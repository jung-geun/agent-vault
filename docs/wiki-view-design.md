# Agent Vault wiki view: research and delivery plan

## Goal

Provide a human-readable, searchable wiki index alongside the graph view. Keep Markdown as the source of truth for wiki documents and preserve the MCP/CLI workflows. Durable SQLite memories remain available through memory tools; the Obsidian sidebar does not silently duplicate them into Markdown.

## Findings

- Vault notes can use shared frontmatter fields: `id`, `title`, `type`, `status`, `summary`, `created`, `updated`, `tags`, `sources`, `confidence`, `reviewed_at`, and `authority`.
- Project and role metadata may be absent. Identity inferred from `projects/<id>/...`, agent directories, or worktree paths must be labeled path-derived rather than authored provenance.
- Access frequency is observable only after logging starts; it cannot be reconstructed retroactively.
- Wikilink scans are approximate and can misread template placeholders or escaped Markdown pipes. Use Obsidian's metadata cache before changing notes.
- A useful home page needs a first-time reading path rather than only a dense graph or directory table.

## Design decision

Use three layers, not a single all-purpose graph:

1. **Native Obsidian Bases** for sortable/filterable lists. Bases read Markdown properties, need no plugin, and keep data local.
2. **A small community plugin sidebar** for cross-note search, provenance, backlinks/related notes, and measured agent access counts. Use the public `ItemView`, `registerView`, `Vault`, and `MetadataCache` APIs; never require a graph visualization or network service.
3. **A CSS snippet and Markdown home page** for comfortable reading and direct navigation. Markdown remains usable in GitHub and ordinary editors if the plugin is absent.

The plugin must label provenance by certainty: frontmatter-authored, path-derived, or unknown. Relatedness must distinguish explicit `sources`/wikilinks from heuristic similarity. Access counts must be labeled as observed since instrumentation was installed, never as lifetime popularity.

## Reading and information architecture

- Home page answers what the vault contains and where to start; lead with purpose and high-value links.
- Project index groups active projects and exposes each project index note, current memory, specs, wiki, and recent logs.
- Agent index groups role memories, handoffs, and worktree activity by project.
- Knowledge pages follow: short summary, provenance/status, key takeaways, details, related pages, sources, next actions.
- Separate learning/tutorial material, task procedures, reference facts, and design rationale where practical (Diátaxis).
- Use descriptive sentence-case headings, short paragraphs, bullets, and links on descriptive text. Avoid wide tables for navigation and avoid multiple ideas per paragraph.

## Access-event contract

Track successful MCP calls to `memory_read`, `memory_search`, `memory_list`, `memory_write`, `agent_memory_read`, `agent_memory_write`, `agent_handoff`, `short_memory_read`, `short_memory_write`, `long_memory_write`, `worktree_list`, `worktree_record`, `project_list`, `project_scaffold`, `log_write`, and `vault_context`.

Each append-only JSONL event in `.agent-vault/access.jsonl` stores timestamp, tool, project when known, declared role when known, direct/result note paths, result count, and whether a returned write created a file. Result paths are capped at 100. The logger omits query text, content, hashes, cwd, prompts, and absolute paths. Failed MCP calls do not count; log-write failures do not fail the MCP operation. The MCP process can opt out with `AGENT_VAULT_DISABLE_ACCESS_LOG=1`; deleting the JSONL file resets recorded history.

Role comes from an explicit role argument, the most recent successful `vault_context` declaration, or a role-bearing path. This is a declared role, not verified agent identity. Reads before logging starts cannot be reconstructed. Search/list events track returned paths (up to 100) so the view can count observed note exposure; lookup counts exclude human Obsidian opens and writes.

### Shipped behavior

- The optional installer supplies `Agent Vault Wiki`, `Projects.base`, `Knowledge.base`, and the reading snippet.
- The sidebar exposes title/path/summary search, project/type/role filters, note provenance, links/backlinks, and observed access summaries.
- The default view contains curated note types (`project`, `index`, `spec`, `concept`, `decision`, `source`, `design`, `template`). **All note types** includes raw reports and worktree records.
- The reading snippet constrains text width and hides rendered properties only in reading mode; YAML remains unchanged.

## Verification

Run `npm run check` and `npm test` from a source checkout. Tests cover access-log privacy, concurrent appends, fail-open behavior, plugin data helpers, and install/update preservation. The plugin build check verifies that generated `main.js` matches its source template and data helpers.

To verify the UI, install into a disposable initialized vault with `vault-cli install --obsidian --path <test-vault>`, restart Obsidian, and exercise sidebar search, filters, provenance, links, access events, and both Bases views. Automated source checks are not a substitute for this visual check.

## Limits

- The access log starts now; it cannot reconstruct earlier reads. Human Obsidian opens are not logged.
- Role is declared context, not authenticated agent identity. Unknown provenance remains visible as unknown.
- Confirm every selected Bases view against the vault's actual frontmatter; fixture results do not establish coverage of another user's data.
- Approximate wikilink scans are not semantic link audits.

Keep the plugin optional. The home page, Bases, and Markdown remain usable without the sidebar.

## Research sources

- Obsidian plugin views: https://docs.obsidian.md/Plugins/User+interface/Views
- Obsidian Bases: https://obsidian.md/help/bases
- Bases views: https://obsidian.md/help/bases/views
- Obsidian properties: https://obsidian.md/help/properties
- Diátaxis: https://diataxis.fr/
- Write the Docs, documentation principles: https://www.writethedocs.org/guide/writing/docs-principles/
- Nielsen Norman Group, web scanning and scannable text: https://www.nngroup.com/articles/how-users-read-on-the-web/
- GitHub README guidance: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes

