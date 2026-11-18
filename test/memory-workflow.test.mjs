import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initVault, scaffoldProject } from "../lib/vault-core.mjs";
import { saveSettings } from "../lib/settings.mjs";
import { closeMemoryDbs } from "../lib/memory-db.mjs";
import { writeLog, writeHandoff, worktreeRecord, worktreeList } from "../lib/memory-store.mjs";
import {
  beginMemoryTask, endMemoryTask, getTieredContext, longTermWrite,
  longMemoryRead, longMemorySearch, migrateLongMemory,
  reconsiderMemory, resolveMemoryReview, sleepMemory,
} from "../lib/memory-tiers.mjs";
import { queryWeeklyMemory } from "../lib/weekly-memory.mjs";
import { observePersona, readPersona } from "../lib/persona.mjs";

const git = promisify(execFile);
const SUNDAY = new Date("2026-11-15T23:30:00Z");
const MONDAY = new Date("2026-11-16T12:30:00Z");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "vault-workflow-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "checkout");
  const vault = path.join(root, "vault");
  await mkdir(home);
  await mkdir(cwd);
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(cwd);
  t.after(async () => {
    closeMemoryDbs();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  await initVault(vault);
  await scaffoldProject(vault, "alpha", "Alpha");
  await saveSettings(vault, { weekly: { timeZone: "UTC", workdayStart: "09:00" } });
  await writeFile(path.join(vault, "_meta/projects-index.md"), "| [Alpha](../projects/alpha/index.md) | checkout | app | no remote | Node |\n");
  return { vault, cwd };
}

test("Sunday task carries its week into Monday without changing the event date", async (t) => {
  const { vault, cwd } = await fixture(t);
  await git("git", ["init", "-q", "-b", "feature/carried-week", cwd]);
  const started = await beginMemoryTask(vault, { taskId: "sunday-task" }, { now: SUNDAY });
  assert.equal(started.weekKey, "2026-46");
  await git("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"]);
  const task = { project: "alpha", taskId: started.taskId };
  const knowledge = await longTermWrite(vault, { ...task, title: "Parser choice", content: "Use the streaming parser." }, { now: MONDAY });
  const log = await writeLog(vault, { ...task, slug: "parser-check", kind: "qa", title: "Parser check", content: "Targeted parser check passed." }, { now: MONDAY });
  const handoff = await writeHandoff(vault, { ...task, slug: "parser-review", from: "builder", to: "reviewer", title: "Review parser", content: "Inspect the streaming path." }, { now: MONDAY });
  const record = await worktreeRecord(vault, { ...task, cwd, kind: "investigation", slug: "parser", title: "Parser investigation", content: "Compared parser allocation paths." }, { now: MONDAY });
  for (const result of [knowledge, log, handoff, record]) {
    assert.equal(result.ref, `memory:${result.id}`);
    assert.equal(result.projection.deferred, true);
    const stored = await longMemoryRead(vault, { project: "alpha", id: result.id }, { now: MONDAY });
    assert.equal(stored.weekKey, "2026-46");
    assert.equal(stored.eventDate, "2026-11-16");
    assert.equal(stored.taskId, started.taskId);
  }
  const query = await queryWeeklyMemory(vault, { project: "alpha", week: "2026-46", from: "2026-11-16", to: "2026-11-16" });
  assert.deepEqual(query.records.map((row) => row.id).sort((a, b) => a - b), [knowledge.id, log.id, handoff.id, record.id].sort((a, b) => a - b));
  assert.deepEqual((await longMemorySearch(vault, { project: "alpha" })).results.map((row) => row.id), [knowledge.id]);
  assert.deepEqual((await worktreeList(vault, { cwd })).worktrees.map((row) => [row.key, row.records]), [["feature-carried-week", 1]]);
  const pendingContext = await getTieredContext(vault, { cwd, taskId: started.taskId }, { now: MONDAY });
  assert.deepEqual(pendingContext.recentLogs, [log.ref]);
  assert.deepEqual(pendingContext.worktree.records, [record.ref]);
  assert.ok(pendingContext.longTermRecent.every((row) => row.kind === "knowledge"));
  const exported = path.join(vault, "projects/alpha/weekly/2026-46.md");
  await assert.rejects(readFile(exported), { code: "ENOENT" });
  const ended = await endMemoryTask(vault, { taskId: started.taskId, completed: true }, { now: MONDAY });
  assert.equal(ended.weekly.deferred, false);
  const markdown = await readFile(exported, "utf8");
  assert.match(markdown, /2026-11-16.*Monday/);
  for (const result of [knowledge, log, handoff, record]) assert.ok(markdown.includes(result.ref));
  assert.match(markdown, /Targeted parser check passed\./);
  const next = await beginMemoryTask(vault, { taskId: "fresh-monday-task" }, { now: MONDAY });
  assert.equal(next.weekKey, "2026-47");
  const fresh = await longTermWrite(vault, { project: "alpha", taskId: next.taskId, title: "Monday choice", content: "New task uses the new week." }, { now: MONDAY });
  assert.equal((await longMemoryRead(vault, { project: "alpha", id: fresh.id })).weekKey, "2026-47");
  await endMemoryTask(vault, { taskId: next.taskId, completed: true }, { now: MONDAY });
});

test("persona stays unchanged during the current task and guides the next context", async (t) => {
  const { vault, cwd } = await fixture(t);
  const started = await beginMemoryTask(vault, { taskId: "style-request" }, { now: SUNDAY });
  const guidance = "Ask one focused question when requirements conflict.";
  const observed = await observePersona(vault, {
    scope: "project", project: "alpha", taskId: started.taskId,
    category: "question_style", pattern: "focused-questions", guidance,
    sourceKind: "user_preference", evidence: "user-message:style-request",
  }, { now: SUNDAY });
  assert.equal(observed.staged, true);
  const during = await getTieredContext(vault, { cwd, taskId: started.taskId }, { now: SUNDAY });
  assert.ok(during.persona.profiles.every((profile) => !profile.context.includes(guidance)));
  assert.deepEqual((await readPersona(vault, { scope: "project", project: "alpha" })).active, []);
  const ended = await endMemoryTask(vault, { taskId: started.taskId, completed: true }, { now: MONDAY });
  assert.equal(ended.persona.applied, true);
  await beginMemoryTask(vault, { taskId: "next-style-task" }, { now: MONDAY });
  const next = await getTieredContext(vault, { cwd, taskId: "next-style-task" }, { now: MONDAY });
  const projectProfile = next.persona.profiles.find((profile) => profile.scope === "project");
  assert.ok(projectProfile.context.includes(guidance));
  assert.equal(projectProfile.context.includes("user-message:style-request"), false);
  assert.ok(projectProfile.context.length <= 2000);
  assert.deepEqual((await readPersona(vault, { scope: "global" })).active, []);
  await endMemoryTask(vault, { taskId: "next-style-task", completed: true }, { now: MONDAY });
});

test("legacy pruning waits for idle and preserves changed, oversized and undated sources", async (t) => {
  const { vault } = await fixture(t);
  const sources = [
    ["projects/alpha/long-term/2026-11-01-choice.md", "# Choice\n\nExact knowledge bytes.\n"],
    ["projects/alpha/logs/2026-11-01-qa-check.md", "# QA\n\nExact log bytes.\n"],
    ["projects/alpha/worktrees/main/2026-11-01-investigation-check.md", "# Check\n\nExact worktree bytes.\n"],
    ["projects/alpha/agents/handoffs/2026-11-01-task-review.md", "# Review\n\nExact handoff bytes.\n"],
    ["projects/alpha/long-term/manual.md", "# Manual\n\nKeep this undated original.\n"],
    ["projects/alpha/logs/2026-11-01-work-large.md", "# Oversized\n\n" + "x".repeat(100_100)],
  ];
  for (const [rel, content] of sources) {
    await mkdir(path.dirname(path.join(vault, rel)), { recursive: true });
    await writeFile(path.join(vault, rel), content);
  }
  await assert.rejects(migrateLongMemory(vault, { project: "alpha", pruneLegacy: "false" }, { now: MONDAY }), { code: "invalid_prune" });
  for (const [rel, content] of sources) assert.equal(await readFile(path.join(vault, rel), "utf8"), content);
  await beginMemoryTask(vault, { taskId: "import-barrier" }, { now: MONDAY });
  const busy = await migrateLongMemory(vault, { project: "alpha", pruneLegacy: true }, { now: MONDAY });
  assert.equal(busy.deferred, true);
  assert.deepEqual(busy.imported, []);
  for (const [rel, content] of sources) assert.equal(await readFile(path.join(vault, rel), "utf8"), content);
  await endMemoryTask(vault, { taskId: "import-barrier", completed: false }, { now: MONDAY });
  const imported = await migrateLongMemory(vault, { project: "alpha" }, { now: MONDAY });
  assert.equal(imported.imported.length, 5);
  for (const entry of imported.imported) {
    const original = sources.find(([rel]) => rel === entry.path)[1];
    assert.equal((await longMemoryRead(vault, { project: "alpha", id: entry.id })).content, original);
    assert.equal(await readFile(path.join(vault, entry.path), "utf8"), original);
  }
  const [changed] = sources[0];
  await writeFile(path.join(vault, changed), "# Choice\n\nLater human edit must survive.\n");
  const pruned = await migrateLongMemory(vault, { project: "alpha", pruneLegacy: true }, { now: MONDAY });
  assert.deepEqual(pruned.pruned.sort(), sources.slice(1, 4).map(([rel]) => rel).sort());
  assert.ok(pruned.conflicts.some((item) => item.path === changed && item.reason === "source_changed"));
  assert.ok(pruned.conflicts.some((item) => item.path === sources[5][0] && item.reason === "source_exceeds_import_limit"));
  assert.match(await readFile(path.join(vault, changed), "utf8"), /Later human edit must survive/);
  for (const [rel] of sources.slice(1, 4)) await assert.rejects(readFile(path.join(vault, rel)), { code: "ENOENT" });
  for (const [rel, content] of sources.slice(4)) assert.equal(await readFile(path.join(vault, rel), "utf8"), content);
  const all = await queryWeeklyMemory(vault, { project: "alpha", from: "2026-11-01", to: "2026-11-01" });
  assert.equal(all.records.length, 4);
  assert.deepEqual(new Set(all.records.map((row) => row.kind)), new Set(["knowledge", "log", "worktree", "handoff"]));
  assert.ok((await longMemorySearch(vault, { project: "alpha" })).results.every((row) => row.kind === "knowledge"));
});

test("memory history combines date and keyword filters with bounded, isolated pages", async (t) => {
  const { vault } = await fixture(t);
  const content = "pagination-sentinel " + "large retained evidence ".repeat(700);
  for (let index = 0; index < 3; index++) {
    await longTermWrite(vault, { project: "alpha", role: "builder", title: `Paged evidence ${index}`, content: `${content}${index}` }, { now: MONDAY });
  }
  await longTermWrite(vault, { scope: "global", role: "builder", title: "Global private evidence", content }, { now: MONDAY });
  await longTermWrite(vault, { project: "alpha", role: "reviewer", title: "Reviewer private evidence", content }, { now: MONDAY });
  await longTermWrite(vault, { project: "alpha", role: "builder", title: "Prior day", content }, { now: SUNDAY });
  const filters = { project: "alpha", role: "builder", query: "pagination-sentinel", from: "2026-11-16", to: "2026-11-16", week: "2026-47", limit: 2 };
  const first = await queryWeeklyMemory(vault, filters);
  const second = await queryWeeklyMemory(vault, { ...filters, offset: 2 });
  assert.equal(first.records.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(second.records.length, 1);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.records, ...second.records].map((row) => row.id)).size, 3);
  for (const row of [...first.records, ...second.records]) {
    assert.equal(row.project, "alpha");
    assert.equal(row.role, "builder");
    assert.equal(row.eventDate, "2026-11-16");
    assert.ok(row.content.length <= 2000);
    assert.equal(row.truncated, true);
    assert.ok(row.totalChars > row.content.length);
    assert.equal(row.ref, `memory:${row.id}`);
    const full = await longMemoryRead(vault, { project: "alpha", role: "builder", id: row.id });
    assert.equal(full.content.length, row.totalChars);
  }
  assert.ok(JSON.stringify(first).length < 8000);
  for (const invalid of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { from: "2026-02-30" }, { from: "2026-11-17", to: "2026-11-16" }, { week: "2026-99" }]) {
    await assert.rejects(queryWeeklyMemory(vault, { project: "alpha", ...invalid }));
  }
});

test("history queries retain unresolved warnings in shared and role namespaces until assessed resolution", async (t) => {
  const { vault } = await fixture(t);
  const challenged = [];
  for (const role of [undefined, "builder"]) {
    const target = { project: "alpha", role };
    const memory = await longTermWrite(vault, { ...target, title: "Disputed fixture", content: "boundary-review claim needs independent evidence." }, { now: MONDAY });
    const feedback = await reconsiderMemory(vault, { ...target, memoryId: memory.id, feedback: "This fixture claim is disputed." }, { now: MONDAY });
    await sleepMemory(vault, target, { now: MONDAY });
    await resolveMemoryReview(vault, {
      ...target, reviewId: feedback.reviewId, memoryId: memory.id, action: "defer", note: "No independent fixture evidence.",
      assessment: { decision: "unresolved", comparison: "Neither claim is established.", applicability: "Fixture only.", limitations: "No supporting source.", sources: [] },
    }, { now: MONDAY });
    challenged.push({ target, memory });
  }
  const untouched = await longTermWrite(vault, { project: "alpha", role: "reviewer", title: "Separate fixture", content: "boundary-review separate namespace." }, { now: MONDAY });
  const page = await queryWeeklyMemory(vault, { project: "alpha", query: "boundary-review" }, { now: MONDAY });
  for (const { target, memory } of challenged) {
    const row = page.records.find((entry) => entry.id === memory.id);
    const direct = await longMemoryRead(vault, { ...target, id: memory.id }, { now: MONDAY });
    assert.equal(row.knowledgeReview.status, "unresolved");
    assert.deepEqual(row.knowledgeReview, direct.knowledgeReview);
  }
  assert.equal(page.records.find((entry) => entry.id === untouched.id).knowledgeReview, undefined);
  const builder = challenged[1];
  const rolePage = await queryWeeklyMemory(vault, { project: "alpha", role: "builder", limit: 1 }, { now: MONDAY });
  assert.equal(rolePage.records[0].id, builder.memory.id);
  assert.equal(rolePage.records[0].knowledgeReview.status, "unresolved");
  const retry = await reconsiderMemory(vault, { ...builder.target, memoryId: builder.memory.id, feedback: "New fixture source available.", trigger: "external_evidence" }, { now: MONDAY });
  await sleepMemory(vault, builder.target, { now: MONDAY });
  await resolveMemoryReview(vault, {
    ...builder.target, reviewId: retry.reviewId, memoryId: builder.memory.id, action: "keep", note: "Retain within fixture scope.",
    assessment: { decision: "retain", comparison: "New fixture evidence supports the bounded claim.", applicability: "Fixture only.", limitations: "Not a real-world finding.", sources: [{ kind: "project", reference: "fixture:review-source", finding: "Synthetic fixture support.", stance: "supports" }] },
  }, { now: MONDAY });
  const resolved = await queryWeeklyMemory(vault, { project: "alpha", query: "boundary-review" }, { now: MONDAY });
  assert.equal(resolved.records.find((entry) => entry.id === builder.memory.id).knowledgeReview, undefined);
  assert.equal(resolved.records.find((entry) => entry.id === challenged[0].memory.id).knowledgeReview.status, "unresolved");
});
