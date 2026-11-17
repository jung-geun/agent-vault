import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../bin/vault-cli.mjs", import.meta.url));

async function initGitRepo(dir) {
  await mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main", dir]);
}

test("CLI preserves an explicitly migrated profile while initializing the vault", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-cli-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const wiki = path.join(root, "wiki");
  const profileSource = path.join(wiki, "profiles", "profile.md");
  const vault = path.join(root, "vault");
  await mkdir(path.dirname(profileSource), { recursive: true });
  await writeFile(profileSource, "# Imported profile\n\nPrefer concise responses.\n");

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "migrate",
    "--from-wiki", wiki,
    "--profile-source", "profiles/profile.md",
    "--path", vault,
  ], { encoding: "utf8" });

  assert.match(stdout, /Profile notes migrated: 1/);
  assert.match(await readFile(path.join(vault, "user/profile.md"), "utf8"), /Prefer concise responses\./);
  assert.match(await readFile(path.join(vault, "user/coding-standards.md"), "utf8"), /User Coding Standards/);
});

test("CLI init adds managed Agent Vault file guidance without replacing project instructions", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-init-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const vault = path.join(root, "vault");
  await initGitRepo(project);
  const instructionsPath = path.join(project, "AGENTS.md");
  await writeFile(instructionsPath, "# Project rules\n\nKeep existing guidance.\n");

  const runInit = () => execFileAsync(process.execPath, [cliPath, "init", "--path", vault], { cwd: project, encoding: "utf8" });
  const first = await runInit();
  const instructions = await readFile(instructionsPath, "utf8");
  assert.match(first.stdout, /Agent Vault project guidance configured: .*AGENTS\.md/);
  assert.match(instructions, /# Project rules[\s\S]*Keep existing guidance\./);
  assert.match(instructions, /`index\.md`: project identity/);
  assert.match(instructions, /\.agent-vault-project/);
  assert.match(instructions, /Long-term decisions and lessons live in SQLite/);
  assert.match(instructions, /defaults 5, 10, 20/);
  assert.match(instructions, /there is no|do not use a direct-file fallback/);
  assert.match(instructions, /not a security sandbox/);

  await runInit();
  const repeated = await readFile(instructionsPath, "utf8");
  assert.equal(repeated.split("<!-- agent-vault:start -->").length - 1, 1);
  assert.equal(repeated.split("<!-- agent-vault:end -->").length - 1, 1);
  assert.match(repeated, /Keep existing guidance\./);
});

test("CLI init adds guidance to existing CLAUDE.md when AGENTS.md is absent", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-init-claude-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initGitRepo(root);
  const vault = path.join(root, "vault");
  const claudePath = path.join(root, "CLAUDE.md");
  await writeFile(claudePath, "# Claude project notes\n");

  const { stdout } = await execFileAsync(process.execPath, [cliPath, "init", "--path", vault], { cwd: root, encoding: "utf8" });
  const instructions = await readFile(claudePath, "utf8");
  assert.match(stdout, /Agent Vault project guidance configured: .*CLAUDE\.md/);
  assert.match(instructions, /# Claude project notes/);
  assert.match(instructions, /## Agent Vault project memory/);
  await assert.rejects(readFile(path.join(root, "AGENTS.md")), { code: "ENOENT" });
});

test("CLI init updates both existing instruction files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-init-both-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initGitRepo(root);
  const vault = path.join(root, "vault");
  const agentsPath = path.join(root, "AGENTS.md");
  const claudePath = path.join(root, "CLAUDE.md");
  await writeFile(agentsPath, "# Agent rules\n");
  await writeFile(claudePath, "# Claude rules\n");

  const { stdout } = await execFileAsync(process.execPath, [cliPath, "init", "--path", vault], { cwd: root, encoding: "utf8" });
  assert.match(stdout, /AGENTS\.md/);
  assert.match(stdout, /CLAUDE\.md/);
  assert.match(await readFile(agentsPath, "utf8"), /# Agent rules[\s\S]*agent-vault:start/);
  assert.match(await readFile(claudePath, "utf8"), /# Claude rules[\s\S]*agent-vault:start/);
});

test("CLI init creates AGENTS.md at the git root when neither file exists", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-init-new-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initGitRepo(root);
  const nested = path.join(root, "packages", "app");
  await mkdir(nested, { recursive: true });
  const vault = path.join(root, "vault");

  const { stdout } = await execFileAsync(process.execPath, [cliPath, "init", "--path", vault], { cwd: nested, encoding: "utf8" });
  assert.match(stdout, /Agent Vault project guidance configured: .*AGENTS\.md/);
  assert.match(await readFile(path.join(root, "AGENTS.md"), "utf8"), /## Agent Vault project memory/);
  await assert.rejects(readFile(path.join(nested, "AGENTS.md")), { code: "ENOENT" });
});

test("CLI init preserves symlinked instruction files and updates their target", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-init-symlink-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initGitRepo(root);
  const vault = path.join(root, "vault");
  const target = path.join(root, "project-instructions.md");
  await writeFile(target, "# Shared instructions\n");
  await symlink(target, path.join(root, "AGENTS.md"));

  await execFileAsync(process.execPath, [cliPath, "init", "--path", vault], { cwd: root, encoding: "utf8" });
  assert.equal((await lstat(path.join(root, "AGENTS.md"))).isSymbolicLink(), true);
  assert.match(await readFile(target, "utf8"), /## Agent Vault project memory/);
});

test("CLI init skips project guidance outside a Git repository", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-init-outside-git-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");

  const { stdout } = await execFileAsync(process.execPath, [cliPath, "init", "--path", vault], { cwd: root, encoding: "utf8" });
  assert.match(stdout, /Skipped project guidance: current directory is not inside a Git repository/);
  await assert.rejects(readFile(path.join(root, "AGENTS.md")), { code: "ENOENT" });
});

test("CLI installs and updates managed Obsidian assets without replacing user settings", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-obsidian-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  await execFileAsync(process.execPath, [cliPath, "init", "--path", vault], { cwd: root, encoding: "utf8" });
  const appearancePath = path.join(vault, ".obsidian", "appearance.json");
  const enabledPath = path.join(vault, ".obsidian", "community-plugins.json");
  await writeFile(appearancePath, JSON.stringify({ showRibbon: false, enabledCssSnippets: ["user-theme"] }));
  await writeFile(enabledPath, JSON.stringify(["user-plugin"]));
  const corePluginsPath = path.join(vault, ".obsidian", "core-plugins.json");
  await writeFile(corePluginsPath, JSON.stringify({ sync: true }));

  const install = () => execFileAsync(process.execPath, [cliPath, "install", "--obsidian", "--path", vault], { encoding: "utf8" });
  await install();
  const pluginDir = path.join(vault, ".obsidian", "plugins", "agent-vault-wiki");
  const stylesPath = path.join(pluginDir, "styles.css");
  await writeFile(stylesPath, "/* agent-vault-managed: Agent Vault Wiki */\n/* stale managed CSS */\n");
  await writeFile(path.join(pluginDir, "data.cjs"), "// agent-vault-managed: Agent Vault Wiki\n// old bundled helper\n");
  await install();

  assert.match(await readFile(path.join(vault, ".obsidian", "plugins", "agent-vault-wiki", "main.js"), "utf8"), /agent-vault-managed/);
  await assert.rejects(readFile(path.join(pluginDir, "data.cjs")), { code: "ENOENT" });
  assert.match(await readFile(stylesPath, "utf8"), /\.avw-metadata/);
  assert.deepEqual(JSON.parse(await readFile(enabledPath, "utf8")), ["user-plugin", "agent-vault-wiki"]);
  assert.deepEqual(JSON.parse(await readFile(appearancePath, "utf8")), {
    showRibbon: false,
    enabledCssSnippets: ["user-theme", "agent-vault-reading"],
  });
  assert.match(await readFile(path.join(vault, "_wiki", "views", "Projects.base"), "utf8"), /type: table/);
  assert.deepEqual(JSON.parse(await readFile(corePluginsPath, "utf8")), { sync: true, bases: true });
});

test("CLI preserves an unmarked Obsidian plugin and does not activate it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-obsidian-preserve-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  await execFileAsync(process.execPath, [cliPath, "init", "--path", vault], { cwd: root, encoding: "utf8" });
  const pluginDir = path.join(vault, ".obsidian", "plugins", "agent-vault-wiki");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, "main.js"), "// user-owned plugin\n");

  const { stderr } = await execFileAsync(process.execPath, [cliPath, "install", "--obsidian", "--path", vault], { encoding: "utf8" });
  assert.match(stderr, /Plugin activation skipped/);
  assert.equal(await readFile(path.join(pluginDir, "main.js"), "utf8"), "// user-owned plugin\n");
  await assert.rejects(readFile(path.join(vault, ".obsidian", "community-plugins.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(pluginDir, "data.cjs")), { code: "ENOENT" });
});

async function installFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-cli-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  await mkdir(home);
  await mkdir(cwd);
  return { root, home, cwd, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

test("CLI no arguments outside a terminal prints help without installing", async (t) => {
  const options = await installFixture(t);
  const { stdout } = await execFileAsync(process.execPath, [cliPath], options);
  assert.match(stdout, /Usage:/);
  await assert.rejects(lstat(path.join(options.home, ".omp")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(options.home, ".agents")), { code: "ENOENT" });
});

test("CLI rejects interactive nonterminal installs before any writes", async (t) => {
  const options = await installFixture(t);
  await assert.rejects(execFileAsync(process.execPath, [cliPath, "install", "--interactive"], options), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /requires an interactive terminal; no files were changed/);
    return true;
  });
  await assert.rejects(lstat(path.join(options.home, ".agents")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(options.home, ".omp")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(options.cwd, ".omp")), { code: "ENOENT" });
});

test("CLI explicit agent selection installs skills without unselected OMP integrations", async (t) => {
  const options = await installFixture(t);
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath, "install", "--global", "--agents", "claude,cursor", "--method", "copy",
  ], options);
  assert.match(stdout, /configure the agent-vault MCP server manually/);
  for (const directory of [".claude", ".cursor"]) {
    assert.match(await readFile(path.join(options.home, directory, "skills/agent-vault/SKILL.md"), "utf8"), /name: agent-vault/);
  }
  await assert.rejects(lstat(path.join(options.home, ".omp")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(options.home, ".agents")), { code: "ENOENT" });
});

test("CLI existing local install defaults to an independent OMP copy", async (t) => {
  const options = await installFixture(t);
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "install", "--local"], options);
  assert.match(stdout, /Installed agent-vault skill locally/);
  const destination = path.join(options.cwd, ".omp/skills/agent-vault");
  assert.equal((await lstat(destination)).isSymbolicLink(), false);
  assert.match(await readFile(path.join(destination, "SKILL.md"), "utf8"), /name: agent-vault/);
  await assert.rejects(lstat(path.join(options.cwd, ".agents")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(options.home, ".omp")), { code: "ENOENT" });
});

test("CLI existing global install copies OMP and Universal and merges MCP settings", async (t) => {
  const options = await installFixture(t);
  const config = path.join(options.home, ".omp/agent/mcp.json");
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, JSON.stringify({ custom: 1, mcpServers: { unrelated: { command: "keep" } } }));
  await execFileAsync(process.execPath, [cliPath, "install", "--global"], options);
  for (const directory of [".omp/agent", ".agents"]) {
    const destination = path.join(options.home, directory, "skills/agent-vault");
    assert.equal((await lstat(destination)).isSymbolicLink(), false);
    assert.match(await readFile(path.join(destination, "SKILL.md"), "utf8"), /name: agent-vault/);
  }
  const installed = JSON.parse(await readFile(config, "utf8"));
  assert.equal(installed.custom, 1);
  assert.deepEqual(installed.mcpServers.unrelated, { command: "keep" });
  assert.equal(installed.mcpServers["agent-vault"].env.AGENT_VAULT_HARNESS, "omp");
  assert.match(await readFile(path.join(options.home, ".omp/agent/extensions/agent-vault-recorder.ts"), "utf8"), /managed by agent-vault/);
});

test("CLI selected local symlink targets use a stable Universal copy", async (t) => {
  const options = await installFixture(t);
  await execFileAsync(process.execPath, [cliPath, "install", "--local", "--agents", "claude", "--method", "symlink"], options);
  const canonical = path.join(options.cwd, ".agents/skills/agent-vault");
  const linked = path.join(options.cwd, ".claude/skills/agent-vault");
  assert.equal((await lstat(canonical)).isSymbolicLink(), false);
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(linked, "package.json"), "utf8"), await readFile(path.join(canonical, "package.json"), "utf8"));
  await assert.rejects(lstat(path.join(options.home, ".omp")), { code: "ENOENT" });
});

test("CLI rejects invalid installer flags without touching agent paths", async (t) => {
  const options = await installFixture(t);
  for (const flags of [
    ["--agents", "unknown"], ["--method", "bad"], ["--agents"], ["--global", "--local"],
    ["--obsidian", "--agents", "claude"], ["--unknown"],
  ]) {
    await assert.rejects(execFileAsync(process.execPath, [cliPath, "install", ...flags], options));
  }
  await assert.rejects(lstat(path.join(options.home, ".agents")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(options.home, ".omp")), { code: "ENOENT" });
});

test("CLI default global Copy refreshes an existing copy while explicit Symlink preserves OMP integrations", async (t) => {
  const { home, cwd } = await installFixture(t);
  const env = { ...process.env, HOME: home };
  await execFileAsync(process.execPath, [cliPath, "install", "--global"], { cwd, env });
  const recorder = path.join(home, ".omp/agent/extensions/agent-vault-recorder.ts");
  const server = path.join(home, ".omp/agent/skills/agent-vault/bin/vault-mcp.mjs");
  const configPath = path.join(home, ".omp/agent/mcp.json");
  const oldRecorder = "// agent-vault-recorder: managed by agent-vault install.\n// old upgrade sentinel\n";
  await writeFile(recorder, oldRecorder);
  await writeFile(server, "// old MCP upgrade sentinel\n");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.mcpServers["agent-vault"].command = "old-node";
  config.mcpServers["agent-vault"].env.CUSTOM_OPTION = "keep";
  await writeFile(configPath, JSON.stringify(config));
  const preserved = await execFileAsync(process.execPath, [cliPath, "install", "--global", "--method", "symlink"], { cwd, env });
  assert.match(preserved.stderr, /choose Copy to upgrade/);
  assert.match(preserved.stdout, /OMP MCP, rule and recorder preserved/);
  assert.equal(await readFile(recorder, "utf8"), oldRecorder);
  assert.equal(await readFile(server, "utf8"), "// old MCP upgrade sentinel\n");
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).mcpServers["agent-vault"].command, "old-node");
  await execFileAsync(process.execPath, [cliPath, "install", "--global"], { cwd, env });
  assert.doesNotMatch(await readFile(recorder, "utf8"), /old upgrade sentinel/);
  assert.doesNotMatch(await readFile(server, "utf8"), /old MCP upgrade sentinel/);
  const updated = JSON.parse(await readFile(configPath, "utf8")).mcpServers["agent-vault"];
  assert.equal(updated.command, "node");
  assert.equal(updated.env.CUSTOM_OPTION, "keep");
});

test("Obsidian installation accepts an explicitly selected vault alias", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-obsidian-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  const alias = path.join(root, "vault-alias");
  await mkdir(vault);
  await symlink(vault, alias, "dir");
  await execFileAsync(process.execPath, [cliPath, "install", "--obsidian", "--path", alias], { cwd: root });
  assert.equal((await lstat(alias)).isSymbolicLink(), true);
  assert.match(await readFile(path.join(vault, ".obsidian/plugins/agent-vault-wiki/main.js"), "utf8"), /agent-vault-managed/);
  assert.ok(JSON.parse(await readFile(path.join(vault, ".obsidian/community-plugins.json"), "utf8")).includes("agent-vault-wiki"));
});
