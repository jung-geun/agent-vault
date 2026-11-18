import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initVault, scaffoldProject } from "../lib/vault-core.mjs";
import * as store from "../lib/memory-store.mjs";
import { longMemorySearch, longTermWrite, recallMemory } from "../lib/memory-tiers.mjs";
import { queryWeeklyMemory } from "../lib/weekly-memory.mjs";
import { saveSettings } from "../lib/settings.mjs";
import { closeMemoryDbs, insertMemory, memoryDbFile, openMemoryDb } from "../lib/memory-db.mjs";
import { CANDIDATE_CAP, TOP_K } from "../lib/search-modes.mjs";
import { REGEX_LIMITS } from "../lib/regex-search.mjs";

const exec = promisify(execFile);
const serverPath = fileURLToPath(new URL("../bin/vault-mcp.mjs", import.meta.url));

async function fixture(t, embedding = { provider: "off" }) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-search-modes-"));
  t.after(async () => { closeMemoryDbs(); await rm(root, { recursive: true, force: true }); });
  const vault = path.join(root, "vault");
  await initVault(vault);
  await scaffoldProject(vault, "alpha", "Alpha");
  // Never probe a real local embedding server from tests: the default provider is auto.
  await saveSettings(vault, { embedding });
  return { root, vault };
}

const remember = (vault, title, content, extra = {}) => longTermWrite(vault, { project: "alpha", title, content, ...extra });
const titles = (response) => (response.results ?? response.records).map((item) => item.title);
const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code, `expected ${code}`);

// Deterministic fake embedder: synonyms share an axis, so "ship" lands next to "deploy".
const AXES = [["deploy", "release", "ship"], ["db", "database", "sql"], ["edit", "change", "rewrite"], ["tests", "test", "verify"]];
const axisOf = new Map(AXES.flatMap((words, axis) => words.map((word) => [word, axis])));
const embed = (text) => {
  const values = Array(8).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) if (axisOf.has(word)) values[axisOf.get(word)]++;
  if (values.every((value) => value === 0)) values[7] = 1;
  return values;
};

async function fakeEmbedder(t) {
  const posts = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader("content-type", "application/json");
    if (req.method !== "POST" || req.url !== "/v1/embeddings") { res.statusCode = 404; res.end("{}"); return; }
    const { input } = JSON.parse(Buffer.concat(chunks).toString());
    posts.push(input);
    res.end(JSON.stringify({ data: input.map((text, index) => ({ embedding: embed(text), index })) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise((resolve) => { if (!server.listening) return resolve(); server.close(resolve); server.closeAllConnections(); });
  t.after(close);
  return { endpoint: `http://127.0.0.1:${server.address().port}`, posts, close };
}

test("search modes cap candidates at the regex row limit and load in any import order", async () => {
  assert.equal(CANDIDATE_CAP, REGEX_LIMITS.maxRows);
  assert.deepEqual([TOP_K.default, TOP_K.max], [5, 10]);
  // memory-store, weekly-memory and search-modes import each other; a top-level read of another module would throw in some orders.
  for (const first of ["regex-search", "search-modes", "memory-store", "weekly-memory", "similar-search", "similarity"]) {
    const url = (name) => JSON.stringify(new URL(`../lib/${name}.mjs`, import.meta.url).href);
    await exec(process.execPath, ["--input-type=module", "-e", `await import(${url(first)}); await import(${url("memory-tiers")});`]);
  }
});

test("long_search regex matches Unicode patterns, ranks by match count, attributes the field, and counts as a read", async (t) => {
  const { vault } = await fixture(t);
  await remember(vault, "Release process", "The deploy job runs after CI is green. Deploy notes live here.");
  await remember(vault, "Rarely", "A single deploy mention.");
  await remember(vault, "배포 절차", "운영 서버 배포는 CI가 끝난 뒤 수행한다.");
  await remember(vault, "Database", "The sql migration alters the schema.");

  const found = await longMemorySearch(vault, { project: "alpha", mode: "regex", query: "deploy" });
  assert.deepEqual(titles(found), ["Release process", "Rarely"]);
  assert.equal(found.results[0].match.count, 2);
  assert.equal(found.results[0].score, 2);
  assert.equal(found.results[0].match.field, "content");
  assert.match(found.results[0].match.excerpt, /deploy/i);
  assert.deepEqual(
    { mode: found.search.mode, method: found.search.method, flags: found.search.flags, candidates: found.search.candidates, truncated: found.search.truncated },
    { mode: "regex", method: "regex", flags: "iu", candidates: 4, truncated: false },
  );
  assert.deepEqual(titles(await longMemorySearch(vault, { project: "alpha", mode: "regex", query: "배포.*수행" })), ["배포 절차"]);
  assert.deepEqual(titles(await longMemorySearch(vault, { project: "alpha", mode: "regex", query: "^database$" })), ["Database"], "titles are matched too");
  assert.deepEqual(titles(await longMemorySearch(vault, { project: "alpha", mode: "regex", query: "DEPLOY", flags: "" })), [], "empty flags make the pattern case sensitive");

  const again = await longMemorySearch(vault, { project: "alpha", mode: "regex", query: "deploy" });
  assert.equal(again.results[0].readCount, found.results[0].readCount + 1, "regex results are counted reads");
});

test("regex and similar validate mode arguments before any scan", async (t) => {
  const { vault } = await fixture(t);
  await remember(vault, "A", "deploy");
  const base = { project: "alpha", query: "deploy" };
  await rejects(longMemorySearch(vault, { ...base, mode: "regex", limit: 11 }), "invalid_limit");
  await rejects(longMemorySearch(vault, { ...base, mode: "similar", limit: 0 }), "invalid_limit");
  await rejects(longMemorySearch(vault, { ...base, mode: "regex", offset: 1 }), "invalid_offset");
  await rejects(longMemorySearch(vault, { ...base, mode: "regex", method: "chars" }), "invalid_method");
  await rejects(longMemorySearch(vault, { ...base, mode: "similar", flags: "i" }), "invalid_mode");
  await rejects(longMemorySearch(vault, { ...base, mode: "keyword", method: "chars" }), "invalid_mode");
  await rejects(longMemorySearch(vault, { ...base, mode: "fuzzy" }), "invalid_mode");
  await rejects(longMemorySearch(vault, { ...base, mode: "similar", method: "magic" }), "invalid_method");
  await rejects(longMemorySearch(vault, { ...base, mode: "regex", query: "(" }), "invalid_regex");
  await rejects(longMemorySearch(vault, { ...base, mode: "regex", flags: "g" }), "invalid_regex");
  await rejects(longMemorySearch(vault, { ...base, mode: "regex", query: "x".repeat(301) }), "invalid_regex");
  await rejects(longMemorySearch(vault, { project: "alpha", mode: "regex" }), "invalid_query");
  assert.deepEqual(titles(await longMemorySearch(vault, { ...base, mode: "regex", limit: 10 })), ["A"]);
  assert.equal((await longMemorySearch(vault, { ...base })).search, undefined, "keyword responses are unchanged");
});

test("similar with method chars needs no model, finds Korean and partial identifiers, and returns top five by default", async (t) => {
  const { vault } = await fixture(t);
  await remember(vault, "배포 절차", "운영 서버 배포는 CI가 끝난 뒤 수행한다.");
  await remember(vault, "릴리스 점검", "릴리스 전에 체크리스트를 확인한다.");
  await remember(vault, "Identifier", "The feature flag is named ENABLE_WEEKLY_JOURNAL_EXPORT in settings.");
  for (let i = 0; i < 8; i++) await remember(vault, `Filler ${i}`, `Unrelated lunch menu ${i}`);

  const korean = await longMemorySearch(vault, { project: "alpha", mode: "similar", method: "chars", query: "배포 절차" });
  assert.equal(korean.results[0].title, "배포 절차");
  assert.ok(korean.results[0].similarity > 0.5 && korean.results[0].similarity <= 1);
  assert.deepEqual({ mode: korean.search.mode, method: korean.search.method, fallback: korean.search.fallback }, { mode: "similar", method: "chars", fallback: undefined });
  assert.ok(korean.results.length <= 5);

  const partial = await longMemorySearch(vault, { project: "alpha", mode: "similar", method: "chars", query: "WEEKLY_JOURNAL_EXP" });
  assert.equal(partial.results[0].title, "Identifier");

  const wide = await longMemorySearch(vault, { project: "alpha", mode: "similar", method: "chars", query: "the", limit: 10 });
  assert.ok(wide.results.length <= 10);
});

test("similar auto falls back to characters with a reason when embeddings are off; explicit embedding refuses", async (t) => {
  const { vault } = await fixture(t);
  await remember(vault, "Release process", "The deploy job runs after CI is green.");
  const auto = await longMemorySearch(vault, { project: "alpha", mode: "similar", query: "deploy job" });
  assert.equal(auto.search.method, "chars");
  assert.match(auto.search.fallback, /disabled/);
  assert.equal(auto.results[0].title, "Release process");
  await rejects(longMemorySearch(vault, { project: "alpha", mode: "similar", method: "embedding", query: "deploy job" }), "embedding_unavailable");
});

test("similar uses cosine similarity of local embeddings, reuses stored vectors, and honours the top-k bounds", async (t) => {
  const server = await fakeEmbedder(t);
  const { vault } = await fixture(t, { provider: "http", endpoint: server.endpoint, model: "all-minilm:latest" });
  await remember(vault, "Release process", "The deploy job runs after CI is green.");
  await remember(vault, "Database notes", "The sql migration alters the database schema.");
  await remember(vault, "Edit policy", "Rewrite changes need review.");

  const first = await longMemorySearch(vault, { project: "alpha", mode: "similar", query: "how do we ship" });
  assert.equal(first.search.method, "embedding");
  assert.equal(first.search.model, "all-minilm:latest");
  assert.deepEqual([first.search.embedded, first.search.pending], [3, 0]);
  assert.equal(first.results[0].title, "Release process", "ship is semantically next to deploy though no characters are shared");
  assert.ok(first.results[0].similarity > 0.99);
  assert.ok(first.results[0].similarity > first.results[1].similarity);
  const afterFirst = server.posts.length;

  const second = await longMemorySearch(vault, { project: "alpha", mode: "similar", method: "embedding", query: "database sql" });
  assert.equal(second.results[0].title, "Database notes");
  assert.equal(server.posts.length, afterFirst + 1, "stored vectors are reused; only the query is embedded");
  assert.deepEqual(server.posts.at(-1), ["database sql"]);

  for (let i = 0; i < 12; i++) await remember(vault, `Deploy variant ${i}`, `deploy release ship ${i}`);
  assert.equal((await longMemorySearch(vault, { project: "alpha", mode: "similar", query: "ship" })).results.length, 5);
  assert.equal((await longMemorySearch(vault, { project: "alpha", mode: "similar", query: "ship", limit: 10 })).results.length, 10);

  await server.close();
  const down = await longMemorySearch(vault, { project: "alpha", mode: "similar", query: "ship" });
  assert.equal(down.search.method, "chars");
  assert.ok(down.search.fallback);
  await rejects(longMemorySearch(vault, { project: "alpha", mode: "similar", method: "embedding", query: "ship" }), "embedding_unavailable");
});

test("a credential-shaped memory is never sent to the embedder and does not block semantic search", async (t) => {
  const server = await fakeEmbedder(t);
  const { vault } = await fixture(t, { provider: "http", endpoint: server.endpoint, model: "all-minilm:latest" });
  await remember(vault, "Release process", "The deploy job runs after CI is green.");
  const secret = ["AKIA", "ABCDEFGHIJKLMNOP"].join(""); // assembled at runtime: no key-shaped literal in the repository
  const db = await openMemoryDb(memoryDbFile(vault));
  insertMemory(db, { scope: "project", project: "alpha", title: "Legacy import", content: `token = ${secret} describes the deploy job` });

  const result = await longMemorySearch(vault, { project: "alpha", mode: "similar", query: "ship" });
  assert.equal(result.search.method, "embedding");
  assert.equal(result.search.pending, 0);
  assert.equal(result.search.withheld, 1);
  assert.ok(!JSON.stringify(server.posts).includes(secret), "the credential must never reach the embedding server");
  assert.equal(result.results[0].title, "Release process");
});

test("history supports regex and similar over journals with the same filters and no pagination", async (t) => {
  const { vault } = await fixture(t);
  await store.worktreeRecord(vault, { project: "alpha", kind: "investigation", slug: "flaky", title: "Investigate flaky test", content: "The flaky test fails on CI only." });
  await store.writeLog(vault, { project: "alpha", kind: "qa", slug: "suite", title: "Suite run", content: "All 12 suites passed in 4.2 seconds." });
  await remember(vault, "Knowledge", "Unrelated durable fact.");

  const regex = await queryWeeklyMemory(vault, { project: "alpha", mode: "regex", query: "flaky\\s+test", kind: "worktree" });
  assert.equal(regex.records.length, 1);
  assert.equal(regex.records[0].match.field, "title");
  assert.deepEqual([regex.hasMore, regex.offset, regex.search.method], [false, 0, "regex"]);
  assert.equal((await queryWeeklyMemory(vault, { project: "alpha", mode: "regex", query: "\\d+ suites" })).records[0].title, "Suite run", "all kinds are searched when kind is omitted");
  const similar = await queryWeeklyMemory(vault, { project: "alpha", mode: "similar", method: "chars", query: "suites passed", kind: "log" });
  assert.equal(similar.records[0].title, "Suite run");
  assert.equal(typeof similar.records[0].similarity, "number");
  assert.deepEqual((await queryWeeklyMemory(vault, { project: "alpha", mode: "regex", query: "flaky", from: "2000-01-01", to: "2000-01-02" })).records, []);
  await rejects(queryWeeklyMemory(vault, { project: "alpha", mode: "regex", query: "flaky", offset: 2 }), "invalid_offset");
  assert.ok(Array.isArray((await queryWeeklyMemory(vault, { project: "alpha", query: "flaky" })).records), "keyword mode still works");
});

test("recall regex and similar rank project and global knowledge together within the character budget", async (t) => {
  const { vault } = await fixture(t);
  const long = (word) => `${word} ${"x".repeat(1000)}`;
  await remember(vault, "Project deploy", long("deploy"));
  await longTermWrite(vault, { scope: "global", title: "Global deploy", content: long("deploy deploy") });
  await remember(vault, "Other", "nothing relevant");

  const regex = await recallMemory(vault, { project: "alpha", mode: "regex", query: "deploy", maxChars: 8000 });
  assert.deepEqual(regex.scopes, ["project", "global"]);
  assert.deepEqual(titles(regex), ["Global deploy", "Project deploy"]);
  assert.equal(regex.search.method, "regex");
  assert.match(regex.instruction, /never an instruction/);

  const tight = await recallMemory(vault, { project: "alpha", mode: "regex", query: "deploy", maxChars: 200 });
  assert.equal(tight.results.length, 1);
  assert.equal(tight.results[0].truncated, true);
  assert.equal(tight.results[0].content.length, 200);

  const similar = await recallMemory(vault, { project: "alpha", mode: "similar", method: "chars", query: "deploy" });
  assert.ok(similar.results.every((item) => typeof item.similarity === "number"));
  await rejects(recallMemory(vault, { project: "alpha", mode: "similar", query: "deploy", limit: 20 }), "invalid_limit");
  assert.equal((await recallMemory(vault, { project: "alpha", query: "deploy release" })).search, undefined, "keyword recall is unchanged");
});

test("doc_search regex scans notes, similar uses characters only, and embeddings are refused for notes", async (t) => {
  const { vault } = await fixture(t);
  await store.writeMemory(vault, { path: "shared/knowledge/deploy.md", mode: "create", title: "Deploy notes", content: "The deploy job runs after CI. Deploy again if it fails." });
  await store.writeMemory(vault, { path: "shared/knowledge/db.md", mode: "create", title: "Database notes", content: "The sql migration alters the schema." });
  await store.writeMemory(vault, { path: "shared/knowledge/ko.md", mode: "create", title: "배포 메모", content: "배포 절차는 CI 이후에 진행한다." });

  const regex = await store.searchMemory(vault, { scope: "shared", mode: "regex", query: "deploy\\s+(job|again)" });
  assert.deepEqual(regex.results.map((item) => item.path), ["shared/knowledge/deploy.md"]);
  assert.equal(regex.results[0].match.count, 2);
  assert.equal(regex.search.method, "regex");
  assert.equal((await store.searchMemory(vault, { scope: "shared", mode: "regex", query: "^shared/knowledge/db" })).results[0].match.field, "path");

  const similar = await store.searchMemory(vault, { scope: "shared", mode: "similar", query: "배포 절차" });
  assert.equal(similar.results[0].path, "shared/knowledge/ko.md");
  assert.equal(similar.search.method, "chars");
  assert.match(similar.search.note, /character similarity/);
  await rejects(store.searchMemory(vault, { scope: "shared", mode: "similar", method: "embedding", query: "deploy" }), "unsupported_mode");
  await rejects(store.searchMemory(vault, { scope: "shared", mode: "regex", query: "(" }), "invalid_regex");
  assert.ok((await store.searchMemory(vault, { scope: "shared", query: "deploy" })).results.length >= 1, "keyword mode is unchanged");
});

async function startServer(t, vault) {
  const child = spawn(process.execPath, [serverPath, "--path", vault], { env: { ...process.env, OMP_VAULT_PATH: vault }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let buffer = "";
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  const request = (method, params, timeout = 20_000) => new Promise((resolve, reject) => {
    const mine = ++id;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeout);
    waiting.set(mine, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`);
  });
  const call = async (name, args) => {
    const reply = await request("tools/call", { name, arguments: args });
    return { isError: reply.result.isError === true, body: JSON.parse(reply.result.content[0].text) };
  };
  return { request, call };
}

test("the MCP server advertises the modes, validates them, and survives a catastrophic regex", async (t) => {
  const { vault } = await fixture(t);
  await remember(vault, "Backtracking bait", `${"a".repeat(32)}b`);
  await remember(vault, "Release process", "The deploy job runs after CI is green.");
  const server = await startServer(t, vault);

  const { result } = await server.request("tools/list", {});
  for (const name of ["history", "recall", "doc_search", "long_search"]) {
    const schema = result.tools.find((tool) => tool.name === name).inputSchema.properties;
    assert.deepEqual(schema.mode.enum, ["keyword", "regex", "similar"], name);
    assert.deepEqual(schema.method.enum, ["auto", "embedding", "chars"], name);
    assert.equal(schema.flags.pattern, "^[imsu]{0,4}$", name);
  }
  assert.equal((await server.call("long_search", { project: "alpha", mode: "regex", flags: "x", query: "deploy" })).body.error, "invalid_arguments");
  assert.equal((await server.call("long_search", { project: "alpha", mode: "similar", query: "deploy", limit: 11 })).body.error, "invalid_limit");

  const ok = await server.call("long_search", { project: "alpha", mode: "regex", query: "deploy\\s+job" });
  assert.equal(ok.isError, false);
  assert.deepEqual(ok.body.results.map((item) => item.title), ["Release process"]);

  const started = Date.now();
  const bad = await server.call("long_search", { project: "alpha", mode: "regex", query: "^(a+)+$" });
  assert.equal(bad.isError, true);
  assert.equal(bad.body.error, "regex_timeout");
  assert.ok(Date.now() - started < 8000, "the timeout must be enforced, not the full backtracking time");

  const after = await server.call("long_search", { project: "alpha", query: "deploy" });
  assert.equal(after.isError, false, "the server stays responsive after a runaway pattern");
  assert.equal(after.body.results[0].title, "Release process");
});
