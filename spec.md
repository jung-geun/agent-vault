# Agent Vault Specification: Hooks, MCP Tools, and Timing

This document describes what Agent Vault does, when it does it, and which component does it. It is derived from the current source (`integrations/omp/agent-vault-recorder.ts`, `bin/vault-recorder.mjs`, `bin/vault-mcp.mjs`, `lib/memory-tiers.mjs`, `lib/memory-db.mjs`, `lib/weekly-memory.mjs`, `lib/persona.mjs`, `lib/access-guard.mjs`, `lib/settings.mjs`). Where behavior depends on the host, the document says so. Anything not listed here is not guaranteed.

Translations of the user guide: [English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md). Agent-facing procedures are in [SKILL.md](SKILL.md).

## 1. Components and Responsibilities

| Component | What it is | Responsibility |
| --- | --- | --- |
| Skill (`SKILL.md`) | Instructions loaded by the agent | Tells the agent how to route requests (`setup`, `install`, `recall`, ...) and which tools to call. It performs no work itself. |
| CLI (`bin/vault-cli.mjs`) | Local Node program run by the agent | One-time administration: `setup`, `config`, `install`, `memory migrate/history/maintain`, `persona`. |
| MCP server (`bin/vault-mcp.mjs`) | Local stdio server started by the host with Node | All runtime memory reads and writes, review handling, task lifecycle calls. |
| Hooks | Host lifecycle callbacks | Automatically record instructions and edits, open and close task boundaries, and (OMP only) block direct vault access. |
| Storage | SQLite plus Markdown | Durable knowledge, journals, persona evidence and review receipts live in SQLite at `<vault>/.agent-vault/memory.db`. Notes, profile, standards, short-term memory and generated weekly views are Markdown. |

Requirements: Node.js `^22.13.0 || >=23.4.0` (`node:sqlite`).

The skill is guidance, the MCP server is the only supported memory interface, and hooks are optional automation. Without MCP the agent must stop memory operations; it must not fall back to reading vault files, SQLite, or shell commands.

## 1a. Tool names

| Area | Tool | Purpose |
| --- | --- | --- |
| Context and lifecycle | `context` | Load vault context and report the active task and review state. |
| Context and lifecycle | `task_start` | Register a task and pin its business week. |
| Context and lifecycle | `task_end` | Close a task and run maintenance after successful completion if idle. |
| Context and lifecycle | `maintain` | Run due review, weekly view, and persona maintenance when idle. |
| Context and lifecycle | `migrate` | Import legacy memory into SQLite. |
| Notes (Markdown documents) | `doc_search` | Search Markdown notes. |
| Notes (Markdown documents) | `doc_read` | Read a note and its content hash. |
| Notes (Markdown documents) | `doc_list` | List notes in a scope. |
| Notes (Markdown documents) | `doc_write` | Create, append to, or replace a note. |
| Working state | `short_read` | Read current working state and its content hash. |
| Working state | `short_write` | Write current working state, using a hash to guard replacement. |
| Durable knowledge | `remember` | Store an immutable durable knowledge entry. |
| Durable knowledge | `long_read` | Read a durable knowledge entry by ID. |
| Durable knowledge | `long_search` | Search active durable knowledge in one namespace. |
| Durable knowledge | `recall` | Rank relevant knowledge for a natural-language task description. |
| History and inspection | `history` | Query SQLite knowledge and journals by date, week, keyword, or kind. |
| History and inspection | `stats` | Inspect memory counts, review queues, active tasks, and effective settings. |
| History and inspection | `diagnose` | Check vault and runtime health and report fixes without applying them. |
| Roles and handoffs | `role_read` | Find durable entries for one role or list role counts. |
| Roles and handoffs | `role_write` | Store a durable entry for one role. |
| Roles and handoffs | `handoff` | Record an immutable handoff between roles. |
| Journals | `log_write` | Record an immutable QA, work, review, or incident log. |
| Journals | `worktree_record` | Record an instruction, implementation, or investigation for a worktree. |
| Journals | `worktree_list` | List worktrees with records and their latest references. |
| Review | `reconsider` | Queue a correction or counterexample for review. |
| Review | `review` | Inspect review tickets, deferrals, failures, and receipts. |
| Review | `review_resolve` | Submit an evidence-based review decision. |
| Persona | `persona_observe` | Stage a summarized behavioral observation with evidence. |
| Persona | `persona_read` | Read applied guidance, pending observations, and the revision hash. |
| Persona | `persona_resolve` | Stage an accept, reject, or disable decision for guidance. |
| Projects | `project_resolve` | Resolve a directory to a registered project without guessing. |
| Projects | `project_list` | List projects and their registration state. |
| Projects | `project_create` | Create a project workspace and register its source directory. |

Hosts show these tools as `mcp__agent-vault__<name>` or with a similar host-specific prefix.
These names replaced the earlier `memory_*`/`*_memory_*` names in this release with no aliases, so update saved allow-lists and approval settings that name the old tools.

## 2. Hook Support by Host

| Host | Install | How task boundaries work |
| --- | --- | --- |
| OMP | `vault-cli install --global` installs `~/.omp/agent/extensions/agent-vault-recorder.ts`, the user rule, and an MCP entry with `AGENT_VAULT_HARNESS=omp`. | Automatic, section 3.1. |
| Claude Code | `vault-cli hooks install --host claude` writes command hooks to `~/.claude/settings.json` (`--local`: `.claude/settings.local.json`). | Automatic, section 3.2. |
| Codex | `vault-cli hooks install --host codex` writes `~/.codex/hooks.json` (`--local`: `.codex/hooks.json`). Codex runs a new or changed hook only after you review and trust it with `/hooks`; Agent Vault never writes trust state. | Automatic once trusted, section 3.2. |
| Cursor, other | None. | Only if the host exposes lifecycle events and the agent or user wires `task_start` / `task_end` to them. Otherwise `context` reports `lifecycle.status: "not_connected"` and maintenance runs only through an explicit `maintain` while all tasks are idle. |

`vault-cli hooks status --host claude|codex` reports each event as `current`, `drifted` (owned but changed, for example after the bundle moved) or `missing`. `hooks uninstall` removes only entries whose command runs this package's `vault-hook.mjs`; every other hook and setting is preserved. A malformed config file is never overwritten. Re-run `hooks install` after moving or updating the bundle, because the hook command contains absolute paths.

The agent must verify the live state with `context` (`memoryMaintenance.lifecycle.status` is `connected`, `ambiguous`, or `not_connected`). A written config or an MCP connection alone does not prove that hooks are active.

## 3. Hook Events

### 3.1 OMP

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
- If `task-start` fails the agent still works, but the task is not registered, `context` reports `not_connected`, and no end-of-task maintenance happens.
- Investigation records are model-driven (`worktree_record`), not hook-driven.

### 3.2 Claude Code and Codex

`bin/vault-hook.mjs --host claude|codex [--path <vault>]` reads one JSON event on stdin (limit 4 MB) and prints at most one JSON object. It **always exits 0**: a failure is reported as `systemMessage` and never stalls the host. Hooks are separate short-lived processes, so per-session state (the task ID, the host process ID, the working directory and the edited-file list) lives in `<vault>/.agent-vault/hooks/<host>/`, keyed by a hash of `session_id`, with mode 0600 and a 14-day cleanup. **Raw prompt text is never written to this state.** Only after the journal has accepted the `instruction` record is its first line (at most 120 characters, already in the journal) kept as the "Triggered by" label; a prompt the journal rejects as credential-shaped leaves no trace in state, journal, or hook output, and the later `implementation` record says `(no prompt recorded)`. The detector is pattern-based (private keys, common cloud and API token formats, JWTs, `key=value` assignments): a secret in an unrecognized format is journaled like any other prompt text, because every accepted prompt is stored (up to 4000 characters) as an `instruction` record. Automatic recall uses the prompt in memory only.

| Event (both hosts unless noted) | Action |
| --- | --- |
| `UserPromptSubmit` | 1. Flush edits and cancel any task left open from a turn the host never reported as finished. 2. Register a new task owned by the host process (the first non-shell ancestor of the hook). 3. Return `additionalContext` naming the task ID so the agent can pass it to `context` and `worktree_record`. 4. If automatic recall is on, append ranked background memory (section 11). 5. Auto-register per join mode and write an `instruction` worktree record. |
| `PreToolUse` | Run the access guard on the call (Claude: `Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Grep`, `Glob`; Codex: `Bash`, `apply_patch`). A direct vault access returns `permissionDecision: "deny"`. MCP tools and other tools are never blocked. |
| `PostToolUse` | For edit tools (Claude `Edit`/`Write`/`MultiEdit`/`NotebookEdit`; Codex `apply_patch`, files parsed from its patch) append the absolute path to the session's pending list. Parallel tool calls append safely. |
| `Stop` | Flush pending edits as one `implementation` record, close the task with `completed=true`, and run idle maintenance when no other task is active. |
| `StopFailure` (Claude), `Interrupt` (Codex) | Same flush, but close with `completed=false`: no maintenance runs. |
| `SessionEnd` | Same as an interrupted end for a still-open task; a no-op after `Stop`. |

Limits, stated plainly:

- `Stop` is treated as completion. If another Stop hook makes the host continue the turn, the task has already been closed and later work in that turn is not attributed to it.
- The MCP server matches a task to its caller by process ID: it is a child of the host, and the hook records the host as owner. If a host launches hooks through an unusual process tree, `context` can report `not_connected` or `ambiguous`; pass the `taskId` from the hook's context instead.
- **What was exercised live** (Claude Code 2.1.327, Codex 0.170.0, a packed 1.1.1 tarball installed into a temporary prefix, temporary vault and project, 2026-11-18):
  - Claude Code: `UserPromptSubmit`, `PreToolUse` (a `Bash` read of a vault file was denied and did not run), `PostToolUse` (`Write`), `Stop`, forced termination (orphan task, `diagnose` warning, cancellation by the next session), automatic recall reaching the model with all tools disabled, and `context` reporting `lifecycle.status: "connected"` for the hook-opened task.
  - Codex: hooks injected as session overrides ran `UserPromptSubmit`, `PostToolUse` for `apply_patch` and the end-of-turn events, wrote the `instruction` and `implementation` records, and the MCP server reported the task as `connected`. Separately, in a temporary `CODEX_HOME`, the hooks file written by `hooks install --host codex` was discovered by Codex's own `hooks/list` (six hooks, source `user`, no errors, initially `untrusted`); an `exec` before trust ran no hook (zero records), and after trust (written through Codex's `config/batchWrite` as `hooks.state.<key>.trusted_hash`) the same `exec` printed `hook: UserPromptSubmit Completed` and wrote the `instruction` record. The model call itself failed (no credentials in that home), so the end-of-turn hooks of that run are only inferred from the closed task and removed state file, not individually observed.
  - Not exercised live: Codex `PreToolUse` denial, Codex `PostToolUse` from a file-loaded (not session-injected) definition, `Interrupt` and `SessionEnd` individually, Claude `StopFailure` after the billing-failure run was repeated with the fixed code, project-scope Codex hooks (they require a trusted project; `codex exec --trust` persists to the user's config and was not used), Cursor, and automatic recall inside Codex.
- Hooks are guardrails, not a security boundary; Codex documents that some tool paths can opt out of hook interception.

## 4. Task Lifecycle

A task is one logical unit of agent work, registered with the vault so maintenance never interrupts it.

### 4.1 Start (`task_start`, hook `task-start`)

- Requires an initialized vault (`_meta` directory); otherwise returns `started: false, reason: "vault_not_initialized"`.
- Registers `taskId` with the owner process ID. The ID must be kept across retries; a finished ID cannot be reused (`memory_task_closed`) and a different owner PID is refused (`memory_task_owner_mismatch`).
- Cancels active tasks whose owner process no longer exists (`kill(pid, 0)` returns ESRCH), so crashed sessions do not block maintenance forever.
- Pins the task to its business week (ISO `YYYY-WW`, Monday to Sunday, in the configured timezone, with a `workdayStart` default of `09:00`). A task keeps the week it started in even if it runs past Monday.
- `parentTaskId` lets a child inherit an active parent's week. `resumeTaskId` lets a new task continue a cancelled or interrupted task; a completed task cannot be resumed into an old week.

### 4.2 End (`task_end`, hook `task-end`)

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

- Every successful call to `doc_read`, `doc_search`, `doc_list`, `doc_write`, `history`, `recall`, `short_read`, `short_write`, `long_read`, `long_search`, `remember`, `role_read`, `role_write`, `handoff`, `log_write`, `worktree_record`, `worktree_list`, and `context` counts once per touched namespace. `stats`, `diagnose`, review bookkeeping tools and automatic recall do not count.
- Defaults (`settings.review`): thresholds `[5, 10, 20]`, then every `20` operations; short-term memory is stale after `14` days; a memory is a skill candidate after `10` reads. All are configurable with `vault-cli config`.
- Crossing a milestone creates a **pending** ticket. A stale short-term note also creates a ticket (`stale-short-term`) when it has not already been reviewed or deferred at its current hash.
- `reconsider` creates a ticket from a correction at any count. The feedback is stored separately and the original memory is not replaced.
- `review`, `context` (once per scope it loads), and the sleep pass all evaluate review state first. That evaluation can enqueue a pending `stale-short-term` ticket, **even while tasks are active**. The task barrier below blocks consolidation, release and application, not this bookkeeping.
- `long_search`, `long_read`, `recall`, and `history` (knowledge rows only) also increment each returned memory's `read_count` and set `last_read_at`. `read_count` feeds skill-candidate detection. The `context` preload and automatic recall do not increment it.

### 5.2 Ticket states

| State | Meaning | Who can act |
| --- | --- | --- |
| Pending | Threshold crossed. Not yet released. | Nobody. `context` never exposes pending work as immediate work. |
| Ready | Released at a task boundary. | The next task's first `context` for the same role delivers it (`memoryMaintenance.reviewWork`), only for tickets released before that task started. |
| Staged | The agent submitted a decision with `review_resolve` while tasks were active or the ticket was not ready. | Applied automatically at the next successful idle boundary. |
| Resolved | Applied, with a receipt. | Read with `review` and `reviewId`. |

### 5.3 The sleep pass (`maintain` or end of a completed task)

- The review state is evaluated first, before any idle check. This can enqueue a stale-short-term ticket even when the pass is then deferred.
- If any task is active, returns `deferred: true`. It performs no duplicate archiving, ticket release, or action application. Bookkeeping already described above may still have occurred.
- If nothing is pending or staged, returns `skipped` with reason `not_due`.
- Otherwise: archive exact duplicate memories, release pending tickets to ready, and apply staged review actions. Applying an action fails with `maintenance_deferred` if tasks became active again; the action stays staged.
- `maintain` additionally runs weekly-view and persona maintenance, which defer on their own when any task is active. The task-end path runs the per-namespace pass without them and then runs them once.
- No model runs and no stored instruction is executed. The pass is deterministic.

### 5.4 What the agent does with a ready ticket

At the start of a task, inspect `reviewWork`, read source evidence, then stage a decision with `review_resolve`. Actions are `keep`, `archive`, `supersede`, `promote`, `skill`, and `defer`. Rules enforced by the server:

- Correction reviews must name the challenged `memoryId` and include a structured `assessment` that compares alternatives, evidence, scope, and limits.
- `defer` records uncertainty and leaves the source knowledge unchanged. Insufficient evidence must defer rather than replace.
- A user report alone is not sufficient to replace a factual memory; user preferences are not external factual disputes.
- Promoting short-term memory requires the current `expectedHash` from `short_read`.
- New feedback that arrives after a proposal blocks application until reassessed (`feedback_changed`).

## 6. MCP Tool Reference

Each tool validates its arguments against a JSON schema. A successful call is also recorded for usage counting and, for a fixed set of tools, appended to the vault access log (disable with `AGENT_VAULT_DISABLE_ACCESS_LOG=1`). Results larger than the response budget return `result_too_large`; reduce `limit`/`maxChars` or read with `offset`.

### 6.0 State-change vocabulary

Timing column: **Now** changes stored content or registration immediately; **Boundary** applies its effect only at a safe task boundary (staging may happen earlier); **Read** returns data without changing knowledge or document content and without applying maintenance.

**Read does not mean side-effect free.** Any successful call to a counted tool (section 5.1) updates usage counters and may create a pending review ticket. In addition:

- `context` may auto-register the project, may enqueue a stale-short-term ticket, and may claim the once-per-task review delivery.
- `long_search`, `long_read`, `history` update `read_count` and `last_read_at` on returned knowledge.
- A fixed set of tools append an event to the vault access log.
- Failure of usage accounting does not fail the call; the result carries `memoryAccountingWarning`.

None of these rewrite or replace knowledge content, release tickets, or apply review decisions.

### 6.1 Context and lifecycle

| Tool | Does | Timing |
| --- | --- | --- |
| `context` | Loads profile, coding standards, project index, short-term memory, recent long-term memory, persona guidance, review state and lifecycle status within a character budget. Auto-registers the project per join mode when called with a working directory. The first call per registered task and role delivers prior-boundary ready review work. | Read (registration is Now) |
| `task_start` | Registers a task and pins its business week. | Now |
| `task_end` | Closes a task and, if completed and idle, runs maintenance. | Boundary |
| `maintain` | Runs due maintenance only when every task is idle. | Boundary |

### 6.2 Documents, short-term and long-term memory

| Tool | Does | Timing |
| --- | --- | --- |
| `doc_search`, `doc_list`, `doc_read` | Search, list, and read Markdown notes with hashes. | Read |
| `doc_write` | Create, append, or replace a note under `projects/`, `shared/knowledge/`, or `user/` (`user/` is append-only). Replace requires `expectedHash`. | Now |
| `short_read` / `short_write` | Read or replace Markdown working state (project or global, optional role) with hash, last-written time and staleness. | Now |
| `remember` | Store an immutable durable SQLite memory (project, global, optional role, or explicitly configured team). Returns `memory:id`. | Now |
| `long_search` / `long_read` | Search active memories in one exact namespace, or read by id including archived and superseded sources. Results carry `knowledgeReview` warnings for unresolved corrections. | Read |
| `role_read` / `role_write` | Per-role durable entries. | Read / Now |
| `recall` | Rank project and global knowledge for a natural-language task description (section 11). Counted as a read. | Read |

### 6.3 Journals and history

| Tool | Does | Timing |
| --- | --- | --- |
| `worktree_record` | Store an immutable worktree entry (instruction, implementation, investigation) pinned to the active task's week. | Now |
| `worktree_list` | List worktrees with record counts and latest `memory:id`. | Read |
| `log_write` | Immutable QA, work, review, or incident log. Use only after a check actually ran. | Now |
| `handoff` | Immutable handoff between roles. | Now |
| `history` | Query SQLite knowledge and journals by inclusive date range, pinned week, keyword and kind. Works after weekly Markdown has been pruned. No arbitrary SQL. | Read |

Weekly Markdown (`projects/<id>/weekly/YYYY-WW.md`, `shared/knowledge/weekly/`) is a generated view of SQLite, written during maintenance, retained for 1 to 6 months (default 3). Only generated files that were not modified are deleted; modified files are preserved and reported as conflicts; SQLite rows are never deleted by retention.

### 6.3a Inspection

| Tool | Does | Timing |
| --- | --- | --- |
| `stats` | Counts by scope, kind and status; review queue (pending, ready, staged, failed); active tasks with owner liveness; weekly coverage; effective settings. Optionally narrowed to one project. | Read, uncounted |
| `diagnose` | Health checks, each with a concrete fix: Node version, settings validity, database integrity (`quick_check`), project resolution, orphaned tasks, failed review actions, recall coverage, guard and team state. Reports hook status as `info` because a server cannot see host config; use `vault-cli hooks status`. Never repairs anything. | Read, uncounted |

CLI equivalents: `vault-cli memory stats|diagnose|recall`.

### 6.4 Review and correction

| Tool | Does | Timing |
| --- | --- | --- |
| `reconsider` | Queue reevaluation of a durable memory from a correction or counterexample. Does not replace the original. | Now (stores feedback) |
| `review` | Inspect ready and pending tickets, unresolved deferrals, failed actions and exact receipts (`reviewId`). | Read |
| `review_resolve` | Submit a reviewed decision. While tasks are active or the ticket is not ready the decision is staged. | Boundary |

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
| `project_create` | Create a project workspace and register its source directory. Only for a stable repository; idempotent. | Now |
| `migrate` | Import exact legacy daily notes and role memory into SQLite. Originals stay unless `pruneLegacy` is true, and then only verified dated sources are removed while idle. Changed sources remain conflicts. | Now (prune only when idle) |

## 7. Join Modes and Registration

- `manual` (default): only checkouts that carry the `.agent-vault-project` marker, or that were scaffolded explicitly, are registered. Unregistered projects produce no records; hook writes report a warning and are skipped.
- `auto`: any Git checkout is registered the first time the harness touches it, through `context` or a recorder write. A directory that is not a Git checkout, the home directory, or the filesystem root is never auto-registered.
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
| Hooks unavailable | Memory tools still work. No automatic records, `not_connected` lifecycle, manual `maintain` while idle. |
| Recorder write fails | UI warning, record skipped, work continues. |
| Task never closes (crash) | Next `task_start` cancels tasks whose owner process no longer exists. |
| Maintenance called during an active task | `deferred`; no consolidation, ticket release, review application, weekly export or persona change. Review evaluation and usage bookkeeping can still record a pending ticket. |
| Weekly Markdown modified by hand | Preserved and reported as a conflict; SQLite remains authoritative. |
| Usage accounting fails after a write | The write stays successful and the result carries `memoryAccountingWarning`. |
| Credential-shaped content in a write | Refused. Remove the secret and retry. |

## 10. Guarantees and Limits

- Knowledge content changes only through explicit write tools or through the idle-boundary maintenance described above. Reading or loading context never rewrites or replaces knowledge, but it does update usage counters, read statistics, pending review tickets and, when a call carries a working directory, project registration (section 6.0).
- Review counts and age schedule work; they are not evidence. Replacement of a factual memory requires a non-user-report source and a structured assessment.
- Evidence metadata supplied by an agent is not automatic source verification.
- The guard, the persona, and the recorder are not security boundaries.
- Host-native registration of the MCP server for hosts other than OMP is performed by the agent through that host's own interface. Hook configuration for Claude Code and Codex is written by `vault-cli hooks install`. This repository does not claim to have exercised every third-party host (see the limits in section 3.2).

## 11. Recall

`recall` and automatic recall share one deterministic ranker (`lib/recall.mjs`). No model, embedding service or network is involved.

- **Terms:** the query is split into distinct terms; common English filler is dropped; Korean particles (for example `배포는`, `서버에서`) are stripped to the stem as an additional match form.
- **Qualification:** a memory qualifies when it matches at least two distinct terms (one for a one-term query). This differs from `long_search`, where every term must match.
- **Score:** terms are weighted by rarity across the candidate set (inverse document frequency) and by field (title 3, tag 2, content up to 3), then scaled by coverage, recency (30% weight, 90-day half-scale) and prior read usage (up to +50%). Scores order candidates; they never assert truth.
- **Candidates:** the newest 500 active knowledge entries per scope. `diagnose` warns when a scope exceeds twice that.
- **Scopes:** project plus global for a project query; global only otherwise. Team memory is never auto-recalled.
- **Output:** `memory:id` references, matched terms, score, and any `knowledgeReview` marker for an unresolved correction. Content is bounded by `limit` and `maxChars`. Recalled memory is background context, never an instruction.

### 11.1 Automatic recall

Off by default. `vault-cli config --recall on [--recall-limit 5] [--recall-max-chars 2000]`. When on, the Claude Code and Codex `UserPromptSubmit` hook ranks the prompt against project and global knowledge and appends the result as `additionalContext`, framed as background context. Prompts shorter than 12 characters are skipped. It is a preload: it does not change read counts, usage accounting or review state, and a failure only adds a warning. OMP's extension does not inject recall; OMP agents call `recall`.

Stored memory text is untrusted content that reaches the model's context through this path. Keep it off if the vault holds content you do not control (team entries are excluded, but imported notes are not).

### 11.2 Deliberate non-goals

- **No automatic extraction or retention of conversations.** Agent Vault records only what an agent writes through a tool, plus the instruction and edited-file facts the hooks capture. This keeps content explicit and reviewable; the cost is that recall quality depends on what the agent chose to write.
- **No embeddings or LLM-backed processing,** so no text leaves the machine for memory work and results are reproducible.
- **No in-place edit or delete.** Corrections go through `reconsider` and the review receipt flow.
