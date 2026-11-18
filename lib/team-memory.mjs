// Team memory: long-term entries shared outside this vault. The user picks the backend (vault-cli config team ...):
//   file  a SQLite file shared by vaults on one host, on a local filesystem only (never NFS or multi-host sync).
//   sql   a dedicated team database; database credentials are independent of the personal vault.
//   http  an external service that implements the contract below; the bearer token comes from an environment variable.
//
// HTTP contract (JSON, UTF-8):
//   POST {url}/v1/memories         body {teamId, slug?, title, content, tags[], author:{project?, role?}}  -> {id}
//   GET  {url}/v1/memories/search  query teamId, q, limit, role?                                           -> {items:[{id,title,content,tags,author,updatedAt}]}
// Content from the team store is untrusted data from other people; results are flagged so agents do not treat it as instructions.
import { VaultToolError } from "./memory-store.mjs";
import { insertMemory, openTeamMemoryDb, searchMemories } from "./memory-db.mjs";
import { validateSettings } from "./settings.mjs";

const fail = (code, message, details) => new VaultToolError(code, message, details);
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function assertTeamWritable(settings) {
  validateSettings(settings);
  const team = settings.team;
  if (!team.enabled) throw fail("team_disabled", "Team memory is not configured. The user enables it with 'vault-cli config team'.");
  if (!team.allowWrite) throw fail("team_read_only", "Team memory is configured read-only on this machine.");
  return team;
}

export function assertTeamReadable(settings) {
  validateSettings(settings);
  if (!settings.team.enabled) throw fail("team_disabled", "Team memory is not configured. The user enables it with 'vault-cli config team'.");
  return settings.team;
}

async function request(team, method, pathname, { query, body } = {}) {
  const url = new URL(pathname, team.url.endsWith("/") ? team.url : `${team.url}/`);
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (team.tokenEnv) {
    const token = process.env[team.tokenEnv];
    if (!token) throw fail("team_auth_missing", "The configured team authentication environment variable is not set.");
    if (/[\r\n]/.test(token)) throw fail("team_auth_invalid", "The configured team authentication token is not a valid HTTP header value.");
    headers.authorization = `Bearer ${token}`;
  }
  let response;
  try {
    response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  } catch {
    // Fetch errors can include URLs, headers, or upstream text. Never echo them.
    throw fail("team_unreachable", "Team memory service request failed or timed out.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw fail("team_error", `Team memory service answered HTTP ${response.status}.`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json" && !/^application\/[\w.+-]+\+json$/.test(contentType ?? "")) {
    await response.body?.cancel().catch(() => {});
    throw fail("team_error", "Team memory service must return JSON content.");
  }
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw fail("team_response_too_large", "Team memory service response exceeds the byte limit.");
  }
  if (!response.body) throw fail("team_error", "Team memory service returned an empty response.");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw fail("team_response_too_large", "Team memory service response exceeds the byte limit.");
      }
      chunks.push(value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch (error) {
    if (error instanceof VaultToolError) throw error;
    throw fail("team_error", "Team memory service returned invalid or incomplete JSON.");
  } finally { reader.releaseLock(); }
}

function validId(id) {
  return (typeof id === "string" && id.trim().length > 0 && id.length <= 200) || (Number.isSafeInteger(id) && id > 0);
}

function text(value, max, required = true) {
  return typeof value === "string" && value.length <= max && (!required || value.trim().length > 0);
}

function validateEntry(entry) {
  if (!object(entry) || !text(entry.title, 500) || !text(entry.content, 200_000)) throw fail("invalid_team_memory", "Team memory needs a nonempty title and content within the size limits.");
  if (entry.tags !== undefined && (!Array.isArray(entry.tags) || entry.tags.length > 100 || entry.tags.some((tag) => !text(tag, 200)))) throw fail("invalid_team_memory", "Team memory tags must be a bounded list of strings.");
  for (const [key, max] of [["project", 80], ["role", 40], ["slug", 200]]) {
    if (entry[key] != null && !text(entry[key], max)) throw fail("invalid_team_memory", "Team memory metadata must contain bounded strings.");
  }
}

function presentItem(item) {
  if (!object(item) || !validId(item.id)) throw fail("team_error", "Team memory service returned an item without a valid id.");
  const author = item.author ?? {};
  if (!object(author)) throw fail("team_error", "Team memory service returned invalid author metadata.");
  try { validateEntry({ ...item, project: author.project, role: author.role }); } catch {
    throw fail("team_error", "Team memory service returned an invalid memory payload.");
  }
  if (item.updatedAt != null && (!text(item.updatedAt, 40) || !Number.isFinite(Date.parse(item.updatedAt)))) throw fail("team_error", "Team memory service returned an invalid timestamp.");
  return { id: item.id, title: item.title, content: item.content, tags: item.tags ?? [], author: { project: author.project ?? null, role: author.role ?? null }, updatedAt: item.updatedAt ?? null };
}

export async function teamRemember(vault, settings, entry, now) {
  const team = assertTeamWritable(settings);
  validateEntry(entry);
  if (team.backend !== "http") {
    const db = await openTeamMemoryDb(team);
    const { duplicate, memory } = insertMemory(db, { ...entry, scope: "team", teamId: team.teamId }, now);
    return { duplicate, id: memory.id, backend: team.backend };
  }
  const answer = await request(team, "POST", "v1/memories", {
    body: { teamId: team.teamId, slug: entry.slug ?? undefined, title: entry.title, content: entry.content, tags: entry.tags ?? [], author: { project: entry.project ?? undefined, role: entry.role ?? undefined } },
  });
  if (!object(answer) || !validId(answer.id)) throw fail("team_error", "Team memory service returned no valid memory id.");
  return { duplicate: false, id: answer.id, backend: "http" };
}

export async function teamRecall(vault, settings, { query, limit = 10, role } = {}) {
  const team = assertTeamReadable(settings);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail("invalid_limit", "Team memory limit must be an integer from 1 to 1000.");
  if (query !== undefined && (typeof query !== "string" || query.length > 10_000)) throw fail("invalid_query", "Team memory query must be a string no longer than 10000 characters.");
  if (role != null && !text(role, 40)) throw fail("invalid_role", "Team memory role must be a bounded string.");
  if (team.backend !== "http") {
    const db = await openTeamMemoryDb(team);
    const rows = searchMemories(db, { scope: "team", teamId: team.teamId, role, query, limit });
    return rows.map((row) => ({ id: row.id, title: row.title, content: row.content, tags: row.tags, author: { project: row.project, role: row.role }, updatedAt: row.updatedAt }));
  }
  const answer = await request(team, "GET", "v1/memories/search", { query: { teamId: team.teamId, q: query ?? "", limit, role: role ?? undefined } });
  if (!object(answer) || !Array.isArray(answer.items) || answer.items.length > limit) throw fail("team_error", "Team memory service returned an invalid or oversized items list.");
  return answer.items.map(presentItem).filter((item) => role === undefined || item.author.role === role);
}
