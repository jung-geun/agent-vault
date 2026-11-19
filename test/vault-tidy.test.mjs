import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initVault, scaffoldProject } from "../lib/vault-core.mjs";
import { closeMemoryDbs } from "../lib/memory-db.mjs";
import { diagnoseMemory } from "../lib/memory-inspect.mjs";
import { longTermWrite } from "../lib/memory-tiers.mjs";
import { noteEditBlock, writeMemory } from "../lib/memory-store.mjs";
import {
  buildLinkIndex, extractLinks, inlineTags, maskCode, readFrontmatterTags, resolveLink, tagKey, writeFrontmatterTags,
} from "../lib/note-scan.mjs";
import { readTagAliases } from "../lib/tag-aliases.mjs";
import { applyTidy, auditVault, listTidyBackups, planTidy, readTidyState, recordTidyAudit, renderTidyReport, undoTidy } from "../lib/vault-tidy.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/vault-cli.mjs", import.meta.url));
const serverPath = fileURLToPath(new URL("../bin/vault-mcp.mjs", import.meta.url));
const sha = (data) => createHash("sha256").update(data).digest("hex");

async function makeVault(t, name = "vault") {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-tidy-"));
  t.after(async () => { closeMemoryDbs(); await rm(root, { recursive: true, force: true }); });
  const vault = path.join(root, name);
  await initVault(vault);
  await scaffoldProject(vault, "demo", "Demo");
  const put = async (rel, text) => { const file = path.join(vault, rel); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
  const read = (rel) => readFile(path.join(vault, rel), "utf8");
  return { root, vault, put, read, digest: async (rel) => sha(await readFile(path.join(vault, rel))) };
}

const note = (tags, body = "text", extra = "") => `---\ntitle: T\n${tags}\n${extra}---\n${body}\n`;
const USER_NOTE = note("tags: [agentvault]", "append only");

// A vault shaped like a real one: curated notes that can be edited, plus legacy journals, user notes, a generated view and notes outside
// the writable folders, all carrying the same duplicate spellings.
async function curatedVault(t) {
  const ctx = await makeVault(t);
  const { put } = ctx;
  await put("shared/knowledge/alpha.md", note('tags: [Agent-Vault, memory, "Governance"]', "See [[beta]], [[Shared/Knowledge/Beta]], [[shared/knowledge/missing]] and [[projects/<project-id>/x]]."));
  await put("shared/knowledge/beta.md", note("tags: [agent-vault, memories, governance, phase-1]", "Back to [[alpha]] #Inline-Tag and #123 and an issue #45."));
  await put("shared/knowledge/gamma.md", note("tags:\n  - agentvault\n  - governence\n  - phase-2", "Nothing links here."));
  await put("shared/knowledge/delta.md", "---\ntitle: D\n---\n```\n[[ghost]] #notatag\n```\nand `[[inline-ghost]]` here.\n");
  await put("shared/knowledge/protected.md", note("tags: [short-term, Short-Term, skill, Skill]"));
  for (const n of [1, 2, 3, 4]) await put(`shared/knowledge/spec-${n}.md`, note("tags: [retrieval, ingest-flow]"));
  for (const n of [1, 2]) await put(`shared/knowledge/os-${n}.md`, note("tags: [agent-os]"));
  for (const n of [3, 4]) await put(`shared/knowledge/os-${n}.md`, note("tags: [agent-os-sqlite]"));
  await put("shared/knowledge/family.md", note("tags: [ticket:1, ticket:2, ticket:3, ticket:4, ticket:5, ticket:6]"));
  for (const n of [1, 2, 3, 4]) await put(`projects/demo/wiki/n${n}.md`, note(`tags: [demo, wiki-note-${n}]`));
  await put("projects/demo/worktrees/main/2026-01-01-instruction-x.md", note('tags: ["worktree", "Agent-Vault", "main", "demo"]', "legacy [[Shared/Knowledge/Beta]]"));
  await put("user/notes.md", USER_NOTE);
  await put("projects/demo/weekly/2026-01.md", note("tags: [weekly-only-tag]", "generated"));
  await put("_meta/extra.md", note("tags: [Agent-Vault]", "outside"));
  return ctx;
}


test("tag keys fold case, separators and a leading hash but keep nesting and families", () => {
  assert.equal(tagKey("#Agent_Vault"), "agent-vault");
  assert.equal(tagKey("  Agent  Vault. "), "agent-vault");
  assert.equal(tagKey("Parent/Child"), "parent/child");
  assert.equal(tagKey("Source:12"), "source:12");
  assert.equal(tagKey("한글_태그"), "한글-태그");
});

test("frontmatter tags are read and rewritten in their own style without touching anything else", () => {
  const cases = [
    ["inline bare", 'tags: [a, b-c, "d e"]', ["a", "b-c", "d e"], 'tags: [x, y]'],
    ["inline double quoted", 'tags: ["a", "b"]', ["a", "b"], 'tags: ["x", "y"]'],
    ["inline single quoted", "tags: ['a', 'it''s']", ["a", "it's"], "tags: ['x', 'y']"],
    ["block", "tags:\n  - a\n  - \"b\"", ["a", "b"], "tags:\n  - x\n  - y"],
    ["scalar", "tags: a, b", ["a", "b"], "tags: [x, y]"],
    ["empty", "tags: []", [], "tags: [x, y]"],
  ];
  for (const [label, line, expected, rewritten] of cases) {
    const text = `---\ntitle: T\n${line}\nupdated: 2026-01-01\n---\nbody ${label}\n`;
    const info = readFrontmatterTags(text);
    assert.deepEqual(info.tags, expected, label);
    const next = writeFrontmatterTags(text, info, ["x", "y"]);
    assert.equal(next, `---\ntitle: T\n${rewritten}\nupdated: 2026-01-01\n---\nbody ${label}\n`, label);
  }
  const crlf = "---\r\ntitle: T\r\ntags: [A, b]\r\n---\r\nbody\r\n";
  assert.equal(writeFrontmatterTags(crlf, readFrontmatterTags(crlf), ["a"]), "---\r\ntitle: T\r\ntags: [a]\r\n---\r\nbody\r\n");
  const block = "---\ntags:\n  - a\n---\n";
  assert.equal(writeFrontmatterTags(block, readFrontmatterTags(block), []), "---\ntags: []\n---\n", "no tags left: an empty list, not a dangling key");
  assert.equal(readFrontmatterTags("no frontmatter\n").present, false);
  assert.equal(readFrontmatterTags("---\ntitle: T\n---\n").present, false);
  const flow = "---\ntags: [a,\n  b]\n---\n";
  assert.equal(readFrontmatterTags(flow).unsupported, true);
  assert.throws(() => writeFrontmatterTags(flow, readFrontmatterTags(flow), ["x"]), /cannot be rewritten/);
  assert.match(writeFrontmatterTags("---\ntags: [a]\n---\n", readFrontmatterTags("---\ntags: [a]\n---\n"), ["2026", "true", "a:b", "한글"]), /tags: \["2026", "true", a:b, 한글\]/);
});

test("code is masked, inline tags skip headings, numbers and code, and links keep their exact offsets", () => {
  const text = "# Heading #notatag\nreal #tag-one and #Tag/Nested but not #123 or word#fragment\n```js\n#fence [[ghost]]\n```\n`#span [[spanlink]]` then [[real|alias]] ![[embed#h]]\n";
  const masked = maskCode(text);
  assert.equal(masked.length, text.length);
  assert.deepEqual(inlineTags(masked), ["notatag", "tag-one", "Tag/Nested"], "a tag inside a heading counts, the heading marker does not");
  const links = extractLinks(masked);
  assert.deepEqual(links.map((link) => [link.kind, link.embed, link.target, link.anchor, link.tail]), [["wiki", false, "real", "", "|alias"], ["wiki", true, "embed", "#h", ""]]);
  for (const link of links) assert.equal(text.slice(link.start, link.end), `${link.embed ? "!" : ""}[[${link.target}${link.anchor}${link.tail}]]`);
  assert.equal(links[0].line, 6);
  const table = extractLinks("| [[a\\|b]] |\n[x](dir/note.md#sec) [y](https://e.com) [z](#top) [w](<my note.md>) [p]({{x}})");
  assert.deepEqual(table.map((link) => [link.kind, link.target, link.tail]), [["wiki", "a", "\\|b"], ["md", "dir/note.md", ""], ["md", "my note.md", ""]], "web links, anchors and template placeholders are not note links");
});

test("links resolve like Obsidian and repairs are only suggested when they cannot mislead", () => {
  const index = buildLinkIndex([
    "projects/a/specs/spec-backend.md", "projects/b/specs/spec-backend.md", "shared/knowledge/deploy-runbook-notes.md", "shared/knowledge/spec.md",
    "projects/a/index.md", "projects/a/wiki/Overview.md", "assets/diagram.png", "README.md", "shared/knowledge/sibling.md", "shared/knowledge/other.md",
  ]);
  const at = (target, from = "shared/knowledge/other.md") => resolveLink(index, from, target);
  assert.equal(at("shared/knowledge/sibling").status, "ok", "vault path");
  assert.equal(at("sibling.md").status, "ok", "short name with extension");
  assert.equal(at("./sibling", "shared/knowledge/other.md").status, "ok", "relative to the note");
  assert.equal(at("assets/diagram.png").status, "ok", "attachments");
  assert.equal(at("README").status, "ok");
  assert.deepEqual(at("spec-backend"), { status: "ambiguous", candidates: ["projects/a/specs/spec-backend", "projects/b/specs/spec-backend"], count: 2 });
  assert.deepEqual(at("Projects/A/Wiki/overview"), { status: "case", fix: "projects/a/wiki/Overview" });
  assert.deepEqual(at("projects/a"), { status: "folder", fix: "projects/a/index" });
  assert.deepEqual(at("old/place/deploy-runbook-notes"), { status: "moved", fix: "shared/knowledge/deploy-runbook-notes" }, "a specific name that exists once");
  assert.deepEqual(at("../project/spec.md", "projects/kia/specs/x.md"), { status: "broken", candidates: ["shared/knowledge/spec"], count: 1 }, "a generic name is never trusted to say where a note moved");
  assert.equal(at("../../../../escape.md", "projects/kia/specs/x.md").status, "external", "climbing out of the vault is not a broken note");
  assert.equal(at("nothing/here").status, "broken");
});

test("noteEditBlock is the same rule doc_write enforces", async (t) => {
  const { vault } = await makeVault(t);
  const paths = [
    "projects/demo/logs/x.md", "projects/demo/worktrees/main/x.md", "projects/demo/long-term/x.md", "projects/demo/agents/handoffs/x.md",
    "projects/demo/agents/builder/memory.md", "projects/demo/weekly/2026-01.md", "shared/knowledge/weekly/2026-01.md", "_meta/x.md", "README.md",
    "shared/knowledge/ok.md", "projects/demo/wiki/ok.md", "projects/demo/agents/builder/short-term.md", "projects/demo/specs/ok.md",
  ];
  for (const rel of paths) {
    const block = noteEditBlock(rel);
    if (block) await assert.rejects(writeMemory(vault, { path: rel, content: "x", mode: "create" }), (error) => error.code === block.code, rel);
    else assert.equal((await writeMemory(vault, { path: rel, content: "x", mode: "append" })).path, rel, rel);
  }
  assert.equal(noteEditBlock("user/profile.md").code, "append_only");
});

test("audit separates editable notes from journals, user notes, outside files and generated views", async (t) => {
  const { vault } = await curatedVault(t);
  const report = await auditVault(vault, { limit: 50 });
  const counts = report.scope.notes;
  assert.equal(counts.legacy, 1);
  assert.equal(counts.generated, 1);
  assert.ok(counts["append-only"] >= 1 && counts.outside >= 1 && counts.mutable >= 20);
  assert.ok(!JSON.stringify(report).includes("weekly-only-tag"), "tags of generated views are not part of the inventory");
  assert.equal(report.tags.legacyJournals.notes, 1);
  assert.match(report.tags.legacyJournals.hint, /memory migrate --project <id> --prune-legacy/);
  assert.equal(report.tags.legacyJournals.projects[0].project, "demo");
});

test("audit finds duplicate spellings, plurals, probable typos, overlaps, co-occurrence, location repeats and families", async (t) => {
  const { vault } = await curatedVault(t);
  const { tags } = await auditVault(vault, { limit: 50 });
  const spelling = tags.mergeCandidates.spelling.items;
  const vaultTag = spelling.find((group) => group.members.some((member) => member.tag === "agent-vault"));
  assert.deepEqual(vaultTag.members.map((member) => member.tag).sort(), ["agent-vault", "agentvault"]);
  assert.equal(vaultTag.canonical, "Agent-Vault", "the spelling used on the most notes wins, and read-only notes count because they cannot change");
  assert.equal(spelling.find((group) => group.members.some((member) => member.tag === "Governance")).canonical, "governance", "a tie prefers the normalized spelling");
  const protectedGroup = spelling.find((group) => group.canonical === "short-term");
  assert.deepEqual(protectedGroup.members.map((member) => member.tag), ["Short-Term"], "a tag Agent Vault writes itself is the canonical spelling, never renamed");
  assert.equal(spelling.find((group) => group.canonical === "skill").members[0].tag, "Skill");
  assert.ok(tags.mergeCandidates.plural.items.some((group) => group.canonical === "memory" && group.members[0].tag === "memories"));
  const typos = tags.mergeCandidates.typo.items.map((group) => [group.canonical, group.members[0].tag]);
  assert.ok(typos.some(([keep, drop]) => keep === "governance" && drop === "governence"));
  assert.ok(!typos.some((pair) => pair.some((tag) => tag.startsWith("phase-"))), "numbered tags are not typos of each other");
  assert.ok(tags.mergeCandidates.overlap.items.some((group) => group.tags.join() === "agent-os,agent-os-sqlite"));
  assert.ok(tags.alwaysTogether.items.some((group) => group.tags.includes("retrieval") && group.tags.includes("ingest-flow")));
  const repeat = tags.repeatsLocation.items.find((item) => item.tag === "demo");
  assert.ok(repeat && repeat.editable >= 4 && repeat.readOnly >= 1);
  assert.ok(tags.families.items.some((family) => family.family === "ticket:" && family.distinct === 6));
  assert.ok(tags.projection.afterSafeMerges < tags.projection.distinctNow && tags.projection.afterEverySuggestion <= tags.projection.afterSafeMerges);
});

test("audit reports links by class, ignores code and template placeholders, and finds orphans among editable notes only", async (t) => {
  const { vault } = await curatedVault(t);
  const { links } = await auditVault(vault, { limit: 50 });
  const fixable = links.fixable.items.find((item) => item.note === "shared/knowledge/alpha.md");
  assert.deepEqual([fixable.target, fixable.to, fixable.status, fixable.editable], ["Shared/Knowledge/Beta", "shared/knowledge/beta", "case", true]);
  assert.ok(links.fixable.items.some((item) => item.note.startsWith("projects/demo/worktrees/") && !item.editable), "read-only notes are listed but marked");
  assert.ok(links.broken.items.some((item) => item.note === "shared/knowledge/alpha.md" && item.target === "shared/knowledge/missing"));
  assert.ok(![...links.broken.items, ...links.fixable.items].some((item) => /ghost|project-id/.test(item.target)));
  assert.ok(links.orphans.items.includes("shared/knowledge/gamma.md"));
  assert.ok(!links.orphans.items.some((rel) => rel.startsWith("projects/demo/worktrees/")));
  assert.equal(links.editableFixable, 1);
});

test("audit is strictly read-only, including the SQLite database it reports on", async (t) => {
  const { vault } = await curatedVault(t);
  await longTermWrite(vault, { project: "demo", title: "First", content: "alpha", tags: ["Skill-Case", "skill-case", "source:1", "source:2", "source:3", "source:4", "source:5"] });
  await longTermWrite(vault, { project: "demo", title: "Second", content: "beta", tags: ["agentvault", "agent-vault"] });
  closeMemoryDbs();
  const snapshot = async () => {
    const out = {};
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (!/-(?:wal|shm)$/.test(entry.name)) out[path.relative(vault, full)] = `${(await stat(full)).mtimeMs}:${sha(await readFile(full))}`;
      }
    };
    await walk(vault);
    return out;
  };
  const before = await snapshot();
  const report = await auditVault(vault, { limit: 10 });
  assert.deepEqual(await snapshot(), before, "no file may change during an audit");
  const database = report.database;
  assert.equal(database.available, true);
  assert.equal(database.memories, 2);
  assert.deepEqual(database.provenanceTags, { distinct: 5, memories: 5 });
  assert.ok(database.sameSpellings.some((group) => group.map((item) => item.tag).sort().join() === "agent-vault,agentvault"));
  assert.match(database.note, /immutable/);
  assert.match(renderTidyReport(report), /SQLite memories/);
});

test("a plan only touches editable notes, applies exactly what it previewed, and undo restores every byte", async (t) => {
  const { vault, read, digest } = await curatedVault(t);
  const watched = ["shared/knowledge/alpha.md", "shared/knowledge/beta.md", "shared/knowledge/gamma.md", "shared/knowledge/delta.md", "shared/knowledge/protected.md",
    "projects/demo/worktrees/main/2026-01-01-instruction-x.md", "user/notes.md", "projects/demo/weekly/2026-01.md", "_meta/extra.md"];
  const before = Object.fromEntries(await Promise.all(watched.map(async (rel) => [rel, await digest(rel)])));

  const plan = await planTidy(vault, { accept: ["spelling"], fixLinks: "safe" });
  assert.deepEqual(plan.edits.map((edit) => edit.path).filter((rel) => watched.includes(rel)).sort(), ["shared/knowledge/alpha.md", "shared/knowledge/beta.md", "shared/knowledge/gamma.md", "shared/knowledge/protected.md"]);
  assert.ok(plan.skipped.some((skip) => skip.path.includes("worktrees") && /legacy/.test(skip.reason)));
  assert.ok(plan.skipped.some((skip) => skip.path === "user/notes.md" && /append-only/.test(skip.reason)));
  assert.equal(plan.merges["Short-Term"], "short-term");
  assert.equal(plan.merges["short-term"], undefined);

  const applied = await applyTidy(vault, plan);
  assert.deepEqual(applied.refused, []);
  assert.equal(applied.changed.length, plan.edits.length);
  assert.equal(await read("shared/knowledge/alpha.md"), note("tags: [Agent-Vault, memory, governance]", "See [[beta]], [[shared/knowledge/beta]], [[shared/knowledge/missing]] and [[projects/<project-id>/x]]."), "a list that mixed quoted and bare items keeps quotes only where needed");
  assert.equal(await read("shared/knowledge/gamma.md"), note("tags:\n  - Agent-Vault\n  - governence\n  - phase-2", "Nothing links here."));
  assert.equal(await read("shared/knowledge/protected.md"), note("tags: [short-term, skill]"));
  for (const rel of ["projects/demo/worktrees/main/2026-01-01-instruction-x.md", "user/notes.md", "projects/demo/weekly/2026-01.md", "_meta/extra.md"]) {
    assert.equal(await digest(rel), before[rel], `${rel} is outside the editable notes`);
  }
  assert.equal((await planTidy(vault, { accept: ["spelling"], fixLinks: "safe" })).edits.length, 0, "applying twice changes nothing more");

  const undone = await undoTidy(vault, applied.id);
  assert.deepEqual(undone.skipped, []);
  assert.equal(undone.aliases, "restored");
  for (const rel of watched) assert.equal(await digest(rel), before[rel], `${rel} is byte-identical after undo`);
  assert.equal(existsSync(path.join(vault, ".agent-vault", "tag-aliases.json")), false);
  assert.deepEqual((await undoTidy(vault, applied.id)).restored, [], "a second undo restores nothing");
});

test("explicit merges and drops are validated, protected tags cannot be touched, and inline tags are reported not rewritten", async (t) => {
  const { vault, read } = await curatedVault(t);
  await assert.rejects(planTidy(vault, { merge: ["nope=other"] }), (error) => error.code === "unknown_tag");
  await assert.rejects(planTidy(vault, { merge: ["retrieval=has space"] }), (error) => error.code === "invalid_tag");
  await assert.rejects(planTidy(vault, { merge: ["skill=other"] }), (error) => error.code === "protected_tag");
  await assert.rejects(planTidy(vault, { merge: ["ticket:1=ticket:2"], drop: ["short-term"] }), (error) => error.code === "protected_tag");
  await assert.rejects(planTidy(vault, { drop: ["unknown"] }), (error) => error.code === "unknown_tag");
  await assert.rejects(planTidy(vault, { merge: ["retrieval=ingest-flow", "ingest-flow=retrieval"] }), (error) => error.code === "merge_cycle");
  await assert.rejects(planTidy(vault, { accept: ["everything"] }), (error) => error.code === "invalid_accept");
  const plan = await planTidy(vault, { accept: [], merge: ["governence=governance", "memories=memory"], drop: ["demo"] });
  assert.deepEqual(plan.merges, { governence: "governance", memories: "memory" });
  assert.deepEqual(plan.drops, ["demo"]);
  const inline = await planTidy(vault, { accept: [], merge: ["agentvault=agent-vault"] });
  assert.deepEqual(inline.notes, []);
  await applyTidy(vault, plan);
  assert.match(await read("shared/knowledge/beta.md"), /tags: \[agent-vault, memory, governance, phase-1\]/);
  assert.match(await read("shared/knowledge/beta.md"), /#Inline-Tag/, "body text is never rewritten");
  assert.match(await read("projects/demo/wiki/n1.md"), /tags: \[wiki-note-1\]/);
});

test("an inline #tag spelling variant is counted and reported but never rewritten", async (t) => {
  const { vault, put, read } = await makeVault(t);
  await put("shared/knowledge/a.md", note("tags: [project-x, ProjectX]", "uses #projectx here"));
  await put("shared/knowledge/b.md", note("tags: [project-x]", "plain"));
  const plan = await planTidy(vault, { accept: ["spelling"] });
  assert.equal(plan.edits.length, 1, "only the frontmatter variant is edited");
  assert.match(plan.notes[0], /Inline #tags are not rewritten: #projectx \(1\)/);
  await applyTidy(vault, plan);
  assert.match(await read("shared/knowledge/a.md"), /uses #projectx here/);
});

test("apply refuses stale, hand-edited, escaping or non-editable plan entries and never follows symlinks", async (t) => {
  const { root, vault, put, read, digest } = await curatedVault(t);
  const plan = await planTidy(vault, { accept: ["spelling"] });
  await put("shared/knowledge/beta.md", `${await read("shared/knowledge/beta.md")}edited after the plan\n`);
  const result = await applyTidy(vault, plan);
  assert.ok(result.refused.some((item) => item.path === "shared/knowledge/beta.md" && /changed since the plan/.test(item.reason)));
  assert.ok(result.changed.includes("shared/knowledge/alpha.md") && !result.changed.includes("shared/knowledge/beta.md"));
  assert.match(await read("shared/knowledge/beta.md"), /edited after the plan/);

  // Each forged entry carries the file's real hash and its real current tags, so nothing but the guard under test can refuse it.
  const forgedFor = async (rel) => {
    const bytes = await readFile(path.join(vault, rel));
    return { version: 1, id: "forged", edits: [{ path: rel, sha256: sha(bytes), tags: { before: readFrontmatterTags(bytes.toString("utf8")).tags, after: ["x"] } }] };
  };
  for (const rel of ["user/notes.md", "_meta/extra.md", "projects/demo/worktrees/main/2026-01-01-instruction-x.md", "projects/demo/weekly/2026-01.md"]) {
    const untouched = await digest(rel);
    const outcome = await applyTidy(vault, await forgedFor(rel));
    assert.equal(outcome.changed.length, 0, rel);
    assert.match(outcome.refused[0].reason, /not an editable note/, rel);
    assert.equal(await digest(rel), untouched, `${rel} must not be rewritten even by a plan that names it correctly`);
  }
  for (const rel of ["../outside.md", "/etc/passwd", "README.txt", "shared/knowledge/../../_meta/extra.md"]) {
    const outcome = await applyTidy(vault, { version: 1, id: "forged", edits: [{ path: rel, sha256: "0".repeat(64), tags: { before: [], after: ["x"] } }] });
    assert.deepEqual([outcome.changed.length, outcome.refused.length], [0, 1], rel);
  }
  // A symlink that leaves the vault, and one that stays inside it (so only the symlink guard can stop that one).
  await writeFile(path.join(root, "outside.md"), note("tags: [Agent-Vault]"));
  await symlink(path.join(root, "outside.md"), path.join(vault, "shared", "knowledge", "linked.md"));
  await symlink(path.join(vault, "shared", "knowledge", "gamma.md"), path.join(vault, "shared", "knowledge", "inner-link.md"));
  const outsideBefore = await readFile(path.join(root, "outside.md"), "utf8");
  const gammaBefore = await digest("shared/knowledge/gamma.md");
  for (const rel of ["shared/knowledge/linked.md", "shared/knowledge/inner-link.md"]) {
    const outcome = await applyTidy(vault, await forgedFor(rel));
    assert.deepEqual([outcome.changed.length, outcome.refused.length], [0, 1], rel);
  }
  assert.equal((await applyTidy(vault, await forgedFor("shared/knowledge/inner-link.md"))).refused[0].reason, "not a regular file", "an in-vault symlink is refused by the symlink guard itself");
  assert.equal(await readFile(path.join(root, "outside.md"), "utf8"), outsideBefore, "a symlink must never be written through");
  assert.equal(await digest("shared/knowledge/gamma.md"), gammaBefore, "nor a link to another note");
  assert.equal(await digest("user/notes.md"), sha(USER_NOTE));
  await assert.rejects(applyTidy(vault, { version: 2, edits: [] }), (error) => error.code === "invalid_plan");
  await assert.rejects(undoTidy(vault, "../../etc"), (error) => error.code === "invalid_backup");
  await assert.rejects(undoTidy(vault, "20260101-000000-abcdef"), (error) => error.code === "backup_not_found");
});

test("undo leaves notes alone that were edited after the tidy", async (t) => {
  const { vault, put, read } = await curatedVault(t);
  const plan = await planTidy(vault, { accept: ["spelling"] });
  const applied = await applyTidy(vault, plan);
  await put("shared/knowledge/gamma.md", `${await read("shared/knowledge/gamma.md")}later work\n`);
  const undone = await undoTidy(vault, applied.id);
  assert.ok(undone.skipped.some((item) => item.path === "shared/knowledge/gamma.md" && /edited since the tidy/.test(item.reason)));
  assert.match(await read("shared/knowledge/gamma.md"), /later work/);
  assert.ok(undone.restored.includes("shared/knowledge/alpha.md"));
});

test("only the ten newest backups are kept", async (t) => {
  const { vault, put, read } = await makeVault(t);
  await put("shared/knowledge/a.md", note("tags: [A-B]"));
  await put("shared/knowledge/b.md", note("tags: [a-b]"));
  for (let round = 0; round < 12; round++) {
    // Flip the spelling each round so every apply has something to change.
    const [from, to] = round % 2 === 0 ? ["a-b", "A-B"] : ["A-B", "a-b"];
    const plan = await planTidy(vault, { accept: [], merge: [`${from}=${to}`] });
    assert.ok((await applyTidy(vault, plan, { now: new Date(Date.UTC(2026, 0, 1, 0, 0, round)) })).changed.length > 0, `round ${round}`);
  }
  const backups = await listTidyBackups(vault);
  assert.equal(backups.length, 10);
  assert.equal(backups[0].at, "2026-01-01T00:00:11.000Z");
  assert.ok((await read("shared/knowledge/a.md")).includes("tags"));
});

test("accepted merges become aliases that doc_write and remember apply to new tags, but not to team or imported entries", async (t) => {
  const { vault, read } = await curatedVault(t);
  const plan = await planTidy(vault, { accept: ["spelling", "plural"] });
  await applyTidy(vault, plan);
  const aliases = readTagAliases(vault);
  assert.equal(aliases.agentvault, "Agent-Vault");
  assert.equal(aliases.memories, "memory");

  await writeMemory(vault, { path: "shared/knowledge/new-note.md", mode: "create", content: "fresh", title: "N", tags: ["agentvault", "Memories", "other"] });
  assert.match(await read("shared/knowledge/new-note.md"), /tags: \["Agent-Vault", "memory", "other"\]/);

  const written = await longTermWrite(vault, { project: "demo", title: "Aliased", content: "body", tags: ["agent-vault", "agentvault", "memories", "keep"] });
  const imported = await longTermWrite(vault, { project: "demo", title: "Imported", content: "body2", tags: ["agentvault"] }, { sourcePath: "legacy/imported.md" });
  const { openMemoryDb, getMemory, memoryDbFile } = await import("../lib/memory-db.mjs");
  const db = await openMemoryDb(memoryDbFile(vault));
  assert.deepEqual(getMemory(db, written.id).tags, ["Agent-Vault", "memory", "keep"]);
  assert.deepEqual(getMemory(db, imported.id).tags, ["agentvault"], "exact legacy imports keep their original tags");
  await assert.rejects(writeMemory(vault, { path: "shared/knowledge/secret.md", mode: "create", content: "x", tags: ["AKIA" + "ABCDEFGHIJKLMNOP"] }), (error) => error.code === "secret_detected");
});

test("a corrupt alias file is ignored instead of breaking writes", async (t) => {
  const { vault } = await makeVault(t);
  await mkdir(path.join(vault, ".agent-vault"), { recursive: true });
  for (const bad of ["{not json", '{"version":2,"aliases":{"a":"b"}}', '{"version":1,"aliases":{"Not Normalized":"x","ok":"two words","fine":"good"}}']) {
    await writeFile(path.join(vault, ".agent-vault", "tag-aliases.json"), bad);
    const aliases = readTagAliases(vault);
    assert.deepEqual(aliases, bad.includes("fine") ? { fine: "good" } : {});
  }
  const written = await writeMemory(vault, { path: "shared/knowledge/ok.md", mode: "create", content: "x", tags: ["fine", "other"] });
  assert.ok(written.created);
  assert.match(await readFile(path.join(vault, "shared/knowledge/ok.md"), "utf8"), /tags: \["good", "other"\]/);
});

test("diagnose reminds the owner to audit tags and links, and stops once the audit is fresh and clean", async (t) => {
  const { vault } = await curatedVault(t);
  const find = (report) => report.checks.find((check) => check.name === "tidy");
  const first = find(await diagnoseMemory(vault, {}));
  assert.equal(first.status, "info");
  assert.match(first.detail, /not been audited/);
  const audit = await auditVault(vault, { limit: 5 });
  await recordTidyAudit(vault, audit);
  const now = new Date(audit.auditedAt);
  const pending = find(await diagnoseMemory(vault, {}, { now }));
  assert.equal(pending.status, "info");
  assert.match(pending.detail, /\d+ safe tag merges, \d+ fixable and \d+ broken links/);
  assert.match(pending.fix, /tidy --plan/);
  const stale = find(await diagnoseMemory(vault, {}, { now: new Date(now.getTime() + 40 * 86_400_000) }));
  assert.match(stale.fix, /stale/);
  assert.equal(readTidyState(vault).summary.safeMerges, audit.tags.mergeCandidates.spelling.total);
  const clean = await makeVault(t, "clean");
  await clean.put("shared/knowledge/a.md", note("tags: [one]"));
  await recordTidyAudit(clean.vault, await auditVault(clean.vault));
  assert.equal(find(await diagnoseMemory(clean.vault, {})).status, "ok");
});

test("the CLI audits, previews, applies with --expect, lists backups, undoes, and rejects misuse (vault path with a space)", async (t) => {
  const { vault, read } = await curatedVault(t);
  const space = path.join(path.dirname(vault), "my vault");
  await exec("cp", ["-R", vault, space]);
  const run = async (...args) => {
    try { return { out: (await exec(process.execPath, [cli, "tidy", "--path", space, ...args], { env: { ...process.env, NODE_NO_WARNINGS: "1" } })).stdout, code: 0 }; }
    catch (error) { return { out: `${error.stdout}${error.stderr}`, code: error.code }; }
  };
  const audit = await run("--limit", "5");
  assert.match(audit.out, /Same name written differently/);
  assert.equal(readTidyState(space).version, 1, "an audit records its time for diagnose");
  assert.equal(JSON.parse((await run("--json", "--limit", "3")).out).scope.notes.legacy, 1);

  const preview = await run("--plan", "--fix-links", "safe");
  assert.match(preview.out, /rename {2}agent-vault {2}->/);
  const id = /--expect (\w{12})/.exec(preview.out)[1];
  assert.match(preview.out, new RegExp(`vault-cli tidy --apply --path '${space.replaceAll("/", "\\/")}' --accept spelling --fix-links safe --expect ${id}`));
  const before = await readFile(path.join(space, "shared/knowledge/alpha.md"), "utf8");
  assert.equal(await readFile(path.join(space, "shared/knowledge/alpha.md"), "utf8"), before, "--plan changes nothing");

  const refused = await run("--apply", "--fix-links", "safe", "--expect", "deadbeef0000");
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /plan is now/);
  assert.equal(await readFile(path.join(space, "shared/knowledge/alpha.md"), "utf8"), before);

  const applied = await run("--apply", "--fix-links", "safe", "--expect", id);
  assert.equal(applied.code, 0);
  const backup = /Backup (\S+)\./.exec(applied.out)[1];
  assert.match(applied.out, new RegExp(`--undo ${backup}`));
  assert.notEqual(await readFile(path.join(space, "shared/knowledge/alpha.md"), "utf8"), before);
  assert.match((await run("--backups")).out, new RegExp(backup));
  assert.match((await run("--apply", "--fix-links", "safe")).out, /Nothing to change/);

  assert.match((await run("--undo", backup)).out, /Restored 4 notes; aliases restored/);
  assert.equal(await readFile(path.join(space, "shared/knowledge/alpha.md"), "utf8"), before);

  for (const [args, pattern] of [
    [["--merge", "a=b"], /need --plan or --apply/],
    [["--plan", "--apply"], /not both/],
    [["--expect", "abc"], /--expect only applies with --apply/],
    [["--undo", "x", "--plan"], /cannot be combined/],
    [["--limit", "0"], /--limit must be an integer from 1 to 100/],
    [["--undo", "../../etc"], /backup id looks like/],
    [["--plan", "--accept", "bogus"], /accept values are/],
    [["--plan", "--merge", "ghost=other"], /No note uses the tag/],
    [["--plan", "--bogus"], /Unknown option/],
  ]) {
    const result = await run(...args);
    assert.notEqual(result.code, 0, args.join(" "));
    assert.match(result.out, pattern, args.join(" "));
  }
  assert.equal(await read("user/notes.md"), USER_NOTE, "the original vault was never involved");
});

async function startServer(t, vault) {
  const child = spawn(process.execPath, [serverPath, "--path", vault], { env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let buffer = "";
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const mine = ++id;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20_000);
    waiting.set(mine, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`);
  });
  return {
    request,
    call: async (name, args) => {
      const reply = await request("tools/call", { name, arguments: args });
      return { isError: reply.result.isError === true, body: JSON.parse(reply.result.content[0].text) };
    },
  };
}

test("the tidy MCP tool is read-only, previews a plan with the exact command, and rejects malformed input", async (t) => {
  const { vault, digest } = await curatedVault(t);
  const server = await startServer(t, vault);
  const tools = (await server.request("tools/list", {})).result.tools;
  const tool = tools.find((item) => item.name === "tidy");
  assert.match(tool.description, /Never edits anything/);
  assert.deepEqual(tool.inputSchema.properties.plan.properties.accept.items.enum, ["spelling", "plural", "typo"]);
  const watched = ["shared/knowledge/alpha.md", "shared/knowledge/beta.md", "projects/demo/worktrees/main/2026-01-01-instruction-x.md"];
  const before = await Promise.all(watched.map(digest));

  const audit = await server.call("tidy", { limit: 5 });
  assert.equal(audit.isError, false);
  assert.ok(audit.body.tags.mergeCandidates.spelling.total >= 2);
  assert.ok(audit.body.tags.mergeCandidates.spelling.items.length <= 5);
  assert.equal(readTidyState(vault).version, 1);

  const preview = await server.call("tidy", { limit: 5, plan: { accept: ["spelling"], fixLinks: "safe", drop: ["demo"] } });
  assert.equal(preview.isError, false);
  assert.ok(preview.body.plan.edits.length <= 5 && preview.body.plan.editsTotal >= 4);
  assert.match(preview.body.plan.applyCommand, new RegExp(`^vault-cli tidy --apply --path '.+' --accept spelling --drop 'demo' --fix-links safe --expect ${preview.body.plan.id}$`));
  assert.deepEqual(await Promise.all(watched.map(digest)), before, "previewing never edits a note");

  const empty = await server.call("tidy", { plan: { accept: [], merge: [] } });
  assert.equal(empty.body.plan.applyCommand, null, "nothing to do means no command to run");
  for (const bad of [{ limit: 0 }, { limit: 101 }, { plan: { accept: ["all"] } }, { plan: { merge: ["no-equals"] } }, { plan: { fixLinks: "everything" } }]) {
    const result = await server.call("tidy", bad);
    assert.equal(result.isError, true, JSON.stringify(bad));
    assert.equal(result.body.error, "invalid_arguments", JSON.stringify(bad));
  }
  const unknown = await server.call("tidy", { plan: { merge: ["ghost=other"] } });
  assert.equal(unknown.body.error, "unknown_tag");
});
