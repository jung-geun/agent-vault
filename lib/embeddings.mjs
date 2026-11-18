import path from "node:path";
import { EMBEDDING_TEXT_LIMIT } from "./memory-db.mjs";
import { assertNoSecrets, VaultToolError } from "./memory-store.mjs";
import { DEFAULT_SETTINGS, embeddingOrigin, loadSettings } from "./settings.mjs";
import { normalizeVector } from "./similarity.mjs";

// Preference order for automatic model choice. Multilingual models come first, smallest first: measured on the same eight Korean-only
// paraphrase queries, granite-embedding:278m ranked the right memory first 7 times and the English-only all-minilm once, so picking the
// lightest model would silently ruin Korean and other non-Latin vaults. English-only tiny models are used only when nothing multilingual
// is installed; set embedding.model to override.
export const SMALL_EMBEDDING_HINTS = Object.freeze([
  "multilingual-e5-small", "paraphrase-multilingual", "granite-embedding:278m", "embeddinggemma", "snowflake-arctic-embed2", "bge-m3",
  "all-minilm", "snowflake-arctic-embed:22m", "snowflake-arctic-embed:33m", "granite-embedding:30m", "bge-small", "e5-small",
  "nomic-embed-text", "embed",
]);
export const EMBEDDING_BATCH_SIZE = 32;

const probes = [
  { endpoint: "http://127.0.0.1:11434", route: "/api/tags", list: "models", key: "name" },
  { endpoint: "http://127.0.0.1:1234", route: "/v1/models", list: "data", key: "id" },
];
const PROBE_TIMEOUT_MS = 400;
const CACHE_MS = 60_000;
const detectionCache = new Map();
const fail = (message) => new VaultToolError("embedding_unavailable", message);

async function request(url, options, timeoutMs, read) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, credentials: "omit", redirect: "manual", signal: controller.signal });
    return await read(response);
  } finally { clearTimeout(timer); }
}

function chooseModel(entries, key) {
  if (!Array.isArray(entries)) return null;
  const models = entries.map((entry) => entry?.[key]).filter((name) => {
    if (typeof name !== "string" || !name.trim()) return false;
    try { assertNoSecrets(name); return true; } catch { return false; }
  });
  for (const hint of SMALL_EMBEDDING_HINTS) {
    const model = models.find((name) => name.toLowerCase().includes(hint));
    if (model !== undefined) return model;
  }
  return null;
}

async function detectEmbedder() {
  let reached = false;
  for (const { endpoint, route, list, key } of probes) {
    try {
      const model = await request(`${endpoint}${route}`, { method: "GET" }, PROBE_TIMEOUT_MS, async (response) => {
        reached = true;
        if (response.status !== 200) { await response.body?.cancel(); return null; }
        return chooseModel((await response.json())?.[list], key);
      });
      if (model) return { available: true, provider: "auto", endpoint, model };
    } catch { /* The other local provider may still be available. */ }
  }
  return { available: false, provider: "auto", reason: reached ? "no local embedding model detected" : "embedding server unreachable" };
}

export async function resolveEmbedder(vault, { now = Date.now(), checkConfigured = false } = {}) {
  let provider = "auto";
  try {
    const key = path.resolve(vault);
    const settings = loadSettings(key).embedding;
    ({ provider } = settings);
    if (provider === "off") return { available: false, provider, reason: "embeddings are disabled" };
    if (provider === "http") {
      const endpoint = embeddingOrigin(settings.endpoint);
      assertNoSecrets(settings.model);
      if (checkConfigured) {
        try {
          // Any HTTP response proves reachability; configured servers need not list models.
          await request(`${endpoint}/v1/models`, { method: "GET" }, PROBE_TIMEOUT_MS, (response) => response.body?.cancel());
        } catch { return { available: false, provider, endpoint, model: settings.model, reason: "embedding server unreachable" }; }
      }
      return { available: true, provider, endpoint, model: settings.model };
    }
    const cached = detectionCache.get(key);
    if (cached && now < cached.expiresAt) return { ...await cached.result };
    const result = detectEmbedder();
    detectionCache.set(key, { expiresAt: Number(now) + CACHE_MS, result });
    return { ...await result };
  } catch { return { available: false, provider, reason: "embedding settings are invalid" }; }
}

export function requireEmbedder(embedder) {
  if (!embedder.available) throw fail(`${embedder.reason}. Start a local embedding server with an installed model (for example, ollama pull all-minilm), or configure vault-cli config --embedding http with a loopback endpoint and model.`);
  return embedder;
}

export async function embedTexts(embedder, texts, { timeoutMs = DEFAULT_SETTINGS.embedding.timeoutMs } = {}) {
  requireEmbedder(embedder);
  let endpoint;
  try {
    endpoint = embeddingOrigin(embedder.endpoint);
    if (typeof embedder.model !== "string" || !embedder.model.trim()) throw new Error();
    assertNoSecrets(embedder.model);
  } catch { throw fail("Embedding endpoint or model is invalid. Configure a loopback origin and model with vault-cli config."); }
  if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string")) throw fail("Embedding inputs must be an array of text strings.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw fail("Embedding request timed out. Increase embedding.timeoutMs or check the local server.");
  const deadline = performance.now() + timeoutMs;
  const vectors = new Array(texts.length);
  let dim;
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE).map((text) => text.slice(0, EMBEDDING_TEXT_LIMIT));
    try { for (const text of batch) assertNoSecrets(text); }
    catch { throw fail("Embedding input contains a potential credential. Remove or redact it before using semantic search."); }
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw fail("Embedding request timed out. Increase embedding.timeoutMs or check the local server.");
    try {
      await request(`${endpoint}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: embedder.model, input: batch }),
      }, remaining, async (response) => {
        if (response.status !== 200) {
          await response.body?.cancel();
          throw fail(`Embedding server returned HTTP ${response.status}. Check that the local endpoint serves /v1/embeddings and the configured model is loaded.`);
        }
        const invalid = () => fail("Embedding server returned invalid vectors. Check the local server's OpenAI-compatible /v1/embeddings response.");
        let data;
        try { ({ data } = await response.json()); }
        catch (error) { if (error.name === "AbortError") throw error; throw invalid(); }
        if (!Array.isArray(data) || data.length !== batch.length) throw invalid();
        let indexed;
        for (const [position, item] of data.entries()) {
          const vector = item?.embedding;
          if (!Array.isArray(vector) || vector.length === 0 || (dim !== undefined && vector.length !== dim)) throw invalid();
          dim = vector.length;
          indexed ??= item.index !== undefined;
          if (indexed !== (item.index !== undefined)) throw invalid();
          const index = indexed ? item.index : position;
          if (!Number.isInteger(index) || index < 0 || index >= batch.length || vectors[start + index] !== undefined) throw invalid();
          const values = new Float32Array(dim);
          for (let i = 0; i < dim; i++) {
            if (!Number.isFinite(vector[i])) throw invalid();
            values[i] = vector[i];
            if (!Number.isFinite(values[i])) throw invalid();
          }
          vectors[start + index] = normalizeVector(values);
        }
      });
    } catch (error) {
      if (error instanceof VaultToolError) throw error;
      if (error.name === "AbortError") throw fail("Embedding request timed out. Increase embedding.timeoutMs or check the local server.");
      throw fail("Embedding server unreachable. Start the local server or check the configured loopback endpoint.");
    }
  }
  return vectors;
}
