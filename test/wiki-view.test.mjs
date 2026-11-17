import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { accessMetrics, deriveProvenance, matchesNote, parseAccessLog } = require("../integrations/obsidian/agent-vault-wiki/data.cjs");

test("access log parser ignores malformed rows and projects only safe fields", () => {
  const events = parseAccessLog([
    JSON.stringify({ ts: "2026-11-16T10:00:00.000Z", tool: "memory_search", role: "builder", paths: ["projects/alpha/wiki/topic.md"], query: "secret query", content: "private body" }),
    "{truncated",
    JSON.stringify({ ts: 12, tool: "memory_read" }),
  ].join("\n"));
  assert.equal(events.length, 1);
  assert.equal(events[0].role, "builder");
  assert.deepEqual(events[0].paths, ["projects/alpha/wiki/topic.md"]);
  assert.equal("query" in events[0], false);
  assert.equal("content" in events[0], false);
});

test("provenance labels authored properties separately from path inference", () => {
  assert.deepEqual(deriveProvenance("projects/alpha/agents/reviewer/memory.md"), {
    project: "alpha",
    projectSource: "path",
    role: "reviewer",
    roleSource: "path",
  });
  assert.deepEqual(deriveProvenance("shared/knowledge/redis.md", { project: "alpha", agent_role: "builder" }), {
    project: "alpha",
    projectSource: "frontmatter",
    role: "builder",
    roleSource: "frontmatter",
  });
});

test("per-note metrics count observed reads and report only logged creation", () => {
  const path = "projects/alpha/wiki/topic.md";
  const events = parseAccessLog([
    { ts: "2026-11-16T10:00:00.000Z", tool: "memory_search", role: "builder", paths: [path] },
    { ts: "2026-11-16T10:05:00.000Z", tool: "memory_read", path },
    { ts: "2026-11-16T10:06:00.000Z", tool: "memory_write", project: "alpha", role: "builder", path, created: true },
    { ts: "2026-11-16T10:07:00.000Z", tool: "memory_write", project: "alpha", role: "reviewer", path, created: false },
  ].map((event) => JSON.stringify(event)).join("\n"));
  assert.deepEqual(accessMetrics(events, path), {
    count: 2,
    lastAccess: "2026-11-16T10:05:00.000Z",
    createdByRole: "builder",
    createdByProject: "alpha",
  });
});

test("note filters match title, path, summary, project, role, and type", () => {
  const note = {
    title: "Queue retry guide",
    path: "projects/alpha/wiki/queue.md",
    summary: "Backoff policy",
    type: "concept",
    provenance: { project: "alpha", role: "builder" },
  };
  assert.equal(matchesNote(note, "retry", "alpha", "builder", "concept"), true);
  assert.equal(matchesNote(note, "retry", "beta", "builder", "concept"), false);
  assert.equal(matchesNote(note, "missing", "", "", ""), false);
  assert.equal(matchesNote(note, "", "", "", "curated"), true);
  assert.equal(matchesNote({ ...note, type: "report" }, "", "", "", "curated"), false);
  const inferred = { ...note, provenance: { project: null, role: null } };
  assert.equal(matchesNote(inferred, "", "alpha", "builder", "concept", { project: "alpha", role: "builder" }), true);
});
