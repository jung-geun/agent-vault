import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, realpath, rename, rm, stat, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import os from "node:os";
import { getVaultStatus, scaffoldProject } from "./vault-core.mjs";
import { joinModeFor, loadSettings, resolveHarness } from "./settings.mjs";
import { openMemoryDb, memoryDbFile, insertMemory, searchMemories } from "./memory-db.mjs";
import { weeklyAttribution, syncWeeklyMemory } from "./weekly-memory.mjs";
import { parseSearchMode } from "./search-modes.mjs";
import { REGEX_LIMITS, searchRegex } from "./regex-search.mjs";
import { rankByCharSimilarity } from "./similarity.mjs";
import { findSecretLabel } from "./secret-detector.mjs";

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

export async function resolveInside(vault, rel) {
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

function touchFrontmatter(text, date, timestamp) {
  const match = FRONTMATTER.exec(text);
  if (!match) return text;
  let block = match[1];
  for (const key of ["updated", "reviewed_at"]) {
    const re = new RegExp(`^${key}:.*$`, "m");
    block = re.test(block) ? block.replace(re, `${key}: ${date}`) : `${block}\n${key}: ${date}`;
  }
  if (timestamp) {
    const line = `updated_at: ${timestamp}`;
    block = /^updated_at:.*$/m.test(block) ? block.replace(/^updated_at:.*$/m, line) : `${block}\n${line}`;
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

export function assertNoSecrets(text) {
  const label = findSecretLabel(text);
  if (label) throw fail("secret_detected", `Refusing to store content that looks like a ${label}. Record only a typed redaction (for example '[redacted: api key]').`);
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

  const registry = await loadRegistry(vault);
  // The checkout's own directory name wins, so a linked worktree with its own registry row resolves to that row.
  // The main repository's name is used only when the checkout itself is not registered.
  const own = path.basename((await gitOutput(cwd, ["rev-parse", "--show-toplevel"])) || path.resolve(cwd));
  const sameName = (name) => {
    const exact = registry.filter((r) => r.sourceDir === name);
    return exact.length ? exact : registry.filter((r) => r.sourceDir.toLowerCase() === name.toLowerCase());
  };
  let base = own;
  let matches = sameName(own);
  if (matches.length === 0) {
    const main = await repoName(cwd);
    if (main !== own) {
      base = main;
      matches = sameName(main);
    }
  }

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
    reason: "No registered project matches this directory. Register a stable repository with project_create, or add an empty .agent-vault-project file at its git top level and the recorder registers it on the next write.",
  };
}

export async function requireProject(vault, { project, cwd }) {
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
  if (!dir && cwd) dir = path.basename((await gitOutput(cwd, ["rev-parse", "--show-toplevel"])) || path.resolve(cwd));
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

// Opt-in auto registration: a checkout (or its main repository) whose git top level holds the marker file is registered on first use.
// Unmarked directories stay unregistered, so temp checkouts never reach the registry.
export const PROJECT_MARKER = ".agent-vault-project";

// Adds the marker to the checkout's local exclude (shared by linked worktrees via the common dir) so `git add -A` never sweeps it in.
// Idempotent; no-op outside git repositories.
async function excludeMarker(cwd) {
  try {
    const exclude = await gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
    if (!exclude) return null;
    const text = (await readIfPresent(exclude)) ?? "";
    if (text.split("\n").includes(PROJECT_MARKER)) return null;
    await fs.promises.mkdir(path.dirname(exclude), { recursive: true });
    await fs.promises.appendFile(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}${PROJECT_MARKER}\n`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Join modes (settings.join): "manual" registers only checkouts that carry the marker file (or that were scaffolded explicitly);
// "auto" also registers every Git checkout the first time the harness touches it. Auto needs a Git top level and never
// registers the home directory or the filesystem root, so stray non-project directories stay out of the registry.
export async function autoRegisterProject(vault, { cwd, harness } = {}, { now } = {}) {
  const resolution = await resolveProject(vault, { cwd });
  if (!cwd) return { ...resolution, autoRegistered: false };
  const mode = joinModeFor(loadSettings(vault), resolveHarness(harness));
  const gitTop = await gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  const top = gitTop || path.resolve(cwd);
  // A linked worktree may lack an uncommitted marker, so the main repository root (owner of the git common dir) is checked too.
  const common = await gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const roots = [top, common ? path.dirname(common) : top];
  const marked = roots.some((root) => fs.existsSync(path.join(root, PROJECT_MARKER)));
  if (!marked) {
    if (mode !== "auto") return { ...resolution, joinMode: mode, autoRegistered: false };
    const resolved = path.resolve(top);
    if (!gitTop || resolved === path.resolve(os.homedir()) || resolved === path.parse(resolved).root) {
      return { ...resolution, joinMode: mode, autoRegistered: false, joinSkipped: "Auto-join needs a Git checkout that is not the home directory or the filesystem root." };
    }
  }
  const excludeWarning = marked ? await excludeMarker(cwd) : null;
  if (resolution.status !== "unregistered") return { ...resolution, joinMode: mode, autoRegistered: false, excludeWarning };
  if (!resolution.suggestedId) {
    throw fail("invalid_project_id", `Cannot derive a project ID from '${resolution.sourceDir}'. Rename the directory to kebab-case or call project_create with an explicit project.`);
  }
  const created = await createProject(vault, {
    project: resolution.suggestedId,
    title: resolution.sourceDir,
    sourceDir: resolution.sourceDir,
    cwd,
    classification: marked ? "auto-registered (marker file)" : "auto-registered (auto-join mode)",
  }, { now });
  return { status: "resolved", projectId: created.projectId, via: "auto-registered", sourceDir: created.sourceDir, joinMode: mode, autoRegistered: true, excludeWarning };
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
      if (entry.name === "weekly" && /(?:\/projects\/[^/]+|\/shared\/knowledge)$/.test(toPosix(dir))) continue;
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

// regex and similar modes for Markdown notes. Notes are files, not SQLite rows, so similarity here is character-set only.
const NOTE_BATCH = 32;

// Notes are streamed so that memory stays bounded: 20 000 files of up to 1 MB each must never be held at once. Only stat results,
// text clipped to what a mode can use, and the hits survive a batch; at most NOTE_BATCH whole files are in memory at a time.
async function noteInfos(files) {
  const infos = [];
  for (let i = 0; i < files.length; i += NOTE_BATCH) {
    await Promise.all(files.slice(i, i + NOTE_BATCH).map(async (file) => {
      const info = await stat(file);
      if (info.size <= MAX_FILE_BYTES) infos.push({ file, mtimeMs: info.mtimeMs });
    }));
  }
  return infos;
}

async function readNotes(root, infos, maxChars) {
  const rows = [];
  for (let i = 0; i < infos.length; i += NOTE_BATCH) {
    rows.push(...await Promise.all(infos.slice(i, i + NOTE_BATCH).map(async ({ file }) => {
      const text = await readFile(file, "utf8");
      const rel = toPosix(path.relative(root, file));
      const cut = text.length > maxChars;
      // A V8 slice would keep the whole parent string alive; copy the clipped part so the full body can be collected.
      const content = cut ? Buffer.from(text.slice(0, maxChars), "utf8").toString("utf8") : text;
      return { path: rel, title: titleOf(text, rel), content, cut };
    })));
  }
  return rows;
}

async function searchNotesByMode(vault, options, parsed) {
  if (parsed.mode === "similar" && parsed.method === "embedding") {
    throw fail("unsupported_mode", "Markdown notes support character similarity only; embeddings cover SQLite memories (long_search, recall, history). Use method chars or auto.");
  }
  const { root, files, truncated } = await collectFiles(vault, options);
  const infos = await noteInfos(files);
  if (parsed.mode === "regex") {
    infos.sort((a, b) => a.file.localeCompare(b.file));
    const hits = new Map();
    let scanned = 0;
    let cut = false;
    // The worker takes at most maxRows items per call, so scan every note in chunks; a catastrophic pattern fails on the first chunk.
    for (let i = 0; i < infos.length; i += REGEX_LIMITS.maxRows) {
      const rows = await readNotes(root, infos.slice(i, i + REGEX_LIMITS.maxRows), REGEX_LIMITS.maxScanChars);
      scanned += rows.length;
      cut ||= rows.some((row) => row.cut);
      const titles = new Map(rows.map((row) => [row.path, row.title]));
      const chunk = rows.map((row) => ({ key: row.path, texts: { title: row.title, path: row.path, content: row.content } }));
      for (const hit of await searchRegex(chunk, parsed.query, { flags: parsed.flags })) hits.set(hit.key, { ...hit, title: titles.get(hit.key) });
    }
    const results = [...hits.values()]
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, parsed.limit)
      .map((hit) => ({ path: hit.key, title: hit.title, score: hit.count, match: { field: hit.field, excerpt: hit.excerpt, count: hit.count } }));
    return {
      query: options.query, scanned, scanTruncated: truncated, totalMatches: hits.size, results,
      search: { mode: "regex", method: "regex", flags: parsed.flags, candidates: scanned, scanned, truncated: truncated || cut },
    };
  }
  // Similarity needs every candidate's character grams at once for rarity weighting, so it scores the newest maxRows notes by
  // modification time, the same cap as SQLite memories.
  infos.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  const rows = await readNotes(root, infos.slice(0, REGEX_LIMITS.maxRows), 8000);
  const capped = infos.length > REGEX_LIMITS.maxRows;
  const ranked = rankByCharSimilarity(rows, parsed.query, { textOf: (row) => `${row.path}\n${row.title}\n${row.content}`, limit: parsed.limit });
  return {
    query: options.query, scanned: rows.length, scanTruncated: truncated, totalMatches: ranked.length,
    results: ranked.map(({ row, score }) => ({ path: row.path, title: row.title, similarity: Number(score.toFixed(4)) })),
    search: { mode: "similar", method: "chars", candidates: rows.length, truncated: truncated || capped, note: "Markdown notes use character similarity over the newest 500 notes by modification time; embeddings cover SQLite memories only." },
  };
}

export async function searchMemory(vault, options = {}) {
  const parsed = parseSearchMode(options);
  if (parsed.mode !== "keyword") return searchNotesByMode(vault, options, parsed);
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
  for (const value of [content, title, summary, ...(tags ?? [])]) if (typeof value === "string") assertNoSecrets(value);

  const norm = normalizeRelative(input.path);
  if (!norm.endsWith(".md")) throw fail("invalid_path", "Only Markdown notes (.md) can be written.");
  if (norm.split("/").some((segment) => segment.startsWith("."))) throw fail("invalid_path", "Hidden path segments are not writable.");
  if (!WRITABLE_ROOTS.some((root) => norm.startsWith(root))) {
    throw fail("path_not_writable", `Writes are limited to ${WRITABLE_ROOTS.join(", ")}. Use _meta tooling for registry changes.`);
  }
  if (norm.startsWith("user/") && mode !== "append") throw fail("append_only", "user/ notes are append-only; use mode 'append'.");
  if (/^(?:projects\/[^/]+|shared\/knowledge)\/weekly\//.test(norm)) throw fail("sqlite_memory_required", "Weekly Markdown is a generated view. Write through memory and journal tools.");
  if (norm.startsWith("projects/")) {
    const [, id, ...rest] = norm.split("/");
    assertProjectId(id);
    if (!(await projectDirs(vault)).has(id)) {
      throw fail("project_not_found", `Project '${id}' does not exist. Use project_create first.`);
    }
    if (["long-term", "logs", "worktrees"].includes(rest[0]) || (rest[0] === "agents" && (rest[1] === "handoffs" || (AGENT_ROLES.includes(rest[1]) && rest[2] === "memory.md")))) {
      throw fail("sqlite_memory_required", "Durable knowledge and journals live in SQLite. Use remember, log_write, worktree_record or handoff; legacy Markdown is read-only.");
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
      if (!expectedHash) throw fail("hash_required", "replace requires expectedHash from a prior doc_read.");
      const carried = FRONTMATTER.exec(existing);
      const body = FRONTMATTER.test(content) || !carried ? content : `${carried[0]}${content.replace(/^\s+/, "")}`;
      next = touchFrontmatter(withHeader(body.trimEnd() + "\n"), date);
    }
    if (/^(?:projects\/[^/]+\/(?:memory\.md|agents\/[^/]+\/short-term\.md)|shared\/knowledge\/memory\/(?:global-short-term\.md|agents\/[^/]+-short-term\.md))$/.test(norm)) {
      next = touchFrontmatter(next, date, (now ?? new Date()).toISOString());
    }
    await atomicWrite(target, next);
    return { path: norm, mode, created: existing === null, sha256: sha256(Buffer.from(next, "utf8")), bytes: Buffer.byteLength(next) };
  });
}

const ACCESS_TOOLS = new Set([
  "history", "persona_observe", "persona_read", "persona_resolve",
  "doc_read", "doc_search", "doc_list", "doc_write",
  "role_read", "role_write", "handoff",
  "short_read", "short_write", "remember", "long_search", "review", "review_resolve", "reconsider",
  "worktree_list", "worktree_record", "project_list", "project_create", "log_write", "context",
]);

// Records tool usage without query text, note content, hashes, or machine paths.
export async function appendAccessEvent(vault, { tool, args = {}, result, now = new Date() } = {}) {
  if (process.env.AGENT_VAULT_DISABLE_ACCESS_LOG === "1" || !ACCESS_TOOLS.has(tool)) return;

  const notePath = result?.path ?? null;
  const paths = (result?.results ?? result?.notes ?? [])
    .map((note) => note.path)
    .filter((notePath) => typeof notePath === "string")
    .slice(0, 100);
  const pathProject = notePath?.match(/^projects\/([a-z0-9][a-z0-9-]*[a-z0-9])\//)?.[1];
  const pathRole = notePath?.match(/^projects\/[^/]+\/agents\/(coordinator|builder|investigator|reviewer)\//)?.[1];
  const role = args.role ?? args.from ?? pathRole;
  const resultCount = result?.totalMatches ?? result?.notes?.length ?? result?.projects?.length ?? result?.total ?? (result ? 1 : 0);
  const event = {
    ts: now.toISOString(),
    tool,
    project: args.project ?? pathProject ?? result?.project?.projectId ?? result?.projectId ?? null,
    role: AGENT_ROLES.includes(role) ? role : null,
    path: notePath,
    paths,
    resultCount,
    created: result?.created === true,
  };
  const { target } = await resolveInside(vault, ".agent-vault/access.jsonl");
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await withFileLock(target, async () => {
    try {
      if ((await lstat(target)).isSymbolicLink()) throw fail("symlink_refused", "Refusing to write through a symbolic link.");
    } catch (error) {
      if (error instanceof VaultToolError) throw error;
      if (error.code !== "ENOENT") throw error;
    }
    await appendFile(target, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  });
}

// ---------------------------------------------------------------- agents / logs / handoffs


async function writeJournal(vault, { project, taskId, kind, slug, title, content, worktree = null }, { now = new Date() } = {}) {
  if (typeof title !== "string" || !title.trim() || title.length > 200) throw fail("invalid_title", "title must contain 1–200 characters.");
  if (typeof content !== "string" || !content.trim() || content.length > MAX_WRITE_CHARS) throw fail("invalid_content", "content must contain 1–200000 characters.");
  assertNoSecrets(title);
  assertNoSecrets(content);
  const attribution = await weeklyAttribution(vault, { taskId }, { now });
  const db = await openMemoryDb(memoryDbFile(vault));
  const { memory, duplicate } = insertMemory(db, {
    scope: "project", project, role: null, kind, worktree, ...attribution,
    slug: `${kind}:${worktree ?? ""}:${attribution.eventDate}:${slug}`,
    title: title.trim(), content, tags: [],
  }, now);
  const projection = await syncWeeklyMemory(vault, { scope: "project", project }, { now });
  return { scope: "project", project, id: memory.id, ref: `memory:${memory.id}`, created: !duplicate, duplicate, weekKey: memory.weekKey, eventDate: memory.eventDate, projection };
}

export async function writeHandoff(vault, { project, cwd, taskId, slug, from, to, title, content } = {}, options) {
  assertSlug(slug);
  assertRole(from);
  assertRole(to);
  const id = await requireProject(vault, { project, cwd });
  return writeJournal(vault, { project: id, taskId, kind: "handoff", slug: `${from}:${to}:${slug}`, title: oneLine(title) || slug, content: `From: ${from}\nTo: ${to}\n\n${String(content ?? "").trim()}` }, options);
}

export async function writeLog(vault, { project, cwd, taskId, kind = "work", slug, title, content } = {}, options) {
  if (!LOG_KINDS.includes(kind)) throw fail("invalid_kind", `Invalid log kind '${kind}'. Allowed: ${LOG_KINDS.join(", ")}.`);
  assertSlug(slug);
  const id = await requireProject(vault, { project, cwd });
  return writeJournal(vault, { project: id, taskId, kind: "log", slug: `${kind}:${slug}`, title: oneLine(title) || slug, content: `Kind: ${kind}\n\n${String(content ?? "").trim()}` }, options);
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
    const { target } = await resolveInside(vault, rel);
    const text = await readIfPresent(target);
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
    agentShortTermMemory: null,
    globalShortTermMemory: await take("shared/knowledge/memory/global-short-term.md", 4000),
    globalAgentShortTermMemory: await take(`shared/knowledge/memory/agents/${role}-short-term.md`, 4000),
    roleMemory: null,
    recentLogs: [],
    worktree: null,
  };
  if (resolution.status === "resolved") {
    const id = resolution.projectId;
    context.projectIndex = await take(`projects/${id}/index.md`, 5000);
    context.shortTermMemory = await take(`projects/${id}/memory.md`, 6000);
    context.agentShortTermMemory = await take(`projects/${id}/agents/${role}/short-term.md`, 4000);
    const db = await openMemoryDb(memoryDbFile(vault));
    context.recentLogs = searchMemories(db, { scope: "project", project: id, kind: "log", limit: 5 }).map((record) => `memory:${record.id}`);
    if (cwd) {
      const wt = await worktreeIdentity(cwd);
      const records = db.prepare("SELECT id FROM memories WHERE scope = 'project' AND project = ? AND kind = 'worktree' AND worktree = ? ORDER BY id DESC LIMIT 10").all(id, wt.key);
      context.worktree = { key: wt.key, branch: wt.branch, records: records.map((record) => `memory:${record.id}`) };
    }
  }
  return context;
}

// ---------------------------------------------------------------- short-term memory

// Short-term memory is mutable working state kept in Markdown, one file per scope:
//   project            projects/<id>/memory.md
//   project + role     projects/<id>/agents/<role>/short-term.md
//   global             shared/knowledge/memory/global-short-term.md
//   global + role      shared/knowledge/memory/agents/<role>-short-term.md
// Replacing a file requires the hash that was read.
export async function shortTermTarget(vault, { scope = "project", role, project, cwd } = {}) {
  if (role !== undefined && role !== null) assertRole(role);
  const agent = role ?? null;
  if (scope === "global") {
    if (project) throw fail("invalid_scope", "Global short-term memory cannot specify a project.");
    return { scope, role: agent, projectId: null, rel: agent ? `shared/knowledge/memory/agents/${agent}-short-term.md` : "shared/knowledge/memory/global-short-term.md" };
  }
  if (scope !== "project") throw fail("invalid_scope", `Short-term memory scope must be 'project' or 'global', got '${scope}'.`);
  const id = await requireProject(vault, { project, cwd });
  return { scope, role: agent, projectId: id, rel: agent ? `projects/${id}/agents/${agent}/short-term.md` : `projects/${id}/memory.md` };
}

export async function shortMemoryRead(vault, { scope, role, project, cwd, maxChars } = {}) {
  const target = await shortTermTarget(vault, { scope, role, project, cwd });
  const { rel, ...identity } = target;
  try {
    return { ...identity, exists: true, ...(await readMemory(vault, { path: rel, maxChars })) };
  } catch (error) {
    if (error.code === "not_found") return { ...identity, exists: false, path: rel };
    throw error;
  }
}

export async function shortMemoryWrite(vault, { scope, role, project, cwd, content, expectedHash, summary } = {}, options) {
  const target = await shortTermTarget(vault, { scope, role, project, cwd });
  const exists = (await shortMemoryRead(vault, { scope: target.scope, role: target.role ?? undefined, project: target.projectId ?? undefined })).exists;
  const label = [target.projectId ?? "global", target.role].filter(Boolean).join(" ");
  const written = await writeMemory(vault, {
    path: target.rel,
    mode: exists ? "replace" : "create",
    expectedHash: exists ? expectedHash : undefined,
    content,
    title: `${label} short-term memory`,
    summary: oneLine(summary) || `Current working state for ${label}.`,
    type: "project",
    tags: ["short-term", target.projectId ?? "global", ...(target.role ? [target.role] : [])],
  }, options);
  return { scope: target.scope, role: target.role, projectId: target.projectId, ...written };
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

export async function worktreeRecord(vault, { project, cwd, taskId, kind, slug, title, content } = {}, options) {
  if (!WORKTREE_KINDS.includes(kind)) throw fail("invalid_kind", `Invalid worktree record kind '${kind}'. Allowed: ${WORKTREE_KINDS.join(", ")}.`);
  assertSlug(slug);
  const id = await requireProject(vault, { project, cwd });
  const wt = await worktreeIdentity(cwd ?? process.cwd());
  return writeJournal(vault, {
    project: id, taskId, kind: "worktree", worktree: wt.key, slug: `${kind}:${slug}`, title: oneLine(title) || slug,
    content: `Worktree: ${wt.key}\nBranch: ${wt.branch ?? "detached HEAD"}\nKind: ${kind}\n\n${String(content ?? "").trim()}`,
  }, options);
}

export async function worktreeList(vault, { project, cwd } = {}) {
  const id = await requireProject(vault, { project, cwd });
  const db = await openMemoryDb(memoryDbFile(vault));
  const rows = db.prepare("SELECT worktree, COUNT(*) AS records, MAX(id) AS latest FROM memories WHERE scope = 'project' AND project = ? AND kind = 'worktree' AND worktree IS NOT NULL GROUP BY worktree ORDER BY worktree").all(id);
  return { projectId: id, worktrees: rows.map((row) => ({ key: row.worktree, records: row.records, latest: `memory:${row.latest}` })) };
}
