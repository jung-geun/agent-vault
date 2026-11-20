import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { getInstallTargets, installOmpIntegrations, installSkillFiles, ownedSkillDirectory, packageFiles, writeAtomic } from "./installer.mjs";

const execFileAsync = promisify(execFile);

export const UPDATE_REPOSITORY = "jung-geun/agent-vault";
export const UPDATE_BACKUPS_KEPT = 3;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

function fail(code, message) {
  return Object.assign(new Error(message), { code, name: "UpdateError" });
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Compare two semantic versions: -1, 0 or 1. A release is newer than its own prerelease. */
export function compareVersions(a, b) {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) throw fail("invalid_version", `Cannot compare versions '${a}' and '${b}'.`);
  for (let i = 1; i <= 3; i++) if (Number(left[i]) !== Number(right[i])) return Number(left[i]) < Number(right[i]) ? -1 : 1;
  if (left[4] === right[4]) return 0;
  if (left[4] === undefined) return 1;
  if (right[4] === undefined) return -1;
  return left[4] < right[4] ? -1 : 1;
}

/** The URL and headers for a GitHub source archive of `ref`. A token is only ever sent to api.github.com. */
export function githubArchiveRequest(ref, token) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(ref) || ref.includes("..")) throw fail("invalid_ref", `'${ref}' is not a valid branch, tag or commit.`);
  return token
    ? { url: `https://api.github.com/repos/${UPDATE_REPOSITORY}/tarball/${ref}`, headers: { Authorization: `Bearer ${token}` } }
    : { url: `https://github.com/${UPDATE_REPOSITORY}/archive/${ref}.tar.gz`, headers: {} };
}

function assertDownloadUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw fail("invalid_archive_url", "The archive URL is not valid."); }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return url;
  throw fail("invalid_archive_url", "The archive URL must use https (plain http is only accepted for loopback addresses).");
}

async function* capped(stream) {
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_ARCHIVE_BYTES) throw fail("archive_too_large", `The archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB.`);
    yield chunk;
  }
}

async function downloadArchive({ url, headers = {} }, destination, fetchImpl) {
  const target = assertDownloadUrl(url);
  const response = await fetchImpl(target, { headers: { ...headers, "User-Agent": "agent-vault-update" }, redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw fail("download_failed", `${target.host} answered HTTP ${response.status}.`);
  if (Number(response.headers.get("content-length")) > MAX_ARCHIVE_BYTES) throw fail("archive_too_large", `The archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB.`);
  if (!response.body) throw fail("download_failed", "The archive response was empty.");
  await pipeline(Readable.fromWeb(response.body), capped, createWriteStream(destination, { mode: 0o600 }));
}

async function ghToken() {
  try { return (await execFileAsync("gh", ["auth", "token"], { timeout: 5_000 })).stdout.trim() || undefined; } catch { return undefined; }
}

async function readManifest(dir) {
  try { return JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")); } catch { return null; }
}

/** Check that `dir` is an Agent Vault bundle that can be installed, and return its version. */
export async function validateSource(dir) {
  const manifest = await readManifest(dir);
  if (manifest?.name !== "agent-vault-skill") throw fail("invalid_source", "The source is not an Agent Vault bundle (package.json name must be agent-vault-skill).");
  if (!VERSION.test(manifest.version ?? "")) throw fail("invalid_source", `The source has no usable version (${JSON.stringify(manifest.version)}).`);
  for (const required of ["bin/vault-cli.mjs", "bin/vault-mcp.mjs", "SKILL.md", "integrations/omp/agent-vault.rule.md", "integrations/omp/agent-vault-recorder.ts"]) {
    if (!(await stat(path.join(dir, required)).catch(() => null))?.isFile()) throw fail("invalid_source", `The source does not contain ${required}.`);
  }
  await packageFiles(dir);
  return manifest.version;
}

/**
 * Locate the new build: a local directory (`from`), a tarball path or URL (`archive`), or the GitHub archive of `ref`.
 * Returns the directory plus a `cleanup` that removes anything downloaded.
 */
export async function resolveSource({ from, archive, ref = "main", env = process.env, fetchImpl = fetch } = {}) {
  if (from && archive) throw fail("conflicting_source", "Choose --from or --archive, not both.");
  if (from) {
    const dir = await realpath(path.resolve(from)).catch(() => { throw fail("invalid_source", `${from} does not exist.`); });
    const version = await validateSource(dir);
    return { dir, version, origin: `directory ${dir}`, cleanup: async () => {} };
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), "agent-vault-update-"));
  const cleanup = () => rm(temp, { recursive: true, force: true });
  try {
    const tarball = path.join(temp, "source.tar.gz");
    const remote = archive ?? env.AGENT_VAULT_ARCHIVE_URL;
    let origin;
    if (remote && /^[a-z][a-z0-9+.-]*:/i.test(remote)) {
      await downloadArchive({ url: remote }, tarball, fetchImpl);
      origin = `archive ${remote}`;
    } else if (remote) {
      const local = path.resolve(remote);
      if (!(await stat(local).catch(() => null))?.isFile()) throw fail("invalid_source", `${remote} is not a file.`);
      await cp(local, tarball);
      origin = `archive ${local}`;
    } else {
      const token = env.GH_TOKEN || env.GITHUB_TOKEN || await ghToken();
      const attempts = [token && githubArchiveRequest(ref, token), githubArchiveRequest(ref)].filter(Boolean);
      const errors = [];
      for (const request of attempts) {
        try { await downloadArchive(request, tarball, fetchImpl); origin = `GitHub ${UPDATE_REPOSITORY}@${ref}`; break; } catch (error) { errors.push(error.message); }
      }
      if (!origin) throw fail("download_failed", `Could not download ${UPDATE_REPOSITORY}@${ref}: ${errors.join("; ")}. For a private repository set GH_TOKEN or run 'gh auth login'; otherwise pass --from <checkout> or --archive <file>.`);
    }
    const dir = path.join(temp, "source");
    await mkdir(dir);
    try { await execFileAsync("tar", ["-xzf", tarball, "-C", dir, "--strip-components=1"], { timeout: 60_000 }); }
    catch { throw fail("invalid_archive", "The archive is invalid or could not be extracted (the tar command is required)."); }
    const version = await validateSource(dir);
    return { dir, version, origin, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function bundleDiff(sourceDir, targetDir) {
  let changed = 0, added = 0, unchanged = 0;
  for (const file of await packageFiles(sourceDir)) {
    if (file.directory) continue;
    const existing = await readFile(path.join(targetDir, file.relative)).catch(() => null);
    if (!existing) added++;
    else if (existing.equals(await readFile(path.join(sourceDir, file.relative)))) unchanged++;
    else changed++;
  }
  return { changed, added, unchanged };
}

/**
 * What is installed for `scope`, compared with the build in `sourceDir`. `deep` also compares every bundled file;
 * without it only versions are read, which is cheap enough for `diagnose`.
 */
export async function inspectInstallation({ sourceDir, home = os.homedir(), cwd = process.cwd(), scope = "global", deep = false }) {
  const key = scope === "global" ? "globalPath" : "localPath";
  const sourceReal = await realpath(sourceDir);
  const sourceVersion = (await readManifest(sourceDir))?.version;
  const targets = [];
  for (const target of await getInstallTargets({ home, cwd })) {
    const entry = { id: target.id, label: target.label, path: target[key] };
    const info = await lstat(entry.path).catch(() => null);
    if (!info) targets.push({ ...entry, kind: "absent" });
    else if (info.isSymbolicLink()) {
      const resolved = await realpath(entry.path).catch(() => null);
      targets.push({ ...entry, kind: "link", resolved, owned: Boolean(resolved && await ownedSkillDirectory(resolved)) });
    } else if (!info.isDirectory() || !await ownedSkillDirectory(entry.path)) targets.push({ ...entry, kind: "foreign" });
    else {
      const real = await realpath(entry.path);
      const same = real === sourceReal;
      const version = (await readManifest(entry.path))?.version;
      targets.push({ ...entry, kind: "directory", version, same, realpath: real, ...(deep && !same ? await bundleDiff(sourceDir, entry.path) : {}) });
    }
  }
  for (const entry of targets) {
    if (entry.kind === "link") entry.follows = targets.find((other) => other.kind === "directory" && entry.resolved === other.realpath)?.id;
  }
  return { scope, sourceVersion, targets };
}

/** Tool names removed by the rename (no aliases were kept), with the tool that replaced each. */
export const RETIRED_TOOL_NAMES = Object.freeze({
  vault_context: "context",
  memory_read: "doc_read",
  memory_search: "doc_search",
  memory_list: "doc_list",
  memory_write: "doc_write",
  agent_memory_read: "role_read",
  agent_memory_write: "role_write",
  agent_handoff: "handoff",
  short_memory_read: "short_read",
  short_memory_write: "short_write",
  long_memory_write: "remember",
});

/**
 * Instruction files that name a retired tool this build does not provide, with line numbers. Only the user-level files that agents
 * read at session start, plus AGENTS.md and CLAUDE.md in `cwd`, are looked at. Nothing is ever edited.
 */
export async function findRetiredToolReferences({ sourceDir, home = os.homedir(), cwd = process.cwd(), skip = [] }) {
  const server = await readFile(path.join(sourceDir, "bin/vault-mcp.mjs"), "utf8").catch(() => "");
  const gone = Object.entries(RETIRED_TOOL_NAMES).filter(([name]) => !server.includes(`name: "${name}"`));
  if (!gone.length) return [];
  const replacement = Object.fromEntries(gone);
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(${gone.map(([name]) => name).join("|")})(?![A-Za-z0-9_])`, "g");
  const files = [".omp/agent/AGENTS.md", ".omp/agent/RULES.md", ".agents/rules/agent-vault.md", ".agents/AGENTS.md", ".claude/CLAUDE.md", ".codex/AGENTS.md"].map((rel) => path.join(home, rel))
    .concat([path.join(cwd, "AGENTS.md"), path.join(cwd, "CLAUDE.md")]);
  const skipped = new Set(skip.map((file) => path.resolve(file)));
  const seen = new Set();
  const found = [];
  for (const file of files.map((item) => path.resolve(item))) {
    if (skipped.has(file) || seen.has(file)) continue;
    seen.add(file);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size > 1024 * 1024) continue;
    const hits = [];
    (await readFile(file, "utf8")).split(/\r?\n/).forEach((text, index) => {
      for (const match of text.matchAll(pattern)) hits.push({ line: index + 1, name: match[1], use: replacement[match[1]] });
    });
    if (hits.length) found.push({ path: file, count: hits.length, hits: hits.slice(0, 6) });
  }
  return found;
}

/** A digest of everything an update would install, so a plan can be tied to exactly the content that was previewed. */
async function sourceDigest(dir) {
  const hash = createHash("sha256");
  for (const file of (await packageFiles(dir)).filter((item) => !item.directory).sort((a, b) => a.relative.localeCompare(b.relative))) {
    hash.update(`${file.relative}\0`);
    hash.update(await readFile(path.join(dir, file.relative)));
  }
  return hash.digest("hex");
}

/** Decide what an update would do. Writes nothing. */
export async function planUpdate({ sourceDir, home = os.homedir(), cwd = process.cwd(), scope = "global", allowDowngrade = false, allowSameVersion = false, origin }) {
  const version = await validateSource(sourceDir);
  const inspected = await inspectInstallation({ sourceDir, home, cwd, scope, deep: true });
  const targets = inspected.targets.map((entry) => {
    if (entry.kind === "directory") return { ...entry, action: entry.same ? "source" : "update" };
    if (entry.kind === "link") return { ...entry, action: entry.owned && entry.follows ? "follows" : "skip", reason: entry.owned && entry.follows ? `symlink to the ${entry.follows} bundle` : "symlink that does not lead to an Agent Vault bundle" };
    if (entry.kind === "foreign") return { ...entry, action: "skip", reason: "a directory that Agent Vault did not install" };
    return { ...entry, action: "skip", reason: "not installed" };
  });
  const updating = targets.filter((entry) => entry.action === "update");
  if (!updating.length) {
    throw fail("nothing_to_update", targets.some((entry) => entry.action === "source")
      ? "This command runs from the installed bundle itself. Run it from a newer checkout or pass --from <directory> or --archive <file|url>."
      : `No Agent Vault bundle is installed for the ${scope} scope. Run vault-cli install first.`);
  }
  if (!allowDowngrade) {
    const newer = updating.find((entry) => entry.version && compareVersions(entry.version, version) > 0);
    if (newer) throw fail("downgrade", `${newer.path} is version ${newer.version}, newer than the source ${version}. Pass --allow-downgrade to install it anyway.`);
  }
  if (!allowSameVersion) {
    // Versions do not move with every commit, so the same number can hide an older build (a release branch that lags a local one).
    const drift = updating.find((entry) => entry.version === version && entry.changed + entry.added > 0);
    if (drift) throw fail("same_version_differs", `${drift.path} is already version ${version}, but ${drift.changed} files differ and ${drift.added} are missing from the source. The source may be older than what is installed. Pass --allow-same-version to install it anyway.`);
  }
  const omp = targets.find((entry) => entry.id === "omp");
  const ompBundled = scope === "global" && omp && (omp.action === "update" || (omp.action === "follows" && targets.find((entry) => entry.id === omp.follows)?.action === "update"));
  const integrations = ompBundled ? await installOmpIntegrations({ sourceDir, bundleDir: omp.path, home, dryRun: true }) : [];
  // A rule this update replaces will no longer name retired tools, so only report it when the update leaves it alone.
  const ruleItem = integrations.find((item) => item.label === "OMP user rule");
  const ruleReplaced = Boolean(ruleItem && /^(installed|updated)/.test(ruleItem.status));
  const bundlesCurrent = updating.every((entry) => entry.changed === 0 && entry.added === 0);
  const integrationsCurrent = integrations.every((item) => item.status === "already current" || item.status.startsWith("preserved"));
  const id = createHash("sha256").update(JSON.stringify([
    await sourceDigest(sourceDir), scope,
    updating.map((entry) => [entry.id, entry.path, entry.version ?? null, entry.changed, entry.added]),
    integrations.map((item) => [item.label, item.status]),
  ])).digest("hex").slice(0, 12);
  return {
    id, scope, source: { dir: sourceDir, version, origin }, targets, integrations,
    instructions: await findRetiredToolReferences({ sourceDir, home, cwd, skip: ruleReplaced ? [ruleItem.path] : [] }),
    verifyPath: (ompBundled ? omp.path : updating[0].path),
    current: bundlesCurrent && integrationsCurrent,
  };
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

// The CLI that sits beside this code: it is the one that understands the plan. The installed copy is older than the source by
// definition and may not know flags such as --expect or --allow-same-version.
const ownCli = fileURLToPath(new URL("../bin/vault-cli.mjs", import.meta.url));

/** The command that applies exactly `plan` again. It names the CLI that produced the plan, not the installed one (vault-cli is not on PATH). */
export function updateCommand(plan, { from, archive, ref, scope = "global", allowDowngrade = false, allowSameVersion = false } = {}) {
  const flags = [from && `--from ${shellQuote(path.resolve(from))}`, archive && `--archive ${shellQuote(archive)}`, ref && `--ref ${shellQuote(ref)}`, scope === "local" && "--local", allowDowngrade && "--allow-downgrade", allowSameVersion && "--allow-same-version", `--expect ${plan.id}`].filter(Boolean);
  return `node ${shellQuote(ownCli)} update ${flags.join(" ")}`;
}

export const rollbackCommand = (plan, id) => `node ${shellQuote(path.join(plan.verifyPath, "bin/vault-cli.mjs"))} update --rollback ${id}`;

const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.(\d+)Z$/, "-$1");
const backupRoot = (home) => path.join(home, ".agent-vault", "update-backups");

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

async function mcpEntry(configPath) {
  const config = await readJson(configPath);
  return config?.mcpServers?.["agent-vault"] ?? null;
}

async function setMcpEntry(configPath, entry) {
  const config = await readJson(configPath);
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  config.mcpServers ??= {};
  if (entry === null) delete config.mcpServers["agent-vault"];
  else config.mcpServers["agent-vault"] = entry;
  await writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`, (await stat(configPath)).mode & 0o777);
  return true;
}

/** Start the installed server in a scratch home and vault and talk MCP to it: it must boot, report the expected version and list tools. */
export async function smokeTest(bundleDir, expectedVersion, { timeoutMs = 20_000 } = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agent-vault-smoke-"));
  const vault = path.join(scratch, "vault");
  const home = path.join(scratch, "home");
  await mkdir(vault);
  await mkdir(home);
  // Never inherit the real vault, database or team settings: this server must not touch them.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("AGENT_VAULT_") && name !== "OMP_VAULT_PATH"));
  const child = spawn(process.execPath, [path.join(bundleDir, "bin/vault-mcp.mjs"), "--path", vault], {
    cwd: scratch, env: { ...env, HOME: home, USERPROFILE: home, AGENT_VAULT_HARNESS: "omp" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { const message = JSON.parse(line); pending.get(message.id)?.(message); } catch { /* ignore noise */ }
    }
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let nextId = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`no reply to ${method} within ${timeoutMs / 1000}s`)); }, timeoutMs);
    pending.set(id, (message) => { clearTimeout(timer); pending.delete(id); resolve(message); });
    exited.then(({ code, signal }) => { if (pending.delete(id)) { clearTimeout(timer); reject(new Error(`the server exited (${signal ?? `code ${code}`}) before replying to ${method}`)); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-vault-update", version: "0" } });
    const version = init.result?.serverInfo?.version;
    if (version !== expectedVersion) throw new Error(`the server reports version ${JSON.stringify(version)}, expected ${expectedVersion}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = await request("tools/list", {});
    const tools = listed.result?.tools?.length ?? 0;
    if (!tools) throw new Error("the server listed no tools");
    return { version, tools };
  } catch (error) {
    throw fail("verification_failed", `${error.message}${stderr.trim() ? ` (stderr: ${stderr.trim().replace(/\s+/g, " ").slice(-300)})` : ""}`);
  } finally {
    child.kill();
    await exited;
    await rm(scratch, { recursive: true, force: true });
  }
}

async function restoreBackup(home, manifest, { force = false } = {}) {
  const dir = path.join(backupRoot(home), manifest.id);
  const restored = [];
  const skipped = [];
  for (const entry of manifest.dirs) {
    const side = `${entry.path}.rollback-${randomBytes(3).toString("hex")}`;
    const exists = Boolean(await lstat(entry.path).catch(() => null));
    if (exists) await rename(entry.path, side);
    try { await cp(path.join(dir, "dirs", entry.id), entry.path, { recursive: true, verbatimSymlinks: true }); }
    catch (error) {
      await rm(entry.path, { recursive: true, force: true });
      if (exists) await rename(side, entry.path);
      throw error;
    }
    if (exists) await rm(side, { recursive: true, force: true });
    restored.push(entry.path);
  }
  for (const entry of manifest.files) {
    const current = await readFile(entry.path).catch(() => null);
    if (!force && entry.after !== undefined && (current ? sha256(current) : null) !== entry.after) { skipped.push({ path: entry.path, reason: "changed since the update" }); continue; }
    if (entry.backup) await writeAtomic(entry.path, await readFile(path.join(dir, "files", entry.backup)), entry.mode ?? 0o644);
    else await rm(entry.path, { force: true });
    restored.push(entry.path);
  }
  if (manifest.mcp) {
    const { path: file, backup, mode } = manifest.mcp;
    const bytes = await readFile(file).catch(() => null);
    if (force || (bytes && sha256(bytes) === manifest.mcp.afterSha)) {
      // The file is exactly as the update left it (or the update stopped before finishing): put the original bytes back.
      if (backup) await writeAtomic(file, await readFile(path.join(dir, "files", backup)), mode ?? 0o600);
      else await rm(file, { force: true });
      restored.push(file);
    } else if (manifest.mcp.after !== undefined && JSON.stringify(await mcpEntry(file)) !== JSON.stringify(manifest.mcp.after)) {
      skipped.push({ path: file, reason: "the agent-vault entry changed since the update" });
    } else if (await setMcpEntry(file, manifest.mcp.before)) restored.push(file);
    else skipped.push({ path: file, reason: "the file is no longer valid JSON" });
  }
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify({ ...manifest, rolledBack: true }, null, 2)}\n`);
  return { restored, skipped };
}

/** Newest first. */
export async function listUpdateBackups(home = os.homedir()) {
  const root = backupRoot(home);
  const out = [];
  for (const name of (await readdir(root).catch(() => [])).sort().reverse()) {
    const manifest = await readJson(path.join(root, name, "manifest.json"));
    if (manifest?.id === name) out.push({ id: name, createdAt: manifest.createdAt, from: manifest.from, to: manifest.to, rolledBack: Boolean(manifest.rolledBack), manifest });
  }
  return out;
}

/** Restore what the update at `id` (default: the newest not yet rolled back) replaced. Files edited since are left alone. */
export async function rollbackUpdate({ home = os.homedir(), id } = {}) {
  const backups = await listUpdateBackups(home);
  const chosen = id && id !== "latest" ? backups.find((item) => item.id === id) : backups.find((item) => !item.rolledBack);
  if (!chosen) throw fail("no_backup", id && id !== "latest" ? `No update backup '${id}'.` : "There is no update to roll back.");
  if (chosen.rolledBack) throw fail("already_rolled_back", `Update ${chosen.id} was already rolled back.`);
  const result = await restoreBackup(home, chosen.manifest);
  return { id: chosen.id, from: chosen.to, to: chosen.from, ...result };
}

async function pruneBackups(home) {
  for (const item of (await listUpdateBackups(home)).slice(UPDATE_BACKUPS_KEPT)) await rm(path.join(backupRoot(home), item.id), { recursive: true, force: true });
}

/** Back up, install the planned build, prove the new server boots, and roll back automatically if it does not. */
export async function applyUpdate(plan, { home = os.homedir(), verify = true, now = new Date() } = {}) {
  if (plan.current) return { id: null, updated: [], integrations: [], verified: null };
  const id = `${stamp(now)}-${randomBytes(3).toString("hex")}`;
  const dir = path.join(backupRoot(home), id);
  await mkdir(path.join(dir, "dirs"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(dir, "files"), { recursive: true, mode: 0o700 });
  const updating = plan.targets.filter((entry) => entry.action === "update");
  const manifest = { version: 1, id, createdAt: now.toISOString(), from: Object.fromEntries(updating.map((entry) => [entry.id, entry.version ?? null])), to: plan.source.version, dirs: [], files: [], mcp: null, rolledBack: false };
  for (const entry of updating) {
    await cp(entry.path, path.join(dir, "dirs", entry.id), { recursive: true, verbatimSymlinks: true });
    manifest.dirs.push({ id: entry.id, path: entry.path });
  }
  for (const [index, item] of plan.integrations.entries()) {
    if (item.path.endsWith("mcp.json")) {
      const bytes = await readFile(item.path).catch(() => null);
      if (bytes) await writeFile(path.join(dir, "files", "mcp"), bytes, { mode: 0o600 });
      manifest.mcp = { path: item.path, before: await mcpEntry(item.path), backup: bytes ? "mcp" : null, mode: bytes ? (await stat(item.path)).mode & 0o777 : undefined };
      continue;
    }
    const bytes = await readFile(item.path).catch(() => null);
    const mode = bytes ? (await stat(item.path)).mode & 0o777 : undefined;
    if (bytes) await writeFile(path.join(dir, "files", String(index)), bytes, { mode: 0o600 });
    manifest.files.push({ label: item.label, path: item.path, backup: bytes ? String(index) : null, mode });
  }
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const updated = [];
  let integrations = [];
  let verified = null;
  try {
    for (const entry of updating) {
      const status = await installSkillFiles(plan.source.dir, entry.path);
      if (status.startsWith("preserved")) throw fail("update_refused", `${entry.path}: ${status}`);
      updated.push({ id: entry.id, path: entry.path, from: entry.version ?? null, to: plan.source.version, status });
    }
    if (plan.integrations.length) {
      const omp = plan.targets.find((entry) => entry.id === "omp");
      integrations = await installOmpIntegrations({ sourceDir: plan.source.dir, bundleDir: omp.path, home });
    }
    if (verify) verified = await smokeTest(plan.verifyPath, plan.source.version);
  } catch (error) {
    const restored = await restoreBackup(home, manifest, { force: true }).catch((restoreError) => ({ failed: restoreError.message }));
    throw Object.assign(new Error(`${error.message} ${restored.failed ? `Restoring the previous build failed too (${restored.failed}); the backup is in ${dir}.` : "The previous build was restored."}`), { code: error.code ?? "update_failed", rolledBack: !restored.failed });
  }
  for (const entry of manifest.files) {
    const bytes = await readFile(entry.path).catch(() => null);
    entry.after = bytes ? sha256(bytes) : null;
  }
  if (manifest.mcp) {
    manifest.mcp.after = await mcpEntry(manifest.mcp.path);
    const bytes = await readFile(manifest.mcp.path).catch(() => null);
    manifest.mcp.afterSha = bytes ? sha256(bytes) : null;
  }
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await pruneBackups(home);
  return { id, updated, integrations, verified };
}

async function countMarkdown(dir, depth) {
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name.endsWith(".md")) count++;
    else if (entry.isDirectory() && depth > 0) count += await countMarkdown(path.join(dir, entry.name), depth - 1);
  }
  return count;
}

/** How many journal Markdown files (worktree records, logs, long-term notes) a vault holds. Never reads their content. */
export async function countLegacyJournals(vault) {
  let count = 0;
  for (const project of await readdir(path.join(vault, "projects"), { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) continue;
    for (const area of ["worktrees", "logs", "long-term"]) count += await countMarkdown(path.join(vault, "projects", project.name, area), 3);
  }
  return count;
}

/** Locate the new build, plan, and unless `dryRun` apply. Always releases anything it downloaded. */
export async function runUpdate({ from, archive, ref, scope = "global", dryRun = false, verify = true, allowDowngrade = false, allowSameVersion = false, expect, blockStaleInstructions = false, home = os.homedir(), cwd = process.cwd(), env = process.env, fetchImpl, vault, now = new Date() } = {}) {
  const source = await resolveSource({ from, archive, ref, env, fetchImpl });
  try {
    const plan = await planUpdate({ sourceDir: source.dir, home, cwd, scope, allowDowngrade, allowSameVersion, origin: source.origin });
    if (!dryRun && expect !== undefined && expect !== plan.id) throw fail("plan_changed", `The plan is now ${plan.id}, not ${expect}: the source or the installed files changed since it was previewed. Check again before applying.`);
    if (!dryRun && blockStaleInstructions && plan.instructions.length) {
      const names = [...new Set(plan.instructions.flatMap((file) => file.hits.map((hit) => `${hit.name} -> ${hit.use}`)))].slice(0, 4).join(", ");
      throw fail("instructions_stale", `${plan.instructions.map((file) => `${file.path} (${file.count})`).join(", ")} still tell agents to call tools that the new build removed (${names}). Fix those files first, or apply with the user's explicit agreement.`);
    }
    const applied = dryRun ? null : await applyUpdate(plan, { home, verify, now });
    const notes = [];
    if (applied?.id) notes.push("Restart OMP and any other host that launched Agent Vault so it starts the new server; running processes keep the old code.");
    if (applied?.id && vault) {
      const journals = await countLegacyJournals(vault);
      if (journals > 0) notes.push(`${journals} journal notes are Markdown files in the vault. The new build keeps journals in the database; import them with 'vault-cli memory migrate --project <id>' and, once you are satisfied, add --prune-legacy to remove the files.`);
    }
    return { plan, applied, notes };
  } finally {
    await source.cleanup();
  }
}

/** A compact, JSON-safe account of a `runUpdate` result for tools: what would change or changed, what to do next, and the commands. */
export function summarizeUpdate({ plan, applied, notes }, { ref, scope = "global" } = {}) {
  const installed = Boolean(applied?.id);
  return {
    planId: plan.id,
    current: plan.current,
    source: { origin: plan.source.origin, version: plan.source.version },
    targets: plan.targets.filter((entry) => entry.action !== "skip" || entry.kind !== "absent").map((entry) => ({
      id: entry.id, path: entry.path, action: entry.action, from: entry.version ?? null, to: plan.source.version,
      ...(entry.action === "update" ? { files: { changed: entry.changed, added: entry.added, unchanged: entry.unchanged } } : { note: entry.reason }),
    })),
    integrations: plan.integrations.map((item) => ({ what: item.label, status: item.status })),
    instructions: plan.instructions,
    applied: installed ? { backup: applied.id, updated: applied.updated, verified: applied.verified, rollbackCommand: rollbackCommand(plan, applied.id) } : null,
    applyCommand: plan.current || installed ? null : updateCommand(plan, { ref, scope }),
    notes,
    next: installed ? "Tell the user to restart the host so it starts the new server; running processes keep the old code."
      : plan.current ? "Nothing to do: the installed build is current."
        : plan.instructions.length ? "Do not apply yet: tell the user which instruction files still name removed tools, and apply only with their agreement (acknowledgeInstructions)."
          : "If the user wants the update, call update with action apply and expect set to planId, or give the user applyCommand to run.",
  };
}

/** Plain-text report of a `runUpdate` result. */
export function renderUpdate({ plan, applied, notes }, { dryRun, source = {} }) {
  const lines = [`Source: ${plan.source.origin ?? plan.source.dir} (version ${plan.source.version})`];
  for (const entry of plan.targets) {
    const detail = entry.action === "update" ? `${entry.version ?? "?"} -> ${plan.source.version} (${entry.changed} changed, ${entry.added} new, ${entry.unchanged} unchanged files)`
      : entry.action === "source" ? "this is the running bundle"
        : entry.action === "follows" ? entry.reason
          : `skipped: ${entry.reason}`;
    lines.push(`  ${entry.id.padEnd(9)} ${entry.path}  ${detail}`);
  }
  for (const item of (applied?.integrations?.length ? applied.integrations : plan.integrations)) lines.push(`  ${item.label}: ${item.status}  ${item.path}`);
  if (plan.instructions.length) {
    lines.push("[WARN] These instruction files still tell agents to call tools that this build no longer has. Agent Vault does not edit them. Fix them before you restart OMP, or every session will be told to call tools that do not exist:");
    for (const file of plan.instructions) {
      lines.push(`  ${file.path}  (${file.count} reference${file.count === 1 ? "" : "s"})`);
      for (const hit of file.hits) lines.push(`    line ${hit.line}: ${hit.name} -> ${hit.use}`);
      if (file.count > file.hits.length) lines.push(`    ... and ${file.count - file.hits.length} more`);
    }
    lines.push("  A repository's AGENTS.md or CLAUDE.md: run vault-cli init inside it. Your own files: rename the tools by hand.");
  }
  if (plan.current) lines.push("Already up to date. Nothing to change.");
  else if (dryRun) {
    lines.push("Dry run: nothing was changed.");
    lines.push(`Plan ${plan.id}. To apply exactly this plan: ${updateCommand(plan, source)}`);
  }
  else {
    lines.push(`Updated. Backup ${applied.id}; undo with: ${rollbackCommand(plan, applied.id)}`);
    if (applied.verified) lines.push(`Verified: the installed server answered as version ${applied.verified.version} with ${applied.verified.tools} tools.`);
  }
  for (const note of notes ?? []) lines.push(`[INFO] ${note}`);
  return lines.join("\n");
}
