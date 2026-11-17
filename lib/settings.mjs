// Vault-level settings for memory architecture: join mode, review thresholds, team memory backend, access guard.
// Stored at <vault>/.agent-vault/settings.json. Only the user edits it (vault-cli config ...); MCP tools can read a redacted summary, never write it.
// Secrets are never stored: the team HTTP backend reads its bearer token from an environment variable named here.
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

export const HARNESSES = Object.freeze(["omp", "claude", "codex", "generic"]);
export const JOIN_MODES = Object.freeze(["manual", "auto"]);
export const GUARD_MODES = Object.freeze(["block", "off"]);
export const TEAM_BACKENDS = Object.freeze(["file", "http"]);

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  join: Object.freeze({ default: "manual", harnesses: Object.freeze({}) }),
  review: Object.freeze({ thresholds: Object.freeze([5, 10, 20]), repeatEvery: 20, staleShortTermDays: 14, hotReadCount: 10 }),
  team: Object.freeze({ enabled: false, backend: "file", path: null, url: null, tokenEnv: null, teamId: "default", allowWrite: true }),
  guard: Object.freeze({ mode: "block" }),
  weekly: Object.freeze({ retentionMonths: 3, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, workdayStart: "09:00" }),
  persona: Object.freeze({ enabled: true, minObservations: 3, maxContextChars: 2000 }),
});

export class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = "SettingsError";
  }
}

const settingsFile = (vault) => path.join(vault, ".agent-vault", "settings.json");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function keys(value, allowed, name) {
  if (!object(value)) throw new SettingsError(`${name} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new SettingsError(`Unknown ${name} key '${key}'.`);
  }
}

function merge(base, patch) {
  keys(patch, Object.keys(base), "settings");
  const out = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (object(base[key]) && object(value)) {
      // Harness names are validated separately because the default override map is empty.
      out[key] = key === "harnesses" ? { ...base[key], ...value } : merge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function validateSettings(settings) {
  keys(settings, ["version", "join", "review", "team", "guard", "weekly", "persona"], "settings");
  if (settings.version !== 1) throw new SettingsError("settings.version must be 1.");
  keys(settings.join, ["default", "harnesses"], "join");
  keys(settings.join.harnesses, HARNESSES, "join.harnesses");
  if (!JOIN_MODES.includes(settings.join.default)) throw new SettingsError(`join.default must be one of ${JOIN_MODES.join(", ")}.`);
  for (const [harness, mode] of Object.entries(settings.join.harnesses)) {
    if (!JOIN_MODES.includes(mode)) throw new SettingsError(`join.harnesses.${harness} must be one of ${JOIN_MODES.join(", ")}.`);
  }
  keys(settings.review, ["thresholds", "repeatEvery", "staleShortTermDays", "hotReadCount"], "review");
  const { thresholds, repeatEvery, staleShortTermDays, hotReadCount } = settings.review;
  if (!Array.isArray(thresholds) || thresholds.length === 0 || thresholds.some((n) => !Number.isSafeInteger(n) || n < 1) || thresholds.some((n, i) => i > 0 && n <= thresholds[i - 1])) {
    throw new SettingsError("review.thresholds must be a strictly increasing list of positive safe integers.");
  }
  for (const [name, value] of Object.entries({ repeatEvery, staleShortTermDays, hotReadCount })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new SettingsError(`review.${name} must be a positive safe integer.`);
  }
  keys(settings.guard, ["mode"], "guard");
  if (!GUARD_MODES.includes(settings.guard.mode)) throw new SettingsError(`guard.mode must be one of ${GUARD_MODES.join(", ")}.`);
  keys(settings.weekly, ["retentionMonths", "timeZone", "workdayStart"], "weekly");
  if (!Number.isInteger(settings.weekly.retentionMonths) || settings.weekly.retentionMonths < 1 || settings.weekly.retentionMonths > 6) throw new SettingsError("weekly.retentionMonths must be an integer from 1 to 6.");
  if (typeof settings.weekly.timeZone !== "string" || !settings.weekly.timeZone.trim()) throw new SettingsError("weekly.timeZone must be an IANA time zone.");
  try { new Intl.DateTimeFormat("en", { timeZone: settings.weekly.timeZone }); }
  catch { throw new SettingsError("weekly.timeZone must be an IANA time zone."); }
  if (typeof settings.weekly.workdayStart !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.weekly.workdayStart)) throw new SettingsError("weekly.workdayStart must be HH:mm.");
  keys(settings.persona, ["enabled", "minObservations", "maxContextChars"], "persona");
  if (typeof settings.persona.enabled !== "boolean") throw new SettingsError("persona.enabled must be boolean.");
  if (!Number.isInteger(settings.persona.minObservations) || settings.persona.minObservations < 2 || settings.persona.minObservations > 100) throw new SettingsError("persona.minObservations must be an integer from 2 to 100.");
  if (!Number.isInteger(settings.persona.maxContextChars) || settings.persona.maxContextChars < 200 || settings.persona.maxContextChars > 4000) throw new SettingsError("persona.maxContextChars must be an integer from 200 to 4000.");
  keys(settings.team, ["enabled", "backend", "path", "url", "tokenEnv", "teamId", "allowWrite"], "team");
  const team = settings.team;
  if (typeof team.enabled !== "boolean" || typeof team.allowWrite !== "boolean") throw new SettingsError("team.enabled and team.allowWrite must be booleans.");
  if (!TEAM_BACKENDS.includes(team.backend)) throw new SettingsError(`team.backend must be one of ${TEAM_BACKENDS.join(", ")}.`);
  if (team.path !== null && (typeof team.path !== "string" || !path.isAbsolute(team.path) || team.path.includes("\0"))) throw new SettingsError("team.path must be an absolute local SQLite file path or null.");
  if (team.tokenEnv !== null && (typeof team.tokenEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/i.test(team.tokenEnv))) throw new SettingsError("team.tokenEnv must be an environment variable name or null.");
  if (typeof team.teamId !== "string" || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(team.teamId)) throw new SettingsError("team.teamId must be kebab-case.");
  if (team.url !== null) {
    if (typeof team.url !== "string") throw new SettingsError("team.url must be an HTTP(S) URL or null.");
    let url;
    try { url = new URL(team.url); } catch { throw new SettingsError("team.url must be an HTTP(S) URL or null."); }
    if (!["http:", "https:"].includes(url.protocol)) throw new SettingsError("team.url must use HTTP(S).");
    if (url.username || url.password || url.search || url.hash) throw new SettingsError("team.url must not contain credentials, query parameters, or fragments; use team.tokenEnv.");
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new SettingsError("team.url must use HTTPS except on localhost.");
  }
  if (team.enabled && team.backend === "file" && team.path === null) throw new SettingsError("team.path is required for the file backend (same-host local filesystem only).");
  if (team.enabled && team.backend === "http" && team.url === null) throw new SettingsError("team.url is required for the HTTP backend.");
  return settings;
}

// SQLite and settings share this path policy. No user-controlled symlink component,
// hard-linked leaf, or writable-by-others directory may redirect private storage.
export function storageFilePath(file, { createParent = false } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) throw new SettingsError("Storage requires an absolute local file path.");
  const absolute = path.resolve(file);
  const parts = path.dirname(absolute).split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code !== "ENOENT" || !createParent) throw error;
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch (mkdirError) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
      stat = fs.lstatSync(current);
    }
    // macOS exposes these OS-owned aliases even in its native temporary directory.
    if (process.platform === "darwin" && ["/var", "/tmp"].includes(current) && stat.isSymbolicLink() && stat.uid === 0) {
      current = fs.realpathSync(current);
      stat = fs.lstatSync(current);
    }
    // Older access logging created this tool-owned directory using the caller's umask.
    // Tighten only the owned, real storage leaf; never change permissions on vault/user ancestors.
    if (index === parts.length - 1 && part === ".agent-vault" && stat.isDirectory() && !stat.isSymbolicLink()
      && process.getuid && stat.uid === process.getuid() && (stat.mode & 0o077)) {
      fs.chmodSync(current, 0o700);
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || ((stat.mode & 0o022) && !(stat.mode & 0o1000)) || (process.getuid && stat.uid !== 0 && stat.uid !== process.getuid())) throw new SettingsError("Storage parent must be an owner-controlled real directory not writable by other users.");
  }
  const target = path.join(current, path.basename(absolute));
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new SettingsError("Storage file must be a user-owned regular file without links.");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return target;
}

export function loadSettings(vault) {
  let stored = {};
  try {
    const target = storageFilePath(settingsFile(path.resolve(vault)));
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65_536 || (process.getuid && stat.uid !== process.getuid())) throw new SettingsError("Settings must be a user-owned regular JSON file smaller than 64 KiB.");
      stored = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code !== "ENOENT") {
      if (error instanceof SettingsError) throw error;
      throw new SettingsError("Settings could not be read as valid JSON.");
    }
  }
  return validateSettings(merge(DEFAULT_SETTINGS, stored));
}

export async function saveSettings(vault, patch) {
  // Reject invalid input before creating any directory; revalidate under the lock after concurrent updates.
  validateSettings(merge(loadSettings(vault), patch));
  const target = storageFilePath(settingsFile(path.resolve(vault)), { createParent: true });
  const lock = `${target}.lock`;
  let fd;
  const deadline = Date.now() + 5000;
  while (fd === undefined) {
    storageFilePath(lock);
    try { fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new SettingsError("Settings are locked by another writer. Remove a stale settings.json.lock only after confirming no writer is running.");
      await delay(20);
    }
  }
  const temp = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const next = validateSettings(merge(loadSettings(vault), patch));
    storageFilePath(target);
    const output = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(output, `${JSON.stringify(next, null, 2)}\n`); fs.fsyncSync(output); } finally { fs.closeSync(output); }
    fs.renameSync(temp, target);
    const directory = fs.openSync(path.dirname(target), fs.constants.O_RDONLY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return next;
  } finally {
    try { fs.rmSync(temp, { force: true }); } finally {
      try { fs.closeSync(fd); } finally { fs.unlinkSync(lock); }
    }
  }
}

// Join mode that applies to one harness: a per-harness override beats the vault default.
export function joinModeFor(settings, harness) {
  return (harness && settings.join.harnesses[harness]) || settings.join.default;
}

// Harness named by the caller or by AGENT_VAULT_HARNESS; unknown or missing values fall back to the vault default.
export function resolveHarness(explicit) {
  const value = explicit ?? process.env.AGENT_VAULT_HARNESS;
  return HARNESSES.includes(value) ? value : null;
}

// Settings summary that is safe to hand to an agent: no URL, path or token variable names.
export function publicSettings(settings, harness) {
  return {
    join: { mode: joinModeFor(settings, harness), harness: harness ?? null },
    review: settings.review,
    team: { enabled: settings.team.enabled, backend: settings.team.enabled ? settings.team.backend : null, teamId: settings.team.teamId, allowWrite: settings.team.allowWrite },
    guard: settings.guard,
    weekly: settings.weekly,
    persona: settings.persona,
  };
}
