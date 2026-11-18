import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dbTransaction, memoryDbFile, memoryTaskHost, openMemoryDb, openTeamMemoryDb, openVaultMemoryDb } from "./memory-db.mjs";
import { VaultToolError } from "./memory-store.mjs";
import { loadDatabaseConfig, loadSettings, storageFilePath } from "./settings.mjs";

// Logical columns only: omit backend-specific generated digest columns. The order
// is topological for the FK graph, independent of the order of SQLite tables.
const TABLES = {
  meta: "k v",
  memories: "id scope project role team_id slug title content tags content_hash source_path status superseded_by created_at updated_at last_read_at read_count kind week_key event_date task_id worktree",
  memory_embeddings: "memory_id model dim vector text_hash created_at",
  activity: "key reads writes level last_op_at",
  reviews: "id key reason total_ops created_at ready_at resolved_at resolution",
  memory_tasks: "id owner_pid status started_at finished_at",
  review_actions: "review_id payload status error_code created_at updated_at",
  review_feedback: "id review_id memory_id trigger feedback source_hash created_at",
  weekly_task_attributions: "task_id week_key business_date time_zone workday_start parent_task_id resume_task_id",
  weekly_exports: "path scope project week_key content_hash latest_event_date exported_at",
  persona_profiles: "scope project revision active applied_at",
  persona_patterns: "id scope project category pattern created_at",
  persona_evidence: "id pattern_id guidance source_kind evidence evidence_hash task_id created_at",
  persona_decisions: "id pattern_id action guidance evidence_through applied_at created_at",
};
const names = Object.keys(TABLES);
const sequences = names.filter((name) => TABLES[name].startsWith("id ") && name !== "memory_tasks");
const quote = (name) => `"${name}"`;
const dataFilter = (name) => name === "meta" ? " WHERE k NOT IN ('schema', 'sql_schema', 'database_scope')" : "";
const count = (db, name) => db.prepare(`SELECT COUNT(*) AS n FROM ${name}${dataFilter(name)}`).get().n;
const fail = (code, message) => new VaultToolError(code, message);

function inspect(db, team) {
  const present = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(({ name }) => name));
  const sourceSchema = present.has("meta") && db.prepare("SELECT v FROM meta WHERE k = 'schema'").get()?.v;
  if (!["1", "2", "3", "4", "5", "6"].includes(sourceSchema) || !present.has("memories")) {
    throw fail("schema_mismatch", "Source is not a supported Agent Vault SQLite memory database.");
  }
  const counts = Object.fromEntries(names.map((name) => [name, present.has(name) ? count(db, name) : 0]));
  if (team && (names.some((name) => !["memories", "memory_embeddings"].includes(name) && counts[name])
    || db.prepare("SELECT 1 FROM memories WHERE scope != 'team' LIMIT 1").get())) {
    throw fail("database_migration_scope", "Team migration accepts only a dedicated SQLite team file with no personal vault records.");
  }
  return { sourceSchema, counts };
}

function copyRows(sqlite, target, name) {
  const columns = TABLES[name].split(" ");
  const sourceColumns = columns.map(quote).join(", ");
  const tasks = name === "memory_tasks";
  const destinationColumns = tasks ? `${sourceColumns}, owner_host` : sourceColumns;
  let batch = [];
  let bytes = 0;
  const values = `(${Array(columns.length + Number(tasks)).fill("?").join(", ")})`;
  const flush = () => {
    target.prepare(`INSERT INTO ${name} (${destinationColumns}) VALUES ${Array(batch.length).fill(values).join(", ")}`).run(...batch.flat());
    batch = [];
    bytes = 0;
  };
  for (const row of sqlite.prepare(`SELECT ${sourceColumns} FROM ${name}${dataFilter(name)}`).iterate()) {
    const data = columns.map((column) => row[column]);
    if (tasks) data.push(memoryTaskHost);
    const size = data.reduce((sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value) : value?.byteLength ?? 8), 0);
    if (batch.length && (batch.length >= 64 || bytes + size > 2 * 1024 * 1024)) flush();
    batch.push(data);
    bytes += size;
  }
  if (batch.length) flush();
}

export async function migrateSqliteMemory(vault, { source, dryRun = false, team = false } = {}) {
  if (team && !source) throw fail("database_migration_source", "Team migration requires --from-sqlite with the explicit team file.");
  source ??= memoryDbFile(vault);
  const teamSettings = team && !dryRun ? loadSettings(vault).team : null;
  if (!dryRun && (team ? !teamSettings.enabled || teamSettings.backend !== "sql" : loadDatabaseConfig(vault).driver === "sqlite")) {
    throw fail("database_migration_target", "Select a MySQL/MariaDB or PostgreSQL destination before copying memory records.");
  }
  let original;
  let snapshot;
  let directory;
  try {
    let report;
    let file;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      original = new DatabaseSync(storageFilePath(path.resolve(source), { tightenParent: false }), { readOnly: true });
      original.exec("PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;");
      original.exec("BEGIN;");
      report = inspect(original, team);
      original.exec("ROLLBACK;");
      if (dryRun) return { dryRun, ...report };
      directory = await mkdtemp(path.join(tmpdir(), "agent-vault-sqlite-"));
      file = path.join(directory, "memory.db");
      // VACUUM INTO takes a consistent snapshot, including committed WAL rows.
      // Any old SQLite schema upgrades happen exclusively on the private copy.
      original.prepare("VACUUM INTO ?").run(file);
      original.close();
      original = undefined;
      snapshot = await openMemoryDb(file);
      const integrity = snapshot.prepare("PRAGMA quick_check").get()?.quick_check;
      if (integrity !== "ok" || snapshot.prepare("PRAGMA foreign_key_check").get()) {
        throw fail("sqlite_source_invalid", "SQLite snapshot did not pass integrity and foreign-key checks.");
      }
    } catch (error) {
      if (error instanceof VaultToolError) throw error;
      throw fail("sqlite_source_invalid", "Could not read and verify the SQLite source. Check its path, permissions, runtime, and schema.");
    }

    const { counts } = inspect(snapshot, team);
    const target = await (team ? openTeamMemoryDb(teamSettings) : openVaultMemoryDb(vault));
    if (!target.driver) throw fail("database_migration_target", "Select a SQL backend before copying memory records.");
    dbTransaction(target, () => {
      if (names.some((name) => count(target, name) !== 0)) {
        throw fail("database_migration_not_empty", "Migration requires an empty destination database; no records were copied.");
      }
      const identityHeads = [];
      for (const table of sequences) {
        const seq = snapshot.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table)?.seq ?? 0;
        if (!Number.isSafeInteger(seq + 1)) throw fail("database_number_range", "Source identity exceeds the supported safe integer range.");
        if (seq > 0) identityHeads.push([table, seq + 1]);
      }
      target.prepareImportIdentities(identityHeads);
      for (const name of names) if (counts[name]) copyRows(snapshot, target, name);
      if (names.some((name) => count(target, name) !== counts[name])) throw fail("database_migration_counts", "Destination counts do not match the SQLite snapshot; import was rolled back.");
    });
    return { dryRun, driver: target.driver, sourceSchema: report.sourceSchema, counts };
  } finally {
    try { original?.close(); } finally {
      try { snapshot?.close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
    }
  }
}
