// Pure credential-shape detector shared by the memory store and settings validation.
// It has no imports on purpose: settings.mjs is loaded by the OMP extension under Bun, which must not pull in SQLite.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/, "GitHub token"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, "API key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, "JWT"],
  [/\b(?:api[_-]?key|secret|token|passwd|password)\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{20,}/i, "credential assignment"],
];

/** Label of the first credential shape found in `text`, or null. */
export function findSecretLabel(text) {
  for (const [pattern, label] of SECRET_PATTERNS) if (pattern.test(text)) return label;
  return null;
}
