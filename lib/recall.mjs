// Deterministic, local relevance ranking for prompt-style queries. No model, embedding service or network is used.
// Unlike keyword search (every term must match), recall treats a prompt as a bag of terms: a memory qualifies when it
// matches at least two distinct terms (one for a one-term query) and ranks by rarity-weighted matches, field weights,
// recency and prior read usage. Scores order candidates; they never assert that a memory is true or current.

const STOP = new Set(("a an and are as at be been but by can could did do does for from had has have how i if in into is it its just may me my "
  + "no not of on or our please should so than that the their them then there these they this those to up us was we were what when where which who why "
  + "will with would you your about after again all also any before between both each get got here more most only other out over some such too very").split(" "));
const HANGUL = /^[\p{Script=Hangul}]+$/u;
const PARTICLES_2 = ["에서", "으로", "에게", "까지", "부터", "처럼", "보다", "에는", "에도", "이다"];
const PARTICLES_1 = "은는이가을를의에도로과와";
const MAX_TERMS = 24;
const MAX_CANDIDATES = 500;

/** Distinct query terms, each with the surface forms that count as a match (Korean particles stripped). */
export function queryTerms(query) {
  const seen = new Set();
  const groups = [];
  for (const raw of String(query ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    if (raw.length < 2 || STOP.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    const forms = [raw];
    if (HANGUL.test(raw)) {
      const two = PARTICLES_2.find((particle) => raw.length >= 4 && raw.endsWith(particle));
      if (two) forms.push(raw.slice(0, -2));
      else if (raw.length >= 3 && PARTICLES_1.includes(raw.at(-1))) forms.push(raw.slice(0, -1));
    }
    groups.push(forms);
    if (groups.length >= MAX_TERMS) break;
  }
  return groups;
}

const countOf = (text, form) => (form ? text.split(form).length - 1 : 0);

function matchGroup(row, forms) {
  let title = 0, tags = 0, content = 0;
  for (const form of forms) {
    title = Math.max(title, row.title.includes(form) ? 1 : 0);
    tags = Math.max(tags, row.tags.includes(form) ? 1 : 0);
    content = Math.max(content, countOf(row.content, form));
  }
  return { title, tags, content };
}

/**
 * Rank memory rows for a query. `rows` need title, content, tags (array), readCount and updatedAt.
 * Returns `[{ memory, score, matchedTerms }]`, best first, at most `limit` entries.
 */
export function rankMemories(rows, query, { now = new Date(), limit = 5 } = {}) {
  const groups = queryTerms(query);
  if (groups.length === 0 || rows.length === 0) return [];
  const prepared = rows.map((memory) => ({
    memory,
    title: String(memory.title ?? "").toLowerCase(),
    content: String(memory.content ?? "").toLowerCase(),
    tags: (Array.isArray(memory.tags) ? memory.tags : []).join(" ").toLowerCase(),
  }));
  const matches = prepared.map((row) => groups.map((forms) => matchGroup(row, forms)));
  const documentFrequency = groups.map((_, index) => matches.filter((perRow) => perRow[index].title || perRow[index].tags || perRow[index].content).length);
  const required = Math.min(2, groups.length);
  const results = [];
  for (const [rowIndex, row] of prepared.entries()) {
    let matched = 0, lexical = 0;
    const matchedTerms = [];
    for (const [index, forms] of groups.entries()) {
      const hit = matches[rowIndex][index];
      const weight = hit.title * 3 + hit.tags * 2 + Math.min(hit.content, 3);
      if (!weight) continue;
      matched++;
      matchedTerms.push(forms[0]);
      lexical += Math.log(1 + (rows.length + 1) / (documentFrequency[index] + 1)) * weight;
    }
    if (matched < required) continue;
    const ageDays = Math.max(0, (now.getTime() - Date.parse(row.memory.updatedAt ?? row.memory.createdAt ?? now.toISOString())) / 86_400_000);
    const recency = 0.7 + 0.3 / (1 + (Number.isFinite(ageDays) ? ageDays : 0) / 90);
    const usage = 1 + Math.min(Number(row.memory.readCount) || 0, 10) / 20;
    const coverage = matched / groups.length;
    results.push({ memory: row.memory, score: Number((lexical * recency * usage * (0.5 + 0.5 * coverage)).toFixed(4)), matchedTerms });
  }
  results.sort((a, b) => b.score - a.score || b.memory.id - a.memory.id);
  return results.slice(0, limit);
}

export const RECALL_CANDIDATE_LIMIT = MAX_CANDIDATES;
