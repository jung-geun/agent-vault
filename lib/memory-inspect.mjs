// Read-only inspection of the memory store: counts, review queue, task state and health checks.
// Nothing here changes memories, tickets, usage counters or settings, and no call is counted toward review thresholds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./memory-store.mjs";
import { loadSettings, publicSettings, resolveHarness } from "./settings.mjs";
import { openVaultMemoryDb, activeMemoryTasks, embeddingCoverage, getMeta, memoryDbFile, memoryTaskOwnerAlive } from "./memory-db.mjs";
import { RECALL_CANDIDATE_LIMIT } from "./recall.mjs";
import { resolveEmbedder } from "./embeddings.mjs";
import { TIDY_REMINDER_DAYS, readTidyState } from "./vault-tidy.mjs";
import { compareVersions, findRetiredToolReferences, inspectInstallation } from "./updater.mjs";

const NODE_RANGE = [[22, 13], [23, 4]];
const rows = (db, sql, ...params) => db.prepare(sql).all(...params);
const count = (db, sql, ...params) => Number(db.prepare(sql).get(...params)?.n ?? 0);

function nodeSupported(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  return major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
}

async function openDb(vault) {
  if (!fs.existsSync(path.join(vault, "_meta"))) return null;
  return openVaultMemoryDb(vault);
}

async function inspectEmbedding(vault, db, project, options) {
  const { provider, available, model, endpoint, reason } = await resolveEmbedder(vault, options);
  const namespace = project ? "(scope = 'global' OR (scope = 'project' AND project = ?))" : "scope = 'global'";
  const ids = rows(db, `SELECT id FROM memories WHERE kind = 'knowledge' AND status = 'active' AND ${namespace}`, ...(project ? [project] : [])).map(({ id }) => id);
  return { provider, available, ...(model && { model }), ...(endpoint && { endpoint }), coverage: embeddingCoverage(db, model, ids), ...(reason && { reason }) };
}

/** Counts and queue state, optionally narrowed to the project that `cwd` or `project` resolves to. */
export async function memoryStats(vault, args = {}, { now = new Date() } = {}) {
  const db = await openDb(vault);
  if (!db) return { vaultReady: false, message: "The vault is not initialized; run setup or init first." };
  const settings = loadSettings(vault);
  const resolution = args.project || args.cwd ? await store.resolveProject(vault, { project: args.project, cwd: args.cwd }) : null;
  const project = resolution?.status === "resolved" ? resolution.projectId : null;
  const scopeFilter = project ? "AND (scope = 'global' OR (scope = 'project' AND project = ?))" : "";
  const scopeParams = project ? [project] : [];
  const tasks = activeMemoryTasks(db).map((task) => ({ taskId: task.taskId, startedAt: task.startedAt, ownerAlive: memoryTaskOwnerAlive(db, task.ownerPid, task.ownerHost) }));
  const latest = db.prepare(`SELECT MAX(updated_at) AS at FROM memories WHERE 1 = 1 ${scopeFilter}`).get(...scopeParams)?.at ?? null;
  const { reason: _reason, ...embedding } = await inspectEmbedding(vault, db, project);
  return {
    vaultReady: true,
    project: resolution ? { status: resolution.status, projectId: project } : null,
    database: { schema: getMeta(db, "schema") ?? null,
      ...(db.driver ? { driver: db.driver, sizeBytes: null } : { sizeBytes: fs.statSync(memoryDbFile(vault)).size }), latestWriteAt: latest },
    memories: {
      byScope: rows(db, `SELECT scope, kind, status, COUNT(*) AS n FROM memories WHERE 1 = 1 ${scopeFilter} GROUP BY scope, kind, status ORDER BY scope, kind, status`, ...scopeParams),
      activeKnowledge: count(db, `SELECT COUNT(*) AS n FROM memories WHERE kind = 'knowledge' AND status = 'active' ${scopeFilter}`, ...scopeParams),
      skillCandidates: count(db, `SELECT COUNT(*) AS n FROM memories WHERE kind = 'knowledge' AND status = 'active' AND read_count >= ? ${scopeFilter}`, settings.review.hotReadCount, ...scopeParams),
    },
    reviews: {
      pending: count(db, "SELECT COUNT(*) AS n FROM reviews WHERE resolved_at IS NULL AND ready_at IS NULL"),
      ready: count(db, "SELECT COUNT(*) AS n FROM reviews WHERE resolved_at IS NULL AND ready_at IS NOT NULL"),
      resolved: count(db, "SELECT COUNT(*) AS n FROM reviews WHERE resolved_at IS NOT NULL"),
      stagedActions: count(db, "SELECT COUNT(*) AS n FROM review_actions WHERE status = 'pending'"),
      failedActions: count(db, "SELECT COUNT(*) AS n FROM review_actions WHERE status = 'failed'"),
      correctionFeedback: count(db, "SELECT COUNT(*) AS n FROM review_feedback"),
    },
    tasks: { active: tasks.length, details: tasks },
    weekly: {
      exports: count(db, "SELECT COUNT(*) AS n FROM weekly_exports"),
      weeks: rows(db, `SELECT week_key AS "week", COUNT(*) AS n FROM memories WHERE week_key IS NOT NULL ${scopeFilter} GROUP BY week_key ORDER BY week_key DESC LIMIT 8`, ...scopeParams),
    },
    embedding,
    settings: publicSettings(settings, resolveHarness(args.harness)),
    checkedAt: now.toISOString(),
  };
}

const check = (name, status, detail, fix) => ({ name, status, detail, ...(fix ? { fix } : {}) });

/** Health checks with an action for every warning. `fail` means memory use is unsafe or impossible until fixed. */
export async function diagnoseMemory(vault, args = {}, { now = new Date(), home = os.homedir() } = {}) {
  const checks = [];
  const supported = nodeSupported();
  checks.push(check("node", supported ? "ok" : "fail", `Node.js ${process.versions.node}`, supported ? undefined : "Install Node.js ^22.13.0 or >=23.4.0 (24 LTS recommended)."));
  if (!fs.existsSync(path.join(vault, "_meta"))) {
    checks.push(check("vault", "fail", "The vault is not initialized.", "Ask the agent to run agent-vault setup, or run vault-cli init."));
    return { healthy: false, checks, checkedAt: now.toISOString() };
  }
  checks.push(check("vault", "ok", "Vault initialized."));
  let settings;
  try { settings = loadSettings(vault); checks.push(check("settings", "ok", "Settings are valid.")); }
  catch (error) { checks.push(check("settings", "fail", error.message, "Repair or remove .agent-vault/settings.json with vault-cli config.")); return { healthy: false, checks, checkedAt: now.toISOString() }; }
  let db;
  try {
    db = await openDb(vault);
    const version = getMeta(db, "schema");
    if (db.driver) {
      db.prepare("SELECT 1").get();
      checks.push(check("database", "ok", `${db.driver} connects and reads schema ${version}.`));
    } else {
      const quick = db.prepare("PRAGMA quick_check").get();
      const verdict = Object.values(quick ?? {})[0];
      checks.push(check("database", verdict === "ok" ? "ok" : "fail", verdict === "ok" ? `SQLite opens and passes quick_check (schema ${version}).` : `quick_check reported: ${verdict}`, verdict === "ok" ? undefined : "Restore .agent-vault/memory.db from a backup; do not edit it by hand."));
    }
  } catch (error) {
    checks.push(check("database", "fail", error.message, "Check the selected backend, driver installation, and database access. SQLite requires a private local file."));
    return { healthy: false, checks, checkedAt: now.toISOString() };
  }
  const resolution = args.project || args.cwd ? await store.resolveProject(vault, { project: args.project, cwd: args.cwd }) : null;
  if (resolution) {
    checks.push(resolution.status === "resolved"
      ? check("project", "ok", `Resolved to '${resolution.projectId}'.`)
      : check("project", "warn", `Project resolution is '${resolution.status}'.`, "Register this repository: ask the agent to run agent-vault setup, or add the .agent-vault-project marker."));
  }
  const tasks = activeMemoryTasks(db);
  const stale = tasks.filter((task) => memoryTaskOwnerAlive(db, task.ownerPid, task.ownerHost) === false);
  const remote = tasks.filter((task) => memoryTaskOwnerAlive(db, task.ownerPid, task.ownerHost) === null).length;
  checks.push(stale.length
    ? check("tasks", "warn", `${stale.length} active task(s) belong to a process that no longer exists; maintenance stays deferred until the next task start cancels them.`, "Start a new task on the owning host.")
    : remote ? check("tasks", "warn", `${remote} active task(s) belong to another host; their liveness is unknown.`, "End abandoned tasks only after confirming their owners are idle.")
      : check("tasks", "ok", `${tasks.length} active task(s); none orphaned.`));
  const failed = count(db, "SELECT COUNT(*) AS n FROM review_actions WHERE status = 'failed'");
  checks.push(failed
    ? check("reviews", "warn", `${failed} staged review action(s) failed to apply.`, "Inspect them with review and resubmit a corrected decision with review_resolve.")
    : check("reviews", "ok", `${count(db, "SELECT COUNT(*) AS n FROM reviews WHERE resolved_at IS NULL")} open review ticket(s); no failed actions.`));
  const embedding = await inspectEmbedding(vault, db, resolution?.status === "resolved" ? resolution.projectId : null, { checkConfigured: true });
  const active = embedding.coverage.total;
  checks.push(active > RECALL_CANDIDATE_LIMIT * 2
    ? check("recall", "warn", `${active} active knowledge memories in scope; recall ranks only the newest ${RECALL_CANDIDATE_LIMIT} per scope.`, "Archive stale memories through review, or query older history with the history tool.")
    : check("recall", "ok", `${active} active knowledge memories in scope; automatic recall is ${settings.recall.auto ? "on" : "off"}.`));
  if (embedding.available) {
    const { model, coverage } = embedding;
    const englishCentric = /all-minilm|snowflake-arctic-embed|granite-embedding:30m|bge-small|nomic-embed-text/i.test(model);
    checks.push(check("embedding", "ok", `Model ${model}; ${coverage.embedded} of ${coverage.total} active knowledge memories embedded.${englishCentric ? " This model is English-centric; use method chars or a multilingual model for Korean, Japanese, or Chinese text." : ""}`));
  } else if (embedding.provider === "http") {
    checks.push(check("embedding", "warn", `Configured embedding server unreachable; ${embedding.coverage.embedded} of ${embedding.coverage.total} active knowledge memories embedded.`, "Start the configured loopback server, check its port, or set vault-cli config --embedding auto."));
  } else {
    const enable = embedding.provider === "off" ? "Set vault-cli config --embedding auto. " : "";
    checks.push(check("embedding", "info", `Similar search uses character similarity (${embedding.reason}).`, `${enable}To enable semantic search, run a local embedding server, install a model (for example, ollama pull all-minilm), then use mode similar.`));
  }
  checks.push(settings.guard.mode === "off"
    ? check("guard", "warn", "The direct-access guard is off.", "Set guard.mode to block unless you intentionally allow direct vault access.")
    : check("guard", "ok", "The direct-access guard is on (defense in depth, not a sandbox)."));
  if (settings.team.enabled) checks.push(check("team", "warn", `Team memory '${settings.team.teamId}' is enabled; its content leaves this vault and is untrusted evidence.`, "Disable with vault-cli config --team-off if sharing is unintended."));
  const tidy = readTidyState(vault);
  if (!tidy) {
    checks.push(check("tidy", "info", "Tags and links have not been audited yet.", "Run vault-cli tidy (or ask the agent to use the tidy tool) every few weeks to find duplicate tags and broken links."));
  } else {
    const days = Math.floor((now.getTime() - Date.parse(tidy.auditedAt)) / 86_400_000);
    const { safeMerges, fixableLinks, brokenLinks } = tidy.summary;
    const pending = safeMerges + fixableLinks + brokenLinks > 0;
    const detail = `Last tag and link audit ${tidy.auditedAt.slice(0, 10)} (${days} days ago): ${safeMerges} safe tag merges, ${fixableLinks} fixable and ${brokenLinks} broken links in editable notes.`;
    checks.push(days > TIDY_REMINDER_DAYS || pending
      ? check("tidy", "info", detail, days > TIDY_REMINDER_DAYS ? "The audit is stale: run vault-cli tidy again." : "Review with vault-cli tidy --plan, then vault-cli tidy --apply.")
      : check("tidy", "ok", detail));
  }
  // The code running here may be newer than the bundle the hosts launch (a checkout, or an update that was never run).
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const installed = await inspectInstallation({ sourceDir: packageRoot, home }).catch(() => null);
  const outdated = installed?.targets.filter((target) => target.kind === "directory" && !target.same && target.version && installed.sourceVersion && compareVersions(target.version, installed.sourceVersion) < 0) ?? [];
  if (outdated.length) {
    checks.push(check("install", "info", `${outdated.map((target) => `${target.id} ${target.version}`).join(", ")} installed; this build is ${installed.sourceVersion}. Hosts that launch the installed bundle run the older code.`, `Run: node '${packageRoot}/bin/vault-cli.mjs' update --from '${packageRoot}'. It shows what changes and asks before installing; restart the host afterwards. Once the update has installed the launchers, plain 'agent-vault update' (or 'vault-cli update') does the same from GitHub.`));
  }
  const retired = await findRetiredToolReferences({ sourceDir: packageRoot, home }).catch(() => []);
  if (retired.length) {
    const names = [...new Set(retired.flatMap((file) => file.hits.map((hit) => `${hit.name} -> ${hit.use}`)))].slice(0, 4).join(", ");
    checks.push(check("instructions", "info", `${retired.map((file) => `${file.path} (${file.count})`).join(", ")} tell agents to call tools that no longer exist (${names}).`, "Rename the tools: run vault-cli init inside a repository for its AGENTS.md or CLAUDE.md, and edit your own instruction files by hand. vault-cli update lists every reference."));
  }
  checks.push(check("hooks", "info", "Lifecycle hooks cannot be verified from inside the memory server.", "Call context and read memoryMaintenance.lifecycle.status, or run vault-cli hooks status --host claude|codex."));
  return { healthy: !checks.some((item) => item.status === "fail"), checks, checkedAt: now.toISOString() };
}
