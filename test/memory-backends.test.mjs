import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS, SettingsError, joinModeFor, loadSettings, publicSettings, saveSettings, validateSettings } from "../lib/settings.mjs";
import { activeMemoryTasks, activityOf, closeMemoryDbs, countMemories, dbTransaction, dedupeExact, deferredReviews, ensureReview, finishMemoryTask, finishReviewAction, getMemory, getReview, getReviewAction, hasMemorySource, hotMemories, insertMemory, listMemoryScopes, openMemoryDb, openReviews, queueMemoryFeedback, recordActivity, releaseReviews, resolveReviewRow, reviewFeedback, searchMemories, setStatus, stageReviewAction, stagedReviewActions, startMemoryTask, touchRead } from "../lib/memory-db.mjs";
import { teamRecall, teamRemember } from "../lib/team-memory.mjs";

const execFileAsync = promisify(execFile);
const defaults = () => structuredClone(DEFAULT_SETTINGS);
const entry = (extra = {}) => ({ scope: "global", title: "Exact title", content: "Exact content", tags: ["test"], ...extra });
const code = (expected) => (error) => error.code === expected;

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-vault-backends-")));
  t.after(async () => { closeMemoryDbs(); await rm(root, { recursive: true, force: true }); });
  return root;
}

async function service(t, handler) {
  const server = createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end(); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  return `http://127.0.0.1:${server.address().port}/api`;
}

const httpSettings = (url, teamId = "alpha") => ({ ...defaults(), team: { ...DEFAULT_SETTINGS.team, enabled: true, backend: "http", url, teamId } });
const fileSettings = (file, teamId = "alpha") => ({ ...defaults(), team: { ...DEFAULT_SETTINGS.team, enabled: true, backend: "file", path: file, teamId } });
const json = (res, value) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };

test("settings reject unknown keys, wrong types, credential URLs, and remote plaintext HTTP", async (t) => {
  const root = await fixture(t);
  for (const patch of [
    { unknown: true }, { team: { enabled: "false" } }, { team: { allowWrite: 1 } },
    { team: { teamId: 12 } }, { team: { tokenEnv: [] } }, { team: { url: 12 } },
    { join: null }, { join: { harnesses: [] } }, { join: { harnesses: { unknown: "auto" } } },
    { review: { repeatEvery: Number.MAX_SAFE_INTEGER + 1 } }, { guard: { surprise: true } },
    { team: { url: "https://user:password@example.test" } },
    { team: { url: "https://example.test?token=secret" } },
    { team: { url: "https://example.test#token" } },
    { team: { url: "http://example.test" } }, { team: { path: "relative.db" } },
    { team: { url: "file:///tmp/team.db" } },
  ]) await assert.rejects(saveSettings(root, patch), SettingsError);
  assert.throws(() => validateSettings(null), SettingsError);
  for (const url of ["https://example.test/base", "http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
    assert.equal(validateSettings(httpSettings(url)).team.url, url);
  }
});

test("settings serialize writers, preserve independent updates, and write private atomic JSON", async (t) => {
  const root = await fixture(t);
  await Promise.all([
    saveSettings(root, { join: { harnesses: { omp: "auto" } } }),
    saveSettings(root, { join: { harnesses: { claude: "manual" } } }),
    saveSettings(root, { review: { hotReadCount: 25 } }),
  ]);
  const settings = loadSettings(root);
  assert.equal(joinModeFor(settings, "omp"), "auto");
  assert.equal(joinModeFor(settings, "claude"), "manual");
  assert.equal(settings.review.hotReadCount, 25);
  assert.equal((await lstat(path.join(root, ".agent-vault/settings.json"))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path.join(root, ".agent-vault/settings.json"), "utf8")).version, 1);
  assert.equal(publicSettings(settings).team.url, undefined);
  await assert.rejects(lstat(path.join(root, ".agent-vault/settings.json.lock")), { code: "ENOENT" });
});

test("settings reject symlinked directories, settings files, locks, and hard links", async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  const vault = path.join(root, "vault");
  await mkdir(vault);
  await symlink(outside, path.join(vault, ".agent-vault"));
  await assert.rejects(saveSettings(vault, {}), SettingsError);
  assert.throws(() => loadSettings(vault), SettingsError);
  await rm(path.join(vault, ".agent-vault"));
  await mkdir(path.join(vault, ".agent-vault"));
  const leaf = path.join(vault, ".agent-vault/settings.json");
  const destination = path.join(outside, "destination");
  await writeFile(destination, JSON.stringify(defaults()));
  await symlink(destination, leaf);
  await assert.rejects(saveSettings(vault, {}), SettingsError);
  await rm(leaf);
  await link(destination, leaf);
  assert.throws(() => loadSettings(vault), SettingsError);
  await rm(leaf);
  await symlink(destination, `${leaf}.lock`);
  await assert.rejects(saveSettings(vault, {}), SettingsError);
  assert.equal(await readFile(destination, "utf8"), JSON.stringify(defaults()));
});

test("SQLite opens once concurrently, reopens after explicit close, and protects files", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "memory.db");
  const connections = await Promise.all(Array.from({ length: 12 }, () => openMemoryDb(file)));
  assert.ok(connections.every((db) => db === connections[0]));
  const stored = insertMemory(connections[0], entry());
  for (const suffix of ["", "-wal", "-shm"]) assert.equal((await lstat(`${file}${suffix}`)).mode & 0o777, 0o600);
  connections[0].close();
  const reopened = await openMemoryDb(file);
  assert.notEqual(reopened, connections[0]);
  assert.equal(getMemory(reopened, stored.memory.id).content, "Exact content");
  closeMemoryDbs();
  const pending = openMemoryDb(file);
  closeMemoryDbs();
  await assert.rejects(pending, code("database_closed"));
  assert.ok(await openMemoryDb(file));
});

test("SQLite rejects symlinked files, sidecars, parent directories, and hard links", async (t) => {
  const root = await fixture(t);
  const destination = path.join(root, "destination");
  await writeFile(destination, "untouched");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = path.join(root, `unsafe${suffix.replaceAll("-", "") || "main"}.db`);
    await symlink(destination, `${file}${suffix}`);
    await assert.rejects(openMemoryDb(file), code("path_unsafe"));
  }
  const linked = path.join(root, "linked.db");
  await link(destination, linked);
  await assert.rejects(openMemoryDb(linked), code("path_unsafe"));
  const parent = path.join(root, "alias");
  await symlink(root, parent);
  await assert.rejects(openMemoryDb(path.join(parent, "memory.db")), code("path_unsafe"));
  const writable = path.join(root, "writable");
  await mkdir(writable);
  await chmod(writable, 0o777);
  await assert.rejects(openMemoryDb(path.join(writable, "memory.db")), code("path_unsafe"));
  assert.equal(await readFile(destination, "utf8"), "untouched");
});

test("SQLite initialization errors release connections and permit repair", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "memory.db");
  const db = await openMemoryDb(file);
  db.prepare("UPDATE meta SET v = '999' WHERE k = 'schema'").run();
  closeMemoryDbs();
  await assert.rejects(openMemoryDb(file), code("schema_mismatch"));
  const { DatabaseSync } = await import("node:sqlite");
  const repair = new DatabaseSync(file);
  repair.prepare("UPDATE meta SET v = '2' WHERE k = 'schema'").run();
  repair.close();
  assert.ok(await openMemoryDb(file));
});

test("SQLite exact deduplication preserves case, whitespace, boundaries, and complete old-match search", async (t) => {
  const root = await fixture(t);
  const db = await openMemoryDb(path.join(root, "memory.db"));
  const first = insertMemory(db, entry({ sourcePath: "legacy/source.md", content: "rareoldneedle" }));
  assert.equal(insertMemory(db, entry({ sourcePath: "legacy/source.md", content: "rareoldneedle" })).duplicate, true);
  for (const content of ["RAREOLDNEEDLE", "rareoldneedle ", "rareoldneedle\n"]) assert.equal(insertMemory(db, entry({ content })).duplicate, false);
  assert.equal(insertMemory(db, entry({ title: "a\nb", content: "c" })).duplicate, false);
  assert.equal(insertMemory(db, entry({ title: "a", content: "b\nc" })).duplicate, false);
  dbTransaction(db, () => {
    for (let i = 0; i < 2005; i++) insertMemory(db, entry({ title: `New ${i}`, content: `New content ${i}` }));
  });
  const matches = searchMemories(db, { scope: "global", query: "rareoldneedle", limit: 10 });
  assert.ok(matches.some((memory) => memory.id === first.memory.id));
  assert.deepEqual(searchMemories(db, { scope: "global", query: "' OR 1=1 --" }), []);
  assert.equal(countMemories(db, { scope: "global" }), 2011);
  assert.equal(hasMemorySource(db, "legacy/source.md"), true);
  assert.equal(hasMemorySource(db, "absent.md"), false);
  assert.deepEqual(listMemoryScopes(db), [{ scope: "global", project: null, role: null }]);
  touchRead(db, [first.memory.id]);
  assert.equal(hotMemories(db, { scope: "global", minReads: 1 })[0].readCount, 1);
  assert.deepEqual(dedupeExact(db, { scope: "global" }), []);
  assert.throws(() => searchMemories(db, { scope: "global", limit: "10" }), code("invalid_limit"));
});

test("independent processes preserve concurrent settings patches", async (t) => {
  const root = await fixture(t);
  const moduleUrl = new URL("../lib/settings.mjs", import.meta.url).href;
  const patches = [
    { join: { harnesses: { omp: "auto" } } },
    { join: { harnesses: { codex: "auto" } } },
    { review: { repeatEvery: 30 } },
    { review: { hotReadCount: 40 } },
  ];
  const script = `import { saveSettings } from ${JSON.stringify(moduleUrl)}; await saveSettings(process.argv[1], JSON.parse(process.argv[2]));`;
  await Promise.all(patches.map((patch) => execFileAsync(process.execPath, ["--input-type=module", "-e", script, root, JSON.stringify(patch)], { timeout: 15000 })));
  const settings = loadSettings(root);
  assert.equal(settings.join.harnesses.omp, "auto");
  assert.equal(settings.join.harnesses.codex, "auto");
  assert.equal(settings.review.repeatEvery, 30);
  assert.equal(settings.review.hotReadCount, 40);
});

test("SQLite keeps import provenance and distinguishes skill tags during deduplication", async (t) => {
  const root = await fixture(t);
  const db = await openMemoryDb(path.join(root, "memory.db"));
  const ordinary = insertMemory(db, entry()).memory;
  const first = insertMemory(db, entry({ sourcePath: "legacy/one.md" })).memory;
  const second = insertMemory(db, entry({ sourcePath: "legacy/two.md" })).memory;
  const skill = insertMemory(db, entry({ tags: ["test", "skill"] })).memory;
  assert.equal(countMemories(db, { scope: "global" }), 4);
  assert.notEqual(first.id, ordinary.id);
  assert.notEqual(second.id, first.id);
  assert.notEqual(skill.id, ordinary.id);
  assert.deepEqual(dedupeExact(db, { scope: "global" }), [first.id, second.id]);
  assert.equal(getMemory(db, first.id).sourcePath, "legacy/one.md");
  assert.equal(getMemory(db, second.id).sourcePath, "legacy/two.md");
  assert.equal(getMemory(db, skill.id).status, "active");
});

test("SQLite upgrades legacy hashes without folding case, whitespace, or tags", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "memory.db");
  const db = await openMemoryDb(file);
  const entries = [entry(), entry({ content: "EXACT CONTENT" }), entry({ content: "Exact content " }), entry({ tags: ["skill"] })];
  for (const value of entries) insertMemory(db, value);
  db.prepare("UPDATE memories SET content_hash = 'old-folded-hash'").run();
  db.prepare("UPDATE meta SET v = '1' WHERE k = 'schema'").run();
  db.exec("DROP TABLE review_feedback; ALTER TABLE reviews DROP COLUMN ready_at");
  closeMemoryDbs();
  const migrated = await openMemoryDb(file);
  assert.deepEqual(dedupeExact(migrated, { scope: "global" }), []);
  assert.equal(migrated.prepare("SELECT v FROM meta WHERE k = 'schema'").get().v, "4");
  assert.equal(ensureReview(migrated, "global", "stale", 0).readyAt, null);
  for (const value of entries) assert.equal(insertMemory(migrated, value).duplicate, true);
});

test("SQLite upgrades schema two without changing exact hashes or releasing legacy reviews", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "memory.db");
  const db = await openMemoryDb(file);
  const memory = insertMemory(db, entry()).memory;
  const review = ensureReview(db, "global", "ops>=5", 5);
  const hash = db.prepare("SELECT content_hash FROM memories WHERE id = ?").get(memory.id).content_hash;
  db.exec("DROP TABLE review_feedback; ALTER TABLE reviews DROP COLUMN ready_at; UPDATE meta SET v = '2' WHERE k = 'schema'");
  closeMemoryDbs();
  const migrated = await openMemoryDb(file);
  assert.equal(migrated.prepare("SELECT v FROM meta WHERE k = 'schema'").get().v, "4");
  assert.equal(migrated.prepare("SELECT content_hash FROM memories WHERE id = ?").get(memory.id).content_hash, hash);
  assert.equal(insertMemory(migrated, entry()).duplicate, true);
  assert.equal(getReview(migrated, review.id).ready_at, null);
  assert.deepEqual(openReviews(migrated), []);
  assert.equal(openReviews(migrated, "", { includePending: true })[0].state, "pending");
});

test("SQLite upgrades schema three while preserving memories, counters, reviews, tasks, and actions", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "memory.db");
  let db = await openMemoryDb(file);
  const memory = insertMemory(db, entry({ sourcePath: "legacy/three.md" })).memory;
  touchRead(db, [memory.id]);
  recordActivity(db, "global:::long", "write", DEFAULT_SETTINGS.review);
  const review = ensureReview(db, "global:::long", "stale", 1);
  releaseReviews(db, [review.id]);
  const readyReview = openReviews(db)[0];
  stageReviewAction(db, review.id, { action: "keep", note: "Retain exact receipt" });
  startMemoryTask(db, { taskId: "migration-task", ownerPid: process.pid });
  const tables = ["memories", "activity", "reviews", "memory_tasks", "review_actions"];
  const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
  db.exec("DROP TABLE review_feedback; UPDATE meta SET v = '3' WHERE k = 'schema'");
  closeMemoryDbs();
  db = await openMemoryDb(file);
  assert.equal(db.prepare("SELECT v FROM meta WHERE k = 'schema'").get().v, "4");
  assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()), before);
  assert.deepEqual(reviewFeedback(db, review.id), []);
  assert.deepEqual(openReviews(db), [readyReview]);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_list(review_feedback)").all().map((row) => row.table).sort(), ["memories", "reviews"]);
  assert.equal(queueMemoryFeedback(db, { key: review.key, memoryId: memory.id, trigger: "outdated", feedback: "Recheck migrated source." }).created, true);
});

test("memory feedback binds exact source hashes and rearms only new immutable feedback", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "memory.db");
  let db = await openMemoryDb(file);
  const memory = insertMemory(db, entry()).memory;
  touchRead(db, [memory.id]);
  recordActivity(db, "global:::long", "read", DEFAULT_SETTINGS.review);
  const source = { ...db.prepare("SELECT * FROM memories WHERE id = ?").get(memory.id) };
  const activity = activityOf(db, "global:::long");
  const firstAt = new Date("2026-11-17T01:00:00.000Z");
  const args = { key: "global:::long", memoryId: memory.id, trigger: "user_correction", feedback: "The old claim may fail; verify evidence." };
  const first = queueMemoryFeedback(db, args, firstAt);
  assert.equal(first.created, true);
  assert.equal(first.review.reason, "knowledge_reconsideration");
  assert.equal(first.review.totalOps, 0);
  assert.equal(first.review.state, "pending");
  assert.deepEqual(first.feedback, {
    id: first.feedback.id, reviewId: first.review.id, memoryId: memory.id, trigger: args.trigger,
    feedback: args.feedback, sourceHash: source.content_hash, createdAt: firstAt.toISOString(),
  });
  assert.deepEqual(openReviews(db), []);
  assert.deepEqual(openReviews(db, args.key, { includePending: true }), [{ ...first.review, feedback: [first.feedback] }]);
  const readyAt = new Date("2026-11-17T02:00:00.000Z");
  releaseReviews(db, [first.review.id], readyAt);
  const duplicate = queueMemoryFeedback(db, args, new Date("2026-11-17T03:00:00.000Z"));
  assert.equal(duplicate.created, false);
  assert.deepEqual(duplicate.feedback, first.feedback);
  assert.equal(duplicate.review.readyAt, readyAt.toISOString());
  assert.equal(duplicate.review.state, "ready");
  const second = queueMemoryFeedback(db, { ...args, trigger: "counterexample" });
  assert.equal(second.created, true);
  assert.equal(second.review.id, first.review.id);
  assert.equal(second.review.readyAt, null);
  assert.deepEqual(reviewFeedback(db, first.review.id), [first.feedback, second.feedback]);
  assert.deepEqual({ ...db.prepare("SELECT * FROM memories WHERE id = ?").get(memory.id) }, source);
  assert.deepEqual(activityOf(db, args.key), activity);
  assert.throws(() => db.prepare("UPDATE review_feedback SET feedback = 'rewritten' WHERE id = ?").run(first.feedback.id), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM review_feedback WHERE id = ?").run(first.feedback.id), /immutable/);
  closeMemoryDbs();
  db = await openMemoryDb(file);
  assert.deepEqual(reviewFeedback(db, first.review.id), [first.feedback, second.feedback]);
  assert.equal(queueMemoryFeedback(db, args).created, false);
  db.prepare("UPDATE memories SET content_hash = 'new-current-source-hash' WHERE id = ?").run(memory.id);
  const rebound = queueMemoryFeedback(db, args);
  assert.equal(rebound.created, true);
  assert.equal(rebound.feedback.sourceHash, "new-current-source-hash");
  assert.equal(reviewFeedback(db, first.review.id)[0].sourceHash, source.content_hash);
  const third = queueMemoryFeedback(db, { ...args, trigger: "external_evidence", feedback: "Published evidence contradicts the claim." });
  assert.equal(third.created, true);
  resolveReviewRow(db, first.review.id, JSON.stringify({ action: "defer", note: "Needs source verification." }));
  const later = queueMemoryFeedback(db, args);
  assert.notEqual(later.review.id, first.review.id);
  assert.equal(later.created, true);
  assert.equal(reviewFeedback(db, first.review.id).length, 4);
  assert.equal(reviewFeedback(db, later.review.id).length, 1);
});

test("memory feedback rejects inactive, missing, team, and cross-namespace sources without side effects", async (t) => {
  const root = await fixture(t);
  const db = await openMemoryDb(path.join(root, "memory.db"));
  const memory = insertMemory(db, entry({ scope: "project", project: "alpha", role: "builder" })).memory;
  const global = insertMemory(db, entry({ role: "reviewer" })).memory;
  const team = insertMemory(db, entry({ scope: "team", teamId: "alpha" })).memory;
  const args = { key: "project:alpha:builder:long", memoryId: memory.id, trigger: "outdated", feedback: "Check freshness." };
  for (const key of ["project:beta:builder:long", "project:alpha:reviewer:long", "project:alphab:builder:long", "global:::long"]) {
    assert.throws(() => queueMemoryFeedback(db, { ...args, key }), code("not_found"));
  }
  assert.throws(() => queueMemoryFeedback(db, { ...args, memoryId: 999 }), code("not_found"));
  assert.throws(() => queueMemoryFeedback(db, { ...args, key: "team:alpha:::long", memoryId: team.id }), code("not_found"));
  assert.throws(() => queueMemoryFeedback(db, { ...args, memoryId: global.id, key: "global:::long" }), code("not_found"));
  for (const memoryId of [0, -1, 1.5, "1"]) assert.throws(() => queueMemoryFeedback(db, { ...args, memoryId }), code("invalid_id"));
  for (const patch of [{ key: "" }, { key: undefined }, { trigger: "agree" }, { feedback: "" }, { feedback: " " }]) {
    assert.throws(() => queueMemoryFeedback(db, { ...args, ...patch }), code("invalid_feedback"));
  }
  setStatus(db, memory.id, "archived");
  assert.throws(() => queueMemoryFeedback(db, args), code("memory_changed"));
  setStatus(db, memory.id, "superseded");
  assert.throws(() => queueMemoryFeedback(db, args), code("memory_changed"));
  assert.deepEqual(openReviews(db, "", { includePending: true }), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM review_feedback").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM activity").get().count, 0);
  assert.equal(queueMemoryFeedback(db, { ...args, key: "global::reviewer:long", memoryId: global.id }).created, true);
});

test("memory feedback and ticket rearming roll back atomically", async (t) => {
  const root = await fixture(t);
  const db = await openMemoryDb(path.join(root, "memory.db"));
  const memory = insertMemory(db, entry()).memory;
  const args = { key: "global:::long", memoryId: memory.id, trigger: "counterexample", feedback: "Investigate this counterexample." };
  assert.throws(() => dbTransaction(db, () => {
    queueMemoryFeedback(db, args);
    throw new Error("rollback");
  }), /rollback/);
  assert.deepEqual(openReviews(db, "", { includePending: true }), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM review_feedback").get().count, 0);
  const ticket = ensureReview(db, args.key, "ops>=5", 5);
  releaseReviews(db, [ticket.id]);
  const before = getReview(db, ticket.id);
  assert.throws(() => dbTransaction(db, () => {
    queueMemoryFeedback(db, args);
    throw new Error("rollback");
  }), /rollback/);
  assert.deepEqual(getReview(db, ticket.id), before);
  assert.deepEqual(reviewFeedback(db, ticket.id), []);
  const queued = queueMemoryFeedback(db, args);
  assert.equal(queued.review.reason, "ops>=5");
  assert.equal(queued.review.totalOps, 5);
  assert.equal(queued.review.readyAt, null);
});

test("deferred review warnings persist through pending requests and disappear only after a newer closed review", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "memory.db");
  let db = await openMemoryDb(file);
  const memory = insertMemory(db, entry()).memory;
  const key = "global:::long";
  const args = { key, memoryId: memory.id, trigger: "outdated", feedback: "Evidence is incomplete." };
  const first = queueMemoryFeedback(db, args);
  const assessment = { decision: "inconclusive", limitations: ["Source missing."] };
  const resolution = { action: "defer", note: "Do not rely on this claim until evidence is checked.", sourceId: memory.id, sourceHash: first.feedback.sourceHash, assessment };
  const resolvedAt = new Date("2026-11-17T04:00:00.000Z");
  releaseReviews(db, [first.review.id]);
  const released = openReviews(db)[0];
  resolveReviewRow(db, first.review.id, JSON.stringify(resolution), resolvedAt);
  const expected = { ...first.review, readyAt: released.readyAt, state: "ready", resolvedAt: resolvedAt.toISOString(), resolution, assessment, feedback: [first.feedback] };
  assert.deepEqual(deferredReviews(db, key), [expected]);
  const second = queueMemoryFeedback(db, { ...args, trigger: "external_evidence" });
  assert.notEqual(second.review.id, first.review.id);
  assert.equal(openReviews(db, key, { includePending: true })[0].id, second.review.id);
  assert.deepEqual(deferredReviews(db, key), [expected]);
  releaseReviews(db, [second.review.id]);
  assert.deepEqual(deferredReviews(db, key), [expected]);
  closeMemoryDbs();
  db = await openMemoryDb(file);
  assert.deepEqual(deferredReviews(db, key), [expected]);
  resolveReviewRow(db, second.review.id, JSON.stringify({ action: "keep", note: "Evidence supports the original claim." }));
  assert.deepEqual(deferredReviews(db, key), []);
  assert.deepEqual(reviewFeedback(db, first.review.id), [first.feedback]);
  const literal = ensureReview(db, "project:under_score%slash\\", "stale", 0);
  const other = ensureReview(db, "project:underXscoreYslashZ", "stale", 0);
  for (const ticket of [literal, other]) resolveReviewRow(db, ticket.id, JSON.stringify({ action: "defer", note: "Await evidence." }));
  assert.deepEqual(deferredReviews(db, literal.key).map((review) => review.id), [literal.id]);
  assert.equal(deferredReviews(db, literal.key)[0].assessment, null);
  const legacy = ensureReview(db, "legacy", "stale", 0);
  resolveReviewRow(db, legacy.id, "keep");
  assert.equal(deferredReviews(db).length, 2);
  const newer = ensureReview(db, literal.key, "knowledge_reconsideration", 0);
  resolveReviewRow(db, newer.id, JSON.stringify({ action: "defer", note: "Still incomplete." }));
  assert.deepEqual(deferredReviews(db, literal.key).map((review) => review.id), [newer.id]);
  assert.equal(getReview(db, literal.id).resolved_at !== null, true);
});

test("SQLite transactions roll back nested memory and activity updates", async (t) => {
  const root = await fixture(t);
  const db = await openMemoryDb(path.join(root, "memory.db"));
  assert.throws(() => dbTransaction(db, () => {
    insertMemory(db, entry());
    recordActivity(db, "global", "write", DEFAULT_SETTINGS.review);
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(countMemories(db, { scope: "global" }), 0);
  assert.equal(activityOf(db, "global").writes, 0);
  assert.throws(() => dbTransaction(db, async () => {}), code("async_transaction"));
  assert.throws(() => recordActivity(db, "global", "invalid", DEFAULT_SETTINGS.review), code("invalid_activity"));
});

test("review tickets queue across operations and release only at an explicit boundary", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "memory.db");
  let db = await openMemoryDb(file);
  let activity;
  for (let i = 0; i < 6; i++) activity = recordActivity(db, "global", i % 2 ? "read" : "write", DEFAULT_SETTINGS.review);
  assert.equal(activity.ticket.totalOps, 6);
  assert.equal(activity.ticket.reason, "ops>=5");
  assert.equal(activity.ticket.state, "pending");
  assert.equal(activity.ticket.readyAt, null);
  assert.deepEqual(openReviews(db), []);
  assert.equal(openReviews(db, "", { includePending: true })[0].id, activity.ticket.id);
  const existing = ensureReview(db, "global", "stale", 8);
  assert.equal(existing.id, activity.ticket.id);
  assert.equal(existing.totalOps, 8);
  closeMemoryDbs();
  db = await openMemoryDb(file);
  assert.deepEqual(openReviews(db), []);
  const boundary = new Date("2026-11-17T10:00:00.000Z");
  assert.deepEqual(releaseReviews(db, [existing.id, existing.id, -1], boundary), [existing.id]);
  assert.equal(openReviews(db)[0].state, "ready");
  assert.equal(openReviews(db)[0].readyAt, boundary.toISOString());
  assert.deepEqual(releaseReviews(db, [existing.id], new Date("2026-11-18")), []);
  assert.equal(getReview(db, existing.id).ready_at, boundary.toISOString());
  resolveReviewRow(db, existing.id, "keep");
  assert.equal(getReview(db, existing.id).resolution, "keep");
  assert.deepEqual(releaseReviews(db, [existing.id]), []);
  for (let i = 0; i < 4; i++) activity = recordActivity(db, "global", "read", DEFAULT_SETTINGS.review);
  assert.equal(activity.ticket.reason, "ops>=10");
  assert.notEqual(activity.ticket.id, existing.id);
  assert.equal(activity.ticket.state, "pending");
  assert.deepEqual(openReviews(db), []);
  const literal = ensureReview(db, "project:under_score%slash\\", "stale", 0);
  ensureReview(db, "project:underXscoreYslashZ", "stale", 0);
  assert.deepEqual(openReviews(db, "project:under_score%slash\\", { includePending: true }).map((row) => row.id), [literal.id]);
  const memory = insertMemory(db, entry()).memory;
  setStatus(db, memory.id, "archived");
  assert.equal(getMemory(db, memory.id).status, "archived");
});

test("new usage milestones rearm ready reviews but stale checks do not", async (t) => {
  const root = await fixture(t);
  const db = await openMemoryDb(path.join(root, "memory.db"));
  const policy = { thresholds: [2, 4], repeatEvery: 2 };
  recordActivity(db, "global", "read", policy);
  const review = recordActivity(db, "global", "read", policy).ticket;
  releaseReviews(db, [review.id]);
  assert.equal(ensureReview(db, "global", "stale", 2).state, "ready");
  assert.equal(recordActivity(db, "global", "read", policy).ticket.state, "ready");
  const rearmed = recordActivity(db, "global", "write", policy).ticket;
  assert.equal(rearmed.id, review.id);
  assert.equal(rearmed.state, "pending");
  assert.equal(rearmed.readyAt, null);
  assert.equal(rearmed.totalOps, 4);
  assert.deepEqual(openReviews(db), []);
  releaseReviews(db, [review.id]);
  recordActivity(db, "global", "read", policy);
  assert.equal(recordActivity(db, "global", "read", policy).ticket.state, "pending");
});

test("memory tasks persist a vault-wide barrier and close once without releasing reviews", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "memory.db");
  let db = await openMemoryDb(file);
  const start = new Date("2000-01-01T00:00:00.000Z");
  assert.deepEqual(startMemoryTask(db, { taskId: "first", ownerPid: process.pid }, start), { started: true, taskId: "first", activeTasks: 1 });
  assert.deepEqual(startMemoryTask(db, { taskId: "first", ownerPid: process.pid }), { started: false, taskId: "first", activeTasks: 1 });
  assert.throws(() => startMemoryTask(db, { taskId: "first", ownerPid: process.pid + 1 }), code("memory_task_owner_mismatch"));
  assert.throws(() => startMemoryTask(db, { taskId: "", ownerPid: process.pid }), code("invalid_memory_task"));
  assert.throws(() => startMemoryTask(db, { taskId: "invalid", ownerPid: 0 }), code("invalid_memory_task"));
  const global = ensureReview(db, "global", "stale", 0);
  const project = ensureReview(db, "project:other", "ops>=5", 5);
  assert.equal(startMemoryTask(db, { taskId: "second", ownerPid: process.pid }).activeTasks, 2);
  assert.equal(activeMemoryTasks(db)[0].startedAt, start.toISOString());
  assert.deepEqual(releaseReviews(db, [global.id, project.id]), []);
  closeMemoryDbs();
  db = await openMemoryDb(file);
  assert.equal(activeMemoryTasks(db).length, 2);
  assert.deepEqual(finishMemoryTask(db, { taskId: "first", completed: true }), { ended: true, completed: true, activeTasks: 1 });
  assert.deepEqual(releaseReviews(db, [global.id, project.id]), []);
  assert.deepEqual(finishMemoryTask(db, { taskId: "first", completed: true }), { ended: false, completed: false, activeTasks: 1 });
  assert.throws(() => startMemoryTask(db, { taskId: "first", ownerPid: process.pid }), code("memory_task_closed"));
  assert.deepEqual(finishMemoryTask(db, { taskId: "second", completed: false }), { ended: true, completed: false, activeTasks: 0 });
  assert.deepEqual(openReviews(db), []);
  assert.deepEqual(finishMemoryTask(db, { taskId: "missing", completed: true }), { ended: false, completed: false, activeTasks: 0 });
  assert.deepEqual(dbTransaction(db, () => releaseReviews(db, [global.id, project.id])), [global.id, project.id]);
  const rows = db.prepare("SELECT id, status, finished_at FROM memory_tasks ORDER BY id").all();
  assert.deepEqual(rows.map((row) => row.status), ["completed", "cancelled"]);
  assert.ok(rows.every((row) => row.finished_at !== null));
  assert.equal(countMemories(db, { scope: "global" }), 0);
});

test("memory tasks in separate processes share the same completion barrier", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "memory.db");
  const db = await openMemoryDb(file);
  const review = ensureReview(db, "project:other", "stale", 0);
  startMemoryTask(db, { taskId: "parent", ownerPid: process.pid });
  const moduleUrl = new URL("../lib/memory-db.mjs", import.meta.url).href;
  const script = `import fs from 'node:fs'; import { openMemoryDb, startMemoryTask, finishMemoryTask, closeMemoryDbs } from ${JSON.stringify(moduleUrl)}; const db = await openMemoryDb(process.argv[1]); startMemoryTask(db, {taskId:'child',ownerPid:process.pid}); process.stdout.write('ready'); fs.readFileSync(0, 'utf8'); finishMemoryTask(db, {taskId:'child',completed:true}); closeMemoryDbs();`;
  const child = execFileAsync(process.execPath, ["--input-type=module", "-e", script, file], { timeout: 15000 });
  try {
    await Promise.race([once(child.child.stdout, "data"), child.then(() => { throw new Error("Child exited before starting its memory task."); })]);
    assert.equal(activeMemoryTasks(db).length, 2);
    assert.deepEqual(finishMemoryTask(db, { taskId: "parent", completed: true }), { ended: true, completed: true, activeTasks: 1 });
    assert.deepEqual(releaseReviews(db, [review.id]), []);
  } finally {
    child.child.stdin.end("\n");
    await child;
  }
  assert.equal(activeMemoryTasks(db).length, 0);
  assert.equal(getReview(db, review.id).ready_at, null);
  assert.deepEqual(releaseReviews(db, [review.id]), [review.id]);
});

test("memory task and release transitions roll back with the enclosing transaction", async (t) => {
  const root = await fixture(t);
  const db = await openMemoryDb(path.join(root, "memory.db"));
  const review = ensureReview(db, "global", "stale", 0);
  startMemoryTask(db, { taskId: "task", ownerPid: process.pid });
  assert.throws(() => dbTransaction(db, () => {
    finishMemoryTask(db, { taskId: "task", completed: true });
    releaseReviews(db, [review.id]);
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(activeMemoryTasks(db).length, 1);
  assert.equal(getReview(db, review.id).ready_at, null);
  assert.throws(() => dbTransaction(db, () => {
    startMemoryTask(db, { taskId: "rolled-back", ownerPid: process.pid });
    throw new Error("rollback");
  }), /rollback/);
  assert.deepEqual(activeMemoryTasks(db).map((row) => row.taskId), ["task"]);
});

test("memory tasks reap only exited process owners when another task starts", async (t) => {
  const root = await fixture(t);
  const db = await openMemoryDb(path.join(root, "memory.db"));
  const child = execFileAsync(process.execPath, ["-e", "setTimeout(() => {}, 100)"]);
  startMemoryTask(db, { taskId: "orphan", ownerPid: child.child.pid }, new Date("2000-01-01"));
  startMemoryTask(db, { taskId: "live", ownerPid: process.pid }, new Date("2000-01-01"));
  await child;
  assert.deepEqual(activeMemoryTasks(db).map((row) => row.taskId), ["live", "orphan"]);
  assert.equal(startMemoryTask(db, { taskId: "next", ownerPid: process.pid }).activeTasks, 2);
  const orphan = db.prepare("SELECT status, finished_at FROM memory_tasks WHERE id = 'orphan'").get();
  assert.equal(orphan.status, "cancelled");
  assert.ok(orphan.finished_at);
  assert.deepEqual(finishMemoryTask(db, { taskId: "orphan", completed: true }), { ended: false, completed: false, activeTasks: 2 });
});

test("memory tasks preserve owners when process probes return EPERM", async (t) => {
  const root = await fixture(t);
  const db = await openMemoryDb(path.join(root, "memory.db"));
  startMemoryTask(db, { taskId: "protected", ownerPid: process.pid }, new Date("2000-01-01"));
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  assert.equal(startMemoryTask(db, { taskId: "new", ownerPid: process.pid }).activeTasks, 2);
  assert.deepEqual(activeMemoryTasks(db).map((row) => row.taskId), ["protected", "new"]);
});

test("review actions persist exact payloads and allow replacement only after failure", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "memory.db");
  let db = await openMemoryDb(file);
  const review = ensureReview(db, "global", "ops>=5", 5);
  const payload = { resolution: "keep", reason: "Exact text", ids: [1, 2] };
  const staged = stageReviewAction(db, review.id, payload);
  assert.equal(staged.status, "pending");
  assert.equal(staged.errorCode, null);
  assert.deepEqual(stageReviewAction(db, review.id, payload), staged);
  assert.throws(() => stageReviewAction(db, review.id, { resolution: "archive" }), code("review_action_conflict"));
  assert.throws(() => stageReviewAction(db, -1, payload), code("review_not_open"));
  assert.throws(() => stageReviewAction(db, review.id, []), code("invalid_review_action"));
  closeMemoryDbs();
  db = await openMemoryDb(file);
  assert.deepEqual(stagedReviewActions(db), [{ reviewId: review.id, payload }]);
  assert.equal(getReview(db, review.id).ready_at, null);
  assert.equal(getReview(db, review.id).resolved_at, null);
  const failed = finishReviewAction(db, review.id, "write_failed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "write_failed");
  assert.deepEqual(failed.payload, payload);
  assert.deepEqual(stagedReviewActions(db), []);
  assert.deepEqual(finishReviewAction(db, review.id), failed);
  const replacement = { resolution: "archive", ids: [2] };
  assert.equal(stageReviewAction(db, review.id, replacement).status, "pending");
  assert.deepEqual(getReviewAction(db, review.id).payload, replacement);
  const applied = finishReviewAction(db, review.id);
  assert.equal(applied.status, "applied");
  assert.equal(applied.errorCode, null);
  assert.deepEqual(finishReviewAction(db, review.id, "late_error"), applied);
  assert.deepEqual(stageReviewAction(db, review.id, replacement), applied);
  assert.throws(() => stageReviewAction(db, review.id, payload), code("review_action_conflict"));
  assert.deepEqual(stagedReviewActions(db), []);
  const retry = ensureReview(db, "project:retry", "stale", 0);
  stageReviewAction(db, retry.id, payload);
  finishReviewAction(db, retry.id, "temporary");
  assert.equal(stageReviewAction(db, retry.id, payload).status, "pending");
  resolveReviewRow(db, retry.id, "keep");
  finishReviewAction(db, retry.id, "closed");
  assert.throws(() => stageReviewAction(db, retry.id, replacement), code("review_not_open"));
});

test("review action transitions roll back with the enclosing transaction", async (t) => {
  const root = await fixture(t);
  const db = await openMemoryDb(path.join(root, "memory.db"));
  const review = ensureReview(db, "global", "stale", 0);
  const payload = { resolution: "keep" };
  assert.throws(() => dbTransaction(db, () => {
    stageReviewAction(db, review.id, payload);
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(getReviewAction(db, review.id), null);
  stageReviewAction(db, review.id, payload);
  assert.throws(() => dbTransaction(db, () => {
    finishReviewAction(db, review.id);
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(getReviewAction(db, review.id).status, "pending");
});

test("independent processes initialize and insert into one local SQLite database", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "memory.db");
  const moduleUrl = new URL("../lib/memory-db.mjs", import.meta.url).href;
  const script = `import { openMemoryDb, insertMemory, closeMemoryDbs } from ${JSON.stringify(moduleUrl)}; const db = await openMemoryDb(process.argv[1]); insertMemory(db, {scope:'global',title:'same',content:'same'}); closeMemoryDbs();`;
  await Promise.all(Array.from({ length: 4 }, () => execFileAsync(process.execPath, ["--input-type=module", "-e", script, file], { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 15000 })));
  const db = await openMemoryDb(file);
  assert.equal(countMemories(db, { scope: "global" }), 1);
});

test("team file backend isolates team IDs while preserving author and role filters", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "team.db");
  const alpha = fileSettings(file, "alpha");
  const beta = fileSettings(file, "beta");
  const authored = entry({ slug: "same-slug", project: "project-one", role: "builder" });
  const first = await teamRemember(root, alpha, authored);
  const second = await teamRemember(root, beta, authored);
  assert.notEqual(first.id, second.id);
  assert.equal((await teamRemember(root, alpha, authored)).duplicate, true);
  await teamRemember(root, beta, entry({ content: "Beta-only knowledge", role: "reviewer" }));
  assert.equal((await teamRecall(root, alpha, {})).length, 1);
  assert.deepEqual((await teamRecall(root, alpha, {}))[0].author, { project: "project-one", role: "builder" });
  assert.equal((await teamRecall(root, beta, {})).length, 2);
  assert.equal((await teamRecall(root, alpha, { query: "Beta-only" })).length, 0);
  assert.equal((await teamRecall(root, beta, { role: "reviewer" })).length, 1);
  const readonly = structuredClone(alpha);
  readonly.team.allowWrite = false;
  await assert.rejects(teamRemember(root, readonly, authored), code("team_read_only"));
});

test("team HTTP backend uses real protocol, bearer auth, namespace, and role query", async (t) => {
  const root = await fixture(t);
  const records = new Map();
  const tokenEnv = "AGENT_VAULT_TEST_TEAM_TOKEN";
  const previous = process.env[tokenEnv];
  process.env[tokenEnv] = "fixture-token";
  t.after(() => { if (previous === undefined) delete process.env[tokenEnv]; else process.env[tokenEnv] = previous; });
  let observedRole;
  const url = await service(t, async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    const target = new URL(req.url, "http://localhost");
    if (req.method === "POST" && target.pathname === "/api/v1/memories") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const value = JSON.parse(body);
      const items = records.get(value.teamId) ?? [];
      const id = `${value.teamId}-${items.length + 1}`;
      items.push({ ...value, id, updatedAt: "2026-11-17T00:00:00.000Z" });
      records.set(value.teamId, items);
      return json(res, { id });
    }
    assert.equal(target.pathname, "/api/v1/memories/search");
    observedRole = target.searchParams.get("role");
    return json(res, { items: (records.get(target.searchParams.get("teamId")) ?? []).filter((item) => !observedRole || item.author.role === observedRole) });
  });
  const alpha = httpSettings(url);
  alpha.team.tokenEnv = tokenEnv;
  const beta = structuredClone(alpha);
  beta.team.teamId = "beta";
  assert.equal((await teamRemember(root, alpha, entry({ role: "builder", project: "test" }))).id, "alpha-1");
  assert.equal((await teamRecall(root, beta, {})).length, 0);
  const recalled = await teamRecall(root, alpha, { query: "Exact", role: "builder" });
  assert.equal(observedRole, "builder");
  assert.equal(recalled[0].author.project, "test");
});

test("team HTTP rejects malformed payloads, missing ids, redirects, and oversized streaming responses", async (t) => {
  const root = await fixture(t);
  let mode = "missing-id";
  const url = await service(t, (req, res) => {
    if (mode === "redirect") { res.writeHead(302, { location: "/elsewhere?token=fixture-secret" }); return res.end(); }
    if (mode === "wrong-type") return res.end("not json");
    res.setHeader("content-type", "application/json");
    if (mode === "invalid-json") return res.end("{broken");
    if (mode === "bad-utf8") return res.end(Buffer.from([0xff]));
    if (mode === "oversized") { res.write(" ".repeat(600000)); return res.end(" ".repeat(600000)); }
    if (mode === "declared-oversized") { res.setHeader("content-length", "2000000"); return res.end("{}"); }
    if (mode === "missing-id") return json(res, {});
    if (mode === "bad-items") return json(res, { items: "invalid" });
    if (mode === "bad-item") return json(res, { items: [{ id: 1, title: "Title", content: 12 }] });
    if (mode === "null-item") return json(res, { items: [null] });
    if (mode === "bad-author") return json(res, { items: [{ id: 1, title: "Title", content: "Body", author: [] }] });
    if (mode === "error") { res.statusCode = 401; return res.end("fixture-secret"); }
  });
  const settings = httpSettings(url);
  await assert.rejects(teamRemember(root, settings, entry()), code("team_error"));
  for (mode of ["invalid-json", "wrong-type", "bad-utf8", "bad-items", "bad-item", "null-item", "bad-author", "error"]) {
    await assert.rejects(teamRecall(root, settings, {}), (error) => error.code === "team_error" && !error.message.includes("fixture-secret"));
  }
  for (mode of ["oversized", "declared-oversized"]) await assert.rejects(teamRecall(root, settings, {}), code("team_response_too_large"));
  mode = "redirect";
  await assert.rejects(teamRecall(root, settings, {}), (error) => error.code === "team_unreachable" && !error.message.includes("fixture-secret"));
  const badUrl = httpSettings("https://user:fixture-secret@example.test");
  await assert.rejects(teamRecall(root, badUrl, {}), (error) => error instanceof SettingsError && !error.message.includes("fixture-secret"));
});

test("legacy owned storage directories are tightened without changing vault ancestors or data", async (t) => {
  const vault = await fixture(t);
  await chmod(vault, 0o755);
  const directory = path.join(vault, ".agent-vault");
  await mkdir(directory);
  const log = path.join(directory, "access.jsonl");
  await writeFile(log, "retained access history\n");
  await chmod(directory, 0o775);
  const settings = loadSettings(vault);
  assert.equal(settings.join.default, "manual");
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  const db = await openMemoryDb(path.join(directory, "memory.db"));
  const saved = insertMemory(db, entry());
  assert.equal(getMemory(db, saved.memory.id).content, "Exact content");
  assert.equal(await readFile(log, "utf8"), "retained access history\n");
  assert.equal((await lstat(vault)).mode & 0o777, 0o755);
  const unrelated = path.join(vault, "unrelated");
  await mkdir(unrelated);
  await chmod(unrelated, 0o775);
  await assert.rejects(openMemoryDb(path.join(unrelated, "team.db")), code("path_unsafe"));
  assert.equal((await lstat(unrelated)).mode & 0o777, 0o775);
});
