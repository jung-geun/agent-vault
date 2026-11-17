import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initVault, scaffoldProject } from "../lib/vault-core.mjs";
import { closeMemoryDbs } from "../lib/memory-db.mjs";
import { saveSettings } from "../lib/settings.mjs";
import {
  shortMemoryWrite, shortMemoryRead, longTermWrite, longMemoryRead, longMemorySearch,
  reviewMemory, resolveMemoryReview, sleepMemory, migrateLongMemory, recordToolUse,
  beginMemoryTask, endMemoryTask, getTieredContext,
} from "../lib/memory-tiers.mjs";

const NOW = new Date("2026-11-17T12:30:00Z");
const OLD = new Date("2026-10-01T12:30:00Z");
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "vault-tiers-"));
  t.after(async () => { closeMemoryDbs(); await rm(root, { recursive: true, force: true }); });
  const vault = path.join(root, "vault");
  await initVault(vault);
  await scaffoldProject(vault, "alpha", "Alpha");
  return vault;
}

test("stale short-term reviews bind to a revision, preserve timestamps and promote evidence", async (t) => {
  const vault = await fixture(t);
  const target = { project: "alpha" };
  await shortMemoryWrite(vault, { ...target, content: "Parser two supports the current wire format." }, { now: OLD });
  const original = await shortMemoryRead(vault, target, { now: NOW });
  assert.equal(original.writtenAt, OLD.toISOString());
  assert.equal(original.stale, true);
  const report = await sleepMemory(vault, target, { now: NOW });
  assert.equal(report.shortTerm.needsReview, true);
  const reviewId = report.reviews[0].id;
  await assert.rejects(resolveMemoryReview(vault, { ...target, reviewId, action: "keep", note: "Checked." }, { now: NOW }), { code: "hash_required" });
  await assert.rejects(resolveMemoryReview(vault, { ...target, reviewId, action: "promote", title: "Parser compatibility", content: "Parser two supports the wire format.", expectedHash: "0".repeat(64), note: "Current source confirms compatibility." }, { now: NOW }), { code: "hash_mismatch" });
  const result = await resolveMemoryReview(vault, { ...target, reviewId, action: "promote", title: "Parser compatibility", content: "Parser two supports the wire format.", expectedHash: original.sha256, note: "Current source confirms compatibility." }, { now: NOW });
  const durable = await longMemoryRead(vault, { ...target, id: result.memoryId });
  assert.match(durable.content, /Parser two/);
  assert.ok(durable.content.includes(original.sha256));
  assert.equal((await shortMemoryRead(vault, target, { now: NOW })).sha256, original.sha256);
  assert.equal((await reviewMemory(vault, target, { now: NOW })).shortTerm.needsReview, false);
  await shortMemoryWrite(vault, { ...target, content: "Different stale work.", expectedHash: original.sha256 }, { now: OLD });
  assert.equal((await reviewMemory(vault, target, { now: NOW })).shortTerm.needsReview, true);
});

test("staleness uses write time rather than read time", async (t) => {
  const vault = await fixture(t);
  const target = { scope: "global", role: "reviewer" };
  await saveSettings(vault, { review: { staleShortTermDays: 2 } });
  await shortMemoryWrite(vault, { ...target, content: "Review the persistence boundary." }, { now: NOW });
  const before = new Date(NOW.getTime() + 2 * 86400000 - 1);
  const boundary = new Date(NOW.getTime() + 2 * 86400000);
  assert.equal((await shortMemoryRead(vault, target, { now: before })).stale, false);
  const stale = await shortMemoryRead(vault, target, { now: boundary });
  assert.equal(stale.stale, true);
  assert.equal(stale.writtenAt, NOW.toISOString());
});

test("legacy import preserves source bytes and reports source conflicts", async (t) => {
  const vault = await fixture(t);
  const rel = "projects/alpha/long-term/2026-10-01-choice.md";
  await mkdir(path.dirname(path.join(vault, rel)), { recursive: true });
  const content = "# Parser choice\n\nUse parser two.\n";
  await writeFile(path.join(vault, rel), content);
  const first = await migrateLongMemory(vault, { project: "alpha" }, { now: NOW });
  assert.equal(first.imported.length, 1);
  assert.equal(await readFile(path.join(vault, rel), "utf8"), content);
  const repeated = await migrateLongMemory(vault, { project: "alpha" }, { now: NOW });
  assert.deepEqual(repeated.imported, []);
  assert.deepEqual(repeated.skipped, [rel]);
  await writeFile(path.join(vault, rel), "# Parser choice\n\nConflicting later edit.\n");
  const conflict = await migrateLongMemory(vault, { project: "alpha" }, { now: NOW });
  assert.deepEqual(conflict.conflicts, [{ path: rel, reason: "source_changed" }]);
  assert.equal((await longMemoryRead(vault, { project: "alpha", id: first.imported[0].id })).content, content);
});

test("sleep consolidates exact imported duplicates without losing originals", async (t) => {
  const vault = await fixture(t);
  const target = { project: "alpha" };
  const entry = { ...target, title: "Retry invariant", content: "Use jitter.", tags: ["imported"] };
  const one = await longTermWrite(vault, entry, { now: OLD, sourcePath: "source-one" });
  const two = await longTermWrite(vault, entry, { now: NOW, sourcePath: "source-two" });
  assert.notEqual(one.id, two.id);
  await saveSettings(vault, { review: { thresholds: [1] } });
  await recordToolUse(vault, "long_memory_write", target, two, { now: NOW });
  const report = await sleepMemory(vault, target, { now: NOW });
  assert.deepEqual(report.archived, [two.id]);
  assert.deepEqual((await longMemorySearch(vault, target)).results.map((row) => row.id), [one.id]);
  assert.equal((await longMemoryRead(vault, { ...target, id: two.id })).content, "Use jitter.");
  assert.deepEqual((await sleepMemory(vault, target, { now: NOW })).archived, []);
});

test("skill review stores reusable procedure with provenance, never executes content", async (t) => {
  const vault = await fixture(t);
  const target = { scope: "global", role: "builder" };
  await saveSettings(vault, { review: { thresholds: [2], hotReadCount: 1 } });
  const saved = await longTermWrite(vault, { ...target, title: "Build lesson", content: "Run a targeted compiler check before packaging." });
  await recordToolUse(vault, "long_memory_write", target, saved);
  const read = await longMemoryRead(vault, { ...target, id: saved.id });
  const [ticket] = await recordToolUse(vault, "long_memory_read", target, read);
  const report = await sleepMemory(vault, target);
  assert.ok(report.skillCandidates.some((item) => item.id === saved.id));
  const skill = await resolveMemoryReview(vault, { ...target, reviewId: ticket.id, memoryId: saved.id, action: "skill", title: "Build validation procedure", content: "When packaging changes, run the targeted compiler check, inspect errors, then package only after success.", note: "Repeated successful checks support this procedure." });
  assert.ok(skill.memory.tags.includes("skill"));
  assert.ok(skill.memory.tags.includes(`source:${saved.id}`));
  assert.equal((await longMemoryRead(vault, { ...target, id: saved.id })).status, "active");
  await assert.rejects(resolveMemoryReview(vault, { scope: "global", role: "reviewer", reviewId: ticket.id, action: "keep", note: "Wrong role." }), { code: "not_found" });
});

test("failed review actions leave the ticket and memory unchanged", async (t) => {
  const vault = await fixture(t);
  await saveSettings(vault, { review: { thresholds: [1] } });
  const target = { project: "alpha" };
  const saved = await longTermWrite(vault, { ...target, title: "Fact", content: "Retain this fact." });
  const [ticket] = await recordToolUse(vault, "long_memory_write", target, saved);
  await sleepMemory(vault, target);
  await assert.rejects(resolveMemoryReview(vault, { ...target, reviewId: ticket.id, action: "supersede", memoryId: 999999, title: "Wrong source", content: "Do not create this.", note: "Source does not exist." }), { code: "not_found" });
  assert.equal((await longMemoryRead(vault, { ...target, id: saved.id })).status, "active");
  assert.equal((await reviewMemory(vault, target)).reviews[0].id, ticket.id);
  assert.equal((await longMemorySearch(vault, { ...target, query: "Wrong source" })).results.length, 0);
});

test("overlapping tasks and cancellation defer all automatic memory changes", async (t) => {
  const vault = await fixture(t);
  const target = { scope: "global", role: "builder" };
  await saveSettings(vault, { review: { thresholds: [1] } });
  const firstTask = await beginMemoryTask(vault, { taskId: "task-a" });
  await beginMemoryTask(vault, { taskId: "task-b" });
  const entry = { ...target, title: "Shared invariant", content: "Keep these bytes until idle." };
  const one = await longTermWrite(vault, entry, { sourcePath: "one" });
  const two = await longTermWrite(vault, entry, { sourcePath: "two" });
  await recordToolUse(vault, "long_memory_write", target, two);
  const midTask = await getTieredContext(vault, { project: "alpha", role: "builder" });
  assert.equal(midTask.memoryMaintenance.contextRevision, firstTask.contextRevision);
  assert.ok(midTask.memoryReviews.every((review) => review.reviews.length === 0 && review.skillCandidates.length === 0));
  const blocked = await sleepMemory(vault, target);
  assert.equal(blocked.deferred, true);
  assert.deepEqual(blocked.archived, []);
  const firstEnd = await endMemoryTask(vault, { taskId: "task-a", completed: true });
  assert.equal(firstEnd.activeTasks, 1);
  assert.deepEqual(firstEnd.maintenance, []);
  const cancelled = await endMemoryTask(vault, { taskId: "task-b", completed: false });
  assert.deepEqual(cancelled.maintenance, []);
  assert.equal((await longMemoryRead(vault, { ...target, id: two.id })).status, "active");
  await beginMemoryTask(vault, { taskId: "task-c" });
  const lastEnd = await endMemoryTask(vault, { taskId: "task-c", completed: true });
  assert.ok(lastEnd.contextRevision > firstTask.contextRevision);
  assert.equal((await longMemoryRead(vault, { ...target, id: two.id })).status, "archived");
  assert.equal((await longMemoryRead(vault, { ...target, id: one.id })).status, "active");
  const duplicateEnd = await endMemoryTask(vault, { taskId: "task-c", completed: true });
  assert.equal(duplicateEnd.ended, false);
  assert.equal(duplicateEnd.contextRevision, lastEnd.contextRevision);
});

test("staged short-term promotion rechecks its source at task completion", async (t) => {
  const vault = await fixture(t);
  const target = { project: "alpha" };
  await beginMemoryTask(vault, { taskId: "promotion" }, { now: NOW });
  await shortMemoryWrite(vault, { ...target, content: "Initial finding." }, { now: OLD });
  const initial = await shortMemoryRead(vault, target, { now: NOW });
  const report = await reviewMemory(vault, target, { now: NOW });
  const reviewId = report.pendingReviews[0].id;
  const queued = await resolveMemoryReview(vault, { ...target, reviewId, action: "promote", expectedHash: initial.sha256, title: "Finding", content: "Initial finding is durable.", note: "Evidence checked before task ended." }, { now: NOW });
  assert.equal(queued.queued, true);
  assert.equal((await longMemorySearch(vault, target)).results.length, 0);
  await shortMemoryWrite(vault, { ...target, content: "Corrected finding.", expectedHash: initial.sha256 }, { now: NOW });
  const ended = await endMemoryTask(vault, { taskId: "promotion", completed: true }, { now: NOW });
  assert.ok(ended.maintenance.flatMap((item) => item.actionResults).some((item) => item.reviewId === reviewId && item.error === "hash_mismatch"));
  assert.equal((await longMemorySearch(vault, target)).results.length, 0);
  assert.match((await shortMemoryRead(vault, target)).content, /Corrected finding/);
  assert.deepEqual((await reviewMemory(vault, target, { now: NOW })).failedActions, [{ reviewId, error: "hash_mismatch" }]);
});

test("completion below the threshold does not refresh context or run maintenance", async (t) => {
  const vault = await fixture(t);
  const started = await beginMemoryTask(vault, { taskId: "small-task" });
  const saved = await longTermWrite(vault, { project: "alpha", title: "Small task", content: "One operation." });
  await recordToolUse(vault, "long_memory_write", {}, saved);
  const ended = await endMemoryTask(vault, { taskId: "small-task", completed: true });
  assert.deepEqual(ended.maintenance, []);
  assert.equal(ended.contextRevision, started.contextRevision);
});

test("deferring stale working state does not requeue unchanged bytes on every task", async (t) => {
  const vault = await fixture(t);
  const target = { project: "alpha" };
  await shortMemoryWrite(vault, { ...target, content: "Uncertain working hypothesis." }, { now: OLD });
  const short = await shortMemoryRead(vault, target, { now: NOW });
  const reviewId = (await reviewMemory(vault, target, { now: NOW })).pendingReviews[0].id;
  await beginMemoryTask(vault, { taskId: "defer-stale" }, { now: NOW });
  await resolveMemoryReview(vault, { ...target, reviewId, action: "defer", expectedHash: short.sha256, note: "Evidence is currently unavailable; do not endorse this hypothesis." }, { now: NOW });
  await endMemoryTask(vault, { taskId: "defer-stale", completed: true }, { now: NOW });
  const report = await reviewMemory(vault, target, { now: NOW });
  assert.deepEqual(report.pendingReviews, []);
  assert.deepEqual(report.reviews, []);
  assert.equal(report.unresolvedReviews[0].id, reviewId);
  assert.equal((await shortMemoryRead(vault, target, { now: NOW })).sha256, short.sha256);
  assert.equal((await sleepMemory(vault, target, { now: NOW })).skipped, true);
  await shortMemoryWrite(vault, { ...target, content: "Changed working hypothesis.", expectedHash: short.sha256 }, { now: OLD });
  const next = await reviewMemory(vault, target, { now: NOW });
  assert.equal(next.pendingReviews.length, 1);
  assert.notEqual(next.pendingReviews[0].id, reviewId);
});
