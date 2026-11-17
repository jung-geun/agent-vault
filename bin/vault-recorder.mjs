#!/usr/bin/env node

// OMP runs extensions in Bun, which does not provide node:sqlite. Keep persistence in
// the same Node runtime as the MCP server. Requests use stdin, never command-line content.
import path from "node:path";
import { autoRegisterProject, worktreeRecord } from "../lib/memory-store.mjs";
import { beginMemoryTask, endMemoryTask, recordToolUse } from "../lib/memory-tiers.mjs";
import { closeMemoryDbs } from "../lib/memory-db.mjs";

try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 64_000) throw new Error("Recorder request exceeds 64 KB.");
    chunks.push(chunk);
  }
  const { operation, vault, cwd, record, taskId, completed } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof vault !== "string" || !path.isAbsolute(vault) || typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Recorder requires absolute vault and cwd paths.");
  const warnings = [];
  let lifecycle;
  if (operation === "record") {
    const registration = await autoRegisterProject(vault, { cwd, harness: "omp" });
    if (registration.excludeWarning) warnings.push(`Marker exclude update failed: ${registration.excludeWarning}`);
    const result = await worktreeRecord(vault, { ...record, cwd });
    try { await recordToolUse(vault, "worktree_record", { cwd }, result); }
    catch { warnings.push("Record saved, but usage review accounting failed."); }
  } else if (operation === "task-start") {
    lifecycle = await beginMemoryTask(vault, { taskId, ownerPid: process.ppid });
  } else if (operation === "task-end") {
    if (typeof completed !== "boolean") throw new Error("Task completion requires a boolean completed value.");
    lifecycle = await endMemoryTask(vault, { taskId, completed });
  } else {
    throw new Error("Unknown recorder operation.");
  }
  process.stdout.write(JSON.stringify({ ok: true, warnings, ...lifecycle }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? "recorder_failed", message: error.message }));
  process.exitCode = 1;
} finally {
  closeMemoryDbs();
}
