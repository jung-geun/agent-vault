import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, link, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveSettings } from "../lib/settings.mjs";
import { closeMemoryDbs, dedupeExact, finishMemoryTask, getMemory, insertMemory, openMemoryDb, searchMemories, setStatus } from "../lib/memory-db.mjs";
import { calendarMonthCutoff, validateCalendarDate, validateWeekKey, workCalendar } from "../lib/work-calendar.mjs";
import { beginWeeklyTask, queryWeeklyMemory, syncWeeklyMemory, weeklyAttribution } from "../lib/weekly-memory.mjs";

const run = promisify(execFile);
const at = (value) => ({ now: new Date(value) });
const calendar = (value, settings = {}) => workCalendar(new Date(value), { timeZone: "UTC", workdayStart: "09:00", ...settings });
const code = (expected) => (error) => error.code === expected;
const journal = (extra = {}) => ({ scope: "project", project: "alpha", kind: "log", title: "Work receipt", content: "SQLite archive proof", weekKey: "2026-47", eventDate: "2026-11-18", ...extra });
async function fixture(t, weekly = {}) {
  const vault = await realpath(await mkdtemp(path.join(tmpdir(), "agent-vault-weekly-")));
  t.after(async () => { closeMemoryDbs(); await rm(vault, { recursive: true, force: true }); });
  await mkdir(path.join(vault, "projects/alpha"), { recursive: true });
  await mkdir(path.join(vault, "projects/beta"), { recursive: true });
  await saveSettings(vault, { weekly: { timeZone: "UTC", workdayStart: "09:00", retentionMonths: 3, ...weekly } });
  return { vault, db: await openMemoryDb(path.join(vault, ".agent-vault/memory.db")) };
}

test("work calendar uses ISO week-years and local workday cutoff", () => {
  assert.deepEqual(calendar("2026-11-17T08:59:59Z"), { weekKey: "2026-47", eventDate: "2026-11-17", weekday: "Tuesday", businessDate: "2026-11-16", timezone: "UTC" });
  assert.equal(calendar("2026-11-16T08:59:59Z").weekKey, "2026-46");
  assert.equal(calendar("2026-11-16T09:00:00Z").weekKey, "2026-47");
  assert.equal(calendar("2021-01-01T12:00:00Z").weekKey, "2020-53");
  assert.equal(calendar("2018-12-31T12:00:00Z").weekKey, "2019-01");
  assert.equal(calendar("2024-03-01T08:00:00Z").businessDate, "2024-02-29");
  assert.equal(calendar("2026-01-01T00:00:00Z").businessDate, "2025-12-31");
  assert.equal(calendar("2026-11-15T16:00:00Z", { timeZone: "Asia/Seoul" }).eventDate, "2026-11-16");
  assert.equal(calendar("2026-11-15T16:00:00Z", { timeZone: "Asia/Seoul" }).weekKey, "2026-46");
});

test("DST transitions use local calendar days, not 24-hour timestamp subtraction", () => {
  const settings = { timeZone: "America/New_York", workdayStart: "03:00" };
  assert.equal(calendar("2026-03-08T06:59:00Z", settings).businessDate, "2026-03-07");
  assert.equal(calendar("2026-03-08T07:00:00Z", settings).businessDate, "2026-03-08");
  assert.equal(calendar("2026-11-01T05:30:00Z", settings).businessDate, "2026-10-31");
  assert.equal(calendar("2026-11-01T06:30:00Z", settings).businessDate, "2026-10-31");
  assert.equal(calendar("2026-11-01T08:00:00Z", settings).businessDate, "2026-11-01");
  assert.equal(calendar("2026-03-09T04:30:00Z", { ...settings, workdayStart: "09:00" }).businessDate, "2026-03-08");
});

test("calendar validates dates, weeks, cutoff settings and clamps calendar-month retention", () => {
  for (const date of ["2026-02-29", "2026-04-31", "2026-1-01", "0000-01-01"]) assert.throws(() => validateCalendarDate(date), code("invalid_calendar"));
  for (const week of ["2025-53", "2026-00", "2026-54", "2026-W47"]) assert.throws(() => validateWeekKey(week), code("invalid_calendar"));
  assert.equal(validateWeekKey("2026-53"), "2026-53");
  assert.equal(calendarMonthCutoff("2026-05-31", 3), "2026-02-28");
  assert.equal(calendarMonthCutoff("2024-03-31", 1), "2024-02-29");
  assert.equal(calendarMonthCutoff("2026-01-31", 6), "2025-07-31");
  assert.throws(() => calendarMonthCutoff("2026-01-31", 7), code("invalid_calendar"));
  assert.throws(() => calendar("2026-11-18T12:00:00Z", { timeZone: "invalid/zone" }), code("invalid_calendar"));
  assert.throws(() => calendar("2026-11-18T12:00:00Z", { workdayStart: "24:00" }), code("invalid_calendar"));
});

test("tasks pin Sunday through Monday; child and resume inherit; new tasks get a new week", async (t) => {
  const { vault, db } = await fixture(t);
  const old = await beginWeeklyTask(vault, { taskId: "old", ownerPid: process.pid }, at("2026-11-15T12:00:00Z"));
  assert.equal(old.weekKey, "2026-46");
  assert.deepEqual(await weeklyAttribution(vault, { taskId: "old" }, at("2026-11-16T12:00:00Z")), { taskId: "old", weekKey: "2026-46", eventDate: "2026-11-16" });
  const child = await beginWeeklyTask(vault, { taskId: "child", ownerPid: process.pid, parentTaskId: "old" }, at("2026-11-16T12:00:00Z"));
  assert.equal(child.weekKey, "2026-46");
  assert.equal((await beginWeeklyTask(vault, { taskId: "child", ownerPid: process.pid }, at("2026-11-17T12:00:00Z"))).started, false);
  finishMemoryTask(db, { taskId: "old", completed: false });
  const resumed = await beginWeeklyTask(vault, { taskId: "resume", ownerPid: process.pid, resumeTaskId: "old" }, at("2026-11-16T12:00:00Z"));
  assert.equal(resumed.weekKey, "2026-46");
  const fresh = await beginWeeklyTask(vault, { taskId: "fresh", ownerPid: process.pid }, at("2026-11-16T12:00:00Z"));
  assert.equal(fresh.weekKey, "2026-47");
  await saveSettings(vault, { weekly: { workdayStart: "00:00", timeZone: "Asia/Seoul" } });
  assert.equal((await weeklyAttribution(vault, { taskId: "resume" }, at("2026-11-22T16:00:00Z"))).weekKey, "2026-46");
  assert.equal((await weeklyAttribution(vault, { taskId: "resume" }, at("2026-11-22T16:00:00Z"))).eventDate, "2026-11-23");
});

test("task attribution refuses ambiguity, invalid relations, owner conflicts and closed reuse atomically", async (t) => {
  const { vault, db } = await fixture(t);
  await beginWeeklyTask(vault, { taskId: "one", ownerPid: process.pid });
  assert.equal((await weeklyAttribution(vault)).taskId, "one");
  await beginWeeklyTask(vault, { taskId: "two", ownerPid: process.pid });
  await assert.rejects(weeklyAttribution(vault), code("memory_task_ambiguous"));
  await assert.rejects(beginWeeklyTask(vault, { taskId: "bad", ownerPid: process.pid, parentTaskId: "missing" }), code("invalid_task_relation"));
  assert.equal(db.prepare("SELECT id FROM memory_tasks WHERE id = 'bad'").get(), undefined);
  await assert.rejects(beginWeeklyTask(vault, { taskId: "one", ownerPid: process.ppid }), code("memory_task_owner_mismatch"));
  await assert.rejects(beginWeeklyTask(vault, { taskId: "one", ownerPid: process.pid, parentTaskId: "two" }), code("task_attribution_conflict"));
  await assert.rejects(beginWeeklyTask(vault, { taskId: "self", ownerPid: process.pid, parentTaskId: "self" }), code("invalid_task_relation"));
  await assert.rejects(beginWeeklyTask(vault, { taskId: "both", ownerPid: process.pid, parentTaskId: "one", resumeTaskId: "two" }), code("invalid_task_relation"));
  finishMemoryTask(db, { taskId: "one", completed: true });
  finishMemoryTask(db, { taskId: "two", completed: false });
  await assert.rejects(weeklyAttribution(vault, { taskId: "one" }), code("memory_task_closed"));
  await assert.rejects(weeklyAttribution(vault, { taskId: "missing" }), code("memory_task_closed"));
  await assert.rejects(beginWeeklyTask(vault, { taskId: "one", ownerPid: process.pid }), code("memory_task_closed"));
  await assert.rejects(beginWeeklyTask(vault, { taskId: "invalid-resume", ownerPid: process.pid, resumeTaskId: "one" }), code("invalid_task_relation"));
  assert.equal((await weeklyAttribution(vault)).taskId, null);
});

test("journal insertion never deduplicates events and knowledge search excludes journal kinds", async (t) => {
  const { db } = await fixture(t);
  const first = insertMemory(db, journal({ taskId: "a" })).memory;
  const second = insertMemory(db, journal({ taskId: "a" })).memory;
  const third = insertMemory(db, journal({ taskId: "b", eventDate: "2026-11-19" })).memory;
  const knowledge = insertMemory(db, journal({ kind: "knowledge", title: "Knowledge" })).memory;
  assert.notEqual(first.id, second.id);
  assert.notEqual(second.id, third.id);
  assert.deepEqual(searchMemories(db, { scope: "project", project: "alpha" }).map((row) => row.id), [knowledge.id]);
  assert.equal(searchMemories(db, { scope: "project", project: "alpha", kind: null }).length, 4);
  assert.deepEqual(dedupeExact(db, { scope: "project", project: "alpha" }), []);
  assert.equal(getMemory(db, third.id).taskId, "b");
  assert.equal(getMemory(db, third.id).eventDate, "2026-11-19");
});

test("knowledge search preserves update timestamps despite journal event dates", async (t) => {
  const { db } = await fixture(t);
  const late = insertMemory(db, journal({ kind: "knowledge", title: "Afternoon update" }), new Date("2026-11-18T15:00:00Z")).memory;
  const early = insertMemory(db, journal({ kind: "knowledge", title: "Morning update" }), new Date("2026-11-18T09:00:00Z")).memory;
  const old = insertMemory(db, journal({ kind: "knowledge", title: "Older knowledge", eventDate: "2026-11-01", weekKey: "2026-44" }), new Date("2026-11-01T12:00:00Z")).memory;
  const ids = () => searchMemories(db, { scope: "project", project: "alpha" }).map((memory) => memory.id);
  assert.deepEqual(ids(), [late.id, early.id, old.id]);
  setStatus(db, old.id, "active", {}, new Date("2026-11-18T16:00:00Z"));
  assert.deepEqual(ids(), [old.id, late.id, early.id]);
});

test("weekly recall counts only returned knowledge rows with the injected read time", async (t) => {
  const { vault, db } = await fixture(t);
  const created = new Date("2026-11-18T12:00:00Z");
  const sentinel = insertMemory(db, journal({ kind: "knowledge", title: "Pagination sentinel" }), created).memory;
  const log = insertMemory(db, journal({ title: "Journal receipt" }), created).memory;
  const returned = insertMemory(db, journal({ kind: "knowledge", title: "Returned knowledge" }), created).memory;
  const now = new Date("2026-11-18T14:30:00Z");
  const page = await queryWeeklyMemory(vault, { project: "alpha", limit: 2 }, { now });
  assert.deepEqual(page.records.map((memory) => memory.id), [returned.id, log.id]);
  assert.equal(page.hasMore, true);
  assert.equal(getMemory(db, returned.id).readCount, 1);
  assert.equal(getMemory(db, returned.id).lastReadAt, now.toISOString());
  assert.equal(getMemory(db, log.id).readCount, 0);
  assert.equal(getMemory(db, log.id).lastReadAt, null);
  assert.equal(getMemory(db, sentinel.id).readCount, 0);
  assert.equal(getMemory(db, sentinel.id).lastReadAt, null);
  const later = new Date("2026-11-18T15:00:00Z");
  await queryWeeklyMemory(vault, { project: "alpha", offset: 2, limit: 1 }, { now: later });
  assert.equal(getMemory(db, sentinel.id).readCount, 1);
  assert.equal(getMemory(db, sentinel.id).lastReadAt, later.toISOString());
  assert.equal(getMemory(db, returned.id).readCount, 1);
});

test("weekly query conjoins keywords, dates, role, week and namespace with bounded pagination", async (t) => {
  const { vault, db } = await fixture(t);
  const one = insertMemory(db, journal({ role: "builder", content: `sqlite archive sqlite archive ${"x".repeat(10000)}` })).memory;
  const two = insertMemory(db, journal({ role: "builder", eventDate: "2026-11-19", content: "sqlite archive" })).memory;
  insertMemory(db, journal({ role: "reviewer" }));
  insertMemory(db, journal({ project: "beta", role: "builder" }));
  insertMemory(db, journal({ scope: "global", project: null, role: "builder" }));
  insertMemory(db, journal({ role: "builder", eventDate: "2026-11-20", content: "sqlite only" }));
  setStatus(db, one.id, "superseded", { supersededBy: two.id });
  const args = { scope: "project", project: "alpha", role: "builder", query: "sqlite archive", from: "2026-11-18", to: "2026-11-19", week: "2026-47", limit: 1 };
  const page = await queryWeeklyMemory(vault, args);
  const next = await queryWeeklyMemory(vault, { ...args, offset: 1 });
  assert.equal(page.hasMore, true);
  assert.equal(next.hasMore, false);
  assert.equal(page.records[0].id, one.id);
  assert.equal(page.records[0].status, "superseded");
  assert.equal(page.records[0].ref, `memory:${one.id}`);
  assert.equal(page.records[0].content.length, 2000);
  assert.equal(page.records[0].truncated, true);
  assert.equal(next.records[0].id, two.id);
  assert.equal((await queryWeeklyMemory(vault, { scope: "global" })).records.length, 1);
  assert.equal((await queryWeeklyMemory(vault, { scope: "global", cwd: "/nonexistent/ambient-checkout" })).records.length, 1);
  for (const invalid of [{ from: "2026-02-29" }, { from: "2026-11-20", to: "2026-11-01" }, { week: "2025-53" }, { offset: -1 }, { limit: 101 }, { kind: "log' OR 1=1" }]) {
    await assert.rejects(queryWeeklyMemory(vault, { scope: "global", ...invalid }));
  }
  await assert.rejects(queryWeeklyMemory(vault, { scope: "team" }), code("invalid_scope"));
  await assert.rejects(queryWeeklyMemory(vault, { scope: "project", project: "missing" }), code("project_unresolved"));
  await assert.rejects(queryWeeklyMemory(vault, { scope: "global", project: "alpha" }), code("invalid_scope"));
  await assert.rejects(queryWeeklyMemory(vault, { scope: "project", project: "../alpha" }), code("invalid_project"));
});

test("idle exports group every role and kind into one week with truthful immutable references", async (t) => {
  const { vault, db } = await fixture(t);
  const a = insertMemory(db, journal({ role: "builder", worktree: "main", taskId: "task" })).memory;
  const b = insertMemory(db, journal({ role: "reviewer", kind: "knowledge", eventDate: "2026-11-19" })).memory;
  setStatus(db, a.id, "superseded", { supersededBy: b.id });
  await beginWeeklyTask(vault, { taskId: "active", ownerPid: process.pid });
  assert.equal((await syncWeeklyMemory(vault, {}, at("2026-11-20T12:00:00Z"))).deferred, true);
  assert.equal(fs.existsSync(path.join(vault, "projects/alpha/weekly/2026-47.md")), false);
  finishMemoryTask(db, { taskId: "active", completed: true });
  const sync = await syncWeeklyMemory(vault, {}, at("2026-11-20T12:00:00Z"));
  assert.deepEqual(sync.written, ["projects/alpha/weekly/2026-47.md"]);
  const content = await readFile(path.join(vault, sync.written[0]), "utf8");
  assert.match(content, /2026-11-18 — Wednesday/);
  assert.match(content, /2026-11-19 — Thursday/);
  assert.match(content, /log · builder · main/);
  assert.match(content, /knowledge · reviewer/);
  assert.match(content, new RegExp(`memory:${a.id} \\^memory-${a.id}`));
  assert.match(content, new RegExp(`Status: superseded; superseded by memory:${b.id}`));
  assert.equal((await syncWeeklyMemory(vault, {}, at("2026-11-20T12:00:00Z"))).written.length, 0);
});

test("global exports ignore ambient cwd and default synchronization still exports all namespaces", async (t) => {
  const { vault, db } = await fixture(t);
  insertMemory(db, journal());
  insertMemory(db, journal({ scope: "global", project: null }));
  const global = await syncWeeklyMemory(vault, { scope: "global", cwd: "/nonexistent/ambient-checkout" }, at("2026-11-20T12:00:00Z"));
  assert.deepEqual(global.written, ["shared/knowledge/weekly/2026-47.md"]);
  assert.equal(fs.existsSync(path.join(vault, "projects/alpha/weekly/2026-47.md")), false);
  const all = await syncWeeklyMemory(vault, {}, at("2026-11-20T12:00:00Z"));
  assert.deepEqual(all.written, ["projects/alpha/weekly/2026-47.md"]);
  await assert.rejects(syncWeeklyMemory(vault, { scope: "global", project: "alpha", cwd: process.cwd() }), code("invalid_scope"));
});

test("imported exports strip only leading YAML while SQLite retains exact source bytes", async (t) => {
  const { vault, db } = await fixture(t);
  const imported = "---\ntags: [legacy-only-tag]\ntitle: Original\n---\n\nImported body.\n---\nbody-divider: keep\n---\n";
  const crlf = "---\r\ntags: [crlf-only-tag]\r\n---\r\nCRLF body.\r\n";
  const native = "---\ntags: [native-only-tag]\n---\nNative content.\n";
  const unclosed = "---\ntags: [unclosed-only-tag]\nUnclosed source.\n";
  const interior = "Body before header.\n---\ntags: [interior-only-tag]\n---\n";
  const rows = [
    insertMemory(db, journal({ sourcePath: "legacy/imported.md", content: imported })).memory,
    insertMemory(db, journal({ sourcePath: "legacy/crlf.md", content: crlf })).memory,
    insertMemory(db, journal({ content: native })).memory,
    insertMemory(db, journal({ sourcePath: "legacy/unclosed.md", content: unclosed })).memory,
    insertMemory(db, journal({ sourcePath: "legacy/interior.md", content: interior })).memory,
  ];
  const result = await syncWeeklyMemory(vault, {}, at("2026-11-20T12:00:00Z"));
  assert.deepEqual(result.conflicts, []);
  const content = await readFile(path.join(vault, "projects/alpha/weekly/2026-47.md"), "utf8");
  assert.doesNotMatch(content, /legacy-only-tag|crlf-only-tag/);
  assert.ok(content.includes("\nImported body.\n---\nbody-divider: keep\n---\n"));
  assert.ok(content.includes("CRLF body.\r\n"));
  for (const body of [native, unclosed, interior]) assert.ok(content.includes(body));
  for (const [index, body] of [imported, crlf, native, unclosed, interior].entries()) assert.equal(getMemory(db, rows[index].id).content, body);
});

test("retention deletes only old untouched generated Markdown, never SQLite or fresh carryover", async (t) => {
  const { vault, db } = await fixture(t, { retentionMonths: 1 });
  const old = insertMemory(db, journal({ weekKey: "2026-35", eventDate: "2026-08-25" })).memory;
  const carryoverOld = insertMemory(db, journal({ weekKey: "2026-36", eventDate: "2026-08-31", content: "Expired carryover event" })).memory;
  await syncWeeklyMemory(vault, {}, at("2026-09-01T12:00:00Z"));
  const carryoverFresh = insertMemory(db, journal({ weekKey: "2026-36", eventDate: "2026-11-18", content: "Fresh carryover event" })).memory;
  const result = await syncWeeklyMemory(vault, {}, at("2026-11-18T12:00:00Z"));
  assert.deepEqual(result.deleted, ["projects/alpha/weekly/2026-35.md"]);
  assert.ok(result.written.includes("projects/alpha/weekly/2026-36.md"));
  const carryoverMarkdown = await readFile(path.join(vault, "projects/alpha/weekly/2026-36.md"), "utf8");
  assert.ok(carryoverMarkdown.includes("Fresh carryover event"));
  assert.ok(!carryoverMarkdown.includes("Expired carryover event"));
  assert.ok(!carryoverMarkdown.includes("2026-08-31"));
  const carryoverQuery = await queryWeeklyMemory(vault, { project: "alpha", week: "2026-36" });
  assert.deepEqual(carryoverQuery.records.map((memory) => memory.id).sort((a, b) => a - b), [carryoverOld.id, carryoverFresh.id]);
  assert.equal(getMemory(db, carryoverOld.id).content, "Expired carryover event");
  assert.equal(getMemory(db, old.id).content, old.content);
  assert.equal((await queryWeeklyMemory(vault, { project: "alpha", week: "2026-35" })).records[0].id, old.id);
  // Importing a historical event now must not revive its expired week.
  insertMemory(db, journal({ weekKey: "2026-34", eventDate: "2026-08-20" }), new Date("2026-11-18T12:00:00Z"));
  await syncWeeklyMemory(vault, {}, at("2026-11-18T12:00:00Z"));
  assert.equal(fs.existsSync(path.join(vault, "projects/alpha/weekly/2026-34.md")), false);
});

test("retention and re-export preserve modified, foreign, symlinked and hardlinked notes", async (t) => {
  const { vault, db } = await fixture(t, { retentionMonths: 1 });
  const relative = "projects/alpha/weekly/2026-35.md";
  const file = path.join(vault, relative);
  insertMemory(db, journal({ weekKey: "2026-35", eventDate: "2026-08-25" }));
  await syncWeeklyMemory(vault, {}, at("2026-09-01T12:00:00Z"));
  await writeFile(file, "Human edit\n");
  assert.equal((await syncWeeklyMemory(vault, {}, at("2026-11-18T12:00:00Z"))).conflicts[0].path, relative);
  assert.equal(await readFile(file, "utf8"), "Human edit\n");
  await rm(file);
  const other = path.join(vault, "foreign.md");
  await writeFile(other, "Untouched foreign file\n");
  await symlink(other, file);
  assert.equal((await syncWeeklyMemory(vault, {}, at("2026-11-18T12:00:00Z"))).conflicts.length, 1);
  assert.equal(await readFile(other, "utf8"), "Untouched foreign file\n");
  await rm(file);
  await link(other, file);
  assert.equal((await syncWeeklyMemory(vault, {}, at("2026-11-18T12:00:00Z"))).conflicts.length, 1);
  assert.equal(await readFile(other, "utf8"), "Untouched foreign file\n");
  await rm(file);
  insertMemory(db, journal({ weekKey: "2026-47" }));
  const current = path.join(vault, "projects/alpha/weekly/2026-47.md");
  await writeFile(current, "Foreign current week\n");
  const result = await syncWeeklyMemory(vault, {}, at("2026-11-18T12:00:00Z"));
  assert.ok(result.conflicts.some((conflict) => conflict.path.endsWith("2026-47.md")));
  assert.equal(await readFile(current, "utf8"), "Foreign current week\n");
});

test("selected exports isolate namespaces and refuse symlinked parent directories", async (t) => {
  const { vault, db } = await fixture(t);
  insertMemory(db, journal());
  insertMemory(db, journal({ project: "beta" }));
  insertMemory(db, journal({ scope: "global", project: null }));
  const result = await syncWeeklyMemory(vault, { scope: "project", project: "alpha" }, at("2026-11-20T12:00:00Z"));
  assert.deepEqual(result.written, ["projects/alpha/weekly/2026-47.md"]);
  assert.equal(fs.existsSync(path.join(vault, "projects/beta/weekly")), false);
  const external = path.join(vault, "external");
  await mkdir(external);
  await symlink(external, path.join(vault, "projects/beta/weekly"));
  const blocked = await syncWeeklyMemory(vault, { project: "beta" }, at("2026-11-20T12:00:00Z"));
  assert.equal(blocked.conflicts.length, 1);
  assert.equal(fs.existsSync(path.join(external, "2026-47.md")), false);
});

test("task attributions persist across processes and make exports defer vault-wide", async (t) => {
  const { vault, db } = await fixture(t);
  const moduleUrl = new URL("../lib/weekly-memory.mjs", import.meta.url).href;
  const source = `import {beginWeeklyTask} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await beginWeeklyTask(${JSON.stringify(vault)}, {taskId:'external',ownerPid:${process.pid}}, {now:new Date('2026-11-15T12:00:00Z')})));`;
  const child = await run(process.execPath, ["--input-type=module", "-e", source], { cwd: path.dirname(fileURLToPath(import.meta.url)) });
  assert.equal(JSON.parse(child.stdout).weekKey, "2026-46");
  assert.equal((await weeklyAttribution(vault, { taskId: "external" }, at("2026-11-16T12:00:00Z"))).weekKey, "2026-46");
  assert.equal((await syncWeeklyMemory(vault)).deferred, true);
  finishMemoryTask(db, { taskId: "external", completed: true });
});

test("interrupted tasks resume their persisted week and child processes inherit unique parent owners", async (t) => {
  const { vault, db } = await fixture(t);
  const moduleUrl = new URL("../lib/weekly-memory.mjs", import.meta.url).href;
  const source = `import {beginWeeklyTask} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await beginWeeklyTask(${JSON.stringify(vault)}, {taskId:'interrupted',ownerPid:process.pid}, {now:new Date('2026-11-15T12:00:00Z')})));`;
  await run(process.execPath, ["--input-type=module", "-e", source]);
  const resumed = await beginWeeklyTask(vault, { taskId: "new-runtime", ownerPid: process.pid, resumeTaskId: "interrupted" }, at("2026-11-16T12:00:00Z"));
  assert.equal(resumed.weekKey, "2026-46");
  assert.equal(db.prepare("SELECT status FROM memory_tasks WHERE id = 'interrupted'").get().status, "cancelled");
  const childSource = `import {weeklyAttribution} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await weeklyAttribution(${JSON.stringify(vault)}, {}, {now:new Date('2026-11-16T12:00:00Z')})));`;
  const child = await run(process.execPath, ["--input-type=module", "-e", childSource]);
  assert.deepEqual(JSON.parse(child.stdout), { taskId: "new-runtime", weekKey: "2026-46", eventDate: "2026-11-16" });
});

test("weekly file publication holds the cross-process task-start barrier until publication finishes", async (t) => {
  const { vault, db } = await fixture(t);
  insertMemory(db, journal());
  await syncWeeklyMemory(vault, {}, at("2026-11-20T12:00:00Z"));
  insertMemory(db, journal({ content: "New receipt changes the export" }));
  const ready = path.join(vault, "child-ready");
  const done = path.join(vault, "child-done");
  const moduleUrl = new URL("../lib/weekly-memory.mjs", import.meta.url).href;
  const source = `import fs from 'node:fs'; import {beginWeeklyTask} from ${JSON.stringify(moduleUrl)}; fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); await beginWeeklyTask(${JSON.stringify(vault)}, {taskId:'racing-start',ownerPid:${process.pid}}); fs.writeFileSync(${JSON.stringify(done)}, 'done');`;
  const original = fs.renameSync;
  let child;
  fs.renameSync = (...args) => {
    if (!child && args[1].endsWith("/weekly/2026-47.md")) {
      child = run(process.execPath, ["--input-type=module", "-e", source]);
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(ready) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 10);
      assert.equal(fs.existsSync(ready), true, "Child must reach the task-start boundary");
      Atomics.wait(sleeper, 0, 0, 100);
      assert.equal(fs.existsSync(done), false, "Task cannot start while export owns the write transaction");
    }
    return original(...args);
  };
  let result;
  try { result = await syncWeeklyMemory(vault, {}, at("2026-11-20T12:00:00Z")); }
  finally { fs.renameSync = original; }
  assert.deepEqual(result.conflicts, []);
  assert.ok(child);
  await child;
  assert.equal(await readFile(done, "utf8"), "done");
  assert.equal((await syncWeeklyMemory(vault)).deferred, true);
  finishMemoryTask(db, { taskId: "racing-start", completed: true });
});
