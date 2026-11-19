// Tag and link audit for the Markdown notes of a vault, plus a guarded cleanup.
//
// Audit is read-only. Cleanup (plan, then apply) only edits notes that doc_write itself may replace, refuses any file that changed
// since the plan, keeps a backup of every file it touches and can be undone. Journals, generated weekly views, `user/` notes and the
// SQLite memories are reported but never rewritten: their contract is append-only or "write through SQLite".
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./installer.mjs";
import { VaultToolError, noteEditBlock, resolveInside } from "./memory-store.mjs";
import {
  buildLinkIndex, extractLinks, inlineTags, maskCode, readFrontmatterTags, resolveLink, tagKey, writeFrontmatterTags,
} from "./note-scan.mjs";
import { TAG_PATTERN, readTagAliases, tagAliasesFile } from "./tag-aliases.mjs";

const fail = (code, message) => new VaultToolError(code, message);
const MAX_FILES = 20_000;
const MAX_NOTE_BYTES = 1_000_000;
const BACKUPS_KEPT = 10;
export const TIDY_REMINDER_DAYS = 30;
export const ACCEPT_CLASSES = Object.freeze(["spelling", "plural", "typo"]);
const LINK_FIX_STATUSES = Object.freeze({ safe: ["case", "folder"], all: ["case", "folder", "moved"] });

// Tags the product writes or relies on. They may be the target of a merge but are never renamed or dropped.
const PROTECTED_TAGS = new Set(["short-term", "long-term", "skill", "migrated"]);
const isProtected = (key) => PROTECTED_TAGS.has(key) || key.startsWith("source:");

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const unique = (list) => [...new Set(list)];
const byCountThenName = (a, b) => b.notes - a.notes || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);
const stateDir = (vault) => path.join(vault, ".agent-vault");
const backupRoot = (vault) => path.join(stateDir(vault), "tidy-backups");
const stateFile = (vault) => path.join(stateDir(vault), "tidy.json");

// ---------------------------------------------------------------- scanning

function noteKind(rel) {
  if (/^(?:projects\/[^/]+|shared\/knowledge)\/weekly\//.test(rel)) return "generated";
  const block = noteEditBlock(rel);
  if (!block) return "mutable";
  if (block.code === "append_only") return "append-only";
  return block.code === "sqlite_memory_required" ? "legacy" : "outside";
}

async function walkVault(root) {
  const files = [];
  let truncated = false;
  async function visit(dir, rel) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) return;
      throw error;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), childRel);
      else if (entry.isFile()) {
        if (files.length >= MAX_FILES) { truncated = true; return; }
        files.push(childRel);
      }
    }
  }
  await visit(root, "");
  return { files, truncated };
}

function parseNote(text, rel, index) {
  const masked = maskCode(text);
  const fm = readFrontmatterTags(text);
  const links = extractLinks(masked).map((link) => ({ ...link, res: resolveLink(index, rel, link.target) }));
  return { fm, links, inline: inlineTags(masked, fm.match?.[0].length ?? 0), legacyRefs: text.split("legacy-source-reference:").length - 1 };
}

async function scanVault(vault) {
  const root = await realpath(path.resolve(vault));
  const { files, truncated } = await walkVault(root);
  const index = buildLinkIndex(files);
  const notes = [];
  const inbound = new Map();
  const linkTotals = { total: 0, ok: 0, ambiguous: 0, case: 0, folder: 0, moved: 0, external: 0, broken: 0 };
  let oversized = 0;
  for (const rel of files) {
    if (!rel.endsWith(".md")) continue;
    const kind = noteKind(rel);
    const file = path.join(root, rel);
    if ((await stat(file)).size > MAX_NOTE_BYTES) { oversized++; continue; }
    const { fm, links, inline, legacyRefs } = parseNote(await readFile(file, "utf8"), rel, index);
    const own = rel.slice(0, -3);
    const open = [];
    for (const link of links) {
      if (kind !== "generated") {
        linkTotals.total++;
        linkTotals[link.res.status]++;
      }
      const targets = link.res.key ? [link.res.key] : link.res.fix ? [link.res.fix] : link.res.status === "ambiguous" ? link.res.candidates : [];
      for (const key of targets) if (key !== own) inbound.set(key, (inbound.get(key) ?? 0) + 1);
      if (!["ok", "external"].includes(link.res.status) && kind !== "generated") open.push({ kind: link.kind, embed: link.embed, start: link.start, end: link.end, target: link.target, line: link.line, res: link.res });
    }
    notes.push({ rel, kind, tags: fm.unsupported ? [] : fm.tags, tagsUnsupported: fm.unsupported, inline: kind === "generated" ? [] : inline, open, legacyRefs: kind === "generated" ? 0 : legacyRefs });
  }
  return { root, files: files.length, truncated, oversized, notes, inbound, linkTotals, index };
}

// ---------------------------------------------------------------- tag analysis

const compactKey = (key) => key.replace(/(?<=\D)-|-(?=\D)/g, "");
function singular(key) {
  const cut = key.lastIndexOf("-") + 1;
  const last = key.slice(cut);
  let word = last;
  if (last.length >= 4) {
    if (/ies$/.test(last)) word = `${last.slice(0, -3)}y`;
    else if (/(?:ss|us|is)$/.test(last)) word = last;
    else if (/(?:ses|xes|ches|shes)$/.test(last)) word = last.slice(0, -2);
    else if (/s$/.test(last)) word = last.slice(0, -1);
  }
  return key.slice(0, cut) + word;
}

function editDistanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return Infinity;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let before = previous.slice();
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      let cost = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cost = Math.min(cost, before[j - 2] + 1);
      row.push(cost);
    }
    before = previous;
    previous = row;
  }
  return previous[b.length];
}

const SEGMENT_SYNONYMS = { logs: "log", worktrees: "worktree", specs: "spec", changes: "change", agents: "agent", templates: "template", concepts: "concept" };
function pathSegmentKeys(rel) {
  const keys = new Set();
  for (const segment of rel.split("/").slice(0, -1)) {
    const key = tagKey(segment);
    keys.add(key);
    if (SEGMENT_SYNONYMS[key]) keys.add(SEGMENT_SYNONYMS[key]);
  }
  return keys;
}

/** Group every spelling of every tag, then derive merge candidates and the other overlap signals. */
function analyzeTags(notes) {
  const entries = new Map();
  const touch = (raw, index, where) => {
    const key = tagKey(raw);
    if (!key) return;
    let entry = entries.get(key);
    if (!entry) entries.set(key, (entry = { key, raws: new Map(), notes: new Set(), inline: new Set() }));
    if (where === "fm") {
      if (!entry.raws.has(raw)) entry.raws.set(raw, new Set());
      entry.raws.get(raw).add(index);
    } else entry.inline.add(index);
    entry.notes.add(index);
  };
  notes.forEach((note, index) => {
    if (note.kind === "generated") return;
    for (const raw of note.tags) touch(raw, index, "fm");
    for (const raw of note.inline) touch(raw, index, "inline");
  });
  for (const entry of entries.values()) {
    entry.mutable = [...entry.notes].filter((index) => notes[index].kind === "mutable").length;
    // Inline-only spellings are real tags too, but cannot be rewritten; they join the group under their key.
    if (entry.raws.size === 0) entry.raws.set(entry.key, new Set());
  }
  const rawCount = (entry, raw) => entry.raws.get(raw)?.size ?? 0;

  // Spelling: same key, or keys that differ only by hyphenation.
  const byCompact = new Map();
  for (const entry of entries.values()) {
    const compact = compactKey(entry.key);
    byCompact.set(compact, [...(byCompact.get(compact) ?? []), entry]);
  }
  const spelling = [];
  const canonicalOf = new Map(); // raw -> canonical raw (spelling stage)
  for (const group of byCompact.values()) {
    const raws = group.flatMap((entry) => [...entry.raws.keys()].map((raw) => ({ raw, key: entry.key, count: rawCount(entry, raw) })));
    if (raws.length < 2) continue;
    const protectedKey = group.find((entry) => isProtected(entry.key))?.key;
    const hyphens = (raw) => raw.split("-").length - 1;
    const canonical = protectedKey ?? raws.slice().sort((a, b) => b.count - a.count || (b.raw === b.key) - (a.raw === a.key) || hyphens(b.raw) - hyphens(a.raw) || a.raw.length - b.raw.length || (a.raw < b.raw ? -1 : 1))[0].raw;
    const members = raws.filter((member) => member.raw !== canonical).sort((a, b) => b.count - a.count);
    if (members.length === 0) continue;
    for (const member of members) canonicalOf.set(member.raw, canonical);
    const affected = new Set(group.flatMap((entry) => [...entry.notes]));
    spelling.push({ class: "spelling", confidence: "high", canonical, members: members.map(({ raw, count }) => ({ tag: raw, notes: count })), notes: affected.size, mutableNotes: [...affected].filter((i) => notes[i].kind === "mutable").length });
  }

  // Plural and typo candidates compare the spelling-level canonical tags.
  const heads = new Map();
  for (const entry of entries.values()) {
    const head = canonicalOf.get([...entry.raws.keys()][0]) ?? [...entry.raws.keys()][0];
    if (!heads.has(tagKey(head))) heads.set(tagKey(head), { key: tagKey(head), tag: head, notes: new Set() });
    for (const index of entry.notes) heads.get(tagKey(head)).notes.add(index);
  }
  const headList = [...heads.values()].map((head) => ({ ...head, count: head.notes.size })).sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
  const bySingular = new Map();
  for (const head of headList) bySingular.set(singular(head.key), [...(bySingular.get(singular(head.key)) ?? []), head]);
  const plural = [];
  const inPlural = new Set();
  for (const group of bySingular.values()) {
    if (group.length < 2) continue;
    const wins = (a, b) => b.count - a.count || (b.key === singular(b.key)) - (a.key === singular(a.key)) || (a.key < b.key ? -1 : 1);
    const canonical = group.slice().sort(wins)[0];
    const members = group.filter((head) => head !== canonical);
    for (const head of group) inPlural.add(head.key);
    plural.push({ class: "plural", confidence: "medium", canonical: canonical.tag, members: members.map((head) => ({ tag: head.tag, notes: head.count })), notes: group.reduce((n, head) => n + head.count, 0) });
  }
  const typo = [];
  if (headList.length <= 3000) {
    for (let i = 0; i < headList.length; i++) {
      for (let j = i + 1; j < headList.length; j++) {
        const a = headList[i];
        const b = headList[j];
        if (Math.min(a.key.length, b.key.length) < 6 || isProtected(a.key) || isProtected(b.key) || (inPlural.has(a.key) && singular(a.key) === singular(b.key))) continue;
        if (a.key.replace(/\D/g, "") !== b.key.replace(/\D/g, "")) continue;
        const limit = Math.min(a.key.length, b.key.length) >= 14 ? 2 : 1;
        const distance = editDistanceAtMost(a.key, b.key, limit);
        if (distance <= limit) typo.push({ class: "typo", confidence: "low", canonical: a.tag, members: [{ tag: b.tag, notes: b.count }], distance, notes: a.count + b.count });
      }
    }
  }

  // Overlap: one tag name is the other plus a single word.
  const overlap = [];
  const tokenized = headList.filter((head) => !head.key.includes(":")).map((head) => ({ ...head, tokens: head.key.split("-") }));
  for (const short of tokenized) {
    if (short.tokens.length < 2 || short.count < 2) continue;
    for (const long of tokenized) {
      if (long === short || long.tokens.length !== short.tokens.length + 1 || long.count < 2) continue;
      const joined = long.tokens.join("-");
      if (joined.startsWith(`${short.key}-`) || joined.endsWith(`-${short.key}`)) overlap.push({ class: "overlap", confidence: "review", tags: [short.tag, long.tag], notes: [short.count, long.count] });
    }
  }

  // Tags that always appear on the same notes: one of the pair carries no extra information.
  const together = [];
  const frequent = headList.filter((head) => head.count >= 4 && !isProtected(head.key)).slice(0, 400);
  for (let i = 0; i < frequent.length; i++) {
    for (let j = i + 1; j < frequent.length; j++) {
      const a = frequent[i];
      const b = frequent[j];
      if (b.count / a.count < 0.9) break;
      let shared = 0;
      for (const index of b.notes) if (a.notes.has(index)) shared++;
      const jaccard = shared / (a.count + b.count - shared);
      if (jaccard >= 0.9) together.push({ tags: [a.tag, b.tag], notes: [a.count, b.count], overlap: Number(jaccard.toFixed(2)) });
    }
  }

  // Tags that merely repeat where the note lives (project folder, branch folder, journal kind).
  const redundant = new Map();
  notes.forEach((note, index) => {
    if (note.kind === "generated" || note.tags.length === 0) return;
    const segments = pathSegmentKeys(note.rel);
    for (const raw of unique(note.tags)) {
      const key = tagKey(raw);
      if (!key) continue;
      const row = redundant.get(key) ?? { tag: raw, total: 0, redundant: 0, mutableRedundant: 0, legacyRedundant: 0 };
      row.total++;
      if (segments.has(key)) {
        row.redundant++;
        if (note.kind === "mutable") row.mutableRedundant++; else row.legacyRedundant++;
      }
      redundant.set(key, row);
    }
  });
  const redundantWithPath = [...redundant.entries()]
    .filter(([key, row]) => !isProtected(key) && row.total >= 3 && row.redundant / row.total >= 0.8)
    .map(([, row]) => ({ tag: row.tag, notes: row.total, repeatsPath: row.redundant, editable: row.mutableRedundant, readOnly: row.legacyRedundant }))
    .sort(byCountThenName);

  const families = new Map();
  for (const entry of entries.values()) {
    const match = /^([^:/]+)([:/])/.exec(entry.key);
    if (!match) continue;
    const name = `${match[1]}${match[2]}`;
    const family = families.get(name) ?? { family: name, distinct: 0, notes: new Set() };
    family.distinct++;
    for (const index of entry.notes) family.notes.add(index);
    families.set(name, family);
  }
  const familyList = [...families.values()].filter((family) => family.distinct >= 5).map((family) => ({ family: family.family, distinct: family.distinct, notes: family.notes.size })).sort((a, b) => b.distinct - a.distinct);

  return { entries, spelling, plural, typo, overlap, together, redundantWithPath, families: familyList, canonicalOf };
}

function distinctAfter(notes, mapping, editable) {
  const seen = new Set();
  for (const note of notes) {
    if (note.kind === "generated") continue;
    const change = editable(note);
    for (const raw of note.tags) {
      const next = change ? mapping(raw) : raw;
      if (next !== null) seen.add(next);
    }
    for (const raw of note.inline) seen.add(raw);
  }
  return seen.size;
}

function buildMapping(analysis, accept) {
  const map = new Map();
  if (accept.includes("spelling")) for (const [from, to] of analysis.canonicalOf) map.set(from, to);
  const addPairs = (groups) => { for (const group of groups) for (const member of group.members) map.set(member.tag, group.canonical); };
  if (accept.includes("plural")) addPairs(analysis.plural);
  if (accept.includes("typo")) {
    const taken = new Set();
    for (const group of analysis.typo) {
      const [member] = group.members;
      if (taken.has(member.tag) || taken.has(group.canonical)) continue;
      taken.add(member.tag);
      map.set(member.tag, group.canonical);
    }
  }
  return map;
}

function resolveChain(map, raw) {
  const seen = new Set([raw]);
  let current = raw;
  while (map.has(current)) {
    current = map.get(current);
    if (seen.has(current)) throw fail("merge_cycle", `The tag merges form a cycle through '${current}'.`);
    seen.add(current);
  }
  return current;
}

// ---------------------------------------------------------------- database tags (read-only)

async function databaseTags(vault, limit) {
  const file = path.join(stateDir(vault), "memory.db");
  if (!fs.existsSync(file)) return { available: false, reason: "no private SQLite memory database in this vault" };
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return { available: false, reason: "node:sqlite is unavailable in this runtime" }; }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const counts = new Map();
    let memories = 0;
    for (const row of db.prepare("SELECT tags FROM memories WHERE status = 'active'").iterate()) {
      memories++;
      let tags = [];
      try { tags = JSON.parse(row.tags); } catch { /* ignore a malformed row */ }
      for (const tag of Array.isArray(tags) ? unique(tags.filter((tag) => typeof tag === "string")) : []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const list = [...counts].map(([tag, notes]) => ({ tag, notes })).sort(byCountThenName);
    const compact = new Map();
    for (const item of list) compact.set(compactKey(tagKey(item.tag)), [...(compact.get(compactKey(tagKey(item.tag))) ?? []), item]);
    const sources = list.filter((item) => item.tag.startsWith("source:"));
    return {
      available: true, memories, distinct: list.length, top: list.slice(0, limit),
      sameSpellings: [...compact.values()].filter((group) => group.length > 1).slice(0, limit).map((group) => group.map((item) => ({ ...item }))),
      provenanceTags: { distinct: sources.length, memories: sources.reduce((n, item) => n + item.notes, 0) },
      note: "Memories are immutable, so their tags are reported but never rewritten. Aliases recorded by tidy apply to memories written afterwards.",
    };
  } catch (error) {
    return { available: false, reason: `database not readable: ${error.message}` };
  } finally { db?.close(); }
}

// ---------------------------------------------------------------- audit

const trim = (list, limit) => ({ items: list.slice(0, limit), total: list.length });

export async function auditVault(vault, { limit = 25, now = new Date() } = {}) {
  const scan = await scanVault(vault);
  const { notes } = scan;
  const analysis = analyzeTags(notes);
  const counts = { total: notes.length, mutable: 0, legacy: 0, generated: 0, "append-only": 0, outside: 0 };
  for (const note of notes) counts[note.kind]++;

  const inventory = [...analysis.entries.values()].map((entry) => ({
    tag: [...entry.raws.entries()].sort((a, b) => b[1].size - a[1].size)[0][0], notes: entry.notes.size, editable: entry.mutable, readOnly: entry.notes.size - entry.mutable,
    spellings: entry.raws.size > 1 ? [...entry.raws].map(([raw, set]) => ({ tag: raw, notes: set.size })) : undefined,
  })).sort(byCountThenName);
  const rawSet = new Set();
  for (const note of notes) if (note.kind !== "generated") { for (const raw of note.tags) rawSet.add(raw); for (const raw of note.inline) rawSet.add(raw); }
  const assignments = notes.reduce((n, note) => n + (note.kind === "generated" ? 0 : note.tags.length), 0);
  const onlyReadOnly = inventory.filter((item) => item.editable === 0).length;
  // Most tag assignments of an older vault sit in legacy journals the tools no longer rewrite; `memory migrate` is the way to retire them.
  const legacyByProject = new Map();
  let legacyAssignments = 0;
  for (const note of notes) {
    if (note.kind !== "legacy") continue;
    legacyAssignments += note.tags.length;
    const project = note.rel.startsWith("projects/") ? note.rel.split("/")[1] : "(other)";
    legacyByProject.set(project, (legacyByProject.get(project) ?? 0) + 1);
  }
  const legacyJournals = {
    notes: counts.legacy, tagAssignments: legacyAssignments,
    projects: [...legacyByProject].map(([project, count]) => ({ project, notes: count })).sort((a, b) => b.notes - a.notes || (a.project < b.project ? -1 : 1)).slice(0, limit),
    hint: counts.legacy ? "These notes are read-only. vault-cli memory migrate --project <id> --prune-legacy moves a project's journals into SQLite, where they carry no tags, and removes the verified originals." : null,
  };

  const safe = buildMapping(analysis, ["spelling"]);
  const all = buildMapping(analysis, ACCEPT_CLASSES);
  const dropAll = new Set(analysis.redundantWithPath.filter((item) => item.editable > 0).map((item) => tagKey(item.tag)));
  const editable = (note) => note.kind === "mutable" && !note.tagsUnsupported;
  const afterSafe = distinctAfter(notes, (raw) => resolveChain(safe, raw), editable);
  const afterAll = distinctAfter(notes, (raw) => { const next = resolveChain(all, raw); return dropAll.has(tagKey(next)) ? null : next; }, editable);

  const fixable = [];
  const broken = [];
  const ambiguous = [];
  for (const note of notes) {
    for (const link of note.open) {
      const base = { note: note.rel, line: link.line, target: link.target, editable: note.kind === "mutable" };
      if (link.res.status === "ambiguous") ambiguous.push({ ...base, candidates: link.res.candidates, count: link.res.count });
      else if (link.res.status === "broken") broken.push({ ...base, kind: link.kind, ...(link.res.candidates ? { candidates: link.res.candidates } : {}) });
      else fixable.push({ ...base, kind: link.kind, status: link.res.status, to: link.res.fix, confidence: link.res.status === "moved" ? "medium" : "high" });
    }
  }
  const rank = (a, b) => Number(b.editable) - Number(a.editable) || (a.note < b.note ? -1 : a.note > b.note ? 1 : a.line - b.line);
  fixable.sort(rank); broken.sort(rank); ambiguous.sort(rank);
  const orphans = notes.filter((note) => note.kind === "mutable" && !/(^|\/)(?:README|index|short-term|memory)\.md$/.test(note.rel) && !note.rel.startsWith("_meta/") && !scan.inbound.get(note.rel.slice(0, -3))).map((note) => note.rel);

  const database = await databaseTags(vault, limit);
  const aliases = readTagAliases(vault);
  const projectionNote = "Counts distinct tag spellings. Read-only notes keep theirs, so the 'after' figures only reflect editable notes.";
  return {
    auditedAt: now.toISOString(),
    scope: { markdownFiles: scan.files, notes: counts, skippedOversized: scan.oversized, unsupportedTagFields: notes.filter((note) => note.tagsUnsupported).length, truncated: scan.truncated },
    tags: {
      distinct: rawSet.size, assignments, onlyInReadOnlyNotes: onlyReadOnly, legacyJournals,
      top: inventory.slice(0, limit), singletons: inventory.filter((item) => item.notes === 1).length,
      mergeCandidates: { spelling: trim(analysis.spelling, limit), plural: trim(analysis.plural, limit), typo: trim(analysis.typo, limit), overlap: trim(analysis.overlap, limit) },
      alwaysTogether: trim(analysis.together, limit), repeatsLocation: trim(analysis.redundantWithPath, limit), families: trim(analysis.families, limit),
      projection: { distinctNow: rawSet.size, afterSafeMerges: afterSafe, afterEverySuggestion: afterAll, note: projectionNote },
      aliases: Object.keys(aliases).length,
    },
    links: {
      totals: { ...scan.linkTotals, legacyReferences: notes.reduce((n, note) => n + note.legacyRefs, 0) },
      fixable: trim(fixable, limit), broken: trim(broken, limit), ambiguous: trim(ambiguous, limit), orphans: { total: orphans.length, items: orphans.slice(0, limit) },
      editableBroken: broken.filter((item) => item.editable).length, editableFixable: fixable.filter((item) => item.editable).length,
    },
    database,
  };
}

// ---------------------------------------------------------------- plan

function parseMerge(value) {
  if (typeof value === "string") {
    const [from, to, ...extra] = value.split("=");
    if (!from || !to || extra.length) throw fail("invalid_merge", `Merge '${value}' must look like old=new.`);
    return { from, to };
  }
  if (value && typeof value.from === "string" && typeof value.to === "string") return { from: value.from, to: value.to };
  throw fail("invalid_merge", "A merge needs a from and a to tag.");
}

export async function planTidy(vault, options = {}) {
  const { accept = ["spelling"], merge = [], drop = [], fixLinks = "none", now = new Date() } = options;
  for (const name of accept) if (!ACCEPT_CLASSES.includes(name)) throw fail("invalid_accept", `accept values are ${ACCEPT_CLASSES.join(", ")}.`);
  if (!["none", "safe", "all"].includes(fixLinks)) throw fail("invalid_fix_links", "fixLinks must be none, safe or all.");
  const scan = await scanVault(vault);
  const analysis = analyzeTags(scan.notes);
  const allRaws = new Set();
  const allKeys = new Set();
  for (const entry of analysis.entries.values()) { allKeys.add(entry.key); for (const raw of entry.raws.keys()) allRaws.add(raw); }

  const map = buildMapping(analysis, accept);
  for (const item of merge.map(parseMerge)) {
    if (!allRaws.has(item.from)) throw fail("unknown_tag", `No note uses the tag '${item.from}'. Spell it exactly as the audit shows it.`);
    if (isProtected(tagKey(item.from)) && tagKey(item.from) === item.from) throw fail("protected_tag", `'${item.from}' is created and used by Agent Vault itself and cannot be merged away.`);
    if (!TAG_PATTERN.test(item.to)) throw fail("invalid_tag", `'${item.to}' is not a valid tag (letters, digits and _ / : . - only, at most 60 characters).`);
    map.set(item.from, item.to);
  }
  const dropKeys = new Set();
  for (const tag of drop) {
    const key = tagKey(tag);
    if (!allKeys.has(key)) throw fail("unknown_tag", `No note uses the tag '${tag}'.`);
    if (isProtected(key)) throw fail("protected_tag", `'${tag}' is created and used by Agent Vault itself and cannot be dropped.`);
    dropKeys.add(key);
  }
  const resolve = (raw) => {
    const next = resolveChain(map, raw);
    return dropKeys.has(tagKey(raw)) || dropKeys.has(tagKey(next)) ? null : next;
  };

  const { index } = scan;
  const edits = [];
  const skipped = [];
  const usedMerges = new Map();
  const usedDrops = new Set();
  const policy = LINK_FIX_STATUSES[fixLinks] ?? [];
  let linksFixed = 0;
  for (const note of scan.notes) {
    const wantsTags = note.tags.some((raw) => resolve(raw) !== raw);
    const wantsLinks = policy.length > 0 && note.open.some((link) => link.kind === "wiki" && policy.includes(link.res.status));
    if (!wantsTags && !wantsLinks) continue;
    if (note.kind !== "mutable") {
      skipped.push({ path: note.rel, reason: note.kind === "legacy" ? "legacy journal (read-only)" : note.kind === "append-only" ? "user note (append-only)" : "outside the editable notes" });
      continue;
    }
    const file = path.join(scan.root, note.rel);
    const bytes = await readFile(file);
    const text = bytes.toString("utf8");
    const parsed = parseNote(text, note.rel, index);
    const edit = { path: note.rel, sha256: sha256(bytes) };
    if (wantsTags && !parsed.fm.unsupported) {
      const after = unique(parsed.fm.tags.map(resolve).filter((raw) => raw !== null));
      if (after.length !== parsed.fm.tags.length || after.some((raw, i) => raw !== parsed.fm.tags[i])) {
        edit.tags = { before: parsed.fm.tags, after };
        for (const raw of parsed.fm.tags) {
          const next = resolve(raw);
          if (next === null) usedDrops.add(tagKey(raw)); else if (next !== raw) usedMerges.set(raw, next);
        }
      }
    }
    if (wantsLinks) {
      const links = parsed.links.filter((link) => link.kind === "wiki" && policy.includes(link.res.status)).map((link) => ({
        line: link.line, start: link.start, end: link.end, raw: text.slice(link.start, link.end), status: link.res.status,
        replacement: `${link.embed ? "!" : ""}[[${link.res.fix}${link.anchor}${link.tail}]]`,
      }));
      if (links.length) { edit.links = links; linksFixed += links.length; }
    }
    if (edit.tags || edit.links) edits.push(edit);
  }
  const mapObject = Object.fromEntries([...usedMerges].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const editedNotes = new Set(edits.map((edit) => edit.path));
  const after = distinctAfter(scan.notes, resolve, (note) => editedNotes.has(note.rel));
  // Every accepted merge becomes an alias for future writes, including spellings that only appear in read-only notes.
  const aliases = {};
  const recorded = readTagAliases(vault);
  for (const from of map.keys()) {
    const to = resolveChain(map, from);
    if (allRaws.has(from) && to !== from && !dropKeys.has(tagKey(to)) && recorded[tagKey(from)] !== to) aliases[from] = to;
  }
  const before = new Set();
  for (const note of scan.notes) if (note.kind !== "generated") { for (const raw of note.tags) before.add(raw); for (const raw of note.inline) before.add(raw); }
  // Inline tags cannot be rewritten. Report the ones that still carry a spelling this plan merges away or a tag it drops.
  const touchedKeys = new Set([...usedMerges.keys(), ...usedDrops].map(tagKey));
  const targets = new Set(usedMerges.values());
  const inlineLeft = {};
  for (const note of scan.notes) for (const raw of note.inline) if (touchedKeys.has(tagKey(raw)) && !targets.has(raw)) inlineLeft[raw] = (inlineLeft[raw] ?? 0) + 1;
  const id = sha256(JSON.stringify([aliases, edits.map((edit) => [edit.path, edit.sha256, edit.tags?.after ?? null, edit.links?.map((link) => link.replacement) ?? null])])).slice(0, 12);
  return {
    version: 1, id, createdAt: now.toISOString(), accept, linkFix: fixLinks,
    merges: mapObject, aliases, drops: [...usedDrops].sort(), edits, skipped,
    notes: Object.keys(inlineLeft).length ? [`Inline #tags are not rewritten: ${Object.entries(inlineLeft).map(([raw, n]) => `#${raw} (${n})`).join(", ")}.`] : [],
    summary: { notesChanged: edits.length, tagRenames: usedMerges.size, tagsDropped: usedDrops.size, linksFixed, readOnlyNotesSkipped: skipped.length, distinctBefore: before.size, distinctAfter: after },
  };
}

// ---------------------------------------------------------------- apply and undo

const BACKUP_ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

async function aliasFileState(vault) {
  try { return (await readFile(tagAliasesFile(vault))).toString("utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function rewrite(text, edit) {
  let next = text;
  for (const link of (edit.links ?? []).slice().sort((a, b) => b.start - a.start)) {
    if (next.slice(link.start, link.end) !== link.raw) throw fail("plan_stale", `A link in ${edit.path} no longer matches the plan.`);
    next = next.slice(0, link.start) + link.replacement + next.slice(link.end);
  }
  if (edit.tags) {
    const info = readFrontmatterTags(next);
    if (!info.present || info.unsupported || JSON.stringify(info.tags) !== JSON.stringify(edit.tags.before)) throw fail("plan_stale", `The tags of ${edit.path} no longer match the plan.`);
    next = writeFrontmatterTags(next, info, edit.tags.after);
  }
  return next;
}

export async function applyTidy(vault, plan, { now = new Date() } = {}) {
  if (!plan || plan.version !== 1 || !Array.isArray(plan.edits)) throw fail("invalid_plan", "Not a tidy plan.");
  const root = await realpath(path.resolve(vault));
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const id = `${stamp}-${randomBytes(3).toString("hex")}`;
  const dir = path.join(backupRoot(root), id);
  const changed = [];
  const refused = [];
  let started = false;
  const begin = async () => {
    if (started) return;
    started = true;
    await mkdir(path.join(dir, "files"), { recursive: true, mode: 0o700 });
    await appendFile(path.join(dir, "manifest.jsonl"), `${JSON.stringify({ type: "start", id, planId: plan.id, at: now.toISOString() })}\n`, { mode: 0o600 });
  };
  for (const edit of plan.edits) {
    const rel = typeof edit?.path === "string" ? edit.path : "";
    try {
      if (!rel.endsWith(".md") || rel.startsWith("/") || rel.split("/").includes("..") || noteEditBlock(rel)) throw fail("not_editable", "not an editable note");
      const { target } = await resolveInside(root, rel);
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw fail("not_editable", "not a regular file");
      const bytes = await readFile(target);
      if (sha256(bytes) !== edit.sha256) throw fail("plan_stale", "the note changed since the plan was made");
      const next = rewrite(bytes.toString("utf8"), edit);
      await begin();
      const backup = path.join(dir, "files", rel);
      await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
      await writeAtomic(backup, bytes, 0o600);
      await writeAtomic(target, next, info.mode & 0o777);
      await appendFile(path.join(dir, "manifest.jsonl"), `${JSON.stringify({ type: "file", path: rel, before: edit.sha256, after: sha256(Buffer.from(next, "utf8")) })}\n`);
      changed.push(rel);
    } catch (error) {
      if (!(error instanceof VaultToolError)) throw error;
      refused.push({ path: rel, reason: error.message });
    }
  }
  const aliases = Object.entries(plan.aliases ?? {}).filter(([from, to]) => typeof to === "string" && TAG_PATTERN.test(to) && from !== to);
  let aliasesRecorded = 0;
  if (aliases.length) {
    const before = await aliasFileState(root);
    const current = readTagAliases(root);
    for (const [from, to] of aliases) current[tagKey(from)] = to;
    for (const key of Object.keys(current)) {
      let target = current[key];
      for (let step = 0; step < 10; step++) {
        const next = current[tagKey(target)];
        if (!next || next === target) break;
        target = next;
      }
      current[key] = target;
    }
    const text = `${JSON.stringify({ version: 1, aliases: Object.fromEntries(Object.entries(current).sort()) }, null, 2)}\n`;
    if (text !== before) {
      await begin();
      await mkdir(stateDir(root), { recursive: true, mode: 0o700 });
      await writeAtomic(tagAliasesFile(root), text, 0o600);
      if (before !== null) await writeAtomic(path.join(dir, "aliases.before.json"), before, 0o600);
      await appendFile(path.join(dir, "manifest.jsonl"), `${JSON.stringify({ type: "aliases", hadFile: before !== null, before: before === null ? null : sha256(before), after: sha256(text) })}\n`);
      aliasesRecorded = aliases.length;
    }
  }
  if (started) await pruneBackups(root);
  return { id: started ? id : null, changed, refused, aliasesRecorded, backup: started ? path.relative(root, dir) : null };
}

async function pruneBackups(root) {
  const names = (await readdir(backupRoot(root)).catch(() => [])).filter((name) => BACKUP_ID.test(name)).sort();
  for (const name of names.slice(0, Math.max(0, names.length - BACKUPS_KEPT))) await rm(path.join(backupRoot(root), name), { recursive: true, force: true });
}

export async function listTidyBackups(vault) {
  const root = await realpath(path.resolve(vault));
  const names = (await readdir(backupRoot(root)).catch(() => [])).filter((name) => BACKUP_ID.test(name)).sort().reverse();
  const out = [];
  for (const id of names) {
    const lines = (await readFile(path.join(backupRoot(root), id, "manifest.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    out.push({ id, files: lines.filter((line) => line.type === "file").length, aliases: lines.some((line) => line.type === "aliases"), at: lines[0]?.at ?? null });
  }
  return out;
}

export async function undoTidy(vault, id) {
  if (typeof id !== "string" || !BACKUP_ID.test(id)) throw fail("invalid_backup", "A backup id looks like 20261120-091500-a1b2c3; list them with --backups.");
  const root = await realpath(path.resolve(vault));
  const dir = path.join(backupRoot(root), id);
  let lines;
  try { lines = (await readFile(path.join(dir, "manifest.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { throw fail("backup_not_found", `No tidy backup named ${id}.`); }
  const restored = [];
  const skipped = [];
  for (const entry of lines.filter((line) => line.type === "file").reverse()) {
    try {
      if (noteEditBlock(entry.path)) throw fail("not_editable", "not an editable note");
      const { target } = await resolveInside(root, entry.path);
      const current = await readFile(target).catch(() => null);
      if (current === null) { skipped.push({ path: entry.path, reason: "the note no longer exists" }); continue; }
      const original = await readFile(path.join(dir, "files", entry.path));
      if (sha256(current) === entry.before) { skipped.push({ path: entry.path, reason: "already restored" }); continue; }
      if (sha256(current) !== entry.after) { skipped.push({ path: entry.path, reason: "edited since the tidy, so it was left alone" }); continue; }
      if (sha256(original) !== entry.before) { skipped.push({ path: entry.path, reason: "the backup copy does not match its record" }); continue; }
      await writeAtomic(target, original, (await stat(target)).mode & 0o777);
      restored.push(entry.path);
    } catch (error) {
      if (!(error instanceof VaultToolError)) throw error;
      skipped.push({ path: entry.path, reason: error.message });
    }
  }
  let aliases = "unchanged";
  const aliasEntry = lines.find((line) => line.type === "aliases");
  if (aliasEntry) {
    const current = await aliasFileState(root);
    if (current !== null && sha256(current) === aliasEntry.after) {
      if (aliasEntry.hadFile) await writeAtomic(tagAliasesFile(root), await readFile(path.join(dir, "aliases.before.json")), 0o600);
      else await rm(tagAliasesFile(root), { force: true });
      aliases = "restored";
    } else aliases = current === null || sha256(current) === aliasEntry.before ? "already restored" : "edited since the tidy, so it was left alone";
  }
  return { id, restored, skipped, aliases };
}

// ---------------------------------------------------------------- reminder state

export async function recordTidyAudit(vault, report) {
  const link = report.links;
  const state = {
    version: 1, auditedAt: report.auditedAt,
    summary: {
      distinctTags: report.tags.distinct, safeMerges: report.tags.mergeCandidates.spelling.total,
      brokenLinks: link.editableBroken, fixableLinks: link.editableFixable, afterEverySuggestion: report.tags.projection.afterEverySuggestion,
    },
  };
  await mkdir(stateDir(vault), { recursive: true, mode: 0o700 });
  await writeAtomic(stateFile(vault), `${JSON.stringify(state, null, 2)}\n`, 0o600);
  return state;
}

export function readTidyState(vault) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(path.resolve(vault)), "utf8"));
    return state?.version === 1 && typeof state.auditedAt === "string" && !Number.isNaN(Date.parse(state.auditedAt)) ? state : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- text rendering

export function renderTidyReport(report) {
  const out = [];
  const { scope, tags, links, database } = report;
  const section = (title) => out.push("", `## ${title}`);
  const some = (box, render) => { for (const item of box.items) out.push(`  ${render(item)}`); if (box.total > box.items.length) out.push(`  ... and ${box.total - box.items.length} more (use --limit)`); };
  out.push(`Tidy audit ${report.auditedAt}`, `Notes: ${scope.notes.total} (editable ${scope.notes.mutable}, read-only legacy journals ${scope.notes.legacy}, user ${scope["notes"]["append-only"]}, other ${scope.notes.outside}, generated weekly views ${scope.notes.generated})`);
  if (scope.truncated) out.push(`The vault has more than 20000 files; only the first 20000 were scanned.`);
  section("Tags");
  out.push(`  ${tags.distinct} distinct tags on ${tags.assignments} assignments; ${tags.singletons} used only once; ${tags.onlyInReadOnlyNotes} exist only in read-only notes`);
  out.push(`  If accepted: safe merges -> ${tags.projection.afterSafeMerges}, every suggestion -> ${tags.projection.afterEverySuggestion} (${tags.projection.note})`);
  if (tags.legacyJournals.notes) {
    out.push(`  ${tags.legacyJournals.tagAssignments} of ${tags.assignments} tag assignments sit in ${tags.legacyJournals.notes} read-only legacy journals (largest: ${tags.legacyJournals.projects.slice(0, 5).map((p) => `${p.project} ${p.notes}`).join(", ")}).`);
    out.push(`  ${tags.legacyJournals.hint}`);
  }
  const groups = (title, box, hint) => { if (box.total) { out.push("", `  ${title} (${box.total})${hint ? ` - ${hint}` : ""}`); some(box, (g) => `${g.members.map((m) => `${m.tag} (${m.notes})`).join(", ")}  ->  ${g.canonical}`); } };
  groups("Same name written differently", tags.mergeCandidates.spelling, "safe: tidy --apply");
  groups("Singular and plural", tags.mergeCandidates.plural, "tidy --apply --accept plural");
  groups("Probable typos", tags.mergeCandidates.typo, "check each, then --merge old=new");
  if (tags.mergeCandidates.overlap.total) { out.push("", `  One name contains the other (${tags.mergeCandidates.overlap.total}) - review`); some(tags.mergeCandidates.overlap, (g) => g.tags.join("  /  ")); }
  if (tags.alwaysTogether.total) { out.push("", `  Always on the same notes (${tags.alwaysTogether.total}) - one may be redundant`); some(tags.alwaysTogether, (g) => `${g.tags.join("  +  ")}  (${g.notes.join("/")} notes)`); }
  if (tags.repeatsLocation.total) { out.push("", `  Repeat where the note already lives (${tags.repeatsLocation.total}) - tidy --apply --drop <tag>`); some(tags.repeatsLocation, (g) => `${g.tag}: ${g.repeatsPath}/${g.notes} notes (${g.editable} editable, ${g.readOnly} read-only)`); }
  if (tags.families.total) { out.push("", `  Tag families with many values (${tags.families.total})`); some(tags.families, (g) => `${g.family}* ${g.distinct} values on ${g.notes} notes`); }
  section("Links");
  const t = links.totals;
  out.push(`  ${t.total} links: ${t.ok} resolve, ${t.ambiguous} ambiguous, ${t.case + t.folder + t.moved} fixable (${t.case} case, ${t.folder} folder, ${t.moved} moved), ${t.external} point outside the vault, ${t.broken} broken; ${t.legacyReferences} legacy source references; ${links.orphans.total} orphan notes`);
  if (links.fixable.total) { out.push("", `  Fixable (${links.fixable.total}) - tidy --apply --fix-links${links.fixable.items.some((i) => i.status === "moved") ? " [all]" : ""}`); some(links.fixable, (l) => `${l.note}:${l.line} ${l.target} -> ${l.to} (${l.status}${l.editable ? "" : ", read-only note"})`); }
  if (links.broken.total) { out.push("", `  Broken (${links.broken.total})`); some(links.broken, (l) => `${l.note}:${l.line} ${l.target}${l.editable ? "" : " (read-only note)"}`); }
  if (links.ambiguous.total) { out.push("", `  Ambiguous short names (${links.ambiguous.total})`); some(links.ambiguous, (l) => `${l.note}:${l.line} ${l.target} matches ${l.count} notes`); }
  if (links.orphans.total) { out.push("", `  Notes nothing links to (${links.orphans.total})`); for (const item of links.orphans.items) out.push(`  ${item}`); }
  section("SQLite memories");
  if (database.available) {
    out.push(`  ${database.memories} active memories, ${database.distinct} distinct tags, ${database.provenanceTags.distinct} source:<id> provenance tags. ${database.note}`);
    for (const group of database.sameSpellings) out.push(`  same name: ${group.map((item) => `${item.tag} (${item.notes})`).join(", ")}`);
  } else out.push(`  skipped: ${database.reason}`);
  return out.join("\n");
}

export function renderTidyPlan(plan, applyCommand) {
  const s = plan.summary;
  const out = [
    `Tidy plan ${plan.id}: ${s.notesChanged} notes to edit, ${s.tagRenames} tag renames, ${s.tagsDropped} tags dropped, ${s.linksFixed} links fixed.`,
    `Distinct tags ${s.distinctBefore} -> ${s.distinctAfter}. ${s.readOnlyNotesSkipped} read-only notes would need changes and are left alone.`,
  ];
  for (const [from, to] of Object.entries(plan.merges)) out.push(`  rename  ${from}  ->  ${to}`);
  for (const key of plan.drops) out.push(`  drop    ${key}`);
  for (const edit of plan.edits) {
    const detail = [];
    if (edit.tags) detail.push(`tags [${edit.tags.before.join(", ")}] -> [${edit.tags.after.join(", ")}]`);
    if (edit.links) detail.push(`${edit.links.length} link${edit.links.length === 1 ? "" : "s"}: ${edit.links.map((link) => `${link.raw} -> ${link.replacement}`).join("; ")}`);
    out.push(`  ${edit.path}: ${detail.join("; ")}`);
  }
  for (const skip of plan.skipped.slice(0, 10)) out.push(`  skipped ${skip.path}: ${skip.reason}`);
  if (plan.skipped.length > 10) out.push(`  ... and ${plan.skipped.length - 10} more skipped`);
  out.push(...plan.notes);
  if (applyCommand) out.push("", `To apply exactly this plan: ${applyCommand}`);
  return out.join("\n");
}

/** The exact shell command that applies a previewed plan. Always names the vault explicitly so it can never act on a different one. */
export function tidyApplyCommand(vault, { accept, merge = [], drop = [], fixLinks = "none" }, planId) {
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const parts = ["vault-cli tidy --apply", "--path", quote(path.resolve(vault))];
  if (accept) parts.push("--accept", accept.length ? accept.join(",") : "none");
  if (merge.length) parts.push("--merge", quote(merge.map((item) => (typeof item === "string" ? item : `${item.from}=${item.to}`)).join(",")));
  if (drop.length) parts.push("--drop", quote(drop.join(",")));
  if (fixLinks !== "none") parts.push("--fix-links", fixLinks);
  parts.push("--expect", planId);
  return parts.join(" ");
}
