import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { getActiveResourcesInfo } from "node:process";
import { test } from "node:test";
import { VaultToolError } from "../lib/memory-store.mjs";
import { REGEX_LIMITS, regexRankMemories, searchRegex, validateRegex } from "../lib/regex-search.mjs";

const item = (key, texts) => ({ key, texts });
const memory = (id, { title = "", tags = [], content = "", updatedAt = "2026-11-18T00:00:00.000Z" } = {}) => ({
  id, title, tags, content, updatedAt,
});
const invalidRegex = { name: "VaultToolError", code: "invalid_regex" };

test("validates syntax, pattern size, and flags before worker startup", async () => {
  assert.deepEqual(validateRegex("a"), { pattern: "a", flags: "iu" });
  assert.deepEqual(validateRegex("a", "sm"), { pattern: "a", flags: "sm" });
  assert.equal(validateRegex("a".repeat(300), "").pattern.length, 300);
  assert.throws(() => validateRegex("("), { ...invalidRegex, message: /^Invalid regular expression/ });
  for (const pattern of ["", 42, "a".repeat(301)]) assert.throws(() => validateRegex(pattern), invalidRegex);
  for (const flags of ["g", "y", "d", "ii", "iv", "I", null]) assert.throws(() => validateRegex("a", flags), invalidRegex);
  await assert.rejects(searchRegex([], "("), invalidRegex);
});

test("counts matches across fields and attributes the first field in scan order", async () => {
  const items = [
    item(1, { content: "xy\nXY", tags: "XY", path: "xy/XY", title: "xY Title" }),
    item(2, { tags: "xy", title: "no", content: "xy", path: "xy.txt" }),
    item(3, { content: "xy", tags: "tag XY" }),
    item(4, { content: "before XY after" }),
    item(5, { content: "no" }),
  ];
  assert.deepEqual(await searchRegex(items, "xy"), [
    { key: 1, count: 6, field: "title", excerpt: "xY Title" },
    { key: 2, count: 3, field: "path", excerpt: "xy.txt" },
    { key: 3, count: 2, field: "tags", excerpt: "tag XY" },
    { key: 4, count: 1, field: "content", excerpt: "before XY after" },
  ]);
  assert.deepEqual(await searchRegex([item("case", { title: "UPPER" })], "upper", { flags: "" }), []);
});

test("supports multiline, dotall and Unicode regex semantics", async () => {
  const [match] = await searchRegex([item(1, { content: "before\n배포\n💡\nafter" })], "^\\p{Script=Hangul}+.💡$", { flags: "msu" });
  assert.deepEqual(match, { key: 1, count: 1, field: "content", excerpt: "before 배포 💡 after" });
});

test("centers a bounded, newline-free excerpt on the first match", async () => {
  const content = "L".repeat(120) + "\r\nneedle\u2028" + "R".repeat(120) + "needle";
  const [match] = await searchRegex([item(1, { content })], "needle");
  assert.equal(match.count, 2);
  assert.ok(match.excerpt.length <= 200);
  assert.match(match.excerpt, /^L{90,100} needle R{90,100}$/);
});

test("zero-length matches advance by code point under u and stop at the item cap", async () => {
  const items = [item(1, { title: "A💡B" }), item(2, { title: "", content: "x" }), item(3, { title: "a".repeat(100) })];
  const matches = await searchRegex(items, "(?=)");
  assert.deepEqual(matches.map(({ count, field }) => [count, field]), [[4, "title"], [3, "title"], [50, "title"]]);
  const [nonUnicode] = await searchRegex(items.slice(0, 1), "(?=)", { flags: "" });
  assert.equal(nonUnicode.count, 5);
});

test("caps the total count at 50 even when later fields still match", async () => {
  const items = [item(1, { title: "x".repeat(48), path: "xxx", tags: "xx", content: "xxx" })];
  assert.deepEqual(await searchRegex(items, "x"), [{ key: 1, count: 50, field: "title", excerpt: "x".repeat(48) }]);
});

test("ranks memories by count, updatedAt, then descending id before applying limit", async () => {
  const newer = "2026-11-19T00:00:00.000Z";
  const rows = [
    memory(1, { title: "word", updatedAt: newer }),
    memory(4, { title: "word" }),
    memory(2, { content: "word", updatedAt: newer }),
    memory(3, { tags: ["one", "word"], content: "word" }),
  ];
  const { results, scanned, truncated } = await regexRankMemories(rows, "word", { limit: 3 });
  assert.deepEqual(results.map((result) => result.memory.id), [3, 2, 1]);
  assert.deepEqual(results[0], { memory: rows[3], score: 2, match: { field: "tags", excerpt: "one word", count: 2 } });
  assert.equal(scanned, 4);
  assert.equal(truncated, false);
});

test("scans only the first 500 items and reports omitted rows", async () => {
  const rows = Array.from({ length: REGEX_LIMITS.maxRows + 1 }, (_, i) => memory(i, { title: i === 500 ? "needle" : "" }));
  assert.deepEqual(await regexRankMemories(rows, "needle"), { results: [], scanned: 500, truncated: true });
  const items = rows.map(({ id, title }) => item(id, { title }));
  assert.deepEqual(await searchRegex(items, "needle"), []);
});

test("limits each field to 20,000 characters and reports cut memory text", async () => {
  const full = "a".repeat(REGEX_LIMITS.maxScanChars - 1) + "x";
  const long = "a".repeat(REGEX_LIMITS.maxScanChars) + "x";
  const rows = [memory(1, { title: full }), memory(2, { content: long })];
  const first = await regexRankMemories(rows.slice(0, 1), "x$");
  assert.equal(first.truncated, false);
  const both = await regexRankMemories(rows, "x$");
  assert.equal(both.truncated, true);
  assert.equal(both.scanned, 2);
  assert.deepEqual(both.results.map(({ memory }) => memory.id), [1]);
  assert.deepEqual(await searchRegex([item(1, { path: long, tags: long })], "x$"), []);
});

test("terminates catastrophic backtracking within twice the deadline and remains usable", async () => {
  const timeoutMs = 300;
  const start = performance.now();
  await assert.rejects(searchRegex([item(1, { content: "a".repeat(40) + "b" })], "^(a+)+$", { timeoutMs }), (error) => {
    assert.ok(error instanceof VaultToolError);
    assert.equal(error.code, "regex_timeout");
    assert.equal(error.message, "pattern took too long; simplify nested quantifiers");
    return true;
  });
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 2 * timeoutMs, `worker termination took ${elapsed}ms`);
  assert.deepEqual(await searchRegex([item(2, { title: "ok" })], "ok"), [{ key: 2, field: "title", excerpt: "ok", count: 1 }]);
});

test("50 sequential searches leave no worker message ports alive", { timeout: 10_000 }, async () => {
  const countPorts = () => getActiveResourcesInfo().filter((kind) => kind === "MessagePort").length;
  const before = countPorts();
  for (let i = 0; i < 50; i++) {
    const [hit] = await searchRegex([item(i, { content: "quick match" })], "match");
    assert.equal(hit.key, i);
  }
  assert.equal(countPorts(), before);
});
