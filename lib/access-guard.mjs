// Defense in depth for inspectable tool inputs, not a security sandbox. Arbitrary code can
// construct aliases or access files without literal paths; hard isolation needs OS controls.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadSettings } from "./settings.mjs";

const DIRECT_TOOLS = new Set(["read", "write", "grep", "glob", "find", "edit", "ast_edit", "ast_grep"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "find", "ast_grep"]);
const CODE_TOOLS = new Set(["bash", "sh", "shell", "exec", "eval", "python", "javascript"]);
const REASON = "Agent Vault memory is tool-only. Use Agent Vault MCP tools, not direct vault files, shell, or code. If MCP tools are unavailable, explain and stop memory access. This guard is defense in depth, not a security sandbox.";

function canonical(file) {
  let cursor = path.isAbsolute(file) ? file : `${process.cwd()}/${file}`;
  const suffix = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cursor), ...suffix);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) return path.resolve(file);
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(file);
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

const within = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
const toolName = (name) => String(name ?? "").split(".").at(-1);
const mcpTool = (name) => /^(?:mcp__agent_vault_|agent-vault[./]|agent_vault[./])/.test(String(name ?? "")) || /^mcp__agent_vault_/.test(toolName(name));

export function guardToolCall(vault, event, { cwd = process.cwd(), home = os.homedir(), settings } = {}) {
  if (mcpTool(event?.toolName ?? event?.name)) return undefined;
  const topInput = event?.input ?? event?.arguments;
  if (toolName(event?.toolName ?? event?.name) === "write" && typeof topInput?.path === "string" && /^xd:\/\/mcp__agent_vault_/.test(topInput.path)) return undefined;
  try {
    let currentSettings = settings;
    if (!currentSettings) {
      try { currentSettings = loadSettings(vault); }
      catch { currentSettings = { guard: { mode: "block" } }; }
    }
    if (currentSettings.guard?.mode === "off") return undefined;
    const root = canonical(vault);
    const lexicalRoot = path.resolve(vault);
    const expand = (value) => value
      .replace(/^~(?=$|\/)/, home)
      .replace(/^\$(?:HOME|\{HOME\})(?=$|\/)/, home);
    const protectedPath = (input, base = cwd, scanAncestors = false) => {
      if (typeof input !== "string" || !input) return false;
      let file = input.trim();
      if (/^vault:\/\//i.test(file)) return true;
      if (file.startsWith("file://")) {
        try { file = fileURLToPath(file); } catch { return false; }
      } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file)) return false;
      // Reader selectors and hashline patch snapshots are not part of the filesystem path.
      file = file.replace(/#[A-F0-9]{4}\]?$/i, "").replace(/:(?:raw(?::.*)?|(?:-?\d|\d[,+:]).*)$/, "");
      file = expand(file);
      const wildcard = file.search(/[?*{\[]/);
      const prefix = wildcard < 0 ? file : file.slice(0, wildcard);
      const raw = path.isAbsolute(prefix) ? prefix : `${base}/${prefix || "."}`;
      const resolved = path.resolve(raw);
      const real = canonical(raw);
      if (within(root, real) || within(lexicalRoot, resolved)) return true;
      // Recursive/explicit wildcards rooted above the vault can enumerate its contents.
      return scanAncestors && wildcard >= 0 && (within(real, root) || within(resolved, lexicalRoot));
    };
    const textHasPath = (text, base) => {
      if (typeof text !== "string") return false;
      if (/vault:\/\//i.test(text)) return true;
      // Check quoted paths as a whole, including paths containing spaces.
      for (const match of text.matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
        if (protectedPath(match[1], base)) return true;
      }
      for (const token of text.replace(/\\\//g, "/").split(/[\s"'`();=,<>|&\[\]]+/)) {
        if (token && protectedPath(token.replace(/^\+/, ""), base)) return true;
      }
      return false;
    };
    const pathValues = (value, base, scanAncestors) => {
      if (typeof value === "string") return value.split(";").some((part) => protectedPath(part, base, scanAncestors));
      if (Array.isArray(value)) return value.some((item) => pathValues(item, base, scanAncestors));
      return false;
    };
    const patchHasPath = (patch, base) => {
      if (typeof patch !== "string") return false;
      for (const match of patch.matchAll(/^\[([^\r\n]+)#[A-F0-9]{4}\]\s*$/gmi)) {
        if (protectedPath(match[1], base)) return true;
      }
      return false;
    };
    const seen = new Set();
    const inspect = (name, input, base = cwd) => {
      if (mcpTool(name)) return false;
      const shortName = toolName(name);
      const object = input && typeof input === "object" ? input : {};
      const localBase = typeof object.cwd === "string" ? path.resolve(base, expand(object.cwd)) : base;
      if (DIRECT_TOOLS.has(shortName)) {
        const hasPath = ["path", "paths", "file", "filePath", "filename", "directory"].some((key) => object[key] !== undefined);
        if (!hasPath && protectedPath(localBase, base)) return true;
        for (const key of ["path", "paths", "file", "filePath", "filename", "directory"]) {
          if (pathValues(object[key], localBase, SEARCH_TOOLS.has(shortName))) return true;
        }
        if (shortName === "edit" || shortName === "ast_edit") {
          if (typeof input === "string" && patchHasPath(input, localBase)) return true;
          if ([object.patch, object.content].some((value) => patchHasPath(value, localBase))) return true;
        }
      }
      if (shortName === "write" && typeof object.path === "string" && /^xd:\/\//.test(object.path)) {
        const device = object.path.slice("xd://".length);
        if (DIRECT_TOOLS.has(device) || CODE_TOOLS.has(device) || ["multi_tool_use.parallel", "parallel"].includes(device)) {
          let payload = object.content;
          if (typeof payload === "string") {
            try { payload = JSON.parse(payload); } catch { /* Freeform code still gets inspected. */ }
          }
          if (inspect(device, payload, localBase)) return true;
        }
      }
      if (CODE_TOOLS.has(shortName)) {
        if (protectedPath(localBase, base)) return true;
        if (scanText(input, localBase)) return true;
      }
      return visit(input, localBase);
    };
    const scanText = (value, base) => {
      if (typeof value === "string") return textHasPath(value, base);
      if (Array.isArray(value)) return value.some((item) => scanText(item, base));
      return value && typeof value === "object" && Object.values(value).some((item) => scanText(item, base));
    };
    const visit = (value, base) => {
      if (!value || typeof value !== "object" || seen.has(value)) return false;
      seen.add(value);
      if (Array.isArray(value)) return value.some((item) => visit(item, base));
      const nestedName = value.toolName ?? value.recipient_name ?? value.name;
      if (typeof nestedName === "string" && (value.input !== undefined || value.parameters !== undefined || value.arguments !== undefined)) {
        let nestedInput = value.input ?? value.parameters ?? value.arguments;
        if (typeof nestedInput === "string") {
          try { nestedInput = JSON.parse(nestedInput); } catch { /* Freeform code is inspected by its tool. */ }
        }
        if (inspect(nestedName, nestedInput, base)) return true;
      }
      return Object.values(value).some((item) => visit(item, base));
    };
    if (inspect(event?.toolName ?? event?.name, event?.input ?? event?.arguments)) return { block: true, reason: REASON };
    return undefined;
  } catch (error) {
    // Unexpected non-JSON input must not silently disable inspection.
    return { block: true, reason: `Agent Vault guard could not inspect this call: ${error.message}. Repair the vault configuration before memory access.` };
  }
}
