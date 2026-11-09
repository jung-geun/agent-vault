import fs from "node:fs";
import { mkdir, readFile, writeFile, stat, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export function resolveVaultPath(explicitPath) {
  if (explicitPath) {
    return path.resolve(explicitPath.replace(/^~(?=$|\/|\\)/, os.homedir()));
  }

  if (process.env.OMP_VAULT_PATH) {
    return path.resolve(process.env.OMP_VAULT_PATH.replace(/^~(?=$|\/|\\)/, os.homedir()));
  }

  // Check current working directory for local .vaultrc or .omp/vault.json
  const localVaultrc = path.resolve(process.cwd(), ".vaultrc");
  if (fs.existsSync(localVaultrc)) {
    try {
      const content = fs.readFileSync(localVaultrc, "utf8").trim();
      if (content) return path.resolve(content.replace(/^~(?=$|\/|\\)/, os.homedir()));
    } catch {}
  }

  const localOmpVault = path.resolve(process.cwd(), ".omp/vault.json");
  if (fs.existsSync(localOmpVault)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(localOmpVault, "utf8"));
      if (parsed.vaultPath) return path.resolve(parsed.vaultPath.replace(/^~(?=$|\/|\\)/, os.homedir()));
    } catch {}
  }

  // Check user home for ~/.vaultrc
  const homeVaultrc = path.resolve(os.homedir(), ".vaultrc");
  if (fs.existsSync(homeVaultrc)) {
    try {
      const content = fs.readFileSync(homeVaultrc, "utf8").trim();
      if (content) return path.resolve(content.replace(/^~(?=$|\/|\\)/, os.homedir()));
    } catch {}
  }

  // Default fallback
  return path.resolve(os.homedir(), ".vault");
}

export async function initVault(vaultPath) {
  await mkdir(vaultPath, { recursive: true });

  // 1. Obsidian App configuration
  const obsidianDir = path.join(vaultPath, ".obsidian");
  await mkdir(obsidianDir, { recursive: true });
  const appJsonPath = path.join(obsidianDir, "app.json");
  if (!fs.existsSync(appJsonPath)) {
    await writeFile(
      appJsonPath,
      JSON.stringify(
        {
          useMarkdownLinks: false,
          newFileLocation: "current",
          attachmentFolderPath: "shared/attachments",
          alwaysUpdateLinks: true,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }

  // 2. _meta directory
  const metaDir = path.join(vaultPath, "_meta");
  await mkdir(metaDir, { recursive: true });

  const configPath = path.join(metaDir, "config.json");
  if (!fs.existsSync(configPath)) {
    await writeFile(
      configPath,
      JSON.stringify(
        {
          vaultVersion: "1.0.0",
          name: "Agent LLM Wiki Vault",
          initializedAt: new Date().toISOString(),
          defaultLanguage: "ko",
          authorityModel: "normative-derived-evidence-historical",
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }

  const schemaPath = path.join(metaDir, "SCHEMA.md");
  if (!fs.existsSync(schemaPath)) {
    await writeFile(
      schemaPath,
      `---
id: meta-schema
title: Vault Metadata Schema & Governance
type: spec
status: active
summary: Standard schema v2, authority levels, and link conventions for this Obsidian LLM Wiki.
created: ${new Date().toISOString().slice(0, 10)}
updated: ${new Date().toISOString().slice(0, 10)}
tags: [schema, governance, llm-wiki]
sources: []
confidence: high
reviewed_at: ${new Date().toISOString().slice(0, 10)}
authority: normative
---

# Vault Metadata Schema & Governance

## 1. Authority Hierarchy

1. **Normative** (\`authority: normative\`): Active specifications (\`specs/\`) and approved decisions.
2. **Derived** (\`authority: derived\`): Synthesized concept notes, agent memories, and project indices.
3. **Evidence** (\`authority: evidence\`): Raw capture logs, dated session notes, test outputs, and handoffs.
4. **Historical** (\`authority: historical\`): Archived changes (\`changes/archive/\`) and superseded documents.

## 2. Canonical Frontmatter Sequence

Every durable note MUST maintain YAML frontmatter with this exact key sequence:

\`\`\`yaml
---
id: <kebab-id>
title: <Title Text>
type: spec | project | concept | decision | source | report | index | template
status: active | draft | contested | superseded | archived
summary: <One concise sentence>
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [<tags...>]
sources: []
confidence: high | medium | low
reviewed_at: YYYY-MM-DD
authority: normative | derived | evidence | historical
---
\`\`\`

## 3. Link Conventions

- Use Obsidian wikilinks: \`[[projects/<project-id>/specs/<spec-file>|Display Text]]\`.
- Use vault-relative paths. Never write machine-specific absolute file paths in notes.
`,
      "utf8"
    );
  }

  // 3. user directory
  const userDir = path.join(vaultPath, "user");
  await mkdir(userDir, { recursive: true });

  const profilePath = path.join(userDir, "profile.md");
  if (!fs.existsSync(profilePath)) {
    await writeFile(
      profilePath,
      `---
id: user-profile
title: User Profile & Interaction Preferences
type: concept
status: active
summary: Core user preferences, working habits, and engineering principles.
created: ${new Date().toISOString().slice(0, 10)}
updated: ${new Date().toISOString().slice(0, 10)}
tags: [user, profile, preferences]
sources: []
confidence: high
reviewed_at: ${new Date().toISOString().slice(0, 10)}
authority: derived
---

# User Profile & Interaction Preferences

## Interaction Preferences

## Work Context

## Privacy & Retention Preferences
`,
      "utf8"
    );
  }

  const codingStandardsPath = path.join(userDir, "coding-standards.md");
  if (!fs.existsSync(codingStandardsPath)) {
    await writeFile(
      codingStandardsPath,
      `---
id: user-coding-standards
title: User Coding Standards & Invariants
type: concept
status: active
summary: Language standards, architectural preferences, and testing rules.
created: ${new Date().toISOString().slice(0, 10)}
updated: ${new Date().toISOString().slice(0, 10)}
tags: [user, coding-standards, rules]
sources: []
confidence: high
reviewed_at: ${new Date().toISOString().slice(0, 10)}
authority: normative
---

# User Coding Standards & Invariants

## Engineering Principles
- Prefer correctness, maintainability, and explicit tradeoffs.
- Do not claim tests or deployments ran unless this session observed them.

## Preferred Languages & Toolchains

## Testing & Verification Expectations

## Repository Boundaries
`,
      "utf8"
    );
  }

  // 4. shared/templates directory
  const templatesDir = path.join(vaultPath, "shared", "templates");
  await mkdir(templatesDir, { recursive: true });

  const projectTemplatePath = path.join(templatesDir, "project.md");
  if (!fs.existsSync(projectTemplatePath)) {
    await writeFile(
      projectTemplatePath,
      `---
id: template-project
title: Project Index Template
type: template
status: active
summary: Standard layout and dashboard for project-scoped knowledge.
created: ${new Date().toISOString().slice(0, 10)}
updated: ${new Date().toISOString().slice(0, 10)}
tags: [template, project]
sources: []
confidence: high
reviewed_at: ${new Date().toISOString().slice(0, 10)}
authority: derived
---

# <Project Title> — Project Memory

## Summary & Objectives

## Architecture & Specs
- [[projects/<project-id>/specs/spec-system-architecture|System Architecture]]

## Agent Memories
- Coordinator: [[projects/<project-id>/agents/coordinator/memory|Coordinator Memory]]
- Builder: [[projects/<project-id>/agents/builder/memory|Builder Memory]]
- Investigator: [[projects/<project-id>/agents/investigator/memory|Investigator Memory]]
- Reviewer: [[projects/<project-id>/agents/reviewer/memory|Reviewer Memory]]

## Handoffs & Activity Logs
- [[projects/<project-id>/agents/handoffs/README|Handoffs Registry]]
`,
      "utf8"
    );
  }

  // 5. projects directory
  await mkdir(path.join(vaultPath, "projects"), { recursive: true });

  // 6. Root README
  const rootReadmePath = path.join(vaultPath, "README.md");
  if (!fs.existsSync(rootReadmePath)) {
    await writeFile(
      rootReadmePath,
      `---
id: vault-root-readme
title: Agent LLM Wiki Vault Dashboard
type: index
status: active
summary: Unified cross-project knowledge base and persistent AI agent memory vault.
created: ${new Date().toISOString().slice(0, 10)}
updated: ${new Date().toISOString().slice(0, 10)}
tags: [vault, root, dashboard]
sources: []
confidence: high
reviewed_at: ${new Date().toISOString().slice(0, 10)}
authority: derived
---

# Agent LLM Wiki Vault Dashboard

Welcome to the central Obsidian LLM Wiki and persistent memory vault for OMP and autonomous AI agents.

## Navigation Hub

| Section | Description | Path |
|---|---|---|
| **User Profile** | Global preferences, engineering style | [[user/profile|User Profile]] |
| **Coding Standards** | Language rules, invariants, and guidelines | [[user/coding-standards|Coding Standards]] |
| **Schema & Rules** | Frontmatter specs and authority levels | [[_meta/SCHEMA|Schema v2]] |
| **Shared Templates** | Project, spec, change, and agent memory templates | \`shared/templates/\` |
| **Projects** | Isolated namespaces for active and archived projects | \`projects/\` |
`,
      "utf8"
    );
  }

  return { ok: true, vaultPath };
}

export async function scaffoldProject(vaultPath, projectId, title) {
  if (!projectId || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(projectId)) {
    throw new Error(`Invalid project ID '${projectId}'. Must be kebab-case (e.g. 'omp-core', 'my-project').`);
  }

  const projTitle = title || projectId;
  const today = new Date().toISOString().slice(0, 10);
  const projDir = path.join(vaultPath, "projects", projectId);
  await mkdir(projDir, { recursive: true });

  // Subdirectories
  await mkdir(path.join(projDir, "specs"), { recursive: true });
  await mkdir(path.join(projDir, "changes", "archive"), { recursive: true });
  await mkdir(path.join(projDir, "wiki", "concepts"), { recursive: true });
  await mkdir(path.join(projDir, "wiki", "decisions"), { recursive: true });
  await mkdir(path.join(projDir, "logs"), { recursive: true });
  await mkdir(path.join(projDir, "agents", "coordinator"), { recursive: true });
  await mkdir(path.join(projDir, "agents", "builder"), { recursive: true });
  await mkdir(path.join(projDir, "agents", "investigator"), { recursive: true });
  await mkdir(path.join(projDir, "agents", "reviewer"), { recursive: true });
  await mkdir(path.join(projDir, "agents", "handoffs"), { recursive: true });

  const files = [
    {
      filePath: path.join(projDir, "index.md"),
      content: `---
id: project-${projectId}
title: ${projTitle} Project Memory
type: project
status: active
summary: Living LLM wiki, OpenSpec specs, and agent memory root for ${projTitle}.
created: ${today}
updated: ${today}
tags: [project, ${projectId}, shared-memory]
sources: ["[[_meta/SCHEMA]]", "[[user/coding-standards]]"]
confidence: high
reviewed_at: ${today}
authority: derived
---

# ${projTitle} — Project Memory

Entry point and unified memory space for **${projTitle}**.

## 1. Directory Structure & Boundaries

- All project modifications MUST be scoped inside \`projects/${projectId}/\`.
- System architecture changes must use OpenSpec changes under \`changes/\`.

| Layer | Path | Description |
|---|---|---|
| Living Specs | [[projects/${projectId}/specs/spec-system-architecture|System Architecture]] | Normative capability specs |
| Changes | \`projects/${projectId}/changes/\` | Active & archived OpenSpec changes |
| Wiki | \`projects/${projectId}/wiki/\` | Distilled concepts and decisions |
| Logs | \`projects/${projectId}/logs/\` | Work session logs and milestone traces |
| Agent Memories | \`projects/${projectId}/agents/\` | Scoped memories for agent roles |
| Handoffs | [[projects/${projectId}/agents/handoffs/README|Handoffs]] | Task transfer records |

## 2. Agent Memories

- Coordinator: [[projects/${projectId}/agents/coordinator/memory|Coordinator Memory]]
- Builder: [[projects/${projectId}/agents/builder/memory|Builder Memory]]
- Investigator: [[projects/${projectId}/agents/investigator/memory|Investigator Memory]]
- Reviewer: [[projects/${projectId}/agents/reviewer/memory|Reviewer Memory]]

## Related

- [[user/coding-standards]]
- [[README]]
`,
    },
    {
      filePath: path.join(projDir, "specs", "spec-system-architecture.md"),
      content: `---
id: spec-${projectId}-system-architecture
title: ${projTitle} System Architecture Specification
type: spec
status: draft
summary: Initial OpenSpec location for ${projTitle}; no project-specific requirements have been verified or recorded yet.
created: ${today}
updated: ${today}
tags: [spec, ${projectId}, architecture, openspec]
sources: []
confidence: low
reviewed_at: ${today}
authority: derived
---

# ${projTitle} — System Architecture Specification

## Purpose

This note marks the starting location for project-specific architecture requirements. It contains no verified system behavior.

## Requirements

No normative requirements have been recorded. Establish requirements from repository evidence and reviewed change proposals before treating this note as authoritative.

## Related

- [[projects/${projectId}/index]]
`,
    },
    {
      filePath: path.join(projDir, "agents", "coordinator", "memory.md"),
      content: `---
id: memory-${projectId}-coordinator
title: ${projTitle} - Coordinator Agent Memory
type: concept
status: active
summary: Scoped durable memory and execution tracking for coordinator agent in ${projTitle}.
created: ${today}
updated: ${today}
tags: [agent-memory, ${projectId}, coordinator]
sources: ["[[projects/${projectId}/index]]"]
confidence: high
reviewed_at: ${today}
authority: derived
---

# ${projTitle} — Coordinator Agent Memory

## Focus & Scope
- High-level task planning and phase decomposition.
- Validation against [[projects/${projectId}/specs/spec-system-architecture]].
- Task handoffs to builder and investigator agents.

## Operational Heuristics
- Check existing dependencies before triggering build steps.
- Maintain handoff logs in \`projects/${projectId}/agents/handoffs/\`.

## Related
- [[projects/${projectId}/index]]
`,
    },
    {
      filePath: path.join(projDir, "agents", "builder", "memory.md"),
      content: `---
id: memory-${projectId}-builder
title: ${projTitle} - Builder Agent Memory
type: concept
status: active
summary: Scoped durable memory, compiler invariants, and build rules for builder agent in ${projTitle}.
created: ${today}
updated: ${today}
tags: [agent-memory, ${projectId}, builder]
sources: ["[[projects/${projectId}/index]]"]
confidence: high
reviewed_at: ${today}
authority: derived
---

# ${projTitle} — Builder Agent Memory

## Build & Test Invariants
- Follow [[user/coding-standards]].
- Verify all modified paths with tests before yielding completion.

## Discovered Gotchas & Path Anchors
- Record verified edge cases and build anomalies here.

## Related
- [[projects/${projectId}/index]]
`,
    },
    {
      filePath: path.join(projDir, "agents", "investigator", "memory.md"),
      content: `---
id: memory-${projectId}-investigator
title: ${projTitle} - Investigator Agent Memory
type: concept
status: active
summary: Scoped durable memory and diagnostic findings for investigator agent in ${projTitle}.
created: ${today}
updated: ${today}
tags: [agent-memory, ${projectId}, investigator]
sources: ["[[projects/${projectId}/index]]"]
confidence: high
reviewed_at: ${today}
authority: derived
---

# ${projTitle} — Investigator Agent Memory

## Diagnostic Strategies
- Locate exact files and symbols using AST and structured search tools.
- Record proven reproduction steps before suggesting fixes.

## Known Subsystems
- Document tricky dependencies and runtime behaviors here.

## Related
- [[projects/${projectId}/index]]
`,
    },
    {
      filePath: path.join(projDir, "agents", "reviewer", "memory.md"),
      content: `---
id: memory-${projectId}-reviewer
title: ${projTitle} - Reviewer Agent Memory
type: concept
status: active
summary: Scoped durable memory, review criteria, and safety checks for reviewer agent in ${projTitle}.
created: ${today}
updated: ${today}
tags: [agent-memory, ${projectId}, reviewer]
sources: ["[[projects/${projectId}/index]]"]
confidence: high
reviewed_at: ${today}
authority: derived
---

# ${projTitle} — Reviewer Agent Memory

## Review Invariants
- Check consistency, scope minimality, and test verification.
- Enforce schema adherence for all documentation changes.

## Related
- [[projects/${projectId}/index]]
`,
    },
    {
      filePath: path.join(projDir, "agents", "handoffs", "README.md"),
      content: `---
id: handoffs-${projectId}-registry
title: ${projTitle} Agent Handoffs Registry
type: index
status: active
summary: Registry of epistemic state transfers and task handoffs in ${projTitle}.
created: ${today}
updated: ${today}
tags: [handoffs, ${projectId}, agents]
sources: ["[[projects/${projectId}/index]]"]
confidence: high
reviewed_at: ${today}
authority: derived
---

# ${projTitle} — Agent Handoffs Registry

Append-only task transfers between agents operating in ${projTitle}.

## File Naming Standard
\`projects/${projectId}/agents/handoffs/YYYY-MM-DD-task-<task-slug>.md\`
`,
    },
  ];

  for (const f of files) {
    if (!fs.existsSync(f.filePath)) {
      await writeFile(f.filePath, f.content, "utf8");
    }
  }

  return { ok: true, projectId, projectDir: projDir };
}

export async function getVaultStatus(vaultPath, projectFilter) {
  if (!fs.existsSync(vaultPath)) {
    return { ok: false, error: "vault-not-found", vaultPath };
  }

  const projectsDir = path.join(vaultPath, "projects");
  const projects = [];

  if (fs.existsSync(projectsDir)) {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        if (projectFilter && entry.name !== projectFilter) continue;

        const pDir = path.join(projectsDir, entry.name);
        const hasIndex = fs.existsSync(path.join(pDir, "index.md"));
        const hasSpecs = fs.existsSync(path.join(pDir, "specs"));
        const specsCount = hasSpecs ? (await readdir(path.join(pDir, "specs"))).filter((f) => f.endsWith(".md")).length : 0;
        const hasAgents = fs.existsSync(path.join(pDir, "agents"));
        let agentMemoryCount = 0;
        if (hasAgents) {
          const agentRoles = await readdir(path.join(pDir, "agents"), { withFileTypes: true });
          for (const role of agentRoles) {
            if (role.isDirectory() && role.name !== "handoffs") {
              if (fs.existsSync(path.join(pDir, "agents", role.name, "memory.md"))) {
                agentMemoryCount++;
              }
            }
          }
        }

        projects.push({
          id: entry.name,
          hasIndex,
          specsCount,
          agentMemoryCount,
        });
      }
    }
  }

  return {
    ok: true,
    vaultPath,
    isObsidianVault: fs.existsSync(path.join(vaultPath, ".obsidian")),
    projectsCount: projects.length,
    projects,
  };
}
