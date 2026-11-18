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
