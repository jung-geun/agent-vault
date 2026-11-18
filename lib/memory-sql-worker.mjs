import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { scoreTerms } from "./memory-scoring.mjs";
import { initializeSqlSchema } from "./memory-sql-schema.mjs";

const { driver, url, purpose, port, signal } = workerData;
const postgres = driver === "postgres";
const fail = (code) => Object.assign(new Error(), { code });
const messages = {
  database_driver_missing: `Install ${postgres ? "pg" : "mysql2"} next to the Agent Vault runtime to use this database driver.`,
  database_url_invalid: "Unsupported settings in the database URL. Check the documented connection options.",
  database_unavailable: "Could not initialize the SQL database. Check the server, credentials and schema permissions.",
  database_closed: "The SQL server closed this connection. Re-read state before repeating writes.",
  database_busy: "The memory database is locked by another operation.",
  database_query_failed: "SQL memory operation failed.",
  database_rolled_back: "The SQL database rolled back this transaction.",
  schema_mismatch: "Memory database schema is not supported by this version.",
  database_scope_mismatch: "Team and personal vaults must use separate SQL databases.",
  unique_violation: "A record with this database identity already exists.",
  foreign_key_violation: "The referenced database record does not exist or is in use.",
  immutable_record: "This database record is immutable.",
  database_number_range: "A database integer exceeds the supported safe integer range.",
};

function safeError(error, fallback) {
  const state = error?.code;
  let code = Object.hasOwn(messages, state) ? state : fallback;
  if (state === "23505" || error?.errno === 1062) code = "unique_violation";
  if (state === "23503" || [1451, 1452].includes(error?.errno)) code = "foreign_key_violation";
  if (state === "55P03" || state === "57014" || [1205, 1213].includes(error?.errno)) code = "database_busy";
  if (state === "P0001" || error?.errno === 1644) code = "immutable_record";
  if (error?.fatal || ["ECONNRESET", "EPIPE", "PROTOCOL_CONNECTION_LOST", "57P01", "57P02", "57P03"].includes(state)) code = "database_closed";
  // Only engine error identifiers; do not forward messages, query arguments, SQL or the DSN.
  const detail = code === fallback && (typeof state === "string" && /^(?:[0-9A-Z]{5}|ER_[A-Z0-9_]{1,60})$/.test(state)) ? ` (${state})` : "";
  return { code, message: messages[code] + detail };
}

const numeric = (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw fail("database_number_range");
  return n;
};
const binary = (value) => value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value;
let connection;
let lockName;
let inTransaction = false;
let disconnected = false;

async function connect() {
  const target = new URL(url);
  const allowed = postgres ? ["sslmode", "sslrootcert", "sslcert", "sslkey"] : ["ssl"];
  if ([...target.searchParams.keys()].some((key) => !allowed.includes(key) || target.searchParams.getAll(key).length !== 1)) throw fail("database_url_invalid");
  if (postgres) {
    const mode = target.searchParams.get("sslmode");
    if (mode !== null && !["disable", "verify-full"].includes(mode)) throw fail("database_url_invalid");
    if (mode !== "verify-full" && [...target.searchParams.keys()].some((key) => key !== "sslmode")) throw fail("database_url_invalid");
    let pg;
    try { ({ default: pg } = await import("pg")); } catch { throw fail("database_driver_missing"); }
    connection = new pg.Client({
      connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 15000, lock_timeout: 5000,
      types: { getTypeParser: (oid, format) => oid === 20 && format !== "binary" ? numeric : pg.types.getTypeParser(oid, format) },
    });
    connection.on("error", () => { disconnected = true; });
    await connection.connect();
    // Use known built-ins and a single schema in the dedicated database, independent of role defaults.
    await query("SET search_path TO public");
  } else {
    const ssl = target.searchParams.get("ssl");
    if (ssl !== null && ssl !== "true") throw fail("database_url_invalid");
    let mysql;
    try { ({ default: mysql } = await import("mysql2/promise")); } catch { throw fail("database_driver_missing"); }
    connection = await mysql.createConnection({
      host: target.hostname.replace(/^\[|\]$/g, ""), port: target.port ? Number(target.port) : 3306,
      user: decodeURIComponent(target.username), password: decodeURIComponent(target.password), database: decodeURIComponent(target.pathname.slice(1)),
      connectTimeout: 5000, supportBigNumbers: true, maxPreparedStatements: 100, charset: "UTF8MB4_BIN", flags: "-FOUND_ROWS",
      ...(ssl === "true" ? { ssl: { rejectUnauthorized: true, verifyIdentity: true } } : {}),
    });
    connection.on("error", () => { disconnected = true; });
    await query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await query("SET SESSION innodb_lock_wait_timeout = 5");
    await query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'");
    const { rows } = await query("SELECT DATABASE() AS name");
    lockName = createHash("sha256").update(`agent-vault:${rows[0].name}`).digest("hex");
  }
}

async function query(sql, params = []) {
  if (disconnected) throw fail("database_closed");
  const values = params.map(binary);
  if (postgres) {
    const result = await connection.query(sql, values);
    return { rows: result.rows, changes: result.rowCount ?? 0, lastInsertRowid: result.rows[0]?.id, command: result.command };
  }
  const [result, fields] = await (values.length ? connection.execute(sql, values) : connection.query(sql));
  if (!Array.isArray(result)) return { rows: [], changes: result.affectedRows, lastInsertRowid: numeric(result.insertId) };
  for (const field of fields) {
    if (field.columnType !== 8) continue; // MYSQL_TYPE_LONGLONG (including COUNT and IDs)
    for (const row of result) if (row[field.name] !== null) row[field.name] = numeric(row[field.name]);
  }
  return { rows: result, changes: 0 };
}

async function takeLock() {
  const { rows } = await query("SELECT GET_LOCK(?, 5) AS locked", [lockName]);
  if (Number(rows[0]?.locked) !== 1) throw fail("database_busy");
}
const releaseLock = () => query("SELECT RELEASE_LOCK(?)", [lockName]);

async function begin() {
  if (!postgres) await takeLock();
  try {
    await query(postgres ? "BEGIN ISOLATION LEVEL READ COMMITTED" : "START TRANSACTION");
    if (postgres) await query("SELECT pg_advisory_xact_lock(1769047371, 1296387395)");
    inTransaction = true;
  } catch (error) {
    try { await query("ROLLBACK"); if (!postgres) await releaseLock(); } catch { disconnected = true; }
    throw error;
  }
}

async function finish(command) {
  try {
    const result = await query(command);
    if (command === "COMMIT" && result.command === "ROLLBACK") throw fail("database_rolled_back");
  } finally {
    inTransaction = false;
    if (!postgres) await releaseLock();
  }
}

async function write(sql, params) {
  if (inTransaction) return query(sql, params);
  await begin();
  try {
    const result = await query(sql, params);
    await finish("COMMIT");
    return result;
  } catch (error) {
    if (inTransaction) try { await finish("ROLLBACK"); } catch { disconnected = true; }
    throw error;
  }
}

async function rank(first, next, projection, { params, pageSize, fieldParams, terms, limit, offset }) {
  const snapshot = !inTransaction;
  if (snapshot) {
    if (postgres) await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    else {
      await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await query("START TRANSACTION READ ONLY");
    }
  }
  try {
    const byScore = new Map();
    let page = (await query(first, params)).rows;
    for (;;) {
      for (const { id, title, content, tags } of page) {
        const score = scoreTerms(title, content, tags, terms);
        if (!score) continue;
        if (!byScore.has(score)) byScore.set(score, []);
        byScore.get(score).push(id);
      }
      if (page.length < pageSize) break;
      page = (await query(next, [...params, page.at(-1).id])).rows;
    }
    const selected = [];
    for (const score of [...byScore.keys()].sort((a, b) => b - a)) {
      const bucket = byScore.get(score);
      if (offset >= bucket.length) { offset -= bucket.length; continue; }
      selected.push(...bucket.slice(offset, offset + limit - selected.length));
      if (selected.length === limit) break;
      offset = 0;
    }
    if (!selected.length) return [];
    const { rows } = await query(projection, [...fieldParams, JSON.stringify(selected)]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return selected.map((id) => byId.get(id));
  } finally {
    if (snapshot) await query("ROLLBACK");
  }
}

const methods = {
  query: (sql, params, mutating) => (mutating ? write : query)(sql, params),
  begin,
  commit: () => finish("COMMIT"),
  rollback: () => finish("ROLLBACK"),
  rank,
  async prepareImportIdentities(heads) {
    if (!inTransaction) throw fail("database_query_failed");
    const tables = new Set(["memories", "reviews", "review_feedback", "persona_patterns", "persona_evidence", "persona_decisions"]);
    for (const [table, next] of heads) {
      if (!tables.has(table) || !Number.isSafeInteger(next) || next < 1) throw fail("database_query_failed");
      // MariaDB/MySQL DDL commits. The advisory lock outlives the transaction,
      // so raise identity heads before copying rows, then start a fresh transaction.
      await query(`ALTER TABLE ${table} ${postgres ? `ALTER COLUMN id RESTART WITH ${next}` : `AUTO_INCREMENT = ${next}`}`);
    }
    if (!postgres && heads.length) await query("START TRANSACTION");
  },
  close: () => connection.end(),
};

try {
  await connect();
  if (postgres) {
    await begin();
    try { await initializeSqlSchema(driver, query, purpose); await finish("COMMIT"); }
    catch (error) { if (inTransaction) await finish("ROLLBACK"); throw error; }
  } else {
    await takeLock();
    try { await initializeSqlSchema(driver, query, purpose); } finally { await releaseLock(); }
  }
  port.on("message", async ({ method, args }) => {
    let response;
    try { response = { result: await methods[method](...args) }; }
    catch (error) { response = { error: safeError(error, "database_query_failed") }; }
    try { port.postMessage(response); }
    finally { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); }
  });
  parentPort.postMessage({ ready: true });
} catch (error) {
  parentPort.postMessage({ error: safeError(error, "database_unavailable") });
  try { await connection?.end(); } catch { /* Worker's parent closes the failed session. */ }
  port.close();
}
