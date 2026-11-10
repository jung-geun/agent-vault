#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, cp, readFile, writeFile, lstat, rename, stat } from "node:fs/promises";
import { resolveVaultPath, initVault, scaffoldProject, getVaultStatus } from "../lib/vault-core.mjs";
import { migrateFromWiki, migrateFromProjectRepo } from "../lib/migration.mjs";

function printUsage() {
  console.log(`
Agent LLM Wiki Vault CLI (agent-vault)

Usage:
  vault-cli init [--path <path>]
  vault-cli scaffold --project <id> [--title <title>] [--path <path>]
  vault-cli status [--project <id>] [--path <path>]
  vault-cli migrate --from-wiki <path> [--profile-source <relative-file>] [--path <path>]
  vault-cli migrate --from-repo <path> [--project <id>] [--path <path>]
  vault-cli install [--global | --local]

Options:
  --path <path>            Target Obsidian vault path (default: ~/.vault)
  --project <id>           Project kebab-case identifier (e.g. 'my-project')
  --title <title>          Human-readable project title
  --from-wiki <path>       Path to existing Obsidian-compatible wiki
  --profile-source <path>  Optional profile file relative to --from-wiki
  --from-repo <path>       Project repo containing OpenSpec or memory
  --global                 Install user skill and non-destructive OMP rule
  --local                  Install skill to ./.omp/skills/agent-vault
`);
}

const args = process.argv.slice(2);
const command = args[0];

if (!command || args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

const getFlag = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};

// SHA-256 of rule files shipped before the tool-based rule. Only these copies are upgraded in place.
const LEGACY_RULE_SHA256 = new Set([
  "99420e12daa5a61c72ae963495ce3f9084f680489020a64f51f78b6b70f23e19", // direct-file rule
  "2e1eb64d07bddc2434a2e2da6a6117907cb71fc09444bf485ba2a0261d4e80d4", // tool rule before memory tiers
]);
const MCP_SERVER_NAME = "agent-vault";

async function writeAtomic(targetPath, data, mode) {
  const temp = `${targetPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, data, { mode });
  await rename(temp, targetPath);
}

async function installRule(sourcePath, targetPath) {
  const source = await readFile(sourcePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  let existing;
  try {
    const destinationStat = await lstat(targetPath);
    if (!destinationStat.isFile()) return "preserved non-regular destination";
    existing = await readFile(targetPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing === undefined) {
    await writeFile(targetPath, source, { flag: "wx" });
    return "installed";
  }
  if (existing.equals(source)) return "already current";
  if (LEGACY_RULE_SHA256.has(createHash("sha256").update(existing).digest("hex"))) {
    await writeAtomic(targetPath, source, 0o644);
    return "updated from legacy version";
  }
  return "preserved existing file with different content";
}

// Adds the agent-vault MCP entry to the OMP user MCP config. Other servers and keys are kept as-is.
async function registerMcpServer(configPath, entry) {
  let config = { mcpServers: {} };
  let mode = 0o600;
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (raw !== undefined) {
    try {
      config = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${configPath} is not valid JSON (${error.message}); fix it before installing the MCP server.`);
    }
    mode = (await stat(configPath)).mode & 0o777;
  }
  config.mcpServers ??= {};
  const current = config.mcpServers[MCP_SERVER_NAME];
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(entry)) return "already current";
  // An entry whose server path is our installed copy is ours: refresh it (for example after a Node upgrade).
  const ownedByUs = Array.isArray(current?.args) && String(current.args[0]).replaceAll("\\", "/").endsWith("skills/agent-vault/bin/vault-mcp.mjs");
  if (current !== undefined && !ownedByUs) return "preserved existing entry that differs";
  config.mcpServers[MCP_SERVER_NAME] = entry;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`, mode);
  return current === undefined ? "registered" : "updated";
}

async function installSkillFiles(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  for (const entry of ["SKILL.md", "package.json", "bin", "lib", "integrations"]) {
    await cp(path.join(sourceDir, entry), path.join(targetDir, entry), { recursive: true });
  }
}

const explicitPath = getFlag("--path");
const targetVaultPath = resolveVaultPath(explicitPath);

try {
  switch (command) {
    case "init": {
      console.log(`Initializing Obsidian LLM Wiki Vault at: ${targetVaultPath}`);
      const res = await initVault(targetVaultPath);
      console.log(`[OK] Vault initialized successfully: ${res.vaultPath}`);
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
      const isLocal = args.includes("--local");
      const isGlobal = args.includes("--global");
      if (isLocal && isGlobal) throw new Error("Choose only one install scope: --global or --local.");
      const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

      if (isLocal) {
        const targetDir = path.resolve(process.cwd(), ".omp/skills/agent-vault");
        if (targetDir !== packageRoot) await installSkillFiles(packageRoot, targetDir);
        console.log(`[OK] Installed agent-vault skill locally to: ${targetDir}`);
      } else {
        const targetDirs = [
          path.resolve(os.homedir(), ".omp/agent/skills/agent-vault"),
          path.resolve(os.homedir(), ".agents/skills/agent-vault"),
        ];
        for (const targetDir of targetDirs) {
          if (targetDir !== packageRoot) await installSkillFiles(packageRoot, targetDir);
          console.log(`[OK] Installed agent-vault skill globally to: ${targetDir}`);
        }

        const ruleSource = path.join(packageRoot, "integrations", "omp", "agent-vault.rule.md");
        const ruleTarget = path.resolve(os.homedir(), ".agents/rules/agent-vault.md");
        const ruleResult = await installRule(ruleSource, ruleTarget);
        if (ruleResult.startsWith("preserved")) {
          console.warn(`[WARN] ${ruleTarget}: ${ruleResult}; review and merge manually.`);
        } else {
          console.log(`[OK] OMP user rule ${ruleResult}: ${ruleTarget}`);
        }

        const serverPath = path.resolve(os.homedir(), ".omp/agent/skills/agent-vault/bin/vault-mcp.mjs");
        const mcpConfig = path.resolve(os.homedir(), ".omp/agent/mcp.json");
        const mcpResult = await registerMcpServer(mcpConfig, {
          type: "stdio",
          command: "node",
          args: [serverPath],
          enabled: true,
        });
        if (mcpResult.startsWith("preserved")) {
          console.warn(`[WARN] ${mcpConfig}: ${MCP_SERVER_NAME} ${mcpResult}; review and merge manually.`);
        } else {
          console.log(`[OK] MCP server ${MCP_SERVER_NAME} ${mcpResult}: ${mcpConfig}`);
        }
      }
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
