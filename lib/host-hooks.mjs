// Lifecycle adapter for hosts that run short-lived command hooks (Claude Code, Codex).
// OMP keeps its state in one long-lived extension; command hooks are separate processes, so the per-session
// task and the files edited during a turn are kept in small state files under <vault>/.agent-vault/hooks.
// Hooks are best effort: a failure becomes a warning and never blocks the host or guesses a project.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { autoRegisterProject, worktreeRecord } from "./memory-store.mjs";
import { beginMemoryTask, endMemoryTask, recordToolUse, autoRecallContext } from "./memory-tiers.mjs";
import { guardToolCall } from "./access-guard.mjs";

export const HOOK_HOSTS = Object.freeze(["claude", "codex"]);
const MAX_CHARS = 4000;
const STATE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "tcsh", "csh"]);
const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Persist one worktree record the same way for every harness; returns user-visible warnings. */
export async function recordHostEntry(vault, { cwd, harness, record, taskId }) {
  const warnings = [];
  const registration = await autoRegisterProject(vault, { cwd, harness });
  if (registration.excludeWarning) warnings.push(`Marker exclude update failed: ${registration.excludeWarning}`);
  const result = await worktreeRecord(vault, { ...record, cwd, taskId });
  if (result.projection?.conflicts?.length) warnings.push("Journal is stored in SQLite; modified weekly Markdown was preserved.");
  try { await recordToolUse(vault, "worktree_record", { cwd }, result); }
  catch { warnings.push("Record saved, but usage review accounting failed."); }
  return warnings;
}

/** Files named by a Codex apply_patch body (`*** Add|Update|Delete File:` and `*** Move to:`). */
export function codexPatchFiles(patch) {
  if (typeof patch !== "string") return [];
  const files = new Set();
  for (const match of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm)) files.add(match[1]);
  return [...files];
}

/** Absolute paths changed by an edit tool call, or an empty list for any other tool. */
export function editedFiles(host, payload) {
  const input = payload?.tool_input;
  const base = typeof payload?.cwd === "string" ? payload.cwd : process.cwd();
  let files = [];
  if (host === "claude" && CLAUDE_EDIT_TOOLS.has(payload?.tool_name)) {
    files = [input?.file_path ?? input?.notebook_path];
  } else if (host === "codex" && payload?.tool_name === "apply_patch") {
    files = codexPatchFiles(input?.command);
  }
  return files.filter((file) => typeof file === "string" && file).map((file) => path.resolve(base, file));
}

/** Map a host tool call onto the lower-case tool shapes the access guard inspects. */
export function guardEvent(host, payload) {
  const name = payload?.tool_name;
  const input = payload?.tool_input ?? {};
  if (typeof name !== "string") return null;
  if (name.startsWith("mcp__")) return { toolName: name, input };
  if (name === "Bash") return { toolName: "bash", input };
  if (host === "claude") {
    const file = input.file_path ?? input.notebook_path;
    switch (name) {
      case "Read": return { toolName: "read", input: { ...input, path: file } };
      case "Write": return { toolName: "write", input: { ...input, path: file } };
      case "Edit": case "MultiEdit": case "NotebookEdit": return { toolName: "edit", input: { ...input, path: file } };
      case "Grep": return { toolName: "grep", input };
      case "Glob": return { toolName: "glob", input: { ...input, paths: [input.pattern] } };
      default: return null;
    }
  }
  if (host === "codex" && name === "apply_patch") return { toolName: "edit", input: { ...input, paths: codexPatchFiles(input.command) } };
  return null;
}

function defaultProcessInfo(pid) {
  try {
    const line = execFileSync("ps", ["-o", "ppid=", "-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(line);
    return match ? { ppid: Number(match[1]), command: match[2] } : null;
  } catch { return null; }
}

/** The long-lived host process behind a hook: skip the intermediate shell the host may use to run the command. */
export function agentProcessId({ ppid = process.ppid, processInfo = defaultProcessInfo } = {}) {
  let pid = ppid;
  for (let hop = 0; hop < 6 && pid > 1; hop++) {
    const info = processInfo(pid);
    if (!info || !SHELLS.has(path.basename(info.command).replace(/^-/, ""))) return pid;
    pid = info.ppid;
  }
  return pid > 1 ? pid : ppid;
}

const stateKey = (sessionId) => crypto.createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32);
const stateDir = (vault, host) => path.join(vault, ".agent-vault", "hooks", host);
const stateFile = (vault, host, sessionId, suffix) => path.join(stateDir(vault, host), `${stateKey(sessionId)}.${suffix}`);

function loadState(vault, host, sessionId) {
  try { return JSON.parse(fs.readFileSync(stateFile(vault, host, sessionId, "json"), "utf8")); }
  catch { return null; }
}

function saveState(vault, host, sessionId, state) {
  fs.mkdirSync(stateDir(vault, host), { recursive: true, mode: 0o700 });
  const file = stateFile(vault, host, sessionId, "json");
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function clearState(vault, host, sessionId) {
  for (const suffix of ["json", "pending"]) fs.rmSync(stateFile(vault, host, sessionId, suffix), { force: true });
}

// O_APPEND keeps concurrent PostToolUse hooks (parallel tool calls) from losing each other's entries.
function appendPending(vault, host, sessionId, files) {
  fs.mkdirSync(stateDir(vault, host), { recursive: true, mode: 0o700 });
  fs.appendFileSync(stateFile(vault, host, sessionId, "pending"), files.map((file) => `${JSON.stringify(file)}\n`).join(""), { mode: 0o600 });
}

function takePending(vault, host, sessionId) {
  const file = stateFile(vault, host, sessionId, "pending");
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  fs.rmSync(file, { force: true });
  const files = new Set();
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { files.add(JSON.parse(line)); } catch { /* A torn line is dropped, never guessed. */ }
  }
  return [...files];
}

function pruneState(vault, host, now) {
  const dir = stateDir(vault, host);
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const file = path.join(dir, name);
    try { if (now - fs.statSync(file).mtimeMs > STATE_RETENTION_MS) fs.rmSync(file, { force: true }); } catch { /* Best effort. */ }
  }
}

const relativeTo = (cwd, file) => {
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : path.basename(file);
};

async function flushEdits(vault, host, sessionId, state, cwd, warnings) {
  const absolute = takePending(vault, host, sessionId);
  if (absolute.length === 0) return;
  const files = absolute.map((file) => relativeTo(cwd, file)).sort();
  const triggered = (state?.lastPrompt ?? "").split("\n")[0].slice(0, 200) || "(no prompt recorded)";
  try {
    warnings.push(...await recordHostEntry(vault, {
      cwd, harness: host, taskId: state?.taskId,
      record: {
        kind: "implementation",
        slug: `edit-${Date.now().toString(36)}`,
        title: `Edited ${files.length} file(s)`,
        content: `Triggered by: ${triggered}\n\nFiles:\n${files.map((file) => `- ${file}`).join("\n")}`.slice(0, MAX_CHARS),
      },
    }));
  } catch (error) { warnings.push(`record skipped: ${error.message}`); }
}

async function closeTask(vault, state, completed, warnings) {
  if (!state?.taskId) return;
  try {
    const result = await endMemoryTask(vault, { taskId: state.taskId, completed });
    for (const key of ["weekly", "persona"]) {
      if (result[key]?.error) warnings.push(`${key} maintenance deferred: ${result[key].error}`);
      if (result[key]?.conflicts?.length) warnings.push(`${key} maintenance preserved modified files.`);
    }
  } catch (error) { warnings.push(`task completion skipped: ${error.message}`); }
}

/**
 * Apply one host hook event. Returns `{ warnings, block?, context? }`: `block` carries the guard reason for a denied
 * tool call and `context` is a one-line task hint for the prompt event. `vault` and `payload.cwd` must be absolute.
 * Unknown events are ignored so a new host event never breaks the hook.
 */
export async function handleHostHook({ host, payload, vault, now = Date.now(), processInfo }) {
  const warnings = [];
  if (!HOOK_HOSTS.includes(host)) throw new Error(`Unsupported hook host '${host}'.`);
  const event = payload?.hook_event_name;
  const sessionId = payload?.session_id;
  const cwd = typeof payload?.cwd === "string" && path.isAbsolute(payload.cwd) ? payload.cwd : null;
  if (event === "PreToolUse") {
    const call = guardEvent(host, payload);
    const blocked = call && guardToolCall(vault, call, { cwd: cwd ?? process.cwd() });
    return { warnings, ...(blocked ? { block: blocked.reason } : {}) };
  }
  if (typeof sessionId !== "string" || !sessionId || !cwd || !fs.existsSync(path.join(vault, "_meta"))) return { warnings };
  const state = loadState(vault, host, sessionId);
  let context;
  switch (event) {
    case "UserPromptSubmit": {
      pruneState(vault, host, now);
      // A turn the host never reported as finished is closed as cancelled before the next one starts.
      await flushEdits(vault, host, sessionId, state, state?.cwd ?? cwd, warnings);
      await closeTask(vault, state, false, warnings);
      clearState(vault, host, sessionId);
      const text = String(payload.prompt ?? "").trim();
      // Raw prompt text never enters hook state: only a line the secret-checked journal already accepted is kept (below).
      const next = { taskId: `${host}-${crypto.randomUUID()}`, cwd, ownerPid: agentProcessId({ processInfo }) };
      try {
        const started = await beginMemoryTask(vault, { taskId: next.taskId, ownerPid: next.ownerPid });
        if (started.started) {
          saveState(vault, host, sessionId, next);
          context = `agent-vault: active memory task ${next.taskId}. Pass taskId "${next.taskId}" to context and worktree_record.`;
        } else delete next.taskId;
      } catch (error) {
        delete next.taskId;
        warnings.push(`task start skipped: ${error.message}`);
      }
      try {
        const recalled = await autoRecallContext(vault, { cwd, prompt: text }, {});
        if (recalled) context = [context, recalled].filter(Boolean).join("\n\n");
      } catch (error) { warnings.push(`automatic recall skipped: ${error.message}`); }
      if (text) {
        try {
          warnings.push(...await recordHostEntry(vault, {
            cwd, harness: host, taskId: next.taskId,
            record: { kind: "instruction", slug: `prompt-${Date.now().toString(36)}`, title: text.split("\n")[0].slice(0, 120), content: text.slice(0, MAX_CHARS) },
          }));
          if (next.taskId) saveState(vault, host, sessionId, { ...next, lastPrompt: text.split("\n")[0].slice(0, 120) });
        } catch (error) { warnings.push(`record skipped: ${error.message}`); }
      }
      break;
    }
    case "PostToolUse": {
      const files = editedFiles(host, payload);
      if (files.length) appendPending(vault, host, sessionId, files);
      break;
    }
    case "Stop":
    case "StopFailure":
    case "Interrupt":
    case "SessionEnd": {
      await flushEdits(vault, host, sessionId, state, state?.cwd ?? cwd, warnings);
      await closeTask(vault, state, event === "Stop", warnings);
      clearState(vault, host, sessionId);
      break;
    }
    default:
      break;
  }
  return { warnings, ...(context ? { context } : {}) };
}
