import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureSettings, setupVault } from "../lib/setup.mjs";
import { joinModeFor, loadSettings } from "../lib/settings.mjs";
import { resolveProject } from "../lib/memory-store.mjs";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/vault-cli.mjs", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-setup-"));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  t.after(async () => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  const home = path.join(root, "home");
  const repo = path.join(root, "checkout");
  const vault = path.join(root, "vault");
  await mkdir(home);
  await mkdir(repo);
  process.env.HOME = home;
  process.chdir(repo);
  const env = { ...process.env, HOME: home, OMP_VAULT_PATH: vault };
  const run = (args, cwd = repo) => execFileAsync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });
  return { root, home, repo, vault, env, run };
}

const missing = (file) => assert.rejects(readFile(file), { code: "ENOENT" });

test("setup defaults to guided help without creating vault or integrations", async (t) => {
  const { root, home, vault, run } = await fixture(t);
  const before = await readdir(root);
  const { stdout } = await run(["setup"]);
  assert.match(stdout, /no changes made/);
  assert.match(stdout, /--mode manual --project my-project/);
  assert.match(stdout, /omp, claude, codex, generic/);
  assert.match(stdout, /not a sandbox/);
  assert.deepEqual(await readdir(root), before);
  assert.deepEqual(await readdir(home), []);
  await assert.rejects(readdir(vault), { code: "ENOENT" });
});

test("config prints default settings without writing them", async (t) => {
  const { vault, run } = await fixture(t);
  const settings = JSON.parse((await run(["config"])).stdout);
  assert.equal(settings.team.enabled, false);
  assert.deepEqual(settings.review.thresholds, [5, 10, 20]);
  await assert.rejects(readdir(vault), { code: "ENOENT" });
});

test("manual without project sets only harness mode and does not initialize", async (t) => {
  const { vault, home, run } = await fixture(t);
  await run(["config", "--mode", "auto", "--harness", "codex"]);
  const result = JSON.parse((await run(["setup", "--mode", "manual", "--harness", "omp"])).stdout);
  assert.equal(result.initialized, false);
  assert.equal(result.registration, null);
  assert.equal(joinModeFor(loadSettings(vault), "omp"), "manual");
  assert.equal(joinModeFor(loadSettings(vault), "codex"), "auto");
  await missing(path.join(vault, "_meta/projects-index.md"));
  assert.deepEqual(await readdir(home), []);
});

test("manual setup registers only current Git project and preserves existing guidance", async (t) => {
  const { vault, repo, root, home, run } = await fixture(t);
  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  const other = path.join(root, "other-checkout");
  await mkdir(other);
  await execFileAsync("git", ["init", "-q", "-b", "main", other]);
  await writeFile(path.join(repo, "AGENTS.md"), "# Keep project rules\n");
  const nested = path.join(repo, "src");
  await mkdir(nested);
  const result = JSON.parse((await run(["setup", "--mode", "manual", "--project", "chosen-project", "--harness", "claude"], nested)).stdout);
  assert.equal(result.registration.projectId, "chosen-project");
  assert.equal(result.registration.sourceDir, "checkout");
  assert.equal((await resolveProject(vault, { cwd: nested })).projectId, "chosen-project");
  assert.equal((await resolveProject(vault, { cwd: other })).status, "unregistered");
  const instructions = await readFile(path.join(repo, "AGENTS.md"), "utf8");
  assert.match(instructions, /^# Keep project rules/);
  assert.ok(instructions.length > "# Keep project rules\n".length);
  await run(["setup", "--mode", "manual", "--project", "chosen-project", "--harness", "claude"], nested);
  assert.equal((await readFile(path.join(repo, "AGENTS.md"), "utf8")).split("<!-- agent-vault:start -->").length, 2);
  assert.equal(loadSettings(vault).team.enabled, false);
  assert.deepEqual(await readdir(home), []);
});

test("manual project setup refuses non-Git directories before mutation", async (t) => {
  const { vault, repo, run } = await fixture(t);
  await assert.rejects(run(["setup", "--mode", "manual", "--project", "chosen-project"]), /current Git project/);
  await assert.rejects(readdir(vault), { code: "ENOENT" });
  await assert.rejects(setupVault(vault, { mode: "auto", project: "chosen-project", cwd: repo }), /requires --mode manual/);
  await assert.rejects(setupVault(vault, { harness: "omp", cwd: repo }), /requires --mode/);
});

test("auto setup initializes but leaves registration to first harness use", async (t) => {
  const { vault, repo, home, run } = await fixture(t);
  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  const result = JSON.parse((await run(["setup", "--mode", "auto", "--harness", "omp"])).stdout);
  assert.equal(result.initialized, true);
  assert.equal(result.registration, null);
  assert.equal(loadSettings(vault).join.default, "manual");
  assert.equal(loadSettings(vault).join.harnesses.omp, "auto");
  assert.equal((await resolveProject(vault, { cwd: repo })).status, "unregistered");
  await missing(path.join(repo, "AGENTS.md"));
  assert.deepEqual(await readdir(home), []);
});

test("config supports explicit team service, local file, read-only and off", async (t) => {
  const { vault, root, run } = await fixture(t);
  let settings = JSON.parse((await run(["config", "--team-url", "https://memory.example.test/v1", "--team-id", "lab-team", "--token-env", "LAB_MEMORY_TOKEN", "--read-only"])).stdout);
  assert.equal(settings.team.backend, "http");
  assert.equal(settings.team.allowWrite, false);
  assert.equal(settings.team.tokenEnv, "LAB_MEMORY_TOKEN");
  const localFile = path.join(root, "team.sqlite");
  const fileResult = await run(["config", "--team-file", localFile, "--team-id", "lab-team"]);
  settings = JSON.parse(fileResult.stdout);
  assert.match(fileResult.stderr, /never use NFS or sync/);
  assert.equal(settings.team.backend, "file");
  assert.equal(settings.team.path, localFile);
  assert.equal(settings.team.url, null);
  assert.equal(settings.team.tokenEnv, null);
  assert.equal(settings.team.allowWrite, true);
  await missing(localFile);
  settings = JSON.parse((await run(["config", "--team-off"])).stdout);
  assert.equal(settings.team.enabled, false);
  assert.equal(settings.team.path, localFile);
  await run(["config", "--review-thresholds", "5,10,20", "--stale-days", "7"]);
  assert.equal(loadSettings(vault).review.staleShortTermDays, 7);
});

test("CLI persists weekly and persona config and queries bounded SQLite journal pages", async (t) => {
  const { vault, repo, run } = await fixture(t);
  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  await run(["setup", "--mode", "manual", "--project", "chosen-project"]);
  const settings = JSON.parse((await run(["config", "--markdown-months", "2", "--timezone", "Asia/Seoul", "--workday-start", "08:30", "--persona", "on", "--persona-min-observations", "4"])).stdout);
  assert.deepEqual(settings.weekly, { retentionMonths: 2, timeZone: "Asia/Seoul", workdayStart: "08:30" });
  assert.equal(settings.persona.enabled, true);
  assert.equal(settings.persona.minObservations, 4);
  assert.deepEqual(loadSettings(vault).weekly, settings.weekly);
  const { writeLog } = await import("../lib/memory-store.mjs");
  const { longTermWrite } = await import("../lib/memory-tiers.mjs");
  const { closeMemoryDbs } = await import("../lib/memory-db.mjs");
  t.after(closeMemoryDbs);
  const now = new Date("2026-11-16T12:00:00Z");
  const first = await writeLog(vault, { project: "chosen-project", slug: "first-query", kind: "qa", title: "First query check", content: "cli-query-sentinel " + "evidence ".repeat(1000) }, { now });
  const second = await writeLog(vault, { project: "chosen-project", slug: "second-query", kind: "qa", title: "Second query check", content: "cli-query-sentinel second check" }, { now });
  const global = await longTermWrite(vault, { scope: "global", title: "Shared CLI fact", content: "global-cli-sentinel" }, { now });
  const args = ["memory", "query", "--project", "chosen-project", "--from", "2026-11-16", "--to", "2026-11-16", "--week", "2026-47", "--kind", "log", "--query", "cli-query-sentinel", "--limit", "1"];
  const pageOne = JSON.parse((await run(args)).stdout);
  const pageTwo = JSON.parse((await run([...args, "--offset", "1"])).stdout);
  assert.equal(pageOne.records.length, 1);
  assert.equal(pageOne.hasMore, true);
  assert.equal(pageTwo.records.length, 1);
  assert.equal(pageTwo.hasMore, false);
  assert.deepEqual(new Set([...pageOne.records, ...pageTwo.records].map((row) => row.id)), new Set([first.id, second.id]));
  assert.ok([...pageOne.records, ...pageTwo.records].every((row) => row.content.length <= 2000 && row.ref === `memory:${row.id}`));
  const inferred = JSON.parse((await run(["memory", "query", "--kind", "log"])).stdout);
  assert.equal(inferred.project, "chosen-project");
  const shared = JSON.parse((await run(["memory", "query", "--scope", "global", "--query", "global-cli-sentinel"])).stdout);
  assert.deepEqual(shared.records.map((row) => row.id), [global.id]);
  await assert.rejects(run(["memory", "query", "--project", "chosen-project", "--limit", "0"]));
  const disabled = JSON.parse((await run(["config", "--persona", "off"])).stdout);
  assert.equal(disabled.persona.enabled, false);
  assert.equal(JSON.parse((await run(["persona", "--scope", "global"])).stdout).enabled, false);
});

test("config rejects incomplete or unsafe options without saving", async (t) => {
  const { vault, run } = await fixture(t);
  const invalid = [
    ["--mode", "sometimes"], ["--mode", "manual", "--harness", "unknown"], ["--harness", "omp"],
    ["--team-url", "https://example.test"], ["--team-url", "file:///tmp/team", "--team-id", "lab"],
    ["--team-url", "https://user:pass@example.test", "--team-id", "lab"],
    ["--team-file", "relative.sqlite", "--team-id", "lab"], ["--team-off", "--read-only"],
    ["--review-thresholds", "10,5"], ["--review-thresholds", "5,,20"], ["--stale-days", "0"],
    ["--stale-days", "1.5"], ["--unknown"], ["--mode"], ["--mode", "manual", "--mode", "auto"],
    ["--markdown-months", "0"], ["--markdown-months", "7"], ["--markdown-months", "1.5"],
    ["--timezone", "Invalid/Zone"], ["--workday-start", "24:00"], ["--workday-start", "9:00"],
    ["--persona", "maybe"], ["--persona-min-observations", "1"],
  ];
  for (const flags of invalid) await assert.rejects(run(["config", ...flags]), undefined, flags.join(" "));
  await assert.rejects(readdir(vault), { code: "ENOENT" });
  await assert.rejects(configureSettings(vault, { teamFile: "/tmp/team.sqlite", teamId: "lab", tokenEnv: "TOKEN" }), /requires --team-url/);
});

test("CLI memory commands call tier exports with project, global and role scopes", async (t) => {
  const { vault, repo, run } = await fixture(t);
  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  await run(["setup", "--mode", "manual", "--project", "chosen-project"]);
  const project = JSON.parse((await run(["memory", "sleep", "--project", "chosen-project"])).stdout);
  assert.equal(project.scope, "project");
  assert.equal(project.project, "chosen-project");
  const inferred = JSON.parse((await run(["memory", "sleep"])).stdout);
  assert.equal(inferred.project, "chosen-project");
  const global = JSON.parse((await run(["memory", "sleep", "--scope", "global", "--role", "builder"])).stdout);
  assert.equal(global.scope, "global");
  assert.equal(global.role, "builder");
  const migrated = JSON.parse((await run(["memory", "migrate", "--project", "chosen-project"])).stdout);
  assert.ok(Array.isArray(migrated.imported));
  await assert.rejects(run(["memory", "migrate"]), /requires --project/);
  await assert.rejects(run(["memory", "sleep", "--scope", "global", "--project", "chosen-project"]), /Choose --project/);
  await assert.rejects(run(["memory", "sleep", "--scope", "team"]), /--scope must be global/);
  await assert.rejects(run(["memory", "sleep", "--role", "unknown"]));
  await assert.rejects(run(["memory", "unknown"]));
  assert.equal(loadSettings(vault).team.enabled, false);
});

for (const runtime of [
  { name: "Node", command: process.execPath, args: ["--experimental-strip-types", "--input-type=module", "-e"] },
  ...(process.env.AGENT_VAULT_TEST_BUN === "1" ? [{ name: "Bun", command: "bun", args: ["-e"] }] : []),
]) test(`global OMP install preserves settings and defers maintenance until successful task completion (${runtime.name})`, async (t) => {
  const { home, repo, vault, env, run } = await fixture(t);
  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  await run(["setup", "--mode", "manual", "--project", "chosen-project"]);
  await run(["install", "--global"]);
  const configPath = path.join(home, ".omp/agent/mcp.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.mcpServers["agent-vault"].env.AGENT_VAULT_HARNESS, "omp");
  config.mcpServers["agent-vault"].env.CUSTOM_MEMORY_OPTION = "preserved";
  await writeFile(configPath, JSON.stringify(config));
  await run(["install", "--global"]);
  const updated = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(updated.mcpServers["agent-vault"].env.CUSTOM_MEMORY_OPTION, "preserved");
  assert.equal(updated.mcpServers["agent-vault"].env.AGENT_VAULT_HARNESS, "omp");
  const recorder = path.join(home, ".omp/agent/extensions/agent-vault-recorder.ts");
  const inspector = `
    import { pathToFileURL } from "node:url";
    const base = pathToFileURL(${JSON.stringify(recorder)});
    const tiers = await import(new URL("../skills/agent-vault/lib/memory-tiers.mjs", base));
    const { closeMemoryDbs, openMemoryDb, memoryDbFile, activeMemoryTasks } = await import(new URL("../skills/agent-vault/lib/memory-db.mjs", base));
    const vault = ${JSON.stringify(vault)};
    const scopes = [
      { scope: "project", project: "chosen-project" },
      { scope: "global" },
      { scope: "global", role: "builder" },
      { scope: "project", project: "chosen-project", role: "builder" },
    ];
    try {
      if (process.argv[1] === "seed") {
        for (const scope of scopes.slice(1)) {
          for (let index = 0; index < 5; index++) {
            await tiers.recordToolUse(vault, "long_memory_read", scope, scope);
          }
        }
      } else {
        const reports = [];
        for (const scope of scopes) reports.push(await tiers.reviewMemory(vault, scope));
        const context = await tiers.getTieredContext(vault, { cwd: ${JSON.stringify(repo)}, role: "builder", harness: "generic" });
        const tasks = activeMemoryTasks(await openMemoryDb(memoryDbFile(vault)));
        process.stdout.write(JSON.stringify({ reports, maintenance: context.memoryMaintenance, tasks }));
      }
    } finally {
      closeMemoryDbs();
    }
  `;
  const scenario = `
    import assert from "node:assert/strict";
    import { execFile, spawn } from "node:child_process";
    import { promisify } from "node:util";
    import { fileURLToPath, pathToFileURL } from "node:url";
    import { rename } from "node:fs/promises";
    const execFileAsync = promisify(execFile);
    const inspect = async (operation = "snapshot") => {
      const result = await execFileAsync("node", ["--input-type=module", "-e", ${JSON.stringify(inspector)}, operation], { env: process.env });
      return operation === "snapshot" ? JSON.parse(result.stdout) : undefined;
    };
    const { default: install } = await import(pathToFileURL(${JSON.stringify(recorder)}));
    const hooks = new Map();
    const warnings = [];
    install({ on(name, handler) { hooks.set(name, handler); } });
    const ctx = { cwd: ${JSON.stringify(repo)}, ui: { notify(message) { warnings.push(message); } } };
    const start = (prompt) => hooks.get("before_agent_start")({ reason: "prompt", prompt }, ctx);
    const finish = (event = { messages: [
      { role: "assistant", stopReason: "stop" },
      { role: "user" },
      { role: "assistant", stopReason: "stop" },
    ] }) => hooks.get("agent_end")(event, ctx);
    const pending = (snapshot, counts) => {
      for (const [index, report] of snapshot.reports.entries()) {
        const totalOps = counts[index];
        if (totalOps === null) continue;
        assert.ok(report.pendingReviews.some((ticket) => ticket.totalOps === totalOps), JSON.stringify(report));
        assert.ok(!report.reviews.some((ticket) => ticket.totalOps === totalOps), JSON.stringify(report));
      }
    };
    const blocked = hooks.get("tool_call")({ toolName: "read", input: { path: ${JSON.stringify(`${vault}/user/profile.md`)} } }, ctx);
    assert.equal(blocked.block, true);
    assert.equal(hooks.get("tool_call")({ toolName: "bash", input: { command: "git status" } }, ctx), undefined);
    const mcpConfig = ${JSON.stringify(updated.mcpServers["agent-vault"])};
    const mcp = spawn(mcpConfig.command, mcpConfig.args, {
      cwd: ctx.cwd, env: { ...process.env, ...mcpConfig.env }, stdio: ["pipe", "pipe", "pipe"],
    });
    let nextRequest = 0;
    let protocolBuffer = "";
    let protocolErrors = "";
    const requests = new Map();
    mcp.stderr.on("data", (chunk) => { protocolErrors += chunk; });
    mcp.stdout.setEncoding("utf8");
    mcp.stdout.on("data", (chunk) => {
      protocolBuffer += chunk;
      let newline;
      while ((newline = protocolBuffer.indexOf("\\n")) >= 0) {
        const reply = JSON.parse(protocolBuffer.slice(0, newline));
        protocolBuffer = protocolBuffer.slice(newline + 1);
        const request = requests.get(reply.id);
        if (request) {
          requests.delete(reply.id);
          clearTimeout(request.timer);
          request.resolve(reply);
        }
      }
    });
    const call = async (name, args = {}) => {
      const id = ++nextRequest;
      const pending = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("MCP response timed out: " + protocolErrors)), 10000);
        requests.set(id, { resolve, timer });
      });
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\\n");
      const reply = await pending;
      assert.equal(reply.result.isError, undefined, JSON.stringify(reply));
      return JSON.parse(reply.result.content[0].text);
    };
    try {
    const disconnected = (await call("vault_context", { role: "builder" })).memoryMaintenance;
    assert.equal(disconnected.lifecycle.status, "not_connected");
    assert.equal(disconnected.reviewWork, null);
    const initialRevision = (await inspect()).maintenance.contextRevision;
    for (let index = 0; index < 5; index++) await start("Inspect invariant " + index);
    await inspect("seed");
    let snapshot = await inspect();
    pending(snapshot, [5, 5, 5, 5]);
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.tasks[0].ownerPid, process.pid);
    const taskId = snapshot.tasks[0].taskId;
    assert.equal(snapshot.maintenance.contextRevision, initialRevision);
    assert.equal(snapshot.maintenance.deferred, true);
    const firstContextA = await call("vault_context", { role: "builder" });
    assert.equal(firstContextA.memoryMaintenance.lifecycle.status, "connected");
    assert.equal(firstContextA.memoryMaintenance.lifecycle.taskId, taskId);
    assert.equal(firstContextA.memoryMaintenance.reviewWork.taskId, taskId);
    assert.deepEqual(firstContextA.memoryMaintenance.reviewWork.namespaces, []);
    assert.equal(firstContextA.memoryMaintenance.contextRevision, initialRevision);
    assert.equal((await call("vault_context", { role: "builder" })).memoryMaintenance.reviewWork, null);
    hooks.get("tool_call")({ toolName: "edit", toolCallId: "edit-one", input: { path: "source.mjs" } }, ctx);
    hooks.get("tool_execution_end")({ toolName: "edit", toolCallId: "edit-one" }, ctx);
    await hooks.get("turn_end")({}, ctx);
    snapshot = await inspect();
    pending(snapshot, [6, 5, 5, 5]);
    assert.equal(snapshot.tasks[0].taskId, taskId);
    assert.equal(snapshot.maintenance.contextRevision, initialRevision);
    await finish({ willContinue: true, messages: [{ role: "assistant", stopReason: "stop" }] });
    await hooks.get("before_agent_start")({ reason: "retry", prompt: "Do not replace this task" }, ctx);
    snapshot = await inspect();
    pending(snapshot, [6, 5, 5, 5]);
    assert.equal(snapshot.tasks[0].taskId, taskId);
    assert.equal(snapshot.maintenance.contextRevision, initialRevision);
    assert.equal(snapshot.maintenance.deferred, true);
    await finish();
    snapshot = await inspect();
    for (const [index, report] of snapshot.reports.entries()) {
      assert.ok(report.reviews.some((ticket) => ticket.totalOps === (index === 0 ? 6 : 5)));
    }
    assert.deepEqual(snapshot.tasks, []);
    assert.ok(snapshot.maintenance.contextRevision > initialRevision);
    const completedRevision = snapshot.maintenance.contextRevision;
    await finish();
    assert.equal((await inspect()).maintenance.contextRevision, completedRevision);
    for (const [index, stopReason] of ["aborted", "error", "length", undefined].entries()) {
      await start("Cancelled task " + index);
      if (index === 0) {
        const firstContextB = await call("vault_context", { role: "builder" });
        assert.equal(firstContextB.memoryMaintenance.lifecycle.status, "connected");
        assert.notEqual(firstContextB.memoryMaintenance.reviewWork.taskId, taskId);
        const namespaces = firstContextB.memoryMaintenance.reviewWork.namespaces;
        assert.equal(namespaces.length, 4);
        assert.ok(namespaces.every((namespace) => namespace.tickets.every((ticket) => ticket.state === "ready")));
        assert.equal(firstContextB.memoryMaintenance.contextRevision, completedRevision);
        const repeated = await call("vault_context", { role: "builder" });
        assert.equal(repeated.memoryMaintenance.reviewWork, null);
        assert.equal(repeated.memoryMaintenance.contextRevision, completedRevision);
      }
      if (index === 0) await inspect("seed");
      await finish({ messages: stopReason === undefined ? [
        { role: "assistant", stopReason: "stop" },
        { role: "user" },
      ] : [
        { role: "assistant", stopReason: "stop" },
        { role: "user" },
        { role: "assistant", stopReason },
      ] });
      snapshot = await inspect();
      pending(snapshot, [null, 10, 10, 10]);
      assert.deepEqual(snapshot.tasks, []);
      assert.equal(snapshot.maintenance.contextRevision, completedRevision);
    }
    pending(snapshot, [10, 10, 10, 10]);
    await start("Continued task");
    const continuedId = (await inspect()).tasks[0].taskId;
    await start("Next prompt in continued task");
    snapshot = await inspect();
    pending(snapshot, [12, 10, 10, 10]);
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.tasks[0].taskId, continuedId);
    const replacementId = continuedId;
    assert.equal(snapshot.maintenance.contextRevision, completedRevision);
    const worker = fileURLToPath(new URL("../skills/agent-vault/bin/vault-recorder.mjs", pathToFileURL(${JSON.stringify(recorder)})));
    await rename(worker, worker + ".held");
    try {
      await finish();
    } finally {
      await rename(worker + ".held", worker);
    }
    snapshot = await inspect();
    pending(snapshot, [12, 10, 10, 10]);
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.tasks[0].taskId, replacementId);
    assert.equal(snapshot.maintenance.contextRevision, completedRevision);
    await start("Recover failed completion");
    snapshot = await inspect();
    pending(snapshot, [13, 10, 10, 10]);
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.tasks[0].taskId, replacementId);
    await finish();
    snapshot = await inspect();
    for (const [index, report] of snapshot.reports.entries()) {
      assert.ok(report.reviews.some((ticket) => ticket.totalOps === (index === 0 ? 13 : 10)));
    }
    assert.deepEqual(snapshot.tasks, []);
    assert.ok(snapshot.maintenance.contextRevision > completedRevision);
    const drainedRevision = snapshot.maintenance.contextRevision;
    await start("Below the next threshold");
    await hooks.get("turn_end")({}, ctx);
    await finish();
    assert.equal((await inspect()).maintenance.contextRevision, drainedRevision);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^agent-vault task completion skipped:/);
    } finally {
      mcp.stdin.end();
      mcp.kill();
    }
  `;
  await execFileAsync(runtime.command, [...runtime.args, scenario], { env, cwd: repo, encoding: "utf8", maxBuffer: 1024 * 1024 });
  const { queryWeeklyMemory } = await import("../lib/weekly-memory.mjs");
  const { closeMemoryDbs } = await import("../lib/memory-db.mjs");
  t.after(closeMemoryDbs);
  const { records } = await queryWeeklyMemory(vault, { project: "chosen-project", kind: "worktree", limit: 100 });
  const implementations = records.filter((record) => record.content.includes("source.mjs"));
  assert.equal(implementations.length, 1);
  assert.ok(typeof implementations[0].worktree === "string" && implementations[0].worktree.length > 0);
});
