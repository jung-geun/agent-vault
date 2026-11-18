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

export function rankByCharSimilarity(rows, query, { textOf = (row) => `${row.title}\n${row.content}`, limit = 5, minScore = 0.05 } = {}) {
  const grams = [...charGrams(query)];
  if (grams.length === 0 || rows.length === 0 || limit <= 0) return [];

  // Keep only query-gram hits, not each candidate's full gram set.
  const frequency = new Array(grams.length).fill(0);
  const candidates = rows.map((row) => {
    const candidateGrams = charGrams(textOf(row));
    const hits = [];
    for (let i = 0; i < grams.length; i++) {
      if (candidateGrams.has(grams[i])) {
        hits.push(i);
        frequency[i]++;
      }
    }
    return { row, hits, size: candidateGrams.size };
  });
  const idf = frequency.map((df) => Math.log(1 + (rows.length + 1) / (df + 1)));
  const totalWeight = idf.reduce((sum, weight) => sum + weight, 0);
  const ranked = [];
  for (const { row, hits, size } of candidates) {
    let weight = 0;
    for (const hit of hits) weight += idf[hit];
    const score = weight / totalWeight;
    if (score >= minScore) ranked.push({ row, score, dice: 2 * hits.length / (grams.length + size) });
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
