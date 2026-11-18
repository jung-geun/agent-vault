import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  activeMemoryTasks, activityOf, closeMemoryDbs, dbTransaction, deferredReviews, embeddingCoverage,
  finishMemoryTask, getEmbeddings, getMemory, getReviewAction, insertMemory,
  memoryDbFile, memoryEmbeddingInput, openMemoryDb, openReviews, openVaultMemoryDb,
  putEmbeddings, queueMemoryFeedback, recordActivity, releaseReviews, reviewFeedback,
  resolveReviewRow, searchMemories, setStatus, stageReviewAction,
} from "../lib/memory-db.mjs";
import { beginMemoryTask, longMemoryRead } from "../lib/memory-tiers.mjs";
import { applyPersona, observePersona, readPersona, resolvePersona } from "../lib/persona.mjs";
import { loadDatabaseConfig, loadSettings, saveSettings } from "../lib/settings.mjs";
import { teamRecall, teamRemember } from "../lib/team-memory.mjs";
import { initVault, scaffoldProject } from "../lib/vault-core.mjs";
import { beginWeeklyTask, queryWeeklyMemory, syncWeeklyMemory, weeklyAttribution } from "../lib/weekly-memory.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/vault-cli.mjs", import.meta.url));
const storageModule = new URL("../lib/memory-db.mjs", import.meta.url).href;
const overrides = ["AGENT_VAULT_DB", "AGENT_VAULT_TEAM_DB"].flatMap((prefix) => ["DRIVER", "URL", "URL_FILE"].map((suffix) => `${prefix}_${suffix}`));
const beforeWeek = new Date("2026-11-15T12:00:00.000Z");
const now = new Date("2026-11-18T12:00:00.000Z");
const policy = { thresholds: [2], repeatEvery: 10 };
const model = "sql-storage-test-v1";
const vector = Buffer.from([0, 0, 0, 0, 0, 0, 192, 191, 0, 0, 128, 62]); // 0, -1.5, 0.25 (float32 LE)
const code = (expected) => (error) => error.code === expected;
const namespace = (project, role = "builder") => ({ scope: "project", project, role });
const reviewKey = (project) => `project:${project}:builder:long`;
const ids = (rows) => rows.map(({ id }) => id);

async function fixture(root, name, projects, database) {
  const vault = path.join(root, name);
  await initVault(vault);
  for (const project of projects) await scaffoldProject(vault, project, project);
  await saveSettings(vault, {
    weekly: { timeZone: "UTC", workdayStart: "09:00" },
    embedding: { provider: "off" },
    ...(database ? { database } : {}),
  });
  return vault;
}

function feedback(key, memoryId) {
  return { key, memoryId, trigger: "counterexample", feedback: "Verify the claim against the new result." };
}

function saveVector(db, memory, textHash = memoryEmbeddingInput(memory).textHash) {
  putEmbeddings(db, model, [{ memoryId: memory.id, dim: 3, vector, textHash }], now);
}

function assertVector(db, memory) {
  const entries = getEmbeddings(db, model, [memory.id]);
  assert.deepEqual([...entries.keys()], [memory.id]);
  const entry = entries.get(memory.id);
  assert.deepEqual({ ...entry, vector: Buffer.from(entry.vector) }, { dim: 3, vector, textHash: memoryEmbeddingInput(memory).textHash });
  assert.deepEqual(embeddingCoverage(db, model, [memory.id]), { embedded: 1, total: 1 });
  assert.equal(getEmbeddings(db, "another-model", [memory.id]).size, 0);
}

async function stagePersona(vault, project, memoryId, taskId) {
  const args = {
    scope: "project", project, category: "question_style", pattern: "concise-questions",
    guidance: "Ask one direct question at a time.", sourceKind: "user_preference", evidence: `memory:${memoryId}`, taskId,
  };
  const observed = await observePersona(vault, args, { now });
  assert.equal(observed.collected, true);
  const duplicate = await observePersona(vault, args, { now });
  assert.equal(duplicate.collected, false);
  assert.equal(duplicate.evidenceId, observed.evidenceId);
  const decision = { scope: args.scope, project, patternId: observed.patternId, action: "accept", expectedHash: observed.hash };
  await resolvePersona(vault, decision, { now });
  await assert.rejects(resolvePersona(vault, decision, { now }), code("hash_mismatch"));
  return { scope: args.scope, project, patternId: observed.patternId };
}

async function memoryContract(db, vault, project, otherProject) {
  const id = namespace(project);
  const entry = { ...id, slug: "portable-storage", title: "Portable storage", content: "Exact bytes." };
  const first = insertMemory(db, entry, now).memory;
  const duplicate = insertMemory(db, entry, now);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.memory.id, first.id);
  assert.throws(() => insertMemory(db, { ...entry, content: "Different bytes." }, now), code("exists"));
  const caseVariant = insertMemory(db, { ...entry, slug: null, content: "exact bytes." }, now);
  assert.equal(caseVariant.duplicate, false);

  const other = namespace(otherProject);
  const reviewer = namespace(project, "reviewer");
  const teamA = { scope: "team", teamId: project };
  const teamB = { scope: "team", teamId: otherProject };
  for (const scope of [other, reviewer, teamA, teamB]) {
    const stored = insertMemory(db, { slug: entry.slug, title: entry.title, content: entry.content, ...scope }, now);
    assert.equal(stored.duplicate, false);
    assert.deepEqual(ids(searchMemories(db, scope)), [stored.memory.id]);
  }
  assert.deepEqual(ids(searchMemories(db, id)), [caseVariant.memory.id, first.id]);
  assert.equal((await longMemoryRead(vault, { ...id, id: first.id }, { now })).content, entry.content);
  await assert.rejects(longMemoryRead(vault, { ...other, id: first.id }, { now }), code("not_found"));
  await assert.rejects(longMemoryRead(vault, { ...reviewer, id: first.id }, { now }), code("not_found"));

  const weekly = { weekKey: "2026-47", eventDate: "2026-11-18" };
  const padding = "x".repeat(2100);
  const best = insertMemory(db, { ...id, ...weekly, title: "Older match", content: `${padding} ÅNGSTRÖM 개발 Ångström 개발 ångström 개발` }, beforeWeek).memory;
  const next = insertMemory(db, { ...id, ...weekly, title: "Newer match", content: "ångström 개발" }, now).memory;
  for (let i = 0; i < 64; i++) insertMemory(db, { ...id, ...weekly, title: `Unrelated ${i}`, content: "Does not match." }, now);
  const partial = insertMemory(db, { ...id, ...weekly, title: "Only one term", content: "Ångström ".repeat(8) }, now).memory;
  insertMemory(db, { ...other, ...weekly, title: "Wrong project", content: best.content }, now);
  const query = { ...id, week: weekly.weekKey, query: "ÅNGSTRÖM 개발", limit: 1 };
  assert.deepEqual(ids(searchMemories(db, query)), [best.id]);
  const page = await queryWeeklyMemory(vault, query, { now });
  const second = await queryWeeklyMemory(vault, { ...query, offset: 1 }, { now });
  assert.deepEqual(ids(page.records), [best.id]);
  assert.deepEqual(ids(second.records), [next.id]);
  assert.equal(page.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.equal(page.records[0].content, padding.slice(0, 2000));
  assert.equal(page.records[0].totalChars, best.content.length);
  assert.equal(page.records[0].truncated, true);
  assert.equal(getMemory(db, best.id).readCount, 1);
  assert.equal(getMemory(db, partial.id).readCount, 0);

  saveVector(db, first, "0".repeat(64));
  assert.deepEqual(embeddingCoverage(db, model, [first.id]), { embedded: 0, total: 1 });
  saveVector(db, first);
  assertVector(db, first);
  return first;
}

function reviewContract(db, project, memoryId) {
  const key = reviewKey(project);
  const rollback = new Error("roll back test writes");
  recordActivity(db, key, "read", policy, beforeWeek);
  dbTransaction(db, () => {
    assert.throws(() => dbTransaction(db, () => {
      assert.equal(recordActivity(db, key, "write", policy, now).ticket.totalOps, 2);
      const queued = queueMemoryFeedback(db, feedback(key, memoryId), now);
      assert.equal(queued.created, true);
      assert.deepEqual(reviewFeedback(db, queued.review.id), [queued.feedback]);
      throw rollback;
    }), (error) => error === rollback);
    assert.equal(activityOf(db, key).writes, 0);
    assert.deepEqual(openReviews(db, key, { includePending: true }), []);
    recordActivity(db, key, "write", policy, now);
  });
  assert.throws(() => dbTransaction(db, () => {
    recordActivity(db, key, "write", policy, now);
    queueMemoryFeedback(db, feedback(key, memoryId), now);
    throw rollback;
  }), (error) => error === rollback);
  assert.deepEqual(activityOf(db, key), { reads: 1, writes: 1, level: 1, lastOpAt: now.toISOString() });
  const [review] = openReviews(db, key, { includePending: true });
  assert.equal(review.reason, "ops>=2");
  assert.equal(review.totalOps, 2);
  assert.deepEqual(reviewFeedback(db, review.id), []);

  const args = feedback(key, memoryId);
  const first = queueMemoryFeedback(db, args, now);
  assert.equal(first.review.id, review.id);
  assert.equal(first.created, true);
  assert.match(first.feedback.sourceHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(releaseReviews(db, [review.id], now), [review.id]);
  const again = queueMemoryFeedback(db, args, now);
  assert.equal(again.created, false);
  assert.deepEqual(again.feedback, first.feedback);
  assert.equal(again.review.state, "ready");
  const second = queueMemoryFeedback(db, { ...args, trigger: "outdated" }, now);
  assert.equal(second.created, true);
  assert.equal(second.review.state, "pending");
  assert.throws(() => db.prepare("UPDATE review_feedback SET feedback = ? WHERE id = ?").run("Rewrite", first.feedback.id), /immutable/i);
  assert.throws(() => db.prepare("DELETE FROM review_feedback WHERE id = ?").run(first.feedback.id), /immutable/i);
  assert.deepEqual(reviewFeedback(db, review.id), [first.feedback, second.feedback]);
  const legacyKey = `${key}:legacy`;
  const legacy = queueMemoryFeedback(db, feedback(legacyKey, memoryId), now).review;
  resolveReviewRow(db, legacy.id, "unstructured resolution", now);
  assert.deepEqual(deferredReviews(db, legacyKey), []);
  const deferred = queueMemoryFeedback(db, feedback(legacyKey, memoryId), now).review;
  resolveReviewRow(db, deferred.id, JSON.stringify({ action: "defer", sourceId: memoryId }), now);
  assert.equal(deferredReviews(db, legacyKey)[0]?.id, deferred.id);
  return review.id;
}

async function weeklyAndPersonaContract(db, vault, project, memoryId) {
  const taskId = `${project}-parent`;
  const childId = `${project}-child`;
  assert.equal((await beginWeeklyTask(vault, { taskId, ownerPid: process.pid }, { now: beforeWeek })).weekKey, "2026-46");
  assert.equal((await beginWeeklyTask(vault, { taskId: childId, ownerPid: process.pid, parentTaskId: taskId }, { now })).weekKey, "2026-46");
  const attribution = await weeklyAttribution(vault, { taskId: childId }, { now });
  assert.deepEqual(attribution, { taskId: childId, weekKey: "2026-46", eventDate: "2026-11-18" });
  const journal = insertMemory(db, { ...namespace(project), ...attribution, kind: "log", title: "Weekly receipt", content: "Task remained in its original week." }, now).memory;
  const scope = { scope: "project", project };
  const persona = await stagePersona(vault, project, memoryId, childId);
  assert.equal((await applyPersona(vault, scope, { now })).deferred, true);
  assert.equal((await readPersona(vault, persona)).active.length, 0);
  assert.equal((await syncWeeklyMemory(vault, scope, { now })).deferred, true);
  assert.equal(finishMemoryTask(db, { taskId: childId, completed: true }, now).ended, true);
  assert.equal(finishMemoryTask(db, { taskId, completed: true }, now).ended, true);
  assert.equal((await applyPersona(vault, scope, { now })).changed, 1);
  const applied = await readPersona(vault, persona);
  assert.equal(applied.active[0].id, persona.patternId);
  assert.equal(applied.active[0].status, "accepted");
  assert.equal(applied.active[0].decision.staged, false);

  const report = await syncWeeklyMemory(vault, scope, { now });
  const exported = `projects/${project}/weekly/2026-46.md`;
  assert.ok(report.written.includes(exported));
  assert.deepEqual(report.conflicts, []);
  const markdown = await readFile(path.join(vault, exported), "utf8");
  assert.match(markdown, new RegExp(`memory:${journal.id} \\^memory-${journal.id}`));
  assert.match(markdown, /Task remained in its original week/);
  assert.deepEqual((await syncWeeklyMemory(vault, scope, { now })).written, []);
  return { persona, applied };
}

async function seedMigration(vault, project) {
  const file = memoryDbFile(vault);
  const db = await openMemoryDb(file);
  const taskId = `${project}-task`;
  await beginWeeklyTask(vault, { taskId, ownerPid: process.pid }, { now: beforeWeek });
  const attribution = await weeklyAttribution(vault, { taskId }, { now });
  const entry = { ...namespace(project), ...attribution, slug: "migration", title: "이전 기록", content: "Preserve emoji 🧪, accents é, and line breaks.\n", tags: ["기록"] };
  const memory = insertMemory(db, entry, now).memory;
  const prior = insertMemory(db, { ...entry, slug: "prior", content: "Earlier form." }, beforeWeek).memory;
  setStatus(db, prior.id, "superseded", { supersededBy: memory.id }, now);
  const removed = insertMemory(db, { ...entry, slug: "removed", content: "Preserve the ID allocator head." }, now).memory.id;
  db.prepare("DELETE FROM memories WHERE id = ?").run(removed);
  saveVector(db, memory);
  const key = reviewKey(project);
  recordActivity(db, key, "write", policy, now);
  const queued = queueMemoryFeedback(db, feedback(key, memory.id), now);
  const action = stageReviewAction(db, queued.review.id, { action: "retain", memoryId: memory.id }, now);
  const persona = await stagePersona(vault, project, memory.id, taskId);
  finishMemoryTask(db, { taskId, completed: false }, now);
  const scope = { scope: "project", project };
  assert.equal((await applyPersona(vault, scope, { now })).changed, 1);
  const { written } = await syncWeeklyMemory(vault, scope, { now });
  assert.equal(written.length, 1);
  const state = {
    file, taskId, persona, scope, removed, memory: getMemory(db, memory.id), prior: getMemory(db, prior.id),
    profile: await readPersona(vault, persona), key, queued, action, exported: written[0],
    markdown: await readFile(path.join(vault, written[0])),
  };
  await closeMemoryDbs();
  return { ...state, bytes: await readFile(file) };
}

async function runCli(vault, args, env = process.env) {
  try {
    const { stdout } = await exec(process.execPath, [cli, "memory", "migrate-db", "--path", vault, ...args], { cwd: vault, env, timeout: 30_000 });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

function migrationResult(output) {
  assert.equal(output.status, 0, output.stderr);
  return JSON.parse(output.stdout);
}

async function migrationContract(sourceVault, source, vault, driver) {
  const from = ["--from-sqlite", source.file];
  const offline = { ...process.env, AGENT_VAULT_DB_DRIVER: "postgres", AGENT_VAULT_DB_URL_FILE: path.join(vault, "missing-dsn") };
  const preview = migrationResult(await runCli(vault, [...from, "--dry-run"], offline));
  assert.equal(preview.dryRun, true);
  assert.ok(Number(preview.sourceSchema) > 0);
  for (const [table, count] of Object.entries({
    memories: 2, memory_embeddings: 1, activity: 1, reviews: 1, review_feedback: 1,
    review_actions: 1, memory_tasks: 1, weekly_task_attributions: 1, weekly_exports: 1,
    persona_profiles: 1, persona_patterns: 1, persona_evidence: 1, persona_decisions: 1,
  })) assert.equal(preview.counts[table], count, table);
  assert.ok(preview.counts.meta >= 1);
  assert.deepEqual(await readFile(source.file), source.bytes);
  await assert.rejects(stat(memoryDbFile(vault)), code("ENOENT"));
  const wrongSource = await runCli(vault, [...from, "--team", "--dry-run"], offline);
  assert.equal(wrongSource.status, 1);
  assert.match(wrongSource.stderr, /dedicated SQLite team file/);
  if (driver === "sqlite") return;

  const targetMarkdown = path.join(vault, source.exported);
  await writeFile(targetMarkdown, source.markdown);
  // The CLI's empty-target check must pass before this test writes any remote fixtures.
  const imported = migrationResult(await runCli(vault, from));
  assert.equal(imported.dryRun, false);
  assert.equal(imported.driver, driver);
  assert.deepEqual(imported.counts, preview.counts);
  const repeated = await runCli(vault, from);
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /\bempty\b|\bnonempty\b/i);
  assert.deepEqual(await readFile(source.file), source.bytes);
  assert.deepEqual(await readFile(path.join(sourceVault, source.exported)), source.markdown);
  assert.deepEqual(await readFile(targetMarkdown), source.markdown);
  await assert.rejects(stat(memoryDbFile(vault)), code("ENOENT"));

  const db = await openVaultMemoryDb(vault, { existing: true });
  assert.deepEqual(getMemory(db, source.memory.id), source.memory);
  assert.deepEqual(getMemory(db, source.prior.id), source.prior);
  assertVector(db, source.memory);
  assert.deepEqual(activityOf(db, source.key), { reads: 0, writes: 1, level: 0, lastOpAt: now.toISOString() });
  assert.deepEqual(openReviews(db, source.key, { includePending: true }), [{ ...source.queued.review, feedback: [source.queued.feedback] }]);
  assert.deepEqual(getReviewAction(db, source.queued.review.id), source.action);
  assert.deepEqual(await readPersona(vault, source.persona), source.profile);
  const synced = await syncWeeklyMemory(vault, source.scope, { now });
  assert.deepEqual(synced.conflicts, [], "migration must preserve the weekly export manifest");
  assert.deepEqual(synced.written, []);

  const taskId = `${source.taskId}-resumed`;
  const resumed = await beginMemoryTask(vault, { taskId, ownerPid: process.pid, resumeTaskId: source.taskId }, { now });
  assert.equal(resumed.weekKey, "2026-46");
  assert.equal(resumed.contextRevision, 1);
  assert.equal(finishMemoryTask(db, { taskId, completed: true }, now).ended, true);
}

async function concurrentContract(vault, db, project) {
  const script = `
    import { closeMemoryDbs, dbTransaction, insertMemory, openVaultMemoryDb, recordActivity } from ${JSON.stringify(storageModule)};
    const [vault, project, key] = process.argv.slice(1);
    try {
      const db = await openVaultMemoryDb(vault);
      const result = dbTransaction(db, () => {
        const { memory, duplicate } = insertMemory(db, { scope: "project", project, title: "Concurrent write", content: "Same content." });
        recordActivity(db, key, "write", ${JSON.stringify(policy)});
        return { id: memory.id, duplicate };
      });
      console.log(JSON.stringify(result));
    } finally { await closeMemoryDbs(); }
  `;
  const key = `${reviewKey(project)}:concurrent`;
  const write = async () => {
    const result = await exec(process.execPath, ["--input-type=module", "-e", script, vault, project, key], { cwd: vault, timeout: 30_000 });
    return JSON.parse(result.stdout);
  };
  const [one, two] = (await Promise.allSettled([write(), write()])).map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  assert.equal(one.id, two.id);
  assert.equal(Number(one.duplicate) + Number(two.duplicate), 1);
  assert.equal(activityOf(db, key).writes, 2);
  const reviews = openReviews(db, key, { includePending: true });
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].totalOps, 2);
}

async function teamContract(vault, driver, personalUrlEnv, teamUrlEnv) {
  const teamId = "portable-team";
  const entry = { project: "portable-test", role: "builder", title: "Team database", content: "Separate shared memory." };
  const teamSettings = (urlEnv) => ({ enabled: true, backend: "sql", teamId, database: { driver, urlEnv } });
  const wrong = await saveSettings(vault, { team: teamSettings(personalUrlEnv) });
  await assert.rejects(teamRecall(vault, wrong), code("database_scope_mismatch"));
  if (!process.env[teamUrlEnv]) return;

  const source = path.join(vault, "old-team.db");
  const old = await openMemoryDb(source);
  const { memory } = insertMemory(old, { ...entry, scope: "team", teamId }, now);
  old.close();
  const bytes = await readFile(source);
  const settings = await saveSettings(vault, { team: teamSettings(teamUrlEnv) });
  const args = ["--team", "--from-sqlite", source];
  const preview = migrationResult(await runCli(vault, [...args, "--dry-run"]));
  const result = migrationResult(await runCli(vault, args));
  assert.equal(result.driver, driver);
  assert.deepEqual(result.counts, preview.counts);
  assert.equal(result.counts.memories, 1);
  assert.deepEqual(await readFile(source), bytes);
  const found = await teamRecall(vault, settings, { query: "shared" });
  assert.equal(found[0]?.id, memory.id);
  assert.equal(found[0]?.content, entry.content);
  assert.deepEqual(await teamRecall(vault, { ...settings, team: { ...settings.team, teamId: "other-team" } }), []);
  const duplicate = await teamRemember(vault, settings, entry, now);
  assert.equal(duplicate.id, memory.id);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.backend, "sql");
  assert.equal((await teamRemember(vault, settings, { ...entry, content: "Second team row." }, now)).duplicate, false);
  await assert.rejects(teamRemember(vault, { ...settings, team: { ...settings.team, allowWrite: false } }, entry, now), code("team_read_only"));
}

test("DSN file and environment selection never enter settings or diagnostics", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-vault-dsn-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = "synthetic-local-password";
  const dsn = `postgresql://vault:${secret}@127.0.0.1/agent_vault`;
  const file = path.join(root, "database-dsn");
  await writeFile(file, `${dsn}\n`, { mode: 0o600 });
  const vault = await fixture(root, "vault", [], { driver: "postgres", urlFile: file });
  assert.equal(loadDatabaseConfig(vault, {}).driver, "postgres");
  assert.equal(loadDatabaseConfig(vault, { AGENT_VAULT_DB_DRIVER: "sqlite" }).driver, "sqlite");
  assert.ok(!JSON.stringify(loadSettings(vault)).includes(secret));
  await chmod(file, 0o644);
  assert.throws(() => loadDatabaseConfig(vault, {}), /owner-only/);
  assert.equal(loadDatabaseConfig(vault, { AGENT_VAULT_DB_URL: dsn }).driver, "postgres");
  assert.throws(() => loadDatabaseConfig(vault, { AGENT_VAULT_DB_URL: `invalid ${secret}` }), (error) =>
    /Configure a database URL/.test(error.message) && !error.message.includes(secret));
  await assert.rejects(exec(process.execPath, [cli, "config", "--path", vault, "--db-driver", "postgres", dsn]), (error) =>
    error.code === 1 && /unexpected positional argument/.test(error.stderr) && !error.stderr.includes(secret));
});

function scrub(error, dsn) {
  const redact = (value) => {
    let text = String(value).replaceAll(dsn, "[redacted DSN]").replace(/\b(?:postgres(?:ql)?|mysql|mariadb):\/\/[^\s'"`<>]+/gi, "[redacted DSN]");
    try {
      const password = new URL(dsn).password;
      if (password) text = text.replaceAll(password, "[redacted password]").replaceAll(decodeURIComponent(password), "[redacted password]");
    } catch { /* The URL itself was already redacted. */ }
    return text;
  };
  const sanitized = new Error(redact(error.message));
  sanitized.stack = redact(error.stack ?? error.message);
  return sanitized;
}

for (const [driver, urlEnv, teamUrlEnv] of [
  ["sqlite"], ["postgres", "AGENT_VAULT_TEST_PG_URL", "AGENT_VAULT_TEST_TEAM_PG_URL"], ["mysql", "AGENT_VAULT_TEST_MYSQL_URL", "AGENT_VAULT_TEST_TEAM_MYSQL_URL"],
]) {
  const dsn = urlEnv && process.env[urlEnv];
  test(`${driver} storage contract`, { skip: urlEnv && !dsn ? `set ${urlEnv} to an empty disposable database` : false, timeout: 120_000 }, async (t) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-vault-sql-contract-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const saved = overrides.map((key) => process.env[key]);
    for (const key of overrides) delete process.env[key];
    try {
      try {
        const prefix = `sql-test-${randomBytes(6).toString("hex")}`;
        const [project, other, migration] = [prefix, `${prefix}-other`, `${prefix}-migration`];
        const sourceVault = await fixture(root, "source", [migration]);
        const source = await seedMigration(sourceVault, migration);
        const vault = await fixture(root, "destination", [project, other, migration], urlEnv && { driver, urlEnv });
        // SQL destinations are single-use. Never truncate or drop anything, even on failure.
        await migrationContract(sourceVault, source, vault, driver);
        const db = await openVaultMemoryDb(vault);
        const memory = await memoryContract(db, vault, project, other);
        const reviewId = reviewContract(db, project, memory.id);
        const { persona, applied } = await weeklyAndPersonaContract(db, vault, project, memory.id);
        await concurrentContract(vault, db, project);
        if (urlEnv) {
          assert.ok(memory.id > source.removed);
          assert.ok(reviewId > source.queued.review.id);
          assert.ok(persona.patternId > source.persona.patternId);
          await teamContract(vault, driver, urlEnv, teamUrlEnv);
        }
        await closeMemoryDbs();
        const reopened = await openVaultMemoryDb(vault, { existing: true });
        assertVector(reopened, memory);
        assert.deepEqual(await readPersona(vault, persona), applied);
        assert.deepEqual(activeMemoryTasks(reopened), []);
        if (urlEnv) await assert.rejects(stat(memoryDbFile(vault)), code("ENOENT"));
      } finally {
        await closeMemoryDbs();
      }
    } catch (error) {
      throw dsn ? scrub(error, dsn) : error;
    } finally {
      for (const [index, key] of overrides.entries()) {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      }
    }
  });
}
