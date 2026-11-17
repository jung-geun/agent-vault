import fs from "node:fs";
import { mkdir, readFile, writeFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { scaffoldProject, roleShortTermTemplate } from "./vault-core.mjs";

async function readImportSource(root, relative, { scanSecrets = true } = {}) {
  const { resolveInside, assertNoSecrets } = await import("./memory-store.mjs");
  const { target } = await resolveInside(root, relative);
  if (!(await stat(target)).isFile()) throw Object.assign(new Error("Import source must be a regular file."), { code: "invalid_source" });
  const content = await readFile(target, "utf8");
  if (scanSecrets) assertNoSecrets(content);
  return content;
}

async function tryImportSource(root, relative, summary, options = {}) {
  try {
    return await readImportSource(root, relative, options);
  } catch (error) {
    if (!["secret_detected", "path_escape", "symlink_refused", "invalid_path", "invalid_source"].includes(error.code)) throw error;
    const source = path.join(root, relative);
    summary.conflicts.push({ type: options.type ?? "import-source", source, target: options.target, reason: error.code });
    summary.details.push(`Conflict: refused ${source} (${error.code}); preserved source and destination`);
    return null;
  }
}

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
    const content = await tryImportSource(wikiRoot, sourceRelative, summary, { type: "user-profile", target: path.join(vaultPath, "user/profile.md") });
    if (content !== null) {
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

        const rawContent = await tryImportSource(wikiPath, `projects/${entry.name}`, summary, { type: "project-overview" });
        if (rawContent === null) continue;
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
          const content = await tryImportSource(wikiPath, `openspec/specs/${entry.name}/spec.md`, summary, { type: "spec" });
          if (content === null) continue;
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
- Agent working memory: \`projects/${pId}/agents/<role>/short-term.md\`; durable memories use SQLite.
`);
  for (const role of ["coordinator", "builder", "investigator", "reviewer"]) {
    await createIfMissing(path.join(projectDir, "agents", role, "short-term.md"), roleShortTermTemplate(pId, pId, role, today));
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
    const sourceContent = await tryImportSource(repoPath, path.relative(repoPath, source), summary, { type: "spec", target });
    if (sourceContent === null) return;
    const content = Buffer.from(sourceContent);
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

  const { longTermWrite, migrateLongMemory } = await import("./memory-tiers.mjs");
  const legacy = await migrateLongMemory(vaultPath, { project: pId, cwd: repoPath });
  if (Array.isArray(legacy.conflicts)) summary.conflicts.push(...legacy.conflicts);
  const builderMemPath = path.join(projectDir, "agents", "builder", "memory.md");
  const { resolveInside } = await import("./memory-store.mjs");
  await resolveInside(vaultPath, `projects/${pId}/agents/builder/memory.md`);
  const existing = fs.existsSync(builderMemPath) ? await readFile(builderMemPath, "utf8") : "";
  const begin = "<!-- BEGIN MIGRATED: repo-build-notes -->";
  const end = "<!-- END MIGRATED: repo-build-notes -->";
  const beginCount = existing.split(begin).length - 1;
  const endCount = existing.split(end).length - 1;
  const start = existing.indexOf(begin);
  const finish = existing.indexOf(end);
  const memoryConflict = (reason, source = repoPath, target = builderMemPath) => {
    summary.conflicts.push({ type: "builder-memory", source, target, reason });
    summary.details.push(`Conflict: ${reason}; preserved source and stored memories`);
  };
  if (beginCount !== endCount || beginCount > 1 || (beginCount && finish < start)) {
    memoryConflict("ambiguous generated block markers");
    return summary;
  }
  const previousBlock = beginCount ? existing.slice(start, finish + end.length) : "";
  if (previousBlock.includes("<!-- sha256:")) {
    const digest = previousBlock.match(/^<!-- BEGIN MIGRATED: repo-build-notes -->\n<!-- sha256:([a-f0-9]{64}) -->\n([\s\S]*)\n<!-- END MIGRATED: repo-build-notes -->$/);
    if (!digest || createHash("sha256").update(digest[2]).digest("hex") !== digest[1]) {
      memoryConflict("generated block was edited or cannot be verified");
      return summary;
    }
  }

  const importMemory = async (name, content, { scripts = false } = {}) => {
    const source = path.join(repoPath, name);
    if (!content.trim()) return;
    if (content.includes(begin) || content.includes(end)) {
      memoryConflict(scripts ? "script information contains generated block markers" : "source notes contain generated block markers", source);
      return;
    }
    if (existing.includes(content.trim())) return;
    const heading = scripts ? "## Available Build/Test Scripts" : `### Migrated from \`${name}\``;
    if (existing.includes(heading)) {
      memoryConflict(scripts ? "unmarked build script information differs from the repository" : "unmarked imported notes differ from the repository", source);
      return;
    }
    const slug = `repo-import-${createHash("sha256").update(name).digest("hex").slice(0, 48)}`;
    try {
      const result = await longTermWrite(vaultPath, {
        project: pId, role: "builder", slug,
        title: scripts ? "Available Build/Test Scripts" : `Migrated from ${name}`,
        content, tags: ["migrated", "repository"],
      }, { sourcePath: `repo-import:${pId}:${createHash("sha256").update(name).digest("hex")}` });
      if (result.created) {
        if (!scripts) summary.memoriesMigrated++;
        summary.details.push(`Imported ${name} into SQLite builder memories`);
      }
    } catch (error) {
      if (error.code !== "exists" && error.code !== "source_conflict" && error.code !== "secret_detected") throw error;
      const { memoryDbFile } = await import("./memory-db.mjs");
      memoryConflict(error.code === "secret_detected" ? "source contains secrets" : "imported source differs from the stored memory", source, memoryDbFile(vaultPath));
    }
  };

  for (const name of ["MEMORY.md", "AGENTS.md", "RULES.md", ".omp/AGENTS.md", ".omp/RULES.md"]) {
    if (fs.existsSync(path.join(repoPath, name))) {
      const content = await tryImportSource(repoPath, name, summary, { type: "builder-memory" });
      if (content !== null) await importMemory(name, content);
    }
  }
  if (fs.existsSync(path.join(repoPath, "package.json"))) {
    const content = await tryImportSource(repoPath, "package.json", summary, { scanSecrets: false, type: "builder-memory" });
    let pkg;
    try { pkg = JSON.parse(content); } catch {}
    if (pkg?.scripts && typeof pkg.scripts === "object") {
      const lines = Object.entries(pkg.scripts).map(([name, command]) => `- \`npm run ${name}\`: \`${command}\``);
      await importMemory("package.json", lines.join("\n"), { scripts: true });
    }
  }

  return summary;
}
