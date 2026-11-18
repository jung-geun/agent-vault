import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { VaultToolError } from "./memory-store.mjs";

const TIMEOUT = 30_000;
const failure = (code, text) => new VaultToolError(code, text);

// The native SQLite statement API and its transaction callbacks are synchronous.
// Keep each remote session pinned to one worker connection and preserve that
// boundary rather than allowing transaction callbacks to interleave across awaits.
export async function openSqlDatabase(config, onClose) {
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL("./memory-sql-worker.mjs", import.meta.url), {
    workerData: { ...config, port: port2, signal }, transferList: [port2], execArgv: [], env: {},
  });
  let closed = false;
  const tearDown = () => {
    if (closed) return;
    closed = true;
    port1.close();
    void worker.terminate();
    onClose();
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(failure("database_timeout", "Database initialization timed out.")), TIMEOUT);
      worker.on("error", () => reject(failure("database_unavailable", "SQL database worker failed.")));
      worker.on("exit", () => {
        reject(failure("database_unavailable", "SQL database worker stopped."));
        tearDown();
      });
      worker.once("message", ({ error }) => {
        if (error) reject(failure(error.code, error.message));
        else resolve();
      });
      worker.once("exit", () => clearTimeout(timer));
      worker.once("message", () => clearTimeout(timer));
    });
  } catch (error) {
    tearDown();
    throw error;
  }
  port1.unref();
  worker.unref();

  const request = (method, args = []) => {
    if (closed) throw failure("database_closed", "SQL database connection is closed.");
    Atomics.store(signal, 0, 0);
    port1.postMessage({ method, args });
    const timedOut = Atomics.wait(signal, 0, 0, TIMEOUT) === "timed-out";
    const response = !timedOut && receiveMessageOnPort(port1)?.message;
    if (!response) {
      tearDown();
      throw failure("database_timeout", "SQL database did not respond; the connection was closed. Re-read state before repeating writes.");
    }
    if (response.error) {
      if (response.error.code === "database_closed") tearDown();
      throw failure(response.error.code, response.error.message);
    }
    return response.result;
  };

  const { driver } = config;
  const compile = driver === "postgres"
    ? (sql) => { let i = 0; return sql.replace(/('(?:[^']|'')*'|"(?:[^"]|"")*")|\?/g, (match, quoted) => quoted ?? `$${++i}`); }
    : (sql) => sql.replace(/('(?:[^']|'')*')|"([A-Za-z_][\w]*)"/g, (_, literal, name) => literal ?? `\`${name}\``);
  const query = (sql, params, write = false) => request("query", [compile(sql), params, write]);
  return {
    driver,
    prepare(sql) {
      const compiled = compile(sql);
      const execute = (params, write = false) => request("query", [compiled, params, write]);
      return {
        get: (...params) => execute(params).rows[0],
        all: (...params) => execute(params).rows,
        iterate: (...params) => execute(params).rows.values(),
        run: (...params) => execute(params, true),
      };
    },
    exec(sql) { query(sql, [], true); },
    rank({ first, next, projection, ...options }) {
      return request("rank", [compile(first), compile(next), compile(projection), options]);
    },
    prepareImportIdentities(heads) { request("prepareImportIdentities", [heads]); },
    begin() { request("begin"); },
    commit() { request("commit"); },
    rollback() { request("rollback"); },
    savepoint(name) { request("query", [`SAVEPOINT ${name}`, [], false]); },
    release(name) { request("query", [`RELEASE SAVEPOINT ${name}`, [], false]); },
    rollbackTo(name) { request("query", [`ROLLBACK TO SAVEPOINT ${name}`, [], false]); },
    close() {
      if (closed) return;
      try { request("close"); } finally { tearDown(); }
    },
  };
}
