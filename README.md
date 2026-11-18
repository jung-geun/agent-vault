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
- **Local storage:** Documents and short-term memory live in Markdown; long-term memory and review history live in SQLite. You can browse the Markdown documents in Obsidian.
- **Weekly journals:** Knowledge, logs, and handoffs are grouped by date and weekday into a single `YYYY-WW.md`. A task still running after Monday stays in the work week it started in, and SQLite can be queried by date or keyword.
- **User persona:** Tracks question, coding, work-instruction, and work-hour patterns together with their evidence to tune answers and clarifying questions. The current request always takes priority, and observations are never treated as facts or permissions.
- **Optional team sharing:** Uses only an explicitly configured team store and never shares personal memory automatically.
- **Ranked recall and health checks:** `agent-vault recall` ranks memory for a task description locally, with no embeddings and no network. Optional automatic recall adds it to Claude Code and Codex prompts as background context, never as instructions. `agent-vault status` reports counts, the review queue, and a concrete fix for each problem.

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

### Memory is updated at task boundaries

Work weeks run Monday to Sunday, and a running task keeps its original week even when the week changes. Markdown is retained only for the configured **1–6 months**, while SQLite records stay queryable.

Persona and reviewed memory changes are applied at an idle point after a normal task end. In environments without hooks, you can ask for `agent-vault sleep` after finishing your work. Existing daily files are imported with `agent-vault migrate`, and deleting the originals requires a separate, explicit request.

### When hooks run and what each tool does

OMP, Claude Code and Codex run hooks that start a task when you send a prompt, record your instruction and each file-editing turn, and close the task when the agent finishes. Ask the agent for `agent-vault install` to set them up: for Claude Code and Codex it runs `vault-cli hooks install --host claude|codex`, and Codex then asks you to review and trust the hooks once with `/hooks`. Maintenance and persona updates run only after a successfully completed task when no other task is active. Other environments such as Cursor install no hooks and use `agent-vault sleep` instead. For the exact events, timing, every MCP tool, what has been verified live, and failure behavior, see **[spec.md](spec.md)**.

See [SKILL.md](SKILL.md) for the detailed tool contract. The official [Skills customization](https://www.skills.sh/docs/customize) applies to the repository's listing page; it does not register commands or hooks for a running agent.
