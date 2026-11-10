import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getVaultStatus, scaffoldProject } from "./vault-core.mjs";

const execFileAsync = promisify(execFile);

export const AGENT_ROLES = Object.freeze(["coordinator", "builder", "investigator", "reviewer"]);
export const LOG_KINDS = Object.freeze(["qa", "work", "review", "incident"]);
export const WORKTREE_KINDS = Object.freeze(["implementation", "instruction", "investigation"]);
export const SCOPES = Object.freeze(["all", "user", "shared", "meta", "project", "agent", "logs"]);

const PROJECT_ID = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;
const SKIP_DIRS = new Set(["node_modules"]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_SCANNED_FILES = 20_000;
const MAX_WRITE_CHARS = 200_000;
const WRITABLE_ROOTS = ["projects/", "shared/knowledge/", "user/"];

export class VaultToolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "VaultToolError";
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details) => new VaultToolError(code, message, details);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dateOf = (now = new Date()) => now.toISOString().slice(0, 10);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const toPosix = (p) => p.split(path.sep).join("/");
const clamp = (value, min, max, fallback) => {
  const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
};

export function assertProjectId(id) {
  if (typeof id !== "string" || !PROJECT_ID.test(id)) {
    throw fail("invalid_project", `Invalid project ID '${id}'. Must be kebab-case (e.g. 'omp-core').`);
  }
  return id;
}

export function assertRole(role) {
  if (!AGENT_ROLES.includes(role)) {
    throw fail("invalid_role", `Invalid agent role '${role}'. Allowed: ${AGENT_ROLES.join(", ")}.`);
  }
  return role;
}

function assertSlug(slug) {
  if (typeof slug !== "string" || !SLUG.test(slug)) {
    throw fail("invalid_slug", `Invalid slug '${slug}'. Use lowercase letters, digits and hyphens (max 61 chars).`);
  }
  return slug;
}

// ---------------------------------------------------------------- paths

function normalizeRelative(rel) {
  if (typeof rel !== "string" || !rel.trim()) throw fail("invalid_path", "path is required.");
  if (rel.includes("\0")) throw fail("invalid_path", "path contains a NUL byte.");
  const posix = rel.trim().replaceAll("\\", "/");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
    throw fail("invalid_path", "path must be relative to the vault root.");
  }
  const norm = path.posix.normalize(posix);
  if (norm === "." || norm === ".." || norm.startsWith("../")) {
    throw fail("path_escape", "path must stay inside the vault.");
  }
  return norm;
}

async function vaultRoot(vault) {
  try {
    return await realpath(vault);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw fail("vault_missing", `Vault not found at ${vault}. Run 'node bin/vault-cli.mjs init' first.`);
    }
    throw error;
  }
}

async function resolveInside(vault, rel) {
  const norm = normalizeRelative(rel);
  const root = await vaultRoot(vault);
  const target = path.join(root, norm);
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      const relative = path.relative(root, real);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw fail("path_escape", "path resolves outside the vault.");
      }
      break;
    } catch (error) {
      if (error instanceof VaultToolError) throw error;
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw fail("path_escape", "path has no resolvable ancestor.");
      probe = parent;
    }
  }
  return { root, norm, target };
}

// ---------------------------------------------------------------- frontmatter

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function parseFrontmatter(text) {
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, body: text, block: null };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { data, body: text.slice(match[0].length), block: match[1] };
}

function touchFrontmatter(text, date) {
  const match = FRONTMATTER.exec(text);
  if (!match) return text;
  let block = match[1];
  for (const key of ["updated", "reviewed_at"]) {
    const re = new RegExp(`^${key}:.*$`, "m");
    block = re.test(block) ? block.replace(re, `${key}: ${date}`) : `${block}\n${key}: ${date}`;
  }
  return `---\n${block}\n---\n${text.slice(match[0].length)}`;
}

const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function buildFrontmatter({ norm, title, type, summary, tags, date }) {
  const slug = norm.replace(/\.md$/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  const heading = oneLine(title) || path.posix.basename(norm, ".md");
  const tagList = [...new Set((tags ?? []).map((t) => oneLine(t)).filter(Boolean))];
  return [
    "---",
    `id: ${type}-${slug}`,
    `title: ${JSON.stringify(heading)}`,
    `type: ${type}`,
    "status: active",
    `summary: ${JSON.stringify(oneLine(summary) || heading)}`,
    `created: ${date}`,
    `updated: ${date}`,
    `tags: [${tagList.map((t) => JSON.stringify(t)).join(", ")}]`,
    "sources: []",
    "confidence: medium",
    `reviewed_at: ${date}`,
    "authority: derived",
    "---",
    "",
    "",
  ].join("\n");
}

function titleOf(text, rel) {
  const { data, body } = parseFrontmatter(text);
  if (data.title) return data.title;
  const heading = /^#\s+(.+)$/m.exec(body);
  return heading ? heading[1].trim() : path.posix.basename(rel, ".md");
}

// ---------------------------------------------------------------- guards

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/, "GitHub token"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, "API key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, "JWT"],
  [/\b(?:api[_-]?key|secret|token|passwd|password)\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{20,}/i, "credential assignment"],
];

function assertNoSecrets(text) {
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw fail("secret_detected", `Refusing to store content that looks like a ${label}. Record only a typed redaction (for example '[redacted: api key]').`);
    }
  }
}

async function withFileLock(target, fn) {
  const lock = `${target}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      await handle.close();
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const info = await stat(lock);
        if (Date.now() - info.mtimeMs > 30_000) {
          await rm(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw fail("locked", `Another writer holds ${path.basename(target)}; retry shortly.`);
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

async function atomicWrite(target, text) {
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function readIfPresent(target) {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// ---------------------------------------------------------------- projects

async function gitOutput(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

// Name of the main repository. A linked worktree resolves to the repository that owns its git common dir,
// so worktrees with any directory name map to the same project.
async function repoName(cwd) {
  const common = await gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common) return path.basename(path.dirname(common));
  return path.basename((await gitOutput(cwd, ["rev-parse", "--show-toplevel"])) || path.resolve(cwd));
}

const ROW = /^\|\s*\[([^\]]*)\]\(\.\.\/projects\/([a-z0-9][a-z0-9-]*[a-z0-9])\/index\.md\)\s*\|\s*([^|]*?)\s*\|\s*((?:\\\||[^|])*?)\s*\|\s*((?:\\\||[^|])*?)\s*\|\s*((?:\\\||[^|])*?)\s*\|/;

async function loadRegistry(vault) {
  const text = await readIfPresent(path.join(vault, "_meta", "projects-index.md"));
  if (!text) return [];
  const rows = [];
  for (const line of text.split("\n")) {
    const m = ROW.exec(line);
    if (m) {
      rows.push({
        title: m[1],
        id: m[2],
        sourceDir: m[3].replace(/`/g, ""),
        classification: m[4],
        git: m[5],
      });
    }
  }
  return rows;
}

async function projectDirs(vault) {
  try {
    const entries = await readdir(path.join(vault, "projects"), { withFileTypes: true });
    return new Set(entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name));
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
}

function kebab(name) {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return PROJECT_ID.test(id) ? id : null;
}

export async function resolveProject(vault, { cwd, project } = {}) {
  const dirs = await projectDirs(vault);
  if (project) {
    assertProjectId(project);
    return dirs.has(project)
      ? { status: "resolved", projectId: project, via: "explicit" }
      : { status: "not_found", projectId: project, via: "explicit", candidates: [] };
  }
  if (!cwd) return { status: "unresolved", reason: "Neither project nor cwd was given.", candidates: [] };

  const base = await repoName(cwd);
  const registry = await loadRegistry(vault);
  let matches = registry.filter((r) => r.sourceDir === base);
  if (matches.length === 0) matches = registry.filter((r) => r.sourceDir.toLowerCase() === base.toLowerCase());

  if (matches.length > 1) {
    const branch = await gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const remote = await gitOutput(cwd, ["remote", "get-url", "origin"]);
    const remoteKey = remote.replace(/^.*[:/]([^/:]+\/[^/]+?)(?:\.git)?$/, "$1");
    const narrowed = matches.filter((r) => (branch && r.git.includes(`\`${branch}\``)) || (remoteKey && remote && r.git.includes(remoteKey)));
    if (narrowed.length === 1) {
      return { status: "resolved", projectId: narrowed[0].id, via: "registry+git", sourceDir: base };
    }
  }
  if (matches.length === 1) {
    return dirs.has(matches[0].id)
      ? { status: "resolved", projectId: matches[0].id, via: "registry", sourceDir: base }
      : { status: "not_found", projectId: matches[0].id, via: "registry", sourceDir: base, candidates: [] };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      sourceDir: base,
      candidates: matches.map((r) => ({ id: r.id, title: r.title, git: r.git })),
      reason: "Several registered projects share this source directory; pass project explicitly.",
    };
  }
  const guess = kebab(base);
  if (guess && dirs.has(guess)) return { status: "resolved", projectId: guess, via: "directory-name", sourceDir: base };
  return {
    status: "unregistered",
    sourceDir: base,
    suggestedId: guess,
    candidates: [],
    reason: "No registered project matches this directory. Call project_scaffold only for a stable repository.",
  };
}

async function requireProject(vault, { project, cwd }) {
  const resolution = await resolveProject(vault, { project, cwd });
  if (resolution.status === "resolved") return resolution.projectId;
  const code = resolution.status === "ambiguous" ? "project_ambiguous" : "project_unresolved";
  throw fail(code, resolution.reason ?? `Project ${resolution.projectId ?? ""} is ${resolution.status}.`, { resolution });
}

export async function listProjects(vault) {
  const status = await getVaultStatus(vault);
  if (!status.ok) throw fail("vault_missing", `Vault not found at ${vault}. Run 'node bin/vault-cli.mjs init' first.`);
  const registry = new Map((await loadRegistry(vault)).map((r) => [r.id, r]));
  return {
    vaultPath: status.vaultPath,
    projects: status.projects.map((p) => ({
      ...p,
      title: registry.get(p.id)?.title ?? p.id,
      sourceDir: registry.get(p.id)?.sourceDir ?? null,
      registered: registry.has(p.id),
    })),
  };
}

export async function createProject(vault, { project, title, sourceDir, cwd, classification, git, stack } = {}, { now } = {}) {
  assertProjectId(project);
  if (!fs.existsSync(path.join(vault, "_meta"))) {
    throw fail("vault_missing", `Vault not initialised at ${vault}. Run 'node bin/vault-cli.mjs init' first.`);
  }
  let dir = sourceDir ? oneLine(sourceDir) : undefined;
  if (!dir && cwd) dir = await repoName(cwd);
  if (dir && /[\\/|]/.test(dir)) throw fail("invalid_source_dir", "sourceDir must be a single directory name.");

  const registry = await loadRegistry(vault);
  const owner = dir ? registry.find((r) => r.sourceDir === dir && r.id !== project) : undefined;
  if (owner) throw fail("source_dir_conflict", `Source directory '${dir}' is already registered to project '${owner.id}'.`);

  const existed = (await projectDirs(vault)).has(project);
  await scaffoldProject(vault, project, oneLine(title) || project);

  let registered = false;
  const indexPath = path.join(vault, "_meta", "projects-index.md");
  if (dir && !registry.some((r) => r.id === project)) {
    await withFileLock(indexPath, async () => {
      const template = [
        "# ~/code Project Registry",
        "",
        "| Project | Source directory | Classification | Git identity / observed branch | Stack |",
        "|---|---|---|---|---|",
        "",
      ].join("\n");
      const text = (await readIfPresent(indexPath)) ?? template;
      const lines = text.split("\n");
      const cell = (v, fallback) => oneLine(v || fallback).replaceAll("|", "\\|");
      const row = `| [${cell(title, project)}](../projects/${project}/index.md) | ${cell(dir)} | ${cell(classification, "registered by agent-vault tool")} | ${cell(git, "not recorded")} | ${cell(stack, "not recorded")} |`;
      let at = -1;
      lines.forEach((line, i) => { if (ROW.test(line)) at = i; });
      if (at < 0) at = lines.findIndex((line) => /^\|\s*-{3,}/.test(line));
      if (at < 0) {
        lines.push("| Project | Source directory | Classification | Git identity / observed branch | Stack |", "|---|---|---|---|---|");
        at = lines.length - 1;
      }
      lines.splice(at + 1, 0, row);
      let updated = lines.join("\n");
      const rowCount = updated.split("\n").filter((line) => ROW.test(line)).length;
      updated = updated.replace(/Registry of \d+ project directories/, `Registry of ${rowCount} project directories`);
      updated = touchFrontmatter(updated, dateOf(now));
      await atomicWrite(indexPath, updated);
      registered = true;
    });
  }
  return { projectId: project, projectDir: path.join(vault, "projects", project), created: !existed, registered, sourceDir: dir ?? null };
}

// ---------------------------------------------------------------- read / list

export async function readMemory(vault, { path: rel, maxChars = 20_000, offset = 0 } = {}) {
  const { norm, target } = await resolveInside(vault, rel);
  if (!norm.endsWith(".md")) throw fail("invalid_path", "Only Markdown notes (.md) can be read.");
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if (error.code === "ENOENT") throw fail("not_found", `No note at ${norm}.`);
    throw error;
  }
  if (!info.isFile()) throw fail("invalid_path", `${norm} is not a file.`);
  if (info.size > 5_000_000) throw fail("too_large", `${norm} exceeds the 5 MB read limit.`);
  const buffer = await readFile(target);
  const text = buffer.toString("utf8");
  const start = clamp(offset, 0, text.length, 0);
  const cap = clamp(maxChars, 1, 100_000, 20_000);
  const content = text.slice(start, start + cap);
  return {
    path: norm,
    sha256: sha256(buffer),
    totalChars: text.length,
    offset: start,
    truncated: start + cap < text.length,
    frontmatter: parseFrontmatter(text).data,
    content,
  };
}

async function* walkMarkdown(dir, state) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (state.truncated) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      yield* walkMarkdown(full, state);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      if (++state.count > MAX_SCANNED_FILES) {
        state.truncated = true;
        return;
      }
      yield full;
    }
  }
}

async function scopeRoots(vault, { scope = "all", project, role, cwd, crossProject = false }) {
  if (!SCOPES.includes(scope)) throw fail("invalid_scope", `Invalid scope '${scope}'. Allowed: ${SCOPES.join(", ")}.`);
  switch (scope) {
    case "user": return ["user"];
    case "shared": return ["shared"];
    case "meta": return ["_meta"];
    case "project": return [`projects/${await requireProject(vault, { project, cwd })}`];
    case "logs": return [`projects/${await requireProject(vault, { project, cwd })}/logs`];
    case "agent": {
      const id = await requireProject(vault, { project, cwd });
      return [role ? `projects/${id}/agents/${assertRole(role)}` : `projects/${id}/agents`];
    }
    default: {
      const resolution = await resolveProject(vault, { project, cwd });
      if (project && resolution.status !== "resolved") {
        throw fail("project_unresolved", `Project '${project}' does not exist.`, { resolution });
      }
      if (resolution.status === "resolved" && !crossProject) return ["user", "shared", `projects/${resolution.projectId}`];
      return [""];
    }
  }
}

async function collectFiles(vault, options) {
  const root = await vaultRoot(vault);
  const state = { count: 0, truncated: false };
  const files = [];
  for (const rel of await scopeRoots(vault, options)) {
    for await (const file of walkMarkdown(path.join(root, rel), state)) files.push(file);
  }
  return { root, files, truncated: state.truncated };
}

export async function listMemory(vault, options = {}) {
  const limit = clamp(options.limit, 1, 500, 100);
  const { root, files, truncated } = await collectFiles(vault, options);
  const notes = [];
  for (const file of files.slice(0, limit)) {
    const text = await readFile(file, "utf8");
    const info = await stat(file);
    const rel = toPosix(path.relative(root, file));
    notes.push({ path: rel, title: titleOf(text, rel), updated: parseFrontmatter(text).data.updated ?? null, bytes: info.size });
  }
  return { total: files.length, returned: notes.length, truncated: truncated || files.length > limit, notes };
}

// ---------------------------------------------------------------- search

function tokenize(query) {
  const terms = [];
  for (const m of String(query ?? "").matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (m[1] ?? m[2]).trim().toLowerCase();
    if (term && !terms.includes(term)) terms.push(term);
  }
  return terms.slice(0, 8);
}

function countOccurrences(haystack, needle, cap) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && count < cap; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

export async function searchMemory(vault, options = {}) {
  const terms = tokenize(options.query);
  if (terms.length === 0) throw fail("invalid_query", "query must contain at least one search term.");
  const limit = clamp(options.limit, 1, 50, 10);
  const matchAll = (options.match ?? "all") !== "any";
  const { root, files, truncated } = await collectFiles(vault, options);

  const hits = [];
  for (let i = 0; i < files.length; i += 32) {
    await Promise.all(files.slice(i, i + 32).map(async (file) => {
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) return;
      const text = await readFile(file, "utf8");
      const lower = text.toLowerCase();
      const rel = toPosix(path.relative(root, file));
      const title = titleOf(text, rel);
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        const count = countOccurrences(lower, term, 20) + (rel.toLowerCase().includes(term) ? 1 : 0);
        if (count === 0) continue;
        matched++;
        score += count;
        if (title.toLowerCase().includes(term)) score += 5;
        if (rel.toLowerCase().includes(term)) score += 3;
      }
      if (matchAll ? matched !== terms.length : matched === 0) return;
      const snippets = [];
      const lines = text.split("\n");
      for (let n = 0; n < lines.length && snippets.length < 2; n++) {
        const lowerLine = lines[n].toLowerCase();
        if (terms.some((t) => lowerLine.includes(t))) snippets.push({ line: n + 1, text: lines[n].trim().slice(0, 240) });
      }
      hits.push({ path: rel, title, score, snippets });
    }));
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    query: options.query,
    terms,
    scanned: files.length,
    scanTruncated: truncated,
    totalMatches: hits.length,
    results: hits.slice(0, limit),
  };
}

// ---------------------------------------------------------------- write

export async function writeMemory(vault, input = {}, { now } = {}) {
  const { content, mode = "append", expectedHash, title, summary, type = "concept", tags } = input;
  if (!["create", "append", "replace"].includes(mode)) throw fail("invalid_mode", `Invalid mode '${mode}'. Use create, append or replace.`);
  if (typeof content !== "string" || !content.trim()) throw fail("invalid_content", "content must be a non-empty string.");
  if (content.length > MAX_WRITE_CHARS) throw fail("too_large", `content exceeds ${MAX_WRITE_CHARS} characters.`);
  assertNoSecrets(content);

  const norm = normalizeRelative(input.path);
  if (!norm.endsWith(".md")) throw fail("invalid_path", "Only Markdown notes (.md) can be written.");
  if (norm.split("/").some((segment) => segment.startsWith("."))) throw fail("invalid_path", "Hidden path segments are not writable.");
  if (!WRITABLE_ROOTS.some((root) => norm.startsWith(root))) {
    throw fail("path_not_writable", `Writes are limited to ${WRITABLE_ROOTS.join(", ")}. Use _meta tooling for registry changes.`);
  }
  if (norm.startsWith("user/") && mode !== "append") throw fail("append_only", "user/ notes are append-only; use mode 'append'.");
  if (norm.startsWith("projects/")) {
    const [, id, ...rest] = norm.split("/");
    assertProjectId(id);
    if (!(await projectDirs(vault)).has(id)) {
      throw fail("project_not_found", `Project '${id}' does not exist. Use project_scaffold first.`);
    }
    const history = rest[0] === "logs" || rest[0] === "long-term" || rest[0] === "worktrees" || (rest[0] === "agents" && rest[1] === "handoffs");
    if (history && mode === "replace") throw fail("append_only", "logs/, long-term/, worktrees/ and agents/handoffs/ are append-only history; replace is not allowed.");
    if (rest[0] === "agents" && rest[1] === "handoffs" && mode === "append") {
      throw fail("append_only", "Handoff files are immutable once created; create a new handoff instead.");
    }
  }

  const { target } = await resolveInside(vault, norm);
  const date = dateOf(now);
  await mkdir(path.dirname(target), { recursive: true });

  return withFileLock(target, async () => {
    try {
      if ((await lstat(target)).isSymbolicLink()) throw fail("symlink_refused", "Refusing to write through a symbolic link.");
    } catch (error) {
      if (error instanceof VaultToolError) throw error;
      if (error.code !== "ENOENT") throw error;
    }
    const existing = await readIfPresent(target);
    if (existing !== null && expectedHash && sha256(Buffer.from(existing, "utf8")) !== expectedHash) {
      throw fail("hash_mismatch", "The note changed since it was read. Re-read it and retry.");
    }
    const withHeader = (body) => (FRONTMATTER.test(body) ? body : buildFrontmatter({ norm, title, type, summary, tags, date }) + body);

    let next;
    if (mode === "create") {
      if (existing !== null) throw fail("exists", `${norm} already exists; use append or replace.`);
      next = touchFrontmatter(withHeader(content.trimEnd() + "\n"), date);
    } else if (mode === "append") {
      next = existing === null
        ? withHeader(content.trimEnd() + "\n")
        : touchFrontmatter(`${existing.trimEnd()}\n\n${content.trimEnd()}\n`, date);
    } else {
      if (existing === null) throw fail("not_found", `${norm} does not exist; use create.`);
      if (!expectedHash) throw fail("hash_required", "replace requires expectedHash from a prior memory_read.");
      const carried = FRONTMATTER.exec(existing);
      const body = FRONTMATTER.test(content) || !carried ? content : `${carried[0]}${content.replace(/^\s+/, "")}`;
      next = touchFrontmatter(withHeader(body.trimEnd() + "\n"), date);
    }
    await atomicWrite(target, next);
    return { path: norm, mode, created: existing === null, sha256: sha256(Buffer.from(next, "utf8")), bytes: Buffer.byteLength(next) };
  });
}

// ---------------------------------------------------------------- agents / logs / handoffs

export async function appendAgentMemory(vault, { project, cwd, role, title, content, tags } = {}, options) {
  assertRole(role);
  if (!oneLine(title)) throw fail("invalid_title", "title is required for an agent memory entry.");
  const id = await requireProject(vault, { project, cwd });
  const date = dateOf(options?.now);
  return writeMemory(vault, {
    path: `projects/${id}/agents/${role}/memory.md`,
    mode: "append",
    content: `## ${date} — ${oneLine(title)}\n\n${String(content ?? "").trim()}`,
    title: `${id} ${role} agent memory`,
    summary: `Durable ${role} memory for ${id}.`,
    tags: ["agent-memory", id, role, ...(tags ?? [])],
  }, options);
}

export async function readAgentMemory(vault, { project, cwd, role, maxChars } = {}) {
  const id = await requireProject(vault, { project, cwd });
  if (!role) {
    const roles = [];
    for (const name of AGENT_ROLES) {
      const target = path.join(vault, "projects", id, "agents", name, "memory.md");
      const info = await stat(target).catch(() => null);
      roles.push({ role: name, exists: Boolean(info), bytes: info?.size ?? 0, path: `projects/${id}/agents/${name}/memory.md` });
    }
    return { projectId: id, roles };
  }
  assertRole(role);
  return { projectId: id, ...(await readMemory(vault, { path: `projects/${id}/agents/${role}/memory.md`, maxChars })) };
}

export async function writeHandoff(vault, { project, cwd, slug, from, to, title, content } = {}, options) {
  assertSlug(slug);
  assertRole(from);
  assertRole(to);
  const id = await requireProject(vault, { project, cwd });
  const date = dateOf(options?.now);
  const heading = oneLine(title) || slug;
  return writeMemory(vault, {
    path: `projects/${id}/agents/handoffs/${date}-task-${slug}.md`,
    mode: "create",
    type: "handoff",
    title: heading,
    summary: `Handoff from ${from} to ${to}: ${heading}`,
    tags: ["handoff", id, from, to],
    content: `# ${heading}\n\n- From: ${from}\n- To: ${to}\n- Date: ${date}\n\n${String(content ?? "").trim()}`,
  }, options);
}

export async function writeLog(vault, { project, cwd, kind = "work", slug, title, content } = {}, options) {
  if (!LOG_KINDS.includes(kind)) throw fail("invalid_kind", `Invalid log kind '${kind}'. Allowed: ${LOG_KINDS.join(", ")}.`);
  assertSlug(slug);
  const id = await requireProject(vault, { project, cwd });
  const date = dateOf(options?.now);
  const heading = oneLine(title) || slug;
  return writeMemory(vault, {
    path: `projects/${id}/logs/${date}-${kind}-${slug}.md`,
    mode: "create",
    type: "report",
    title: heading,
    summary: heading,
    tags: [kind, id, "log"],
    content: `# ${heading}\n\n${String(content ?? "").trim()}`,
  }, options);
}

// ---------------------------------------------------------------- context

export async function getContext(vault, { cwd, project, role = "coordinator", maxChars = 24_000 } = {}) {
  assertRole(role);
  if (!fs.existsSync(path.join(vault, "_meta"))) {
    return {
      vaultPath: vault,
      vaultReady: false,
      hint: "Vault not initialised. Run 'node bin/vault-cli.mjs init' (or set OMP_VAULT_PATH).",
    };
  }
  const resolution = await resolveProject(vault, { cwd, project });
  let remaining = clamp(maxChars, 2000, 100_000, 24_000);
  const take = async (rel, cap) => {
    const text = await readIfPresent(path.join(vault, rel));
    if (text === null) return null;
    const limit = Math.min(cap, remaining);
    const content = text.slice(0, limit);
    remaining -= content.length;
    return { path: rel, content, truncated: text.length > limit };
  };

  const context = {
    vaultPath: vault,
    vaultReady: true,
    project: resolution,
    role,
    user: {
      profile: await take("user/profile.md", 5000),
      codingStandards: await take("user/coding-standards.md", 5000),
    },
    projectIndex: null,
    shortTermMemory: null,
    roleMemory: null,
    recentLogs: [],
    longTermRecent: [],
    worktree: null,
  };
  if (resolution.status === "resolved") {
    const id = resolution.projectId;
    context.projectIndex = await take(`projects/${id}/index.md`, 5000);
    context.shortTermMemory = await take(`projects/${id}/memory.md`, 6000);
    context.roleMemory = await take(`projects/${id}/agents/${role}/memory.md`, 6000);
    const newestFirst = (dir) => readdir(path.join(vault, "projects", id, dir)).catch(() => []).then((names) => names.filter((n) => n.endsWith(".md")).sort().reverse());
    context.recentLogs = (await newestFirst("logs")).slice(0, 5).map((n) => `projects/${id}/logs/${n}`);
    context.longTermRecent = (await newestFirst("long-term")).slice(0, 10).map((n) => `projects/${id}/long-term/${n}`);
    if (cwd) {
      const wt = await worktreeIdentity(cwd);
      const records = await newestFirst(`worktrees/${wt.key}`);
      context.worktree = { key: wt.key, branch: wt.branch, records: records.slice(0, 10).map((n) => `projects/${id}/worktrees/${wt.key}/${n}`) };
    }
  }
  return context;
}

// ---------------------------------------------------------------- short-term memory

// Mutable working state for one project: projects/<id>/memory.md. Replacing it requires the hash that was read.
export async function shortMemoryRead(vault, { project, cwd, maxChars } = {}) {
  const id = await requireProject(vault, { project, cwd });
  const rel = `projects/${id}/memory.md`;
  try {
    return { projectId: id, exists: true, ...(await readMemory(vault, { path: rel, maxChars })) };
  } catch (error) {
    if (error.code === "not_found") return { projectId: id, exists: false, path: rel };
    throw error;
  }
}

export async function shortMemoryWrite(vault, { project, cwd, content, expectedHash, summary } = {}, options) {
  const id = await requireProject(vault, { project, cwd });
  const rel = `projects/${id}/memory.md`;
  const exists = (await shortMemoryRead(vault, { project: id })).exists;
  return writeMemory(vault, {
    path: rel,
    mode: exists ? "replace" : "create",
    expectedHash: exists ? expectedHash : undefined,
    content,
    title: `${id} short-term memory`,
    summary: oneLine(summary) || `Current working state for ${id}.`,
    type: "project",
    tags: ["short-term", id],
  }, options);
}

// ---------------------------------------------------------------- long-term memory (dated, append-only)

export async function longTermWrite(vault, { project, cwd, slug, title, content, summary, tags } = {}, options) {
  assertSlug(slug);
  const id = await requireProject(vault, { project, cwd });
  const date = dateOf(options?.now);
  const heading = oneLine(title) || slug;
  return writeMemory(vault, {
    path: `projects/${id}/long-term/${date}-${slug}.md`,
    mode: "create",
    type: "concept",
    title: heading,
    summary: oneLine(summary) || heading,
    tags: ["long-term", id, ...(tags ?? [])],
    content: `# ${heading}\n\n${String(content ?? "").trim()}`,
  }, options);
}

// ---------------------------------------------------------------- worktree records

const slugify = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// Identity of the worktree that contains cwd. Uses the branch name; detached HEAD falls back to the directory name plus a hash of its path.
// The absolute path is never returned, so machine paths stay out of the vault.
export async function worktreeIdentity(cwd) {
  const top = (await gitOutput(cwd, ["rev-parse", "--show-toplevel"])) || path.resolve(cwd);
  const branch = await gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const detached = !branch || branch === "HEAD";
  const name = path.basename(top);
  const label = detached ? `${name}-${sha256(top).slice(0, 8)}` : branch;
  return { key: slugify(label) || "worktree", branch: detached ? null : branch, directory: name, detached };
}

export async function worktreeRecord(vault, { project, cwd, kind, slug, title, content } = {}, options) {
  if (!WORKTREE_KINDS.includes(kind)) throw fail("invalid_kind", `Invalid worktree record kind '${kind}'. Allowed: ${WORKTREE_KINDS.join(", ")}.`);
  assertSlug(slug);
  const id = await requireProject(vault, { project, cwd });
  const wt = await worktreeIdentity(cwd ?? process.cwd());
  const date = dateOf(options?.now);
  const heading = oneLine(title) || slug;
  return writeMemory(vault, {
    path: `projects/${id}/worktrees/${wt.key}/${date}-${kind}-${slug}.md`,
    mode: "create",
    type: "report",
    title: heading,
    summary: `${kind} record for worktree ${wt.key}: ${heading}`,
    tags: ["worktree", kind, id, wt.key],
    content: `# ${heading}\n\n- Worktree: ${wt.key}\n- Branch: ${wt.branch ?? "detached HEAD"}\n- Kind: ${kind}\n- Date: ${date}\n\n${String(content ?? "").trim()}`,
  }, options);
}

export async function worktreeList(vault, { project, cwd } = {}) {
  const id = await requireProject(vault, { project, cwd });
  const root = path.join(vault, "projects", id, "worktrees");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const worktrees = [];
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const files = (await readdir(path.join(root, entry.name))).filter((f) => f.endsWith(".md")).sort();
    worktrees.push({
      key: entry.name,
      records: files.length,
      latest: files.length ? `projects/${id}/worktrees/${entry.name}/${files[files.length - 1]}` : null,
    });
  }
  return { projectId: id, worktrees: worktrees.sort((a, b) => a.key.localeCompare(b.key)) };
}
