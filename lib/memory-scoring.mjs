export const tokensOf = (query) => [...new Set(String(query ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))];

export function scoreTerms(title, content, tags, terms) {
  if (terms.length === 0) return 1;
  title = title.toLowerCase();
  content = content.toLowerCase();
  tags = JSON.parse(tags).join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    const hits = (title.includes(term) ? 3 : 0) + (tags.includes(term) ? 2 : 0) + Math.min(content.split(term).length - 1, 5);
    if (!hits) return 0;
    score += hits;
  }
  return score;
}

export const scoreMemory = (title, content, tags, query) => scoreTerms(title, content, tags, tokensOf(query));
