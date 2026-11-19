// Pure parsing helpers for Markdown notes: frontmatter and inline tags, wikilinks and Markdown links, code masking and link resolution.
// Nothing here touches the file system, so every rule can be tested against plain strings.

export const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Comparison key for a tag: NFKC, lower case, no leading '#', separators folded to '-'. Nested ('/') and family (':') markers stay. */
export function tagKey(raw) {
  return String(raw).normalize("NFKC").trim().replace(/^#+/, "").toLowerCase().replace(/[\s_.]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function unquote(item) {
  const value = item.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

function splitFlow(inner) {
  const items = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"') current += inner[++i] ?? "";
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ",") {
      items.push(current);
      current = "";
    } else current += char;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter(Boolean);
}

// Keep a list's quoting only when every item was quoted the same way; a mixed list gets quotes just where an item needs them.
function quoteStyle(items) {
  if (items.length && items.every((item) => item.startsWith('"'))) return "double";
  if (items.length && items.every((item) => item.startsWith("'"))) return "single";
  return "none";
}

/**
 * Read the frontmatter `tags` field. Supported shapes: `[a, "b"]`, a block list, and a comma or space separated scalar.
 * A multi-line flow sequence is reported as unsupported and is never rewritten.
 */
export function readFrontmatterTags(text) {
  const match = FRONTMATTER.exec(text);
  if (!match) return { present: false, tags: [], unsupported: false };
  const lines = match[1].split(/\r?\n/);
  const start = lines.findIndex((line) => /^tags\s*:/.test(line));
  if (start < 0) return { present: false, tags: [], unsupported: false, match };
  const rest = lines[start].replace(/^tags\s*:\s*/, "").replace(/\s+#.*$/, "");
  const base = { present: true, match, lines, start, count: 1, quote: "none", indent: "  " };
  if (rest.startsWith("[")) {
    if (!rest.includes("]")) return { ...base, tags: [], style: "inline", unsupported: true };
    const items = splitFlow(rest.slice(1, rest.lastIndexOf("]")));
    const quote = quoteStyle(items);
    return { ...base, tags: items.map(unquote), style: "inline", quote, unsupported: false };
  }
  if (rest === "") {
    const items = [];
    let indent = "  ";
    for (let i = start + 1; i < lines.length; i++) {
      const item = /^(\s*)-\s*(.*)$/.exec(lines[i]);
      if (!item) break;
      if (items.length === 0) indent = item[1];
      items.push(item[2].replace(/\s+#.*$/, ""));
    }
    return { ...base, tags: items.map(unquote).filter(Boolean), count: 1 + items.length, style: items.length ? "block" : "empty", quote: quoteStyle(items), indent, unsupported: false };
  }
  return { ...base, tags: unquote(rest).split(/[,\s]+/).filter(Boolean), style: "scalar", unsupported: false };
}

const YAML_SPECIAL = /^(?:true|false|null|yes|no|on|off|~|[+-]?\d[\d_.]*)$/i;
function formatTag(tag, quote) {
  if (quote === "double") return JSON.stringify(tag);
  if (quote === "single") return `'${tag.replaceAll("'", "''")}'`;
  return /^[\p{L}\p{N}_/.:-]+$/u.test(tag) && !/^[-:]/.test(tag) && !YAML_SPECIAL.test(tag) ? tag : JSON.stringify(tag);
}

/** Return `text` with its frontmatter tags replaced, keeping the original list style, quoting and line endings. */
export function writeFrontmatterTags(text, info, tags) {
  if (!info.present || info.unsupported) throw new Error("This note's tags field cannot be rewritten safely.");
  const newline = info.match[0].includes("\r\n") ? "\r\n" : "\n";
  const replacement = info.style === "block" && tags.length
    ? ["tags:", ...tags.map((tag) => `${info.indent}- ${formatTag(tag, info.quote)}`)]
    : [`tags: [${tags.map((tag) => formatTag(tag, info.quote)).join(", ")}]`];
  const lines = [...info.lines.slice(0, info.start), ...replacement, ...info.lines.slice(info.start + info.count)];
  const head = /^---\r?\n/.exec(info.match[0])[0];
  const tail = info.match[0].slice(head.length + info.match[1].length);
  return head + lines.join(newline) + tail + text.slice(info.match[0].length);
}

const PLACEHOLDER_TARGET = /<[^<>]*>|\{\{|\$\{/;

/** Blank out fenced code blocks and inline code spans, keeping every offset and newline in place. */
export function maskCode(text) {
  const out = [];
  let fence = null;
  for (const line of text.split(/(?<=\n)/)) {
    const body = line.replace(/\r?\n$/, "");
    const eol = line.slice(body.length);
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(body);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && /^\s*$/.test(body.slice(open[0].length))) fence = null;
      out.push(" ".repeat(body.length) + eol);
    } else if (open) {
      fence = open[1];
      out.push(" ".repeat(body.length) + eol);
    } else out.push(body.replace(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, (span) => " ".repeat(span.length)) + eol);
  }
  return out.join("");
}

/** Inline `#tag` occurrences outside code and frontmatter (a heading's own `#` marker is not a tag; a tag inside a heading is). All-digit tokens such as issue numbers are not tags. */
export function inlineTags(masked, bodyStart = 0) {
  const tags = [];
  for (const match of masked.slice(bodyStart).matchAll(/(?<=^|[\s(])#([\p{L}\p{N}_/-]+)/gmu)) {
    if (!/^\p{N}+$/u.test(match[1]) && !/^[/_-]/u.test(match[1])) tags.push(match[1]);
  }
  return tags;
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid; else high = mid - 1;
    }
    return low + 1;
  };
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Links outside code. Wikilinks keep enough detail to be rewritten in place; Markdown links are only reported. */
export function extractLinks(masked) {
  const lineOf = lineIndex(masked);
  const links = [];
  for (const match of masked.matchAll(/(!?)\[\[([^[\]\n]+)\]\]/g)) {
    const inner = match[2];
    const pipe = inner.search(/\\?\|/);
    const head = pipe < 0 ? inner : inner.slice(0, pipe);
    const tail = pipe < 0 ? "" : inner.slice(pipe);
    const anchor = head.search(/[#^]/);
    const target = anchor < 0 ? head : head.slice(0, anchor);
    if (PLACEHOLDER_TARGET.test(target)) continue; // template text, not a link to a real note
    links.push({ kind: "wiki", embed: match[1] === "!", start: match.index, end: match.index + match[0].length, target, anchor: anchor < 0 ? "" : head.slice(anchor), tail, line: lineOf(match.index) });
  }
  for (const match of masked.matchAll(/(!?)\[([^[\]\n]*)\]\(([^)\n]+?)\)/g)) {
    let dest = match[3].trim();
    if (dest.startsWith("<")) dest = dest.slice(1, dest.indexOf(">") < 0 ? undefined : dest.indexOf(">"));
    else dest = dest.split(/\s+/)[0];
    const hash = dest.indexOf("#");
    let target = hash < 0 ? dest : dest.slice(0, hash);
    if (!target || SCHEME.test(target) || target.startsWith("//") || PLACEHOLDER_TARGET.test(target)) continue;
    try { target = decodeURIComponent(target); } catch { /* keep the raw text */ }
    links.push({ kind: "md", embed: match[1] === "!", start: match.index, end: match.index + match[0].length, target, anchor: "", tail: "", line: lineOf(match.index) });
  }
  return links.sort((a, b) => a.start - b.start);
}

const normalizeTarget = (target) => target.replaceAll("\\", "").trim().replace(/^\/+/, "");
const keyOf = (rel) => (rel.endsWith(".md") ? rel.slice(0, -3) : rel);
const baseOf = (key) => key.slice(key.lastIndexOf("/") + 1);

/** Lookup tables over every non-hidden vault file path (posix, vault relative). */
export function buildLinkIndex(paths) {
  const keys = new Set();
  const lower = new Map();
  const base = new Map();
  const add = (map, name, key) => (map.has(name) ? map.get(name).push(key) : map.set(name, [key]));
  for (const rel of paths) {
    const key = keyOf(rel);
    keys.add(key);
    add(lower, key.toLowerCase(), key);
    add(base, baseOf(key).toLowerCase(), key);
  }
  return { keys, lower, base };
}

// null when the path climbs above the vault root.
const posixJoin = (dir, rel) => {
  const out = [];
  for (const part of `${dir}/${rel}`.split("/")) {
    if (part === "..") { if (out.length === 0) return null; out.pop(); }
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
};

// A short name shared by many notes of different projects (spec, index, memory...) says nothing about where a note moved.
const GENERIC_NAMES = new Set(["spec", "specs", "index", "readme", "memory", "overview", "proposal", "design", "tasks", "notes", "summary", "changelog", "todo", "plan", "report", "home", "readme.md"]);
const isSpecificName = (name) => !GENERIC_NAMES.has(name.toLowerCase()) && (name.includes("-") || name.length >= 12);

/**
 * Resolve one link target the way Obsidian does (vault path, note-relative path, or a unique short name) and say how to repair a miss.
 * status: ok | ambiguous | case | folder | moved | external | broken. `fix` is a canonical key for case, folder and moved.
 * `external` is a relative path that leaves the vault (for example into the repository a spec was imported from): not an error here.
 */
export function resolveLink(index, fromRel, rawTarget) {
  const target = keyOf(normalizeTarget(rawTarget));
  if (!target) return { status: "ok", key: keyOf(fromRel) };
  const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  const relative = posixJoin(dir, target);
  if (relative === null && target.startsWith("../")) return { status: "external" };
  for (const candidate of [target, relative]) {
    if (candidate && index.keys.has(candidate)) return { status: "ok", key: candidate };
  }
  if (!target.includes("/")) {
    const hits = index.base.get(target.toLowerCase()) ?? [];
    if (hits.length === 1) return { status: "ok", key: hits[0] };
    if (hits.length > 1) return { status: "ambiguous", candidates: hits.slice(0, 5), count: hits.length };
  }
  const sameCase = index.lower.get(target.toLowerCase()) ?? [];
  if (sameCase.length === 1) return { status: "case", fix: sameCase[0] };
  for (const name of ["index", "README"]) {
    if (index.keys.has(`${target}/${name}`)) return { status: "folder", fix: `${target}/${name}` };
  }
  if (target.includes("/")) {
    const name = baseOf(target);
    const hits = index.base.get(name.toLowerCase()) ?? [];
    if (hits.length === 1 && isSpecificName(name)) return { status: "moved", fix: hits[0] };
    if (hits.length >= 1) return { status: "broken", candidates: hits.slice(0, 5), count: hits.length };
  }
  return { status: "broken" };
}
