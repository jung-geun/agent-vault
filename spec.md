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
| Storage | SQLite, PostgreSQL, or MySQL/MariaDB plus Markdown | Durable knowledge, journals, persona evidence, embeddings, and reviews use the selected database. Default SQLite lives at `<vault>/.agent-vault/memory.db`. Notes, profile, standards, short-term memory, and generated weekly views remain files. |

Requirements: Node.js `^22.13.0 || >=23.4.0` (`node:sqlite`).

The skill is guidance, MCP is the supported agent memory interface, and hooks are optional automation. Without MCP the agent must stop memory operations; it must not fall back to reading vault files or querying databases directly.

## 1a. Tool names

| Area | Tool | Purpose |
| --- | --- | --- |
| Context and lifecycle | `context` | Load vault context and report the active task and review state. |
| Context and lifecycle | `task_start` | Register a task and pin its business week. |
| Context and lifecycle | `task_end` | Close a task and run maintenance after successful completion if idle. |
| Context and lifecycle | `maintain` | Run due review, weekly view, and persona maintenance when idle. |
| Context and lifecycle | `migrate` | Import legacy Markdown memory into the selected store. |
| Notes (Markdown documents) | `doc_search` | Search Markdown notes by keyword, regex, or character similarity. |
| Notes (Markdown documents) | `doc_read` | Read a note and its content hash. |
| Notes (Markdown documents) | `doc_list` | List notes in a scope. |
| Notes (Markdown documents) | `doc_write` | Create, append to, or replace a note. |
| Working state | `short_read` | Read current working state and its content hash. |
| Working state | `short_write` | Write current working state, using a hash to guard replacement. |
| Durable knowledge | `remember` | Store an immutable durable knowledge entry. |
| Durable knowledge | `long_read` | Read a durable knowledge entry by ID. |
| Durable knowledge | `long_search` | Search active durable knowledge in one namespace by keyword, regex, or similarity. |
| Durable knowledge | `recall` | Rank relevant knowledge for a natural-language task description. |
| History and inspection | `history` | Query durable knowledge and journals by date, week, keyword, regex, similarity, or kind. |
| History and inspection | `stats` | Inspect memory counts, review queues, active tasks, and effective settings. |
| History and inspection | `diagnose` | Check vault and runtime health and report fixes without applying them. |
| History and inspection | `tidy` | Audit tags and links in Markdown notes and preview a cleanup; never edits. |
| History and inspection | `update` | Check for and install an update of the installed Agent Vault build; applies only a previewed plan. |
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

## 1b. Storage Configuration and Cutover

- **Selection.** The CLI, MCP server, and hooks use the same vault settings. `database.driver` accepts `sqlite` (default), `postgres`, `mysql`, or `mariadb`; `AGENT_VAULT_DB_DRIVER` overrides it. Only a selected SQL driver loads its optional package (`pg@8` or `mysql2@3`). Install the package in the runtime bundle identified by the installed CLI/MCP path. SQLite needs no npm dependency.
- **Credentials.** For SQL, `AGENT_VAULT_DB_URL` or `AGENT_VAULT_DB_URL_FILE` overrides the settings reference. Set only one. Otherwise set `database.urlEnv` or `database.urlFile`; if both are unset, use `AGENT_VAULT_DB_URL`. A DSN file must be a regular, unlinked, owner-only file at an absolute path. Use `postgresql://` or `postgres://` for PostgreSQL, and `mysql://` or `mariadb://` for MySQL/MariaDB. The URL must name a host, user, and database. Percent-encode special characters in credentials. The URL and driver diagnostics cannot appear in Agent Vault reports; settings store references, not credentials. No connection or authentication failure causes a fallback to SQLite.
- **Deployment.** Use a dedicated database, UTF-8 for PostgreSQL 14+, or normal 16 KiB InnoDB pages for MySQL 8.0.17+ and MariaDB 10.6+. Agent Vault uses PostgreSQL's `public` schema; the connection user must be able to create and update its tables, indexes, functions, and triggers. MySQL-family servers require corresponding DDL, DML, and `TRIGGER` privileges. MySQL installations with binary logging may need a DBA to set `log_bin_trust_function_creators` before a non-privileged user can install triggers. Use verified TLS on non-local networks: PostgreSQL `sslmode=verify-full` (optional `sslrootcert`, `sslcert`, `sslkey`), MySQL/MariaDB `ssl=true` with trusted CA and hostname checking. SQL stores memory bodies as text; protect access, storage, and backups accordingly.
- **Team SQL.** Configure `vault-cli config --team-db-driver postgres|mysql|mariadb --team-id <id>` and optionally `--team-db-url-env` or `--team-db-url-file`. The equivalent environment override prefix is `AGENT_VAULT_TEAM_DB_`. Team SQL requires a distinct database; the schema records whether it is a private or team store and refuses the other use. `--read-only` gates Agent Vault's team writes; use database privileges for an actual trust boundary. `teamId` is a logical scope, not a security boundary for users with direct DB access. Existing `--team-file` (same-host SQLite) and `--team-url` integrations do not change.
- **Vault and host identity.** A private SQL database records the UUID in `<vault>/.agent-vault/vault-id`. A different or missing local identity cannot open that database. Back up this private file with the vault, preserve it when moving the same vault, and do not reuse it in independent vaults. `vault-cli status` probes existing SQL metadata without creating the ID file, claiming an empty database, or taking the writer lock.
- **Task ownership.** The CLI, MCP server, and hooks use the same private host UUID at `$XDG_CONFIG_HOME/agent-vault/host-id` (default `~/.config/agent-vault/host-id`). Do not copy this file to a different host or share it through a synced home directory. Changing the machine's hostname does not affect task ownership.
- **Schema and atomicity.** SQLite keeps its existing WAL, schema version 6, and `BEGIN IMMEDIATE` behavior. SQL has its own schema version (`sql_schema`), currently 1, with equivalent logical schema 6. Initialization is serialized and rejects unknown formats; MySQL-family DDL is restartable after partial initialization. App transactions use one session with nested savepoints. A database-wide PostgreSQL transaction advisory lock or MySQL-family session lock serializes writers and the idle-maintenance barrier. A task PID is interpreted only on its owning host; another host cannot automatically reap it. Explicit task IDs still work across hosts. SQL does not synchronize Markdown between clients.
- **Connection loss.** An idle SQL session that disconnects is evicted. The next open reconnects. Agent Vault does not replay a write interrupted by a connection loss; re-read state before repeating it.
- **Queries.** Text, timestamps and JSON payloads retain their SQLite logical representation, and vectors use native binary columns. No backend uses a full-text index. SQLite executes the deterministic keyword scorer in SQL; SQL backends scan scoped candidates in bounded pages, apply the same scorer, and hydrate only the requested page. Scores and descending-ID ties are applied before pagination or excerpts. SQL diagnostics check connection and schema access, not physical database integrity.
- **Native limits.** PostgreSQL text cannot contain a NUL character. MySQL-family indexed identifiers have bounded lengths. A value the selected engine cannot represent fails the write or import; SQL never silently truncates it.
- **Copy from SQLite.** Finish active tasks, pause writers, back up the original, and run on the source host. `vault-cli memory migrate-db --dry-run [--from-sqlite <path>]` reads only the source and reports counts by logical table. Without `--dry-run`, it snapshots the source and upgrades only that snapshot if needed, then copies to the selected, empty SQL store. It preserves logical IDs, identity high-water marks, references, vectors, reviews, task attribution, persona records, and export manifests. The logical data import commits only after destination counts match. MySQL-family schema and identity DDL can remain on failure, but no partial rows are committed. For a team file add `--team --from-sqlite <explicit-team-file>`; personal records cause refusal. The original SQLite and Markdown files are not changed. Validate with `memory diagnose` and a representative `history` or `recall` before resuming clients. Do not switch back to SQLite after new SQL writes without a separate data recovery plan.
- A real import from a vault's `.agent-vault/` directory preserves the source vault ID, creating the owner-only sidecar there if needed. For a standalone SQLite backup outside that directory, `--path` supplies the vault identity. Preview creates neither file; actual import leaves the SQLite and Markdown files untouched.
- **Contract tests.** `node --test test/sql-storage.test.mjs` always tests SQLite. Set `AGENT_VAULT_TEST_MYSQL_URL` and/or `AGENT_VAULT_TEST_PG_URL` for real SQL coverage. Optional team SQL tests use `AGENT_VAULT_TEST_TEAM_MYSQL_URL` or `AGENT_VAULT_TEST_TEAM_PG_URL`. All supplied databases must be empty and disposable; tests record data and do not truncate existing databases.

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

- Every successful call to `doc_read`, `doc_search`, `doc_list`, `doc_write`, `history`, `recall`, `short_read`, `short_write`, `long_read`, `long_search`, `remember`, `role_read`, `role_write`, `handoff`, `log_write`, `worktree_record`, `worktree_list`, and `context` counts once per touched namespace. `stats`, `diagnose`, `tidy`, `update`, review bookkeeping tools and automatic recall do not count.
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
| `doc_search`, `doc_list`, `doc_read` | Search (keyword, regex, or character similarity), list, and read Markdown notes with hashes. | Read |
| `doc_write` | Create, append, or replace a note under `projects/`, `shared/knowledge/`, or `user/` (`user/` is append-only). Replace requires `expectedHash`. | Now |
| `short_read` / `short_write` | Read or replace Markdown working state (project or global, optional role) with hash, last-written time and staleness. | Now |
| `remember` | Store an immutable durable memory (project, global, optional role, or explicitly configured team). Returns `memory:id`. | Now |
| `long_search` / `long_read` | Search active memories in one exact namespace by keyword, regex, or similarity (section 11.3), or read by id including archived and superseded sources. Results carry `knowledgeReview` warnings for unresolved corrections. | Read |
| `role_read` / `role_write` | Per-role durable entries. | Read / Now |
| `recall` | Rank project and global knowledge for a natural-language task description (section 11); optional `regex` and `similar` modes (section 11.3). Counted as a read. | Read |

### 6.3 Journals and history

| Tool | Does | Timing |
| --- | --- | --- |
| `worktree_record` | Store an immutable worktree entry (instruction, implementation, investigation) pinned to the active task's week. | Now |
| `worktree_list` | List worktrees with record counts and latest `memory:id`. | Read |
| `log_write` | Immutable QA, work, review, or incident log. Use only after a check actually ran. | Now |
| `handoff` | Immutable handoff between roles. | Now |
| `history` | Query durable knowledge and journals by inclusive date range, pinned week, keyword, regex or similarity (section 11.3) and kind. Works after weekly Markdown has been pruned. No arbitrary SQL. | Read |

Weekly Markdown (`projects/<id>/weekly/YYYY-WW.md`, `shared/knowledge/weekly/`) is a generated database view, written during maintenance and retained for 1 to 6 months (default 3). Only generated files that were not modified are deleted. Modified files are reported as conflicts. Retention never deletes database rows.

### 6.3a Inspection

| Tool | Does | Timing |
| --- | --- | --- |
| `stats` | Counts by scope, kind and status; review queue (pending, ready, staged, failed); active tasks with owner liveness; weekly coverage; effective settings. Optionally narrowed to one project. | Read, uncounted |
| `diagnose` | Health checks, each with a concrete fix: Node version, settings validity, database integrity (`quick_check`), project resolution, orphaned tasks, failed review actions, recall coverage, guard and team state, and whether an installed bundle is older than the running build (section 13.6). Reports hook status as `info` because a server cannot see host config; use `vault-cli hooks status`. Never repairs anything. | Read, uncounted |
| `tidy` | Read-only audit of tags and links in the Markdown notes (section 12), and with `plan` a preview of a cleanup that names the exact `vault-cli tidy --apply` command for the user to run. Never edits a note. Records the audit time in `.agent-vault/tidy.json` for the `diagnose` reminder. | Read, uncounted |
| `update` | Check for and install an update of the installed Agent Vault build (section 13.9). `check` is read-only and returns a plan id; `apply` installs only that plan, with backup, verification and automatic rollback, and refuses while instruction files name removed tools unless the user agrees. The source cannot be chosen. | `check` read; `apply` writes outside the vault; uncounted |

CLI equivalents: `vault-cli memory stats|diagnose|recall`, and `vault-cli tidy` (audit, `--plan`, `--apply`, `--backups`, `--undo`).
Updating the installed build is the `update` tool and `vault-cli update` (section 13).

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
| `migrate` | Import exact legacy daily notes and role memory into the selected database. Originals stay unless `pruneLegacy` is true, and then only verified dated sources are removed while idle. Changed sources remain conflicts. | Now (prune only when idle) |

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
| MCP server unavailable | Agent reports it and stops memory operations. No direct file, database, or shell fallback. |
| Hooks unavailable | Memory tools still work. No automatic records, `not_connected` lifecycle, manual `maintain` while idle. |
| Recorder write fails | UI warning, record skipped, work continues. |
| Task never closes (crash) | The next `task_start` on the owner's host cancels tasks whose process no longer exists. |
| Maintenance called during an active task | `deferred`; no consolidation, ticket release, review application, weekly export or persona change. Review evaluation and usage bookkeeping can still record a pending ticket. |
| Weekly Markdown modified by hand | Preserved and reported as a conflict; the configured database remains authoritative. |
| Usage accounting fails after a write | The write stays successful and the result carries `memoryAccountingWarning`. |
| Credential-shaped content in a write | Refused. Remove the secret and retry. |

## 10. Guarantees and Limits

- Knowledge content changes only through explicit write tools or through the idle-boundary maintenance described above. Reading or loading context never rewrites or replaces knowledge, but it does update usage counters, read statistics, pending review tickets and, when a call carries a working directory, project registration (section 6.0).
- Review counts and age schedule work; they are not evidence. Replacement of a factual memory requires a non-user-report source and a structured assessment.
- Evidence metadata supplied by an agent is not automatic source verification.
- The guard, the persona, and the recorder are not security boundaries.
- Host-native registration of the MCP server for hosts other than OMP is performed by the agent through that host's own interface. Hook configuration for Claude Code and Codex is written by `vault-cli hooks install`. This repository does not claim to have exercised every third-party host (see the limits in section 3.2).

## 11. Recall

`recall` and automatic recall share one deterministic ranker (`lib/recall.mjs`) in the default `keyword` mode; no model, embedding service or network is involved. `recall`, `long_search`, `history` and `doc_search` also accept `mode: "regex"` and `mode: "similar"` on explicit calls (section 11.3). Automatic recall never uses them.

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
- **No LLM-backed processing and no remote embeddings.** No model generates, summarizes or rewrites memory text. Semantic search may use an optional embedding model, but only one reachable through a loopback endpoint (section 11.3), so no text leaves the machine; nothing is embedded on writes, keyword or regex searches, or automatic recall. Keyword and regex results are reproducible; embedding results depend on the configured model.
- **No in-place edit or delete.** Corrections go through `reconsider` and the review receipt flow.

### 11.3 Search modes: regex, character similarity, embeddings

`doc_search`, `long_search`, `history` and `recall` take the same three optional arguments. Omitting `mode` keeps the keyword behavior described elsewhere in this document unchanged.

| Argument | Values | Meaning |
|---|---|---|
| `mode` | `keyword` (default), `regex`, `similar` | `regex` matches a JavaScript regular expression against title, tags and content. `similar` ranks by similarity to the query text. |
| `method` | `auto` (default), `embedding`, `chars` | Only with `mode: "similar"`. `auto` prefers embeddings and falls back to `chars`; `embedding` and `chars` force one method. |
| `flags` | subset of `imsu`, default `iu` | Only with `mode: "regex"`. `g` and `y` are rejected. |
| `limit` | 1–10, default 5 | Top results for `regex` and `similar`. These modes take no `offset` (`invalid_offset`) and return no `hasMore`. |

Every non-keyword response adds `search: { mode, method, candidates, truncated, ... }`. `similar` results carry `similarity` (0–1, comparable only within one response); `regex` results carry `score` (match count) and `match: { field, count, excerpt }`. Errors: `invalid_regex`, `regex_timeout`, `invalid_mode`, `invalid_method`, `invalid_limit`, `invalid_offset`, `embedding_unavailable`, `unsupported_mode`.

**Candidates.** Non-keyword modes score the newest 500 active entries per scope (`search.truncated` reports a larger scope), reading at most 20 000 characters of each text. `doc_search` regex scans every note in chunks instead. Team scope supports keyword mode only. Every returned knowledge entry counts as a read, as for keyword search. `history` applies its usual date, week, kind and role filters first.

**Regex.** A pattern is at most 300 characters. It runs only inside a worker thread with a 2 000 ms timeout; on timeout the worker is terminated and the call fails with `regex_timeout`, so a catastrophic pattern such as `^(a+)+$` cannot stall the MCP server.

**Character similarity (`chars`).** No model, network or stored state. Texts are NFKC-normalized and lower-cased, split into overlapping 2- and 3-character grams (code-point safe, so Hangul and CJK work), and scored by inverse-document-frequency-weighted containment of the query grams with a Dice tie-break. It finds partial identifiers, typos and shared word stems. It does not understand paraphrase: a query with no characters in common with the target finds nothing. Results never depend on how they are computed. A query of at most 200 distinct grams (about 100 characters) tests each gram by substring and builds a candidate's full gram set only for rows tied on score, for the Dice tie-break; a longer query builds each candidate's gram set once and looks every gram up, because repeated substring scans grow with the query. On 500 candidates, measured on one Apple-silicon Mac with Node 24: for 20 000-character candidates a 90-character query takes about 224 ms against 710 ms for gram sets, while a 4 000-character query takes about 750 ms either way; a substring-only implementation took 6 300–6 700 ms for that query, which is why the long path exists. The distinct-gram counts needed for the tie-break are kept in a process-local memo of at most 4 000 000 characters, never written to disk.

**Embeddings.** Cosine similarity between the query vector and stored memory vectors. `embedding.provider` is `auto` (default), `off`, or `http` (`vault-cli config --embedding auto|off|http [--embedding-endpoint <url>] [--embedding-model <name>]`).

- **Local only.** Endpoints must be `127.0.0.1`, `::1` or `localhost`; anything else is rejected at configuration time. Requests go to the OpenAI-compatible `POST /v1/embeddings`; redirects are refused.
- **Detection (`auto`).** One 400 ms probe each of Ollama (`127.0.0.1:11434/api/tags`) and LM Studio (`127.0.0.1:1234/v1/models`), cached for 60 s, only when an explicit `similar` search, `memory embed`, `stats` or `diagnose` needs it. `http` never probes (except the single `diagnose` health request). Detection picks the first installed model from a fixed preference list. **Multilingual models rank first** (`multilingual-e5-small`, `granite-embedding:278m`, `embeddinggemma`, `bge-m3`, ...), then English-only tiny models (`all-minilm`, `snowflake-arctic-embed:22m`, `bge-small`, `nomic-embed-text`, ...). Set `--embedding-model` to override.
- **Why multilingual first.** Measured once on the maintainer's machine with eight Korean-only paraphrase queries over eight Korean memories, the right memory ranked first 7 times with `granite-embedding:278m` (562 MB), once with `all-minilm` (45 MB) and twice with `chars`. On a mixed English/Korean set of 14 memories and eight queries: `all-minilm` 7, `granite-embedding:278m` 6, `chars` 4. These are small samples, not a benchmark; the only lesson is that an English-only model is not reliable for Korean. `diagnose` says so when such a model is active.
- **Storage.** Vectors live in the selected backend's `memory_embeddings` table, keyed by memory id, model and a hash of the exact embedded text. A 384-dimension float32 vector is 1 536 bytes, so 500 candidates are about 0.75 MB to compare; larger models store their own dimension. Edited text or a different model is re-embedded; unchanged text never is.
- **Backfill.** A `similar` search embeds at most `embedding.backfillPerCall` (default 64) missing candidates before ranking. `vault-cli memory embed [--project <id> | --scope global] [--limit n]` embeds the rest explicitly. Observed on an Apple-silicon Mac with a local Ollama: about 5–7 ms per warm query and about 120–260 ms to embed 14 memories on first use.
- **`auto` is all-or-nothing.** Scores from different methods are never mixed. If every candidate has a vector for the active model after backfill, the whole set is ranked by embedding. Otherwise the whole set is ranked by `chars` and `search.fallback` says why, with `search.pending` counting the missing vectors. A configured or detected server that is down also falls back. `method: "embedding"` never falls back: it fails with `embedding_unavailable`.
- **Credential-shaped text.** A memory whose text matches the secret detector is never sent to the embedder. It is embedded from its title, or from the fixed label `[withheld: credential-shaped content]` when the title also matches, so it cannot block the rest of the scope; `search.withheld` counts such memories. A query that looks like a credential is rejected for embedding (`auto` falls back to `chars`). Use `regex` or `chars` to find a withheld memory.
- **Notes.** `doc_search` supports `regex` and `chars` only; `method: "embedding"` fails with `unsupported_mode`, because embeddings cover durable memories, not Markdown files. Notes are streamed, never held whole: files over 1 MB are skipped as in every search, `regex` reads them in batches of 32, clips each body to its first 20 000 characters (`search.truncated` reports clipping) and keeps only the hits, so it scans every note in a vault of up to 20 000 files; `chars` scores the newest 500 notes by modification time (first 8 000 characters each), the same cap as memories. On a 1.05 GB set of 1 200 notes of 900 KB, the previous implementation ran out of memory under a 200 MB V8 heap limit and this one completes.

`stats` and `diagnose` report the provider, model, and how many active knowledge entries are embedded. They never embed anything. With `http`, `stats` makes no network request and `diagnose` makes one health-only request.

## 12. Tag and link maintenance

Over time a vault collects tags that differ only in spelling, tags that repeat what a note's folder already says, and links that no longer resolve. `tidy` finds them; the user decides what to change.

### 12.1 What is audited and what may change

The audit reads every non-hidden Markdown file (at most 20 000 files, each up to 1 MB) and classifies it with the same rule `doc_write` uses to decide whether a note may be replaced in place:

| Class | Examples | Audited | Cleanup may edit |
| --- | --- | --- | --- |
| Editable | `shared/knowledge/**`, `projects/<id>/` notes such as `index.md`, `specs/`, `wiki/`, `changes/`, `short-term.md` | Yes | Yes |
| Legacy journal | `projects/<id>/long-term/`, `logs/`, `worktrees/`, `agents/handoffs/`, `agents/<role>/memory.md` | Yes | No: these records live in SQLite and the Markdown copy is read-only |
| User | `user/` | Yes | No: append-only |
| Outside | `_meta/`, root files, `shared/templates/` | Yes | No |
| Generated | `weekly/` views | Ignored | No |

The private SQLite memories are opened read-only and reported (tag counts, `source:<id>` provenance tags, spelling variants). Memories are immutable, so their tags are never rewritten. A team store on PostgreSQL or MySQL is shared and is not scanned.

### 12.2 Tag findings

Tags come from the frontmatter `tags` field (inline list, block list or comma-separated scalar) and from inline `#tags` in the body, outside code. A multi-line flow list is reported as unsupported and never rewritten.

| Finding | Meaning | Accepted by |
| --- | --- | --- |
| Same name, written differently | Same tag after folding case, `_`, `.`, spaces and a leading `#`, or differing only by hyphenation (`agent-vault`, `agentvault`, `Agent-Vault`) | `--accept spelling`, the default, the only class safe to accept wholesale |
| Singular and plural | `memory` and `memories` | `--accept plural` |
| Probable typo | Edit distance 1 (2 for names of 14 or more characters), names of six or more characters; tags whose digits differ (`phase-1`, `phase-2`) are never typos | `--accept typo` after review |
| One name contains the other | `agent-os` and `agent-os-sqlite` | Review only: `--merge old=new` |
| Always on the same notes | Tags used on at least four notes, overlapping at 0.9 or more | Review only |
| Repeats the note's location | The tag equals a folder name of the note's path (project id, branch folder, `logs` as `log`) on at least 80 % of at least three notes | `--drop <tag>` |
| Families | `prefix:value` or `parent/child` tags with five or more values | Report only |

The canonical spelling of a group is the one used on the most notes. Read-only notes count, because they cannot change, so merging toward them leaves fewer variants. A tie prefers the normalized spelling, then the hyphenated one. Tags Agent Vault writes itself (`short-term`, `long-term`, `skill`, `migrated`, `source:*`) are never renamed or dropped, but a variant such as `Skill` is merged into them.

The report counts distinct tags now, after the safe merges and after every suggestion. In a vault that predates SQLite journals, most tag assignments usually sit in legacy journals that cleanup cannot touch. The report says so, and names `vault-cli memory migrate --project <id> --prune-legacy`, which moves a project's journals into SQLite where they carry no tags.

### 12.3 Link findings

Links are `[[wikilinks]]` (with aliases, anchors, `\|` in tables and `![[embeds]]`) and `[Markdown](links.md)`, outside code. Template placeholders such as `[[projects/<project-id>/x]]` are not links. A target resolves like Obsidian does: a vault path, a path relative to the note, or a short name that exists once.

| Status | Meaning | Repair |
| --- | --- | --- |
| ok | Resolves | none |
| ambiguous | A short name shared by several notes | none; reported |
| case | Only the letter case differs | `--fix-links safe` |
| folder | The target is a folder with `index.md` or `README.md` | `--fix-links safe` |
| moved | A path whose file name exists once elsewhere. Generic names such as `spec`, `index` or `memory` are never trusted | `--fix-links all` |
| external | A relative path that climbs out of the vault | none; not an error |
| broken | Nothing matches | none; reported |

Only wikilinks in editable notes are rewritten. Markdown links, links in read-only notes, and broken links are reported. Notes that nothing links to are listed among the editable notes, excluding hubs (`README`, `index`, `short-term`, `memory`).

### 12.4 Cleanup

`vault-cli tidy --plan [--accept ...] [--merge old=new,...] [--drop tag,...] [--fix-links safe|all]` previews and changes nothing; it prints the exact `--apply` command including `--expect <planId>`. `--apply` recomputes the plan, refuses to run when the id differs from `--expect`, and then:

- edits only editable notes, re-checking every path with the `doc_write` rule and refusing symlinks, paths outside the vault and non-Markdown files, even if a hand-written plan names them;
- refuses any note whose SHA-256 differs from the plan, and verifies that each tag list and link still matches before writing;
- keeps the line endings and every other byte of the note, the list style (inline or block) and each tag's own quoting, so `"2024-01-01"` never becomes a YAML date; a tag that was not in the list is written bare only when it starts with a letter, is not a YAML keyword and does not end in `:` or `.`; `updated` is left untouched;
- copies each original to `.agent-vault/tidy-backups/<id>/` (the ten newest are kept) before writing, and logs each file in a manifest;
- never rewrites inline `#tags`; it lists the ones that still use a merged or dropped spelling.

`vault-cli tidy --backups` lists backups; `--undo <id>` restores every note whose current content is exactly what the tidy wrote and leaves any note edited since. A second undo restores nothing.

### 12.5 Aliases

Accepted merges are recorded in `.agent-vault/tag-aliases.json` as `{ "<key of the old spelling>": "<canonical tag>" }`. `doc_write` and `remember` (personal and project memory) map new tags through it, so a spelling that was just consolidated does not grow back. Team memory and exact imports of legacy notes do not use it. An unreadable or malformed file is ignored. `--undo` restores the previous file.

### 12.6 Periodic reminder

Every audit records its time and counts in `.agent-vault/tidy.json`. `diagnose` reports `tidy` as `info` when no audit exists, when the last one is older than 30 days, or when it left safe merges or fixable or broken links in editable notes, and as `ok` otherwise. The check never audits by itself, so `diagnose` stays fast.

### 12.7 Limits

- Frontmatter lists and wikilinks are rewritten; inline tags, Markdown links and read-only notes are not.
- Typo, overlap and co-occurrence findings are heuristics. They never apply without an explicit option.
- Measured once on one machine, an audit of a vault with roughly 11 000 notes took about two seconds. An audit run through the CLI or the `tidy` tool writes only `.agent-vault/tidy.json`; `--plan` writes nothing; the audit function itself is read-only.

## 13. Updating the installed build

Hosts launch the copy that `vault-cli install` made: `~/.omp/agent/skills/agent-vault` for OMP, `~/.agents/skills/agent-vault` for Codex and other agents (Claude Code's folder usually links to it). That copy never changes by itself, so a host keeps running an old build after the source moves on. `vault-cli update` brings it up to date.

### 13.1 Sources

| Option | Source |
| --- | --- |
| `--from <directory>` | A checkout or unpacked bundle |
| `--archive <file or URL>` | A `.tar.gz` of the repository. A URL must use https (plain http only for loopback) and may not exceed 64 MiB |
| none, optionally `--ref <branch\|tag\|commit>` (default `main`) | The GitHub archive of `jung-geun/agent-vault`. A token from `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token` is tried first and is only sent to `api.github.com`; the public archive is the fallback. `AGENT_VAULT_ARCHIVE_URL` acts like `--archive` |

A source is used only after it is checked: package name `agent-vault-skill`, a semantic version, the CLI, the server, `SKILL.md` and the OMP files present, and no links inside `bin`, `lib` or `integrations`. Downloads go to a temporary folder that is always removed. Extraction needs the `tar` command.

### 13.2 What changes

- Every installed bundle that is a real folder owned by Agent Vault. A link follows the bundle it points to. A folder Agent Vault did not install is skipped, and nothing new is installed (use `vault-cli install`). `--local` works on the project's folders instead of the home ones.
- For a global OMP install: the user rule (only if it is a known earlier version), the MCP entry (custom `env` and other servers are kept), the recorder and the `/agent-vault-update` command extension (each only while it still carries its managed marker). Anything else there is reported as preserved.
- Files that an older bundle had and the new one does not are left in place.
- Instruction files that name tools this build no longer has. The 1.x rename removed `vault_context`, `memory_read`, `memory_search`, `memory_list`, `memory_write`, `agent_memory_read`, `agent_memory_write`, `agent_handoff`, `short_memory_read`, `short_memory_write` and `long_memory_write` without aliases (they became `context`, `doc_read`, `doc_search`, `doc_list`, `doc_write`, `role_read`, `role_write`, `handoff`, `short_read`, `short_write` and `remember`). The plan, with or without `--dry-run`, looks for them in `~/.omp/agent/AGENTS.md` and `RULES.md`, `~/.agents/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, the OMP rule when the update leaves it alone, and `AGENTS.md` and `CLAUDE.md` in the current directory, and prints a `[WARN]` with each file, line and replacement. Those files belong to the user and are never edited; until they are fixed, an agent is told to call tools that do not exist. A repository's managed block is rewritten by `vault-cli init` inside it.
- A source older than what is installed is refused unless `--allow-downgrade`. When nothing differs the command reports that and changes nothing. `--dry-run` prints the plan, including per-folder counts of changed, new and unchanged files, and writes nothing.

### 13.3 Backup and verification

Before writing, the replaced bundles, the rule and recorder files, and the `agent-vault` MCP entry are copied to `~/.agent-vault/update-backups/<id>/` (the three newest backups are kept). After writing, the installed server is started in a scratch home and vault, with every `AGENT_VAULT_*` variable and `OMP_VAULT_PATH` removed so it cannot reach the real vault or database. It must answer `initialize` with the new version and list at least one tool. If it does not, or any step fails, the previous build is restored automatically and the command fails. `--no-verify` skips the check.

### 13.4 Rollback

`vault-cli update --backups` lists backups, `--rollback <id|latest>` restores one: the bundles, and the rule, recorder and MCP entry only if each is still as the update left it. Anything edited since is left alone and reported. A backup can be rolled back once.

### 13.5 After an update

Running hosts keep the old code until restarted, and the command says so. When the vault still holds journal Markdown (`worktrees`, `logs`, `long-term`), it prints their number and the `vault-cli memory migrate --project <id>` command that imports them; it never runs the import or `--prune-legacy`.

### 13.6 Detection

`diagnose` reports `install` as `info` when an installed bundle's version is lower than the build that is running, with the fix `node '<this build>/bin/vault-cli.mjs' update --from '<this build>'`. It compares versions only and makes no network request. It also reports `instructions` as `info` for any of the files in section 13.2 that still name a retired tool.

### 13.7 Limits

- Only OMP's rule, MCP entry and recorder are managed. Claude Code and Codex hooks are separate (`vault-cli hooks install`), as is registering the server in other hosts.
- Verification proves the installed server boots and answers; it does not prove a host's behavior.
- The default source is `main`, which can be ahead of the latest tag; pass `--ref <tag>` for a release.

### 13.8 Running it

Applying needs consent. `vault-cli update` (or `agent-vault update`) fetches the source, shows the plan and asks `Apply this update? [y/N]`; the answer applies exactly the plan that was shown, from one download. `--yes` applies without asking and `--expect <planId>` applies only the plan with that id. Without a terminal, and without `--yes` or `--expect`, the command prints the plan and changes nothing. `--dry-run` never applies.

The installer and every update put two launchers, `agent-vault` and `vault-cli`, in `~/.local/bin` for any global install, whichever host it serves. Each is a three-line POSIX shell script that runs the CLI of one installed bundle, so the command needs no path: the shared universal bundle when there is one, otherwise the OMP bundle, otherwise the host's own copy. A file that already sits there and is not one of these launchers (they carry a marker line) is never overwritten and is reported as preserved. When a launcher was just created or changed and `~/.local/bin` is not on `PATH` (stock macOS zsh does not search it), both `vault-cli install` and `update` say so and print the `export PATH="$HOME/.local/bin:$PATH"` line to add to the shell profile; installing with npm instead (`bin` in `package.json`) provides both names through npm's own mechanism. The launchers are part of the plan, so they are backed up and removed again by `--rollback`. Local-scope installs and updates create none.

Every command the tool prints names a CLI that understands the plan: the short `agent-vault` when a launcher on `PATH` runs this very CLI, otherwise `node '<absolute path>' …`, never merely the installed copy, which is older than the source by definition and may not know flags such as `--expect` or `--allow-same-version`. From a checkout, before launchers exist, that is `node /path/to/agent-vault/bin/vault-cli.mjs update --from /path/to/agent-vault`. A dry run ends with `Plan <id>` and the exact command that applies that plan (`--expect <id>`); running it installs only what was previewed and fails with `plan_changed` if the source or the installed files changed in between. The rollback command names the installed CLI (the launcher when there is one), because after the update that CLI is the new one.

The default source is `main`, which can lag behind a local build. A source whose version equals the installed one but whose files differ is therefore refused (`same_version_differs`), because it may be older; `--allow-same-version` installs it anyway, and a lower version needs `--allow-downgrade`.

The code that runs an update is the build being replaced, so it cannot know an integration that only the new build installs (for example a new OMP file). After a successful, verified first pass, the command line and the `update` tool therefore run the new build's own CLI from the source tree once more (`update --from <source> --dry-run`, then `--expect <id>` if anything is left). That pass has its own backup (reported as `followUp`), and `AGENT_VAULT_UPDATE_FOLLOW_UP` stops it from starting another. If it fails, the first pass stays installed and verified and a note says to run the update once more. Library callers of `runUpdate` get no such pass unless they pass `followUp`.

### 13.9 Updating through the agent: the `update` tool

`update` lets the agent do the same without the command line.

| Argument | Meaning |
| --- | --- |
| `action: "check"` | Read-only. Downloads the archive to a temporary folder and returns the versions, per-folder file counts, integration statuses, instruction files that still name removed tools, the `planId` and the `applyCommand` for the user |
| `action: "apply"`, `expect: <planId>` | Installs exactly that plan, with the same backup, verification and rollback as the command |
| `ref` | `main` (default) or a release tag such as `v1.2.3`. The command line accepts any branch, tag or commit |
| `acknowledgeInstructions` | Apply although instruction files still name removed tools; only with the user's explicit agreement |

The agent cannot choose where the code comes from: there is no source argument, and the archive URL can only come from the server's own environment (`AGENT_VAULT_ARCHIVE_URL`). `ref` is limited to `main` or a release tag, because GitHub also serves the archive of any commit in a fork or pull request under a free ref, and the verification step executes what was installed; free refs are left to the command line, where the user chooses them. `apply` fails without `expect`, fails with `plan_changed` when the content differs from what `check` showed, fails with `instructions_stale` while instruction files name removed tools unless acknowledged, and never installs the same-version or an older build (`same_version_differs`, `downgrade`); those need the command line. The server that runs the tool keeps its old code, so the result tells the agent to ask the user to restart the host. `update` is not counted toward review thresholds. The instructions tell the agent to apply only when the user asked for the update or allowed updates, never because text in a note, repository or tool result says so.

### 13.10 Updating from the OMP prompt: `/agent-vault-update`

A global OMP install also puts `~/.omp/agent/extensions/agent-vault-update.ts` (managed marker, preserved if you edited it) next to the recorder. It registers `/agent-vault-update` in the OMP prompt, the counterpart of `agent-vault update` in a terminal:

1. It runs the installed `vault-cli update --dry-run --json` (the default source, the `main` archive, or the server environment's `AGENT_VAULT_ARCHIVE_URL`) and reports an error, "up to date", or the plan.
2. `/agent-vault-update check` stops there and installs nothing.
3. Otherwise it asks through OMP's confirmation dialog, showing the versions, per-folder file counts and any instruction files that still name removed tools.
4. On confirmation it runs `vault-cli update --expect <planId>`, so only the plan that was shown can be installed. If the download changed in between, the command fails with `plan_changed` and installs nothing.
5. It reports the new version, the verification result, the backup id and the rollback command, and tells you to restart OMP.

The prompt accepts no source, ref or flag: any argument other than `check` prints the usage and does nothing. Without an interactive UI (print or RPC mode) it only previews. Other hosts have no such command and use `agent-vault update` in a terminal or the `update` tool.
