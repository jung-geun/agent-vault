import { Buffer } from "node:buffer";

export function normalizeText(text) {
  return String(text ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function charGrams(text, sizes = [2, 3]) {
  const normalized = normalizeText(text);
  const grams = new Set();
  if (!normalized) return grams;

  // Keep Unicode code points intact when slicing the string's UTF-16 offsets.
  const offsets = [0];
  let offset = 0;
  for (const char of normalized) offsets.push(offset += char.length);
  const length = offsets.length - 1;
  for (const size of sizes) {
    if (length < size) grams.add(normalized);
    else for (let i = 0; i <= length - size; i++) grams.add(normalized.slice(offsets[i], offsets[i + size]));
  }
  return grams;
}

// Distinct-gram count of a text, remembered across calls because a long-lived server ranks the same memories again and again.
// It is a pure function of the normalized text, so the memo never changes a result. Bounded by total characters held (oldest evicted).
const GRAM_COUNT_BUDGET_CHARS = 4_000_000;
const GRAM_COUNT_MAX_TEXT_CHARS = 100_000;
const gramCounts = new Map();
let gramCountChars = 0;
function gramCount(text) {
  const key = normalizeText(text);
  const known = gramCounts.get(key);
  if (known !== undefined) {
    gramCounts.delete(key); // refresh recency
    gramCounts.set(key, known);
    return known;
  }
  const size = charGrams(text).size;
  if (key.length <= GRAM_COUNT_MAX_TEXT_CHARS) {
    gramCounts.set(key, size);
    gramCountChars += key.length;
    for (const oldest of gramCounts.keys()) {
      if (gramCountChars <= GRAM_COUNT_BUDGET_CHARS) break;
      gramCountChars -= oldest.length;
      gramCounts.delete(oldest);
    }
  }
  return size;
}

// Two ways to find which query grams a candidate contains, with identical results:
//  - substring: test each query gram with String.includes on the normalized text. Cost grows with grams x text length, so it wins only
//    for short queries and never builds a candidate's gram set (the Dice tie-break builds one only for rows that share a score);
//  - gram set: build the candidate's full 2/3-gram Set once and look every query gram up. Cost is one pass over the text, independent
//    of the query, so it wins once the query has more than SUBSTRING_MAX_GRAMS distinct grams (measured crossover, see spec 11.3).
// The substring path is exact except that a one-code-point query gram (only a one-code-point query yields one) is present only in a
// text that is exactly that character, and a gram holding a lone surrogate could match half of a surrogate pair, so a query with such
// a gram always uses gram sets.
export const SUBSTRING_MAX_GRAMS = 200;

export function rankByCharSimilarity(rows, query, { textOf = (row) => `${row.title}\n${row.content}`, limit = 5, minScore = 0.05 } = {}) {
  const grams = [...charGrams(query)].map((gram) => ({ gram, whole: [...gram].length === 1, sound: gram.isWellFormed() }));
  if (grams.length === 0 || rows.length === 0 || limit <= 0) return [];
  const useSets = grams.length > SUBSTRING_MAX_GRAMS || grams.some(({ sound }) => !sound);

  const frequency = new Array(grams.length).fill(0);
  const gramTexts = grams.map(({ gram }) => gram);
  const candidates = rows.map((row) => {
    const raw = textOf(row);
    const hits = [];
    if (useSets) {
      const set = charGrams(raw);
      for (let i = 0; i < gramTexts.length; i++) if (set.has(gramTexts[i])) { hits.push(i); frequency[i]++; }
      return { row, hits, size: set.size };
    }
    const text = normalizeText(raw);
    for (let i = 0; i < grams.length; i++) {
      const { gram, whole } = grams[i];
      if (whole ? text === gram : text.includes(gram)) { hits.push(i); frequency[i]++; }
    }
    return { row, hits, size: undefined };
  });
  const idf = frequency.map((df) => Math.log(1 + (rows.length + 1) / (df + 1)));
  const totalWeight = idf.reduce((sum, weight) => sum + weight, 0);
  const ranked = [];
  for (const { row, hits, size } of candidates) {
    let weight = 0;
    for (const hit of hits) weight += idf[hit];
    const score = weight / totalWeight;
    if (score >= minScore) ranked.push({ row, score, hits: hits.length, size, dice: 0 });
  }
  ranked.sort((a, b) => b.score - a.score);
  // Rows below the cut-off score can never be returned, and a row with a unique score needs no tie-break.
  const cut = ranked.length > limit ? ranked[limit - 1].score : -Infinity;
  for (let start = 0; start < ranked.length && ranked[start].score >= cut;) {
    let end = start + 1;
    while (end < ranked.length && ranked[end].score === ranked[start].score) end++;
    if (end - start > 1) for (let i = start; i < end; i++) ranked[i].dice = 2 * ranked[i].hits / (grams.length + (ranked[i].size ?? gramCount(textOf(ranked[i].row))));
    start = end;
  }
  ranked.sort((a, b) => b.score - a.score || b.dice - a.dice);
  return ranked.slice(0, limit).map(({ row, score }) => ({ row, score }));
}

export function normalizeVector(vector) {
  let squaredLength = 0;
  for (const value of vector) squaredLength += value * value;
  if (squaredLength === 0) return vector;
  const length = Math.sqrt(squaredLength);
  return vector.map((value) => value / length);
}

export function cosine(a, b) {
  if (a.length !== b.length) throw new RangeError("Vector dimensions must match.");
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function packVector(vector) {
  const buffer = Buffer.allocUnsafe(vector.byteLength);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let i = 0; i < vector.length; i++) view.setFloat32(i * 4, vector[i], true);
  return buffer;
}

export function unpackVector(buffer, dim) {
  if (!Number.isInteger(dim) || dim < 0 || buffer.byteLength !== dim * 4) {
    throw new RangeError("Vector byte length must equal dimension × 4.");
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const vector = new Float32Array(dim);
  for (let i = 0; i < dim; i++) vector[i] = view.getFloat32(i * 4, true);
  return vector;
}

export function topK(items, k, scoreOf) {
  if (k <= 0) return [];
  const ranked = items.map((item) => ({ item, score: scoreOf(item) }));
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, k).map(({ item }) => item);
}
