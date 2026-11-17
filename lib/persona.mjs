// Local behavioral guidance, separate from factual memory and authorization.
// Evidence and review decisions are immutable; only an idle boundary changes the applied profile.
import { createHash } from "node:crypto";
import { activeMemoryTasks, dbTransaction, memoryDbFile, openMemoryDb } from "./memory-db.mjs";
import { assertNoSecrets, requireProject, VaultToolError } from "./memory-store.mjs";
import { loadSettings } from "./settings.mjs";

const CATEGORIES = ["question_style", "coding_style", "task_delegation", "work_hours"];
const SOURCES = ["user_preference", "observation"];
const initialized = new WeakSet();
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code, message) => new VaultToolError(code, message);
const NOTICE = "Style guidance only; current instructions override this profile. Counts do not establish truth or permission. Work hours never authorize scheduling or actions.";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS persona_profiles (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  project TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  active TEXT NOT NULL DEFAULT '[]',
  applied_at TEXT,
  PRIMARY KEY (scope, project)
);
CREATE TABLE IF NOT EXISTS persona_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  pattern TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (scope, project, category, pattern),
  FOREIGN KEY (scope, project) REFERENCES persona_profiles(scope, project)
);
CREATE TABLE IF NOT EXISTS persona_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id INTEGER NOT NULL REFERENCES persona_patterns(id),
  guidance TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('user_preference', 'observation')),
  evidence TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (pattern_id, evidence_hash)
);
CREATE INDEX IF NOT EXISTS persona_evidence_pattern ON persona_evidence(pattern_id, id);
CREATE TABLE IF NOT EXISTS persona_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id INTEGER NOT NULL REFERENCES persona_patterns(id),
  action TEXT NOT NULL CHECK (action IN ('accept', 'reject', 'disable')),
  guidance TEXT,
  evidence_through INTEGER NOT NULL,
  applied_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS persona_decisions_pattern ON persona_decisions(pattern_id, id);
CREATE TRIGGER IF NOT EXISTS persona_evidence_no_update BEFORE UPDATE ON persona_evidence
BEGIN SELECT RAISE(ABORT, 'Persona evidence is immutable.'); END;
CREATE TRIGGER IF NOT EXISTS persona_evidence_no_delete BEFORE DELETE ON persona_evidence
BEGIN SELECT RAISE(ABORT, 'Persona evidence is immutable.'); END;
CREATE TRIGGER IF NOT EXISTS persona_decisions_no_content_update
BEFORE UPDATE OF pattern_id, action, guidance, evidence_through, created_at ON persona_decisions
BEGIN SELECT RAISE(ABORT, 'Persona decisions are immutable.'); END;
CREATE TRIGGER IF NOT EXISTS persona_decisions_no_delete BEFORE DELETE ON persona_decisions
BEGIN SELECT RAISE(ABORT, 'Persona decisions are immutable.'); END;
`;

function text(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]|```/.test(value)) {
    throw fail("invalid_persona", `${name} must be a nonempty single-line summary of at most ${max} characters.`);
  }
  assertNoSecrets(value);
  return value.trim();
}

function behavioral(value) {
  // This API accepts practical interaction summaries, not demographic or psychological profiles.
  const personalAttribute = /\b(?:race|diagnosis)\s*[:=]|\b(?:user(?:'s)?|operator(?:'s)?|person(?:'s)?|their|his|her|your|my)\s+(?:race|diagnosis)\b|\b(?:user|operator|person|they|he|she)\s+(?:has|have|had|is|was|were|has been|have been)\s+(?:(?:a|an|been)\s+)?(?:diagnosis|diagnosed)\b|\b(?:infer|guess|deduce|predict)\s+(?:(?:the|a|an)\s+)?(?:race(?![- ]conditions?\b)|diagnosis)\b/iu;
  if (personalAttribute.test(value) || /\b(?:ethnicity|nationality|citizenship|religion|religious|political affiliation|sexual orientation|sexuality|gender identity|mental health|personality|temperament|introvert|extrovert|neurotic|bipolar|autis(?:m|tic)|adhd|depress(?:ion|ed)|anxiety disorder|intelligence quotient|iq score)\b|\b(?:age|sex|gender)\s*[:=]|\b\d{1,3}[ -]year[ -]old\b|인종|민족|종교|성적 지향|성별 정체성|정신 건강|정신질환|성격장애|우울증|조울증|자폐/iu.test(value)) {
    throw fail("persona_sensitive", "Persona stores practical behavior only, not sensitive demographic or psychological claims.");
  }
  return value;
}

function timestamp(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw fail("invalid_persona", "now must be a valid Date.");
  return now.toISOString();
}

function policy(vault) {
  return { enabled: true, minObservations: 3, maxContextChars: 2000, ...loadSettings(vault).persona };
}

async function namespace(vault, args) {
  const scope = args.scope ?? "global";
  if (!["global", "project"].includes(scope)) throw fail("invalid_persona_scope", "Persona scope must be global or project; team collection is not supported.");
  if (scope === "global") {
    if (args.project != null) throw fail("invalid_persona_scope", "Global persona must not specify a project.");
    return { scope, project: "" };
  }
  return { scope, project: await requireProject(vault, args) };
}

async function database(vault) {
  const db = await openMemoryDb(memoryDbFile(vault));
  if (!initialized.has(db)) {
    dbTransaction(db, () => db.exec(SCHEMA));
    initialized.add(db);
  }
  return db;
}

function profile(db, key) {
  return db.prepare("SELECT * FROM persona_profiles WHERE scope = ? AND project = ?").get(key.scope, key.project)
    ?? { ...key, revision: 0, active: "[]", applied_at: null };
}

function ensureProfile(db, key) {
  db.prepare("INSERT OR IGNORE INTO persona_profiles (scope, project) VALUES (?, ?)").run(key.scope, key.project);
}

function revisionHash(row) {
  return hash([row.scope, row.project, row.revision, row.active, row.applied_at]);
}

function bump(db, key) {
  db.prepare("UPDATE persona_profiles SET revision = revision + 1 WHERE scope = ? AND project = ?").run(key.scope, key.project);
}

function candidates(db, key, settings, patternId = null) {
  const rows = db.prepare("SELECT * FROM persona_patterns WHERE scope = ? AND project = ? AND (? IS NULL OR id = ?) ORDER BY id").all(key.scope, key.project, patternId, patternId);
  return rows.map((row) => {
    const evidence = db.prepare("SELECT * FROM persona_evidence WHERE pattern_id = ? ORDER BY id").all(row.id);
    const decision = db.prepare("SELECT * FROM persona_decisions WHERE pattern_id = ? ORDER BY id DESC LIMIT 1").get(row.id);
    const groups = new Map();
    for (const item of evidence) {
      const key = JSON.stringify([item.guidance, item.source_kind]);
      if (!groups.has(key)) groups.set(key, { guidance: item.guidance, sourceKind: item.source_kind, evidenceCount: 0, independent: new Set() });
      const group = groups.get(key);
      group.evidenceCount++;
      group.independent.add(item.task_id ? `task:${item.task_id}` : `evidence:${item.evidence_hash}`);
    }
    const variants = [...groups.values()].map(({ independent, ...group }) => ({ ...group, independentCount: independent.size }));
    const guidanceValues = new Set(evidence.map((item) => item.guidance));
    let conflict = guidanceValues.size > 1;
    let status = "pending";
    let guidance = evidence[0]?.guidance ?? "";
    let sourceKind = evidence.some((item) => item.source_kind === "user_preference") ? "user_preference" : "observation";
    if (decision) {
      guidance = decision.guidance ?? guidance;
      conflict = decision.action === "accept" && evidence.some((item) => item.id > decision.evidence_through && item.guidance !== guidance);
      status = decision.action === "accept" ? "accepted" : decision.action === "reject" ? "rejected" : "disabled";
      sourceKind = "submitted_decision";
    } else if (!conflict) {
      const independent = new Set(evidence.map((item) => item.task_id ? `task:${item.task_id}` : `evidence:${item.evidence_hash}`));
      if (sourceKind === "user_preference") status = "preference";
      else if (independent.size >= settings.minObservations) status = "tentative";
    }
    if (conflict) status = "conflict";
    return {
      id: row.id, category: row.category, pattern: row.pattern, guidance, sourceKind, status, conflict,
      evidenceCount: evidence.length,
      independentCount: new Set(evidence.map((item) => item.task_id ? `task:${item.task_id}` : `evidence:${item.evidence_hash}`)).size,
      variants: variants.slice(0, 5),
      variantCount: variants.length,
      variantsTruncated: variants.length > 5,
      evidence: evidence.slice(-5).map((item) => ({ id: item.id, reference: item.evidence, taskId: item.task_id, sourceKind: item.source_kind, createdAt: item.created_at })),
      evidenceTruncated: evidence.length > 5,
      ...(decision ? { decision: { id: decision.id, action: decision.action, guidance: decision.guidance, staged: !decision.applied_at } } : {}),
    };
  });
}

const eligible = (candidate) => ["preference", "accepted", "tentative"].includes(candidate.status) && !candidate.conflict;
const appliedCandidate = ({ decision, variants, variantCount, variantsTruncated, evidence, evidenceTruncated, ...candidate }) => candidate;
const metadata = (row, enabled) => ({ enabled, scope: row.scope, project: row.project || null, revision: row.revision, hash: revisionHash(row) });

function budget(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw fail("invalid_persona", `maxChars must be an integer from 0 to ${maximum}.`);
  return value;
}

export async function observePersona(vault, args = {}, { now = new Date() } = {}) {
  const settings = policy(vault);
  const key = await namespace(vault, args);
  if (!settings.enabled) return { enabled: false, staged: false, collected: false };
  if (!CATEGORIES.includes(args.category)) throw fail("invalid_persona", `category must be one of ${CATEGORIES.join(", ")}.`);
  if (!SOURCES.includes(args.sourceKind)) throw fail("invalid_persona", "sourceKind must be user_preference or observation.");
  const pattern = behavioral(text(args.pattern, "pattern", 120));
  const guidance = behavioral(text(args.guidance, "guidance", 600));
  const evidence = text(args.evidence, "evidence", 500);
  const taskId = args.taskId == null ? null : text(args.taskId, "taskId", 200);
  const at = timestamp(now);
  const db = await database(vault);
  return dbTransaction(db, () => {
    if (taskId && !db.prepare("SELECT 1 FROM memory_tasks WHERE id = ?").get(taskId)) throw fail("invalid_memory_task", "Persona taskId must reference a recorded memory task.");
    ensureProfile(db, key);
    db.prepare("INSERT OR IGNORE INTO persona_patterns (scope, project, category, pattern, created_at) VALUES (?, ?, ?, ?, ?)").run(key.scope, key.project, args.category, pattern, at);
    const row = db.prepare("SELECT id FROM persona_patterns WHERE scope = ? AND project = ? AND category = ? AND pattern = ?").get(key.scope, key.project, args.category, pattern);
    const evidenceHash = hash(evidence);
    const previous = db.prepare("SELECT * FROM persona_evidence WHERE pattern_id = ? AND evidence_hash = ?").get(row.id, evidenceHash);
    if (previous && (previous.guidance !== guidance || previous.source_kind !== args.sourceKind || previous.task_id !== taskId)) {
      throw fail("persona_evidence_conflict", "This provenance reference already records different evidence; submit a new reference for a new event.");
    }
    if (!previous) {
      db.prepare("INSERT INTO persona_evidence (pattern_id, guidance, source_kind, evidence, evidence_hash, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, guidance, args.sourceKind, evidence, evidenceHash, taskId, at);
      bump(db, key);
    }
    const candidate = candidates(db, key, settings, row.id)[0];
    return { ...metadata(profile(db, key), true), collected: !previous, staged: true, patternId: row.id, evidenceId: previous?.id ?? Number(db.prepare("SELECT id FROM persona_evidence WHERE pattern_id = ? AND evidence_hash = ?").get(row.id, evidenceHash).id), candidate };
  });
}

export async function readPersona(vault, args = {}, { now = new Date() } = {}) {
  timestamp(now);
  const settings = policy(vault);
  const key = await namespace(vault, args);
  if (args.patternId !== undefined && (!Number.isSafeInteger(args.patternId) || args.patternId < 1 || args.context === true)) {
    throw fail("invalid_persona", "patternId must be a positive integer and is only supported in full profile mode.");
  }
  const db = await database(vault);
  return dbTransaction(db, () => {
    const row = profile(db, key);
    const result = { ...metadata(row, settings.enabled), warnings: [NOTICE], truncated: false };
    if (args.context !== undefined && typeof args.context !== "boolean") throw fail("invalid_persona", "context must be a boolean.");
    const active = settings.enabled ? JSON.parse(row.active).filter((item) => args.patternId === undefined || item.id === args.patternId) : [];
    if (args.patternId !== undefined && !db.prepare("SELECT 1 FROM persona_patterns WHERE id = ? AND scope = ? AND project = ?").get(args.patternId, key.scope, key.project)) {
      throw fail("persona_not_found", "Persona pattern does not exist in this scope.");
    }
    if (args.context) {
      const maxChars = Math.min(settings.maxContextChars, budget(args.maxChars, settings.maxContextChars, 20_000));
      let context = "";
      for (const item of active) {
        const label = item.status === "tentative" ? "Tentative behavioral suggestion, not fact" : item.status === "preference" ? "Submitted style preference, not authentication" : "Submitted style decision, not authentication";
        const line = `[persona:${item.id}; ${item.category}; ${label}] ${item.guidance}`;
        const next = context ? `${context}\n${line}` : `${NOTICE}\n${line}`;
        if (next.length > maxChars) { result.truncated = true; continue; }
        context = next;
      }
      return { ...result, context };
    }
    const maxChars = budget(args.maxChars, 12_000, 20_000);
    if (maxChars < 1024) throw fail("invalid_persona", "Full profile maxChars must be at least 1024; use context mode for smaller budgets.");
    const current = settings.enabled ? candidates(db, key, settings, args.patternId ?? null) : [];
    const pending = current.filter((item) => {
      const applied = active.find((entry) => entry.id === item.id);
      return item.decision?.staged || !applied || JSON.stringify(applied) !== JSON.stringify(appliedCandidate(item));
    });
    if (pending.some((item) => item.conflict)) result.warnings.push("Conflicting guidance requires an explicit submitted resolution; conflicting candidates are not adopted.");
    result.active = [];
    result.pending = [];
    if (args.patternId !== undefined && current.length && active.length && !pending.length) {
      active[0] = current[0];
    }
    // Bound the entire structured result, not only individual guidance strings.
    for (const [name, values] of [["active", active], ["pending", pending]]) {
      for (const item of values) {
        result[name].push(item);
        if (JSON.stringify(result).length > maxChars) {
          result[name].pop();
          const compact = {
            id: item.id, category: item.category, pattern: item.pattern, status: item.status,
            evidenceCount: item.evidenceCount, independentCount: item.independentCount,
            conflict: item.conflict, truncated: true,
            ...(item.variantCount === undefined ? {} : { variantCount: item.variantCount, variantsTruncated: true }),
          };
          result[name].push(compact);
          if (JSON.stringify(result).length > maxChars) result[name].pop();
          result.truncated = true;
        }
      }
    }
    return result;
  });
}

export async function resolvePersona(vault, args = {}, { now = new Date() } = {}) {
  const settings = policy(vault);
  const key = await namespace(vault, args);
  if (!settings.enabled) return { enabled: false, staged: false };
  if (!Number.isSafeInteger(args.patternId) || args.patternId < 1 || !["accept", "reject", "disable"].includes(args.action)) throw fail("invalid_persona", "A positive patternId and accept, reject, or disable action are required.");
  if (typeof args.expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(args.expectedHash)) throw fail("invalid_persona", "expectedHash must be a profile SHA-256 hash.");
  if (args.guidance !== undefined && args.action !== "accept") throw fail("invalid_persona", "Only accept may supply updated guidance.");
  const updated = args.guidance === undefined ? null : behavioral(text(args.guidance, "guidance", 600));
  const at = timestamp(now);
  const db = await database(vault);
  return dbTransaction(db, () => {
    const row = profile(db, key);
    if (revisionHash(row) !== args.expectedHash) throw fail("hash_mismatch", "Persona changed since review; read the profile before resolving again.");
    const candidate = candidates(db, key, settings).find((item) => item.id === args.patternId);
    if (!candidate) throw fail("persona_not_found", "Persona pattern does not exist in this scope.");
    if (args.action === "accept" && candidate.conflict && !updated) throw fail("persona_conflict", "Conflicting guidance requires an explicit guidance choice.");
    const guidance = args.action === "accept" ? updated ?? candidate.guidance : null;
    const through = db.prepare("SELECT MAX(id) AS id FROM persona_evidence WHERE pattern_id = ?").get(args.patternId).id;
    db.prepare("INSERT INTO persona_decisions (pattern_id, action, guidance, evidence_through, created_at) VALUES (?, ?, ?, ?, ?)").run(args.patternId, args.action, guidance, through, at);
    bump(db, key);
    return { ...metadata(profile(db, key), true), staged: true, patternId: args.patternId, action: args.action };
  });
}

export async function applyPersona(vault, args = {}, { now = new Date() } = {}) {
  const settings = policy(vault);
  if (!settings.enabled) return { enabled: false, applied: false, deferred: false, activeTasks: 0, profiles: 0, changed: 0 };
  const selected = args.scope !== undefined || args.project !== undefined || args.cwd !== undefined ? await namespace(vault, args) : null;
  const at = timestamp(now);
  const db = await database(vault);
  return dbTransaction(db, () => {
    const activeTasks = activeMemoryTasks(db).length;
    if (activeTasks) return { enabled: true, applied: false, deferred: true, activeTasks, profiles: 0, changed: 0 };
    const profiles = selected ? [profile(db, selected)] : db.prepare("SELECT * FROM persona_profiles ORDER BY scope, project").all();
    let changed = 0;
    for (const row of profiles) {
      const desired = candidates(db, row, settings).filter(eligible).map(appliedCandidate);
      const pendingDecision = db.prepare("SELECT 1 FROM persona_decisions d JOIN persona_patterns p ON p.id = d.pattern_id WHERE p.scope = ? AND p.project = ? AND d.applied_at IS NULL LIMIT 1").get(row.scope, row.project);
      if (JSON.stringify(desired) === row.active && !pendingDecision) continue;
      ensureProfile(db, row);
      db.prepare("UPDATE persona_profiles SET active = ?, revision = revision + 1, applied_at = ? WHERE scope = ? AND project = ?").run(JSON.stringify(desired), at, row.scope, row.project);
      db.prepare("UPDATE persona_decisions SET applied_at = ? WHERE applied_at IS NULL AND pattern_id IN (SELECT id FROM persona_patterns WHERE scope = ? AND project = ?)").run(at, row.scope, row.project);
      changed++;
    }
    if (changed > 0) db.prepare("INSERT INTO meta(k,v) VALUES ('context_revision','1') ON CONFLICT(k) DO UPDATE SET v=CAST(v AS INTEGER)+1").run();
    return { enabled: true, applied: true, deferred: false, activeTasks: 0, profiles: profiles.length, changed };
  });
}
