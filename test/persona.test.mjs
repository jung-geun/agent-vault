import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { activeMemoryTasks, closeMemoryDbs, finishMemoryTask, memoryDbFile, openMemoryDb, startMemoryTask } from "../lib/memory-db.mjs";
import { createProject } from "../lib/memory-store.mjs";
import { initVault } from "../lib/vault-core.mjs";
import { saveSettings } from "../lib/settings.mjs";
import { applyPersona, observePersona, readPersona, resolvePersona } from "../lib/persona.mjs";

const code = (expected) => (error) => error.code === expected;
const at = (date) => ({ now: new Date(date) });
const observation = (extra = {}) => ({ category: "question_style", pattern: "concise-questions", guidance: "Ask one direct question at a time.", sourceKind: "observation", evidence: "memory:1", ...extra });
const preference = (extra = {}) => observation({ sourceKind: "user_preference", ...extra });

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-vault-persona-")));
  t.after(async () => { closeMemoryDbs(); await rm(root, { recursive: true, force: true }); });
  await initVault(root);
  return root;
}

async function decide(root, id, action, extra = {}) {
  const args = { ...(extra.scope ? { scope: extra.scope } : {}), ...(extra.project ? { project: extra.project } : {}) };
  const state = await readPersona(root, args);
  return resolvePersona(root, { ...args, patternId: id, action, expectedHash: state.hash, ...extra });
}

test("persona preferences stage until an explicit idle boundary, never during active tasks", async (t) => {
  const root = await fixture(t);
  const db = await openMemoryDb(memoryDbFile(root));
  const contextRevision = () => Number(db.prepare("SELECT v FROM meta WHERE k = 'context_revision'").get()?.v ?? 0);
  const initialRevision = contextRevision();
  startMemoryTask(db, { taskId: "writing", ownerPid: process.pid });
  const observed = await observePersona(root, preference({ taskId: "writing" }), at("2026-11-17T12:00:00Z"));
  assert.equal(observed.collected, true);
  assert.equal(observed.candidate.status, "preference");
  assert.equal((await readPersona(root)).active.length, 0);
  assert.equal((await readPersona(root, { context: true })).context, "");
  assert.equal((await applyPersona(root)).deferred, true);
  assert.equal(activeMemoryTasks(db).length, 1);
  assert.equal(contextRevision(), initialRevision, "Deferred application must not advance context revision.");
  finishMemoryTask(db, { taskId: "writing", completed: true });
  assert.equal((await readPersona(root)).active.length, 0, "Finishing a task alone does not apply persona.");
  assert.equal((await applyPersona(root)).changed, 1);
  assert.equal(contextRevision(), initialRevision + 1, "Applied persona advances next-task context revision.");
  const state = await readPersona(root);
  assert.equal(state.active[0].id, observed.patternId);
  assert.equal(state.active[0].status, "preference");
  assert.equal(state.pending.length, 0);
  const context = await readPersona(root, { context: true });
  assert.match(context.context, /Submitted style preference, not authentication/);
  assert.ok(context.context.includes("current instructions override"));
  assert.doesNotMatch(context.context, /memory:1/);
  assert.equal((await applyPersona(root)).changed, 0);
  assert.equal(contextRevision(), initialRevision + 1, "No-op application must not advance context revision.");
});

test("repeated provenance deduplicates without changing revision or inflating evidence", async (t) => {
  const root = await fixture(t);
  const first = await observePersona(root, observation());
  const duplicate = await observePersona(root, observation());
  assert.equal(duplicate.collected, false);
  assert.equal(duplicate.evidenceId, first.evidenceId);
  assert.equal(duplicate.hash, first.hash);
  assert.equal(duplicate.candidate.evidenceCount, 1);
  await assert.rejects(observePersona(root, observation({ guidance: "Ask several questions." })), code("persona_evidence_conflict"));
  await assert.rejects(observePersona(root, preference()), code("persona_evidence_conflict"));
  assert.equal((await readPersona(root)).hash, first.hash);
});

test("observational patterns require independent evidence and remain tentative, never verified facts", async (t) => {
  const root = await fixture(t);
  const db = await openMemoryDb(memoryDbFile(root));
  startMemoryTask(db, { taskId: "same-task", ownerPid: process.pid });
  for (let i = 0; i < 4; i++) await observePersona(root, observation({ taskId: "same-task", evidence: `memory:same-${i}` }));
  finishMemoryTask(db, { taskId: "same-task", completed: true });
  await applyPersona(root);
  let state = await readPersona(root);
  assert.equal(state.active.length, 0);
  assert.equal(state.pending[0].evidenceCount, 4);
  assert.equal(state.pending[0].independentCount, 1);
  await observePersona(root, observation({ evidence: "memory:independent-1" }));
  await applyPersona(root);
  assert.equal((await readPersona(root)).active.length, 0);
  await observePersona(root, observation({ evidence: "memory:independent-2" }));
  assert.equal((await readPersona(root)).active.length, 0);
  await applyPersona(root);
  state = await readPersona(root);
  assert.equal(state.active[0].status, "tentative");
  assert.equal(state.active[0].independentCount, 3);
  assert.match((await readPersona(root, { context: true })).context, /Tentative behavioral suggestion, not fact/);
  assert.equal("verified" in state.active[0], false);
});

test("project profiles and global profile never leak across namespaces", async (t) => {
  const root = await fixture(t);
  await createProject(root, { project: "alpha", title: "Alpha" });
  await createProject(root, { project: "beta", title: "Beta" });
  await observePersona(root, preference({ scope: "project", project: "alpha", guidance: "Use Alpha naming." }));
  await observePersona(root, preference({ guidance: "Use global concise questions." }));
  await applyPersona(root, { scope: "project", project: "alpha" });
  assert.match((await readPersona(root, { scope: "project", project: "alpha", context: true })).context, /Alpha/);
  assert.equal((await readPersona(root, { scope: "project", project: "beta", context: true })).context, "");
  assert.equal((await readPersona(root, { context: true })).context, "");
  await applyPersona(root);
  assert.doesNotMatch((await readPersona(root, { context: true })).context, /Alpha/);
  await assert.rejects(readPersona(root, { scope: "project", project: "missing" }), code("project_unresolved"));
  await assert.rejects(observePersona(root, preference({ scope: "team" })), code("invalid_persona_scope"));
  await assert.rejects(readPersona(root, { project: "alpha" }), code("invalid_persona_scope"));
});

test("conflicting guidance never silently overrides; explicit choice remains staged", async (t) => {
  const root = await fixture(t);
  const first = await observePersona(root, preference());
  await applyPersona(root);
  await observePersona(root, observation({ evidence: "memory:opposite", guidance: "Ask all clarifying questions together." }));
  assert.equal((await readPersona(root)).active[0].guidance, first.candidate.guidance, "Midtask snapshot does not change.");
  assert.equal((await readPersona(root)).pending[0].conflict, true);
  await applyPersona(root);
  const conflict = await readPersona(root);
  assert.equal(conflict.active.length, 0);
  assert.equal(conflict.pending[0].status, "conflict");
  assert.equal(conflict.pending[0].variants.length, 2);
  assert.match(conflict.warnings.join(" "), /explicit submitted resolution/);
  await assert.rejects(resolvePersona(root, { patternId: first.patternId, expectedHash: conflict.hash, action: "accept" }), code("persona_conflict"));
  await decide(root, first.patternId, "accept", { guidance: "Ask questions one at a time unless requested otherwise." });
  assert.equal((await readPersona(root)).active.length, 0);
  assert.equal((await readPersona(root)).pending[0].decision.staged, true);
  await applyPersona(root);
  const accepted = await readPersona(root);
  assert.equal(accepted.active[0].status, "accepted");
  assert.equal(accepted.active[0].sourceKind, "submitted_decision");
  assert.match((await readPersona(root, { context: true })).context, /Submitted style decision, not authentication/);
  await observePersona(root, observation({ evidence: "memory:new-counterexample", guidance: "Ask all questions together without exception." }));
  await applyPersona(root);
  assert.equal((await readPersona(root)).active.length, 0, "New contradictory evidence reopens conflict.");
});

test("conflicting observational variants do not combine counts toward adoption", async (t) => {
  const root = await fixture(t);
  for (let i = 0; i < 3; i++) await observePersona(root, observation({ evidence: `memory:a-${i}` }));
  await observePersona(root, observation({ evidence: "memory:b", guidance: "Ask every question together." }));
  await applyPersona(root);
  const result = await readPersona(root);
  assert.equal(result.active.length, 0);
  assert.equal(result.pending[0].status, "conflict");
});

test("stale review hashes reject concurrent observations and decisions", async (t) => {
  const root = await fixture(t);
  const observed = await observePersona(root, observation());
  const stale = await readPersona(root);
  await observePersona(root, observation({ evidence: "memory:2" }));
  await assert.rejects(resolvePersona(root, { patternId: observed.patternId, action: "accept", expectedHash: stale.hash }), code("hash_mismatch"));
  const first = await decide(root, observed.patternId, "accept");
  await resolvePersona(root, { patternId: observed.patternId, action: "disable", expectedHash: first.hash });
  await assert.rejects(resolvePersona(root, { patternId: observed.patternId, action: "reject", expectedHash: first.hash }), code("hash_mismatch"));
  await applyPersona(root);
  assert.equal((await readPersona(root)).active.length, 0);
});

test("reject and disable survive fresh evidence and only explicit acceptance reactivates", async (t) => {
  const root = await fixture(t);
  const observed = await observePersona(root, preference());
  await applyPersona(root);
  await decide(root, observed.patternId, "reject");
  assert.equal((await readPersona(root)).active.length, 1);
  await applyPersona(root);
  assert.equal((await readPersona(root)).pending[0].status, "rejected");
  await observePersona(root, preference({ evidence: "memory:another" }));
  await applyPersona(root);
  assert.equal((await readPersona(root)).active.length, 0);
  await decide(root, observed.patternId, "accept");
  await applyPersona(root);
  assert.equal((await readPersona(root)).active.length, 1);
  await decide(root, observed.patternId, "disable");
  await applyPersona(root);
  assert.equal((await readPersona(root)).pending[0].status, "disabled");
});

test("disabled settings stop collection, review application and context without deleting history", async (t) => {
  const root = await fixture(t);
  const observed = await observePersona(root, preference());
  await applyPersona(root);
  const before = await readPersona(root);
  await saveSettings(root, { persona: { enabled: false } });
  assert.deepEqual(await observePersona(root, preference({ evidence: "memory:disabled" })), { enabled: false, staged: false, collected: false });
  assert.equal((await resolvePersona(root, { patternId: observed.patternId, expectedHash: before.hash, action: "disable" })).staged, false);
  assert.equal((await applyPersona(root)).enabled, false);
  assert.equal((await readPersona(root, { context: true })).context, "");
  assert.deepEqual((await readPersona(root)).active, []);
  await saveSettings(root, { persona: { enabled: true } });
  const after = await readPersona(root);
  assert.equal(after.hash, before.hash);
  assert.equal(after.active[0].evidenceCount, 1);
});

test("configured evidence threshold and compact context budget take effect", async (t) => {
  const root = await fixture(t);
  await saveSettings(root, { persona: { minObservations: 2, maxContextChars: 500 } });
  await observePersona(root, observation());
  await observePersona(root, observation({ evidence: "memory:2" }));
  await applyPersona(root);
  assert.equal((await readPersona(root)).active[0].status, "tentative");
  const context = await readPersona(root, { context: true, maxChars: 20_000 });
  assert.ok(context.context.length <= 500);
  const tiny = await readPersona(root, { context: true, maxChars: 10 });
  assert.equal(tiny.context, "");
  assert.equal(tiny.truncated, true);
  assert.equal((await readPersona(root, { context: true, maxChars: 0 })).context, "");
});

test("full profiles and context remain bounded and preserve review identifiers", async (t) => {
  const root = await fixture(t);
  for (let i = 0; i < 20; i++) await observePersona(root, preference({ pattern: `pattern-${i}`, guidance: `Use concise questions for case ${i}.`, evidence: `memory:${i}` }));
  let state = await readPersona(root, { maxChars: 3000 });
  assert.ok(JSON.stringify(state).length <= 3000);
  assert.equal(state.truncated, true);
  assert.ok(state.pending.length > 0);
  assert.ok(state.pending.every((item) => item.id > 0 && (item.truncated || item.evidence[0].reference.startsWith("memory:"))));
  await applyPersona(root);
  const context = await readPersona(root, { context: true, maxChars: 700 });
  assert.ok(context.context.length <= 700);
  assert.equal(context.truncated, true);
  assert.equal("pending" in context, false);
  assert.equal("evidence" in context, false);
  state = await readPersona(root, { maxChars: 1024 });
  assert.ok(JSON.stringify(state).length <= 1024);
});

test("persona evidence is immutable and profile survives database reopen", async (t) => {
  const root = await fixture(t);
  const observed = await observePersona(root, preference());
  await decide(root, observed.patternId, "accept");
  await applyPersona(root);
  const before = await readPersona(root);
  let db = await openMemoryDb(memoryDbFile(root));
  assert.throws(() => db.prepare("UPDATE persona_evidence SET guidance = 'replacement' WHERE id = ?").run(observed.evidenceId), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM persona_evidence WHERE id = ?").run(observed.evidenceId), /immutable/);
  assert.throws(() => db.prepare("UPDATE persona_decisions SET action = 'disable'").run(), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM persona_decisions").run(), /immutable/);
  closeMemoryDbs();
  assert.equal((await readPersona(root)).hash, before.hash);
  assert.deepEqual((await readPersona(root)).active, before.active);
  db = await openMemoryDb(memoryDbFile(root));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM persona_evidence").get().n, 1);
});

test("secret-looking values are refused in every stored text field", async (t) => {
  const root = await fixture(t);
  const secret = `ghp_${"x".repeat(36)}`;
  for (const name of ["pattern", "guidance", "evidence", "taskId"]) {
    await assert.rejects(observePersona(root, observation({ [name]: secret })), code("secret_detected"));
  }
  const observed = await observePersona(root, preference());
  await assert.rejects(decide(root, observed.patternId, "accept", { guidance: secret }), code("secret_detected"));
  assert.equal((await readPersona(root)).pending[0].evidenceCount, 1);
});

test("persona rejects sensitive inference, raw multiline bodies, invalid fields and unknown tasks", async (t) => {
  const root = await fixture(t);
  for (const guidance of ["User has ADHD.", "Infer religion from work hours.", "User is 42-year-old.", "User has a mental health diagnosis."]) {
    await assert.rejects(observePersona(root, observation({ guidance })), code("persona_sensitive"));
  }
  for (const args of [
    { category: "personality" }, { pattern: "" }, { guidance: "x".repeat(601) }, { evidence: "" },
    { evidence: "raw prompt\nbody" }, { guidance: "```raw code```" }, { sourceKind: "verified" },
  ]) await assert.rejects(observePersona(root, observation(args)), code("invalid_persona"));
  await assert.rejects(observePersona(root, observation({ taskId: "not-recorded" })), code("invalid_memory_task"));
  await assert.rejects(readPersona(root, { context: "true" }), code("invalid_persona"));
  await assert.rejects(readPersona(root, { context: true, maxChars: -1 }), code("invalid_persona"));
  await assert.rejects(readPersona(root, { maxChars: 0 }), code("invalid_persona"));
  await assert.rejects(observePersona(root, observation(), { now: new Date("invalid") }), code("invalid_persona"));
});

test("work-hour guidance stays non-authorizing and cross-scope resolutions are refused", async (t) => {
  const root = await fixture(t);
  await createProject(root, { project: "alpha", title: "Alpha" });
  const observed = await observePersona(root, preference({ category: "work_hours", guidance: "Prefer short status summaries late in the evening." }));
  const project = await readPersona(root, { scope: "project", project: "alpha" });
  await assert.rejects(resolvePersona(root, { scope: "project", project: "alpha", patternId: observed.patternId, expectedHash: project.hash, action: "accept" }), code("persona_not_found"));
  await applyPersona(root);
  assert.match((await readPersona(root, { context: true })).context, /Work hours never authorize scheduling or actions/);
});

test("oversized conflicts retain bounded variants and compact review identities", async (t) => {
  const root = await fixture(t);
  let observed;
  for (let i = 0; i < 50; i++) {
    observed = await observePersona(root, observation({
      guidance: `Case ${i}: ${"Use a concise response. ".repeat(20)}`,
      evidence: `memory:conflict-${i}`,
    }));
  }
  assert.equal(observed.candidate.conflict, true);
  assert.equal(observed.candidate.variantCount, 50);
  assert.equal(observed.candidate.variants.length, 5);
  assert.equal(observed.candidate.variantsTruncated, true);
  assert.ok(JSON.stringify(observed).length < 10_000, "Observation responses must not return every historical variant.");
  const detailed = await readPersona(root, { maxChars: 20_000 });
  assert.equal(detailed.pending[0].id, observed.patternId);
  assert.equal(detailed.pending[0].variantCount, 50);
  assert.equal(detailed.pending[0].variants.length, 5);
  const compact = await readPersona(root, { maxChars: 1024 });
  assert.ok(JSON.stringify(compact).length <= 1024);
  assert.equal(compact.pending[0].id, observed.patternId);
  assert.equal(compact.pending[0].conflict, true);
  assert.equal(compact.pending[0].evidenceCount, 50);
  assert.equal(compact.pending[0].truncated, true);
  await resolvePersona(root, {
    patternId: compact.pending[0].id, action: "accept", expectedHash: compact.hash,
    guidance: "Use concise responses unless current instructions request detail.",
  });
  await applyPersona(root);
  assert.equal((await readPersona(root)).active[0].status, "accepted");
});

test("scoped pattern reads inspect candidates omitted from a bounded profile", async (t) => {
  const root = await fixture(t);
  await createProject(root, { project: "alpha", title: "Alpha" });
  let last;
  for (let i = 0; i < 12; i++) {
    last = await observePersona(root, preference({
      pattern: `selected-${i}`, evidence: `memory:selected-${i}`, guidance: `Use concise response ${i}.`,
    }));
  }
  const bounded = await readPersona(root, { maxChars: 1024 });
  assert.equal(bounded.pending.some((item) => item.id === last.patternId), false);
  const selected = await readPersona(root, { patternId: last.patternId });
  assert.equal(selected.pending.length, 1);
  assert.equal(selected.pending[0].id, last.patternId);
  assert.equal(selected.pending[0].evidence[0].reference, "memory:selected-11");
  assert.equal(selected.hash, bounded.hash);
  await applyPersona(root);
  const active = await readPersona(root, { patternId: last.patternId });
  assert.equal(active.active.length, 1);
  assert.equal(active.active[0].id, last.patternId);
  assert.equal(active.active[0].evidence[0].reference, "memory:selected-11");
  assert.equal(active.pending.length, 0);
  await assert.rejects(readPersona(root, { scope: "project", project: "alpha", patternId: last.patternId }), code("persona_not_found"));
  await assert.rejects(readPersona(root, { patternId: last.patternId + 100 }), code("persona_not_found"));
  for (const patternId of [0, -1, "1", 1.5, null]) {
    await assert.rejects(readPersona(root, { patternId }), code("invalid_persona"));
  }
  await assert.rejects(readPersona(root, { patternId: last.patternId, context: true }), code("invalid_persona"));
});

test("persona evidence accepts 500-character provenance and rejects larger references", async (t) => {
  const root = await fixture(t);
  const observed = await observePersona(root, observation({ evidence: `memory:${"x".repeat(493)}` }));
  assert.equal(observed.candidate.evidence[0].reference.length, 500);
  await assert.rejects(observePersona(root, observation({ evidence: `memory:${"x".repeat(494)}` })), code("invalid_persona"));
});

test("coding race and diagnosis guidance remains valid without allowing personal-attribute claims", async (t) => {
  const root = await fixture(t);
  const accepted = [
    "Prefer race-condition tests.",
    "Explain the bug diagnosis.",
    "Infer race conditions from execution traces.",
    "The user requests race-condition tests.",
    "Discuss diagnosed compiler failures before suggesting a fix.",
  ];
  for (let i = 0; i < accepted.length; i++) {
    const result = await observePersona(root, preference({
      category: "coding_style", pattern: `coding-case-${i}`, guidance: accepted[i], evidence: `memory:coding-case-${i}`,
    }));
    assert.equal(result.collected, true);
  }
  for (const guidance of [
    "Infer the user's race from code.",
    "Their diagnosis changes question style.",
    "User has a diagnosis.",
    "User was diagnosed from these messages.",
    "Infer race from work hours.",
    "diagnosis: speculative personal attribute",
  ]) await assert.rejects(observePersona(root, observation({ guidance })), code("persona_sensitive"));
  await applyPersona(root);
  assert.equal((await readPersona(root)).active.length, accepted.length);
});
