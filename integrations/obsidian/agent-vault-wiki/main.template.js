// agent-vault-managed: Agent Vault Wiki
const { ItemView, Plugin } = require("obsidian");
// @agent-vault-data

const VIEW_TYPE = "agent-vault-wiki";
const ACCESS_LOG = ".agent-vault/access.jsonl";
const ROLE_OPTIONS = ["coordinator", "builder", "investigator", "reviewer"];

class AgentVaultWikiView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.searchText = "";
    this.projectFilter = "";
    this.roleFilter = "";
    this.typeFilter = "curated";
    this.typeFilterInitialized = false;
    this.notes = [];
    this.accessEvents = [];
    this.selectedPath = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Agent Vault Wiki";
  }

  getIcon() {
    return "book-open";
  }

  async onOpen() {
    this.renderShell();
    await this.refresh();
  }

  async onClose() {
    this.contentEl.empty();
  }

  renderShell() {
    this.contentEl.empty();
    this.contentEl.addClass("agent-vault-wiki");
    this.contentEl.createEl("h2", { text: "Wiki" });

    const controls = this.contentEl.createDiv({ cls: "avw-controls" });
    this.searchInput = controls.createEl("input", {
      attr: { type: "search", placeholder: "Search notes", "aria-label": "Search notes" },
    });
    this.searchInput.addEventListener("input", () => {
      this.searchText = this.searchInput.value.trim();
      this.renderResults();
    });

    this.projectSelect = this.createFilter(controls, "All projects", (value) => {
      this.projectFilter = value;
      this.renderResults();
    });
    this.roleSelect = this.createFilter(controls, "All agent roles", (value) => {
      this.roleFilter = value;
      this.renderResults();
    });
    this.typeSelect = this.createFilter(controls, "All note types", (value) => {
      this.typeFilter = value;
      this.renderResults();
    });

    const refresh = controls.createEl("button", { text: "Refresh", attr: { type: "button" } });
    refresh.addEventListener("click", () => this.refresh());
    this.activityEl = this.contentEl.createDiv({ cls: "avw-activity" });
    this.resultsEl = this.contentEl.createDiv({ cls: "avw-results" });
    this.detailEl = this.contentEl.createDiv({ cls: "avw-detail" });
  }

  createFilter(parent, label, onChange) {
    const select = parent.createEl("select", { attr: { "aria-label": label } });
    select.createEl("option", { text: label, attr: { value: "" } });
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  async refresh() {
    this.notes = this.app.vault.getMarkdownFiles().map((file) => {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      return {
        file,
        path: file.path,
        title: typeof frontmatter.title === "string" ? frontmatter.title : file.basename,
        summary: typeof frontmatter.summary === "string" ? frontmatter.summary : "",
        type: typeof frontmatter.type === "string" ? frontmatter.type : "",
        status: typeof frontmatter.status === "string" ? frontmatter.status : "",
        frontmatter,
        provenance: deriveProvenance(file.path, frontmatter),
      };
    });

    try {
      this.accessEvents = parseAccessLog(await this.app.vault.adapter.read(ACCESS_LOG));
    } catch {
      this.accessEvents = [];
    }

    const projects = new Set(this.notes.map((note) => note.provenance.project).filter(Boolean));
    for (const note of this.notes) {
      const project = accessMetrics(this.accessEvents, note.path).createdByProject;
      if (project) projects.add(project);
    }
    this.updateSelect(this.projectSelect, "All projects", [...projects].sort());
    this.updateSelect(this.roleSelect, "All agent roles", ROLE_OPTIONS);
    const noteTypes = [...new Set(this.notes.map((note) => note.type).filter(Boolean))].sort();
    this.updateSelect(this.typeSelect, "All note types", ["curated", ...noteTypes]);
    if (!this.typeFilterInitialized) {
      this.typeSelect.value = "curated";
      this.typeFilterInitialized = true;
    }
    this.typeFilter = this.typeSelect.value;
    this.renderActivity();
    this.renderResults();
  }

  updateSelect(select, label, options) {
    if (!select) return;
    const previous = select.value;
    select.empty();
    select.createEl("option", { text: label, attr: { value: "" } });
    for (const option of options) {
      const labelText = option === "curated" ? "Curated knowledge" : option;
      select.createEl("option", { text: labelText, attr: { value: option } });
    }
    select.value = options.includes(previous) ? previous : "";
  }

  renderActivity() {
    this.activityEl.empty();
    const observed = this.accessEvents.filter((event) => ["memory_read", "memory_search", "memory_list", "agent_memory_read", "short_memory_read"].includes(event.tool));
    this.activityEl.createEl("p", {
      text: `${observed.length} agent lookup events observed${observed.length ? " since logging began" : "; access history unavailable"}.`,
      cls: "avw-muted",
    });
    const roles = new Map();
    const projects = new Map();
    for (const event of observed) {
      const role = event.role ?? "role unknown";
      roles.set(role, (roles.get(role) ?? 0) + 1);
      const eventProjects = new Set(event.project ? [event.project] : []);
      for (const eventPath of [event.path, ...event.paths]) {
        const project = eventPath?.match(/^projects\/([^/]+)\//)?.[1];
        if (project) eventProjects.add(project);
      }
      for (const project of eventProjects) projects.set(project, (projects.get(project) ?? 0) + 1);
    }
    if (roles.size) {
      this.activityEl.createEl("h4", { text: "Lookups by declared role" });
      const list = this.activityEl.createEl("ul", { cls: "avw-role-counts" });
      for (const [role, count] of [...roles].sort((a, b) => b[1] - a[1])) {
        list.createEl("li", { text: `${role}: ${count}` });
      }
    }
    if (projects.size) {
      this.activityEl.createEl("h4", { text: "Lookups by project" });
      const list = this.activityEl.createEl("ul", { cls: "avw-role-counts" });
      for (const [project, count] of [...projects].sort((a, b) => b[1] - a[1])) {
        list.createEl("li", { text: `${project}: ${count}` });
      }
    }
  }

  renderResults() {
    if (!this.resultsEl) return;
    this.resultsEl.empty();
    const filtered = this.notes
      .map((note) => ({ note, metrics: accessMetrics(this.accessEvents, note.path) }))
      .filter(({ note, metrics }) => matchesNote(note, this.searchText, this.projectFilter, this.roleFilter, this.typeFilter, {
        project: metrics.createdByProject,
        role: metrics.createdByRole,
      }))
      .sort((a, b) => b.metrics.count - a.metrics.count || a.note.title.localeCompare(b.note.title));
    const matches = filtered.slice(0, 100);

    this.resultsEl.createEl("p", { text: `${filtered.length} notes${filtered.length > matches.length ? " (showing first 100)" : ""}`, cls: "avw-muted" });
    for (const { note, metrics } of matches) {
      const row = this.resultsEl.createDiv({ cls: "avw-result" });
      const open = row.createEl("button", { text: note.title, attr: { type: "button" } });
      open.addEventListener("click", () => this.openNote(note));
      row.createEl("small", {
        text: `${note.type || "note"} · ${note.provenance.project ?? metrics.createdByProject ?? "project unknown"} · ${note.provenance.role ?? metrics.createdByRole ?? "role unknown"} · ${metrics.count} observed lookups`,
      });
      if (note.summary) row.createEl("p", { text: note.summary });
    }

    if (this.selectedPath) {
      const selected = this.notes.find((note) => note.path === this.selectedPath);
      if (selected) this.renderDetails(selected);
    }
  }

  async openNote(note) {
    this.selectedPath = note.path;
    await this.app.workspace.getLeaf(false).openFile(note.file);
    this.renderDetails(note);
  }

  renderDetails(note) {
    this.detailEl.empty();
    this.detailEl.createEl("h3", { text: "Note details" });
    const provenance = note.provenance;
    const metrics = accessMetrics(this.accessEvents, note.path);
    const details = this.detailEl.createEl("dl", { cls: "avw-metadata" });
    this.addDetail(details, "Project", `${provenance.project ?? "unknown"} (${provenance.projectSource})`);
    this.addDetail(details, "Agent role", `${provenance.role ?? "unknown"} (${provenance.roleSource})`);
    this.addDetail(details, "Observed lookups", String(metrics.count));
    this.addDetail(details, "Last lookup", metrics.lastAccess ?? "not observed");
    this.addDetail(details, "Creator role (logged)", metrics.createdByRole ?? "not recorded");
    this.addDetail(details, "Creation project (logged)", metrics.createdByProject ?? "not recorded");
    this.addDetail(details, "Status", note.status || "not set");
    this.addRelatedLinks(note, "Outgoing links", this.app.metadataCache.getFileCache(note.file)?.links ?? []);

    const backlinks = [];
    const resolved = this.app.metadataCache.resolvedLinks ?? {};
    for (const [sourcePath, targets] of Object.entries(resolved)) {
      if (targets[note.path]) {
        const file = this.app.vault.getAbstractFileByPath(sourcePath);
        if (file && file.extension === "md") backlinks.push({ link: sourcePath });
      }
    }
    this.addRelatedLinks(note, "Backlinks", backlinks);
  }

  addDetail(parent, label, value) {
    parent.createEl("dt", { text: label });
    parent.createEl("dd", { text: value });
  }

  addRelatedLinks(note, heading, links) {
    const resolved = [];
    for (const link of links) {
      const file = this.app.metadataCache.getFirstLinkpathDest(link.link, note.path);
      if (file && file.path !== note.path && !resolved.some((item) => item.path === file.path)) resolved.push(file);
    }
    if (!resolved.length) return;
    this.detailEl.createEl("h4", { text: heading });
    const list = this.detailEl.createEl("ul");
    const visibleLinks = resolved.slice(0, 20);
    const nameCounts = new Map();
    for (const file of visibleLinks) nameCounts.set(file.basename, (nameCounts.get(file.basename) ?? 0) + 1);
    for (const file of visibleLinks) {
      const item = list.createEl("li");
      const parentName = file.path.split("/").at(-2) ?? "";
      const label = nameCounts.get(file.basename) > 1 ? `${file.basename} · ${parentName}` : file.basename;
      const button = item.createEl("button", { text: label, attr: { type: "button" } });
      button.addEventListener("click", () => {
        const noteTarget = this.notes.find((note) => note.path === file.path);
        if (noteTarget) this.openNote(noteTarget);
        else this.app.workspace.getLeaf(false).openFile(file);
      });
    }
  }
}

module.exports = class AgentVaultWikiPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new AgentVaultWikiView(leaf, this));
    this.addRibbonIcon("book-open", "Open Agent Vault Wiki", () => this.activateView());
    this.addCommand({ id: "open-wiki", name: "Open wiki search", callback: () => this.activateView() });
    this.registerEvent(this.app.metadataCache.on("changed", () => {
      for (const view of this.app.workspace.getLeavesOfType(VIEW_TYPE)) view.view.refresh();
    }));
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf) this.app.workspace.revealLeaf(leaf);
  }
};
