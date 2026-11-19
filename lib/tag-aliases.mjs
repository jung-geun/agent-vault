// Vault-level tag aliases: `tidy` records the merges the user accepted, and writers map new tags through them so that a duplicate
// spelling that was just consolidated does not grow back. Existing SQLite memories are immutable and are never rewritten.
import fs from "node:fs";
import path from "node:path";
import { tagKey } from "./note-scan.mjs";

export const TAG_PATTERN = /^[\p{L}\p{N}_/:.-]{1,60}$/u;
export const tagAliasesFile = (vault) => path.join(vault, ".agent-vault", "tag-aliases.json");

/** `{ <tagKey of an old spelling>: <canonical tag> }`. A missing or unreadable file means no aliases. */
export function readTagAliases(vault) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(tagAliasesFile(path.resolve(vault)), "utf8")); } catch { return {}; }
  const aliases = {};
  if (parsed?.version !== 1 || parsed.aliases === null || typeof parsed.aliases !== "object" || Array.isArray(parsed.aliases)) return aliases;
  for (const [key, to] of Object.entries(parsed.aliases)) {
    if (typeof to === "string" && TAG_PATTERN.test(to) && key === tagKey(key)) aliases[key] = to;
  }
  return aliases;
}

/** Map each tag through the aliases, keeping order and dropping repeats. Anything that is not a string is returned untouched. */
export function canonicalTags(vault, tags) {
  if (!Array.isArray(tags) || tags.length === 0) return tags;
  const aliases = readTagAliases(vault);
  if (Object.keys(aliases).length === 0) return tags;
  const out = [];
  for (const tag of tags) {
    const mapped = typeof tag === "string" ? (aliases[tagKey(tag)] ?? tag) : tag;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}
