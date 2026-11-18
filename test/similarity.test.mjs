import assert from "node:assert/strict";
import { test } from "node:test";
import {
  charGrams, cosine, normalizeText, normalizeVector, packVector, rankByCharSimilarity, topK, unpackVector,
} from "../lib/similarity.mjs";

const approx = (actual, expected, epsilon = 1e-7) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≉ ${expected}`);

const row = (title, content = "") => ({ title, content });

test("character grams normalize Unicode and whitespace without splitting code points", () => {
  assert.equal(normalizeText(" \nＡＢC\t\t배포  절차\u3000"), "abc 배포 절차");
  assert.deepEqual(charGrams(" Ａ💡漢 "), new Set(["a💡", "💡漢", "a💡漢"]));
  assert.deepEqual(charGrams(" 漢 "), new Set(["漢"]));
  assert.deepEqual(charGrams("abcd", [4]), new Set(["abcd"]));
  assert.equal(charGrams("\t\n").size, 0);
});

test("character similarity ranks Korean without segmentation and ignores blank queries", () => {
  const direct = row("서비스 배포 절차", "운영 서버에 적용한다.");
  const partial = row("자동 배포 도구", "인프라 변경.");
  const unrelated = row("사용자 인증", "로그인 화면 설명.");
  const rows = [unrelated, partial, direct];
  const results = rankByCharSimilarity(rows, "배포 절차");
  assert.deepEqual(results.map((hit) => hit.row), [direct, partial]);
  assert.equal(results[0].score, 1);
  assert.ok(results[1].score < 1);
  assert.deepEqual(rankByCharSimilarity(rows, " \t "), []);
});

test("character similarity handles typos and partial identifiers", () => {
  const expected = row("FlightControllerV2");
  const rows = [row("BackgroundController"), row("TimeController"), expected];
  assert.deepEqual(rankByCharSimilarity(rows, "FlightContoller", { limit: 1 }).map((hit) => hit.row), [expected]);
  assert.deepEqual(rankByCharSimilarity(rows, "FlightCon", { minScore: 1 }), [{ row: expected, score: 1 }]);
});

test("idf prefers rows matching rarer query grams even with the same hit count", () => {
  const rows = ["abc", "abc", "abc", "bcd"];
  const results = rankByCharSimilarity(rows, "abcd", { textOf: (text) => text, limit: 2 });
  assert.deepEqual(results.map((hit) => hit.row), ["bcd", "abc"]);
  const common = Math.log(1 + 5 / 4);
  const rare = Math.log(1 + 5 / 2);
  const shared = Math.log(1 + 5 / 5);
  const total = 2 * common + 2 * rare + shared;
  approx(results[0].score, (2 * rare + shared) / total);
  approx(results[1].score, (2 * common + shared) / total);
});

test("character containment ties use Dice, then input order", () => {
  const long = row("jabcdx");
  const first = row("abcd");
  const second = row("ABCD");
  assert.deepEqual(rankByCharSimilarity([long, first, second], "abcd"), [
    { row: first, score: 1 }, { row: second, score: 1 }, { row: long, score: 1 },
  ]);
});

test("cosine is the dot product of unit vectors and rejects different dimensions", () => {
  const x = new Float32Array([1, 0]);
  const y = new Float32Array([0, 1]);
  assert.equal(cosine(x, y), 0);
  assert.equal(cosine(x, x), 1);
  assert.equal(cosine(x, new Float32Array([-1, 0])), -1);
  const input = new Float32Array([3, 4]);
  const unit = normalizeVector(input);
  assert.deepEqual(input, new Float32Array([3, 4]));
  approx(cosine(unit, unit), 1);
  approx(cosine(unit, x), 0.6);
  const zero = new Float32Array(2);
  assert.equal(normalizeVector(zero), zero);
  assert.throws(() => cosine(x, new Float32Array(3)), RangeError);
});

test("vector packing is little-endian and unpacking copies unaligned buffers", () => {
  const original = new Float32Array([1, -2.5, 0.1]);
  const packed = packVector(original);
  assert.equal(packed.subarray(0, 8).toString("hex"), "0000803f000020c0");
  assert.deepEqual(unpackVector(packed, 3), original);

  const unaligned = new Uint8Array(packed.length + 2).subarray(1, 1 + packed.length);
  unaligned.set(packed);
  assert.equal(unaligned.byteOffset, 1);
  const decoded = unpackVector(unaligned, 3);
  assert.equal(decoded.byteOffset, 0);
  unaligned.fill(0);
  assert.deepEqual(decoded, original);
  assert.throws(() => unpackVector(packed, 2), RangeError);
  assert.throws(() => unpackVector(packed.subarray(0, 2), 0.5), RangeError);
});

test("topK is stable and leaves inputs unchanged", () => {
  const items = [{ score: 1 }, { score: 2 }, { score: 2 }, { score: 3 }];
  const original = items.slice();
  const best = topK(items, 3, (item) => item.score);
  assert.equal(best[0], original[3]);
  assert.equal(best[1], original[1]);
  assert.equal(best[2], original[2]);
  assert.deepEqual(topK(items, 0, (item) => item.score), []);
  assert.deepEqual(items, original);
});

// The original algorithm, kept here only as the specification the optimized one must match exactly.
function referenceRank(rows, query, { textOf = (item) => `${item.title}\n${item.content}`, limit = 5, minScore = 0.05 } = {}) {
  const grams = [...charGrams(query)];
  if (grams.length === 0 || rows.length === 0 || limit <= 0) return [];
  const frequency = new Array(grams.length).fill(0);
  const candidates = rows.map((item) => {
    const set = charGrams(textOf(item));
    const hits = [];
    for (let i = 0; i < grams.length; i++) if (set.has(grams[i])) { hits.push(i); frequency[i]++; }
    return { item, hits, size: set.size };
  });
  const idf = frequency.map((df) => Math.log(1 + (rows.length + 1) / (df + 1)));
  const total = idf.reduce((sum, weight) => sum + weight, 0);
  const ranked = [];
  for (const { item, hits, size } of candidates) {
    let weight = 0;
    for (const hit of hits) weight += idf[hit];
    const score = weight / total;
    if (score >= minScore) ranked.push({ row: item, score, dice: 2 * hits.length / (grams.length + size) });
  }
  ranked.sort((a, b) => b.score - a.score || b.dice - a.dice);
  return ranked.slice(0, limit).map(({ row: item, score }) => ({ row: item, score }));
}

test("rankByCharSimilarity returns exactly what scoring full gram sets returns, including ties, one-character queries and astral text", () => {
  let seed = 20260518;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  // Few distinct characters make equal scores (and so the Dice tie-break) common; "\ud83d" and "\ude00" are lone surrogates.
  const alphabet = ["a", "b", "c", " ", "\n", "배", "포", "절", "차", "漢", "💡", "😀", "Ａ", "ß", "é", "\ud83d", "\ude00"];
  const text = (max) => Array.from({ length: Math.floor(random() * max) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
  let compared = 0;
  for (let round = 0; round < 400; round++) {
    const rows = Array.from({ length: 1 + Math.floor(random() * 40) }, () => row(text(6), text(random() < 0.2 ? 400 : 30)));
    const queries = [text(1), text(2), text(3), text(8), rows[0].title, `${rows[0].title} ${rows[rows.length - 1].content.slice(0, 5)}`];
    for (const query of queries) {
      for (const options of [{}, { limit: 1 }, { limit: 3, minScore: 0 }, { limit: 100, minScore: 0.3 }]) {
        assert.deepEqual(rankByCharSimilarity(rows, query, options), referenceRank(rows, query, options), JSON.stringify({ round, query, options }));
        compared++;
      }
    }
  }
  assert.ok(compared >= 9000);
  const single = [row("a"), row("ab"), row("xa"), row("A"), row("💡"), row("💡x")];
  for (const query of ["a", "💡", "ａ", "\ude00"]) assert.deepEqual(rankByCharSimilarity(single, query, { minScore: 0 }), referenceRank(single, query, { minScore: 0 }), query);
  assert.deepEqual(rankByCharSimilarity(single, "a", { minScore: 0 }).filter((hit) => hit.score > 0).map((hit) => hit.row.title), ["a", "A"], "a one-character query matches only a text that is exactly that character");
});

test("remembered gram counts never change a result when the memo evicts or a memory's text changes", () => {
  // Every row contains the query, so all of them tie and each needs a gram count. 70 rows of ~90 000 characters exceed the memo's
  // 4 000 000-character budget several times over, forcing eviction; texts differ only in distinct-gram counts.
  const filler = (n, salt) => Array.from({ length: n }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 7 + salt * 13) % (150 + (salt % 40))))).join("");
  const rows = Array.from({ length: 70 }, (_, i) => row(`doc ${i}`, `needle ${filler(90_000, i)}`));
  for (let pass = 0; pass < 3; pass++) {
    assert.deepEqual(rankByCharSimilarity(rows, "needle", { limit: 10 }), referenceRank(rows, "needle", { limit: 10 }), `pass ${pass}`);
  }
  const before = rankByCharSimilarity(rows, "needle", { limit: 3 }).map((hit) => hit.row.title);
  rows[0] = row("doc 0", "needle x"); // the shortest text has the fewest distinct grams, so it must now rank first
  assert.equal(rankByCharSimilarity(rows, "needle", { limit: 3 })[0].row.title, "doc 0");
  assert.notEqual(before[0], "doc 0");
  assert.deepEqual(rankByCharSimilarity(rows, "needle", { limit: 3 }), referenceRank(rows, "needle", { limit: 3 }));
});
