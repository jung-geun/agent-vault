import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installAgents } from "../lib/installer.mjs";

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const bun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

// The real extension, loaded the way OMP loads it, with a stand-in for OMP's command API and prompt UI.
const driver = `
const [extension, argument, answer] = process.argv.slice(2);
let registered;
(await import(extension)).default({ registerCommand: (name, options) => { registered = { name, ...options }; } });
const notes = [];
const confirms = [];
await registered.handler(argument, {
  hasUI: answer !== "no-ui",
  ui: { notify: (message, type) => notes.push([type, message]), confirm: async (title, message) => { confirms.push(\`\${title}\\n\${message}\`); return answer === "yes"; } },
});
console.log(JSON.stringify({ name: registered.name, description: registered.description, notes, confirms }));
`;

async function world(t, { olderBuild = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-test-update-command-"));
  const home = path.join(root, "home");
  await mkdir(home);
  // The installed build is this tree; the "latest" build on the archive server is the same tree under a higher version.
  if (olderBuild) {
    // A build from before the /agent-vault-update command existed: it installs everything else, but does not know that file.
    const old = path.join(root, "older-build");
    await mkdir(old);
    for (const entry of ["bin", "lib", "integrations", "SKILL.md", "package.json"]) await cp(path.join(ROOT, entry), path.join(old, entry), { recursive: true });
    const installer = await readFile(path.join(old, "lib/installer.mjs"), "utf8");
    assert.match(installer, /^    \{ label: "\/agent-vault-update command".*\n/m);
    await writeFile(path.join(old, "lib/installer.mjs"), installer.replace(/^    \{ label: "\/agent-vault-update command".*\n/m, ""));
    await (await import(path.join(old, "lib/installer.mjs"))).installAgents({ sourceDir: old, home, cwd: root, scope: "global", method: "copy", targets: ["omp", "universal"] });
  } else await installAgents({ sourceDir: ROOT, home, cwd: root, scope: "global", method: "copy", targets: ["omp", "universal"] });
  const next = path.join(root, "agent-vault-9.9.9");
  await mkdir(next);
  for (const entry of ["bin", "lib", "integrations", "SKILL.md", "package.json"]) await cp(path.join(ROOT, entry), path.join(next, entry), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(next, "package.json"), "utf8"));
  await writeFile(path.join(next, "package.json"), JSON.stringify({ ...manifest, version: "9.9.9" }));
  const server = await readFile(path.join(next, "bin/vault-mcp.mjs"), "utf8");
  await writeFile(path.join(next, "bin/vault-mcp.mjs"), server.replace(`version: "${manifest.version}" }`, 'version: "9.9.9" }'));
  await exec("tar", ["-czf", path.join(root, "next.tgz"), "-C", root, "agent-vault-9.9.9"]);
  await writeFile(path.join(next, "lib/zz-changed-after-preview.mjs"), "export const changed = true;\n");
  await exec("tar", ["-czf", path.join(root, "changed.tgz"), "-C", root, "agent-vault-9.9.9"]);
  await rm(path.join(next, "lib/zz-changed-after-preview.mjs"));
  const archive = await readFile(path.join(root, "next.tgz"));
  const changed = await readFile(path.join(root, "changed.tgz"));
  const state = { requests: 0, changeFrom: Infinity };
  const web = http.createServer((_, response) => { response.writeHead(200); response.end(state.requests++ >= state.changeFrom ? changed : archive); });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  t.after(async () => { web.closeAllConnections(); await new Promise((resolve) => web.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${web.address().port}/main.tgz`;
  await writeFile(path.join(root, "driver.mjs"), driver);
  const installedVersion = async () => JSON.parse(await readFile(path.join(home, ".omp/agent/skills/agent-vault/package.json"), "utf8")).version;
  // The children get their own temporary folder: `update` makes a transient agent-vault-update-* folder there, and updater.test.mjs
  // asserts that none is left in the shared one while this file runs in parallel.
  const env = { ...process.env, HOME: home, TMPDIR: path.join(root, "tmp"), NODE_NO_WARNINGS: "1" };
  await mkdir(env.TMPDIR);
  const command = async (argument, answer, archiveUrl = url) => JSON.parse((await exec("bun", [path.join(root, "driver.mjs"), path.join(home, ".omp/agent/extensions/agent-vault-update.ts"), argument, answer], {
    env: { ...env, AGENT_VAULT_ARCHIVE_URL: archiveUrl }, cwd: root,
  })).stdout);
  const installedCli = (...args) => exec(process.execPath, [path.join(home, ".omp/agent/skills/agent-vault/bin/vault-cli.mjs"), "update", ...args], { env, cwd: root });
  return { home, url, installedVersion, command, installedCli, changeArchiveAfterNextDownload: () => { state.changeFrom = state.requests + 1; } };
}

test("/agent-vault-update checks, asks, and installs exactly the plan that was shown", { skip: !bun && "bun is not installed" }, async (t) => {
  const w = await world(t);
  const installed = await w.installedVersion();
  assert.notEqual(installed, "9.9.9");

  const check = await w.command("check", "yes");
  assert.equal(check.name, "agent-vault-update");
  assert.match(check.description, /Check for a newer Agent Vault/);
  assert.equal(check.confirms.length, 0, "check never asks and never installs");
  assert.match(check.notes.map(([, message]) => message).join("\n"), new RegExp(`Version ${installed.replaceAll(".", "\\.")} -> 9\\.9\\.9[\\s\\S]*Run /agent-vault-update to install it`));
  assert.equal(await w.installedVersion(), installed);

  const declined = await w.command("", "no");
  assert.equal(declined.confirms.length, 1);
  assert.match(declined.confirms[0], /^Update Agent Vault\?\nVersion .* -> 9\.9\.9/);
  assert.match(declined.notes.at(-1)[1], /cancelled\. Nothing was changed/);
  assert.equal(await w.installedVersion(), installed, "declining installs nothing");

  const accepted = await w.command("", "yes");
  assert.equal(accepted.confirms.length, 1);
  const done = accepted.notes.map(([, message]) => message).join("\n");
  assert.match(done, /Agent Vault updated to 9\.9\.9 \(new server answered with \d+ tools\)\. Backup \d{8}-\d{6}-\d{3}-[0-9a-f]{6}; undo with 'agent-vault update --rollback .*Restart OMP/);
  assert.equal(await w.installedVersion(), "9.9.9");

  const again = await w.command("", "yes");
  assert.equal(again.confirms.length, 0, "nothing to ask when it is current");
  assert.match(again.notes.at(-1)[1], /up to date \(version 9\.9\.9\)/);
});

test("/agent-vault-update refuses unknown arguments, a missing UI, and a failing download without changing anything", { skip: !bun && "bun is not installed" }, async (t) => {
  const w = await world(t);
  const installed = await w.installedVersion();
  const usage = await w.command("apply --from /tmp/evil", "yes");
  assert.deepEqual(usage.notes, [["warning", "Usage: /agent-vault-update [check]"]], "no way to choose a source from the prompt");
  assert.equal(usage.confirms.length, 0);

  const headless = await w.command("", "no-ui");
  assert.equal(headless.confirms.length, 0);
  assert.match(headless.notes.at(-1)[1], /No interactive UI to confirm with, so nothing was installed\. Run 'agent-vault update' in a terminal/);

  const broken = await w.command("", "yes", "http://127.0.0.1:9/never.tgz");
  assert.equal(broken.confirms.length, 0);
  assert.equal(broken.notes.at(-1)[0], "error");
  assert.match(broken.notes.at(-1)[1], /^Agent Vault update check failed: /);
  assert.equal(await w.installedVersion(), installed);
});

test("/agent-vault-update installs nothing when the download changed between the preview and the confirmation", { skip: !bun && "bun is not installed" }, async (t) => {
  const w = await world(t);
  const installed = await w.installedVersion();
  w.changeArchiveAfterNextDownload();
  const result = await w.command("", "yes");
  assert.equal(result.confirms.length, 1, "the user was shown the first plan");
  assert.equal(result.notes.at(-1)[0], "error");
  assert.match(result.notes.at(-1)[1], /^Agent Vault update failed: The plan is now [0-9a-f]{12}, not [0-9a-f]{12}/);
  assert.equal(await w.installedVersion(), installed, "what the user did not see is not installed");
});

test("an older installed CLI still gets the integrations that only the new build knows, through the follow-up pass", async (t) => {
  const w = await world(t, { olderBuild: true });
  const extension = path.join(w.home, ".omp/agent/extensions/agent-vault-update.ts");
  assert.equal(existsSync(extension), false, "the older build never installed the prompt command");
  const preview = await w.installedCli("--archive", w.url, "--dry-run");
  assert.doesNotMatch(preview.stdout, /agent-vault-update command/, "the older CLI cannot even see it");
  assert.equal(existsSync(extension), false);

  const run = await w.installedCli("--archive", w.url, "--yes");
  assert.equal(await w.installedVersion(), "9.9.9");
  assert.equal(existsSync(extension), true, "the new build installed what the old one did not know");
  assert.match(run.stdout, /The new build installed \/agent-vault-update command that the build which ran this update does not know about \(backup \d{8}-/);
  assert.match(run.stdout, /\/agent-vault-update command: installed/);

  const again = await w.installedCli("--archive", w.url, "--yes");
  assert.match(again.stdout, /Already up to date/, "nothing is left for a second run");
  assert.doesNotMatch(again.stdout, /The new build installed/);
});
