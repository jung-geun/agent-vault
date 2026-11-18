import { EMBEDDING_BATCH_SIZE, embedTexts, requireEmbedder, resolveEmbedder } from "./embeddings.mjs";
import { dbTransaction, getEmbeddings, memoryEmbeddingInput, MEMORY_EMBEDDING_CONTENT_LIMIT, openMemoryDb, putEmbeddings } from "./memory-db.mjs";
import { requireProject, resolveInside, VaultToolError } from "./memory-store.mjs";
import { loadSettings } from "./settings.mjs";
import { cosine, packVector, rankByCharSimilarity, topK, unpackVector } from "./similarity.mjs";

const fail = (message) => new VaultToolError("embedding_unavailable", message);
const newerFirst = (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b.id - a.id);
const round = (score) => Math.round(Math.max(0, Math.min(1, score)) * 10_000) / 10_000;

async function embedBatch(db, embedder, batch, timeoutMs) {
  const vectors = await embedTexts(embedder, batch.map(({ text }) => text), { timeoutMs });
  dbTransaction(db, () => putEmbeddings(db, embedder.model, batch.map(({ memoryId, textHash }, index) => ({
    memoryId, textHash, vector: packVector(vectors[index]), dim: vectors[index].length,
  }))));
  return vectors;
}

export async function similarRank(vault, db, rows, query, { method = "auto", limit = 5, backfill = true, timeoutMs } = {}) {
  if (!["auto", "embedding", "chars"].includes(method)) throw new VaultToolError("invalid_method", "Similar search method must be auto, embedding or chars.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new VaultToolError("invalid_limit", "Similar search limit must be an integer from 1 to 10.");
  const search = { mode: "similar", candidates: rows.length };
  const byChars = (metadata = {}) => ({
    results: rankByCharSimilarity(rows, query, { limit: rows.length })
      .sort((a, b) => b.score - a.score || newerFirst(a.row, b.row)).slice(0, limit)
      .map(({ row, score }) => ({ memory: row, similarity: round(score) })),
    search: { ...search, method: "chars", ...metadata },
  });
  if (method === "chars") return byChars();
  const embedder = await resolveEmbedder(vault);
  if (!embedder.available) {
    if (method === "embedding") requireEmbedder(embedder);
    return byChars({ fallback: embedder.reason });
  }
  const settings = loadSettings(vault).embedding;
  const deadline = performance.now() + (timeoutMs ?? settings.timeoutMs);
  const stored = getEmbeddings(db, embedder.model, rows.map(({ id }) => id));
  const vectors = new Map();
  const missing = [];
  let withheld = 0;
  for (const row of rows) {
    const entry = memoryEmbeddingInput(row);
    if (entry.withheld) withheld++;
    const cached = stored.get(row.id);
    if (cached?.textHash === entry.textHash && cached.dim > 0) {
      try {
        const vector = unpackVector(cached.vector, cached.dim);
        if (vector.every(Number.isFinite)) { vectors.set(row.id, vector); continue; }
      } catch { /* Treat an invalid cached vector as missing. */ }
    }
    missing.push(entry);
  }

  let backfillError;
  if (backfill) {
    const count = Math.min(missing.length, settings.backfillPerCall);
    for (let start = 0; start < count; start += EMBEDDING_BATCH_SIZE) {
      const remainingMs = Math.ceil(deadline - performance.now());
      if (remainingMs <= 0) break;
      const batch = missing.slice(start, Math.min(start + EMBEDDING_BATCH_SIZE, count));
      try {
        const completed = await embedBatch(db, embedder, batch, remainingMs);
        for (let index = 0; index < batch.length; index++) vectors.set(batch[index].memoryId, completed[index]);
      } catch (error) {
        if (error.code !== "embedding_unavailable") throw error;
        backfillError = error;
        break;
      }
    }
  }
  const pending = rows.length - vectors.size;
  const metadata = { model: embedder.model, embedded: vectors.size, pending, ...(withheld ? { withheld } : {}) };
  if (pending > 0) {
    const fallback = `embeddings incomplete: ${pending} of ${rows.length} candidates pending`;
    if (method === "embedding") throw fail(`${fallback}. ${backfillError ? `${backfillError.message} ` : ""}Run vault-cli memory embed to backfill active knowledge.`);
    return byChars({ ...metadata, fallback: backfillError ? `${fallback}; ${shortReason(backfillError)}` : fallback });
  }
  if (rows.length === 0) return { results: [], search: { ...search, method: "embedding", ...metadata } };
  try {
    const [queryVector] = await embedTexts(embedder, [query], { timeoutMs: Math.ceil(deadline - performance.now()) });
    const scores = rows.slice().sort(newerFirst).map((memory) => {
      const vector = vectors.get(memory.id);
      if (vector.length !== queryVector.length) throw fail("Stored and new embedding dimensions do not match. Check the local server or configure a model with a distinct name.");
      return { memory, score: cosine(vector, queryVector) };
    });
    return {
      results: topK(scores, limit, ({ score }) => score).map(({ memory, score }) => ({ memory, similarity: round(score) })),
      search: { ...search, method: "embedding", ...metadata },
    };
  } catch (error) {
    if (method === "embedding" || error.code !== "embedding_unavailable") throw error;
    return byChars({ ...metadata, fallback: shortReason(error) });
  }
}

function shortReason(error) {
  const sentenceEnd = error.message.indexOf(". ");
  const message = sentenceEnd === -1 ? error.message : error.message.slice(0, sentenceEnd);
  return message[0].toLowerCase() + message.slice(1);
}

export async function embedMemoryScope(vault, { scope = "project", project, cwd, limit = 500 } = {}) {
  if (!["project", "global"].includes(scope) || (scope === "global" && project != null)) throw new VaultToolError("invalid_scope", "Choose a project or global scope.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new VaultToolError("invalid_limit", "Embedding limit must be an integer from 1 to 5000.");
  const projectId = scope === "project" ? await requireProject(vault, { project, cwd }) : null;
  const embedder = requireEmbedder(await resolveEmbedder(vault));
  const { timeoutMs } = loadSettings(vault).embedding;
  const { target } = await resolveInside(vault, ".agent-vault/memory.db");
  const db = await openMemoryDb(target);
  const batchSize = 500;
  const select = db.prepare(`SELECT m.id, m.title, substr(m.content, 1, ${MEMORY_EMBEDDING_CONTENT_LIMIT}) AS content, m.updated_at AS updatedAt, e.text_hash AS textHash
    FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ?
    WHERE m.scope = ? AND m.project IS ? AND m.team_id = '' AND m.kind = 'knowledge' AND m.status = 'active'
      AND (? IS NULL OR (m.updated_at, m.id) < (?, ?)) ORDER BY m.updated_at DESC, m.id DESC LIMIT ${batchSize}`);
  let cursor;
  let embedded = 0;
  let remaining = 0;
  const batch = [];
  async function flush() {
    await embedBatch(db, embedder, batch, timeoutMs);
    embedded += batch.length;
    batch.length = 0;
  }
  for (;;) {
    const rows = select.all(embedder.model, scope, projectId, cursor?.updatedAt ?? null, cursor?.updatedAt ?? null, cursor?.id ?? null);
    for (const row of rows) {
      const entry = memoryEmbeddingInput(row);
      if (entry.textHash === row.textHash) continue;
      if (embedded + batch.length >= limit) { remaining++; continue; }
      batch.push(entry);
      if (batch.length === EMBEDDING_BATCH_SIZE) await flush();
    }
    if (rows.length < batchSize) break;
    cursor = rows.at(-1);
  }
  if (batch.length > 0) await flush();
  return { model: embedder.model, embedded, remaining };
}
