#!/usr/bin/env node

// Command hook for Claude Code and Codex: `vault-hook.mjs --host claude|codex [--path <vault>]`.
// Reads one JSON event on stdin and prints at most one JSON object. It never blocks the host except to deny a
// tool call that reaches the vault directly, and it always exits 0 so a hook failure cannot stall the session.
import path from "node:path";
import { resolveVaultPath } from "../lib/vault-core.mjs";
import { handleHostHook, HOOK_HOSTS } from "../lib/host-hooks.mjs";
import { closeMemoryDbs } from "../lib/memory-db.mjs";

const MAX_BYTES = 4_000_000;
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

let event;
const warnings = [];
let out;
try {
  const host = flag("--host");
  if (!HOOK_HOSTS.includes(host)) throw new Error(`--host must be one of ${HOOK_HOSTS.join(", ")}.`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error("Hook input exceeds 4 MB.");
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  event = payload?.hook_event_name;
  const result = await handleHostHook({ host, payload, vault: path.resolve(resolveVaultPath(flag("--path"))) });
  warnings.push(...result.warnings);
  if (result.block) {
    out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: result.block } };
  } else if (result.context && event === "UserPromptSubmit") {
    out = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: result.context } };
  }
} catch (error) {
  warnings.push(`hook skipped: ${error.message}`);
} finally {
  closeMemoryDbs();
}
if (warnings.length) out = { ...out, systemMessage: warnings.map((warning) => `agent-vault: ${warning.replace(/^agent-vault:\s*/, "")}`).join("\n") };
if (out) process.stdout.write(JSON.stringify(out));
