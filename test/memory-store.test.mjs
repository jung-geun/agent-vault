import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initVault, scaffoldProject } from "../lib/vault-core.mjs";
import {
  appendAgentMemory,
  createProject,
  getContext,
  listProjects,
  readMemory,
  resolveProject,
  searchMemory,
  writeHandoff,
  writeMemory,
} from "../lib/memory-store.mjs";

const NOW = new Date("2026-11-10T00:00:00Z");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-store-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  await initVault(vault);
  await scaffoldProject(vault, "alpha", "Alpha");
  await writeFile(
    path.join(vault, "_meta", "projects-index.md"),
    [
      "# Registry",
      "| Project | Source directory | Classification | Git identity | Stack |",
      "|---|---|---|---|---|",
      "| [Alpha](../projects/alpha/index.md) | alpha-repo | app | remote `origin` branch `main` | Node |",
      "",
    ].join("\n"),
  );
  return { root, vault };
}

test("reads and writes stay inside the vault and reject escapes", async (t) => {
  const { vault } = await fixture(t);
  await assert.rejects(readMemory(vault, { path: "../outside.md" }), { code: "path_escape" });
  await assert.rejects(readMemory(vault, { path: "/etc/passwd" }), { code: "invalid_path" });
  await assert.rejects(writeMemory(vault, { path: "projects/../../escape.md", content: "x", mode: "create" }), { code: "path_escape" });
  await assert.rejects(writeMemory(vault, { path: "_meta/SCHEMA.md", content: "x", mode: "replace", expectedHash: "0" }), { code: "path_not_writable" });
});

test("symlinks that point outside the vault are refused for reads and writes", async (t) => {
  const { root, vault } = await fixture(t);
  const outside = path.join(root, "outside.md");
  await writeFile(outside, "outside note\n");
  await mkdir(path.join(vault, "shared", "knowledge"), { recursive: true });
  await symlink(outside, path.join(vault, "shared", "knowledge", "link.md"));
  await assert.rejects(readMemory(vault, { path: "shared/knowledge/link.md" }), { code: "path_escape" });
  await assert.rejects(writeMemory(vault, { path: "shared/knowledge/link.md", content: "x", mode: "append" }), { code: "path_escape" });
  assert.equal(await readFile(outside, "utf8"), "outside note\n");
});

test("credentials are refused before anything is written", async (t) => {
  const { vault } = await fixture(t);
  const key = "sk-" + "a".repeat(30);
  await assert.rejects(
    writeMemory(vault, { path: "shared/knowledge/notes.md", content: `token ${key}`, mode: "create" }),
    { code: "secret_detected" },
  );
  await assert.rejects(readMemory(vault, { path: "shared/knowledge/notes.md" }), { code: "not_found" });
});

test("replace requires the hash that was read, and rejects stale writers", async (t) => {
  const { vault } = await fixture(t);
  const created = await writeMemory(vault, { path: "shared/knowledge/topic.md", content: "# Topic\n\nfirst\n", mode: "create", title: "Topic" }, { now: NOW });
  const read = await readMemory(vault, { path: "shared/knowledge/topic.md" });
  assert.equal(read.sha256, created.sha256);

  await writeMemory(vault, { path: "shared/knowledge/topic.md", content: "# Topic\n\nsecond\n", mode: "replace", expectedHash: read.sha256 }, { now: NOW });
  await assert.rejects(
    writeMemory(vault, { path: "shared/knowledge/topic.md", content: "# Topic\n\nthird\n", mode: "replace", expectedHash: read.sha256 }),
    { code: "hash_mismatch" },
  );
  await assert.rejects(writeMemory(vault, { path: "shared/knowledge/topic.md", content: "x", mode: "replace" }), { code: "hash_required" });
});

test("frontmatter is generated for new notes and updated on append", async (t) => {
  const { vault } = await fixture(t);
  await writeMemory(vault, { path: "shared/knowledge/tips.md", content: "Use fixtures.", mode: "append", title: "Tips", summary: "Test tips", tags: ["testing"] }, { now: NOW });
  let note = await readMemory(vault, { path: "shared/knowledge/tips.md" });
  assert.equal(note.frontmatter.title, "Tips");
  assert.equal(note.frontmatter.created, "2026-11-10");
  assert.match(note.content, /Use fixtures\./);

  await writeMemory(vault, { path: "shared/knowledge/tips.md", content: "Second line.", mode: "append" }, { now: new Date("2026-11-11T00:00:00Z") });
  note = await readMemory(vault, { path: "shared/knowledge/tips.md" });
  assert.equal(note.frontmatter.updated, "2026-11-11");
  assert.equal(note.frontmatter.created, "2026-11-10");
  assert.match(note.content, /Use fixtures\.[\s\S]*Second line\./);
});

test("history is append-only: logs cannot be replaced and handoffs cannot be appended", async (t) => {
  const { vault } = await fixture(t);
  await writeMemory(vault, { path: "projects/alpha/logs/2026-11-10-qa-run.md", content: "# Run\n", mode: "create" }, { now: NOW });
  const read = await readMemory(vault, { path: "projects/alpha/logs/2026-11-10-qa-run.md" });
  await assert.rejects(
    writeMemory(vault, { path: "projects/alpha/logs/2026-11-10-qa-run.md", content: "# Rewritten\n", mode: "replace", expectedHash: read.sha256 }),
    { code: "append_only" },
  );
  await assert.rejects(
    writeMemory(vault, { path: "projects/alpha/agents/handoffs/2026-11-10-task-x.md", content: "more", mode: "append" }),
    { code: "append_only" },
  );
});

test("project-scoped writes require a registered project and a valid role", async (t) => {
  const { vault } = await fixture(t);
  await assert.rejects(writeMemory(vault, { path: "projects/ghost/index.md", content: "x", mode: "append" }), { code: "project_not_found" });
  await assert.rejects(appendAgentMemory(vault, { project: "alpha", role: "janitor", title: "t", content: "c" }), { code: "invalid_role" });
  const result = await appendAgentMemory(vault, { project: "alpha", role: "builder", title: "Build invariant", content: "Run npm test first." }, { now: NOW });
  assert.equal(result.path, "projects/alpha/agents/builder/memory.md");
  const memory = await readMemory(vault, { path: "projects/alpha/agents/builder/memory.md" });
  assert.match(memory.content, /## 2026-11-10 — Build invariant/);
});

test("handoff files are created once with a deterministic name", async (t) => {
  const { vault } = await fixture(t);
  const handoff = await writeHandoff(vault, { project: "alpha", slug: "refactor-api", from: "builder", to: "reviewer", title: "Review API", content: "Please review." }, { now: NOW });
  assert.equal(handoff.path, "projects/alpha/agents/handoffs/2026-11-10-task-refactor-api.md");
  await assert.rejects(
    writeHandoff(vault, { project: "alpha", slug: "refactor-api", from: "builder", to: "reviewer", title: "Again", content: "x" }, { now: NOW }),
    { code: "exists" },
  );
});

test("search ranks title and path matches and respects scope", async (t) => {
  const { vault } = await fixture(t);
  await writeMemory(vault, { path: "shared/knowledge/redis.md", content: "Redis streams notes.\nRedis again.", mode: "create", title: "Redis Streams" }, { now: NOW });
  await writeMemory(vault, { path: "shared/knowledge/misc.md", content: "Mentions redis once.", mode: "create", title: "Misc" }, { now: NOW });
  await writeMemory(vault, { path: "projects/alpha/wiki/concepts/queue.md", content: "Queue design uses streams.", mode: "create", title: "Queue" }, { now: NOW });

  const hits = await searchMemory(vault, { query: "redis", scope: "shared" });
  assert.deepEqual(hits.results.map((r) => r.path), ["shared/knowledge/redis.md", "shared/knowledge/misc.md"]);
  assert.equal(hits.results[0].title, "Redis Streams");

  const none = await searchMemory(vault, { query: "redis streams", scope: "project", project: "alpha" });
  assert.equal(none.totalMatches, 0);
  await assert.rejects(searchMemory(vault, { query: "   " }), { code: "invalid_query" });
});

test("project resolution is explicit about ambiguity and never guesses", async (t) => {
  const { root, vault } = await fixture(t);
  const repo = path.join(root, "alpha-repo");
  await mkdir(repo);
  const resolved = await resolveProject(vault, { cwd: repo });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.projectId, "alpha");

  const stranger = path.join(root, "stranger");
  await mkdir(stranger);
  const unregistered = await resolveProject(vault, { cwd: stranger });
  assert.equal(unregistered.status, "unregistered");
  assert.equal(unregistered.projectId, undefined);

  await writeFile(
    path.join(vault, "_meta", "projects-index.md"),
    "| [A](../projects/alpha/index.md) | alpha-repo | app | remote `origin` branch `main` | Node |\n| [B](../projects/beta/index.md) | alpha-repo | app | remote `origin` branch `dev` | Node |\n",
  );
  const ambiguous = await resolveProject(vault, { cwd: "/nonexistent/alpha-repo" });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.candidates.length, 2);
});

test("createProject scaffolds once and registers the source directory exactly once", async (t) => {
  const { root, vault } = await fixture(t);
  const repo = path.join(root, "gamma-repo");
  await mkdir(repo);
  const first = await createProject(vault, { project: "gamma", title: "Gamma", sourceDir: "gamma-repo", classification: "app", git: "no remote", stack: "Node" }, { now: NOW });
  assert.equal(first.created, true);
  assert.equal(first.registered, true);
  const second = await createProject(vault, { project: "gamma", title: "Gamma", sourceDir: "gamma-repo" }, { now: NOW });
  assert.equal(second.created, false);
  assert.equal(second.registered, false);
  const index = await readFile(path.join(vault, "_meta", "projects-index.md"), "utf8");
  assert.equal(index.match(/gamma-repo/g).length, 1);
  await assert.rejects(createProject(vault, { project: "delta", sourceDir: "gamma-repo" }), { code: "source_dir_conflict" });
  await assert.rejects(createProject(vault, { project: "../bad" }), { code: "invalid_project" });

  const listed = await listProjects(vault);
  assert.ok(listed.projects.some((p) => p.id === "gamma" && p.registered));
});

test("context returns profile, project index, role memory and recent logs without writing", async (t) => {
  const { root, vault } = await fixture(t);
  const repo = path.join(root, "alpha-repo");
  await mkdir(repo);
  await writeMemory(vault, { path: "projects/alpha/logs/2026-11-09-qa-check.md", content: "# QA\n", mode: "create" }, { now: NOW });
  const context = await getContext(vault, { cwd: repo, role: "builder" });
  assert.equal(context.vaultReady, true);
  assert.equal(context.project.projectId, "alpha");
  assert.match(context.user.profile.content, /User Profile/);
  assert.match(context.projectIndex.content, /Alpha/);
  assert.equal(context.roleMemory.path, "projects/alpha/agents/builder/memory.md");
  assert.deepEqual(context.recentLogs, ["projects/alpha/logs/2026-11-09-qa-check.md"]);
});

test("missing vault is reported as a state, not a crash, in context", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = await getContext(path.join(root, "absent"), { cwd: root });
  assert.equal(context.vaultReady, false);
  assert.match(context.hint, /init/);
});

test("registering a project creates the registry when the vault has none", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  await initVault(vault);
  const repo = path.join(root, "beta-repo");
  await mkdir(repo);

  const created = await createProject(vault, { project: "beta", title: "Beta", sourceDir: "beta-repo", classification: "app" }, { now: NOW });
  assert.equal(created.registered, true);
  const index = await readFile(path.join(vault, "_meta", "projects-index.md"), "utf8");
  assert.match(index, /\| \[Beta\]\(\.\.\/projects\/beta\/index\.md\) \| beta-repo \| app \|/);
  assert.equal((await resolveProject(vault, { cwd: repo })).projectId, "beta");
});
