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
