# Agent Vault Specification: Hooks, MCP Tools, and Timing

This document describes what Agent Vault does, when it does it, and which component does it. It is derived from the current source (`integrations/omp/agent-vault-recorder.ts`, `bin/vault-recorder.mjs`, `bin/vault-mcp.mjs`, `lib/memory-tiers.mjs`, `lib/memory-db.mjs`, `lib/weekly-memory.mjs`, `lib/persona.mjs`, `lib/access-guard.mjs`, `lib/settings.mjs`). Where behavior depends on the host, the document says so. Anything not listed here is not guaranteed.

Translations of the user guide: [English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md). Agent-facing procedures are in [SKILL.md](SKILL.md).

## 1. Components and Responsibilities

| Component | What it is | Responsibility |
| --- | --- | --- |
| Skill (`SKILL.md`) | Instructions loaded by the agent | Tells the agent how to route requests (`setup`, `install`, `recall`, ...) and which tools to call. It performs no work itself. |
| CLI (`bin/vault-cli.mjs`) | Local Node program run by the agent | One-time administration: `setup`, `config`, `install`, `memory migrate/query/sleep`, `persona`. |
| MCP server (`bin/vault-mcp.mjs`) | Local stdio server started by the host with Node | All runtime memory reads and writes, review handling, task lifecycle calls. |
| Hooks | Host lifecycle callbacks | Automatically record instructions and edits, open and close task boundaries, and (OMP only) block direct vault access. |
| Storage | SQLite plus Markdown | Durable knowledge, journals, persona evidence and review receipts live in SQLite at `<vault>/.agent-vault/memory.db`. Notes, profile, standards, short-term memory and generated weekly views are Markdown. |

Requirements: Node.js `^22.13.0 || >=23.4.0` (`node:sqlite`).

The skill is guidance, the MCP server is the only supported memory interface, and hooks are optional automation. Without MCP the agent must stop memory operations; it must not fall back to reading vault files, SQLite, or shell commands.

## 2. Hook Support by Host

| Host | Hooks installed by Agent Vault | How task boundaries work |
| --- | --- | --- |
| OMP | Yes. `install --global` installs `~/.omp/agent/extensions/agent-vault-recorder.ts`, the user rule, and an MCP entry with `AGENT_VAULT_HARNESS=omp`. | Automatic, described in section 3. |
| Claude Code, Codex, Cursor, other | No. Agent Vault does not write hook configuration for these hosts. | Only if the host exposes lifecycle events and the agent or user wires `memory_task_start` / `memory_task_end` to them. Otherwise `vault_context` reports `lifecycle.status: "not_connected"` and maintenance runs only through an explicit `memory_sleep` while all tasks are idle. |

The agent must verify hook status with `vault_context` (`memoryMaintenance.lifecycle.status` is `connected`, `ambiguous`, or `not_connected`). A written config or an MCP connection alone does not prove that hooks are active.

## 3. OMP Hook Events

The extension subscribes to five host events. Persistence is delegated to `bin/vault-recorder.mjs`, a Node child process, because OMP's extension host (Bun) has no `node:sqlite`. Each request is sent on stdin (limit 64 KB, timeout 60 s) and never on the command line.

| Event | Condition | Action |
| --- | --- | --- |
| `before_agent_start` | Only when `reason` is `"prompt"`. Parked-subagent `revive` starts are ignored. | 1. If an active task exists for a different cwd or vault, close it with `completed=false`. 2. If no task is active, generate a UUID and call `task-start`; on success it becomes the active task. 3. If the prompt text is non-empty, auto-register the project according to the join mode, then write a worktree record of kind `instruction` (title is the first line, at most 120 characters; content is at most 4000 characters). |
| `tool_call` | Every tool call. | 1. Run the access guard (section 8); a violation returns `{block: true}` and the call does not run. 2. For `edit`, `write`, `ast_edit`, remember the resolved target path against the call ID. |
| `tool_execution_end` | After each tool call. | If the call was an edit tool and did not error, add its file to the pending set. Failed edits are not recorded. |
| `turn_end` | End of every model turn. | Flush: if the pending set is non-empty, write one worktree record of kind `implementation` titled `Edited N file(s)`, listing the files relative to cwd and the first line of the triggering prompt. Does not close the task. |
| `agent_end` | Skipped when no task is active or when `willContinue` is true. | Flush, then close the task. `completed` is `true` only if the final assistant message after the last user message has `stopReason: "stop"`; any other end (error, abort, length) is `completed=false`. |

Key properties:

- The task ID is attached to records only when the active task matches the current vault and cwd, so business-week attribution is unambiguous.
- Records are best effort. A failure (no resolved project, credential-shaped content refused, worker error, timeout) raises a UI warning and is skipped. Nothing is guessed and the user's task is not blocked.
- If `task-start` fails the agent still works, but the task is not registered, `vault_context` reports `not_connected`, and no end-of-task maintenance happens.
- Investigation records are model-driven (`worktree_record`), not hook-driven.

## 4. Task Lifecycle

A task is one logical unit of agent work, registered with the vault so maintenance never interrupts it.

### 4.1 Start (`memory_task_start`, hook `task-start`)

- Requires an initialized vault (`_meta` directory); otherwise returns `started: false, reason: "vault_not_initialized"`.
- Registers `taskId` with the owner process ID. The ID must be kept across retries; a finished ID cannot be reused (`memory_task_closed`) and a different owner PID is refused (`memory_task_owner_mismatch`).
- Cancels active tasks whose owner process no longer exists (`kill(pid, 0)` returns ESRCH), so crashed sessions do not block maintenance forever.
- Pins the task to its business week (ISO `YYYY-WW`, Monday to Sunday, in the configured timezone, with a `workdayStart` default of `09:00`). A task keeps the week it started in even if it runs past Monday.
- `parentTaskId` lets a child inherit an active parent's week. `resumeTaskId` lets a new task continue a cancelled or interrupted task; a completed task cannot be resumed into an old week.

### 4.2 End (`memory_task_end`, hook `task-end`)

- Intended only for the terminal settle of a task. Never call it on a turn end or an automatic retry.
- `completed=false` (cancel or error): the task is closed and no maintenance runs.
- `completed=true` and other tasks are still active: the task is closed and maintenance is deferred.
- `completed=true` and no other task is active: maintenance runs in this order.
  1. For each namespace (scope, project, role) that has pending review tickets or staged review actions, run the sleep pass (section 5.3).
  2. Regenerate weekly Markdown views and apply retention.
  3. Apply persona guidance.
- Maintenance errors never fail the task end. Each step reports `deferred` with an error code, and the OMP hook shows warnings.

## 5. Review and Maintenance Timing

### 5.1 What creates a review ticket

Counts and age only schedule a review; they never prove that knowledge is true.

- Every successful call to `memory_read`, `memory_search`, `memory_list`, `memory_write`, `memory_query`, `short_memory_read/write`, `long_memory_read/search/write`, `agent_memory_read/write`, `agent_handoff`, `log_write`, `worktree_record`, `worktree_list`, and `vault_context` counts once per touched namespace. Review bookkeeping tools do not count themselves.
- Defaults (`settings.review`): thresholds `[5, 10, 20]`, then every `20` operations; short-term memory is stale after `14` days; a memory is a skill candidate after `10` reads. All are configurable with `vault-cli config`.
- Crossing a milestone creates a **pending** ticket. A stale short-term note also creates a ticket (`stale-short-term`) when it has not already been reviewed or deferred at its current hash.
- `memory_reconsider` creates a ticket from a correction at any count. The feedback is stored separately and the original memory is not replaced.
- `memory_review`, `vault_context` (once per scope it loads), and the sleep pass all evaluate review state first. That evaluation can enqueue a pending `stale-short-term` ticket, **even while tasks are active**. The task barrier below blocks consolidation, release and application, not this bookkeeping.
- `long_memory_search`, `long_memory_read`, and `memory_query` (knowledge rows only) also increment each returned memory's `read_count` and set `last_read_at`. `read_count` feeds skill-candidate detection. The `vault_context` preload does not increment it.

### 5.2 Ticket states

| State | Meaning | Who can act |
| --- | --- | --- |
| Pending | Threshold crossed. Not yet released. | Nobody. `vault_context` never exposes pending work as immediate work. |
| Ready | Released at a task boundary. | The next task's first `vault_context` for the same role delivers it (`memoryMaintenance.reviewWork`), only for tickets released before that task started. |
| Staged | The agent submitted a decision with `memory_review_resolve` while tasks were active or the ticket was not ready. | Applied automatically at the next successful idle boundary. |
| Resolved | Applied, with a receipt. | Read with `memory_review` and `reviewId`. |

### 5.3 The sleep pass (`memory_sleep` or end of a completed task)

- The review state is evaluated first, before any idle check. This can enqueue a stale-short-term ticket even when the pass is then deferred.
- If any task is active, returns `deferred: true`. It performs no duplicate archiving, ticket release, or action application. Bookkeeping already described above may still have occurred.
- If nothing is pending or staged, returns `skipped` with reason `not_due`.
- Otherwise: archive exact duplicate memories, release pending tickets to ready, and apply staged review actions. Applying an action fails with `maintenance_deferred` if tasks became active again; the action stays staged.
- `memory_sleep` additionally runs weekly-view and persona maintenance, which defer on their own when any task is active. The task-end path runs the per-namespace pass without them and then runs them once.
- No model runs and no stored instruction is executed. The pass is deterministic.

### 5.4 What the agent does with a ready ticket

At the start of a task, inspect `reviewWork`, read source evidence, then stage a decision with `memory_review_resolve`. Actions are `keep`, `archive`, `supersede`, `promote`, `skill`, and `defer`. Rules enforced by the server:

- Correction reviews must name the challenged `memoryId` and include a structured `assessment` that compares alternatives, evidence, scope, and limits.
- `defer` records uncertainty and leaves the source knowledge unchanged. Insufficient evidence must defer rather than replace.
- A user report alone is not sufficient to replace a factual memory; user preferences are not external factual disputes.
- Promoting short-term memory requires the current `expectedHash` from `short_memory_read`.
- New feedback that arrives after a proposal blocks application until reassessed (`feedback_changed`).

## 6. MCP Tool Reference

Each tool validates its arguments against a JSON schema. A successful call is also recorded for usage counting and, for a fixed set of tools, appended to the vault access log (disable with `AGENT_VAULT_DISABLE_ACCESS_LOG=1`). Results larger than the response budget return `result_too_large`; reduce `limit`/`maxChars` or read with `offset`.

### 6.0 State-change vocabulary

Timing column: **Now** changes stored content or registration immediately; **Boundary** applies its effect only at a safe task boundary (staging may happen earlier); **Read** returns data without changing knowledge or document content and without applying maintenance.

**Read does not mean side-effect free.** Any successful call to a counted tool (section 5.1) updates usage counters and may create a pending review ticket. In addition:

- `vault_context` may auto-register the project, may enqueue a stale-short-term ticket, and may claim the once-per-task review delivery.
- `long_memory_search`, `long_memory_read`, `memory_query` update `read_count` and `last_read_at` on returned knowledge.
- A fixed set of tools append an event to the vault access log.
- Failure of usage accounting does not fail the call; the result carries `memoryAccountingWarning`.

None of these rewrite or replace knowledge content, release tickets, or apply review decisions.

### 6.1 Context and lifecycle

| Tool | Does | Timing |
| --- | --- | --- |
| `vault_context` | Loads profile, coding standards, project index, short-term memory, recent long-term memory, persona guidance, review state and lifecycle status within a character budget. Auto-registers the project per join mode when called with a working directory. The first call per registered task and role delivers prior-boundary ready review work. | Read (registration is Now) |
| `memory_task_start` | Registers a task and pins its business week. | Now |
| `memory_task_end` | Closes a task and, if completed and idle, runs maintenance. | Boundary |
| `memory_sleep` | Runs due maintenance only when every task is idle. | Boundary |

### 6.2 Documents, short-term and long-term memory

| Tool | Does | Timing |
| --- | --- | --- |
| `memory_search`, `memory_list`, `memory_read` | Search, list, and read Markdown notes with hashes. | Read |
| `memory_write` | Create, append, or replace a note under `projects/`, `shared/knowledge/`, or `user/` (`user/` is append-only). Replace requires `expectedHash`. | Now |
| `short_memory_read` / `short_memory_write` | Read or replace Markdown working state (project or global, optional role) with hash, last-written time and staleness. | Now |
| `long_memory_write` | Store an immutable durable SQLite memory (project, global, optional role, or explicitly configured team). Returns `memory:id`. | Now |
| `long_memory_search` / `long_memory_read` | Search active memories in one exact namespace, or read by id including archived and superseded sources. Results carry `knowledgeReview` warnings for unresolved corrections. | Read |
| `agent_memory_read` / `agent_memory_write` | Per-role durable entries. | Read / Now |

### 6.3 Journals and history

| Tool | Does | Timing |
| --- | --- | --- |
| `worktree_record` | Store an immutable worktree entry (instruction, implementation, investigation) pinned to the active task's week. | Now |
| `worktree_list` | List worktrees with record counts and latest `memory:id`. | Read |
| `log_write` | Immutable QA, work, review, or incident log. Use only after a check actually ran. | Now |
| `agent_handoff` | Immutable handoff between roles. | Now |
| `memory_query` | Query SQLite knowledge and journals by inclusive date range, pinned week, keyword and kind. Works after weekly Markdown has been pruned. No arbitrary SQL. | Read |

Weekly Markdown (`projects/<id>/weekly/YYYY-WW.md`, `shared/knowledge/weekly/`) is a generated view of SQLite, written during maintenance, retained for 1 to 6 months (default 3). Only generated files that were not modified are deleted; modified files are preserved and reported as conflicts; SQLite rows are never deleted by retention.

### 6.4 Review and correction

| Tool | Does | Timing |
| --- | --- | --- |
| `memory_reconsider` | Queue reevaluation of a durable memory from a correction or counterexample. Does not replace the original. | Now (stores feedback) |
| `memory_review` | Inspect ready and pending tickets, unresolved deferrals, failed actions and exact receipts (`reviewId`). | Read |
| `memory_review_resolve` | Submit a reviewed decision. While tasks are active or the ticket is not ready the decision is staged. | Boundary |

### 6.5 Persona

Persona is behavioral guidance for response and question style. It never states facts, never grants permissions, and the current user instruction always overrides it. It does not store raw prompts, secrets, or sensitive demographic or psychological claims.

| Tool | Does | Timing |
| --- | --- | --- |
| `persona_observe` | Stage a summarized observation with provenance, distinguishing explicit preferences from tentative observations. Repeated evidence is deduplicated. | Staged |
| `persona_read` | Read applied guidance and pending observations with a revision hash. | Read |
| `persona_resolve` | Stage an accept, reject, or disable decision using the current profile hash. | Boundary |

An observation becomes `tentative` only after at least `minObservations` independent tasks or evidence items (default 3). Conflicting guidance requires an explicit decision. Applied guidance changes only at a successful idle boundary, and only when persona is enabled (`config --persona on|off`).

### 6.6 Projects and migration

| Tool | Does | Timing |
| --- | --- | --- |
| `project_resolve` | Resolve which registered project a directory belongs to: `resolved`, `ambiguous`, `unregistered`, or `not_found`. Never guesses. | Read |
| `project_list` | List projects with registration state. | Read |
| `project_scaffold` | Create a project workspace and register its source directory. Only for a stable repository; idempotent. | Now |
| `memory_migrate` | Import exact legacy daily notes and role memory into SQLite. Originals stay unless `pruneLegacy` is true, and then only verified dated sources are removed while idle. Changed sources remain conflicts. | Now (prune only when idle) |

## 7. Join Modes and Registration

- `manual` (default): only checkouts that carry the `.agent-vault-project` marker, or that were scaffolded explicitly, are registered. Unregistered projects produce no records; hook writes report a warning and are skipped.
- `auto`: any Git checkout is registered the first time the harness touches it, through `vault_context` or a recorder write. A directory that is not a Git checkout, the home directory, or the filesystem root is never auto-registered.
- Linked worktrees resolve to their main repository's project.
- Team memory is off by default. It is used only when explicitly configured and only for the `team` scope.

## 8. Access Guard (OMP)

The extension's `tool_call` handler blocks tool calls that reach vault files directly. It is defense in depth, not a sandbox: arbitrary code can still construct paths the guard cannot see, and hard isolation needs operating-system controls.

- Allowed: any Agent Vault MCP tool call, and writes to `xd://mcp__agent_vault_*` tool devices.
- Inspected: direct file tools (`read`, `write`, `edit`, `ast_edit`, `grep`, `glob`, `find`, `ast_grep`) and code or shell tools (`bash`, `sh`, `shell`, `exec`, `eval`, `python`, `javascript`) whose inputs reference the vault path.
- Blocked calls return a reason telling the agent to use the MCP tools, or to explain and stop if they are unavailable.
- Setting `guard.mode` to `off` disables the guard.

Other hosts have no guard installed. The rule "memory is tool-only" is then enforced only by the skill instructions.

## 9. Failure and Degradation

| Situation | Behavior |
| --- | --- |
| MCP server unavailable | Agent reports it and stops memory operations. No direct file, SQLite, or shell fallback. |
| Hooks unavailable | Memory tools still work. No automatic records, `not_connected` lifecycle, manual `memory_sleep` while idle. |
| Recorder write fails | UI warning, record skipped, work continues. |
| Task never closes (crash) | Next `memory_task_start` cancels tasks whose owner process no longer exists. |
| Maintenance called during an active task | `deferred`; no consolidation, ticket release, review application, weekly export or persona change. Review evaluation and usage bookkeeping can still record a pending ticket. |
| Weekly Markdown modified by hand | Preserved and reported as a conflict; SQLite remains authoritative. |
| Usage accounting fails after a write | The write stays successful and the result carries `memoryAccountingWarning`. |
| Credential-shaped content in a write | Refused. Remove the secret and retry. |

## 10. Guarantees and Limits

- Knowledge content changes only through explicit write tools or through the idle-boundary maintenance described above. Reading or loading context never rewrites or replaces knowledge, but it does update usage counters, read statistics, pending review tickets and, when a call carries a working directory, project registration (section 6.0).
- Review counts and age schedule work; they are not evidence. Replacement of a factual memory requires a non-user-report source and a structured assessment.
- Evidence metadata supplied by an agent is not automatic source verification.
- The guard, the persona, and the recorder are not security boundaries.
- Host-native registration of the MCP server and hooks for hosts other than OMP is performed by the agent through that host's own interface; this repository does not claim to have exercised every third-party host.
