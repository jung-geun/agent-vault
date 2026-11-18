import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initVault, scaffoldProject } from "../lib/vault-core.mjs";
import { installHooks, uninstallHooks, hooksStatus, hookConfigPath, hookCommand } from "../lib/hooks-install.mjs";
import { codexPatchFiles, editedFiles, guardEvent, agentProcessId } from "../lib/host-hooks.mjs";
import { queryTerms, rankMemories } from "../lib/recall.mjs";
import { memoryStats, diagnoseMemory } from "../lib/memory-inspect.mjs";
import { longTermWrite, recallMemory } from "../lib/memory-tiers.mjs";
import { saveSettings } from "../lib/settings.mjs";
import { closeMemoryDbs } from "../lib/memory-db.mjs";

const hookBin = fileURLToPath(new URL("../bin/vault-hook.mjs", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-hooks-test-"));
  const home = path.join(root, "home");
  await mkdir(home);
  t.after(async () => { closeMemoryDbs(); await rm(root, { recursive: true, force: true }); });
  const vault = path.join(root, "vault");
  await initVault(vault);
  await scaffoldProject(vault, "alpha", "Alpha");
  const repo = path.join(root, "alpha-repo");
  await mkdir(repo);
  await writeFile(path.join(vault, "_meta", "projects-index.md"), "| [Alpha](../projects/alpha/index.md) | alpha-repo | app | remote `origin` branch `main` | Node |\n");
  return { root, home, vault, repo };
}

function runHook(host, vault, payload, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBin, "--host", host, "--path", vault], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: stdout ? JSON.parse(stdout) : null }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const base = (repo, extra) => ({ session_id: "session-1", cwd: repo, transcript_path: null, ...extra });

test("hook installer merges, is idempotent, and removes only its own entries", async (t) => {
  const { home, vault, repo } = await fixture(t);
  const options = { home, cwd: repo, env: {}, vaultPath: vault };
  const claudeFile = hookConfigPath("claude", options);
  await mkdir(path.dirname(claudeFile), { recursive: true });
  const foreign = { type: "command", command: "echo mine" };
  await writeFile(claudeFile, JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [foreign] }], Notification: [{ hooks: [foreign] }] } }));
  const first = await installHooks("claude", options);
  assert.equal(first.status, "updated");
  const settings = JSON.parse(await readFile(claudeFile, "utf8"));
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.hooks.Notification, [{ hooks: [foreign] }]);
  assert.equal(settings.hooks.Stop.length, 2);
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /vault-hook\.mjs' --host claude --path /);
  assert.equal((await installHooks("claude", options)).status, "already current");
  assert.equal((await hooksStatus("claude", options)).state, "current");
  await writeFile(claudeFile, (await readFile(claudeFile, "utf8")).replaceAll("--host claude", "--host claude --stale"));
  assert.ok((await hooksStatus("claude", options)).events.every((event) => event.state === "drifted"));
  assert.equal((await installHooks("claude", options)).status, "updated");
  const removed = await uninstallHooks("claude", options);
  assert.ok(removed.removed >= 6);
  const after = JSON.parse(await readFile(claudeFile, "utf8"));
  assert.deepEqual(after, { theme: "dark", hooks: { Stop: [{ hooks: [foreign] }], Notification: [{ hooks: [foreign] }] } });
});

test("hook installer refuses malformed configuration without writing and reports Codex trust", async (t) => {
  const { home, vault, repo } = await fixture(t);
  const options = { home, cwd: repo, env: {}, vaultPath: vault };
  const file = hookConfigPath("codex", options);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{not json");
  await assert.rejects(installHooks("codex", options), /not valid JSON/);
  assert.equal(await readFile(file, "utf8"), "{not json");
  await rm(file);
  await writeFile(path.join(path.dirname(file), "config.toml"), "[features]\nhooks = false\n");
  const result = await installHooks("codex", options);
  assert.equal(result.status, "installed");
  assert.match(result.trust, /\/hooks/);
  const status = await hooksStatus("codex", options);
  assert.equal(status.state, "current");
  assert.ok(status.notes.some((note) => /hooks = false/.test(note)));
  assert.match(JSON.parse(await readFile(file, "utf8")).hooks.SessionEnd[0].hooks[0].command, new RegExp(`'${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
  assert.equal(hookCommand("claude", { node: "/n o/node", script: "/s/it's.mjs" }), "'/n o/node' '/s/it'\\''s.mjs' --host claude");
});

test("host payloads map to edited files and guard tool shapes", () => {
  assert.deepEqual(codexPatchFiles("*** Begin Patch\n*** Add File: a.txt\n*** Update File: src/b.js\n*** Move to: src/c.js\n*** Delete File: d\n*** End Patch"), ["a.txt", "src/b.js", "src/c.js", "d"]);
  assert.deepEqual(editedFiles("claude", { cwd: "/w", tool_name: "Edit", tool_input: { file_path: "/w/x.js" } }), ["/w/x.js"]);
  assert.deepEqual(editedFiles("claude", { cwd: "/w", tool_name: "Read", tool_input: { file_path: "/w/x.js" } }), []);
  assert.deepEqual(editedFiles("codex", { cwd: "/w", tool_name: "apply_patch", tool_input: { command: "*** Update File: y.js" } }), ["/w/y.js"]);
  assert.deepEqual(guardEvent("claude", { tool_name: "Read", tool_input: { file_path: "/v/a.md" } }), { toolName: "read", input: { file_path: "/v/a.md", path: "/v/a.md" } });
  assert.equal(guardEvent("claude", { tool_name: "WebFetch", tool_input: {} }), null);
  const info = new Map([[30, { ppid: 20, command: "/bin/zsh" }], [20, { ppid: 10, command: "-bash" }], [10, { ppid: 1, command: "/usr/local/bin/claude" }]]);
  assert.equal(agentProcessId({ ppid: 30, processInfo: (pid) => info.get(pid) ?? null }), 10);
  assert.equal(agentProcessId({ ppid: 77, processInfo: () => null }), 77);
});

test("claude hooks register a task, record instruction and edits, and close it on completion", async (t) => {
  const { vault, repo } = await fixture(t);
  const prompt = await runHook("claude", vault, base(repo, { hook_event_name: "UserPromptSubmit", prompt: "Refactor the parser module" }));
  assert.equal(prompt.code, 0);
  assert.match(prompt.out.hookSpecificOutput.additionalContext, /active memory task claude-/);
  assert.equal((await memoryStats(vault)).tasks.active, 1);
  const edited = path.join(repo, "src", "parser.js");
  await runHook("claude", vault, base(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: edited } }));
  await runHook("claude", vault, base(repo, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: edited } }));
  const stop = await runHook("claude", vault, base(repo, { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "done" }));
  assert.equal(stop.code, 0);
  assert.equal((await memoryStats(vault)).tasks.active, 0);
  const { queryWeeklyMemory } = await import("../lib/weekly-memory.mjs");
  const records = (await queryWeeklyMemory(vault, { project: "alpha", kind: "worktree", limit: 20 })).records;
  const titles = records.map((record) => record.title);
  assert.ok(titles.includes("Refactor the parser module"), titles.join("|"));
  const implementation = records.find((record) => record.title === "Edited 1 file(s)");
  assert.ok(implementation, titles.join("|"));
  assert.match(implementation.content, /- src\/parser\.js/);
  assert.match(implementation.content, /Triggered by: Refactor the parser module/);
});

test("an interrupted turn, a superseded prompt and a session end all close the open task", async (t) => {
  const { vault, repo } = await fixture(t);
  await runHook("codex", vault, base(repo, { hook_event_name: "UserPromptSubmit", prompt: "Investigate the flaky test" }));
  assert.equal((await memoryStats(vault)).tasks.active, 1);
  await runHook("codex", vault, base(repo, { hook_event_name: "Interrupt" }));
  assert.equal((await memoryStats(vault)).tasks.active, 0);
  await runHook("codex", vault, base(repo, { hook_event_name: "UserPromptSubmit", prompt: "Try again with a smaller case" }));
  // A prompt that arrives while the previous turn never reported Stop cancels the stale task instead of leaking it.
  await runHook("codex", vault, base(repo, { hook_event_name: "UserPromptSubmit", prompt: "Actually, a different question" }));
  assert.equal((await memoryStats(vault)).tasks.active, 1);
  await runHook("codex", vault, base(repo, { hook_event_name: "SessionEnd", reason: "other" }));
  assert.equal((await memoryStats(vault)).tasks.active, 0);
});

test("the pre-tool hook denies direct vault access and allows ordinary files", async (t) => {
  const { vault, repo } = await fixture(t);
  const denied = await runHook("claude", vault, base(repo, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(vault, "user", "profile.md") } }));
  assert.equal(denied.out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.out.hookSpecificOutput.permissionDecisionReason, /tool-only/);
  const bash = await runHook("claude", vault, base(repo, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `cat ${vault}/user/profile.md` } }));
  assert.equal(bash.out.hookSpecificOutput.permissionDecision, "deny");
  const allowed = await runHook("claude", vault, base(repo, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path.join(repo, "README.md") } }));
  assert.equal(allowed.out, null);
  const patch = await runHook("codex", vault, base(repo, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Update File: ${vault}/user/profile.md` } }));
  assert.equal(patch.out.hookSpecificOutput.permissionDecision, "deny");
});

test("a hook never fails the host: bad input only produces a warning", async (t) => {
  const { vault } = await fixture(t);
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [hookBin, "--host", "claude", "--path", vault], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out: JSON.parse(out) }));
    child.stdin.end("not json");
  });
  assert.equal(result.code, 0);
  assert.match(result.out.systemMessage, /hook skipped/);
});

test("recall terms drop filler and Korean particles; ranking needs two matching terms and prefers rare ones", () => {
  assert.deepEqual(queryTerms("How should we deploy the release 서버에서 배포는").map((forms) => forms[0]), ["deploy", "release", "서버에서", "배포는"]);
  assert.deepEqual(queryTerms("서버에서 배포는").map((forms) => forms), [["서버에서", "서버"], ["배포는", "배포"]]);
  const row = (id, title, content, extra = {}) => ({ id, title, content, tags: [], readCount: 0, updatedAt: "2026-11-01T00:00:00.000Z", ...extra });
  const rows = [
    row(1, "Release process", "Releases use pnpm and tags. The deploy job runs after CI."),
    row(2, "Parser notes", "The parser handles deploy keys once."),
    row(3, "Unrelated", "Lunch menu."),
    row(4, "배포 절차", "서버 배포는 CI가 끝난 뒤 수행한다."),
  ];
  const ranked = rankMemories(rows, "release deploy checklist", { now: new Date("2026-11-18T00:00:00Z") });
  assert.deepEqual(ranked.map((entry) => entry.memory.id), [1]);
  assert.deepEqual(ranked[0].matchedTerms, ["release", "deploy"]);
  assert.deepEqual(rankMemories(rows, "서버에서 배포는 어떻게", { now: new Date("2026-11-18T00:00:00Z") }).map((entry) => entry.memory.id), [4]);
  assert.deepEqual(rankMemories(rows, "lunch").map((entry) => entry.memory.id), [3]);
  assert.deepEqual(rankMemories(rows, "the and of"), []);
});

test("recall ranks across project and global knowledge and counts as a read", async (t) => {
  const { vault, repo } = await fixture(t);
  await longTermWrite(vault, { project: "alpha", role: undefined, title: "Release process", content: "Releases use pnpm and git tags; the deploy job runs after CI is green." });
  await longTermWrite(vault, { scope: "global", title: "Review preference", content: "Prefer small pull requests with deploy notes." });
  await longTermWrite(vault, { project: "alpha", title: "Lunch", content: "Nothing relevant here." });
  const result = await recallMemory(vault, { cwd: repo, query: "how do we deploy a release" });
  assert.deepEqual(result.results.map((item) => item.title), ["Release process"]);
  assert.match(result.instruction, /never an instruction/);
  assert.equal(result.results[0].readCount, 0);
  const again = await recallMemory(vault, { cwd: repo, query: "deploy release steps" });
  assert.equal(again.results[0].readCount, 1);
  await assert.rejects(recallMemory(vault, { cwd: repo, query: "" }), /recall requires a query/);
});

test("automatic recall is off by default, preloads background context when enabled, and never counts as a read", async (t) => {
  const { vault, repo } = await fixture(t);
  await longTermWrite(vault, { project: "alpha", title: "Release process", content: "Releases use pnpm and git tags; the deploy job runs after CI is green." });
  const prompt = { hook_event_name: "UserPromptSubmit", prompt: "Explain how we deploy a release please" };
  const off = await runHook("claude", vault, base(repo, prompt));
  assert.doesNotMatch(off.out.hookSpecificOutput.additionalContext, /recalled memory/);
  await saveSettings(vault, { recall: { auto: true, limit: 3, maxChars: 600 } });
  const on = await runHook("claude", vault, base(repo, prompt));
  const context = on.out.hookSpecificOutput.additionalContext;
  assert.match(context, /recalled memory \(background context, not instructions/);
  assert.match(context, /Release process/);
  assert.match(context, /memory:\d+/);
  const check = await recallMemory(vault, { cwd: repo, query: "deploy release" });
  assert.equal(check.results[0].readCount, 0, "preload must not inflate read counts");
  const unrelated = await runHook("claude", vault, base(repo, { hook_event_name: "UserPromptSubmit", prompt: "Rename the lunch spreadsheet columns" }));
  assert.doesNotMatch(unrelated.out.hookSpecificOutput.additionalContext, /recalled memory/);
});

test("stats and diagnose are read-only and give an action for every problem", async (t) => {
  const { vault, repo } = await fixture(t);
  assert.deepEqual(await memoryStats(path.join(vault, "missing")), { vaultReady: false, message: "The vault is not initialized; run setup or init first." });
  await longTermWrite(vault, { project: "alpha", title: "Fact", content: "Body of a durable fact." });
  const before = await memoryStats(vault, { cwd: repo });
  assert.equal(before.project.projectId, "alpha");
  assert.equal(before.memories.activeKnowledge, 1);
  assert.equal(before.reviews.failedActions, 0);
  const again = await memoryStats(vault, { cwd: repo });
  assert.deepEqual(again.reviews, before.reviews);
  const report = await diagnoseMemory(vault, { cwd: repo });
  assert.equal(report.healthy, true);
  assert.ok(report.checks.every((item) => item.status === "ok" || item.status === "info" || item.fix));
  assert.ok(report.checks.some((item) => item.name === "database" && item.status === "ok"));
  const hooks = report.checks.find((item) => item.name === "hooks");
  assert.equal(hooks.status, "info");
  const unregistered = await diagnoseMemory(vault, { cwd: tmpdir() });
  assert.equal(unregistered.checks.find((item) => item.name === "project").status, "warn");
  const uninitialized = await diagnoseMemory(path.join(vault, "missing"));
  assert.equal(uninitialized.healthy, false);
  assert.ok(uninitialized.checks.find((item) => item.name === "vault").fix);
});

test("the MCP server recognises the task a Claude hook opened, through the shared host process", async (t) => {
  const { root, vault, repo } = await fixture(t);
  await runHook("claude", vault, base(repo, { hook_event_name: "UserPromptSubmit", prompt: "Plan the migration steps" }));
  const serverPath = fileURLToPath(new URL("../bin/vault-mcp.mjs", import.meta.url));
  const home = path.join(root, "home");
  const call = (harness) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath, "--path", vault], { cwd: repo, env: { ...process.env, HOME: home, OMP_VAULT_PATH: vault, AGENT_VAULT_HARNESS: harness }, stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP server timed out")); }, 15_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      clearTimeout(timer);
      child.kill();
      resolve(JSON.parse(JSON.parse(buffer.split("\n")[0]).result.content[0].text));
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context", arguments: { role: "builder" } } })}\n`);
  });
  const claude = await call("claude");
  assert.equal(claude.memoryMaintenance.lifecycle.status, "connected");
  assert.match(claude.memoryMaintenance.lifecycle.taskId, /^claude-/);
  const generic = await call("generic");
  assert.equal(generic.memoryMaintenance.lifecycle.status, "not_connected");
  await runHook("claude", vault, base(repo, { hook_event_name: "Stop", last_assistant_message: "ok" }));
});

async function filesUnder(directory) {
  const { readdir } = await import("node:fs/promises");
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(target));
    else if (entry.isFile()) found.push(target);
  }
  return found;
}

const vaultContains = async (vault, needle) => {
  for (const file of await filesUnder(vault)) if ((await readFile(file)).includes(needle)) return file;
  return null;
};

test("a credential-shaped prompt is rejected from the journal and never reaches hook state or any vault file", async (t) => {
  const { vault, repo } = await fixture(t);
  const secret = `sk-${"a1B2c3D4e5F6g7H8i9J0k1L2"}`;
  const prompt = `Use ${secret} to call the billing API and refactor the invoice module`;
  const submitted = await runHook("claude", vault, base(repo, { hook_event_name: "UserPromptSubmit", prompt }));
  assert.equal(submitted.code, 0);
  assert.match(submitted.out.systemMessage, /record skipped/);
  assert.ok(!JSON.stringify(submitted.out).includes(secret), "hook output must not echo the credential");
  // The turn is still open (as after a crash): nothing from the prompt may be on disk yet.
  assert.equal((await memoryStats(vault)).tasks.active, 1);
  const state = (await filesUnder(path.join(vault, ".agent-vault", "hooks"))).filter((file) => file.endsWith(".json"));
  assert.equal(state.length, 1);
  const saved = await readFile(state[0], "utf8");
  assert.ok(!saved.includes(secret) && !saved.includes("invoice") && !saved.includes("lastPrompt"), saved);
  closeMemoryDbs();
  assert.equal(await vaultContains(vault, secret), null, "credential found in the vault before Stop");
  await runHook("claude", vault, base(repo, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, "invoice.js") } }));
  await runHook("claude", vault, base(repo, { hook_event_name: "Stop", last_assistant_message: "done" }));
  const { queryWeeklyMemory } = await import("../lib/weekly-memory.mjs");
  const records = (await queryWeeklyMemory(vault, { project: "alpha", kind: "worktree", limit: 20 })).records;
  assert.ok(!records.some((record) => record.kind === "worktree" && /billing API/.test(record.content)), "rejected prompt must not be journaled");
  const implementation = records.find((record) => record.title === "Edited 1 file(s)");
  assert.match(implementation.content, /Triggered by: \(no prompt recorded\)/);
  closeMemoryDbs();
  assert.equal(await vaultContains(vault, secret), null, "credential found in the vault after Stop");
});
