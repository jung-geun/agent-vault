// Installs, inspects and removes the Agent Vault command hooks in Claude Code and Codex configuration.
// Only entries whose command runs this package's vault-hook.mjs are owned; every other setting and hook is preserved.
// Codex additionally requires the user to review and trust new hooks (/hooks); this module never writes trust state.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { writeAtomic } from "./installer.mjs";

export const HOOK_SCRIPT = "vault-hook.mjs";
const OWNED = /(?:^|[\\/'" ])vault-hook\.mjs(?:['" ]|$)/;

// Event, optional matcher, timeout in seconds. Timeouts respect each host's documented limits (Codex SessionEnd: 1-3 s).
const SPECS = Object.freeze({
  claude: {
    label: "Claude Code",
    events: [
      ["UserPromptSubmit", undefined, 20],
      ["PreToolUse", "Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob", 10],
      ["PostToolUse", "Edit|Write|MultiEdit|NotebookEdit", 10],
      ["Stop", undefined, 30],
      ["StopFailure", undefined, 30],
      ["SessionEnd", undefined, 10],
    ],
  },
  codex: {
    label: "Codex",
    events: [
      ["UserPromptSubmit", undefined, 20],
      ["PreToolUse", "Bash|apply_patch", 10],
      ["PostToolUse", "apply_patch|Edit|Write", 10],
      ["Stop", undefined, 30],
      ["Interrupt", undefined, 3],
      ["SessionEnd", undefined, 3],
    ],
  },
});

export const HOOK_HOST_IDS = Object.freeze(Object.keys(SPECS));
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function hookScriptPath() {
  return fileURLToPath(new URL(`../bin/${HOOK_SCRIPT}`, import.meta.url));
}

/** Configuration file for one host and scope. Claude project hooks go to the git-ignored local file, never the shared one. */
export function hookConfigPath(host, { scope = "global", home = os.homedir(), cwd = process.cwd(), env = process.env } = {}) {
  if (!SPECS[host]) throw new Error(`Unsupported hook host '${host}'. Use ${HOOK_HOST_IDS.join(" or ")}.`);
  if (!["global", "local"].includes(scope)) throw new Error("Hook scope must be global or local.");
  if (host === "claude") return scope === "global" ? path.join(home, ".claude", "settings.json") : path.join(cwd, ".claude", "settings.local.json");
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, ".codex");
  return scope === "global" ? path.join(codexHome, "hooks.json") : path.join(cwd, ".codex", "hooks.json");
}

export function hookCommand(host, { vaultPath, script = hookScriptPath(), node = process.execPath } = {}) {
  return [quote(node), quote(script), "--host", host, ...(vaultPath ? ["--path", quote(path.resolve(vaultPath))] : [])].join(" ");
}

function expectedGroups(host, options) {
  const command = hookCommand(host, options);
  return SPECS[host].events.map(([event, matcher, timeout]) => ({
    event,
    group: { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout }] },
  }));
}

async function readConfig(file) {
  let text;
  try { text = await fs.readFile(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return { config: {}, mode: 0o600, exists: false };
    throw error;
  }
  let config;
  try { config = JSON.parse(text); } catch { throw new Error(`${file} is not valid JSON; repair it before installing hooks (nothing was changed).`); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${file} must contain a JSON object (nothing was changed).`);
  if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks))) throw new Error(`${file} has a non-object "hooks" value (nothing was changed).`);
  const stat = await fs.stat(file);
  return { config, mode: stat.mode & 0o777, exists: true };
}

const isOwnedHook = (hook) => typeof hook?.command === "string" && OWNED.test(hook.command);

// Remove owned hook handlers; drop a matcher group only when nothing else is left in it.
function withoutOwned(groups) {
  if (!Array.isArray(groups)) return { groups, removed: 0 };
  let removed = 0;
  const kept = [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) { kept.push(group); continue; }
    const remaining = group.hooks.filter((hook) => !isOwnedHook(hook));
    removed += group.hooks.length - remaining.length;
    if (remaining.length) kept.push({ ...group, hooks: remaining });
  }
  return { groups: kept, removed };
}

async function write(file, config, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, `${JSON.stringify(config, null, 2)}\n`, mode);
}

export async function installHooks(host, options = {}) {
  const file = hookConfigPath(host, options);
  const { config, mode, exists } = await readConfig(file);
  const before = JSON.stringify(config);
  config.hooks ??= {};
  for (const { event, group } of expectedGroups(host, options)) {
    const { groups } = withoutOwned(config.hooks[event] ?? []);
    config.hooks[event] = [...groups, group];
  }
  const changed = JSON.stringify(config) !== before;
  if (changed && !options.dryRun) await write(file, config, mode);
  return { host, file, status: !changed ? "already current" : exists ? "updated" : "installed", trust: host === "codex" ? "Codex skips new or changed hooks until you review and trust them: open /hooks in the Codex CLI." : null };
}

export async function uninstallHooks(host, options = {}) {
  const file = hookConfigPath(host, options);
  const { config, mode, exists } = await readConfig(file);
  if (!exists || !config.hooks) return { host, file, status: "not installed", removed: 0 };
  let removed = 0;
  for (const event of Object.keys(config.hooks)) {
    const result = withoutOwned(config.hooks[event]);
    removed += result.removed;
    if (Array.isArray(result.groups) && result.groups.length === 0) delete config.hooks[event];
    else config.hooks[event] = result.groups;
  }
  if (Object.keys(config.hooks).length === 0) delete config.hooks;
  if (removed && !options.dryRun) await write(file, config, mode);
  return { host, file, status: removed ? "removed" : "not installed", removed };
}

/** Per-event state: `current`, `drifted` (owned but a different command/timeout/matcher) or `missing`. */
export async function hooksStatus(host, options = {}) {
  const file = hookConfigPath(host, options);
  const { config, exists } = await readConfig(file);
  const events = [];
  for (const { event, group } of expectedGroups(host, options)) {
    const groups = Array.isArray(config.hooks?.[event]) ? config.hooks[event] : [];
    const owned = groups.filter((candidate) => Array.isArray(candidate?.hooks) && candidate.hooks.some(isOwnedHook));
    const current = owned.some((candidate) => candidate.matcher === group.matcher
      && candidate.hooks.some((hook) => isOwnedHook(hook) && hook.command === group.hooks[0].command && hook.timeout === group.hooks[0].timeout));
    events.push({ event, state: current ? "current" : owned.length ? "drifted" : "missing" });
  }
  const notes = [];
  if (host === "codex") {
    const codexHome = (options.env ?? process.env).CODEX_HOME;
    const toml = path.join(codexHome ? path.resolve(codexHome) : path.join(options.home ?? os.homedir(), ".codex"), "config.toml");
    const text = await fs.readFile(toml, "utf8").catch(() => "");
    if (/^\s*hooks\s*=\s*false\b/m.test(text)) notes.push(`${toml} sets hooks = false; Codex will not run any hook.`);
    notes.push("Trust is held by Codex and cannot be verified here; review hooks with /hooks.");
  }
  const states = new Set(events.map((item) => item.state));
  return { host, file, exists, state: states.size === 1 ? [...states][0] : "partial", events, notes };
}
