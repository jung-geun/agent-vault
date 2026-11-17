import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateFromWiki, migrateFromProjectRepo } from "../lib/migration.mjs";
import { longMemorySearch, longMemoryRead } from "../lib/memory-tiers.mjs";

async function builderMemories(vault) {
  const { results } = await longMemorySearch(vault, { project: "test-project", role: "builder", query: "", limit: 50 });
  return Promise.all(results.map(({ id }) => longMemoryRead(vault, { project: "test-project", role: "builder", id })));
}

const begin = "<!-- BEGIN MIGRATED: repo-build-notes -->";
const end = "<!-- END MIGRATED: repo-build-notes -->";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "vault-migration-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const vault = path.join(root, "vault");
  await mkdir(repo);
  await mkdir(vault);
  return { repo, vault, project: path.join(vault, "projects", "test-project") };
}

async function put(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function snapshot(dir, prefix = "") {
  const result = {};
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(path.join(dir, entry.name), relative));
    else result[relative] = await readFile(path.join(dir, entry.name));
  }
  return result;
}

test("first migration imports both spec layouts without changing sources, and repeats idempotently", async (t) => {
  const { repo, vault, project } = await fixture(t);
  await put(path.join(repo, "openspec/specs/flat.md"), "# Flat spec\n");
  await put(path.join(repo, "openspec/specs/widget/spec.md"), "# Widget spec\n");
  await put(path.join(repo, "MEMORY.md"), "Use the fixture builder.\n");
  await put(path.join(repo, ".omp/AGENTS.md"), "Keep fixture changes small.\n");
  await put(path.join(repo, "package.json"), JSON.stringify({ scripts: { check: "node --check app.js" } }));
  const before = await snapshot(repo);

  const first = await migrateFromProjectRepo(repo, vault, "test-project");
  assert.equal(first.projectId, "test-project");
  assert.equal(first.specsMigrated, 2);
  assert.equal(first.memoriesMigrated, 2);
  assert.deepEqual(first.conflicts, []);
  assert.equal(await readFile(path.join(project, "specs/flat.md"), "utf8"), "# Flat spec\n");
  assert.equal(await readFile(path.join(project, "specs/spec-widget.md"), "utf8"), "# Widget spec\n");
  assert.deepEqual((await readdir(path.join(project, "specs"))).sort(), ["flat.md", "spec-widget.md"]);
  const index = await readFile(path.join(project, "index.md"), "utf8");
  assert.doesNotMatch(index, /Component boundary isolation|System architecture changes must/);
  const memories = await builderMemories(vault);
  assert.equal(memories.length, 3);
  const memory = memories.map(({ content }) => content).join("\n");
  assert.match(memory, /npm run check/);
  assert.match(memory, /Use the fixture builder\./);
  assert.match(memory, /Keep fixture changes small\./);
  await assert.rejects(readFile(path.join(project, "agents/builder/memory.md")), { code: "ENOENT" });
  assert.match(await readFile(path.join(project, "agents/builder/short-term.md"), "utf8"), /Current State/);
  assert.deepEqual(await snapshot(repo), before);

  const second = await migrateFromProjectRepo(repo, vault, "test-project");
  assert.equal(second.specsMigrated, 0);
  assert.deepEqual(second.conflicts, []);
  assert.equal(second.memoriesMigrated, 0);
  assert.deepEqual((await builderMemories(vault)).map(({ id, content }) => ({ id, content })), memories.map(({ id, content }) => ({ id, content })));
  assert.equal(await readFile(path.join(project, "index.md"), "utf8"), index);
  assert.deepEqual(await snapshot(repo), before);
});

test("changed source conflicts without replacing stored memory or touching source", async (t) => {
  const { repo, vault, project } = await fixture(t);
  await put(path.join(repo, "MEMORY.md"), "Original fixture instructions.\n");
  await migrateFromProjectRepo(repo, vault, "test-project");
  const [original] = await builderMemories(vault);
  await put(path.join(repo, "MEMORY.md"), "Updated fixture instructions.\n");
  const before = await snapshot(repo);

  const result = await migrateFromProjectRepo(repo, vault, "test-project");
  assert.equal(result.memoriesMigrated, 0);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].reason, /differs from the stored memory/);
  const [preserved] = await builderMemories(vault);
  assert.equal(preserved.id, original.id);
  assert.equal(preserved.content, original.content);
  await assert.rejects(readFile(path.join(project, "agents/builder/memory.md")), { code: "ENOENT" });
  await migrateFromProjectRepo(repo, vault, "test-project");
  assert.equal((await builderMemories(vault)).length, 1);
  assert.deepEqual(await snapshot(repo), before);
});

test("existing index and unmarked user memory stay intact without duplicate imports", async (t) => {
  const { repo, vault, project } = await fixture(t);
  const indexPath = path.join(project, "index.md");
  const memoryPath = path.join(project, "agents/builder/memory.md");
  const index = "---\ntitle: Curated title\n---\n\nUser index with no trailing newline";
  const memory = "# Personal notes\n\n## Available Build/Test Scripts\n- `npm run check`: `node --check app.js`\n\n### Migrated from `MEMORY.md`\n\nExisting fixture instructions.\n\nUser note with no trailing newline";
  await put(indexPath, index);
  await put(memoryPath, memory);
  await put(path.join(repo, "MEMORY.md"), "Existing fixture instructions.\n");
  await put(path.join(repo, "RULES.md"), "New fixture rule.\n");
  await put(path.join(repo, "package.json"), JSON.stringify({ scripts: { check: "node --check app.js" } }));
  const before = await snapshot(repo);

  const first = await migrateFromProjectRepo(repo, vault, "test-project");
  const imported = await readFile(memoryPath, "utf8");
  assert.deepEqual(first.conflicts, []);
  assert.equal(await readFile(indexPath, "utf8"), index);
  assert.equal(imported, memory);
  const memories = await builderMemories(vault);
  assert.equal(memories.length, 2);
  assert.equal(memories.filter(({ content }) => content.includes("Existing fixture instructions.")).length, 1);
  assert.equal(memories.filter(({ content }) => content.includes("New fixture rule.")).length, 1);
  await migrateFromProjectRepo(repo, vault, "test-project");
  assert.equal(await readFile(memoryPath, "utf8"), memory);
  assert.equal((await builderMemories(vault)).length, 2);
  assert.equal(await readFile(indexPath, "utf8"), index);
  assert.deepEqual(await snapshot(repo), before);
});

test("different existing specs are conflicts, identical specs stay untouched", async (t) => {
  const { repo, vault, project } = await fixture(t);
  await put(path.join(repo, "openspec/specs/flat.md"), "Source flat\n");
  await put(path.join(repo, "openspec/specs/widget/spec.md"), "Source widget\n");
  await put(path.join(repo, "openspec/specs/same.md"), "Same bytes\n");
  await put(path.join(project, "specs/flat.md"), "Curated flat\n");
  await put(path.join(project, "specs/spec-widget.md"), "Curated widget\n");
  await put(path.join(project, "specs/same.md"), "Same bytes\n");
  const before = await snapshot(repo);

  const result = await migrateFromProjectRepo(repo, vault, "test-project");
  assert.equal(result.specsMigrated, 0);
  assert.deepEqual(result.conflicts.map(({ type, source, target }) => ({ type, source, target })), [
    { type: "spec", source: path.join(repo, "openspec/specs/flat.md"), target: path.join(project, "specs/flat.md") },
    { type: "spec", source: path.join(repo, "openspec/specs/widget/spec.md"), target: path.join(project, "specs/spec-widget.md") },
  ]);
  assert.equal(result.details.filter((detail) => detail.startsWith("Conflict:")).length, 2);
  assert.equal(await readFile(path.join(project, "specs/flat.md"), "utf8"), "Curated flat\n");
  assert.equal(await readFile(path.join(project, "specs/spec-widget.md"), "utf8"), "Curated widget\n");
  assert.equal(await readFile(path.join(project, "specs/same.md"), "utf8"), "Same bytes\n");
  assert.deepEqual(await snapshot(repo), before);
});

test("edited or ambiguous generated blocks remain untouched through SQLite import", async (t) => {
  const { repo, vault, project } = await fixture(t);
  await put(path.join(repo, "MEMORY.md"), "Changed fixture source.\n");
  const memoryPath = path.join(project, "agents/builder/memory.md");
  const edited = `User prefix\n${begin}\n<!-- sha256:${"0".repeat(64)} -->\nUser-edited fixture source.\n${end}\nUser suffix`;
  await put(memoryPath, edited);
  let result = await migrateFromProjectRepo(repo, vault, "test-project");
  assert.equal(await readFile(memoryPath, "utf8"), edited);
  assert.ok(result.conflicts.some(({ reason }) => /cannot be verified/.test(reason)));
  const [stored] = await builderMemories(vault);
  assert.equal(stored.content, edited);

  const ambiguous = `${edited}\n${begin}\nUnpaired user text\n`;
  await writeFile(memoryPath, ambiguous);
  result = await migrateFromProjectRepo(repo, vault, "test-project");
  assert.equal(await readFile(memoryPath, "utf8"), ambiguous);
  assert.ok(result.conflicts.some(({ reason }) => /ambiguous/.test(reason)));
  assert.equal((await builderMemories(vault))[0].content, edited);
});

test("legacy generated block imports once without changing retained Markdown", async (t) => {
  const { repo, vault, project } = await fixture(t);
  const memoryPath = path.join(project, "agents/builder/memory.md");
  await put(path.join(repo, "MEMORY.md"), "Fixture source.\n");
  const block = `${begin}\n\n\n### Migrated from \`MEMORY.md\`\n\nFixture source.\n\n\n${end}`;
  const original = `Before\n${block}\nAfter\n`;
  await put(memoryPath, original);
  const result = await migrateFromProjectRepo(repo, vault, "test-project");
  assert.deepEqual(result.conflicts, []);
  assert.equal(await readFile(memoryPath, "utf8"), original);
  const [memory] = await builderMemories(vault);
  assert.equal(memory.content, original);
  await migrateFromProjectRepo(repo, vault, "test-project");
  assert.equal((await builderMemories(vault)).length, 1);
  assert.equal((await builderMemories(vault))[0].id, memory.id);

  await put(path.join(repo, "MEMORY.md"), "New fixture source.\n");
  const conflict = await migrateFromProjectRepo(repo, vault, "test-project");
  assert.match(conflict.conflicts[0].reason, /differ/);
  assert.equal(await readFile(memoryPath, "utf8"), original);
  assert.equal((await builderMemories(vault))[0].content, original);
});

test("unmarked differing imports and source marker collisions are reported", async (t) => {
  const { repo, vault, project } = await fixture(t);
  const memoryPath = path.join(project, "agents/builder/memory.md");
  const original = "### Migrated from `MEMORY.md`\n\nUser-edited old source.\n";
  await put(memoryPath, original);
  await put(path.join(repo, "MEMORY.md"), "New fixture source.\n");
  await put(path.join(repo, "RULES.md"), `Do not interpret this text: ${begin}\n`);
  const before = await snapshot(repo);
  const result = await migrateFromProjectRepo(repo, vault, "test-project");
  assert.equal(await readFile(memoryPath, "utf8"), original);
  assert.deepEqual(result.conflicts.map(({ reason }) => reason), [
    "unmarked imported notes differ from the repository",
    "source notes contain generated block markers",
  ]);
  assert.deepEqual(await snapshot(repo), before);
});

test("changed source spec conflicts with a previous import without replacing it", async (t) => {
  const { repo, vault, project } = await fixture(t);
  const source = path.join(repo, "openspec/specs/capability.md");
  const target = path.join(project, "specs/capability.md");
  await put(source, "Original specification\n");
  await migrateFromProjectRepo(repo, vault, "test-project");
  await put(source, "Changed specification\n");
  const before = await snapshot(repo);
  const result = await migrateFromProjectRepo(repo, vault, "test-project");
  assert.deepEqual(result.conflicts, [{ type: "spec", source, target }]);
  assert.equal(await readFile(target, "utf8"), "Original specification\n");
  assert.deepEqual(await snapshot(repo), before);
});

test("unmarked script information is never duplicated or overwritten", async (t) => {
  const { repo, vault, project } = await fixture(t);
  const memoryPath = path.join(project, "agents/builder/memory.md");
  const original = "## Available Build/Test Scripts\n- `npm run check`: `old check`\n";
  await put(memoryPath, original);
  await put(path.join(repo, "package.json"), JSON.stringify({ scripts: { check: "new check" } }));
  const result = await migrateFromProjectRepo(repo, vault, "test-project");
  assert.equal(await readFile(memoryPath, "utf8"), original);
  assert.equal(result.conflicts[0].reason, "unmarked build script information differs from the repository");
});

test("project id defaults to repo basename and retains validation", async (t) => {
  const { repo, vault } = await fixture(t);
  const result = await migrateFromProjectRepo(repo, vault);
  assert.equal(result.projectId, "repo");
  assert.equal(await readFile(path.join(vault, "projects/repo/index.md"), "utf8").then((s) => s.includes("# repo — Project Memory")), true);
  await assert.rejects(migrateFromProjectRepo(repo, vault, "../invalid"), /Invalid project ID/);
});

test("uncertain legacy text and complete repository notes survive repeated imports", async (t) => {
  const { repo, vault, project } = await fixture(t);
  const legacyPath = path.join(project, "agents/builder/memory.md");
  const legacy = "Unclassified user notes without a trailing newline";
  const content = `${"Repository context.\n".repeat(220)}Final detail beyond the old truncation boundary.\n`;
  await put(legacyPath, legacy);
  await put(path.join(repo, "MEMORY.md"), content);
  const before = await snapshot(repo);
  await migrateFromProjectRepo(repo, vault, "test-project");
  const memories = await builderMemories(vault);
  assert.equal(memories.length, 2);
  assert.ok(memories.some((memory) => memory.content === legacy));
  assert.ok(memories.some((memory) => memory.content === content));
  await migrateFromProjectRepo(repo, vault, "test-project");
  assert.deepEqual((await builderMemories(vault)).map(({ id }) => id), memories.map(({ id }) => id));
  assert.equal(await readFile(legacyPath, "utf8"), legacy);
  assert.deepEqual(await snapshot(repo), before);
});
test("wiki migration imports an explicitly selected profile, projects, and specs once without changing source", async (t) => {
  const { repo: wiki, vault } = await fixture(t);
  await put(path.join(wiki, "profiles", "profile.md"), "# Profile\n\nPreferred response style.\n");
  await put(path.join(wiki, "projects", "alpha.md"), "# Alpha\n\nProject history.\n");
  await put(path.join(wiki, "openspec/specs/alpha/spec.md"), "# Alpha Spec\n\n## Purpose\n");
  const before = await snapshot(wiki);

  const first = await migrateFromWiki(wiki, vault, { profileSource: "profiles/profile.md" });
  assert.equal(first.profileMigrated, 1);
  assert.equal(first.projectsMigrated, 1);
  assert.equal(first.specsMigrated, 1);
  assert.deepEqual(first.conflicts, []);
  const profilePath = path.join(vault, "user/profile.md");
  const overviewPath = path.join(vault, "projects/alpha/wiki/concepts/alpha-overview.md");
  const specPath = path.join(vault, "shared/knowledge/specs/alpha-spec.md");
  const profile = await readFile(profilePath, "utf8");
  const overview = await readFile(overviewPath, "utf8");
  const spec = await readFile(specPath, "utf8");
  assert.match(profile, /Preferred response style/);
  assert.match(profile, /profiles\/profile\.md/);
  assert.match(overview, /Project history/);
  assert.equal(spec, "# Alpha Spec\n\n## Purpose\n");
  assert.deepEqual(await snapshot(wiki), before);

  const second = await migrateFromWiki(wiki, vault, { profileSource: "profiles/profile.md" });
  assert.equal(second.profileMigrated, 0);
  assert.equal(second.projectsMigrated, 0);
  assert.equal(second.specsMigrated, 0);
  assert.deepEqual(second.conflicts, []);
  assert.equal(await readFile(profilePath, "utf8"), profile);
  assert.equal(await readFile(overviewPath, "utf8"), overview);
  assert.equal(await readFile(specPath, "utf8"), spec);
  assert.deepEqual(await snapshot(wiki), before);
});

test("wiki migration does not guess a profile source", async (t) => {
  const { repo: wiki, vault } = await fixture(t);
  await put(path.join(wiki, "entities", "profile.md"), "# Local profile\n");

  const result = await migrateFromWiki(wiki, vault);
  assert.equal(result.profileMigrated, 0);
  await assert.rejects(readFile(path.join(vault, "user/profile.md")), { code: "ENOENT" });
});

test("wiki migration reports conflicts and preserves existing vault notes", async (t) => {
  const { repo: wiki, vault } = await fixture(t);
  await put(path.join(wiki, "profiles/profile.md"), "# Source profile\n");
  await put(path.join(wiki, "projects", "alpha.md"), "# Source project\n");
  await put(path.join(wiki, "openspec/specs/alpha/spec.md"), "# Source spec\n");
  const profilePath = path.join(vault, "user/profile.md");
  const overviewPath = path.join(vault, "projects/alpha/wiki/concepts/alpha-overview.md");
  const specPath = path.join(vault, "shared/knowledge/specs/alpha-spec.md");
  await put(profilePath, "# Existing user profile\n");
  await put(overviewPath, "# Existing project memory\n");
  await put(specPath, "# Existing spec copy\n");
  const before = await snapshot(wiki);

  const result = await migrateFromWiki(wiki, vault, { profileSource: "profiles/profile.md" });
  assert.equal(result.profileMigrated, 0);
  assert.deepEqual(result.conflicts.map(({ type }) => type).sort(), ["project-overview", "spec", "user-profile"]);
  assert.equal(await readFile(profilePath, "utf8"), "# Existing user profile\n");
  assert.equal(await readFile(overviewPath, "utf8"), "# Existing project memory\n");
  assert.equal(await readFile(specPath, "utf8"), "# Existing spec copy\n");
  assert.deepEqual(await snapshot(wiki), before);
});

test("wiki migration rejects profile paths outside the source wiki", async (t) => {
  const { repo: wiki, vault } = await fixture(t);
  await put(path.join(path.dirname(wiki), "outside-profile.md"), "# Outside profile\n");

  await assert.rejects(
    migrateFromWiki(wiki, vault, { profileSource: "../outside-profile.md" }),
    /stay inside the source wiki/
  );
  await assert.rejects(
    migrateFromWiki(wiki, vault, { profileSource: path.join(path.dirname(wiki), "outside-profile.md") }),
    /relative path inside the source wiki/
  );
});
