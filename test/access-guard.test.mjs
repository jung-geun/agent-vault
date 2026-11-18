import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { guardToolCall } from "../lib/access-guard.mjs";
import { saveSettings } from "../lib/settings.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const vault = path.join(home, ".vault");
  const repo = path.join(root, "repo");
  await mkdir(path.join(vault, "user"), { recursive: true });
  await mkdir(repo);
  await writeFile(path.join(vault, "user/profile.md"), "fixture");
  const check = (toolName, input, extra = {}) => guardToolCall(vault, { toolName, input }, { cwd: repo, home, ...extra });
  return { root, home, vault, repo, check };
}

function blocked(result) {
  assert.equal(result?.block, true);
  assert.match(result.reason, /tool-only/);
  assert.match(result.reason, /not a security sandbox/);
}

test("guard blocks explicit read/write/search/edit paths including selectors and traversal", async (t) => {
  const { vault, repo, check } = await fixture(t);
  for (const name of ["read", "write", "grep", "glob", "find", "edit", "ast_edit", "ast_grep", "functions.read"]) {
    blocked(check(name, { path: path.join(vault, "user/profile.md") }));
  }
  blocked(check("read", { path: `${vault}/user/profile.md:5-10:raw` }));
  blocked(check("read", { path: `${vault}/user/../user/profile.md` }));
  blocked(check("read", { path: path.relative(repo, path.join(vault, "user/profile.md")) }));
  blocked(check("read", { path: `${pathToFileURL(vault)}/user/profile.md` }));
  blocked(check("find", { path: "vault://_/user", query: "profile" }));
  blocked(check("grep", { path: `src;${vault}/user`, pattern: "fixture" }));
  blocked(check("glob", { path: `${vault}/**/*.md` }));
  blocked(check("read", {}, { cwd: vault }));
  blocked(check("edit", `*** Begin Patch\n[${vault}/user/profile.md#A1B2]\nPUT 1.=1:\n+changed\n*** End Patch`));
});

test("guard resolves symlink aliases and nonexistent write targets", async (t) => {
  const { root, vault, check } = await fixture(t);
  const alias = path.join(root, "alias");
  await symlink(vault, alias);
  blocked(check("read", { path: `${alias}/user/profile.md` }));
  blocked(check("write", { path: `${alias}/new/subdir/note.md` }));
  blocked(check("bash", { command: `cat ${alias}/user/profile.md` }));
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(path.join(vault, "user/profile.md"), path.join(outside, "profile-link"));
  blocked(check("read", { path: path.join(outside, "profile-link") }));
});

test("guard blocks shell and eval literal vault paths without blocking useful shell", async (t) => {
  const { vault, check } = await fixture(t);
  for (const command of [
    `cat '${vault}/user/profile.md'`,
    "cat ~/.vault/user/profile.md", "cat $HOME/.vault/user/profile.md", "cat ${HOME}/.vault/user/profile.md",
    `node bin/vault-cli.mjs status --path '${vault}'`,
    `python -c 'open("${vault}/user/profile.md").read()'`,
  ]) blocked(check("bash", { command }));
  blocked(check("eval", { language: "py", code: `open("${vault}/user/profile.md").read()` }));
  blocked(check("eval", { language: "js", code: `await tool.read({path: "${vault}/user/profile.md"})` }));
  blocked(check("bash", { command: "ls", cwd: vault }));
  assert.equal(check("bash", { command: "npm run check" }), undefined);
  assert.equal(check("bash", { command: "git status --short" }), undefined);
  assert.equal(check("eval", { language: "py", code: 'print("hello")' }), undefined);
  assert.equal(check("read", { path: `${vault}-unrelated/profile.md` }), undefined);
});

test("guard inspects nested parallel, eval and tool device payloads", async (t) => {
  const { vault, check } = await fixture(t);
  const nested = { tool_uses: [{ recipient_name: "functions.read", parameters: { path: `${vault}/user/profile.md` } }] };
  blocked(check("multi_tool_use.parallel", nested));
  blocked(check("multi_tool_use.parallel", { tool_uses: [{ recipient_name: "functions.eval", parameters: { code: `await tool.read({path:"${vault}/user/profile.md"})` } }] }));
  blocked(check("write", { path: "xd://eval", content: JSON.stringify({ language: "py", code: `open("${vault}/user/profile.md")` }) }));
  blocked(check("write", { path: "xd://read", content: JSON.stringify({ path: `${vault}/user/profile.md` }) }));
  blocked(check("parallel", { calls: [{ toolName: "read", arguments: JSON.stringify({ path: `${vault}/user/profile.md` }) }] }));
  assert.equal(check("multi_tool_use.parallel", { tool_uses: [{ recipient_name: "functions.read", parameters: { path: "package.json" } }] }), undefined);
});

test("guard allows provided MCP tools including device routes and never disables them on bad settings", async (t) => {
  const { vault, check } = await fixture(t);
  const payload = { path: `${vault}/user/profile.md`, content: "fixture" };
  assert.equal(check("mcp__agent_vault_doc_read", payload), undefined);
  assert.equal(check("functions.mcp__agent_vault_doc_write", payload), undefined);
  assert.equal(check("write", { path: "xd://mcp__agent_vault_doc_read", content: JSON.stringify(payload) }), undefined);
  await mkdir(path.join(vault, ".agent-vault"), { recursive: true });
  await writeFile(path.join(vault, ".agent-vault/settings.json"), "invalid json");
  assert.equal(check("mcp__agent_vault_context", {}), undefined);
  assert.equal(check("write", { path: "xd://mcp__agent_vault_context", content: "{}" }), undefined);
  assert.equal(check("read", { path: `${vault}/user/profile.md` }).block, true);
  assert.equal(check("bash", { command: "git status" }), undefined);
  assert.equal(check("read", { path: "package.json" }), undefined);
});

test("guard honors explicit user off setting", async (t) => {
  const { vault, check } = await fixture(t);
  await saveSettings(vault, { guard: { mode: "off" } });
  assert.equal(check("read", { path: `${vault}/user/profile.md` }), undefined);
});

test("guard permits ordinary shell and code from vault ancestor directories", async (t) => {
  const { home, check } = await fixture(t);
  for (const command of ["ls *.md", "awk '{print $1}' input.txt", "test -f '?'"]) {
    assert.equal(check("bash", { command }, { cwd: home }), undefined);
  }
  assert.equal(check("eval", { code: "if (true) { console.log('ok'); }" }, { cwd: home }), undefined);
  blocked(check("glob", { path: "**/*.md" }, { cwd: home }));
  blocked(check("ast_grep", { path: "**/*.md" }, { cwd: home }));
});

test("guard inspects edit destinations but permits documentation mentioning vault paths", async (t) => {
  const { vault, check } = await fixture(t);
  const patch = "*** Begin Patch\n[README.md#A1B2]\nPUT 1.=1:\n+Use ~/.vault through MCP tools.\n*** End Patch";
  assert.equal(check("edit", patch), undefined);
  assert.equal(check("edit", { path: "README.md", patch }), undefined);
  assert.equal(check("edit", { paths: ["README.md"], content: `Mention ${vault}/user/profile.md` }), undefined);
  assert.equal(check("ast_edit", { path: "lib/example.mjs", content: 'const help = "~/.vault";' }), undefined);
  blocked(check("edit", { patch: `*** Begin Patch\n[${vault}/user/profile.md#A1B2]\nPUT 1.=1:\n+blocked\n*** End Patch` }));
});

test("guard falls back to lexical checks for inaccessible or oversized path candidates", async (t) => {
  const { home, vault, check } = await fixture(t);
  const long = "x".repeat(1024);
  assert.equal(check("bash", { command: `git commit -m "${long}"` }, { cwd: home }), undefined);
  assert.equal(check("eval", { code: `const message = "${long}";` }, { cwd: home }), undefined);
  assert.equal(check("read", { path: long }), undefined);
  blocked(check("read", { path: `${vault}/${long}` }));
});

test("guard keeps lexical protection when candidate canonicalization is denied", async (t) => {
  const { vault, check } = await fixture(t);
  t.mock.method(fs.realpathSync, "native", () => {
    throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
  });
  assert.equal(check("bash", { command: "git status" }), undefined);
  assert.equal(check("read", { path: "package.json" }), undefined);
  blocked(check("read", { path: `${vault}/user/profile.md` }));
});
