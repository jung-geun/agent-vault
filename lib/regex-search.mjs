import { Worker } from "node:worker_threads";
import { VaultToolError } from "./memory-store.mjs";

export const REGEX_LIMITS = Object.freeze({
  maxPatternChars: 300,
  allowedFlags: "imsu",
  defaultFlags: "iu",
  timeoutMs: 2000,
  maxScanChars: 20000,
  maxRows: 500,
});

const fail = (code, message) => new VaultToolError(code, message);

export function validateRegex(pattern, flags = REGEX_LIMITS.defaultFlags) {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > REGEX_LIMITS.maxPatternChars) {
    throw fail("invalid_regex", `Pattern must be a non-empty string of at most ${REGEX_LIMITS.maxPatternChars} characters.`);
  }
  if (typeof flags !== "string" || [...flags].some((flag) => !REGEX_LIMITS.allowedFlags.includes(flag)) || new Set(flags).size !== flags.length) {
    throw fail("invalid_regex", `Flags must be drawn from ${REGEX_LIMITS.allowedFlags}, without duplicates.`);
  }
  try {
    new RegExp(pattern, flags);
  } catch (error) {
    throw fail("invalid_regex", error.message.trim());
  }
  return { pattern, flags };
}

export async function searchRegex(items, pattern, { flags, timeoutMs = REGEX_LIMITS.timeoutMs } = {}) {
  const regex = validateRegex(pattern, flags);
  if (items.length === 0) return [];
  const worker = new Worker(new URL("./regex-worker.mjs", import.meta.url), {
    execArgv: [],
    workerData: {
      ...regex,
      items: items.slice(0, REGEX_LIMITS.maxRows).map(({ key, texts }) => ({
        key,
        texts: {
          title: texts.title?.slice(0, REGEX_LIMITS.maxScanChars),
          path: texts.path?.slice(0, REGEX_LIMITS.maxScanChars),
          tags: texts.tags?.slice(0, REGEX_LIMITS.maxScanChars),
          content: texts.content?.slice(0, REGEX_LIMITS.maxScanChars),
        },
      })),
    },
  });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Regex worker exited before returning results (code ${code}).`)));
      timer = setTimeout(() => reject(fail("regex_timeout", "pattern took too long; simplify nested quantifiers")), timeoutMs);
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

export async function regexRankMemories(rows, pattern, { flags, limit = 5, timeoutMs } = {}) {
  let truncated = rows.length > REGEX_LIMITS.maxRows;
  const memories = new Map();
  const items = rows.slice(0, REGEX_LIMITS.maxRows).map((row) => {
    const { id, title, content } = row;
    const tags = row.tags.join(" ");
    if (title.length > REGEX_LIMITS.maxScanChars || tags.length > REGEX_LIMITS.maxScanChars || content.length > REGEX_LIMITS.maxScanChars) {
      truncated = true;
    }
    memories.set(id, row);
    return { key: id, texts: { title, tags, content } };
  });
  const results = (await searchRegex(items, pattern, { flags, timeoutMs })).map(({ key, ...match }) => ({
    memory: memories.get(key), score: match.count, match,
  }));
  results.sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || b.memory.id - a.memory.id);
  return { results: results.slice(0, limit), scanned: items.length, truncated };
}
