#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { resolveVaultPath, initVault, scaffoldProject, getVaultStatus } from "../lib/vault-core.mjs";
import { migrateFromWiki, migrateFromProjectRepo } from "../lib/migration.mjs";
import { getInstallTargets, installAgents, installManagedFile, previewInstallAgents, recommendedInstallMethod, writeAtomic } from "../lib/installer.mjs";

import { setupVault, configureSettings, configureProjectInstructions, gitTopLevel } from "../lib/setup.mjs";

function printUsage() {
  console.log(`
Agent LLM Wiki Vault CLI (agent-vault)

Usage:
  vault-cli setup [--mode manual|auto] [--project <id>] [--harness omp|claude|codex|generic] [--path <path>] [--json]
  vault-cli config [--mode manual|auto] [--harness <name>] [--path <path>]
  vault-cli config --team-url <url> --team-id <id> [--token-env <name>] [--read-only]
  vault-cli config --team-file <absolute-local.sqlite> --team-id <id> [--read-only]
  vault-cli config --team-db-driver postgres|mysql|mariadb --team-id <id> [--team-db-url-env <name> | --team-db-url-file <absolute-path>] [--read-only]
  vault-cli config --team-off | --review-thresholds 5,10,20 | --stale-days <days>
  vault-cli config --markdown-months 1..6 [--timezone Asia/Seoul] [--workday-start 09:00]
  vault-cli config --persona on|off [--persona-min-observations 3]
  vault-cli config --recall on|off [--recall-limit 5] [--recall-max-chars 2000]
  vault-cli config --embedding auto|off|http [--embedding-endpoint <loopback-url>] [--embedding-model <name>]
  vault-cli config --db-driver sqlite|postgres|mysql|mariadb [--db-url-env <name> | --db-url-file <absolute-path>]
  vault-cli memory recall --query <text> [--project <id> | --scope global] [--role <role>] [--limit 5]
  vault-cli memory embed [--project <id> | --scope global] [--limit 500] [--path <path>]
  vault-cli memory stats [--project <id>] [--path <path>]
  vault-cli memory diagnose [--project <id>] [--path <path>]
  vault-cli tidy [--limit 25] [--json] [--path <path>]
  vault-cli tidy --plan|--apply [--accept spelling,plural,typo|none] [--merge old=new,...] [--drop tag,...] [--fix-links safe|all] [--expect <planId>]
  vault-cli tidy --backups | --undo <backupId>
  vault-cli hooks install|status|uninstall --host claude|codex [--local] [--dry-run] [--path <path>]
  vault-cli memory history [--project <id> | --scope global] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--week YYYY-WW] [--query <text>]
  vault-cli persona [--project <id> | --scope global] [--path <path>]
  vault-cli memory maintain [--project <id> | --scope global] [--role <role>] [--path <path>]
  vault-cli memory migrate --project <id> [--prune-legacy] [--path <path>]
  vault-cli memory migrate-db [--from-sqlite <path>] [--team] [--dry-run] [--path <path>]
  vault-cli init [--path <path>]
  vault-cli scaffold --project <id> [--title <title>] [--path <path>]
  vault-cli status [--project <id>] [--path <path>]
  vault-cli migrate --from-wiki <path> [--profile-source <relative-file>] [--path <path>]
  vault-cli migrate --from-repo <path> [--project <id>] [--path <path>]
  vault-cli install [--interactive] [--global | --local | --obsidian] [--agents omp,claude,universal,cursor] [--method copy|symlink]
  vault-cli update [--from <directory> | --archive <file|https-url>] [--ref <branch|tag|commit>] [--local] [--dry-run] [--expect <planId>] [--no-verify] [--allow-downgrade] [--allow-same-version] [--json]
  vault-cli update --backups | --rollback <backupId|latest>

Options:
  --path <path>            Target Obsidian vault path (default: ~/.vault)
  --project <id>           Project kebab-case identifier (e.g. 'my-project')
  --title <title>          Human-readable project title
  --from-wiki <path>       Path to existing Obsidian-compatible wiki
  --profile-source <path>  Optional profile file relative to --from-wiki
  --from-repo <path>       Project repo containing OpenSpec or memory
  --global                Install user skills (default: OMP and Universal)
  --local                 Install project-local skills (default: OMP)
  --interactive           Choose agents, scope and method, then confirm exact paths
  --agents <ids>          Comma-separated agent targets
  --method <method>       Copy independent bundles or link to a stable Universal bundle
  Memory recall/history search: [--mode keyword|regex|similar] [--method auto|embedding|chars] [--flags <imsu>] [--limit <n>]
  Regex and similar mode return 5 results by default (1–10 allowed). --method applies to similar; --flags applies to regex.
  --obsidian              Install Agent Vault Wiki and Bases into the target vault
  init also adds or refreshes guidance in each existing AGENTS.md and CLAUDE.md at the Git repository root; creates AGENTS.md only when neither exists.
  setup without --mode prints guided help and makes no changes.
  Setup never installs global integrations or enables team memory.
  Team SQLite is same-host/local-filesystem only, never NFS or sync folders.
  Memory is tool-only. The OMP guard is defense in depth, not an OS security sandbox.
`);
}

const args = process.argv.slice(2);
const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const command = args[0] ?? (terminal ? "install" : undefined);

if (!command || args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

const getFlag = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};

// New command surfaces reject unknown or missing values instead of silently ignoring them.
function commandFlags(start, valueFlags, booleanFlags = []) {
  const values = {};
  for (let index = start; index < args.length; index++) {
    const flag = args[index];
    if (Object.hasOwn(values, flag)) throw new Error(`Duplicate option: ${flag}`);
    if (booleanFlags.includes(flag)) {
      values[flag] = true;
    } else if (valueFlags.includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
      values[flag] = value;
    } else {
      // Do not echo arbitrary arguments: a DSN must come from the environment or a file.
      throw new Error(/^--[a-z][a-z0-9-]*$/.test(flag) ? `Unknown option: ${flag}` : "Unknown option or unexpected positional argument.");
    }
  }
  return values;
}


async function readJsonFile(targetPath, fallback) {
  try {
    return JSON.parse(await readFile(targetPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeAtomic(targetPath, `${JSON.stringify(value, null, 2)}\n`, 0o644);
}

async function installObsidianAssets(packageRoot, vaultPath) {
  const vaultInfo = await stat(vaultPath).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`Vault not found at ${vaultPath}; run 'vault-cli init' first.`);
    throw error;
  });
  if (!vaultInfo.isDirectory()) throw new Error(`Vault path is not a directory: ${vaultPath}`);
  // The user explicitly selected this vault; bind its root before strict child-path checks.
  vaultPath = await realpath(vaultPath);

  const pluginSource = path.join(packageRoot, "integrations", "obsidian", "agent-vault-wiki");
  const pluginTarget = path.join(vaultPath, ".obsidian", "plugins", "agent-vault-wiki");
  const pluginMarker = "// agent-vault-managed: Agent Vault Wiki";
  const pluginStylesMarker = "/* agent-vault-managed: Agent Vault Wiki */";
  const mainTarget = path.join(pluginTarget, "main.js");
  const mainResult = await installManagedFile(path.join(pluginSource, "main.js"), mainTarget, pluginMarker);
  let pluginSafe = !mainResult.startsWith("preserved");
  if (pluginSafe) console.log(`[OK] Agent Vault Wiki ${mainResult}: ${mainTarget}`);
  else console.warn(`[WARN] ${mainTarget}: ${mainResult}; plugin files were preserved.`);

  if (pluginSafe) {
    for (const file of ["styles.css"]) {
      const target = path.join(pluginTarget, file);
      const result = await installManagedFile(path.join(pluginSource, file), target, pluginStylesMarker);
      if (result.startsWith("preserved")) {
        pluginSafe = false;
        console.warn(`[WARN] ${target}: ${result}.`);
      } else {
        console.log(`[OK] Agent Vault Wiki ${result}: ${target}`);
      }
    }
  }

  const obsoleteDataPath = path.join(pluginTarget, "data.cjs");
  try {
    const obsoleteData = await readFile(obsoleteDataPath, "utf8");
    if (obsoleteData.startsWith(pluginMarker)) await rm(obsoleteDataPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (pluginSafe) {
    const manifestTarget = path.join(pluginTarget, "manifest.json");
    const manifest = JSON.parse(await readFile(path.join(pluginSource, "manifest.json"), "utf8"));
    const existingManifest = await readJsonFile(manifestTarget, null);
    if (existingManifest && existingManifest.id !== manifest.id) {
      pluginSafe = false;
      console.warn(`[WARN] ${manifestTarget}: preserved manifest with a different plugin id.`);
    } else if (!existingManifest || JSON.stringify(existingManifest) !== JSON.stringify(manifest)) {
      await writeJsonFile(manifestTarget, manifest);
    }
  }

  const snippetSource = path.join(packageRoot, "integrations", "obsidian", "agent-vault-reading.css");
  const snippetTarget = path.join(vaultPath, ".obsidian", "snippets", "agent-vault-reading.css");
  const snippetResult = await installManagedFile(snippetSource, snippetTarget, "/* agent-vault-managed: agent-vault-reading */");
  if (snippetResult.startsWith("preserved")) console.warn(`[WARN] ${snippetTarget}: ${snippetResult}.`);
  else console.log(`[OK] Reading snippet ${snippetResult}: ${snippetTarget}`);

  for (const base of ["Projects.base", "Knowledge.base"]) {
    const source = path.join(packageRoot, "integrations", "obsidian", "bases", base);
    const target = path.join(vaultPath, "_wiki", "views", base);
    const result = await installManagedFile(source, target, "# agent-vault-managed: Agent Vault Bases");
    if (result.startsWith("preserved")) console.warn(`[WARN] ${target}: ${result}.`);
    else console.log(`[OK] Bases view ${result}: ${target}`);
  }

  const corePluginsPath = path.join(vaultPath, ".obsidian", "core-plugins.json");
  const corePlugins = await readJsonFile(corePluginsPath, {});
  if (!corePlugins || typeof corePlugins !== "object" || Array.isArray(corePlugins)) {
    throw new Error(`${corePluginsPath} must contain a JSON object.`);
  }
  if (corePlugins.bases !== true) {
    corePlugins.bases = true;
    await writeJsonFile(corePluginsPath, corePlugins);
  }

  if (!snippetResult.startsWith("preserved")) {
    const appearancePath = path.join(vaultPath, ".obsidian", "appearance.json");
    const appearance = await readJsonFile(appearancePath, {});
    if (!Array.isArray(appearance.enabledCssSnippets)) appearance.enabledCssSnippets = [];
    if (!appearance.enabledCssSnippets.includes("agent-vault-reading")) {
      appearance.enabledCssSnippets.push("agent-vault-reading");
      await writeJsonFile(appearancePath, appearance);
    }
  }

  if (pluginSafe) {
    const enabledPath = path.join(vaultPath, ".obsidian", "community-plugins.json");
    const enabled = await readJsonFile(enabledPath, []);
    if (!Array.isArray(enabled)) throw new Error(`${enabledPath} must contain a JSON array.`);
    if (!enabled.includes("agent-vault-wiki")) {
      enabled.push("agent-vault-wiki");
      await writeJsonFile(enabledPath, enabled);
    }
    console.log("[OK] Agent Vault Wiki enabled. Restart Obsidian to load it.");
  } else {
    console.warn("[WARN] Plugin activation skipped because existing plugin files were preserved.");
  }
}


const explicitPath = getFlag("--path");
const targetVaultPath = resolveVaultPath(explicitPath);

try {
  switch (command) {
    case "setup": {
      const flags = commandFlags(1, ["--mode", "--project", "--harness", "--path", "--title"], ["--json"]);
      const result = await setupVault(targetVaultPath, {
        mode: flags["--mode"], project: flags["--project"], harness: flags["--harness"],
        title: flags["--title"], cwd: process.cwd(),
      });
      console.log(flags["--json"] ? JSON.stringify(result, null, 2) : result.guide ?? JSON.stringify(result, null, 2));
      break;
    }

    case "config": {
      const flags = commandFlags(1, ["--mode", "--harness", "--path", "--team-url", "--team-file", "--team-id", "--token-env", "--review-thresholds", "--stale-days", "--markdown-months", "--timezone", "--workday-start", "--persona", "--persona-min-observations", "--recall", "--recall-limit", "--recall-max-chars", "--embedding", "--embedding-endpoint", "--embedding-model", "--db-driver", "--db-url-env", "--db-url-file", "--team-db-driver", "--team-db-url-env", "--team-db-url-file"], ["--read-only", "--team-off"]);
      const settings = await configureSettings(targetVaultPath, {
        mode: flags["--mode"], harness: flags["--harness"],
        teamUrl: flags["--team-url"], teamFile: flags["--team-file"], teamId: flags["--team-id"],
        teamDbDriver: flags["--team-db-driver"], teamDbUrlEnv: flags["--team-db-url-env"], teamDbUrlFile: flags["--team-db-url-file"],
        tokenEnv: flags["--token-env"], readOnly: flags["--read-only"], teamOff: flags["--team-off"],
        reviewThresholds: flags["--review-thresholds"], staleDays: flags["--stale-days"],
        markdownMonths: flags["--markdown-months"], timeZone: flags["--timezone"], workdayStart: flags["--workday-start"],
        persona: flags["--persona"], personaMinObservations: flags["--persona-min-observations"],
        recall: flags["--recall"], recallLimit: flags["--recall-limit"], recallMaxChars: flags["--recall-max-chars"],
        embedding: flags["--embedding"], embeddingEndpoint: flags["--embedding-endpoint"], embeddingModel: flags["--embedding-model"],
        dbDriver: flags["--db-driver"], dbUrlEnv: flags["--db-url-env"], dbUrlFile: flags["--db-url-file"],
      });
      if (flags["--team-file"]) console.error("[WARN] Team SQLite requires one host and a local filesystem; never use NFS or sync folders.");
      console.log(JSON.stringify(settings, null, 2));
      break;
    }

    case "memory": {
      const action = args[1];
      if (action === "migrate-db") {
        const flags = commandFlags(2, ["--path", "--from-sqlite"], ["--dry-run", "--team"]);
        const { migrateSqliteMemory } = await import("../lib/memory-db-migration.mjs");
        const source = flags["--from-sqlite"]?.replace(/^~(?=$|\/|\\)/, os.homedir());
        const report = await migrateSqliteMemory(targetVaultPath, { source, dryRun: flags["--dry-run"], team: flags["--team"] });
        console.log(JSON.stringify(report, null, 2));
        break;
      }
      if (!["maintain", "migrate", "history", "recall", "embed", "stats", "diagnose"].includes(action)) throw new Error("memory requires maintain, migrate, migrate-db, history, recall, embed, stats or diagnose.");
      const values = ["--project", "--path"];
      if (["maintain", "history", "recall"].includes(action)) values.push("--scope", "--role");
      if (action === "history") values.push("--from", "--to", "--week", "--kind", "--offset");
      if (action === "recall" || action === "history") values.push("--query", "--limit", "--mode", "--method", "--flags");
      if (action === "embed") values.push("--scope", "--limit");
      const flags = commandFlags(2, values, action === "migrate" ? ["--prune-legacy"] : []);
      if (flags["--scope"] && flags["--scope"] !== "global") throw new Error("--scope must be global; use --project for project memory.");
      if (flags["--project"] && flags["--scope"]) throw new Error("Choose --project or --scope global, not both.");
      if (action === "migrate" && !flags["--project"]) throw new Error("memory migrate requires --project.");
      const tiers = await import("../lib/memory-tiers.mjs");
      const options = { cwd: process.cwd(), project: flags["--project"], scope: flags["--scope"], role: flags["--role"], pruneLegacy: flags["--prune-legacy"] };
      const searchOptions = {
        query: flags["--query"], mode: flags["--mode"], method: flags["--method"], flags: flags["--flags"],
        limit: flags["--limit"] === undefined ? undefined : Number(flags["--limit"]),
      };
      let result;
      if (action === "history") {
        const { queryWeeklyMemory } = await import("../lib/weekly-memory.mjs");
        result = await queryWeeklyMemory(targetVaultPath, {
          ...options, ...searchOptions, from: flags["--from"], to: flags["--to"], week: flags["--week"], kind: flags["--kind"],
          offset: flags["--offset"] === undefined ? undefined : Number(flags["--offset"]),
        });
      } else if (action === "recall") {
        if (!flags["--query"]) throw new Error("memory recall requires --query.");
        result = await tiers.recallMemory(targetVaultPath, { ...options, ...searchOptions });
      } else if (action === "embed") {
        if (flags["--limit"] !== undefined && !/^\d+$/.test(flags["--limit"])) throw new Error("--limit must be an integer from 1 to 5000.");
        const { embedMemoryScope } = await import("../lib/similar-search.mjs");
        result = await embedMemoryScope(targetVaultPath, { ...options, limit: searchOptions.limit });
      } else if (action === "stats" || action === "diagnose") {
        const inspect = await import("../lib/memory-inspect.mjs");
        result = await (action === "stats" ? inspect.memoryStats : inspect.diagnoseMemory)(targetVaultPath, { cwd: process.cwd(), project: flags["--project"] });
      } else result = action === "maintain" ? await tiers.sleepMemory(targetVaultPath, options) : await tiers.migrateLongMemory(targetVaultPath, options);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "hooks": {
      const action = args[1];
      if (!["install", "status", "uninstall"].includes(action)) throw new Error("hooks requires install, status or uninstall.");
      const flags = commandFlags(2, ["--host", "--path"], ["--local", "--dry-run"]);
      const hooks = await import("../lib/hooks-install.mjs");
      if (!hooks.HOOK_HOST_IDS.includes(flags["--host"])) throw new Error(`--host must be one of ${hooks.HOOK_HOST_IDS.join(", ")}. OMP uses 'vault-cli install --global'.`);
      const options = { scope: flags["--local"] ? "local" : "global", cwd: process.cwd(), vaultPath: explicitPath ? path.resolve(explicitPath) : undefined, dryRun: flags["--dry-run"] };
      const result = await (action === "install" ? hooks.installHooks : action === "status" ? hooks.hooksStatus : hooks.uninstallHooks)(flags["--host"], options);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "tidy": {
      const flags = commandFlags(1, ["--path", "--limit", "--accept", "--merge", "--drop", "--fix-links", "--expect", "--undo"], ["--plan", "--apply", "--json", "--backups"]);
      const tidy = await import("../lib/vault-tidy.mjs");
      const show = (value, text) => console.log(flags["--json"] ? JSON.stringify(value, null, 2) : text);
      const editing = flags["--plan"] || flags["--apply"];
      const planOnly = ["--accept", "--merge", "--drop", "--fix-links"].filter((name) => flags[name] !== undefined);
      if (flags["--plan"] && flags["--apply"]) throw new Error("Choose --plan or --apply, not both.");
      if (planOnly.length && !editing) throw new Error(`${planOnly.join(", ")} need --plan or --apply.`);
      if (flags["--expect"] !== undefined && !flags["--apply"]) throw new Error("--expect only applies with --apply.");
      if ((flags["--undo"] !== undefined || flags["--backups"]) && (editing || planOnly.length)) throw new Error("--undo and --backups cannot be combined with --plan or --apply.");
      if (flags["--backups"]) {
        const backups = await tidy.listTidyBackups(targetVaultPath);
        show(backups, backups.length ? backups.map((item) => `${item.id}  ${item.files} notes${item.aliases ? " + aliases" : ""}  ${item.at ?? ""}`).join("\n") : "No tidy backups.");
        break;
      }
      if (flags["--undo"] !== undefined) {
        const result = await tidy.undoTidy(targetVaultPath, flags["--undo"]);
        show(result, [`Restored ${result.restored.length} notes; aliases ${result.aliases}.`, ...result.skipped.map((item) => `  left alone ${item.path}: ${item.reason}`)].join("\n"));
        break;
      }
      if (flags["--limit"] !== undefined && !/^(?:[1-9]\d?|100)$/.test(flags["--limit"])) throw new Error("--limit must be an integer from 1 to 100.");
      if (!editing) {
        const report = await tidy.auditVault(targetVaultPath, { limit: flags["--limit"] === undefined ? 25 : Number(flags["--limit"]) });
        await tidy.recordTidyAudit(targetVaultPath, report);
        show(report, tidy.renderTidyReport(report));
        break;
      }
      const csv = (value) => (value === undefined ? [] : value.split(",").map((item) => item.trim()).filter(Boolean));
      const options = {
        accept: flags["--accept"] === undefined ? ["spelling"] : flags["--accept"] === "none" ? [] : csv(flags["--accept"]),
        merge: csv(flags["--merge"]), drop: csv(flags["--drop"]), fixLinks: flags["--fix-links"] ?? "none",
      };
      const plan = await tidy.planTidy(targetVaultPath, options);
      const command = tidy.tidyApplyCommand(targetVaultPath, options, plan.id);
      if (flags["--plan"]) {
        show({ ...plan, applyCommand: command }, tidy.renderTidyPlan(plan, plan.edits.length || Object.keys(plan.aliases).length ? command : undefined));
        break;
      }
      if (flags["--expect"] !== undefined && flags["--expect"] !== plan.id) throw new Error(`The plan is now ${plan.id}, not ${flags["--expect"]}: notes or options changed. Run --plan again and review it.`);
      if (plan.edits.length === 0 && Object.keys(plan.aliases).length === 0) { show({ changed: [] }, "Nothing to change."); break; }
      const result = await tidy.applyTidy(targetVaultPath, plan);
      show(result, [
        result.id === null ? "Nothing to change." : `Changed ${result.changed.length} notes${result.aliasesRecorded ? `, recorded ${result.aliasesRecorded} tag aliases` : ""}.`,
        ...(result.id ? [`Backup ${result.id}. Undo with: vault-cli tidy --path '${path.resolve(targetVaultPath)}' --undo ${result.id}`] : []),
        ...result.refused.map((item) => `  refused ${item.path}: ${item.reason}`),
      ].join("\n"));
      break;
    }

    case "persona": {
      const flags = commandFlags(1, ["--project", "--scope", "--path"]);
      if (flags["--scope"] && flags["--scope"] !== "global") throw new Error("--scope must be global; use --project for a project persona.");
      if (flags["--project"] && flags["--scope"]) throw new Error("Choose --project or --scope global, not both.");
      const { readPersona } = await import("../lib/persona.mjs");
      const result = await readPersona(targetVaultPath, { scope: flags["--project"] ? "project" : "global", project: flags["--project"], cwd: process.cwd() });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "init": {
      console.log(`Initializing Obsidian LLM Wiki Vault at: ${targetVaultPath}`);
      const res = await initVault(targetVaultPath);
      const projectRoot = await gitTopLevel(process.cwd());
      console.log(`[OK] Vault initialized successfully: ${res.vaultPath}`);
      if (!projectRoot) {
        console.log("[INFO] Skipped project guidance: current directory is not inside a Git repository.");
      } else {
        for (const instructionPath of await configureProjectInstructions(projectRoot)) {
          console.log(`[OK] Agent Vault project guidance configured: ${instructionPath}`);
        }
      }
      break;
    }

    case "scaffold": {
      const projectId = getFlag("--project");
      const title = getFlag("--title");
      if (!projectId) {
        console.error("Error: --project <id> is required.");
        process.exit(2);
      }
      console.log(`Ensuring vault exists at: ${targetVaultPath}`);
      await initVault(targetVaultPath);
      console.log(`Scaffolding project '${projectId}'...`);
      const res = await scaffoldProject(targetVaultPath, projectId, title);
      console.log(`[OK] Project '${res.projectId}' scaffolded at: ${res.projectDir}`);
      break;
    }

    case "status": {
      const projectFilter = getFlag("--project");
      const res = await getVaultStatus(targetVaultPath, projectFilter);
      if (!res.ok) {
        console.log(`[WARN] Vault not found at: ${targetVaultPath}. Run 'vault-cli init' to create it.`);
        process.exit(1);
      }
      console.log(`Vault Path: ${res.vaultPath}`);
      console.log(`Obsidian Ready: ${res.isObsidianVault ? "YES (.obsidian/ present)" : "NO"}`);
      console.log(`Total Projects: ${res.projectsCount}`);
      if (res.memoryDatabaseError) console.warn(`[WARN] Memory database: ${res.memoryDatabaseError.message}`);
      if (res.projects.length > 0) {
        console.log("\nRegistered Projects:");
        for (const p of res.projects) {
          console.log(`  - [${p.id}] Specs: ${p.specsCount}, Agent Memories: ${p.agentMemoryCount}, Index: ${p.hasIndex ? "OK" : "Missing"}`);
        }
      }
      break;
    }

    case "migrate": {
      const fromWiki = getFlag("--from-wiki");
      const fromRepo = getFlag("--from-repo");
      const profileSource = getFlag("--profile-source");

      if (fromWiki) {
        const resolvedWiki = fromWiki.replace(/^~(?=$|\/|\\)/, os.homedir());
        console.log(`Migrating non-destructively from wiki: ${resolvedWiki}`);
        let res;
        if (profileSource) {
          res = await migrateFromWiki(resolvedWiki, targetVaultPath, { profileSource });
          await initVault(targetVaultPath);
        } else {
          await initVault(targetVaultPath);
          res = await migrateFromWiki(resolvedWiki, targetVaultPath);
        }
        console.log(`[OK] Migration completed:`);
        console.log(`  Profile notes migrated: ${res.profileMigrated}`);
        console.log(`  Projects migrated: ${res.projectsMigrated}`);
        console.log(`  Specs migrated: ${res.specsMigrated}`);
        for (const d of res.details) {
          console.log(`  + ${d}`);
        }
      } else if (fromRepo) {
        if (profileSource) throw new Error("--profile-source requires --from-wiki.");
        await initVault(targetVaultPath);
        const resolvedRepo = fromRepo.replace(/^~(?=$|\/|\\)/, os.homedir());
        const projectId = getFlag("--project") || path.basename(resolvedRepo);
        console.log(`Migrating non-destructively from repo: ${resolvedRepo} (project: ${projectId})`);
        const res = await migrateFromProjectRepo(resolvedRepo, targetVaultPath, projectId);
        console.log(`[OK] Project migration completed:`);
        console.log(`  OpenSpec specs migrated: ${res.specsMigrated}`);
        console.log(`  Memories migrated: ${res.memoriesMigrated}`);
        for (const d of res.details) {
          console.log(`  + ${d}`);
        }
      } else {
        console.error("Error: --from-wiki <path> or --from-repo <path> must be specified.");
        process.exit(2);
      }
      break;
    }

    case "install": {
      const flags = commandFlags(1, ["--agents", "--method", "--path"], ["--global", "--local", "--obsidian", "--interactive"]);
      const isLocal = Boolean(flags["--local"]);
      const isGlobal = Boolean(flags["--global"]);
      const isObsidian = Boolean(flags["--obsidian"]);
      const interactive = Boolean(flags["--interactive"] || (terminal && args.length <= 1));
      if ((isLocal && isGlobal) || (isObsidian && (isLocal || isGlobal))) {
        throw new Error("Choose one install scope: --global, --local or --obsidian.");
      }
      if (interactive && !terminal) throw new Error("--interactive requires an interactive terminal; no files were changed.");
      if (isObsidian && (interactive || flags["--agents"] || flags["--method"])) {
        throw new Error("--obsidian cannot be combined with --interactive, --agents or --method.");
      }
      const method = flags["--method"] ?? (interactive ? "symlink" : "copy");
      if (!["copy", "symlink"].includes(method)) throw new Error("--method must be copy or symlink.");
      const selected = flags["--agents"]?.split(",").map((id) => id.trim());
      const available = await getInstallTargets();
      for (const id of selected ?? []) {
        if (!available.some((target) => target.id === id)) throw new Error(`Unknown agent target: ${id || "(empty)"}`);
      }
      const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
      if (isObsidian) {
        await installObsidianAssets(packageRoot, targetVaultPath);
        break;
      }
      let plan = {
        scope: isLocal ? "local" : "global",
        method,
        targets: selected ?? (isLocal ? ["omp"] : ["omp", "universal"]),
      };
      if (interactive) {
        const { runInstallTui } = await import("../lib/install-tui.mjs");
        const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
        if (!flags["--method"]) plan.method = await recommendedInstallMethod(plan);
        plan = await runInstallTui({
          targets: available,
          initialScope: plan.scope,
          initialMethod: plan.method,
          defaultTargets: [...new Set(["universal", ...plan.targets])],
          skill: { name: "agent-vault", version: manifest.version, source: packageRoot },
          preview: (choice) => previewInstallAgents({ sourceDir: packageRoot, ...choice }),
        });
        if (!plan) {
          console.log("Installation cancelled. No files were changed.");
          break;
        }
        plan.targets = [...new Set(["universal", ...plan.targets])];
      }
      const result = await installAgents({ sourceDir: packageRoot, ...plan });
      for (const target of result.targets) {
        const scope = result.scope === "global" ? "globally" : "locally";
        if (target.status.startsWith("preserved")) console.warn(`[WARN] ${target.path}: ${target.status}.`);
        else console.log(`[OK] Installed agent-vault skill ${scope} to: ${target.path} (${target.status})`);
      }
      for (const integration of result.integrations) {
        if (integration.status.startsWith("preserved")) {
          console.warn(`[WARN] ${integration.path}: ${integration.status}; review and merge manually.`);
        } else console.log(`[OK] ${integration.label} ${integration.status}: ${integration.path}`);
      }
      for (const note of result.notes) console.log(`[INFO] ${note}`);
      break;
    }

    case "update": {
      const flags = commandFlags(1, ["--path", "--from", "--archive", "--ref", "--rollback", "--expect"], ["--local", "--dry-run", "--no-verify", "--allow-downgrade", "--allow-same-version", "--backups", "--json"]);
      const updater = await import("../lib/updater.mjs");
      const show = (value, text) => console.log(flags["--json"] ? JSON.stringify(value, null, 2) : text);
      const sourceFlags = ["--from", "--archive", "--ref", "--dry-run", "--no-verify", "--allow-downgrade", "--allow-same-version", "--expect"].filter((name) => flags[name] !== undefined);
      if ((flags["--backups"] || flags["--rollback"] !== undefined) && (sourceFlags.length || flags["--local"])) throw new Error(`--backups and --rollback cannot be combined with ${[...sourceFlags, ...(flags["--local"] ? ["--local"] : [])].join(", ")}.`);
      if (flags["--backups"] && flags["--rollback"] !== undefined) throw new Error("Choose --backups or --rollback, not both.");
      if (flags["--ref"] !== undefined && (flags["--from"] !== undefined || flags["--archive"] !== undefined)) throw new Error("--ref only applies to the GitHub download; it cannot be combined with --from or --archive.");
      if (flags["--expect"] !== undefined && (flags["--dry-run"] || !/^[0-9a-f]{12}$/.test(flags["--expect"]))) throw new Error("--expect takes the 12-character plan id printed by --dry-run, and only applies when updating.");
      if (flags["--backups"]) {
        const backups = await updater.listUpdateBackups();
        show(backups.map(({ manifest, ...item }) => item), backups.length ? backups.map((item) => `${item.id}  ${Object.entries(item.from).map(([id, version]) => `${id} ${version ?? "?"}`).join(", ")} -> ${item.to}${item.rolledBack ? "  (rolled back)" : ""}`).join("\n") : "No update backups.");
        break;
      }
      if (flags["--rollback"] !== undefined) {
        const result = await updater.rollbackUpdate({ id: flags["--rollback"] });
        show(result, [
          `Rolled back update ${result.id}: ${result.from} -> ${Object.values(result.to).join(", ")}.`,
          ...result.restored.map((item) => `  restored ${item}`),
          ...result.skipped.map((item) => `  [WARN] left ${item.path}: ${item.reason}`),
          "[INFO] Restart OMP and any other host that launched Agent Vault.",
        ].join("\n"));
        break;
      }
      const result = await updater.runUpdate({
        from: flags["--from"], archive: flags["--archive"], ref: flags["--ref"],
        scope: flags["--local"] ? "local" : "global", dryRun: Boolean(flags["--dry-run"]), expect: flags["--expect"],
        verify: !flags["--no-verify"], allowDowngrade: Boolean(flags["--allow-downgrade"]), allowSameVersion: Boolean(flags["--allow-same-version"]), vault: targetVaultPath,
      });
      show(result, updater.renderUpdate(result, { dryRun: Boolean(flags["--dry-run"]), source: { from: flags["--from"], archive: flags["--archive"], ref: flags["--ref"], scope: flags["--local"] ? "local" : "global", allowDowngrade: Boolean(flags["--allow-downgrade"]), allowSameVersion: Boolean(flags["--allow-same-version"]) } }));
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(2);
  }
} catch (err) {
  console.error(`[FAIL] ${err.message}`);
  process.exit(1);
}
