// SQLite storage for long-term memory, activity counters and review tickets.
// Uses built-in node:sqlite (Node ^22.13.0 or >=23.4.0), loaded lazily for Markdown-only operations.
// The database file lives under <vault>/.agent-vault/ and is only reachable through the Agent Vault tools.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { VaultToolError } from "./memory-store.mjs";
import { storageFilePath } from "./settings.mjs";
import { validateCalendarDate, validateWeekKey, workCalendar } from "./work-calendar.mjs";

const SCHEMA_VERSION = "5";
const fail = (code, message, details) => new VaultToolError(code, message, details);
const handles = new Map();
const opening = new Map();
let closeGeneration = 0;
let savepointId = 0;
const transactionDepth = new WeakMap();
const identities = new WeakMap();

export const memoryDbFile = (vault) => path.join(vault, ".agent-vault", "memory.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'team')),
  project TEXT,
  role TEXT,
  team_id TEXT NOT NULL DEFAULT '',
  slug TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  source_path TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'superseded')),
  superseded_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_read_at TEXT,
  read_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS memories_lookup ON memories (scope, project, role, status);
CREATE TABLE IF NOT EXISTS activity (
  key TEXT PRIMARY KEY,
  reads INTEGER NOT NULL DEFAULT 0,
  writes INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  last_op_at TEXT
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  reason TEXT NOT NULL,
  total_ops INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  ready_at TEXT,
  resolved_at TEXT,
  resolution TEXT
);
CREATE TABLE IF NOT EXISTS memory_tasks (
  id TEXT PRIMARY KEY,
  owner_pid INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS review_actions (
  review_id INTEGER PRIMARY KEY REFERENCES reviews(id),
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'failed')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id),
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('user_correction', 'counterexample', 'external_evidence', 'outdated')),
  feedback TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (review_id, memory_id, trigger, feedback, source_hash)
);
CREATE TRIGGER IF NOT EXISTS review_feedback_no_update
BEFORE UPDATE ON review_feedback BEGIN SELECT RAISE(ABORT, 'Review feedback is immutable.'); END;
CREATE TRIGGER IF NOT EXISTS review_feedback_no_delete
BEFORE DELETE ON review_feedback BEGIN SELECT RAISE(ABORT, 'Review feedback is immutable.'); END;
CREATE TABLE IF NOT EXISTS weekly_task_attributions (
  task_id TEXT PRIMARY KEY REFERENCES memory_tasks(id),
  week_key TEXT NOT NULL,
  business_date TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  workday_start TEXT NOT NULL,
  parent_task_id TEXT REFERENCES memory_tasks(id),
  resume_task_id TEXT REFERENCES memory_tasks(id)
);
CREATE TABLE IF NOT EXISTS weekly_exports (
  path TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  project TEXT,
  week_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  latest_event_date TEXT NOT NULL,
  exported_at TEXT NOT NULL
);
`;

function privateDbFiles(file, { prepare = false } = {}) {
  try {
    const target = storageFilePath(file, { createParent: true });
    const parent = fs.statSync(path.dirname(target));
    if ((parent.mode & 0o022) || (process.getuid && parent.uid !== process.getuid())) throw new Error("Database parent must be private to its owner.");
    // Best-effort Linux rejection only. statfs type numbers differ on macOS,
    // and synced directories cannot be detected reliably on any platform.
    const filesystem = fs.statfsSync(path.dirname(target));
    const unsupportedLinux = [0x6969, 0xff534d42, 0xfe534d42, 0x5346414f, 0x73757245, 0x65735546, 0x01021997, 0x00c36400, 0x47504653, 0x0bd00bd0];
    if (process.platform === "linux" && unsupportedLinux.includes(Number(filesystem.type))) {
      throw fail("network_filesystem", "SQLite memory requires a same-host local filesystem, not NFS, SMB, or a synced multi-host store. Use the HTTP backend for remote teams.");
    }
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const name = storageFilePath(`${target}${suffix}`);
      if (!prepare) {
        // Never open and close another descriptor for a live SQLite inode:
        // POSIX close() can release SQLite's process-wide advisory locks.
        try { fs.chmodSync(name, 0o600); } catch (error) { if (error.code !== "ENOENT") throw error; }
        continue;
      }
      let fd;
      try {
        fd = fs.openSync(name, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (suffix === "" ? fs.constants.O_CREAT : 0), 0o600);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe database file.");
        fs.fchmodSync(fd, 0o600);
      } catch (error) { if (error.code !== "ENOENT" || suffix === "") throw error; } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    return target;
  } catch (error) {
    if (error instanceof VaultToolError) throw error;
    throw fail("path_unsafe", "Memory database path must contain only owner-controlled directories and regular, unlinked files.");
  }
}

export async function openMemoryDb(file) {
  const target = privateDbFiles(file);
  if (handles.has(target)) {
    const db = handles.get(target);
    const stored = identities.get(db);
    const current = fs.statSync(target);
    if (stored.dev !== current.dev || stored.ino !== current.ino) throw fail("database_changed", "Memory database file changed while its connection was open. Close connections before replacing the file.");
    return db;
  }
  if (opening.has(target)) return opening.get(target);
  const generation = closeGeneration;
  const pending = (async () => {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import("node:sqlite")); } catch {
      throw fail("sqlite_unavailable", `Long-term memory needs unflagged node:sqlite (Node.js ^22.13.0 or >=23.4.0); this runtime is ${process.version}.`);
    }
    if (generation !== closeGeneration) throw fail("database_closed", "Memory databases were closed while this connection was opening.");
    privateDbFiles(target, { prepare: true });
    let db;
    try {
      db = new DatabaseSync(target);
      db.exec("PRAGMA busy_timeout = 5000;");
      // Journal-mode upgrades can return SQLITE_BUSY without invoking SQLite's busy handler.
      // Serialize competing first opens with the same bounded wait as ordinary writes.
      const deadline = Date.now() + 5000;
      for (;;) {
        if (generation !== closeGeneration) throw fail("database_closed", "Memory databases were closed while this connection was opening.");
        try {
          db.exec("PRAGMA journal_mode = WAL;");
          break;
        } catch (error) {
          if (error.errcode !== 5 || Date.now() >= deadline) throw error;
          await delay(Math.min(20, deadline - Date.now()));
        }
      }
      dbTransaction(db, () => {
        db.exec(SCHEMA);
        const version = db.prepare("SELECT v FROM meta WHERE k = 'schema'").get();
        if (version && !["1", "2", "3", "4", SCHEMA_VERSION].includes(version.v)) throw fail("schema_mismatch", "Memory database schema is not supported by this version.");
        if (!db.prepare("PRAGMA table_info(memories)").all().some((column) => column.name === "team_id")) {
          db.exec("ALTER TABLE memories ADD COLUMN team_id TEXT NOT NULL DEFAULT ''");
        }
        if (!db.prepare("PRAGMA table_info(reviews)").all().some((column) => column.name === "ready_at")) {
          db.exec("ALTER TABLE reviews ADD COLUMN ready_at TEXT");
        }
        const columns = new Set(db.prepare("PRAGMA table_info(memories)").all().map((column) => column.name));
        for (const [name, definition] of [["kind", "TEXT NOT NULL DEFAULT 'knowledge'"], ["week_key", "TEXT"], ["event_date", "TEXT"], ["task_id", "TEXT"], ["worktree", "TEXT"]]) {
          if (!columns.has(name)) db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
        }
        db.exec("CREATE INDEX IF NOT EXISTS memories_week ON memories(scope, project, week_key, event_date); CREATE INDEX IF NOT EXISTS memories_event_date ON memories(scope, project, event_date, kind)");
        if (version?.v !== SCHEMA_VERSION) db.exec("DROP INDEX IF EXISTS memories_slug; DROP INDEX IF EXISTS memories_source;");
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS memories_slug ON memories (scope, team_id, IFNULL(project, ''), IFNULL(role, ''), slug) WHERE slug IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS memories_source ON memories (team_id, source_path) WHERE source_path IS NOT NULL;");
        if (version?.v === "1") {
          const update = db.prepare("UPDATE memories SET content_hash = ? WHERE id = ?");
          for (const row of db.prepare("SELECT id, title, content, tags FROM memories").iterate()) update.run(hashOf(row.title, row.content, JSON.parse(row.tags)), row.id);
        }
        if (version && version.v !== SCHEMA_VERSION) {
          const update = db.prepare("UPDATE memories SET event_date = COALESCE(event_date, ?), week_key = COALESCE(week_key, ?) WHERE id = ?");
          for (const row of db.prepare("SELECT id, created_at, event_date FROM memories WHERE event_date IS NULL OR week_key IS NULL").all()) {
            const created = new Date(row.event_date == null ? row.created_at : `${row.event_date}T12:00:00Z`);
            if (!Number.isFinite(created.getTime())) continue;
            const calendar = workCalendar(created, { timeZone: "UTC", workdayStart: "00:00" });
            update.run(calendar.eventDate, calendar.weekKey, row.id);
          }
        }
        db.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(SCHEMA_VERSION);
      });
      db.function("memory_score", { deterministic: true }, scoreMemory);
      privateDbFiles(target);
      identities.set(db, fs.statSync(target));
      const close = db.close.bind(db);
      let closed = false;
      db.close = () => {
        if (closed) return;
        const result = close();
        closed = true;
        if (handles.get(target) === db) handles.delete(target);
        return result;
      };
      handles.set(target, db);
      return db;
    } catch (error) {
      try { db?.close(); } catch { /* Preserve the initialization error. */ }
      throw error;
    }
  })();
  opening.set(target, pending);
  try { return await pending; } finally { if (opening.get(target) === pending) opening.delete(target); }
}

export function closeMemoryDbs() {
  closeGeneration++;
  const errors = [];
  for (const db of [...handles.values()]) {
    try { db.close(); } catch (error) { errors.push(error); }
  }
  handles.clear();
  opening.clear();
  if (errors.length) throw new AggregateError(errors, "Could not close every memory database.");
}

export function dbTransaction(db, fn) {
  if (typeof fn !== "function" || fn.constructor?.name === "AsyncFunction") throw fail("async_transaction", "dbTransaction requires a synchronous callback.");
  const depth = transactionDepth.get(db) ?? 0;
  const savepoint = `memory_tx_${++savepointId}`;
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
  transactionDepth.set(db, depth + 1);
  try {
    const result = fn();
    if (result && typeof result.then === "function") throw fail("async_transaction", "dbTransaction callbacks must be synchronous.");
    db.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    try { db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally { transactionDepth.set(db, depth); }
}

const plain = (row) => (row ? { ...row } : null);
const hashOf = (title, content, tags = []) => createHash("sha256").update(JSON.stringify([title, content, tags])).digest("hex");

function present(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    project: row.project,
    role: row.role,
    teamId: row.team_id || null,
    slug: row.slug,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags),
    status: row.status,
    supersededBy: row.superseded_by,
    sourcePath: row.source_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastReadAt: row.last_read_at,
    readCount: row.read_count,
    kind: row.kind,
    weekKey: row.week_key,
    eventDate: row.event_date,
    taskId: row.task_id,
    worktree: row.worktree,
  };
}

// Preserve distinct import sources; tags form part of a memory's meaning.
export function insertMemory(db, entry, now = new Date()) {
  if (!entry || !["global", "project", "team"].includes(entry.scope) || typeof entry.title !== "string" || typeof entry.content !== "string") {
    throw fail("invalid_memory", "Memory requires a valid scope and string title and content.");
  }
  if (entry.tags !== undefined && (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string"))) throw fail("invalid_memory", "Memory tags must be strings.");
  for (const name of ["project", "role", "slug", "sourcePath", "teamId", "weekKey", "eventDate", "taskId", "worktree"]) {
    if (entry[name] != null && typeof entry[name] !== "string") throw fail("invalid_memory", "Memory identity and source fields must be strings or null.");
  }
  if (entry.scope === "team" && !entry.teamId) throw fail("invalid_memory", "Team memory requires an explicit teamId namespace.");
  if (entry.scope !== "team" && entry.teamId) throw fail("invalid_memory", "Only team memories may specify teamId.");
  const kind = entry.kind ?? "knowledge";
  if (typeof kind !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(kind)) throw fail("invalid_memory", "Memory kind must be a short lowercase identifier.");
  if (entry.weekKey != null) validateWeekKey(entry.weekKey);
  if (entry.eventDate != null) validateCalendarDate(entry.eventDate);
  return dbTransaction(db, () => {
    const ts = now.toISOString();
    const hash = hashOf(entry.title, entry.content, entry.tags ?? []);
    const teamId = entry.teamId ?? "";
    const same = kind === "knowledge" ? db
      .prepare("SELECT * FROM memories WHERE scope = ? AND team_id = ? AND IFNULL(project, '') = ? AND IFNULL(role, '') = ? AND content_hash = ? AND title = ? AND content = ? AND tags = ? AND source_path IS ? AND kind = ? AND (? IS NULL OR week_key IS ?) AND (? IS NULL OR event_date IS ?) AND task_id IS ? AND worktree IS ? AND status = 'active'")
      .get(entry.scope, teamId, entry.project ?? "", entry.role ?? "", hash, entry.title, entry.content, JSON.stringify(entry.tags ?? []), entry.sourcePath ?? null, kind, entry.weekKey ?? null, entry.weekKey ?? null, entry.eventDate ?? null, entry.eventDate ?? null, entry.taskId ?? null, entry.worktree ?? null) : null;
    if (same) return { duplicate: true, memory: present(same) };
    try {
      const info = db.prepare(
        "INSERT INTO memories (scope, team_id, project, role, slug, title, content, tags, content_hash, source_path, created_at, updated_at, kind, week_key, event_date, task_id, worktree) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(entry.scope, teamId, entry.project ?? null, entry.role ?? null, entry.slug ?? null, entry.title, entry.content, JSON.stringify(entry.tags ?? []), hash, entry.sourcePath ?? null, entry.createdAt ?? ts, entry.createdAt ?? ts, kind, entry.weekKey ?? null, entry.eventDate ?? null, entry.taskId ?? null, entry.worktree ?? null);
      return { duplicate: false, memory: getMemory(db, info.lastInsertRowid) };
    } catch (error) {
      if (/UNIQUE constraint failed/.test(error.message) && entry.slug) {
        throw fail("exists", `A long-term memory with slug '${entry.slug}' already exists in this scope; use a new slug or supersede it through memory_review_resolve.`);
      }
      throw error;
    }
  });
}

export function getMemory(db, id) {
  return present(db.prepare("SELECT * FROM memories WHERE id = ?").get(id));
}

const tokensOf = (query) => [...new Set(String(query ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))];

function scoreMemory(title, content, tags, query) {
  const terms = tokensOf(query);
  if (terms.length === 0) return 1;
  title = title.toLowerCase();
  content = content.toLowerCase();
  tags = JSON.parse(tags).join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    const hits = (title.includes(term) ? 3 : 0) + (tags.includes(term) ? 2 : 0) + Math.min(content.split(term).length - 1, 5);
    if (!hits) return 0;
    score += hits;
  }
  return score;
}

// Score all matching rows inside SQLite before applying the requested limit.
export function searchMemories(db, { scope, project, role, teamId = "", query, limit = 10, offset = 0, status = "active", kind = "knowledge", from, to, week, excerptChars } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail("invalid_limit", "Memory search limit must be an integer from 1 to 1000.");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw fail("invalid_offset", "Memory search offset must be an integer from 0 to 1000000.");
  if (query !== undefined && (typeof query !== "string" || query.length > 4000)) throw fail("invalid_query", "Memory search query must be a string of at most 4000 characters.");
  if (kind != null && (typeof kind !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(kind))) throw fail("invalid_kind", "Memory kind must be a short lowercase identifier or null.");
  if (from !== undefined) validateCalendarDate(from);
  if (to !== undefined) validateCalendarDate(to);
  if (from !== undefined && to !== undefined && from > to) throw fail("invalid_calendar", "from must not follow to.");
  if (week !== undefined) validateWeekKey(week);
  if (excerptChars !== undefined && (!Number.isInteger(excerptChars) || excerptChars < 0 || excerptChars > 4000)) throw fail("invalid_limit", "Excerpt size must be an integer from 0 to 4000.");
  const where = ["scope = ?", "team_id = ?"];
  const params = [scope, teamId];
  if (project !== undefined) { where.push("IFNULL(project, '') = ?"); params.push(project ?? ""); }
  if (role !== undefined) { where.push("IFNULL(role, '') = ?"); params.push(role ?? ""); }
  if (status) { where.push("status = ?"); params.push(status); }
  if (kind != null) { where.push("kind = ?"); params.push(kind); }
  if (from !== undefined) { where.push("COALESCE(event_date, substr(created_at, 1, 10)) >= ?"); params.push(from); }
  if (to !== undefined) { where.push("COALESCE(event_date, substr(created_at, 1, 10)) <= ?"); params.push(to); }
  if (week !== undefined) { where.push("week_key = ?"); params.push(week); }
  const hasTerms = tokensOf(query).length > 0;
  const fields = excerptChars === undefined ? "*" : "id, scope, project, role, team_id, slug, title, substr(content, 1, ?) AS content, length(content) AS total_chars, tags, status, superseded_by, source_path, created_at, updated_at, last_read_at, read_count, kind, week_key, event_date, task_id, worktree";
  if (hasTerms) { where.push("memory_score(title, content, tags, ?) > 0"); params.push(query); }
  const ordering = hasTerms ? "memory_score(memories.title, memories.content, memories.tags, ?) DESC, id DESC" : "updated_at DESC, id DESC";
  const rows = db.prepare(`SELECT ${fields} FROM memories WHERE ${where.join(" AND ")} ORDER BY ${ordering} LIMIT ? OFFSET ?`)
    .all(...(excerptChars === undefined ? [] : [excerptChars]), ...params, ...(hasTerms ? [query] : []), limit, offset);
  return rows.map((row) => excerptChars === undefined ? present(row) : { ...present(row), totalChars: row.total_chars, truncated: row.total_chars > excerptChars });
}

export function touchRead(db, ids, now = new Date()) {
  const stmt = db.prepare("UPDATE memories SET read_count = read_count + 1, last_read_at = ? WHERE id = ?");
  for (const id of ids) stmt.run(now.toISOString(), id);
}

export function setStatus(db, id, status, { supersededBy = null } = {}, now = new Date()) {
  db.prepare("UPDATE memories SET status = ?, superseded_by = ?, updated_at = ? WHERE id = ?").run(status, supersededBy, now.toISOString(), id);
}

export function hotMemories(db, { scope, project, role, teamId = "", minReads }) {
  return db
    .prepare("SELECT * FROM memories WHERE scope = ? AND team_id = ? AND IFNULL(project, '') = ? AND IFNULL(role, '') = ? AND kind = 'knowledge' AND status = 'active' AND read_count >= ? ORDER BY read_count DESC, id DESC LIMIT 20")
    .all(scope, teamId, project ?? "", role ?? "", minReads)
    .map(present);
}

// Archives later copies of identical active memories, keeping the oldest. Returns the archived ids.
export function dedupeExact(db, { scope, project, role, teamId = "" } = {}, now = new Date()) {
  const rows = db
    .prepare("SELECT id, content_hash, week_key, event_date, task_id, worktree FROM memories WHERE scope = ? AND team_id = ? AND IFNULL(project, '') = ? AND IFNULL(role, '') = ? AND kind = 'knowledge' AND status = 'active' ORDER BY id")
    .all(scope, teamId, project ?? "", role ?? "");
  const keeper = new Map();
  const archived = [];
  for (const row of rows) {
    const key = JSON.stringify([row.content_hash, row.week_key, row.event_date, row.task_id, row.worktree]);
    const first = keeper.get(key);
    if (first === undefined) {
      keeper.set(key, row.id);
    } else {
      setStatus(db, row.id, "archived", { supersededBy: first }, now);
      archived.push(row.id);
    }
  }
  return archived;
}

// ---------------------------------------------------------------- activity and review tickets

// Cumulative operation counts that open a review: the configured thresholds, then every `repeatEvery` operations.
export function milestoneValue(level, { thresholds, repeatEvery }) {
  if (level <= thresholds.length) return thresholds[level - 1];
  return thresholds[thresholds.length - 1] + (level - thresholds.length) * repeatEvery;
}

export function milestonesPassed(total, review) {
  const { thresholds, repeatEvery } = review;
  const base = thresholds.filter((n) => n <= total).length;
  const last = thresholds[thresholds.length - 1];
  return total > last ? base + Math.floor((total - last) / repeatEvery) : base;
}

// Counts one read or write and queues a pending review ticket when a milestone is crossed.
export function recordActivity(db, key, kind, review, now = new Date()) {
  if (!["read", "write"].includes(kind)) throw fail("invalid_activity", "Activity kind must be read or write.");
  return dbTransaction(db, () => {
    const ts = now.toISOString();
    db.prepare("INSERT INTO activity (key, reads, writes, level, last_op_at) VALUES (?, 0, 0, 0, ?) ON CONFLICT (key) DO NOTHING").run(key, ts);
    db.prepare(`UPDATE activity SET ${kind === "read" ? "reads = reads + 1" : "writes = writes + 1"}, last_op_at = ? WHERE key = ?`).run(ts, key);
    const row = db.prepare("SELECT * FROM activity WHERE key = ?").get(key);
    const total = row.reads + row.writes;
    const level = milestonesPassed(total, review);
    if (level > row.level) {
      db.prepare("UPDATE activity SET level = ? WHERE key = ?").run(level, key);
      const ticket = ensureReview(db, key, `ops>=${milestoneValue(level, review)}`, total, now);
      db.prepare("UPDATE reviews SET ready_at = NULL WHERE id = ?").run(ticket.id);
    }
    const open = db.prepare("SELECT * FROM reviews WHERE key = ? AND resolved_at IS NULL ORDER BY id LIMIT 1").get(key);
    if (open) db.prepare("UPDATE reviews SET total_ops = ? WHERE id = ?").run(total, open.id);
    return { reads: row.reads, writes: row.writes, total, ticket: open ? reviewOf({ ...open, total_ops: total }) : null };
  });
}

const reviewOf = (row) => row ? {
  id: row.id, key: row.key, reason: row.reason, totalOps: row.total_ops,
  createdAt: row.created_at, readyAt: row.ready_at, state: row.ready_at === null ? "pending" : "ready",
} : null;

export function ensureReview(db, key, reason, totalOps, now = new Date()) {
  return dbTransaction(db, () => {
    const existing = db.prepare("SELECT * FROM reviews WHERE key = ? AND resolved_at IS NULL ORDER BY id LIMIT 1").get(key);
    if (existing) {
      db.prepare("UPDATE reviews SET total_ops = MAX(total_ops, ?) WHERE id = ?").run(totalOps, existing.id);
      return reviewOf({ ...existing, total_ops: Math.max(existing.total_ops, totalOps) });
    }
    const info = db.prepare("INSERT INTO reviews (key, reason, total_ops, created_at) VALUES (?, ?, ?, ?)").run(key, reason, totalOps, now.toISOString());
    return reviewOf(db.prepare("SELECT * FROM reviews WHERE id = ?").get(info.lastInsertRowid));
  });
}

const feedbackOf = (row) => ({
  id: row.id, reviewId: row.review_id, memoryId: row.memory_id, trigger: row.trigger,
  feedback: row.feedback, sourceHash: row.source_hash, createdAt: row.created_at,
});

export function reviewFeedback(db, reviewId) {
  return db.prepare("SELECT * FROM review_feedback WHERE review_id = ? ORDER BY id").all(reviewId).map(feedbackOf);
}

export function queueMemoryFeedback(db, { key, memoryId, trigger, feedback }, now = new Date()) {
  if (!Number.isSafeInteger(memoryId) || memoryId < 1) throw fail("invalid_id", "A positive integer memory id is required.");
  if (typeof key !== "string" || !key) throw fail("invalid_feedback", "Feedback requires an explicit review key.");
  if (!["user_correction", "counterexample", "external_evidence", "outdated"].includes(trigger)) {
    throw fail("invalid_feedback", "Feedback trigger must be user_correction, counterexample, external_evidence, or outdated.");
  }
  if (typeof feedback !== "string" || !feedback.trim()) throw fail("invalid_feedback", "Feedback must be a nonempty string.");
  return dbTransaction(db, () => {
    const memory = db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId);
    if (!memory || !["project", "global"].includes(memory.scope)
      || !key.startsWith(`${memory.scope}:${memory.project ?? ""}:${memory.role ?? ""}:`)) {
      throw fail("not_found", "No memory with that id exists in the selected scope and role.");
    }
    if (memory.status !== "active") throw fail("memory_changed", "The source memory is no longer active; re-read it before reviewing.");
    const review = ensureReview(db, key, "knowledge_reconsideration", 0, now);
    const result = db.prepare(`INSERT INTO review_feedback (review_id, memory_id, trigger, feedback, source_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(review_id, memory_id, trigger, feedback, source_hash) DO NOTHING`)
      .run(review.id, memoryId, trigger, feedback, memory.content_hash, now.toISOString());
    const created = Boolean(result.changes);
    if (created) db.prepare("UPDATE reviews SET ready_at = NULL WHERE id = ?").run(review.id);
    const stored = db.prepare(`SELECT * FROM review_feedback
      WHERE review_id = ? AND memory_id = ? AND trigger = ? AND feedback = ? AND source_hash = ?`)
      .get(review.id, memoryId, trigger, feedback, memory.content_hash);
    return { review: reviewOf(getReview(db, review.id)), feedback: feedbackOf(stored), created };
  });
}

export function openReviews(db, keyPrefix = "", { includePending = false } = {}) {
  return db
    .prepare(`SELECT * FROM reviews WHERE resolved_at IS NULL${includePending ? "" : " AND ready_at IS NOT NULL"} AND key LIKE ? ESCAPE '\\' ORDER BY id`)
    .all(`${keyPrefix.replace(/[\\%_]/g, "\\$&")}%`)
    .map((row) => {
      const review = reviewOf(row);
      const feedback = reviewFeedback(db, row.id);
      return feedback.length ? { ...review, feedback } : review;
    });
}

export function deferredReviews(db, keyPrefix = "") {
  return db.prepare(`SELECT r.* FROM reviews r
    WHERE r.resolved_at IS NOT NULL AND r.key LIKE ? ESCAPE '\\'
      AND json_extract(CASE WHEN json_valid(r.resolution) THEN r.resolution ELSE '{}' END, '$.action') = 'defer'
      AND NOT EXISTS (SELECT 1 FROM reviews newer WHERE newer.key = r.key AND newer.resolved_at IS NOT NULL AND newer.id > r.id)
    ORDER BY r.id`)
    .all(`${keyPrefix.replace(/[\\%_]/g, "\\$&")}%`)
    .map((row) => {
      const resolution = JSON.parse(row.resolution);
      return {
        ...reviewOf(row), resolvedAt: row.resolved_at, resolution,
        assessment: resolution.assessment ?? null, feedback: reviewFeedback(db, row.id),
      };
    });
}

export function releaseReviews(db, ids, now = new Date()) {
  return dbTransaction(db, () => {
    if (activeMemoryTasks(db).length) return [];
    const update = db.prepare("UPDATE reviews SET ready_at = ? WHERE id = ? AND resolved_at IS NULL AND ready_at IS NULL");
    const timestamp = now.toISOString();
    const released = [];
    for (const id of ids) if (update.run(timestamp, id).changes) released.push(id);
    return released;
  });
}

export function activeMemoryTasks(db) {
  return db.prepare("SELECT id, owner_pid, started_at FROM memory_tasks WHERE status = 'active' ORDER BY started_at, id").all()
    .map((row) => ({ taskId: row.id, ownerPid: row.owner_pid, startedAt: row.started_at }));
}

const validateTaskId = (taskId) => {
  if (typeof taskId !== "string" || !taskId.trim()) throw fail("invalid_memory_task", "Memory task ID must be a nonempty string.");
};

export function startMemoryTask(db, { taskId, ownerPid }, now = new Date()) {
  validateTaskId(taskId);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || ownerPid > 2147483647) throw fail("invalid_memory_task", "Memory task owner must be a positive process ID.");
  return dbTransaction(db, () => {
    const timestamp = now.toISOString();
    const existing = db.prepare("SELECT * FROM memory_tasks WHERE id = ?").get(taskId);
    if (existing && existing.owner_pid !== ownerPid) throw fail("memory_task_owner_mismatch", "Memory task belongs to a different process.");
    const cancel = db.prepare("UPDATE memory_tasks SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'active'");
    for (const task of activeMemoryTasks(db)) {
      try { process.kill(task.ownerPid, 0); } catch (error) {
        if (error.code === "ESRCH") cancel.run(timestamp, task.taskId);
      }
    }
    if (existing) {
      if (!db.prepare("SELECT 1 FROM memory_tasks WHERE id = ? AND status = 'active'").get(taskId)) {
        throw fail("memory_task_closed", "A finished memory task ID cannot be reused.");
      }
      return { started: false, taskId, activeTasks: activeMemoryTasks(db).length };
    }
    db.prepare("INSERT INTO memory_tasks (id, owner_pid, status, started_at) VALUES (?, ?, 'active', ?)").run(taskId, ownerPid, timestamp);
    return { started: true, taskId, activeTasks: activeMemoryTasks(db).length };
  });
}

export function finishMemoryTask(db, { taskId, completed }, now = new Date()) {
  validateTaskId(taskId);
  if (typeof completed !== "boolean") throw fail("invalid_memory_task", "Memory task completion must be a boolean.");
  return dbTransaction(db, () => {
    const result = db.prepare("UPDATE memory_tasks SET status = ?, finished_at = ? WHERE id = ? AND status = 'active'")
      .run(completed ? "completed" : "cancelled", now.toISOString(), taskId);
    return { ended: Boolean(result.changes), completed: Boolean(result.changes) && completed, activeTasks: activeMemoryTasks(db).length };
  });
}

const actionOf = (row) => row ? {
  reviewId: row.review_id, payload: JSON.parse(row.payload), status: row.status,
  errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at,
} : null;

export function getReviewAction(db, reviewId) {
  return actionOf(db.prepare("SELECT * FROM review_actions WHERE review_id = ?").get(reviewId));
}

export function stageReviewAction(db, reviewId, payload, now = new Date()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw fail("invalid_review_action", "Review action payload must be an object.");
  const serialized = JSON.stringify(payload);
  return dbTransaction(db, () => {
    const existing = db.prepare("SELECT * FROM review_actions WHERE review_id = ?").get(reviewId);
    if (existing?.payload === serialized && existing.status !== "failed") return actionOf(existing);
    if (existing && existing.status !== "failed") throw fail("review_action_conflict", "A pending or applied review action cannot be replaced.");
    const review = getReview(db, reviewId);
    if (!review || review.resolved_at !== null) throw fail("review_not_open", "Review action requires an unresolved review.");
    const timestamp = now.toISOString();
    db.prepare(`INSERT INTO review_actions (review_id, payload, status, error_code, created_at, updated_at)
      VALUES (?, ?, 'pending', NULL, ?, ?)
      ON CONFLICT(review_id) DO UPDATE SET payload = excluded.payload, status = 'pending', error_code = NULL, updated_at = excluded.updated_at`)
      .run(reviewId, serialized, timestamp, timestamp);
    return getReviewAction(db, reviewId);
  });
}

export function stagedReviewActions(db) {
  return db.prepare("SELECT review_id, payload FROM review_actions WHERE status = 'pending' ORDER BY review_id").all()
    .map((row) => ({ reviewId: row.review_id, payload: JSON.parse(row.payload) }));
}

export function finishReviewAction(db, reviewId, errorCode = null, now = new Date()) {
  if (errorCode !== null && (typeof errorCode !== "string" || !errorCode)) throw fail("invalid_review_action", "Review action error code must be null or a nonempty string.");
  return dbTransaction(db, () => {
    db.prepare("UPDATE review_actions SET status = ?, error_code = ?, updated_at = ? WHERE review_id = ? AND status = 'pending'")
      .run(errorCode === null ? "applied" : "failed", errorCode, now.toISOString(), reviewId);
    return getReviewAction(db, reviewId);
  });
}

export function getReview(db, id) {
  return plain(db.prepare("SELECT * FROM reviews WHERE id = ?").get(id));
}

export function resolveReviewRow(db, id, resolution, now = new Date()) {
  db.prepare("UPDATE reviews SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL").run(now.toISOString(), resolution, id);
}

export function activityOf(db, key) {
  const row = db.prepare("SELECT * FROM activity WHERE key = ?").get(key);
  return row ? { reads: row.reads, writes: row.writes, level: row.level, lastOpAt: row.last_op_at } : { reads: 0, writes: 0, level: 0, lastOpAt: null };
}

export function countMemories(db, { scope, project, role, teamId = "" }) {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM memories WHERE scope = ? AND team_id = ? AND IFNULL(project, '') = ? AND IFNULL(role, '') = ? AND kind = 'knowledge' AND status = 'active'")
    .get(scope, teamId, project ?? "", role ?? "");
  return row.n;
}

export function listMemoryScopes(db) {
  return db.prepare("SELECT DISTINCT scope, project, role FROM memories WHERE scope != 'team' ORDER BY scope, project, role").all().map(plain);
}

export function hasMemorySource(db, sourcePath) {
  return Boolean(db.prepare("SELECT 1 FROM memories WHERE source_path = ? LIMIT 1").get(sourcePath));
}
