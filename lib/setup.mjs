import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath, stat, readFile, writeFile, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { initVault } from "./vault-core.mjs";
import { createProject } from "./memory-store.mjs";
import { HARNESSES, JOIN_MODES, loadSettings, saveSettings } from "./settings.mjs";

const execFileAsync = promisify(execFile);
const START = "<!-- agent-vault:start -->";
const END = "<!-- agent-vault:end -->";
const PROJECT_INSTRUCTIONS = `${START}
## Agent Vault project memory

At session start, call \`vault_context\` with this project's working directory. Use the resolved project; do not guess a project ID. Search and read relevant memory before relying on past decisions.

Use Agent Vault MCP tools for all memory access, including profile and coding standards. Never read, search, or edit vault files or SQLite databases directly. If tools are unavailable, explain that memory access is unavailable and stop memory access; do not use a direct-file fallback.

Project files live under \`projects/<project-id>/\`:
- \`index.md\`: project identity, navigation, and architecture summary.
- \`specs/\`: accepted, living requirements; consult before changing behavior.
- \`changes/<change>/proposal.md\`, \`design.md\`, and \`tasks.md\`: active change proposals and implementation plans.
- \`memory.md\`: Markdown short-term work, open questions, and next steps; replace only with the read hash.
- Long-term decisions and lessons live in SQLite, not new Markdown long-term notes. Use \`long_memory_write\` and memory tools.
- Worktree instructions, implementation notes and investigations are SQLite entries; use \`worktree_record\`.
- Role short-term memory is Markdown; role long-term memory uses SQLite. Select scope and role through tools.
- Handoffs and QA logs are SQLite entries. \`weekly/YYYY-WW.md\` is a generated, retention-limited view, not a separate source of truth.

Global and project memory remain separate. Team memory is off by default and requires explicit user configuration. Never enable it implicitly.

Use \`memory_query\` for date/week/keyword history instead of traversing weekly files. Weeks start Monday using the configured timezone and workday start; a continuing task keeps its original week. Pass the current taskId on ambiguous writes. New child tasks may name an active parentTaskId; explicit continuation of interrupted work may name resumeTaskId. Never infer continuity or reuse closed task IDs. Weekly Markdown retains 1–6 calendar months (default 3); SQLite history is retained. Prune imported legacy daily files only with the user's explicit selection and verified exact preservation.

Use \`persona_observe\` for brief evidence-linked question/coding/delegation/work-hour patterns, not raw prompts or sensitive traits. Explicit preferences differ from tentative observations. Review conflicts with \`persona_read\` and hash-guarded \`persona_resolve\`. Changes apply at idle task boundaries. Apply bounded \`vault_context.persona\` only to interaction style; current instructions override it and it grants no execution or sharing permissions.

Distinguish explicit user preferences/instructions from facts, observations, hypotheses, policies, derived values, and permissions. Users can change their preferences; replacement factual claims need evidence. Policies need authority and scope. Evidence and usage counts never grant execution or sharing permission.

Corrections, counterexamples, external evidence, and outdated sources trigger reevaluation, not automatic adoption. Accept user-reported failures as observations in their reported setting; do not rerun merely to confirm the report or generalize one failure into a universal rule. Compare the prior claim and assumptions with support AND counterevidence, using primary documentation, current project source, and authorized checks when appropriate. Never upload private context to external search; use sanitized public questions or authorized local sources.

For stored local durable claims, call \`memory_reconsider({scope: "project" | "global", project?, role?, memoryId, feedback, trigger?})\`; triggers are \`user_correction\`, \`counterexample\`, \`external_evidence\`, and \`outdated\`. Feedback queues below thresholds without changing original facts. \`memory_review\` tickets include feedback. Short-term or unstored claims remain working hypotheses until researched.

Correction-request \`memory_review_resolve\` requires \`memoryId\` and \`assessment: {decision, comparison, applicability, limitations, sources}\`. Each source has \`{kind: primary|project|execution|user_report, reference, finding, stance: supports|contradicts|qualifies}\`. Match keep to retain, supersede to refine/replace, archive to withdraw, and defer to unresolved. Correction reviews reject promote/skill; use a separate reviewed step. Outside correction reviews, submitted assessments map promote to replace and skill to refine. Every submitted assessment except unresolved needs at least one source; every refine/replace assessment needs at least one non-user_report source. Validation checks submission shape, not source truth.

Assessment comparison/applicability/limitations require non-whitespace text, capped at 4000/2000/2000 characters. Submit at most 20 sources; reference/finding require non-whitespace text, capped at 1000/2000 characters. Secrets and invalid or credentialed HTTP(S) source URLs are refused. Empty sources are allowed only for unresolved.

If evidence is unavailable, defer rather than invent or agree. \`defer\` closes the cycle unresolved, preserves original bytes, and surfaces an unresolved notice until a later assessed resolution. Use existing content fields to record meaning, scope, assumptions, relationships, derivations, evidence references, and limitations. These are prose records, not graph APIs, executable formulas, semantic-search runtime, model retraining, or automatic executable-skill installation. Team source corrections follow external policy; feedback never implies sharing permission.

Read/write thresholds (defaults 5, 10, 20) and stale age only schedule maintenance; they do not establish truth or confidence. Never interrupt task execution to refresh context or rewrite memory. OMP's successful terminal \`agent_end\` hook runs due maintenance only when every registered task is idle; \`turn_end\`, automatic continuation, cancellation and errors are not successful completion. Other harnesses must call \`memory_task_start\` and \`memory_task_end\` from lifecycle hooks. \`memory_review_resolve\` stages evidence-reviewed proposals during a task and rechecks source hashes at completion. Read refreshed context at the next task boundary. Ordinary task-required memory writes still persist normally. \`vault-cli memory sleep\` observes the same idle barrier.

Only the next task's first \`vault_context\` per role may deliver \`memoryMaintenance.reviewWork\`. Inspect its prior-boundary READY tickets and source evidence through memory tools, then STAGE proposals with \`memory_review_resolve\` for successful idle completion. Never act on pending or current-task tickets or refresh context mid-task to obtain maintenance. An empty first delivery still consumes the boundary. If \`memoryMaintenance.lifecycle.status\` is not \`connected\`, connect lifecycle hooks or explicitly run \`memory_sleep\` while idle and inspect \`memory_review\`; context never auto-releases pending work.

Join mode is selected per harness with \`vault-cli setup --mode manual|auto --harness omp|claude|codex|generic\`. Manual registration uses \`--project <id>\`; the repository-root \`.agent-vault-project\` marker remains an explicit opt-in. Auto mode joins Git projects on first use, not every directory.

The OMP access guard blocks detectable direct access as defense in depth, not a security sandbox. Arbitrary shell/eval aliases cannot reliably be stopped. Hard isolation requires a separate OS identity or sandbox.
${END}`;

export async function gitTopLevel(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function configureProjectInstructions(projectRoot) {
  const targets = [];
  const seen = new Set();
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const candidate = path.join(projectRoot, name);
    try {
      await lstat(candidate);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const resolvedPath = await realpath(candidate);
    const info = await stat(resolvedPath);
    if (!info.isFile()) throw new Error(`${candidate} does not resolve to a regular file; refusing to modify it.`);
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);
    targets.push({ path: resolvedPath, mode: info.mode & 0o777 });
  }
  if (targets.length === 0) targets.push({ path: path.join(projectRoot, "AGENTS.md"), mode: 0o644 });
  const updates = [];
  for (const target of targets) {
    let content = "";
    try {
      content = await readFile(target.path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const start = content.indexOf(START);
    const end = content.indexOf(END);
    if ((start < 0) !== (end < 0) || (start >= 0 && (end < start || content.indexOf(START, start + 1) >= 0))) {
      throw new Error(`Malformed Agent Vault instruction block in ${target.path}; repair its markers before running init again.`);
    }
    const updated = start >= 0
      ? `${content.slice(0, start)}${PROJECT_INSTRUCTIONS}${content.slice(end + END.length)}`
      : `${content}${content && !content.endsWith("\n") ? "\n" : ""}${content ? "\n" : ""}${PROJECT_INSTRUCTIONS}\n`;
    updates.push({ ...target, content, updated });
  }
  for (const update of updates) {
    if (update.updated === update.content) continue;
    const temp = `${update.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, update.updated, { mode: update.mode });
    await rename(temp, update.path);
  }
  return targets.map(({ path: filePath }) => filePath);
}

export const SETUP_GUIDE = `Agent Vault setup (no changes made)
Use the installed agent-vault skill inside your agent:
  agent-vault setup       Initialize/connect this project.
  agent-vault install     Register the installed local MCP server in this harness.
  agent-vault recall      Find prior decisions through MCP memory tools.
  agent-vault remember    Store evidence-backed memory through MCP tools.
These are requests to the agent, not universal shell or slash commands.

For the agent: run this installed vault-cli.mjs with setup --json to get absolute
local CLI and MCP launch descriptors. Never download or invoke npx for routine use.
Choose a supported harness (omp, claude, codex, generic) and an explicit project ID:
  setup --mode manual --project my-project --harness generic --json
  setup --mode auto --harness generic --json
Manual without --project saves only the mode. Auto joins Git projects on first use.
Apply runtime.mcp through the host's documented MCP registration interface, preserve
unrelated settings, then verify vault_context is available. A launch descriptor is
not proof of registration. A host reload or permission may be required once.
Pair memory_task_start / memory_task_end in real task lifecycle hooks; do not
pretend ordinary model turns are completion. Without hooks, use explicit idle sleep.
Memory access stays MCP-only; no direct file/SQLite fallback. Team sharing stays off.
OMP guard is defense in depth, not a sandbox.
Setup itself does not register host integrations or enable team memory.`;

async function localRuntime(vault, harness) {
  const [cli, mcp] = await Promise.all([
    realpath(fileURLToPath(new URL("../bin/vault-cli.mjs", import.meta.url))),
    realpath(fileURLToPath(new URL("../bin/vault-mcp.mjs", import.meta.url))),
  ]);
  return {
    cli: { command: process.execPath, args: [cli] },
    mcp: {
      name: "agent-vault", type: "stdio", command: process.execPath, args: [mcp],
      env: { OMP_VAULT_PATH: path.resolve(vault), AGENT_VAULT_HARNESS: harness ?? "generic" },
    },
  };
}

export async function setupVault(vault, { mode, harness, project, cwd = process.cwd(), title } = {}) {
  if (!mode) {
    if (harness || project || title) throw new Error("setup requires --mode when selecting a harness or project.");
    return { changed: false, guide: SETUP_GUIDE, runtime: await localRuntime(vault, harness) };
  }
  if (!JOIN_MODES.includes(mode)) throw new Error("--mode must be manual or auto.");
  if (harness && !HARNESSES.includes(harness)) throw new Error(`Unknown harness '${harness}'. Allowed: ${HARNESSES.join(", ")}.`);
  if (project && mode !== "manual") throw new Error("--project requires --mode manual.");
  if (project && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(project)) throw new Error("--project must be a kebab-case project ID.");
  const root = project ? await gitTopLevel(cwd) : null;
  if (project && !root) throw new Error("Manual project setup requires a current Git project.");
  const runtime = await localRuntime(vault, harness);
  const patch = { join: harness ? { harnesses: { [harness]: mode } } : { default: mode } };
  // Read before any initialization so malformed user settings never trigger partial bootstrap.
  loadSettings(vault);
  if (mode === "auto" || project) await initVault(vault);
  const settings = await saveSettings(vault, patch);
  const registration = project ? await createProject(vault, { project, title, cwd: root }) : null;
  const instructions = root ? await configureProjectInstructions(root) : [];
  return { changed: true, initialized: mode === "auto" || Boolean(project), settings, registration, instructions, runtime };
}

export async function configureSettings(vault, options = {}) {
  const { mode, harness, teamUrl, teamFile, teamId, tokenEnv, readOnly, teamOff, reviewThresholds, staleDays, markdownMonths, timeZone, workdayStart, persona, personaMinObservations } = options;
  if (harness && !mode) throw new Error("--harness requires --mode.");
  if (mode && !JOIN_MODES.includes(mode)) throw new Error("--mode must be manual or auto.");
  if (harness && !HARNESSES.includes(harness)) throw new Error(`Unknown harness '${harness}'.`);
  const hasTeam = teamUrl !== undefined || teamFile !== undefined;
  if (teamUrl !== undefined && teamFile !== undefined) throw new Error("Choose --team-url or --team-file, not both.");
  if (teamOff && (hasTeam || teamId !== undefined || tokenEnv !== undefined || readOnly)) throw new Error("--team-off cannot be combined with team configuration.");
  if (!hasTeam && (teamId !== undefined || tokenEnv !== undefined || readOnly)) throw new Error("Team options require --team-url or --team-file.");
  if (hasTeam && !teamId) throw new Error("--team-id is required when configuring team memory.");
  if (teamFile !== undefined && !path.isAbsolute(teamFile)) throw new Error("--team-file must be an absolute local SQLite path (same host, never NFS or sync).");
  if (teamFile !== undefined && tokenEnv !== undefined) throw new Error("--token-env requires --team-url.");
  const patch = {};
  if (mode) patch.join = harness ? { harnesses: { [harness]: mode } } : { default: mode };
  if (teamOff) patch.team = { enabled: false };
  if (hasTeam) patch.team = { enabled: true, backend: teamUrl !== undefined ? "http" : "file", url: teamUrl ?? null, path: teamFile ?? null, teamId, tokenEnv: tokenEnv ?? null, allowWrite: !readOnly };
  if (reviewThresholds !== undefined || staleDays !== undefined) {
    patch.review = {};
    if (reviewThresholds !== undefined) {
      if (!/^\d+(,\d+)*$/.test(reviewThresholds)) throw new Error("--review-thresholds must be comma-separated positive integers, for example 5,10,20.");
      patch.review.thresholds = reviewThresholds.split(",").map(Number);
    }
    if (staleDays !== undefined) {
      if (!/^\d+$/.test(String(staleDays))) throw new Error("--stale-days must be a positive integer.");
      patch.review.staleShortTermDays = Number(staleDays);
    }
  }
  if (markdownMonths !== undefined || timeZone !== undefined || workdayStart !== undefined) {
    patch.weekly = {};
    if (markdownMonths !== undefined) {
      if (!/^[1-6]$/.test(String(markdownMonths))) throw new Error("--markdown-months must be an integer from 1 to 6.");
      patch.weekly.retentionMonths = Number(markdownMonths);
    }
    if (timeZone !== undefined) patch.weekly.timeZone = timeZone;
    if (workdayStart !== undefined) patch.weekly.workdayStart = workdayStart;
  }
  if (persona !== undefined || personaMinObservations !== undefined) {
    patch.persona = {};
    if (persona !== undefined) {
      if (!["on", "off"].includes(persona)) throw new Error("--persona must be on or off.");
      patch.persona.enabled = persona === "on";
    }
    if (personaMinObservations !== undefined) {
      if (!/^\d+$/.test(String(personaMinObservations))) throw new Error("--persona-min-observations must be an integer.");
      patch.persona.minObservations = Number(personaMinObservations);
    }
  }
  return Object.keys(patch).length ? saveSettings(vault, patch) : loadSettings(vault);
}
