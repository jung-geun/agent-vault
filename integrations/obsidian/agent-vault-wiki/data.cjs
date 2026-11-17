// agent-vault-managed: Agent Vault Wiki
// @agent-vault-data:start
const ROLES = new Set(["coordinator", "builder", "investigator", "reviewer"]);
const CURATED_TYPES = new Set(["project", "index", "spec", "concept", "decision", "source", "design", "template"]);
const ACCESS_TOOLS = new Set(["memory_read", "memory_search", "memory_list", "agent_memory_read", "short_memory_read"]);
const WRITE_TOOLS = new Set(["memory_write", "agent_memory_write", "agent_handoff", "short_memory_write", "long_memory_write", "worktree_record", "log_write"]);

function parseAccessLog(text) {
  const events = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || typeof value.ts !== "string" || typeof value.tool !== "string") continue;
      events.push({
        ts: value.ts,
        tool: value.tool,
        project: typeof value.project === "string" ? value.project : null,
        role: ROLES.has(value.role) ? value.role : null,
        path: typeof value.path === "string" ? value.path : null,
        paths: Array.isArray(value.paths) ? value.paths.filter((item) => typeof item === "string") : [],
        resultCount: Number.isFinite(value.resultCount) ? value.resultCount : 0,
        created: value.created === true,
      });
    } catch {
      // Ignore incomplete final writes and malformed lines; valid events remain useful.
    }
  }
  return events;
}

function deriveProvenance(path, frontmatter = {}) {
  const pathParts = String(path).split("/");
  const pathProject = pathParts[0] === "projects" ? pathParts[1] ?? null : null;
  const roleIndex = pathParts.indexOf("agents");
  const pathRole = roleIndex >= 0 && ROLES.has(pathParts[roleIndex + 1]) ? pathParts[roleIndex + 1] : null;
  const project = typeof frontmatter.project === "string" ? frontmatter.project : pathProject;
  const role = typeof frontmatter.agent_role === "string" && ROLES.has(frontmatter.agent_role)
    ? frontmatter.agent_role
    : pathRole;
  return {
    project,
    projectSource: typeof frontmatter.project === "string" ? "frontmatter" : pathProject ? "path" : "unknown",
    role,
    roleSource: typeof frontmatter.agent_role === "string" && ROLES.has(frontmatter.agent_role) ? "frontmatter" : pathRole ? "path" : "unknown",
  };
}

function accessMetrics(events, path) {
  const accesses = events.filter((event) => ACCESS_TOOLS.has(event.tool) && (event.path === path || event.paths.includes(path)));
  const writes = events.filter((event) => WRITE_TOOLS.has(event.tool) && (event.path === path || event.paths.includes(path)));
  const last = accesses.map((event) => event.ts).sort().at(-1) ?? null;
  const creation = writes.find((event) => event.created);
  return {
    count: accesses.length,
    lastAccess: last,
    createdByRole: creation?.role ?? null,
    createdByProject: creation?.project ?? null,
  };
}

function matchesNote(note, query, project, role, type, observed = {}) {
  const text = `${note.title} ${note.path} ${note.summary}`.toLocaleLowerCase();
  const typeMatches = !type || (type === "curated" ? CURATED_TYPES.has(note.type) : note.type === type);
  return (!query || text.includes(query.toLocaleLowerCase()))
    && (!project || (note.provenance.project ?? observed.project) === project)
    && (!role || (note.provenance.role ?? observed.role) === role)
    && typeMatches;
}

// @agent-vault-data:end
module.exports = { accessMetrics, deriveProvenance, matchesNote, parseAccessLog };
