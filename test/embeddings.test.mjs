import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { embedTexts, resolveEmbedder } from "../lib/embeddings.mjs";
import { closeMemoryDbs, getEmbeddings, getMemory, insertMemory, memoryDbFile, openMemoryDb, searchMemories, setStatus } from "../lib/memory-db.mjs";
import { diagnoseMemory, memoryStats } from "../lib/memory-inspect.mjs";
import { publicSettings, saveSettings, SettingsError } from "../lib/settings.mjs";
import { similarRank } from "../lib/similar-search.mjs";
import { initVault } from "../lib/vault-core.mjs";
import { createProject } from "../lib/memory-store.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/vault-cli.mjs", import.meta.url));
const groups = [
  ["deploy", "release", "ship"], ["db", "database", "sql"], ["edit", "change", "rewrite"],
  ["tests", "test", "verify"], ["docs", "documentation"],
];
const byWord = new Map(groups.flatMap((group, axis) => group.map((word) => [word, axis])));
const vector = (text) => {
  const values = Array(16).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const axis = byWord.get(word);
    if (axis !== undefined) values[axis]++;
  }
  if (values.every((value) => value === 0)) values[15] = 1;
  return values;
};

async function fakeServer(t) {
  const state = { tags: ["nomic-embed-text:latest", "all-minilm:latest"], models: [], posts: [], gets: [] };
  const server = createServer(async (req, res) => {
    try {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") {
        state.gets.push(req.url);
        if (req.url === "/api/tags") res.end(JSON.stringify({ models: state.tags.map((name) => ({ name })) }));
        else if (req.url === "/v1/models") res.end(JSON.stringify({ data: state.models.map((id) => ({ id })) }));
        else { res.statusCode = 404; res.end(); }
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      state.posts.push({ path: req.url, body, authorization: req.headers.authorization });
      if (state.reply) return state.reply(res, body.input);
      res.end(JSON.stringify({ data: body.input.map((text, index) => ({ embedding: vector(text), index })).reverse() }));
    } catch { res.statusCode = 500; res.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  async function close() {
    if (!server.listening) return;
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  t.after(close);
  return { endpoint, state, close };
}

function mapDiscovery(t, endpoint) {
  const fetch = globalThis.fetch;
  const requested = [];
  const discovery = new Set(["http://127.0.0.1:11434/api/tags", "http://127.0.0.1:1234/v1/models"]);
  t.mock.method(globalThis, "fetch", (url, init) => {
    if (!discovery.has(url)) return fetch(url, init);
    requested.push(url);
    return fetch(`${endpoint}${new URL(url).pathname}`, init);
  });
  return requested;
}

async function fixture(t) {
  const vault = await realpath(await mkdtemp(path.join(tmpdir(), "agent-vault-embeddings-")));
  t.after(async () => { closeMemoryDbs(); await rm(vault, { recursive: true, force: true }); });
  await initVault(vault);
  const db = await openMemoryDb(memoryDbFile(vault));
  return { vault, db };
}

const http = (endpoint, model = "all-minilm:latest", more = {}) => ({ embedding: { provider: "http", endpoint, model, ...more } });
const insert = (db, title, content, more = {}, now) => insertMemory(db, { scope: "global", title, content, ...more }, now).memory;
const candidates = (db) => searchMemories(db, { scope: "global" });
const unavailable = (pattern) => (error) => error.code === "embedding_unavailable" && pattern.test(error.message);
const embeddingCheck = (report) => report.checks.find(({ name }) => name === "embedding");

async function cliJson(vault, ...args) {
  const { stdout } = await exec(process.execPath, [cli, ...args, "--path", vault]);
  return JSON.parse(stdout);
}

test("embedding settings restrict endpoints, require HTTP configuration, and redact public settings", async (t) => {
  const { vault } = await fixture(t);
  for (const endpoint of ["https://example.test", "http://127.0.0.2", "http://localhost.evil.test", "http://user:secret@localhost", "http://localhost/path", "http://localhost/a/..", "http://localhost?#", "ftp://localhost", "http://localhost:70000", "http://localhost?", "http://localhost#"]) {
    await assert.rejects(saveSettings(vault, http(endpoint)), SettingsError);
  }
  for (const embedding of [{ provider: "http" }, { provider: "http", endpoint: "https://localhost" }, { provider: "http", model: "model" }, { provider: "remote" }, { model: " " }, { timeoutMs: 199 }, { timeoutMs: 30_001 }, { backfillPerCall: 0 }, { backfillPerCall: 501 }]) {
    await assert.rejects(saveSettings(vault, { embedding }), SettingsError);
  }
  await assert.rejects(saveSettings(vault, { embedding: { model: `sk-${"x".repeat(24)}` } }), /not a credential/);
  for (const endpoint of ["http://localhost:1234/", "https://[::1]:1234", "http://127.0.0.1:1234"]) {
    const settings = await saveSettings(vault, http(endpoint));
    assert.equal(settings.embedding.endpoint, endpoint);
    assert.deepEqual(publicSettings(settings).embedding, { provider: "http", model: "all-minilm:latest", endpointConfigured: true });
  }
  assert.deepEqual((await cliJson(vault, "config", "--embedding", "http", "--embedding-endpoint", "http://localhost:4321", "--embedding-model", "small")).embedding,
    { provider: "http", endpoint: "http://localhost:4321", model: "small", timeoutMs: 3000, backfillPerCall: 64 });
  await assert.rejects(cliJson(vault, "config", "--embedding", "bad"), /--embedding must be/);
});

test("a schema v5 database gains vector storage without altering existing rows", async (t) => {
  const { vault, db } = await fixture(t);
  const memory = insert(db, "Keep", "Existing schema five data");
  db.exec("DROP TABLE memory_embeddings; UPDATE meta SET v = '5' WHERE k = 'schema';");
  closeMemoryDbs();
  const migrated = await openMemoryDb(memoryDbFile(vault));
  assert.equal(migrated.prepare("SELECT v FROM meta WHERE k = 'schema'").get().v, "6");
  assert.deepEqual(getMemory(migrated, memory.id), memory);
  assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get().n, 0);
});

test("off and HTTP never probe; auto chooses a model, caches, and tries the second server", async (t) => {
  const { vault } = await fixture(t);
  const server = await fakeServer(t);
  const requested = mapDiscovery(t, server.endpoint);
  await saveSettings(vault, { embedding: { provider: "off" } });
  assert.deepEqual(await resolveEmbedder(vault), { available: false, provider: "off", reason: "embeddings are disabled" });
  await saveSettings(vault, http(`${server.endpoint}/`));
  assert.deepEqual(await resolveEmbedder(vault), { available: true, provider: "http", endpoint: server.endpoint, model: "all-minilm:latest" });
  assert.deepEqual(server.state.gets, []);
  await saveSettings(vault, { embedding: { provider: "auto" } });
  const start = Date.now();
  assert.equal((await resolveEmbedder(vault, { now: start })).model, "all-minilm:latest");
  server.state.tags = ["other-instruct"];
  server.state.models = ["nomic-embed-text:latest", "bge-small-en"];
  assert.equal((await resolveEmbedder(vault, { now: start + 59_999 })).model, "all-minilm:latest");
  assert.deepEqual(server.state.gets, ["/api/tags"]);
  const fallback = await resolveEmbedder(vault, { now: start + 60_001 });
  assert.equal(fallback.model, "bge-small-en");
  assert.equal(fallback.endpoint, "http://127.0.0.1:1234");
  assert.deepEqual(requested, ["http://127.0.0.1:11434/api/tags", "http://127.0.0.1:11434/api/tags", "http://127.0.0.1:1234/v1/models"]);
  server.state.models = [];
  assert.deepEqual(await resolveEmbedder(vault, { now: start + 120_002 }), { available: false, provider: "auto", reason: "no local embedding model detected" });
  await server.close();
  assert.equal((await resolveEmbedder(vault, { now: start + 180_003 })).reason, "embedding server unreachable");
});

test("auto prefers a multilingual model over a lighter English-only one, and falls back to English-only when it is all there is", async (t) => {
  const { vault } = await fixture(t);
  const server = await fakeServer(t);
  mapDiscovery(t, server.endpoint);
  await saveSettings(vault, { embedding: { provider: "auto" } });
  const start = Date.now();
  server.state.tags = ["all-minilm:latest", "granite-embedding:278m", "nomic-embed-text:latest"];
  assert.equal((await resolveEmbedder(vault, { now: start })).model, "granite-embedding:278m");
  server.state.tags = ["nomic-embed-text:latest", "all-minilm:latest"];
  assert.equal((await resolveEmbedder(vault, { now: start + 60_001 })).model, "all-minilm:latest");
  server.state.tags = ["all-minilm:latest", "multilingual-e5-small:latest"];
  assert.equal((await resolveEmbedder(vault, { now: start + 120_002 })).model, "multilingual-e5-small:latest");
});

test("embedTexts batches, truncates, restores indexed order, and normalizes float32 results", async (t) => {
  const { vault } = await fixture(t);
  const { endpoint, state } = await fakeServer(t);
  await saveSettings(vault, http(endpoint));
  const embedder = await resolveEmbedder(vault);
  const vectors = await embedTexts(embedder, [`deploy ship db ${"x".repeat(2010)}`, ...Array(33).fill("sql")], { timeoutMs: 3000 });
  assert.deepEqual(state.posts.map(({ body }) => body.input.length), [32, 2]);
  assert.equal(state.posts[0].body.input[0].length, 2000);
  assert.ok(state.posts.every(({ path: route, authorization }) => route === "/v1/embeddings" && authorization === undefined));
  assert.ok(vectors.every((value) => value instanceof Float32Array && value.length === 16));
  assert.ok(Math.abs(Math.hypot(...vectors[0]) - 1) < 1e-7);
  assert.ok(vectors[0][0] > vectors[0][1]);
  assert.equal(vectors[1][1], 1);
});

test("embedTexts rejects malformed responses, redirects, and timeouts without leaking response text", async (t) => {
  const { endpoint, state } = await fakeServer(t);
  const embedder = { available: true, provider: "http", endpoint, model: "all-minilm" };
  for (const malformed of [
    "{", "null", '{"data":[]}', '{"data":[{"embedding":[1e999]},{"embedding":[0]}]}',
    '{"data":[{"embedding":[1e100]},{"embedding":[0]}]}',
    '{"data":[{"embedding":[1,"0"]},{"embedding":[0,1]}]}',
    '{"data":[{"embedding":[1]},{"embedding":[0,1]}]}',
    '{"data":[{"embedding":[]},{"embedding":[]}]}',
    '{"data":[{"embedding":[1],"index":0},{"embedding":[0],"index":0}]}',
    '{"data":[{"embedding":[1],"index":0},{"embedding":[0]}]}',
  ]) {
    state.reply = (res) => res.end(malformed);
    await assert.rejects(embedTexts(embedder, ["deploy", "db"]), unavailable(/invalid vectors/));
  }
  state.reply = (res) => { res.writeHead(307, { location: `${endpoint}/not-allowed` }); res.end(); };
  await assert.rejects(embedTexts(embedder, ["private context"]), unavailable(/HTTP 307/));
  assert.equal(state.posts.some(({ path: route }) => route === "/not-allowed"), false);
  state.reply = () => {};
  await assert.rejects(embedTexts(embedder, ["db"], { timeoutMs: 35 }), unavailable(/timed out/));
});

test("similarRank embeds synonyms, reuses vectors, and invalidates on text or model identity changes", async (t) => {
  const { vault, db } = await fixture(t);
  const server = await fakeServer(t);
  const deployment = insert(db, "Deploy guide", "Release procedure");
  const database = insert(db, "Run SQL", "Database setup");
  await saveSettings(vault, http(server.endpoint));
  const query = "how do we ship";
  const rank = () => similarRank(vault, db, candidates(db), query, { method: "embedding" });
  const first = await rank();
  assert.deepEqual(first.search, { mode: "similar", method: "embedding", model: "all-minilm:latest", candidates: 2, embedded: 2, pending: 0 });
  assert.deepEqual(first.results.map(({ memory, similarity }) => [memory.id, similarity]), [[deployment.id, 1], [database.id, 0]]);
  assert.equal(server.state.posts.length, 2);
  assert.deepEqual((await rank()).results, first.results);
  assert.deepEqual(server.state.posts[2].body.input, [query]);
  assert.equal(server.state.posts.length, 3);
  db.prepare("UPDATE memories SET content = ? WHERE id = ?").run("database sql setup", deployment.id);
  assert.deepEqual((await memoryStats(vault)).embedding.coverage, { embedded: 1, total: 2 });
  const changed = await rank();
  assert.deepEqual(server.state.posts[3].body.input, ["Deploy guide\ndatabase sql setup"]);
  assert.ok(changed.results[0].similarity < 1);
  assert.deepEqual((await memoryStats(vault)).embedding.coverage, { embedded: 2, total: 2 });
  assert.equal(server.state.posts.length, 5);
  await saveSettings(vault, http(server.endpoint, "different-model"));
  assert.equal((await rank()).search.model, "different-model");
  const ids = [deployment.id, database.id];
  assert.equal(getEmbeddings(db, "all-minilm:latest", ids).size, 2);
  assert.equal(getEmbeddings(db, "different-model", ids).size, 2);
  assert.deepEqual(server.state.posts.slice(5).map(({ body }) => body.input.length), [2, 1]);
});

test("coverage compares the actual title-only text for withheld content", async (t) => {
  const { vault, db } = await fixture(t);
  const server = await fakeServer(t);
  await saveSettings(vault, http(server.endpoint));
  const entry = insert(db, "Deploy guide", `Example API key sk-${"x".repeat(24)}`);
  const rank = await similarRank(vault, db, [entry], "ship");
  assert.equal(rank.search.withheld, 1);
  assert.deepEqual(server.state.posts[0].body.input, ["Deploy guide"]);
  assert.deepEqual((await memoryStats(vault)).embedding.coverage, { embedded: 1, total: 1 });
  const update = db.prepare("UPDATE memories SET content = ? WHERE id = ?");
  update.run(`Edited example API key sk-${"y".repeat(24)}`, entry.id);
  assert.deepEqual((await memoryStats(vault)).embedding.coverage, { embedded: 1, total: 1 });
  update.run("Safe deployment guide", entry.id);
  assert.deepEqual((await memoryStats(vault)).embedding.coverage, { embedded: 0, total: 1 });
  assert.equal(server.state.posts.length, 2);
});

test("similarRank falls back for partial or unreachable coverage and chars makes no request", async (t) => {
  const { vault, db } = await fixture(t);
  const server = await fakeServer(t);
  for (const [day, item] of ["Deploy book", "Deploy guide", "Database setup"].entries()) {
    insert(db, item, `Notes for ${item}`, {}, new Date(`2026-01-0${day + 1}T00:00:00Z`));
  }
  const memories = candidates(db);
  await saveSettings(vault, http(server.endpoint, "all-minilm", { backfillPerCall: 1 }));
  const partial = await similarRank(vault, db, memories, "deploy", {});
  assert.deepEqual(partial.search, { mode: "similar", method: "chars", model: "all-minilm", candidates: 3, embedded: 1, pending: 2, fallback: "embeddings incomplete: 2 of 3 candidates pending" });
  assert.deepEqual(partial.results.map(({ memory }) => memory.title), ["Deploy guide", "Deploy book"]);
  await assert.rejects(similarRank(vault, db, memories, "deploy", { method: "embedding" }), unavailable(/1 of 3 candidates pending.*vault-cli memory embed/));
  assert.equal(server.state.posts.length, 2);
  const chars = await similarRank(vault, db, memories, "deploy", { method: "chars" });
  assert.deepEqual(chars.search, { mode: "similar", method: "chars", candidates: 3 });
  assert.deepEqual(chars.results, partial.results);
  assert.equal(server.state.posts.length, 2);
  assert.deepEqual(server.state.gets, []);
  await server.close();
  const unavailableAuto = await similarRank(vault, db, memories, "deploy");
  assert.deepEqual(unavailableAuto.results, chars.results);
  assert.match(unavailableAuto.search.fallback, /1 of 3 candidates pending; embedding server unreachable/);
  assert.equal(unavailableAuto.search.pending, 1);
  assert.equal(unavailableAuto.search.method, "chars");
});

test("memory embed CLI backfills newest active knowledge in the selected scope", async (t) => {
  const { vault, db } = await fixture(t);
  const server = await fakeServer(t);
  await saveSettings(vault, http(server.endpoint));
  const older = insert(db, "Older", "Release", {}, new Date("2026-01-01"));
  const newer = insert(db, "Newer", "Deploy", {}, new Date("2026-02-01"));
  setStatus(db, insert(db, "Archived", "Deploy").id, "archived");
  insert(db, "Project-only", "Deploy", { scope: "project", project: "sample-project" });
  assert.deepEqual(await cliJson(vault, "memory", "embed", "--scope", "global", "--limit", "1"), { model: "all-minilm:latest", embedded: 1, remaining: 1 });
  assert.deepEqual(server.state.posts[0].body.input, ["Newer\nDeploy"]);
  assert.deepEqual(await cliJson(vault, "memory", "embed", "--scope", "global"), { model: "all-minilm:latest", embedded: 1, remaining: 0 });
  assert.deepEqual(server.state.posts[1].body.input, ["Older\nRelease"]);
  assert.equal(getEmbeddings(db, "all-minilm:latest", [older.id, newer.id]).size, 2);
  assert.deepEqual(await cliJson(vault, "memory", "embed", "--scope", "global"), { model: "all-minilm:latest", embedded: 0, remaining: 0 });
  await assert.rejects(cliJson(vault, "memory", "embed", "--scope", "global", "--limit", "5001"), /1 to 5000/);
  await saveSettings(vault, { embedding: { provider: "off" } });
  await assert.rejects(cliJson(vault, "memory", "embed", "--scope", "global"), /embeddings are disabled.*local embedding server/);
  assert.equal(server.state.posts.length, 2);
});

test("stats scope coverage and diagnose health are read-only (ok, info, warn)", async (t) => {
  const { vault, db } = await fixture(t);
  const server = await fakeServer(t);
  await createProject(vault, { project: "sample-project", title: "Sample" });
  const global = insert(db, "Global guidance", "Deploy");
  insert(db, "Project guidance", "Ship", { scope: "project", project: "sample-project" });
  insert(db, "Other project", "SQL", { scope: "project", project: "other-project" });
  await saveSettings(vault, http(server.endpoint));
  await similarRank(vault, db, [global], "deploy", { method: "embedding" });
  const postCount = server.state.posts.length;
  const stats = await memoryStats(vault, { project: "sample-project" });
  assert.deepEqual(stats.embedding, { provider: "http", available: true, model: "all-minilm:latest", endpoint: server.endpoint, coverage: { embedded: 1, total: 2 } });
  assert.deepEqual(server.state.gets, []);
  const ok = embeddingCheck(await diagnoseMemory(vault, { project: "sample-project" }));
  assert.equal(ok.status, "ok");
  assert.match(ok.detail, /all-minilm.*1 of 2.*English-centric.*Korean/);
  assert.deepEqual(server.state.gets, ["/v1/models"]);
  await saveSettings(vault, { embedding: { provider: "off" } });
  const info = embeddingCheck(await diagnoseMemory(vault));
  assert.equal(info.status, "info");
  assert.match(info.fix, /ollama pull all-minilm.*mode similar/);
  await saveSettings(vault, http(server.endpoint));
  await server.close();
  const warn = embeddingCheck(await diagnoseMemory(vault, { project: "sample-project" }));
  assert.equal(warn.status, "warn");
  assert.match(warn.detail, /unreachable.*1 of 2/);
  assert.match(warn.fix, /loopback server/);
  assert.equal(server.state.posts.length, postCount);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get().n, 1);
});
