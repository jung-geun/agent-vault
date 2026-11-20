import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { findLauncher, getInstallTargets, installAgents, installManagedFile, installRule, installSkillFiles, launcherOnPath, launcherScript, previewInstallAgents, recommendedInstallMethod, registerMcpServer, RECORDER_MARKER } from "../lib/installer.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-targets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "download");
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  for (const directory of [home, cwd, path.join(sourceDir, "bin"), path.join(sourceDir, "lib"), path.join(sourceDir, "integrations/omp")]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(path.join(sourceDir, "package.json"), JSON.stringify({ name: "agent-vault-skill", version: "1.0.0" }));
  await writeFile(path.join(sourceDir, "SKILL.md"), "---\nname: agent-vault\n---\nBundled skill\n");
  await writeFile(path.join(sourceDir, "bin/vault-mcp.mjs"), "// bundled MCP server\n");
  await writeFile(path.join(sourceDir, "lib/installer.mjs"), "// bundled library\n");
  await writeFile(path.join(sourceDir, "integrations/omp/agent-vault.rule.md"), "# Bundled rule\n");
  await writeFile(path.join(sourceDir, "integrations/omp/agent-vault-recorder.ts"), `${RECORDER_MARKER}\n// recorder\n`);
  return { root, sourceDir, home, cwd };
}

async function absent(target) {
  await assert.rejects(lstat(target), { code: "ENOENT" });
}

test("target catalog exposes real global and local agent skill paths", async (t) => {
  const { home, cwd } = await fixture(t);
  const targets = await getInstallTargets({ home, cwd });
  assert.deepEqual(targets.map(({ id }) => id), ["universal", "omp", "claude", "cursor"]);
  for (const [id, globalDir, localDir] of [
    ["universal", ".agents/skills", ".agents/skills"], ["omp", ".omp/agent/skills", ".omp/skills"],
    ["claude", ".claude/skills", ".claude/skills"], ["cursor", ".cursor/skills", ".cursor/skills"],
  ]) {
    const target = targets.find((item) => item.id === id);
    assert.equal(target.globalPath, path.join(home, globalDir, "agent-vault"));
    assert.equal(target.localPath, path.join(cwd, localDir, "agent-vault"));
    assert.equal(target.required, id === "universal");
  }
});

test("copy installs only selected agent trees without unselected OMP config", async (t) => {
  const options = await fixture(t);
  const result = await installAgents({ ...options, targets: ["claude", "cursor"] });
  assert.deepEqual(result.targets.map(({ id }) => id), ["claude", "cursor"]);
  assert.equal(result.integrations.length, 0);
  assert.equal(result.notes.length, 2);
  for (const target of result.targets) {
    assert.equal((await lstat(target.path)).isDirectory(), true);
    assert.equal((await lstat(target.path)).isSymbolicLink(), false);
    assert.match(await readFile(path.join(target.path, "SKILL.md"), "utf8"), /Bundled skill/);
  }
  await writeFile(path.join(result.targets[0].path, "SKILL.md"), "Independent copy\n");
  assert.match(await readFile(path.join(result.targets[1].path, "SKILL.md"), "utf8"), /Bundled skill/);
  await absent(path.join(options.home, ".omp"));
  await absent(path.join(options.home, ".agents"));
});

test("symlinks point to the copied canonical bundle after download removal", async (t) => {
  const options = await fixture(t);
  const result = await installAgents({ ...options, method: "symlink", targets: ["claude", "cursor"] });
  const canonical = path.join(options.home, ".agents/skills/agent-vault");
  assert.equal(result.targets[0].id, "universal");
  assert.equal((await lstat(canonical)).isSymbolicLink(), false);
  await rm(options.sourceDir, { recursive: true });
  for (const id of ["claude", "cursor"]) {
    const target = result.targets.find((item) => item.id === id).path;
    assert.equal((await lstat(target)).isSymbolicLink(), true);
    assert.equal(await realpath(target), await realpath(canonical));
    assert.match(await readFile(path.join(target, "bin/vault-mcp.mjs"), "utf8"), /bundled MCP/);
  }
  await absent(path.join(options.home, ".omp"));
});

test("global OMP installs integrations and preserves unrelated MCP settings", async (t) => {
  const options = await fixture(t);
  const config = path.join(options.home, ".omp/agent/mcp.json");
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, JSON.stringify({ other: true, mcpServers: { unrelated: { command: "keep" } } }));
  const result = await installAgents(options);
  assert.equal(result.integrations.length, 5);
  const launcherPath = path.join(options.home, ".local/bin/agent-vault");
  const bundle = path.join(options.home, ".omp/agent/skills/agent-vault");
  assert.equal(await readFile(launcherPath, "utf8"), launcherScript(bundle), "the launcher runs the bundle OMP launches");
  assert.equal(await readFile(path.join(options.home, ".local/bin/vault-cli"), "utf8"), launcherScript(bundle));
  assert.ok(((await lstat(launcherPath)).mode & 0o111) !== 0, "executable");
  assert.equal(await findLauncher(path.join(bundle, "bin/vault-cli.mjs"), { PATH: `/nowhere${path.delimiter}${path.dirname(launcherPath)}` }), "agent-vault");
  assert.equal(await findLauncher(path.join(options.home, "elsewhere/bin/vault-cli.mjs"), { PATH: path.dirname(launcherPath) }), null, "a launcher for another bundle does not count");
  assert.equal(launcherOnPath(options.home, { PATH: `/usr/bin${path.delimiter}${path.dirname(launcherPath)}` }), true);
  assert.equal(launcherOnPath(options.home, { PATH: "/usr/bin" }), false);
  const installed = JSON.parse(await readFile(config, "utf8"));
  assert.equal(installed.other, true);
  assert.deepEqual(installed.mcpServers.unrelated, { command: "keep" });
  assert.equal(installed.mcpServers["agent-vault"].args[0], path.join(options.home, ".omp/agent/skills/agent-vault/bin/vault-mcp.mjs"));
  assert.equal(installed.mcpServers["agent-vault"].env.AGENT_VAULT_HARNESS, "omp");
  assert.match(await readFile(path.join(options.home, ".omp/agent/extensions/agent-vault-recorder.ts"), "utf8"), /managed by agent-vault/);
});

test("local targets use project paths and never configure global integrations", async (t) => {
  const options = await fixture(t);
  const result = await installAgents({ ...options, scope: "local", targets: ["universal", "omp", "claude", "cursor"] });
  assert.equal(result.integrations.length, 0);
  assert.equal(result.notes.length, 4);
  for (const target of result.targets) assert.equal(target.path.startsWith(`${options.cwd}${path.sep}`), true);
  assert.match(result.targets.find(({ id }) => id === "omp").path, /\.omp\/skills\/agent-vault$/);
  await absent(path.join(options.home, ".omp"));
});

test("copy-to-link conflicts preserve whole directories and skip OMP integrations", async (t) => {
  const options = await fixture(t);
  await installAgents({ ...options, targets: ["omp"] });
  const omp = path.join(options.home, ".omp/agent/skills/agent-vault");
  await writeFile(path.join(omp, "personal.txt"), "Keep me\n");
  const result = await installAgents({ ...options, method: "symlink", targets: ["omp"] });
  assert.match(result.targets.find(({ id }) => id === "omp").status, /^preserved existing directory/);
  assert.equal((await lstat(omp)).isDirectory(), true);
  assert.equal(await readFile(path.join(omp, "personal.txt"), "utf8"), "Keep me\n");
  assert.equal(result.integrations.length, 0);
});

test("unowned trees, unsafe links and symlinked parents remain untouched", async (t) => {
  const options = await fixture(t);
  const foreign = path.join(options.root, "foreign");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "SKILL.md"), "Do not touch\n");
  const catalog = await getInstallTargets(options);
  const claude = catalog.find(({ id }) => id === "claude").globalPath;
  await mkdir(path.dirname(claude), { recursive: true });
  await symlink(foreign, claude, "dir");
  const cursor = catalog.find(({ id }) => id === "cursor").globalPath;
  await mkdir(cursor, { recursive: true });
  await writeFile(path.join(cursor, "personal.txt"), "Keep\n");
  const result = await installAgents({ ...options, targets: ["claude", "cursor"] });
  assert.ok(result.targets.every(({ status }) => status.startsWith("preserved")));
  assert.equal(await readFile(path.join(foreign, "SKILL.md"), "utf8"), "Do not touch\n");
  assert.equal(await readFile(path.join(cursor, "personal.txt"), "utf8"), "Keep\n");
  await symlink(foreign, path.join(options.home, ".omp"), "dir");
  const linkedParent = await installAgents({ ...options, targets: ["omp"] });
  assert.match(linkedParent.targets[0].status, /^preserved unsafe parent/);
  assert.equal(linkedParent.integrations.length, 0);
  await absent(path.join(foreign, "agent"));
});

test("canonical conflict never links other agents to an unowned bundle", async (t) => {
  const options = await fixture(t);
  const canonical = path.join(options.home, ".agents/skills/agent-vault");
  await mkdir(canonical, { recursive: true });
  await writeFile(path.join(canonical, "personal.txt"), "Keep\n");
  const result = await installAgents({ ...options, method: "symlink", targets: ["claude"] });
  assert.ok(result.targets.every(({ status }) => status.startsWith("preserved")));
  await absent(path.join(options.home, ".claude"));
});

test("managed copies update in place, keep extras, and reject nested symlink writes", async (t) => {
  const options = await fixture(t);
  const target = path.join(options.home, "skill");
  assert.equal(await installSkillFiles(options.sourceDir, target), "installed");
  await writeFile(path.join(target, "personal.txt"), "Keep\n");
  await writeFile(path.join(options.sourceDir, "SKILL.md"), "---\nname: agent-vault\n---\nUpdated\n");
  assert.equal(await installSkillFiles(options.sourceDir, target), "updated");
  assert.equal(await readFile(path.join(target, "personal.txt"), "utf8"), "Keep\n");
  const foreign = path.join(options.root, "foreign-server");
  await writeFile(foreign, "Do not touch\n");
  await rm(path.join(target, "bin/vault-mcp.mjs"));
  await symlink(foreign, path.join(target, "bin/vault-mcp.mjs"));
  assert.match(await installSkillFiles(options.sourceDir, target), /^preserved conflicting bundled path/);
  assert.equal(await readFile(foreign, "utf8"), "Do not touch\n");
});

test("managed integration helpers preserve symlinks and unrelated server entries", async (t) => {
  const options = await fixture(t);
  const source = path.join(options.sourceDir, "integrations/omp/agent-vault-recorder.ts");
  const foreign = path.join(options.root, "foreign");
  await writeFile(foreign, `${RECORDER_MARKER}\nKeep\n`);
  const target = path.join(options.home, "recorder.ts");
  await symlink(foreign, target);
  assert.match(await installManagedFile(source, target, RECORDER_MARKER), /^preserved non-regular/);
  assert.match(await installRule(source, target), /^preserved non-regular/);
  assert.match(await registerMcpServer(target, {}), /^preserved non-regular/);
  assert.equal(await readFile(foreign, "utf8"), `${RECORDER_MARKER}\nKeep\n`);
  const config = path.join(options.home, "mcp.json");
  await writeFile(config, JSON.stringify({ mcpServers: { "agent-vault": { command: "user-server" } } }));
  assert.equal(await registerMcpServer(config, { command: "node", args: ["/skills/agent-vault/bin/vault-mcp.mjs"] }), "preserved existing entry that differs");
  assert.equal(JSON.parse(await readFile(config, "utf8")).mcpServers["agent-vault"].command, "user-server");
});

test("invalid plans fail before creating target directories", async (t) => {
  const options = await fixture(t);
  for (const plan of [{ targets: ["unknown"] }, { targets: [] }, { method: "bad" }, { scope: "bad" }]) {
    await assert.rejects(installAgents({ ...options, ...plan }));
  }
  await absent(path.join(options.home, ".agents"));
  await absent(path.join(options.home, ".omp"));
});

test("symlink method preserves foreign links when switching to copy", async (t) => {
  const options = await fixture(t);
  const foreign = path.join(options.root, "foreign-skill");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "SKILL.md"), "Foreign skill\n");
  const destination = path.join(options.home, ".claude/skills/agent-vault");
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(foreign, destination, "dir");
  const linked = await installAgents({ ...options, targets: ["claude"], method: "symlink" });
  assert.equal(linked.targets.find(({ id }) => id === "claude").status, "preserved existing symlink");
  const copied = await installAgents({ ...options, targets: ["claude"], method: "copy" });
  assert.match(copied.targets[0].status, /^preserved/);
  assert.equal(await realpath(destination), await realpath(foreign));
  assert.equal(await readFile(path.join(foreign, "SKILL.md"), "utf8"), "Foreign skill\n");
});

test("owned MCP updates retain custom environment and foreign rule or recorder content", async (t) => {
  const options = await fixture(t);
  await installAgents({ ...options, targets: ["omp"] });
  const configPath = path.join(options.home, ".omp/agent/mcp.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.mcpServers["agent-vault"].env.CUSTOM_OPTION = "keep";
  config.mcpServers["agent-vault"].command = "old-node";
  await writeFile(configPath, JSON.stringify(config));
  const rulePath = path.join(options.home, ".agents/rules/agent-vault.md");
  const recorderPath = path.join(options.home, ".omp/agent/extensions/agent-vault-recorder.ts");
  await writeFile(rulePath, "# Custom user rule\n");
  await writeFile(recorderPath, "// User extension\n");
  const result = await installAgents({ ...options, targets: ["omp"] });
  const updated = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(updated.mcpServers["agent-vault"].command, "node");
  assert.equal(updated.mcpServers["agent-vault"].env.CUSTOM_OPTION, "keep");
  assert.equal(await readFile(rulePath, "utf8"), "# Custom user rule\n");
  assert.equal(await readFile(recorderPath, "utf8"), "// User extension\n");
  assert.equal(result.integrations.filter(({ status }) => status.startsWith("preserved")).length, 2);
});

test("default global copy converts owned canonical links and refreshes OMP integrations", async (t) => {
  const options = await fixture(t);
  await installAgents({ ...options, method: "symlink" });
  const omp = path.join(options.home, ".omp/agent/skills/agent-vault");
  const canonical = path.join(options.home, ".agents/skills/agent-vault");
  assert.equal((await lstat(omp)).isSymbolicLink(), true);
  const updatedRecorder = `${RECORDER_MARKER}\n// updated recorder\n`;
  await writeFile(path.join(canonical, "integrations/omp/agent-vault-recorder.ts"), updatedRecorder);
  const configPath = path.join(options.home, ".omp/agent/mcp.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.mcpServers["agent-vault"].command = "old-node";
  await writeFile(configPath, JSON.stringify(config));
  // The installed CLI can run through the link that copy mode must replace.
  const result = await installAgents({ ...options, sourceDir: omp });
  assert.equal(result.method, "copy");
  assert.equal((await lstat(omp)).isSymbolicLink(), false);
  assert.equal((await lstat(omp)).isDirectory(), true);
  assert.equal(result.integrations.length, 5);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).mcpServers["agent-vault"].command, "node");
  assert.equal(await readFile(path.join(options.home, ".omp/agent/extensions/agent-vault-recorder.ts"), "utf8"), updatedRecorder);
  await writeFile(path.join(omp, "SKILL.md"), "Independent copy\n");
  assert.match(await readFile(path.join(canonical, "SKILL.md"), "utf8"), /Bundled skill/);
});

test("local symlinks remain valid after moving the project", async (t) => {
  const options = await fixture(t);
  await installAgents({ ...options, scope: "local", method: "symlink", targets: ["omp", "claude", "cursor"] });
  for (const agent of [".omp", ".claude", ".cursor"]) {
    assert.equal(path.isAbsolute(await readlink(path.join(options.cwd, agent, "skills/agent-vault"))), false);
  }
  const moved = path.join(options.root, "moved-project");
  await rename(options.cwd, moved);
  for (const agent of [".omp", ".claude", ".cursor"]) {
    const linked = path.join(moved, agent, "skills/agent-vault");
    assert.equal(await realpath(linked), await realpath(path.join(moved, ".agents/skills/agent-vault")));
    assert.match(await readFile(path.join(linked, "SKILL.md"), "utf8"), /Bundled skill/);
  }
});

async function priorGlobalCopy(t) {
  const options = await fixture(t);
  const cli = fileURLToPath(new URL("../bin/vault-cli.mjs", import.meta.url));
  await promisify(execFile)(process.execPath, [cli, "install", "--global"], {
    cwd: options.cwd, env: { ...process.env, HOME: options.home },
  });
  const omp = path.join(options.home, ".omp/agent/skills/agent-vault");
  const recorder = path.join(options.home, ".omp/agent/extensions/agent-vault-recorder.ts");
  const configPath = path.join(options.home, ".omp/agent/mcp.json");
  await writeFile(path.join(omp, "bin/vault-mcp.mjs"), "// outdated installed MCP sentinel\n");
  await writeFile(recorder, `${RECORDER_MARKER}\n// outdated installed recorder sentinel\n`);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.mcpServers["agent-vault"].command = "outdated-node";
  config.mcpServers["agent-vault"].env.CUSTOM_OPTION = "keep";
  await writeFile(configPath, JSON.stringify(config));
  return { ...options, omp, recorder, configPath };
}

test("read-only default Copy preview upgrades a prior CLI global copy and retains custom MCP environment", async (t) => {
  const options = await priorGlobalCopy(t);
  const before = await readFile(options.configPath, "utf8");
  const method = await recommendedInstallMethod(options);
  assert.equal(method, "copy");
  const plan = { ...options, method };
  const preview = await previewInstallAgents(plan);
  assert.equal(preview.targets.find(({ id }) => id === "omp").status, "updated");
  assert.equal(preview.integrations.find(({ label }) => label === "MCP server agent-vault").status, "updated");
  assert.equal(preview.integrations.find(({ label }) => label === "worktree recorder extension").status, "updated");
  assert.equal(await readFile(options.configPath, "utf8"), before);
  assert.match(await readFile(options.recorder, "utf8"), /outdated installed recorder sentinel/);
  assert.match(await readFile(path.join(options.omp, "bin/vault-mcp.mjs"), "utf8"), /outdated installed MCP sentinel/);
  assert.deepEqual(await installAgents(plan), preview);
  assert.match(await readFile(path.join(options.omp, "bin/vault-mcp.mjs"), "utf8"), /bundled MCP server/);
  assert.equal(await readFile(options.recorder, "utf8"), `${RECORDER_MARKER}\n// recorder\n`);
  const config = JSON.parse(await readFile(options.configPath, "utf8"));
  assert.equal(config.mcpServers["agent-vault"].command, "node");
  assert.equal(config.mcpServers["agent-vault"].env.CUSTOM_OPTION, "keep");
});

test("explicit Symlink preview preserves a prior CLI copy and skips all OMP integrations", async (t) => {
  const options = await priorGlobalCopy(t);
  const plan = { ...options, method: "symlink" };
  const preview = await previewInstallAgents(plan);
  assert.match(preview.targets.find(({ id }) => id === "omp").status, /^preserved existing directory.*choose Copy to upgrade/);
  assert.deepEqual(preview.integrations, []);
  assert.match(preview.notes.join("\n"), /OMP MCP, rule and recorder preserved/);
  assert.deepEqual(await installAgents(plan), preview);
  assert.equal((await lstat(options.omp)).isSymbolicLink(), false);
  assert.match(await readFile(options.recorder, "utf8"), /outdated installed recorder sentinel/);
  assert.match(await readFile(path.join(options.omp, "bin/vault-mcp.mjs"), "utf8"), /outdated installed MCP sentinel/);
  assert.equal(JSON.parse(await readFile(options.configPath, "utf8")).mcpServers["agent-vault"].command, "outdated-node");
});

test("preview matches stable links, safe Copy conversion and preserved custom integrations", async (t) => {
  const options = await fixture(t);
  const linked = { ...options, method: "symlink" };
  const fresh = await previewInstallAgents(linked);
  await absent(path.join(options.home, ".agents"));
  await absent(path.join(options.home, ".omp"));
  assert.deepEqual(await installAgents(linked), fresh);
  assert.equal(await recommendedInstallMethod(options), "symlink");
  assert.deepEqual(await installAgents(linked), await previewInstallAgents(linked));
  const recorder = path.join(options.home, ".omp/agent/extensions/agent-vault-recorder.ts");
  await writeFile(recorder, "// custom recorder\n");
  await writeFile(path.join(options.home, ".agents/rules/agent-vault.md"), "# Custom rule\n");
  const copied = { ...options, method: "copy" };
  const preview = await previewInstallAgents(copied);
  assert.equal(preview.integrations.filter(({ status }) => status.startsWith("preserved")).length, 2);
  assert.equal((await lstat(path.join(options.home, ".omp/agent/skills/agent-vault"))).isSymbolicLink(), true);
  assert.deepEqual(await installAgents(copied), preview);
  assert.equal(await readFile(recorder, "utf8"), "// custom recorder\n");
});

test("Copy preview matches conversion of a dangling OMP link when Universal will be installed first", async (t) => {
  const options = await fixture(t);
  const canonical = path.join(options.home, ".agents/skills/agent-vault");
  const omp = path.join(options.home, ".omp/agent/skills/agent-vault");
  await mkdir(path.dirname(omp), { recursive: true });
  await symlink(canonical, omp, "dir");
  const plan = { ...options, method: "copy" };
  const preview = await previewInstallAgents(plan);
  assert.equal(preview.targets.find(({ id }) => id === "omp").status, "installed");
  assert.equal(preview.integrations.length, 5);
  await absent(canonical);
  assert.equal((await lstat(omp)).isSymbolicLink(), true);
  assert.deepEqual(await installAgents(plan), preview);
  assert.equal((await lstat(omp)).isSymbolicLink(), false);
});

test("preserved custom OMP targets never suggest Copy as a fix", async (t) => {
  const options = await fixture(t);
  const omp = path.join(options.home, ".omp/agent/skills/agent-vault");
  await mkdir(omp, { recursive: true });
  await writeFile(path.join(omp, "personal.txt"), "Keep\n");
  for (const method of ["copy", "symlink"]) {
    const preview = await previewInstallAgents({ ...options, method });
    assert.match(preview.targets.find(({ id }) => id === "omp").status, /^preserved/);
    assert.doesNotMatch(JSON.stringify(preview), /[Cc]hoose Copy/);
  }
});

test("the rule file shipped before the tool rename is upgraded in place, and a user-edited rule is preserved", async (t) => {
  const options = await fixture(t);
  const shipped = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "integrations", "omp", "agent-vault.rule.md");
  const previous = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "agent-vault.rule.pre-tool-rename.md");
  const target = path.join(options.home, "agent-vault.md");
  await writeFile(target, await readFile(previous));
  assert.equal(await installRule(shipped, target, { dryRun: true }), "updated from legacy version");
  assert.equal(await installRule(shipped, target), "updated from legacy version");
  assert.deepEqual(await readFile(target), await readFile(shipped));
  assert.equal(await installRule(shipped, target), "already current");
  await writeFile(target, `${await readFile(previous, "utf8")}\nMy own addition.\n`);
  assert.equal(await installRule(shipped, target), "preserved existing file with different content");
});
