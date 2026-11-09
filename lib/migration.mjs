import fs from "node:fs";
import { mkdir, readFile, writeFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { scaffoldProject } from "./vault-core.mjs";

export async function migrateFromWiki(wikiPath, vaultPath, { profileSource } = {}) {
  const summary = {
    source: wikiPath,
    target: vaultPath,
    profileMigrated: 0,
    specsMigrated: 0,
    projectsMigrated: 0,
    details: [],
    conflicts: [],
  };
  const importFile = async (type, source, target, content, label) => {
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(target, content, { encoding: "utf8", flag: "wx" });
      summary.details.push(`Migrated ${label} -> ${target}`);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readFile(target, "utf8");
      if (existing === content) {
        summary.details.push(`Already present: ${target}`);
      } else {
        summary.conflicts.push({ type, source, target });
        summary.details.push(`Conflict: ${source} differs from existing ${target}; preserved destination and source`);
      }
      return false;
    }
  };

  if (!fs.existsSync(wikiPath)) {
    throw new Error(`Source wiki path not found: ${wikiPath}`);
  }

  if (profileSource) {
    if (path.isAbsolute(profileSource)) {
      throw new Error("Profile source must be a relative path inside the source wiki.");
    }
    const wikiRoot = await realpath(wikiPath);
    const candidatePath = path.resolve(wikiRoot, profileSource);
    const candidateRelative = path.relative(wikiRoot, candidatePath);
    if (candidateRelative === ".." || candidateRelative.startsWith(`..${path.sep}`) || path.isAbsolute(candidateRelative)) {
      throw new Error("Profile source must stay inside the source wiki.");
    }
    const sourceProfilePath = await realpath(candidatePath);
    const sourceRelativePath = path.relative(wikiRoot, sourceProfilePath);
    if (sourceRelativePath === ".." || sourceRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(sourceRelativePath)) {
      throw new Error("Profile source must stay inside the source wiki.");
    }
    if (!(await stat(sourceProfilePath)).isFile()) {
      throw new Error("Profile source must be a regular file.");
    }

    const sourceRelative = sourceRelativePath.split(path.sep).join("/");
    const content = await readFile(sourceProfilePath, "utf8");
    const today = new Date().toISOString().slice(0, 10);
    const updatedContent = `---
id: user-profile
title: User Profile & Interaction Preferences
type: concept
status: active
summary: User preferences migrated from an explicitly selected source note.
created: ${today}
updated: ${today}
tags: [user, profile, preferences]
sources: ${JSON.stringify([sourceRelative])}
confidence: high
reviewed_at: ${today}
authority: derived
---

# User Profile & Interaction Preferences

*Migrated non-destructively from \`${sourceRelative}\` in the source wiki.*

${content.replace(/^---[\s\S]*?---\s*/, "")}
`;
    if (await importFile("user-profile", sourceProfilePath, path.join(vaultPath, "user", "profile.md"), updatedContent, `profile ${sourceRelative}`)) {
      summary.profileMigrated++;
    }
  }


  // 2. Migrate existing projects under projects/
  const projectsDir = path.join(wikiPath, "projects");
  if (fs.existsSync(projectsDir)) {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith(".")) {
        const pSlug = entry.name.replace(/\.md$/, "");
        // Remove a YYYY-MM-DD prefix from dated project filenames.
        const cleanSlug = pSlug.replace(/^\d{4}-\d{2}-\d{2}-/, "");

        await scaffoldProject(vaultPath, cleanSlug, cleanSlug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "));

        const rawContent = await readFile(path.join(projectsDir, entry.name), "utf8");
        const bodyContent = rawContent.replace(/^---[\s\S]*?---\s*/, "");

        const targetOverviewPath = path.join(vaultPath, "projects", cleanSlug, "wiki", "concepts", `${cleanSlug}-overview.md`);
        const today = new Date().toISOString().slice(0, 10);
        const overviewContent = `---
id: concept-${cleanSlug}-overview
title: ${cleanSlug} Historical Context
type: concept
status: active
summary: Historical project context migrated non-destructively from prior knowledge base.
created: ${today}
updated: ${today}
tags: [migrated, ${cleanSlug}, context]
sources: []
confidence: high
reviewed_at: ${today}
authority: derived
---

# ${cleanSlug} — Historical Context

${bodyContent}
`;
        const created = await importFile(
          "project-overview",
          path.join(projectsDir, entry.name),
          targetOverviewPath,
          overviewContent,
          `project ${entry.name}`
        );
        if (created) summary.projectsMigrated++;
      }
    }
  }

  // 3. Migrate core normative OpenSpec specs into shared/knowledge/
  const specsDir = path.join(wikiPath, "openspec", "specs");
  if (fs.existsSync(specsDir)) {
    const specEntries = await readdir(specsDir, { withFileTypes: true });
    const sharedSpecsDir = path.join(vaultPath, "shared", "knowledge", "specs");
    await mkdir(sharedSpecsDir, { recursive: true });

    for (const entry of specEntries) {
      if (entry.isDirectory()) {
        const specFile = path.join(specsDir, entry.name, "spec.md");
        if (fs.existsSync(specFile)) {
          const content = await readFile(specFile, "utf8");
          const targetFile = path.join(sharedSpecsDir, `${entry.name}-spec.md`);
          const imported = await importFile(
            "spec",
            specFile,
            targetFile,
            content,
            `spec ${entry.name}/spec.md`
          );
          if (imported) summary.specsMigrated++;
        }
      }
    }
  }

  return summary;
}

export async function migrateFromProjectRepo(repoPath, vaultPath, projectId) {
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repository path not found: ${repoPath}`);
  }

  const pId = projectId || path.basename(repoPath);
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(pId)) {
    throw new Error(`Invalid project ID '${pId}'. Must be kebab-case (e.g. 'omp-core', 'my-project').`);
  }
  const projectDir = path.join(vaultPath, "projects", pId);
  const directories = [
    "specs", "changes/archive", "wiki/concepts", "wiki/decisions", "logs",
    "agents/coordinator", "agents/builder", "agents/investigator",
    "agents/reviewer", "agents/handoffs",
  ];
  await Promise.all(directories.map((dir) => mkdir(path.join(projectDir, dir), { recursive: true })));
  const createIfMissing = async (file, content) => {
    try {
      await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  };
  const today = new Date().toISOString().slice(0, 10);
  await createIfMissing(path.join(projectDir, "index.md"), `---
id: project-${pId}
title: ${pId} Project Memory
type: project
status: active
summary: Project memory and imported specifications for ${pId}.
created: ${today}
updated: ${today}
tags: [project, ${pId}, shared-memory]
sources: []
confidence: high
reviewed_at: ${today}
authority: derived
---

# ${pId} — Project Memory

- Specifications: \`projects/${pId}/specs/\`
- Changes: \`projects/${pId}/changes/\`
- Wiki: \`projects/${pId}/wiki/\`
- Logs: \`projects/${pId}/logs/\`
- Agent memories: \`projects/${pId}/agents/\`
`);
  for (const role of ["coordinator", "builder", "investigator", "reviewer"]) {
    await createIfMissing(path.join(projectDir, "agents", role, "memory.md"), `---
id: memory-${pId}-${role}
title: ${pId} - ${role} Agent Memory
type: concept
status: active
summary: Scoped ${role} memory for ${pId}.
created: ${today}
updated: ${today}
tags: [agent-memory, ${pId}, ${role}]
sources: ["[[projects/${pId}/index]]"]
confidence: high
reviewed_at: ${today}
authority: derived
---

# ${pId} — ${role} Agent Memory
`);
  }
  await createIfMissing(path.join(projectDir, "agents", "handoffs", "README.md"), `# ${pId} — Agent Handoffs\n`);
  const summary = {
    repoPath,
    vaultPath,
    projectId: pId,
    specsMigrated: 0,
    memoriesMigrated: 0,
    details: [],
    conflicts: [],
  };

  const importSpec = async (source, target, label) => {
    const content = await readFile(source);
    try {
      await writeFile(target, content, { flag: "wx" });
      summary.specsMigrated++;
      summary.details.push(`Migrated OpenSpec ${label} -> ${target}`);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readFile(target);
      if (!existing.equals(content)) {
        summary.conflicts.push({ type: "spec", source, target });
        summary.details.push(`Conflict: OpenSpec ${source} differs from existing ${target}; preserved destination and source`);
      }
    }
  };

  const repoSpecs = path.join(repoPath, "openspec", "specs");
  if (fs.existsSync(repoSpecs)) {
    const entries = (await readdir(repoSpecs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        await importSpec(path.join(repoSpecs, entry.name), path.join(projectDir, "specs", entry.name), entry.name);
      } else if (entry.isDirectory()) {
        const subSpec = path.join(repoSpecs, entry.name, "spec.md");
        if (fs.existsSync(subSpec)) {
          await importSpec(subSpec, path.join(projectDir, "specs", `spec-${entry.name}.md`), `${entry.name}/spec.md`);
        }
      }
    }
  }

  const builderMemPath = path.join(projectDir, "agents", "builder", "memory.md");
  const begin = "<!-- BEGIN MIGRATED: repo-build-notes -->";
  const end = "<!-- END MIGRATED: repo-build-notes -->";
  const existing = await readFile(builderMemPath, "utf8");
  const beginCount = existing.split(begin).length - 1;
  const endCount = existing.split(end).length - 1;
  const start = existing.indexOf(begin);
  const finish = existing.indexOf(end);
  const memoryConflict = (reason, source = repoPath) => {
    summary.conflicts.push({ type: "builder-memory", source, target: builderMemPath, reason });
    summary.details.push(`Conflict: ${reason}; preserved ${builderMemPath}`);
  };
  if (beginCount !== endCount || beginCount > 1 || (beginCount && finish < start)) {
    memoryConflict("ambiguous generated block markers");
    return summary;
  }
  const previousBlock = beginCount ? existing.slice(start, finish + end.length) : "";
  const outside = beginCount ? existing.slice(0, start) + existing.slice(finish + end.length) : existing;
  const notes = [];
  for (const name of ["MEMORY.md", "AGENTS.md", "RULES.md", ".omp/AGENTS.md", ".omp/RULES.md"]) {
    const source = path.join(repoPath, name);
    if (fs.existsSync(source)) {
      const content = (await readFile(source, "utf8")).slice(0, 3000);
      notes.push({ name, source, content });
    }
  }
  let scripts = [];
  const pkgJsonPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8"));
      if (pkg.scripts && typeof pkg.scripts === "object") {
        scripts = Object.entries(pkg.scripts).map(([name, command]) => ({
          line: `- \`npm run ${name}\`: \`${command}\``,
        }));
      }
    } catch {}
  }

  // Older generated blocks had no digest. Only replace one when it still
  // exactly matches the content this migration would have generated.
  const oldScripts = scripts.map(({ line }) => line).join("\n");
  const oldNotes = notes.map(({ name, content }) => `\n\n### Migrated from \`${name}\`\n\n${content}\n`).join("");
  const legacyBlock = `${begin}\n${oldScripts ? `\n## Available Build/Test Scripts\n${oldScripts}\n` : ""}${oldNotes}\n${end}`;
  if (previousBlock) {
    const digestMatch = previousBlock.match(/^<!-- BEGIN MIGRATED: repo-build-notes -->\n<!-- sha256:([a-f0-9]{64}) -->\n([\s\S]*)\n<!-- END MIGRATED: repo-build-notes -->$/);
    const verified = digestMatch && createHash("sha256").update(digestMatch[2]).digest("hex") === digestMatch[1];
    if (!verified && previousBlock !== legacyBlock) {
      memoryConflict("generated block was edited or cannot be verified");
      return summary;
    }
  }

  const parts = [];
  const scriptLines = scripts.map(({ line }) => line);
  if (scriptLines.some((line) => line.includes(begin) || line.includes(end))) {
    memoryConflict("script information contains generated block markers", pkgJsonPath);
  } else if (outside.includes("## Available Build/Test Scripts")) {
    if (scriptLines.some((line) => !outside.includes(line))) {
      memoryConflict("unmarked build script information differs from the repository", pkgJsonPath);
    }
  } else {
    const missing = scriptLines.filter((line) => !outside.includes(line));
    if (missing.length) parts.push(`## Available Build/Test Scripts\n${missing.join("\n")}`);
  }
  for (const { name, source, content } of notes) {
    const heading = `### Migrated from \`${name}\``;
    if (content.includes(begin) || content.includes(end)) {
      memoryConflict("source notes contain generated block markers", source);
    } else if (content.trim() && outside.includes(content.trim())) {
      continue;
    } else if (outside.includes(heading)) {
      memoryConflict("unmarked imported notes differ from the repository", source);
    } else {
      parts.push(`${heading}\n\n${content}`);
      summary.memoriesMigrated++;
      summary.details.push(`Imported ${name} into agent memories`);
    }
  }
  if (parts.length || previousBlock) {
    const body = parts.join("\n\n");
    const digest = createHash("sha256").update(body).digest("hex");
    const block = `${begin}\n<!-- sha256:${digest} -->\n${body}\n${end}`;
    const merged = previousBlock
      ? existing.slice(0, start) + block + existing.slice(finish + end.length)
      : existing + (existing.endsWith("\n") ? "\n" : "\n\n") + block + "\n";
    if (merged !== existing) await writeFile(builderMemPath, merged, "utf8");
  }

  return summary;
}
