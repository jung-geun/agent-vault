import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initVault, scaffoldProject } from "../lib/vault-core.mjs";

const serverPath = fileURLToPath(new URL("../bin/vault-mcp.mjs", import.meta.url));

async function startServer(t, vault, cwd) {
  const child = spawn(process.execPath, [serverPath, "--path", vault], { cwd, stdio: ["pipe", "pipe", "pipe"] });
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
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  await initVault(vault);
  await scaffoldProject(vault, "alpha", "Alpha");
  const repo = path.join(root, "alpha-repo");
  await mkdir(repo);
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
  for (const required of ["vault_context", "memory_search", "memory_read", "memory_list", "memory_write", "project_resolve", "project_list", "project_scaffold", "agent_memory_read", "agent_memory_write", "agent_handoff", "log_write"]) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }
  for (const tool of reply.result.tools) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object schema`);
  }
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

test("project-aware context resolves from cwd without the caller naming a project", async (t) => {
  const { vault, repo } = await fixture(t);
  const server = await startServer(t, vault, repo);
  const context = await server.call("vault_context", { role: "builder" });
  assert.equal(context.body.project.status, "resolved");
  assert.equal(context.body.project.projectId, "alpha");
  assert.equal(context.body.roleMemory.path, "projects/alpha/agents/builder/memory.md");
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
  assert.equal(agentWrite.body.path, "projects/beta/agents/builder/memory.md");

  const agentRead = await server.call("agent_memory_read", { project: "beta", role: "builder" });
  assert.match(agentRead.body.content, /Run check before test\./);

  const handoff = await server.call("agent_handoff", { project: "beta", slug: "review-build", from: "builder", to: "reviewer", title: "Review build", content: "Check the order note." });
  assert.equal(handoff.isError, false);
  assert.match(handoff.body.path, /^projects\/beta\/agents\/handoffs\/\d{4}-\d{2}-\d{2}-task-review-build\.md$/);

  const log = await server.call("log_write", { project: "beta", kind: "qa", slug: "smoke", title: "Smoke", content: "Ran npm test: pass." });
  assert.equal(log.isError, false);
  assert.match(log.body.path, /^projects\/beta\/logs\/\d{4}-\d{2}-\d{2}-qa-smoke\.md$/);

  const listed = await server.call("memory_list", { scope: "project", project: "beta" });
  const paths = listed.body.notes.map((n) => n.path);
  assert.ok(paths.includes("projects/beta/agents/builder/memory.md"));
  assert.ok(paths.includes(log.body.path));

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
  assert.match(longTerm.body.path, /^projects\/alpha\/long-term\/\d{4}-\d{2}-\d{2}-tiers\.md$/);

  const record = await server.call("worktree_record", { kind: "instruction", slug: "tiers", title: "Tiers request", content: "User asked for tiers." });
  assert.equal(record.isError, false);
  assert.match(record.body.path, /^projects\/alpha\/worktrees\/feature-tiers\/\d{4}-\d{2}-\d{2}-instruction-tiers\.md$/);

  const worktrees = await server.call("worktree_list", {});
  assert.deepEqual(worktrees.body.worktrees.map((w) => [w.key, w.records]), [["feature-tiers", 1]]);

  const context = await server.call("vault_context", {});
  assert.match(context.body.shortTermMemory.content, /wire the tiers/);
  assert.equal(context.body.worktree.key, "feature-tiers");
});
