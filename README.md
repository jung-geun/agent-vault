# Agent Vault

**English** | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

[![skills.sh](https://skills.sh/b/jung-geun/agent-vault)](https://skills.sh/jung-geun/agent-vault)

**A memory harness that carries user, project, and work knowledge across agents and development environments.**

Instead of merely storing conversations, Agent Vault records the meaning, relationships, conditions, and derivation evidence of knowledge, and improves it incrementally as new evidence arrives. It ships a skill, an MCP server, and a CLI so it is not tied to a single harness, and it connects to any environment that supports skills and MCP, such as Claude Code, Codex, Cursor, and OMP. OMP is one supported environment, not a requirement.

## Installation

Node.js 24 LTS is recommended. Choose the agents you want to use when the command prompts you.

```sh
npx skills add jung-geun/agent-vault -g
```

`-g` installs for the current user globally. The install source is the GitHub repository `jung-geun/agent-vault`, not the npm package name.

After installing, use your agent's skill invocation feature, or ask in chat: **"Use the agent-vault skill to set up this project."** You do not need to run `npx` repeatedly in a terminal for setup or memory use.

## Features

- **Persistent context:** Stores user preferences, project decisions, and working state, and recalls them in later tasks.
- **Separated memory:** Splits global, project, and role scopes, and distinguishes short-term working state from long-term knowledge.
- **Evidence-based improvement:** Treats user corrections as a signal to reevaluate, comparing existing knowledge with new evidence. Updates are deferred when evidence is insufficient.
- **Cleanup at task boundaries:** Usage counts and age only schedule a review. Reviewed changes are applied at a normal task end or idle point, never by interrupting a running task.
- **Pluggable storage:** Documents and short-term memory stay in Markdown. Durable memory and review history use dependency-free SQLite by default, or an explicitly configured PostgreSQL or MySQL/MariaDB database.
- **Weekly journals:** Knowledge, logs, and handoffs are grouped by date and weekday into a single `YYYY-WW.md`. A task still running after Monday stays in the work week it started in. The configured database remains queryable by date or keyword.
- **User persona:** Tracks question, coding, work-instruction, and work-hour patterns together with their evidence to tune answers and clarifying questions. The current request always takes priority, and observations are never treated as facts or permissions.
- **Optional team sharing:** Uses only an explicitly configured team store and never shares personal memory automatically.
- **Ranked recall and health checks:** `agent-vault recall` ranks memory for a task description by keyword without an external search service. Optional automatic recall adds it to Claude Code and Codex prompts as background context, never as instructions. `agent-vault status` reports counts, the review queue, and a concrete fix for each problem.
- **Regex, similarity, and local-embedding search:** Searches accept `regex` and `similar` modes and return the top 5 (up to 10) results. `similar` uses a small embedding model running on your own machine (Ollama or LM Studio, loopback only) when one is available, and character similarity otherwise, so it also works with no model. Nothing is embedded unless you search with `similar`. For Korean or other non-English notes, use a multilingual model (for example `granite-embedding:278m`) instead of an English-only one.
- **Tag and link tidy-up:** `vault-cli tidy` audits tags and links, finds duplicate spellings, plurals, probable typos and overlapping tags, and reports broken, ambiguous and orphan links. `--plan` previews a cleanup, `--apply` edits only notes that `doc_write` may replace (with backups and `--undo`), and journals, `user/` and SQLite memories are only reported. `diagnose` reminds you to run it every 30 days.
- **Updating the installed build:** run `agent-vault update` (or `vault-cli update`) in a terminal. It shows what would change, asks `Apply this update? [y/N]`, then replaces the installed skill bundle, refreshes the OMP rule, MCP entry and recorder, starts the new server to verify it, and restores the old build if that fails. `--yes` skips the question, `--dry-run` only previews, `update --rollback latest` undoes. Every global install and update puts both command names in `~/.local/bin` (for any host, not only OMP); if your shell does not search that directory, the installer says so and shows the line to add to your profile. The agent can do the same through the `update` tool, which installs only a plan it has previewed and never chooses the source. `diagnose` tells you when the installed copy is older than the build you run.

## Usage

The entries below are **requests you send to the agent**. They are not terminal commands, and invocation syntax such as `/agent-vault` applies only where your environment supports it.

| Example request | What it does |
| --- | --- |
| `agent-vault setup` | Sets up the current project and vault, and connects the local MCP server for your environment. |
| `agent-vault install` | Registers or repairs the MCP connection of the already installed skill. |
| `agent-vault status` | Checks the connection state of the skill, MCP, project, and task hooks. |
| `agent-vault recall last week's deployment decision` | Finds records by date or keyword and answers with their evidence. |
| `agent-vault remember this decision and its reason` | Records it as working state or long-term knowledge as appropriate. |
| `agent-vault review this differs from the earlier record` | Compares the existing evidence with the new evidence and reevaluates. |
| `agent-vault persona show my response preferences` | Shows the preferences in effect and the observations awaiting review. |
| `agent-vault config keep weekly Markdown for 3 months, work starts at 09:00` | Applies the requested retention period and work-hour settings. |

### MCP is an internal mechanism

**The skill guides the agent's commands; storage, search, and review are handled by the local MCP server.** The agent performs initial setup with the CLI in the installed bundle, and the harness runs the MCP server from the same bundle with Node. Nothing needs to be run repeatedly by you, and no package is downloaded again.

Environments that need a permission approval or an agent restart for the first connection will tell you once. Where MCP or hooks cannot be registered automatically, the agent explains the required steps and limits, and never reports an unconnected state as complete.

### Optional SQL storage

SQLite needs no npm packages or configuration. For SQL, provision an empty database dedicated to one vault. Use PostgreSQL 14+ with UTF-8, MySQL 8.0.17+, or MariaDB 10.6+. The database user needs table, index, trigger, and routine creation privileges as well as read/write access. Install only the driver you select, next to the installed `bin/` and `lib/`:

```sh
npm install --prefix /absolute/path/to/agent-vault --no-save --no-package-lock pg@8
# MySQL or MariaDB instead:
npm install --prefix /absolute/path/to/agent-vault --no-save --no-package-lock mysql2@3
```

Set `AGENT_VAULT_DB_DRIVER` to `postgres`, `mysql`, or `mariadb`; supply a connection URL through `AGENT_VAULT_DB_URL` or `AGENT_VAULT_DB_URL_FILE`. Alternatively, persist a driver and an environment variable name or credential-file path:

```sh
vault-cli config --db-driver postgres --db-url-file /absolute/private/path/vault-dsn
```

The file must be owner-only and contain one connection URL. Never pass the URL itself on the command line or put it in the vault settings. Set the same configuration for the CLI, MCP process, and all lifecycle hooks. Use verified TLS on non-local networks (`sslmode=verify-full` for PostgreSQL, `ssl=true` for MySQL/MariaDB). See [storage configuration](spec.md#1b-storage-configuration-and-cutover) for details.

To move an existing SQLite database, stop the vault's writers and run on the SQLite host:

```sh
vault-cli memory migrate-db --path /absolute/path/to/vault --dry-run
vault-cli memory migrate-db --path /absolute/path/to/vault
vault-cli memory diagnose --path /absolute/path/to/vault
```

The first command previews table counts without connecting to the destination. The copy requires an empty SQL store and leaves the SQLite source and Markdown untouched. Keep the original as a backup, then restart the clients with the SQL configuration.

Team SQL is opt-in and uses a separate database. Configure it with `vault-cli config --team-db-driver postgres|mysql|mariadb --team-id <id>`; copy an existing team file with `memory migrate-db --team --from-sqlite <path>`.

### Memory is updated at task boundaries

Work weeks run Monday to Sunday, and a running task keeps its original week even when the week changes. Markdown is retained only for the configured **1–6 months**, while database records stay queryable.

Persona and reviewed memory changes are applied at an idle point after a normal task end. In environments without hooks, you can ask for `agent-vault maintain` after finishing your work. Existing daily files are imported with `agent-vault migrate`, and deleting the originals requires a separate, explicit request.

### When hooks run and what each tool does

OMP, Claude Code and Codex run hooks that start a task when you send a prompt, record your instruction and each file-editing turn, and close the task when the agent finishes. Ask the agent for `agent-vault install` to set them up: for Claude Code and Codex it runs `vault-cli hooks install --host claude|codex`, and Codex then asks you to review and trust the hooks once with `/hooks`. Maintenance and persona updates run only after a successfully completed task when no other task is active. Other environments such as Cursor install no hooks and use `agent-vault maintain` instead. For the exact events, timing, every MCP tool, what has been verified live, and failure behavior, see **[spec.md](spec.md)**.

See [SKILL.md](SKILL.md) for the detailed tool contract. The official [Skills customization](https://www.skills.sh/docs/customize) applies to the repository's listing page; it does not register commands or hooks for a running agent.
