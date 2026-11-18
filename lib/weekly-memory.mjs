import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { VaultToolError, assertProjectId, assertRole, requireProject } from "./memory-store.mjs";
import { loadSettings, storageFilePath } from "./settings.mjs";
import {
  activeMemoryTasks, annotateMemoryReviews, dbTransaction, memoryTaskIsLocal, memoryTaskOwnerAlive,
  nullEquals, openVaultMemoryDb, searchMemories, startMemoryTask, touchRead, upsertSql,
} from "./memory-db.mjs";
import { calendarMonthCutoff, validateCalendarDate, validateWeekKey, workCalendar } from "./work-calendar.mjs";
import { parseSearchMode, candidateRows, rankCandidates } from "./search-modes.mjs";

const fail = (code, message) => new VaultToolError(code, message);
const hash = (content) => createHash("sha256").update(content).digest("hex");
const dbFor = openVaultMemoryDb;
const taskId = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw fail("invalid_memory_task", "Task ID must contain 1–500 characters.");
  return value;
};
const taskRow = (db, id) => db.prepare("SELECT * FROM memory_tasks WHERE id = ?").get(id);
const attributionRow = (db, id) => db.prepare("SELECT * FROM weekly_task_attributions WHERE task_id = ?").get(id);

function saveAttribution(db, task, calendar, weekly, relation = {}) {
  db.prepare("INSERT INTO weekly_task_attributions (task_id, week_key, business_date, time_zone, workday_start, parent_task_id, resume_task_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(task.id, calendar.weekKey, calendar.businessDate, calendar.timezone, weekly.workdayStart ?? "09:00", relation.parentTaskId ?? null, relation.resumeTaskId ?? null);
  return attributionRow(db, task.id);
}

function ensureAttribution(db, task, weekly) {
  return attributionRow(db, task.id) ?? saveAttribution(db, task, workCalendar(new Date(task.started_at), weekly), weekly);
}

export async function beginWeeklyTask(vault, args, { now = new Date() } = {}) {
  const weekly = loadSettings(vault).weekly;
  const calendar = workCalendar(now, weekly);
  taskId(args?.taskId);
  if (args.parentTaskId != null) taskId(args.parentTaskId);
  if (args.resumeTaskId != null) taskId(args.resumeTaskId);
  if ((args.parentTaskId != null && args.resumeTaskId != null) || args.taskId === args.parentTaskId || args.taskId === args.resumeTaskId) {
    throw fail("invalid_task_relation", "A task may inherit from one different parent or resumed task.");
  }
  const db = await dbFor(vault);
  return dbTransaction(db, () => {
    const result = startMemoryTask(db, args, now);
    const task = taskRow(db, args.taskId);
    let saved = attributionRow(db, task.id);
    const relationId = args.parentTaskId ?? args.resumeTaskId;
    if (saved) {
      if ((args.parentTaskId != null && saved.parent_task_id !== args.parentTaskId) || (args.resumeTaskId != null && saved.resume_task_id !== args.resumeTaskId)) {
        throw fail("task_attribution_conflict", "An existing task cannot change its weekly attribution or inheritance.");
      }
    } else {
      if (!result.started && relationId != null) throw fail("task_attribution_conflict", "A running task cannot acquire a new parent or resume relation.");
      let inherited;
      if (relationId != null) {
        const related = taskRow(db, relationId);
        const valid = related && (args.parentTaskId != null
          ? related.status === "active" && memoryTaskOwnerAlive(db, related.owner_pid, related.owner_host) !== false
          : related.status === "cancelled");
        if (!valid) throw fail("invalid_task_relation", "Parent must be active; resumed task must be cancelled or interrupted, never completed.");
        inherited = ensureAttribution(db, related, weekly);
      }
      saved = saveAttribution(db, task, inherited ? { weekKey: inherited.week_key, businessDate: inherited.business_date, timezone: inherited.time_zone } : result.started ? calendar : workCalendar(new Date(task.started_at), weekly), inherited ? { workdayStart: inherited.workday_start } : weekly, args);
    }
    return { ...result, weekKey: saved.week_key, eventDate: calendar.eventDate };
  });
}

export async function weeklyAttribution(vault, args = {}, { now = new Date() } = {}) {
  const weekly = loadSettings(vault).weekly;
  const calendar = workCalendar(now, weekly);
  const db = await dbFor(vault);
  return dbTransaction(db, () => {
    let task;
    if (args.taskId != null) {
      task = taskRow(db, taskId(args.taskId));
      if (!task || task.status !== "active" || memoryTaskOwnerAlive(db, task.owner_pid, task.owner_host) === false) throw fail("memory_task_closed", "Explicit task must exist and remain active.");
    } else {
      for (const ownerPid of [...new Set([process.pid, process.ppid])]) {
        const matches = activeMemoryTasks(db).filter((candidate) => candidate.ownerPid === ownerPid && memoryTaskIsLocal(db, candidate.ownerHost)
          && memoryTaskOwnerAlive(db, ownerPid, candidate.ownerHost));
        if (matches.length > 1) throw fail("memory_task_ambiguous", "Multiple active tasks match this process; supply taskId.");
        if (matches.length === 1) { task = taskRow(db, matches[0].taskId); break; }
      }
    }
    const saved = task ? ensureAttribution(db, task, weekly) : null;
    return { weekKey: saved?.week_key ?? calendar.weekKey, eventDate: calendar.eventDate, taskId: task?.id ?? null };
  });
}

async function namespace(vault, args, allowAll = false) {
  const scope = args.scope ?? (allowAll && args.project === undefined && args.cwd === undefined ? "all" : "project");
  if (!["global", "project", ...(allowAll ? ["all"] : [])].includes(scope)) throw fail("invalid_scope", "Weekly memory supports global or project scope.");
  if (args.role != null) assertRole(args.role);
  if (scope !== "project" && args.project != null) throw fail("invalid_scope", "Only project scope accepts a project.");
  if (scope === "all" && args.role != null) throw fail("invalid_scope", "All-vault synchronization cannot filter roles.");
  return { scope, project: scope === "project" ? await requireProject(vault, args) : null, ...(args.role != null ? { role: args.role } : {}) };
}

export async function queryWeeklyMemory(vault, args = {}, { now = new Date() } = {}) {
  const id = await namespace(vault, args);
  const parsed = parseSearchMode(args);
  if (parsed.mode !== "keyword") {
    const db = await dbFor(vault);
    const ranked = await rankCandidates(vault, db, candidateRows(db, { ...id, from: args.from, to: args.to, week: args.week, kind: args.kind ?? null, status: null }), parsed);
    // Bound the response like the keyword path: each record carries at most an excerpt.
    const cap = Math.min(2000, Math.floor(20000 / parsed.limit));
    const records = annotateMemoryReviews(db, ranked.results).map((memory) => ({
      ...memory, content: memory.content.slice(0, cap), totalChars: memory.totalChars ?? memory.content.length, truncated: Boolean(memory.truncated) || memory.content.length > cap, ref: `memory:${memory.id}`,
    }));
    dbTransaction(db, () => touchRead(db, records.filter((memory) => memory.kind === "knowledge").map((memory) => memory.id), now));
    return { ...id, records, hasMore: false, limit: parsed.limit, offset: 0, search: ranked.search };
  }
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail("invalid_limit", "Weekly query limit must be an integer from 1 to 100.");
  const db = await dbFor(vault);
  return dbTransaction(db, () => {
    const rows = searchMemories(db, { ...id, query: args.query, from: args.from, to: args.to, week: args.week, kind: args.kind ?? null, status: null, limit: limit + 1, offset, excerptChars: Math.min(2000, Math.floor(20000 / limit)) });
    const records = annotateMemoryReviews(db, rows.slice(0, limit));
    touchRead(db, records.filter((memory) => memory.kind === "knowledge").map((memory) => memory.id), now);
    return { ...id, records: records.map((memory) => ({ ...memory, ref: `memory:${memory.id}` })), hasMore: rows.length > limit, limit, offset };
  });
}

const exportPath = (scope, project, week) => {
  validateWeekKey(week);
  if (scope === "project") assertProjectId(project);
  return scope === "project" ? `projects/${project}/weekly/${week}.md` : `shared/knowledge/weekly/${week}.md`;
};
const heading = (value) => String(value).replace(/[\r\n]+/g, " ");
const importedBody = (row) => row.source_path == null ? row.content : row.content.replace(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/, "");
function renderWeekly(scope, project, week, rows, remote) {
  const authority = remote ? "Database records are authoritative." : "SQLite records are authoritative.";
  const lines = [`# ${scope === "project" ? project : "Global"} weekly journal — ${week}`, "", `<!-- Generated by Agent Vault. ${authority} Local edits are preserved as conflicts. -->`, ""];
  let lastDate;
  for (const row of rows) {
    const date = row.event_date ?? row.created_at.slice(0, 10);
    validateCalendarDate(date);
    if (date !== lastDate) {
      const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(`${date}T12:00:00Z`));
      lines.push(`## ${date} — ${weekday}`, "");
      lastDate = date;
    }
    lines.push(`### ${heading(row.kind)} · ${heading(row.role ?? "unassigned role")} · ${heading(row.worktree ?? "no worktree")} — ${heading(row.title)}`, "", `memory:${row.id} ^memory-${row.id}`, "", `Status: ${row.status}${row.superseded_by == null ? "" : `; superseded by memory:${row.superseded_by}`}${row.task_id == null ? "" : `; task: ${heading(row.task_id)}`}`, "", importedBody(row), "");
  }
  return lines.join("\n");
}

function checkedFile(file) {
  storageFilePath(file);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw fail("weekly_export_conflict", "Weekly export must be a regular file with one link.");
    return { stat, contentHash: hash(fs.readFileSync(fd)) };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function unchanged(file, before) {
  const current = checkedFile(file);
  if (before === null ? current !== null : !current || current.stat.ino !== before.stat.ino || current.stat.dev !== before.stat.dev || current.contentHash !== before.contentHash) {
    throw fail("weekly_export_conflict", "Weekly export changed during synchronization.");
  }
}

function atomicExport(file, content, before) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    unchanged(file, before);
    if (before === null) {
      // link is an atomic no-replace publish, unlike rename over an absent destination.
      fs.linkSync(temporary, file);
      fs.unlinkSync(temporary);
    } else fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export async function syncWeeklyMemory(vault, args = {}, { now = new Date() } = {}) {
  const id = await namespace(vault, args, true);
  if (id.role != null) throw fail("invalid_scope", "Weekly exports contain every role in the selected scope.");
  const weekly = loadSettings(vault).weekly;
  const cutoff = calendarMonthCutoff(workCalendar(now, weekly).eventDate, weekly.retentionMonths ?? 3);
  const db = await dbFor(vault);
  // Hold the same cross-process write lock as task starts throughout synchronous file publication.
  return dbTransaction(db, () => {
    const report = { deferred: false, written: [], deleted: [], conflicts: [] };
    if (activeMemoryTasks(db).length) return { ...report, deferred: true };
    const where = ["scope IN ('global', 'project')", "week_key IS NOT NULL"];
    const params = [];
    if (id.scope !== "all") { where.push("scope = ?", nullEquals(db, "project")); params.push(id.scope, id.project); }
    const groups = db.prepare(`SELECT scope, project, week_key, MAX(COALESCE(event_date, substr(created_at, 1, 10))) AS latest FROM memories WHERE ${where.join(" AND ")} GROUP BY scope, project, week_key`).all(...params);
    const manifests = db.prepare(`SELECT * FROM weekly_exports${id.scope === "all" ? "" : ` WHERE scope = ? AND ${nullEquals(db, "project")}`}`).all(...(id.scope === "all" ? [] : [id.scope, id.project]));
    const manifestByPath = new Map(manifests.map((manifest) => [manifest.path, manifest]));
    const candidates = new Map(manifests.map((manifest) => [manifest.path, { scope: manifest.scope, project: manifest.project, week_key: manifest.week_key, latest: manifest.latest_event_date }]));
    for (const group of groups) candidates.set(exportPath(group.scope, group.project, group.week_key), group);
    for (const [relative, group] of candidates) {
      try {
        dbTransaction(db, () => {
          if (relative !== exportPath(group.scope, group.project, group.week_key)) throw fail("weekly_export_conflict", "Export manifest path does not match its namespace.");
          const file = path.join(vault, relative);
          storageFilePath(file, { createParent: true });
          const before = checkedFile(file);
          const manifest = manifestByPath.get(relative);
          if (before && (!manifest || manifest.content_hash !== before.contentHash)) throw fail("weekly_export_conflict", "Weekly export contains foreign or modified content.");
          if (group.latest < cutoff) {
            if (before) { unchanged(file, before); fs.unlinkSync(file); report.deleted.push(relative); }
            db.prepare("DELETE FROM weekly_exports WHERE path = ?").run(relative);
            return;
          }
          const rows = db.prepare(`SELECT * FROM memories WHERE scope = ? AND ${nullEquals(db, "project")} AND week_key = ? AND COALESCE(event_date, substr(created_at, 1, 10)) >= ? ORDER BY COALESCE(event_date, substr(created_at, 1, 10)), id`).all(group.scope, group.project, group.week_key, cutoff);
          const content = renderWeekly(group.scope, group.project, group.week_key, rows, Boolean(db.driver));
          const contentHash = hash(content);
          // A copied manifest still owns an unchanged SQLite-era export. Do not
          // rewrite an otherwise identical file on the first SQL maintenance pass.
          const sameBefore = before?.contentHash === contentHash || (db.driver && before && manifest
            && before.contentHash === hash(content.replace("<!-- Generated by Agent Vault. Database records", "<!-- Generated by Agent Vault. SQLite records")));
          if (!sameBefore) { atomicExport(file, content, before); report.written.push(relative); }
          const conflict = upsertSql(db, "path", "content_hash = excluded.content_hash, latest_event_date = excluded.latest_event_date, exported_at = excluded.exported_at",
            "content_hash = VALUES(content_hash), latest_event_date = VALUES(latest_event_date), exported_at = VALUES(exported_at)");
          db.prepare(`INSERT INTO weekly_exports (path, scope, project, week_key, content_hash, latest_event_date, exported_at) VALUES (?, ?, ?, ?, ?, ?, ?) ${conflict}`)
            .run(relative, group.scope, group.project, group.week_key, sameBefore ? before.contentHash : contentHash, group.latest, now.toISOString());
        });
      } catch (error) {
        report.conflicts.push({ path: relative, reason: error.code ?? "weekly_export_error" });
      }
    }
    return report;
  });
}
