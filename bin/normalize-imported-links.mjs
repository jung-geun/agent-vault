#!/usr/bin/env node

import fs from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveVaultPath } from "../lib/vault-core.mjs";

const args = process.argv.slice(2);
const explicitPath = args.includes("--path") ? args[args.indexOf("--path") + 1] : undefined;
const writeChanges = args.includes("--write");
const vault = resolveVaultPath(explicitPath);
const projectsDir = path.join(vault, "projects");
const projectIds = fs.existsSync(projectsDir)
  ? (await readdir(projectsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  : [];

function resolveLegacyTarget(target) {
  if (target === "SCHEMA") return "_meta/SCHEMA";
  if (target === "SECURITY") return "shared/knowledge/specs/content-security-spec";
  const spec = target.match(/^openspec\/specs\/([^/]+)\/spec$/);
  if (spec) return `shared/knowledge/specs/${spec[1]}-spec`;
  if (target === "templates/project-template") return "shared/templates/project";
  return target;
}

function existsInVault(target) {
  const resolved = path.resolve(vault, target);
  const relative = path.relative(vault, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  return fs.existsSync(resolved) || fs.existsSync(`${resolved}.md`) ||
    fs.existsSync(path.join(resolved, "index.md")) || fs.existsSync(path.join(resolved, "README.md"));
}

function normalizePlainText(text, counters) {
  return text.replace(/\[\[([^\]]+)\]\]/g, (_full, raw) => {
    const [rawTarget, ...aliasParts] = raw.split("|");
    const target = rawTarget.split("#")[0].trim().replaceAll("\\", "");
    const alias = aliasParts.join("|").trim();
    const localTarget = resolveLegacyTarget(target);
    if (existsInVault(localTarget)) {
      counters.remapped++;
      return `[[${localTarget}${alias ? `|${alias}` : ""}]]`;
    }
    counters.unresolved++;
    const label = alias ? ` (alias: ${alias})` : "";
    return `legacy-source-reference: \`${target}\`${label} (target not migrated)`;
  });
}

function normalizeLine(line, counters) {
  return line.split(/(`+[^`]*`+)/g).map((part, index) =>
    index % 2 === 0 ? normalizePlainText(part, counters) : part
  ).join("");
}

function normalizeMarkdown(text) {
  const counters = { remapped: 0, unresolved: 0 };
  let inFence = false;
  const lines = text.split(/(?<=\n)/);
  const output = lines.map((line) => {
    const trimmed = line.trimStart();
    if (/^```|^~~~/.test(trimmed)) {
      inFence = !inFence;
      return line;
    }
    return inFence ? line : normalizeLine(line, counters);
  });
  return { text: output.join(""), ...counters };
}

const files = [];
const specsDir = path.join(vault, "shared", "knowledge", "specs");
if (fs.existsSync(specsDir)) {
  for (const entry of await readdir(specsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(path.join(specsDir, entry.name));
  }
}
for (const projectId of projectIds) {
  const file = path.join(vault, "projects", projectId, "wiki", "concepts", `${projectId}-overview.md`);
  if (fs.existsSync(file)) files.push(file);
}

let changedFiles = 0;
let remappedLinks = 0;
let unresolvedLinks = 0;
for (const file of files) {
  const original = await readFile(file, "utf8");
  const result = normalizeMarkdown(original);
  remappedLinks += result.remapped;
  unresolvedLinks += result.unresolved;
  if (result.text !== original) {
    changedFiles++;
    if (writeChanges) await writeFile(file, result.text, "utf8");
  }
}

console.log(JSON.stringify({
  mode: writeChanges ? "write" : "check",
  filesScanned: files.length,
  changedFiles,
  remappedLinks,
  sourceReferencesMadePlain: unresolvedLinks,
  vault,
}, null, 2));
