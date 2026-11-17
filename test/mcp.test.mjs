import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initVault, scaffoldProject } from "../lib/vault-core.mjs";

const serverPath = fileURLToPath(new URL("../bin/vault-mcp.mjs", import.meta.url));

async function startServer(t, vault, cwd, env = {}, entrypoint = serverPath) {
  const home = path.join(path.dirname(vault), "home");
  await mkdir(home, { recursive: true });
  const child = spawn(process.execPath, [entrypoint, "--path", vault], { cwd, env: { ...process.env, HOME: home, OMP_VAULT_PATH: vault, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const lines = [];
  let buffer = "";
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      lines.push(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      for (const w of waiters.splice(0)) w();
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => (stderr += c));

  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return waitFor(id);
  };
  const waitFor = (id) =>
    new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`timeout waiting for ${id}; stderr=${stderr}`)), 10_000);
      const check = () => {
        const index = lines.findIndex((l) => JSON.parse(l).id === id);
        if (index !== -1) {
          clearTimeout(deadline);
          resolve(JSON.parse(lines.splice(index, 1)[0]));
        } else waiters.push(check);
      };
      check();
    });
  const call = async (name, args) => {
    const reply = await request("tools/call", { name, arguments: args });
    const text = reply.result.content[0].text;
    return { isError: reply.result.isError === true, body: JSON.parse(text.replace(/\n… \[truncated\]$/, "")) };
  };
  return { request, call, child, lines, stderr: () => stderr };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-mcp-test-"));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const home = path.join(root, "home");
  await mkdir(home);
  process.env.HOME = home;
  t.after(async () => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  const vault = path.join(root, "vault");
  await initVault(vault);
  await scaffoldProject(vault, "alpha", "Alpha");
  const repo = path.join(root, "alpha-repo");
  await mkdir(repo);
  process.chdir(repo);
  await writeFile(
    path.join(vault, "_meta", "projects-index.md"),
    "| [Alpha](../projects/alpha/index.md) | alpha-repo | app | remote `origin` branch `main` | Node |\n",
  );
  return { root, vault, repo };
}

test("handshake advertises tools and the memory-first instructions", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const reply = await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(reply.result.protocolVersion, "2025-06-18");
  assert.deepEqual(reply.result.capabilities, { tools: { listChanged: false } });
  assert.equal(reply.result.serverInfo.name, "agent-vault");
  assert.match(reply.result.instructions, /vault_context/);
  assert.match(reply.result.instructions, /memory_search/);
});

test("tools/list exposes memory, project and agent operations with schemas", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const reply = await server.request("tools/list", {});
  const names = reply.result.tools.map((tool) => tool.name).sort();
  for (const required of ["vault_context", "memory_search", "memory_read", "memory_list", "memory_write", "memory_query", "persona_observe", "persona_read", "persona_resolve", "memory_task_start", "project_resolve", "project_list", "project_scaffold", "agent_memory_read", "agent_memory_write", "agent_handoff", "log_write"]) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }
  for (const tool of reply.result.tools) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object schema`);
  }
  const taskSchema = reply.result.tools.find((tool) => tool.name === "memory_task_start").inputSchema;
  assert.equal(taskSchema.properties.parentTaskId.type, "string");
  assert.equal(taskSchema.properties.resumeTaskId.type, "string");
});

test("write, search and read round-trip through the protocol with the content hash", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const written = await server.call("memory_write", {
    path: "shared/knowledge/retry-policy.md",
    mode: "create",
    title: "Retry policy",
    content: "Exponential backoff with jitter for the queue consumer.",
  });
  assert.equal(written.isError, false);

  const found = await server.call("memory_search", { query: "backoff jitter", scope: "shared" });
  assert.equal(found.body.results[0].path, "shared/knowledge/retry-policy.md");

  const read = await server.call("memory_read", { path: "shared/knowledge/retry-policy.md" });
  assert.equal(read.body.sha256, written.body.sha256);
});

test("memory access events count successful tools without storing query text", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const query = "private-query-marker";

  await server.call("memory_write", {
    path: "projects/alpha/agents/builder/notes.md",
    mode: "create",
    content: `Searchable note: ${query}`,
  });
  await server.call("memory_search", { query, scope: "project", project: "alpha", role: "builder" });
  await server.call("memory_list", { scope: "project", project: "alpha" });
  await server.call("memory_read", { path: "projects/alpha/agents/builder/notes.md" });
  await server.call("memory_read", { path: "projects/alpha/missing.md" });

  const log = await readFile(path.join(vault, ".agent-vault", "access.jsonl"), "utf8");
  const events = log.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((event) => event.tool), ["memory_write", "memory_search", "memory_list", "memory_read"]);
  assert.equal(events[0].project, "alpha");
  assert.equal(events[0].role, "builder");
  assert.equal(events[0].created, true);
  assert.equal(events[1].role, "builder");
  assert.equal(events[1].resultCount, 1);
  assert.deepEqual(events[1].paths, ["projects/alpha/agents/builder/notes.md"]);
  assert.equal(events[3].path, "projects/alpha/agents/builder/notes.md");
  assert.ok(events.every((event) => !("query" in event) && !("content" in event) && !("cwd" in event)));
  assert.equal(log.includes(query), false);
});

test("access logging can be disabled through the MCP process environment", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo, { AGENT_VAULT_DISABLE_ACCESS_LOG: "1" });
  const result = await server.call("memory_search", { query: "absent", scope: "shared" });
  assert.equal(result.isError, false);
  await assert.rejects(readFile(path.join(vault, ".agent-vault", "access.jsonl")), { code: "ENOENT" });
});

test("access-log filesystem failures do not fail successful memory tools", async (t) => {
  const { root, vault, repo } = await fixture(t);
  const outsideLog = path.join(root, "outside-access.jsonl");
  await writeFile(outsideLog, "keep this file\n");
  await symlink(outsideLog, path.join(vault, ".agent-vault"));
  const server = await startServer(t, vault, repo);

  const result = await server.call("memory_search", { query: "missing", scope: "shared" });
  assert.equal(result.isError, false);
  assert.equal(await readFile(outsideLog, "utf8"), "keep this file\n");
  assert.match(server.stderr(), /access log failed/);
});

test("project-aware context resolves from cwd without the caller naming a project", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const context = await server.call("vault_context", { role: "builder" });
  assert.equal(context.body.project.status, "resolved");
  assert.equal(context.body.project.projectId, "alpha");
  assert.deepEqual(context.body.roleMemory.results, []);
});

test("refusals come back as tool errors, not protocol errors", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);

  const escape = await server.call("memory_read", { path: "../../etc/passwd" });
  assert.equal(escape.isError, true);
  assert.equal(escape.body.error, "path_escape");

  const secret = await server.call("memory_write", {
    path: "shared/knowledge/leak.md",
    mode: "create",
    content: "api_key = 'abcdefghijklmnopqrstuvwxyz0123'",
  });
  assert.equal(secret.body.error, "secret_detected");

  const invalid = await server.call("memory_search", { query: "" });
  assert.equal(invalid.body.error, "invalid_arguments");

  const schema = await server.call("agent_memory_write", { role: "janitor", title: "x", content: "y" });
  assert.equal(schema.body.error, "invalid_arguments");
  assert.match(schema.body.message, /role/);
});

test("notifications get no reply and unknown methods get JSON-RPC errors", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  server.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const reply = await server.request("nope/nope", {});
  assert.equal(reply.error.code, -32601);

  server.child.stdin.write("{not json\n");
  const parse = await new Promise((resolve) => {
    const check = () => {
      const index = server.lines.findIndex((l) => JSON.parse(l).error?.code === -32700);
      if (index !== -1) resolve(JSON.parse(server.lines.splice(index, 1)[0]));
      else setTimeout(check, 10);
    };
    check();
  });
  assert.equal(parse.error.code, -32700);
});

test("stdout carries only protocol messages; diagnostics stay on stderr", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  await server.call("memory_search", { query: "anything" });
  await server.request("ping", {});
  for (const line of server.lines) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.jsonrpc, "2.0");
  }
  assert.match(server.stderr(), /vault=/);
});

test("every tool works end-to-end when calls are awaited in order", async (t) => {
  const { root, vault, repo } = await fixture(t);
  const betaRepo = path.join(root, "beta-repo");
  await mkdir(betaRepo);
  const server = await startServer(t, vault, repo);

  const scaffold = await server.call("project_scaffold", { project: "beta", title: "Beta", sourceDir: "beta-repo", classification: "app", git: "no remote", stack: "Node" });
  assert.equal(scaffold.isError, false);
  assert.equal(scaffold.body.registered, true);

  const resolved = await server.call("project_resolve", { cwd: betaRepo });
  assert.equal(resolved.body.status, "resolved");
  assert.equal(resolved.body.projectId, "beta");

  const agentWrite = await server.call("agent_memory_write", { project: "beta", role: "builder", title: "Build order", content: "Run check before test." });
  assert.equal(agentWrite.isError, false);
  assert.match(agentWrite.body.ref, /^memory:\d+$/);

  const agentRead = await server.call("agent_memory_read", { project: "beta", role: "builder" });
  assert.equal(agentRead.body.results[0].content, "Run check before test.");

  const handoff = await server.call("agent_handoff", { project: "beta", slug: "review-build", from: "builder", to: "reviewer", title: "Review build", content: "Check the order note." });
  assert.equal(handoff.isError, false);
  assert.equal(handoff.body.ref, `memory:${handoff.body.id}`);
  const handoffRead = await server.call("long_memory_read", { project: "beta", id: handoff.body.id });
  assert.equal(handoffRead.body.kind, "handoff");
  assert.match(handoffRead.body.content, /Check the order note\./);

  const log = await server.call("log_write", { project: "beta", kind: "qa", slug: "smoke", title: "Smoke", content: "Ran npm test: pass." });
  assert.equal(log.isError, false);
  assert.equal(log.body.ref, `memory:${log.body.id}`);
  const logs = await server.call("memory_query", { project: "beta", kind: "log" });
  assert.deepEqual(logs.body.records.map((row) => row.id), [log.body.id]);

  const listed = await server.call("memory_list", { scope: "project", project: "beta" });
  const paths = listed.body.notes.map((n) => n.path);
  assert.ok(!paths.includes("projects/beta/agents/builder/memory.md"));
  assert.ok(paths.every((notePath) => !notePath.startsWith("projects/beta/logs/")));

  const projects = await server.call("project_list", {});
  const beta = projects.body.projects.find((p) => p.id === "beta");
  assert.equal(beta.registered, true);
  assert.equal(beta.sourceDir, "beta-repo");
});

test("pipelined requests are answered in order, so dependent calls see earlier effects", async (t) => {
  const { root, vault, repo } = await fixture(t);
  await mkdir(path.join(root, "gamma-repo"));
  const server = await startServer(t, vault, repo);
  const first = server.request("tools/call", { name: "project_scaffold", arguments: { project: "gamma", sourceDir: "gamma-repo" } });
  const second = server.request("tools/call", { name: "project_resolve", arguments: { cwd: path.join(root, "gamma-repo") } });
  const [scaffold, resolved] = await Promise.all([first, second]);
  assert.notEqual(scaffold.result.isError, true);
  assert.equal(JSON.parse(resolved.result.content[0].text).status, "resolved");
});

test("memory tiers and worktree records are advertised and work in order through the protocol", async (t) => {
  const { vault, repo } = await fixture(t);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const git = promisify(execFile);
  await git("git", ["init", "-q", "-b", "feature/tiers", repo]);
  await git("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"]);
  const server = await startServer(t, vault, repo);

  const listed = await server.request("tools/list", {});
  const names = listed.result.tools.map((tool) => tool.name);
  for (const name of ["short_memory_read", "short_memory_write", "long_memory_write", "worktree_record", "worktree_list"]) {
    assert.ok(names.includes(name), `missing ${name}`);
  }

  const empty = await server.call("short_memory_read", {});
  assert.equal(empty.body.exists, false);

  const written = await server.call("short_memory_write", { content: "Next: wire the tiers." });
  assert.equal(written.isError, false);
  const current = await server.call("short_memory_read", {});
  assert.equal(current.body.sha256, written.body.sha256);
  const refused = await server.call("short_memory_write", { content: "Overwrite." });
  assert.equal(refused.body.error, "hash_required");

  const longTerm = await server.call("long_memory_write", { slug: "tiers", title: "Memory tiers", content: "Short-term is mutable; long-term is dated." });
  assert.match(longTerm.body.ref, /^memory:\d+$/);
  const durable = await server.call("long_memory_read", { id: longTerm.body.id });
  assert.equal(durable.body.content, "Short-term is mutable; long-term is dated.");

  const record = await server.call("worktree_record", { kind: "instruction", slug: "tiers", title: "Tiers request", content: "User asked for tiers." });
  assert.equal(record.isError, false);
  assert.equal(record.body.ref, `memory:${record.body.id}`);
  const recordRead = await server.call("long_memory_read", { id: record.body.id });
  assert.equal(recordRead.body.kind, "worktree");
  assert.equal(recordRead.body.worktree, "feature-tiers");
  assert.match(recordRead.body.content, /User asked for tiers\./);

  const worktrees = await server.call("worktree_list", {});
  assert.deepEqual(worktrees.body.worktrees.map((w) => [w.key, w.records]), [["feature-tiers", 1]]);

  const context = await server.call("vault_context", {});
  assert.match(context.body.shortTermMemory.content, /wire the tiers/);
  assert.equal(context.body.worktree.key, "feature-tiers");
  assert.deepEqual(context.body.worktree.records, [record.body.ref]);
});

test("global, project and role memory remain isolated through MCP", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const global = await server.call("long_memory_write", { scope: "global", title: "Global fact", content: "Global isolation sentinel." });
  const agent = await server.call("long_memory_write", { scope: "global", role: "builder", title: "Builder fact", content: "Builder isolation sentinel." });
  await server.call("long_memory_write", { project: "alpha", title: "Project fact", content: "Project isolation sentinel." });
  assert.equal((await server.call("long_memory_search", { query: "sentinel" })).body.results[0].content, "Project isolation sentinel.");
  assert.equal((await server.call("long_memory_search", { scope: "global", query: "sentinel" })).body.results[0].id, global.body.id);
  assert.equal((await server.call("long_memory_search", { scope: "global", role: "builder", query: "sentinel" })).body.results[0].id, agent.body.id);
  assert.equal((await server.call("long_memory_read", { id: global.body.id })).body.error, "not_found");
  assert.equal((await server.call("long_memory_read", { scope: "global", id: agent.body.id })).body.error, "not_found");
  assert.equal((await server.call("long_memory_write", { scope: "team", title: "External", content: "Must not leave this vault." })).body.error, "team_disabled");

  const first = await server.call("short_memory_write", { scope: "global", content: "Shared work." });
  const role = await server.call("short_memory_write", { scope: "global", role: "builder", content: "Role work." });
  assert.notEqual(first.body.path, role.body.path);
  assert.match((await server.call("short_memory_read", { scope: "global" })).body.content, /Shared work/);
  assert.match((await server.call("short_memory_read", { scope: "global", role: "builder" })).body.content, /Role work/);
  assert.equal((await server.call("short_memory_write", { scope: "global", content: "Wrong revision.", expectedHash: role.body.sha256 })).body.error, "hash_mismatch");
  assert.equal((await server.call("short_memory_read", { scope: "global", project: "alpha" })).body.error, "invalid_scope");
});

test("operation thresholds stay pending until task completion at 5, 10 and 20", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  let taskId = (await server.call("memory_task_start", {})).body.taskId;
  const saved = await server.call("long_memory_write", { title: "Threshold fact", content: "Evidence remains valid." });
  let priorId;
  for (let count = 2; count <= 20; count++) {
    const read = await server.call("long_memory_read", { id: saved.body.id });
    assert.equal(read.body.memoryReview, undefined);
    if ([5, 10, 20].includes(count)) {
      const pending = await server.call("memory_review", {});
      assert.deepEqual(pending.body.reviews, []);
      assert.equal(pending.body.deferred, true);
      const ticket = pending.body.pendingReviews[0];
      assert.equal(ticket.totalOps, count);
      assert.notEqual(ticket.id, priorId);
      priorId = ticket.id;
      const blocked = await server.call("memory_sleep", {});
      assert.equal(blocked.body.deferred, true);
      assert.deepEqual(blocked.body.released, []);
      const ended = await server.call("memory_task_end", { taskId, completed: true });
      assert.equal(ended.body.completed, true);
      const review = await server.call("memory_review", {});
      assert.ok(review.body.reviews.some((item) => item.id === ticket.id));
      const resolved = await server.call("memory_review_resolve", { reviewId: ticket.id, action: "keep", note: "Checked the source; still valid." });
      assert.equal(resolved.body.resolved, true);
      if (count < 20) taskId = (await server.call("memory_task_start", {})).body.taskId;
    }
  }
});

test("review supersession keeps source evidence and rejects stale actions", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const { taskId } = (await server.call("memory_task_start", {})).body;
  const saved = await server.call("long_memory_write", { title: "Old policy", content: "Use parser one." });
  for (let i = 0; i < 4; i++) await server.call("long_memory_read", { id: saved.body.id });
  const reviewId = (await server.call("memory_review", {})).body.pendingReviews[0].id;
  const failed = await server.call("memory_review_resolve", { reviewId, action: "supersede", memoryId: saved.body.id, title: "Bad", content: `password = "${"a".repeat(24)}"`, note: "Must refuse credentials." });
  assert.equal(failed.body.error, "secret_detected");
  const replaced = await server.call("memory_review_resolve", { reviewId, action: "supersede", memoryId: saved.body.id, title: "New policy", content: "Use parser two.", note: "Verified compatibility against current source." });
  assert.equal(replaced.body.queued, true);
  const beforeEnd = await server.call("long_memory_search", { query: "parser" });
  assert.deepEqual(beforeEnd.body.results.map((item) => item.content), ["Use parser one."]);
  const ended = await server.call("memory_task_end", { taskId, completed: true });
  const applied = ended.body.maintenance.flatMap((item) => item.actionResults).find((item) => item.reviewId === reviewId);
  assert.equal(applied.applied, true);
  const active = await server.call("long_memory_search", { query: "parser" });
  assert.deepEqual(active.body.results.map((item) => item.content), ["Use parser two."]);
  const source = await server.call("long_memory_read", { id: saved.body.id });
  assert.equal(source.body.content, "Use parser one.");
  assert.equal(source.body.status, "superseded");
  assert.equal(source.body.supersededBy, applied.memoryId);
  assert.equal((await server.call("memory_review_resolve", { reviewId, action: "archive", memoryId: applied.memoryId, note: "Repeat." })).body.error, "review_resolved");
});

test("first context of the next task delivers ready evidence reviews once and stages changes until completion", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const taskA = (await server.call("memory_task_start", { taskId: "review-task-a" })).body.taskId;
  const initial = (await server.call("vault_context", { role: "builder" })).body;
  assert.equal(initial.memoryMaintenance.lifecycle.status, "connected");
  assert.deepEqual(initial.memoryMaintenance.reviewWork.namespaces, []);
  assert.equal(initial.memoryMaintenance.reviewWork.taskId, taskA);
  const saved = (await server.call("long_memory_write", { title: "Parser policy", content: "Use parser one." })).body;
  for (let index = 0; index < 10; index++) {
    const recalled = (await server.call("long_memory_read", { id: saved.id })).body;
    assert.equal(recalled.memoryReview, undefined);
  }
  const previousShort = await server.call("short_memory_read", { role: "builder" });
  const shortWrite = await server.call("short_memory_write", { role: "builder", content: "Verified promotion evidence.", expectedHash: previousShort.body.sha256 });
  assert.equal(shortWrite.isError, false);
  const short = shortWrite.body;
  for (let index = 0; index < 4; index++) await server.call("short_memory_read", { role: "builder" });
  const duringA = (await server.call("vault_context", { role: "builder" })).body;
  assert.equal(duringA.memoryMaintenance.reviewWork, null);
  assert.ok(duringA.memoryReviews.every((review) => review.reviews.length === 0 && review.skillCandidates.length === 0));
  assert.equal(duringA.memoryMaintenance.contextRevision, initial.memoryMaintenance.contextRevision);
  const projectPending = (await server.call("memory_review", {})).body;
  const rolePending = (await server.call("memory_review", { role: "builder" })).body;
  assert.deepEqual(projectPending.reviews, []);
  assert.deepEqual(rolePending.reviews, []);
  const projectTicket = projectPending.pendingReviews[0];
  const roleTicket = rolePending.pendingReviews[0];
  const endedA = (await server.call("memory_task_end", { taskId: taskA, completed: true })).body;
  assert.ok(endedA.maintenance.flatMap((report) => report.released).includes(projectTicket.id));
  assert.ok(endedA.maintenance.flatMap((report) => report.released).includes(roleTicket.id));

  const taskB = (await server.call("memory_task_start", { taskId: "review-task-b" })).body.taskId;
  const firstB = (await server.call("vault_context", { role: "builder" })).body;
  const work = firstB.memoryMaintenance.reviewWork;
  assert.equal(work.taskId, taskB);
  assert.equal(firstB.memoryMaintenance.contextRevision, endedA.contextRevision);
  assert.ok(firstB.memoryReviews.every((review) => review.reviews.length === 0));
  assert.deepEqual(work.namespaces.map((namespace) => ({
    scope: namespace.scope, project: namespace.project, role: namespace.role,
    tickets: namespace.tickets.map((ticket) => ticket.id),
  })), [
    { scope: "project", project: "alpha", role: null, tickets: [projectTicket.id] },
    { scope: "project", project: "alpha", role: "builder", tickets: [roleTicket.id] },
  ]);
  assert.deepEqual(work.namespaces[0].skillCandidates, [{ id: saved.id, title: "Parser policy", readCount: 10 }]);
  assert.equal(firstB.longTermRecent.find((memory) => memory.id === saved.id).readCount, 10);
  const secondB = (await server.call("vault_context", { role: "builder" })).body;
  assert.equal(secondB.memoryMaintenance.reviewWork, null);
  assert.equal(secondB.memoryMaintenance.contextRevision, endedA.contextRevision);
  assert.equal(secondB.longTermRecent.find((memory) => memory.id === saved.id).readCount, 10);
  const reconnected = await startServer(t, vault, repo);
  assert.equal((await reconnected.call("vault_context", { taskId: taskB, role: "builder" })).body.memoryMaintenance.reviewWork, null);
  const source = (await server.call("long_memory_read", { id: saved.id })).body;
  const promotionSource = (await server.call("short_memory_read", { role: "builder" })).body;
  assert.equal(source.content, "Use parser one.");
  assert.equal(promotionSource.sha256, short.sha256);
  const supersede = (await server.call("memory_review_resolve", {
    reviewId: projectTicket.id, action: "supersede", memoryId: source.id,
    title: "Verified parser policy", content: "Use parser two.", note: "Inspected current parser evidence.",
  })).body;
  const promote = (await server.call("memory_review_resolve", {
    role: "builder", reviewId: roleTicket.id, action: "promote", expectedHash: promotionSource.sha256,
    title: "Verified durable evidence", content: "Promotion verified against source.", note: "Read and verified working evidence.",
  })).body;
  assert.equal(supersede.queued, true);
  assert.equal(promote.queued, true);
  const staged = (await server.call("vault_context", { role: "builder" })).body;
  assert.equal(staged.memoryMaintenance.reviewWork, null);
  assert.equal(staged.memoryMaintenance.contextRevision, endedA.contextRevision);
  assert.equal(staged.longTermRecent.find((memory) => memory.id === saved.id).status, "active");
  assert.ok(staged.longTermRecent.every((memory) => memory.title !== "Verified durable evidence"));
  assert.equal((await server.call("short_memory_read", { role: "builder" })).body.sha256, short.sha256);
  const endedB = (await server.call("memory_task_end", { taskId: taskB, completed: true })).body;
  const actions = endedB.maintenance.flatMap((report) => report.actionResults);
  assert.equal(actions.find((action) => action.reviewId === projectTicket.id).applied, true);
  assert.equal(actions.find((action) => action.reviewId === roleTicket.id).applied, true);
  await server.call("memory_task_start", { taskId: "review-task-c" });
  const next = (await server.call("vault_context", { role: "builder" })).body;
  assert.ok(next.longTermRecent.some((memory) => memory.content === "Use parser two."));
  assert.ok(next.longTermRecent.some((memory) => memory.title === "Verified durable evidence" && memory.content.includes(short.sha256)));
  assert.ok(!next.longTermRecent.some((memory) => memory.id === saved.id));
  const nextTickets = next.memoryMaintenance.reviewWork.namespaces.flatMap((namespace) => namespace.tickets);
  assert.ok(nextTickets.every((ticket) => ticket.id !== projectTicket.id && ticket.id !== roleTicket.id));
  assert.ok(nextTickets.every((ticket) => ticket.key.endsWith(":context") && ticket.reason === "ops>=5"));
});

test("context claims only its actual task and reports disconnected or ambiguous lifecycle honestly", async (t) => {
  const { vault, repo } = await fixture(t);
  const owner = await startServer(t, vault, repo);
  const observer = await startServer(t, vault, repo);
  const taskId = (await owner.call("memory_task_start", { taskId: "owned-task" })).body.taskId;
  const disconnected = (await observer.call("vault_context", { role: "builder" })).body.memoryMaintenance;
  assert.equal(disconnected.lifecycle.status, "not_connected");
  assert.equal(disconnected.lifecycle.taskId, null);
  assert.equal(disconnected.reviewWork, null);
  const missing = (await owner.call("vault_context", { taskId: "missing-task", role: "builder" })).body.memoryMaintenance;
  assert.equal(missing.lifecycle.status, "not_connected");
  assert.equal(missing.reviewWork, null);
  await owner.call("memory_task_start", { taskId: "second-owned-task" });
  const ambiguous = (await owner.call("vault_context", { role: "builder" })).body.memoryMaintenance;
  assert.equal(ambiguous.lifecycle.status, "ambiguous");
  assert.equal(ambiguous.reviewWork, null);
  const explicit = (await owner.call("vault_context", { taskId, role: "builder" })).body.memoryMaintenance;
  assert.equal(explicit.lifecycle.status, "connected");
  assert.equal(explicit.reviewWork.taskId, taskId);
  assert.deepEqual(explicit.reviewWork.namespaces, []);
  assert.equal((await owner.call("vault_context", { taskId, role: "builder" })).body.memoryMaintenance.reviewWork, null);
  const otherRole = (await owner.call("vault_context", { taskId, role: "reviewer" })).body.memoryMaintenance;
  assert.equal(otherRole.reviewWork.taskId, taskId);
  await owner.call("memory_task_end", { taskId, completed: false });
  await owner.call("memory_task_end", { taskId: "second-owned-task", completed: false });
  const idle = (await observer.call("vault_context", {})).body.memoryMaintenance;
  assert.equal(idle.lifecycle.status, "not_connected");
  assert.equal(idle.reviewWork, null);
});

test("disconnected context never releases pending work and explains explicit idle maintenance", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const saved = (await server.call("long_memory_write", { title: "Manual maintenance", content: "Keep checked source evidence." })).body;
  for (let index = 0; index < 4; index++) await server.call("long_memory_read", { id: saved.id });
  const pending = (await server.call("memory_review", {})).body;
  assert.equal(pending.pendingReviews.length, 1);
  assert.deepEqual(pending.reviews, []);
  const context = (await server.call("vault_context", {})).body;
  assert.equal(context.memoryMaintenance.lifecycle.status, "not_connected");
  assert.equal(context.memoryMaintenance.reviewWork, null);
  assert.ok(context.memoryReviews.every((review) => review.reviews.length === 0));
  assert.deepEqual((await server.call("memory_review", {})).body.reviews, []);
  const released = (await server.call("memory_sleep", {})).body;
  assert.ok(released.released.includes(pending.pendingReviews[0].id));
  const idle = (await server.call("vault_context", {})).body;
  assert.equal(idle.memoryMaintenance.reviewWork, null);
  assert.ok(idle.memoryReviews.every((review) => review.reviews.length === 0 && review.skillCandidates.length === 0));
  assert.ok((await server.call("memory_review", {})).body.reviews.some((ticket) => ticket.id === pending.pendingReviews[0].id));
});

test("large SQLite memories remain readable in valid JSON pages", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const content = "A".repeat(35_000) + "end-of-memory";
  const saved = await server.call("long_memory_write", { title: "Long evidence", content });
  assert.equal(saved.isError, false);
  const first = await server.call("long_memory_read", { id: saved.body.id, maxChars: 30_000 });
  const second = await server.call("long_memory_read", { id: saved.body.id, maxChars: 30_000, offset: 30_000 });
  assert.equal(first.body.content + second.body.content, content);
  assert.equal(first.body.truncated, true);
  assert.equal(second.body.truncated, false);
});

test("first-use auto join honors the MCP harness and leaves manual projects untouched", async (t) => {
  const { root, vault } = await fixture(t);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { saveSettings } = await import("../lib/settings.mjs");
  const git = promisify(execFile);
  const repo = path.join(root, "new-project");
  await git("git", ["init", "-q", "-b", "main", repo]);
  await saveSettings(vault, { join: { harnesses: { omp: "auto", claude: "manual" } } });
  const server = await startServer(t, vault, repo, { AGENT_VAULT_HARNESS: "omp" });
  const manual = await server.call("vault_context", { harness: "claude" });
  assert.equal(manual.body.project.status, "unregistered");
  const joined = await server.call("vault_context", {});
  assert.equal(joined.body.project.status, "resolved");
  assert.equal(joined.body.project.projectId, "new-project");
  assert.equal(joined.body.registration.autoRegistered, true);
  const repeated = await server.call("vault_context", {});
  assert.equal(repeated.body.registration.autoRegistered, false);
  const projects = await server.call("project_list", {});
  assert.equal(projects.body.projects.filter((project) => project.id === "new-project").length, 1);
});

test("configured team memory stays opt-in and its reviews cannot mutate shared records", async (t) => {
  const { root, vault, repo } = await fixture(t);
  const { saveSettings } = await import("../lib/settings.mjs");
  await saveSettings(vault, { team: { enabled: true, backend: "file", path: path.join(root, "team.db"), teamId: "engineering" }, review: { thresholds: [1] } });
  const server = await startServer(t, vault, repo);
  const { taskId } = (await server.call("memory_task_start", {})).body;
  const saved = await server.call("long_memory_write", { scope: "team", title: "Shared evidence", content: "Use the reviewed protocol." });
  assert.equal(saved.isError, false);
  assert.equal(saved.body.teamId, "engineering");
  const ticket = (await server.call("memory_review", { scope: "team" })).body.pendingReviews[0];
  assert.equal((await server.call("long_memory_search", { scope: "global", query: "protocol" })).body.results.length, 0);
  const shared = await server.call("long_memory_search", { scope: "team", query: "protocol" });
  assert.equal(shared.body.results[0].content, "Use the reviewed protocol.");
  assert.equal((await server.call("memory_review_resolve", { scope: "team", reviewId: ticket.id, action: "archive", memoryId: saved.body.id, note: "Do not modify other users' records." })).body.error, "team_review_policy");
  const receipt = await server.call("memory_review_resolve", { scope: "team", reviewId: ticket.id, action: "keep", note: "The shared protocol matches current evidence." });
  assert.equal(receipt.body.queued, true);
  const ended = await server.call("memory_task_end", { taskId, completed: true });
  assert.ok(ended.body.maintenance.flatMap((item) => item.actionResults).some((item) => item.reviewId === ticket.id && item.applied));
  await saveSettings(vault, { team: { allowWrite: false } });
  assert.equal((await server.call("long_memory_write", { scope: "team", title: "Refused", content: "Read-only." })).body.error, "team_read_only");
});

test("context preloads do not count as recalls or create skill candidates", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const targets = [
    { scope: "global" }, { scope: "global", role: "builder" },
    { project: "alpha" }, { project: "alpha", role: "builder" },
  ];
  const saved = [];
  for (const [index, target] of targets.entries()) {
    const result = await server.call("long_memory_write", { ...target, title: `Preloaded fact ${index}`, content: `Preload evidence ${index}.` });
    assert.equal(result.isError, false);
    saved.push(result.body.id);
  }
  for (let index = 0; index < 10; index++) {
    const result = await server.call("vault_context", { role: "builder" });
    assert.equal(result.isError, false);
    assert.deepEqual(result.body.longTermRecent.map((memory) => memory.id).sort((a, b) => a - b), saved);
    assert.ok(result.body.longTermRecent.every((memory) => memory.readCount === 0 && memory.lastReadAt === null));
    assert.ok(result.body.memoryReviews.every((review) => review.skillCandidates.length === 0));
  }
  await server.call("long_memory_search", { scope: "global", query: "Preload evidence" });
  const recalled = await server.call("vault_context", { role: "builder" });
  assert.equal(recalled.body.longTermRecent.find((memory) => memory.id === saved[0]).readCount, 1);
  assert.ok(recalled.body.longTermRecent.filter((memory) => memory.id !== saved[0]).every((memory) => memory.readCount === 0));
});

test("MCP starts through a symlink entrypoint used by linked skill installs", async (t) => {
  const { root, vault, repo } = await fixture(t);
  const linkedServer = path.join(root, "linked-vault-mcp.mjs");
  await symlink(serverPath, linkedServer);
  const server = await startServer(t, vault, repo, {}, linkedServer);
  const handshake = await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "linked-install", version: "1" } });
  assert.equal(handshake.result.serverInfo.name, "agent-vault");
  const context = await server.call("vault_context", {});
  assert.equal(context.isError, false);
  assert.equal(context.body.project.projectId, "alpha");
});

function assessment(decision, overrides = {}) {
  return {
    decision,
    comparison: "Synthetic test evidence compares the previous claim with the reported counterexample.",
    applicability: "Applies only to the fixture's version-three parser.",
    limitations: "Fixture metadata exercises the protocol; it is not a real-world source verification.",
    sources: [{ kind: "project", reference: "fixture://parser/version-3", finding: "The fixture defines the supported version-three behavior.", stance: "qualifies" }],
    ...overrides,
  };
}

test("correction feedback queues below thresholds and requires comparative evidence before replacement", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const original = (await server.call("long_memory_write", { title: "Parser behavior", content: "All parser versions accept format A." })).body;
  const a = (await server.call("memory_task_start", {})).body.taskId;
  const request = await server.call("memory_reconsider", { memoryId: original.id, feedback: "Format A failed with version three; perhaps it is unsupported everywhere." });
  assert.equal(request.isError, false);
  assert.equal(request.body.knowledgeUpdated, false);
  const duplicate = await server.call("memory_reconsider", { memoryId: original.id, feedback: "Format A failed with version three; perhaps it is unsupported everywhere." });
  assert.equal(duplicate.body.requestId, request.body.requestId);
  assert.equal(duplicate.body.created, false);
  const pending = (await server.call("memory_review", {})).body.pendingReviews.find((review) => review.id === request.body.reviewId);
  assert.equal(pending.totalOps, 0);
  assert.equal(pending.feedback[0].memoryId, original.id);
  assert.match(pending.feedback[0].sourceHash, /^[a-f0-9]{64}$/);
  assert.equal((await server.call("long_memory_read", { id: original.id })).body.content, original.memory.content);
  await server.call("memory_task_end", { taskId: a, completed: true });
  const b = (await server.call("memory_task_start", {})).body.taskId;
  const context = (await server.call("vault_context", {})).body;
  assert.ok(context.memoryMaintenance.reviewWork.namespaces.flatMap((item) => item.tickets).some((item) => item.id === request.body.reviewId && item.feedback.length === 1));
  const proposal = { reviewId: request.body.reviewId, memoryId: original.id, action: "supersede", title: "Version-scoped parser behavior", content: "Format A is unsupported by version three; older versions need separate evaluation.", note: "Narrow the claim rather than copying the reported universal conclusion." };
  assert.equal((await server.call("memory_review_resolve", proposal)).body.error, "assessment_required");
  const userOnly = assessment("replace", { sources: [{ kind: "user_report", reference: "user-message:fixture", finding: "The user proposed a replacement claim.", stance: "supports" }] });
  assert.equal((await server.call("memory_review_resolve", { ...proposal, assessment: userOnly })).body.error, "evidence_required");
  const evaluated = assessment("refine");
  const staged = await server.call("memory_review_resolve", { ...proposal, assessment: evaluated });
  assert.equal(staged.body.queued, true);
  assert.equal((await server.call("long_memory_read", { id: original.id })).body.status, "active");
  const ended = (await server.call("memory_task_end", { taskId: b, completed: true })).body;
  const applied = ended.maintenance.flatMap((item) => item.actionResults).find((item) => item.reviewId === request.body.reviewId);
  assert.equal(applied.applied, true);
  assert.equal(applied.knowledgeUpdated, true);
  const revised = (await server.call("long_memory_read", { id: applied.memoryId })).body;
  assert.equal(revised.content, proposal.content);
  assert.ok(revised.tags.includes(`review:${request.body.reviewId}`));
  const receipt = (await server.call("memory_review", { reviewId: request.body.reviewId })).body.review;
  assert.equal(receipt.state, "resolved");
  assert.deepEqual(receipt.resolution.assessment, evaluated);
  assert.deepEqual(receipt.resolution.feedbackIds, [request.body.requestId]);
  assert.equal((await server.call("long_memory_read", { id: original.id })).body.content, original.memory.content);
});

test("reevaluation can retain previous knowledge instead of agreeing with feedback", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const original = (await server.call("long_memory_write", { title: "Scoped invariant", content: "This fixture requires Node version three." })).body;
  const taskId = (await server.call("memory_task_start", {})).body.taskId;
  const request = (await server.call("memory_reconsider", { memoryId: original.id, feedback: "I think this applies to version two instead." })).body;
  const retained = await server.call("memory_review_resolve", { reviewId: request.reviewId, memoryId: original.id, action: "keep", note: "The inspected fixture supports the original scoped invariant, not the proposed replacement.", assessment: assessment("retain") });
  assert.equal(retained.body.queued, true);
  const ended = (await server.call("memory_task_end", { taskId, completed: true })).body;
  const action = ended.maintenance.flatMap((item) => item.actionResults).find((item) => item.reviewId === request.reviewId);
  assert.equal(action.applied, true);
  assert.equal(action.knowledgeUpdated, false);
  assert.equal((await server.call("long_memory_read", { id: original.id })).body.content, original.memory.content);
  assert.equal((await server.call("memory_review", { reviewId: request.reviewId })).body.review.resolution.assessment.decision, "retain");
});

test("insufficient evidence defers without endorsing the original and later evidence clears the warning", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const original = (await server.call("long_memory_write", { title: "Platform limit", content: "The platform limit is ten." })).body;
  const a = (await server.call("memory_task_start", {})).body.taskId;
  const request = (await server.call("memory_reconsider", { memoryId: original.id, feedback: "The vendor may have changed the limit." })).body;
  const held = await server.call("memory_review_resolve", { reviewId: request.reviewId, memoryId: original.id, action: "defer", note: "Primary evidence is not accessible; no new limit is established.", assessment: assessment("unresolved", { sources: [], limitations: "No authorized access to the primary reference is available." }) });
  assert.equal(held.body.queued, true);
  assert.equal((await server.call("long_memory_read", { id: original.id })).body.knowledgeReview, undefined);
  const ended = (await server.call("memory_task_end", { taskId: a, completed: true })).body;
  assert.equal(ended.maintenance.flatMap((item) => item.actionResults).find((item) => item.reviewId === request.reviewId).knowledgeUpdated, false);
  const uncertain = (await server.call("long_memory_read", { id: original.id })).body;
  assert.equal(uncertain.content, original.memory.content);
  assert.equal(uncertain.knowledgeReview.status, "unresolved");
  assert.ok((await server.call("long_memory_search", { query: "Platform limit" })).body.results[0].knowledgeReview);
  const b = (await server.call("memory_task_start", {})).body.taskId;
  const context = (await server.call("vault_context", {})).body;
  assert.ok(context.memoryMaintenance.unresolvedReviews.some((item) => item.memoryId === original.id));
  const newEvidence = (await server.call("memory_reconsider", { memoryId: original.id, trigger: "external_evidence", feedback: "Authorized version-specific evidence is now available." })).body;
  assert.notEqual(newEvidence.reviewId, request.reviewId);
  const reconsidered = await server.call("memory_review_resolve", { reviewId: newEvidence.reviewId, memoryId: original.id, action: "keep", note: "The newly inspected fixture confirms the old limit under its documented version.", assessment: assessment("retain") });
  assert.equal(reconsidered.body.queued, true);
  assert.equal((await server.call("long_memory_read", { id: original.id })).body.knowledgeReview.status, "unresolved");
  await server.call("memory_task_end", { taskId: b, completed: true });
  assert.equal((await server.call("long_memory_read", { id: original.id })).body.knowledgeReview, undefined);
  assert.deepEqual((await server.call("memory_review", {})).body.unresolvedReviews, []);
});

test("new feedback invalidates a staged assessment rather than silently ignoring a counterexample", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const original = (await server.call("long_memory_write", { title: "Assessed claim", content: "Original knowledge." })).body;
  const taskId = (await server.call("memory_task_start", {})).body.taskId;
  const request = (await server.call("memory_reconsider", { memoryId: original.id, feedback: "First challenge." })).body;
  await server.call("memory_review_resolve", { reviewId: request.reviewId, memoryId: original.id, action: "keep", note: "Assessed the first challenge.", assessment: assessment("retain") });
  const second = (await server.call("memory_reconsider", { memoryId: original.id, trigger: "counterexample", feedback: "A different case contradicts that assessment." })).body;
  assert.equal(second.reviewId, request.reviewId);
  const ended = (await server.call("memory_task_end", { taskId, completed: true })).body;
  const action = ended.maintenance.flatMap((item) => item.actionResults).find((item) => item.reviewId === request.reviewId);
  assert.equal(action.applied, false);
  assert.equal(action.error, "feedback_changed");
  const review = (await server.call("memory_review", { reviewId: request.reviewId })).body.review;
  assert.equal(review.state, "ready");
  assert.equal(review.feedback.length, 2);
  assert.equal(review.resolution, null);
});

test("correction tools enforce namespaces and refuse credential-bearing feedback or evidence", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const original = (await server.call("long_memory_write", { scope: "global", role: "builder", title: "Private role", content: "Scoped fact." })).body;
  const target = { scope: "global", role: "builder", memoryId: original.id };
  assert.equal((await server.call("memory_reconsider", { memoryId: original.id, feedback: "Wrong namespace." })).body.error, "not_found");
  assert.equal((await server.call("memory_reconsider", { ...target, feedback: `token = \"${"z".repeat(32)}\"` })).body.error, "secret_detected");
  const request = (await server.call("memory_reconsider", { ...target, feedback: "Check this scoped fact." })).body;
  assert.equal((await server.call("memory_review", { reviewId: request.reviewId })).body.error, "not_found");
  const credentialUrl = assessment("retain", { sources: [{ kind: "primary", reference: "https://user:password@example.test/reference", finding: "Invalid source reference.", stance: "supports" }] });
  assert.equal((await server.call("memory_review_resolve", { ...target, reviewId: request.reviewId, action: "keep", note: "Refuse URL credentials.", assessment: credentialUrl })).body.error, "invalid_assessment");
  assert.equal((await server.call("memory_review", { scope: "global", role: "builder", reviewId: request.reviewId })).body.review.resolution, null);
});

test("a late correction blocks an older usage-based skill proposal", async (t) => {
  const { vault, repo } = await fixture(t);
  const { saveSettings } = await import("../lib/settings.mjs");
  await saveSettings(vault, { review: { thresholds: [1], hotReadCount: 1 } });
  const server = await startServer(t, vault, repo);
  const taskId = (await server.call("memory_task_start", {})).body.taskId;
  const original = (await server.call("long_memory_write", { title: "Frequently reused claim", content: "Previously assumed behavior." })).body;
  await server.call("long_memory_read", { id: original.id });
  const general = (await server.call("memory_review", {})).body.pendingReviews.find((review) => review.reason.startsWith("ops>="));
  const staged = await server.call("memory_review_resolve", { reviewId: general.id, memoryId: original.id, action: "skill", title: "Proposed procedure", content: "Procedure based on the earlier assumption.", note: "Prepared before the new counterexample." });
  assert.equal(staged.body.queued, true);
  await server.call("memory_reconsider", { memoryId: original.id, trigger: "counterexample", feedback: "A later observation challenges the assumption used by that procedure." });
  const ended = (await server.call("memory_task_end", { taskId, completed: true })).body;
  const result = ended.maintenance.flatMap((item) => item.actionResults).find((item) => item.reviewId === general.id);
  assert.equal(result.error, "reconsideration_required");
  assert.equal(result.applied, false);
  assert.equal((await server.call("long_memory_search", { query: "Proposed procedure" })).body.results.length, 0);
  assert.deepEqual((await server.call("memory_review", {})).body.skillCandidates, []);
});

test("task parent and resume relations preserve attribution through MCP", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const parent = (await server.call("memory_task_start", { taskId: "parent-task" })).body;
  const child = await server.call("memory_task_start", { taskId: "child-task", parentTaskId: parent.taskId });
  assert.equal(child.isError, false);
  assert.equal(child.body.weekKey, parent.weekKey);
  const written = await server.call("long_memory_write", { taskId: "child-task", title: "Child finding", content: "Keep the parent business week." });
  assert.equal(written.isError, false);
  const stored = (await server.call("long_memory_read", { id: written.body.id })).body;
  assert.equal(stored.taskId, "child-task");
  assert.equal(stored.weekKey, parent.weekKey);
  await server.call("memory_task_end", { taskId: "child-task", completed: false });
  const resumed = await server.call("memory_task_start", { taskId: "resumed-child", resumeTaskId: "child-task" });
  assert.equal(resumed.isError, false);
  assert.equal(resumed.body.weekKey, parent.weekKey);
  const log = await server.call("log_write", { taskId: "resumed-child", slug: "resumed-check", kind: "qa", title: "Resumed check", content: "The resumed task completed its check." });
  assert.equal(log.isError, false);
  assert.equal(log.body.projection.deferred, true);
  await server.call("memory_task_end", { taskId: "resumed-child", completed: true });
  await server.call("memory_task_end", { taskId: parent.taskId, completed: true });
  const refused = await server.call("memory_task_start", { taskId: "invalid-resume", resumeTaskId: "resumed-child" });
  assert.equal(refused.isError, true);
  const queried = await server.call("memory_query", { kind: "log", week: parent.weekKey });
  assert.deepEqual(queried.body.records.map((row) => row.id), [log.body.id]);
  assert.equal(queried.body.records[0].taskId, "resumed-child");
});

test("persona tools stage explicit decisions and only next-task context uses accepted guidance", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const taskId = (await server.call("memory_task_start", { taskId: "persona-current" })).body.taskId;
  const target = { scope: "project", project: "alpha" };
  const guidance = "Ask one focused question before choosing between conflicting requirements.";
  const observed = await server.call("persona_observe", {
    ...target, taskId, category: "question_style", pattern: "focused-question",
    guidance, sourceKind: "observation", evidence: "test-conversation:focused-question",
  });
  assert.equal(observed.isError, false);
  assert.equal(observed.body.staged, true);
  const profile = (await server.call("persona_read", target)).body;
  assert.deepEqual(profile.active, []);
  assert.equal(profile.pending[0].id, observed.body.patternId);
  const stale = await server.call("persona_resolve", { ...target, patternId: observed.body.patternId, action: "accept", expectedHash: "0".repeat(64) });
  assert.equal(stale.body.error, "hash_mismatch");
  const decision = await server.call("persona_resolve", { ...target, patternId: observed.body.patternId, action: "accept", expectedHash: profile.hash });
  assert.equal(decision.isError, false);
  assert.equal(decision.body.staged, true);
  const during = (await server.call("vault_context", { taskId })).body;
  assert.ok(during.persona.profiles.every((entry) => !entry.context.includes(guidance)));
  await server.call("memory_task_end", { taskId, completed: true });
  const nextTask = (await server.call("memory_task_start", { taskId: "persona-next" })).body.taskId;
  const next = (await server.call("vault_context", { taskId: nextTask })).body;
  const applied = next.persona.profiles.find((entry) => entry.scope === "project");
  assert.ok(applied.context.includes(guidance));
  assert.ok(applied.context.length <= 2000);
  assert.equal(applied.context.includes("test-conversation:focused-question"), false);
  assert.deepEqual((await server.call("persona_read", { scope: "global" })).body.active, []);
  await server.call("memory_task_end", { taskId: nextTask, completed: true });
});

test("memory_query bounds excerpts and pages without crossing scope or role", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const target = { project: "alpha", role: "builder" };
  const saved = [];
  for (let index = 0; index < 3; index++) {
    const result = await server.call("long_memory_write", { ...target, title: `Bounded query ${index}`, content: `mcp-query-sentinel ${index} ` + "bounded evidence ".repeat(1500) });
    assert.equal(result.isError, false);
    saved.push(result.body.id);
  }
  const shared = await server.call("long_memory_write", { scope: "global", role: "builder", title: "Shared bounded query", content: "mcp-query-sentinel global" });
  await server.call("long_memory_write", { project: "alpha", role: "reviewer", title: "Other role", content: "mcp-query-sentinel reviewer" });
  const first = await server.call("memory_query", { ...target, query: "mcp-query-sentinel", limit: 2 });
  const second = await server.call("memory_query", { ...target, query: "mcp-query-sentinel", limit: 2, offset: 2 });
  assert.equal(first.isError, false);
  assert.equal(first.body.hasMore, true);
  assert.equal(second.body.hasMore, false);
  const rows = [...first.body.records, ...second.body.records];
  assert.deepEqual(rows.map((row) => row.id).sort((a, b) => a - b), saved);
  assert.ok(rows.every((row) => row.truncated && row.content.length <= 2000 && row.ref === `memory:${row.id}`));
  assert.ok(JSON.stringify(first.body).length < 8000);
  const global = await server.call("memory_query", { scope: "global", role: "builder", query: "mcp-query-sentinel" });
  assert.deepEqual(global.body.records.map((row) => row.id), [shared.body.id]);
  assert.equal((await server.call("memory_query", { ...target, limit: 0 })).isError, true);
});
