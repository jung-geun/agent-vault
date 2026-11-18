// Shared plumbing for the non-keyword search modes (regex and similar) used by long_search, history, recall and doc_search.
// Keyword mode is untouched and never reaches this module. Both modes return a top-k list (1..10, default 5), never a page.
import { VaultToolError } from "./memory-store.mjs";
import { searchMemories } from "./memory-db.mjs";
import { REGEX_LIMITS, validateRegex, regexRankMemories } from "./regex-search.mjs";
import { similarRank } from "./similar-search.mjs";

export const SEARCH_MODES = Object.freeze(["keyword", "regex", "similar"]);
export const SEARCH_METHODS = Object.freeze(["auto", "embedding", "chars"]);
export const TOP_K = Object.freeze({ default: 5, max: 10 });
// Literal on purpose: this module sits in an import cycle (memory-store <-> weekly-memory), so it must not read another module's exports while it evaluates. A test pins it to REGEX_LIMITS.maxRows.
export const CANDIDATE_CAP = 500;
const fail = (code, message) => new VaultToolError(code, message);

/**
 * Validate the mode-related arguments. Returns `{ mode: "keyword" }` untouched for the default mode, otherwise
 * `{ mode, limit, query, flags?, method? }`. `teamScope` marks the external team backend, which only supports keyword.
 */
export function parseSearchMode(args = {}, { teamScope = false } = {}) {
  const mode = args.mode ?? "keyword";
  if (!SEARCH_MODES.includes(mode)) throw fail("invalid_mode", `mode must be one of ${SEARCH_MODES.join(", ")}.`);
  if (mode === "keyword") {
    if (args.method !== undefined || args.flags !== undefined) throw fail("invalid_mode", "method and flags apply only to mode similar or regex.");
    return { mode };
  }
  if (teamScope) throw fail("unsupported_mode", "Team memory supports keyword search only; use mode keyword.");
  if (args.offset !== undefined && args.offset !== 0) throw fail("invalid_offset", `mode ${mode} returns a top-${TOP_K.max} list and does not paginate; omit offset.`);
  const limit = args.limit ?? TOP_K.default;
  if (!Number.isInteger(limit) || limit < 1 || limit > TOP_K.max) throw fail("invalid_limit", `mode ${mode} returns at most ${TOP_K.max} results; limit must be an integer from 1 to ${TOP_K.max}.`);
  if (typeof args.query !== "string" || !args.query.trim()) throw fail("invalid_query", `mode ${mode} requires a non-empty query.`);
  if (mode === "regex") {
    if (args.method !== undefined) throw fail("invalid_method", "method applies only to mode similar.");
    const { flags } = validateRegex(args.query, args.flags ?? REGEX_LIMITS.defaultFlags);
    return { mode, limit, query: args.query, flags };
  }
  if (args.flags !== undefined) throw fail("invalid_mode", "flags apply only to mode regex.");
  const method = args.method ?? "auto";
  if (!SEARCH_METHODS.includes(method)) throw fail("invalid_method", `method must be one of ${SEARCH_METHODS.join(", ")}.`);
  return { mode, limit, query: args.query, method };
}

/** Newest rows for the given filters, one namespace per entry, merged newest first and capped. Content is cut at the scan cap. */
export function candidateRows(db, filters) {
  const lists = (Array.isArray(filters) ? filters : [filters]).map((filter) => searchMemories(db, { ...filter, query: undefined, offset: 0, limit: CANDIDATE_CAP + 1, excerptChars: REGEX_LIMITS.maxScanChars }));
  const rows = lists.flat().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || b.id - a.id);
  return { rows: rows.slice(0, CANDIDATE_CAP), capped: rows.length > CANDIDATE_CAP };
}

/** Rank candidate rows. Each result is the memory plus `score`+`match` (regex) or `similarity` (similar). */
export async function rankCandidates(vault, db, { rows, capped }, parsed) {
  if (parsed.mode === "regex") {
    const { results, scanned, truncated } = await regexRankMemories(rows, parsed.query, { flags: parsed.flags, limit: parsed.limit });
    return {
      results: results.map(({ memory, score, match }) => ({ ...memory, score, match })),
      search: { mode: "regex", method: "regex", flags: parsed.flags, candidates: rows.length, scanned, truncated: truncated || capped },
    };
  }
  const { results, search } = await similarRank(vault, db, rows, parsed.query, { method: parsed.method, limit: parsed.limit });
  return { results: results.map(({ memory, similarity }) => ({ ...memory, similarity })), search: { ...search, truncated: capped } };
}
