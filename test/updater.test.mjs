import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RECORDER_MARKER, installAgents } from "../lib/installer.mjs";
import { initVault } from "../lib/vault-core.mjs";
import { closeMemoryDbs } from "../lib/memory-db.mjs";
import { diagnoseMemory } from "../lib/memory-inspect.mjs";
import { RETIRED_TOOL_NAMES, compareVersions, findRetiredToolReferences, githubArchiveRequest, listUpdateBackups, renderUpdate, rollbackUpdate, runUpdate, smokeTest, UPDATE_BACKUPS_KEPT } from "../lib/updater.mjs";

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(ROOT, "bin/vault-cli.mjs");
let counter = 0;

// A stand-in for the MCP server: answers initialize and tools/list like the real one, or misbehaves on request.
const stubServer = (version, mode) => `
if (${JSON.stringify(mode)} === "crash") { console.error("boom: cannot start"); process.exit(3); }
if (process.env.PROBE_FILE) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(process.env.PROBE_FILE, JSON.stringify({ home: process.env.HOME, db: process.env.AGENT_VAULT_DB_DRIVER ?? null, vaultEnv: process.env.OMP_VAULT_PATH ?? null, harness: process.env.AGENT_VAULT_HARNESS ?? null, args: process.argv.slice(2) }));
}
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf("\\n"); i >= 0; i = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "agent-vault", version: ${JSON.stringify(mode === "wrong-version" ? "0.0.1" : version)} } });
    if (message.method === "tools/list") reply(message.id, { tools: ${mode === "no-tools" ? "[]" : '[{ name: "stub" }]'} });
  }
});
`;

async function makeBundle(dir, { version, mode = "ok", note = "" }) {
  const put = async (rel, text) => { const file = path.join(dir, rel); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
  await put("package.json", JSON.stringify({ name: "agent-vault-skill", version }));
  await put("SKILL.md", "---\nname: agent-vault\n---\nskill\n");
  await put("bin/vault-cli.mjs", `// cli ${version}\n`);
  await put("bin/vault-mcp.mjs", stubServer(version, mode));
  await put("lib/module.mjs", `export const version = "${version}";\n`);
  await put("integrations/omp/agent-vault.rule.md", "rule\n");
  await put("integrations/omp/agent-vault-recorder.ts", `${RECORDER_MARKER} Do not edit in place.\n// recorder ${version}${note}\n`);
  return dir;
}

// A temporary home with an older Agent Vault installed the way `vault-cli install --global` leaves it.
async function world(t, { installed = "0.9.0", targets = ["omp", "universal"] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-update-test-"));
  t.after(async () => { closeMemoryDbs(); await rm(root, { recursive: true, force: true }); });
  const home = path.join(root, "home");
  const cwd = path.join(root, "cwd");
  await mkdir(home);
  await mkdir(cwd);
  const bundle = (version, options = {}) => makeBundle(path.join(root, "sources", `${version}-${counter++}`), { version, ...options });
  if (installed) {
    await installAgents({ sourceDir: await bundle(installed), home, cwd, scope: "global", method: "copy", targets });
    if (targets.includes("universal")) {
      await mkdir(path.join(home, ".claude/skills"), { recursive: true });
      await symlink("../../.agents/skills/agent-vault", path.join(home, ".claude/skills/agent-vault"));
    }
  }
  const paths = {
    omp: path.join(home, ".omp/agent/skills/agent-vault"),
    universal: path.join(home, ".agents/skills/agent-vault"),
    claude: path.join(home, ".claude/skills/agent-vault"),
    mcp: path.join(home, ".omp/agent/mcp.json"),
    recorder: path.join(home, ".omp/agent/extensions/agent-vault-recorder.ts"),
  };
  const version = async (dir) => JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")).version;
  const update = (options) => runUpdate({ home, cwd, ...options });
  return { root, home, cwd, bundle, paths, version, update };
}

// Every file and link under `dir`, except the update backups themselves.
async function snapshot(dir) {
  const out = {};
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (rel === ".agent-vault") continue;
      if (entry.isSymbolicLink()) out[rel] = `link:${await readlink(full)}`;
      else if (entry.isDirectory()) { out[rel] = "dir"; await visit(full); }
      else out[rel] = createHash("sha256").update(await readFile(full)).digest("hex");
    }
  }
  await visit(dir);
  return out;
}

const mcpConfig = async (w) => JSON.parse(await readFile(w.paths.mcp, "utf8"));

test("versions compare numerically and a release outranks its own prerelease", () => {
  for (const [a, b, expected] of [["1.2.0", "1.10.0", -1], ["2.0.0", "1.99.99", 1], ["1.0.0", "1.0.0", 0], ["1.0.0-rc.1", "1.0.0", -1], ["1.0.0", "1.0.0-rc.1", 1], ["1.0.0-rc.1", "1.0.0-rc.2", -1], ["1.0.0+build", "1.0.0", 0]]) {
    assert.equal(compareVersions(a, b), expected, `${a} vs ${b}`);
  }
  assert.throws(() => compareVersions("1.0", "1.0.0"), (error) => error.code === "invalid_version");
});

test("a GitHub archive request only carries a token to the API host and rejects unsafe refs", () => {
  assert.deepEqual(githubArchiveRequest("main"), { url: "https://github.com/jung-geun/agent-vault/archive/main.tar.gz", headers: {} });
  assert.deepEqual(githubArchiveRequest("v1.2.0", "tok"), { url: "https://api.github.com/repos/jung-geun/agent-vault/tarball/v1.2.0", headers: { Authorization: "Bearer tok" } });
  assert.equal(githubArchiveRequest("feature/x-1").url.endsWith("/archive/feature/x-1.tar.gz"), true);
  for (const bad of ["", "../x", "a b", "a;b", "-rf", "x/../y", "a\nb"]) assert.throws(() => githubArchiveRequest(bad), (error) => error.code === "invalid_ref", JSON.stringify(bad));
});

test("an update replaces every owned bundle, follows links, refreshes the OMP files and keeps unrelated settings", async (t) => {
  const w = await world(t);
  const config = await mcpConfig(w);
  config.mcpServers["agent-vault"].env.CUSTOM = "kept";
  config.mcpServers.other = { type: "stdio", command: "other" };
  await writeFile(w.paths.mcp, JSON.stringify(config, null, 2));

  const result = await w.update({ from: await w.bundle("1.0.0") });

  assert.deepEqual(result.applied.updated.map((item) => item.id).sort(), ["omp", "universal"]);
  assert.equal(await w.version(w.paths.omp), "1.0.0");
  assert.equal(await w.version(w.paths.universal), "1.0.0");
  assert.equal((await lstat(w.paths.claude)).isSymbolicLink(), true, "a link stays a link");
  assert.equal(await w.version(w.paths.claude), "1.0.0", "and follows the updated bundle");
  const after = await mcpConfig(w);
  assert.equal(after.mcpServers["agent-vault"].env.CUSTOM, "kept");
  assert.equal(after.mcpServers["agent-vault"].env.AGENT_VAULT_HARNESS, "omp");
  assert.deepEqual(after.mcpServers.other, { type: "stdio", command: "other" });
  assert.match(await readFile(w.paths.recorder, "utf8"), /recorder 1\.0\.0/);
  assert.deepEqual(result.applied.verified, { version: "1.0.0", tools: 1 });
  assert.match(result.notes.join("\n"), /Restart OMP/);
  assert.equal(result.plan.targets.find((item) => item.id === "claude").action, "follows");
});

test("a dry run changes nothing and an update that is already current does nothing", async (t) => {
  const w = await world(t);
  const source = await w.bundle("1.0.0");
  const before = await snapshot(w.home);
  const dry = await w.update({ from: source, dryRun: true });
  assert.equal(dry.applied, null);
  assert.equal(dry.plan.current, false);
  assert.deepEqual(dry.plan.targets.filter((item) => item.action === "update").map((item) => [item.id, item.version]), [["universal", "0.9.0"], ["omp", "0.9.0"]]);
  assert.deepEqual(await snapshot(w.home), before);
  assert.equal(existsSync(path.join(w.home, ".agent-vault")), false, "not even the backup folder is created");

  await w.update({ from: source });
  const again = await w.update({ from: source });
  assert.equal(again.plan.current, true);
  assert.equal(again.applied.id, null);
  assert.equal((await listUpdateBackups(w.home)).length, 1, "an up-to-date run makes no backup");
});

test("a newer install is not downgraded unless asked", async (t) => {
  const w = await world(t, { installed: "1.5.0" });
  await assert.rejects(w.update({ from: await w.bundle("1.0.0") }), (error) => error.code === "downgrade" && /1\.5\.0/.test(error.message));
  assert.equal(await w.version(w.paths.omp), "1.5.0");
  await w.update({ from: await w.bundle("1.0.0"), allowDowngrade: true });
  assert.equal(await w.version(w.paths.omp), "1.0.0");
});

test("a new server that does not boot is rolled back byte for byte, and only verification catches it", async (t) => {
  for (const [mode, pattern] of [["crash", /boom/], ["wrong-version", /reports version "0\.0\.1"/], ["no-tools", /listed no tools/]]) {
    const w = await world(t);
    const before = await snapshot(w.home);
    await assert.rejects(w.update({ from: await w.bundle("1.0.0", { mode }) }), (error) => {
      assert.equal(error.code, "verification_failed", mode);
      assert.equal(error.rolledBack, true, mode);
      assert.match(error.message, pattern, mode);
      assert.match(error.message, /previous build was restored/, mode);
      return true;
    });
    assert.deepEqual(await snapshot(w.home), before, `${mode}: every file is back as it was`);
    assert.equal((await listUpdateBackups(w.home))[0].rolledBack, true, mode);
  }
  const unverified = await world(t);
  await unverified.update({ from: await unverified.bundle("1.0.0", { mode: "crash" }), verify: false });
  assert.equal(await unverified.version(unverified.paths.omp), "1.0.0", "--no-verify skips the check");
});

test("rollback restores the previous build, leaves files edited since, and works once", async (t) => {
  const w = await world(t);
  const before = await mcpConfig(w);
  const originalRecorder = await readFile(w.paths.recorder, "utf8");
  const { applied } = await w.update({ from: await w.bundle("1.0.0") });
  await writeFile(w.paths.recorder, `${await readFile(w.paths.recorder, "utf8")}// local edit\n`);

  const result = await rollbackUpdate({ home: w.home });

  assert.equal(result.id, applied.id);
  assert.equal(await w.version(w.paths.omp), "0.9.0");
  assert.equal(await w.version(w.paths.universal), "0.9.0");
  assert.deepEqual(await mcpConfig(w), before);
  assert.deepEqual(result.skipped.map((item) => item.path), [w.paths.recorder], "a recorder edited after the update is not overwritten");
  assert.match(await readFile(w.paths.recorder, "utf8"), /local edit/);
  assert.notEqual(await readFile(w.paths.recorder, "utf8"), originalRecorder);
  await assert.rejects(rollbackUpdate({ home: w.home }), (error) => error.code === "no_backup");
  await assert.rejects(rollbackUpdate({ home: w.home, id: applied.id }), (error) => error.code === "already_rolled_back");
  await assert.rejects(rollbackUpdate({ home: w.home, id: "20200101-000000-000" }), (error) => error.code === "no_backup");
});

test("rollback puts a hand-formatted MCP config back byte for byte, and only its own entry when the file changed since", async (t) => {
  const prepare = async () => {
    const w = await world(t);
    const { env, ...entry } = (await mcpConfig(w)).mcpServers["agent-vault"]; // an entry from before AGENT_VAULT_HARNESS was registered
    const handmade = `{"mcpServers":{"other":{"command":"x"},"agent-vault":${JSON.stringify(entry)}}}`; // compact, no trailing newline
    await writeFile(w.paths.mcp, handmade);
    await w.update({ from: await w.bundle("1.0.0") });
    assert.notEqual(await readFile(w.paths.mcp, "utf8"), handmade, "the update re-serializes the file");
    return { w, entry, handmade };
  };
  const untouched = await prepare();
  await rollbackUpdate({ home: untouched.w.home });
  assert.equal(await readFile(untouched.w.paths.mcp, "utf8"), untouched.handmade);

  const edited = await prepare();
  const config = await mcpConfig(edited.w);
  config.mcpServers.later = { command: "y" };
  await writeFile(edited.w.paths.mcp, JSON.stringify(config));
  const result = await rollbackUpdate({ home: edited.w.home });
  assert.deepEqual(result.skipped, []);
  const after = await mcpConfig(edited.w);
  assert.deepEqual(after.mcpServers["agent-vault"], edited.entry, "this tool's entry is back as it was");
  assert.deepEqual(after.mcpServers.later, { command: "y" }, "what another tool added is kept");
  assert.deepEqual(after.mcpServers.other, { command: "x" });
});

test("an OMP folder Agent Vault did not install and an unrelated MCP config are left alone", async (t) => {
  const w = await world(t, { installed: null });
  await installAgents({ sourceDir: await w.bundle("0.9.0"), home: w.home, cwd: w.cwd, scope: "global", method: "copy", targets: ["universal"] });
  await mkdir(w.paths.omp, { recursive: true });
  await writeFile(path.join(w.paths.omp, "README"), "not ours\n");
  await mkdir(path.dirname(w.paths.mcp), { recursive: true });
  await writeFile(w.paths.mcp, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  const result = await w.update({ from: await w.bundle("1.0.0") });
  assert.deepEqual(result.applied.updated.map((item) => item.id), ["universal"]);
  assert.equal(result.plan.integrations.length, 0, "no OMP bundle was updated, so OMP files are left alone");
  assert.deepEqual(await mcpConfig(w), { mcpServers: { other: { command: "x" } } });
  assert.equal(await readFile(path.join(w.paths.omp, "README"), "utf8"), "not ours\n");
  assert.match(result.plan.targets.find((item) => item.id === "omp").reason, /did not install/);
});

test("only the newest backups are kept", async (t) => {
  const w = await world(t);
  const ids = [];
  for (let i = 0; i < UPDATE_BACKUPS_KEPT + 2; i++) {
    const result = await w.update({ from: await w.bundle(`1.0.${i}`), now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
    ids.push(result.applied.id);
  }
  const kept = (await listUpdateBackups(w.home)).map((item) => item.id);
  assert.deepEqual(kept, ids.slice(-UPDATE_BACKUPS_KEPT).reverse(), "newest first, older ones removed");
  assert.deepEqual((await readdir(path.join(w.home, ".agent-vault/update-backups"))).sort(), [...kept].sort());
});

test("without an owned bundle there is nothing to update, and the running bundle is not its own source", async (t) => {
  const none = await world(t, { installed: null });
  await assert.rejects(none.update({ from: await none.bundle("1.0.0") }), (error) => error.code === "nothing_to_update" && /vault-cli install/.test(error.message));

  const only = await world(t, { installed: "0.9.0", targets: ["universal"] });
  await assert.rejects(only.update({ from: only.paths.universal }), (error) => error.code === "nothing_to_update" && /newer checkout/.test(error.message));
});

test("sources are validated before anything is written", async (t) => {
  const w = await world(t);
  const before = await snapshot(w.home);
  await assert.rejects(w.update({ from: path.join(w.root, "missing") }), (error) => error.code === "invalid_source");
  const incomplete = await w.bundle("1.0.0");
  await rm(path.join(incomplete, "bin/vault-mcp.mjs"));
  await assert.rejects(w.update({ from: incomplete }), (error) => error.code === "invalid_source" && /vault-mcp\.mjs/.test(error.message));
  const foreign = path.join(w.root, "foreign");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "package.json"), JSON.stringify({ name: "something-else", version: "1.0.0" }));
  await assert.rejects(w.update({ from: foreign }), (error) => error.code === "invalid_source" && /agent-vault-skill/.test(error.message));
  await assert.rejects(w.update({ from: incomplete, archive: "x.tgz" }), (error) => error.code === "conflicting_source");
  assert.deepEqual(await snapshot(w.home), before);
  assert.equal(existsSync(path.join(w.home, ".agent-vault")), false);
});

async function tarball(w, name, build = async () => {}) {
  const top = path.join(w.root, "tar", name);
  const dir = await w.bundle("1.0.0");
  await mkdir(path.dirname(top), { recursive: true });
  await exec("cp", ["-R", dir, top]);
  await build(top);
  const file = path.join(w.root, `${name}.tgz`);
  await exec("tar", ["-czf", file, "-C", path.dirname(top), name]);
  return file;
}

async function serve(t, routes) {
  const server = http.createServer((request, response) => (routes[request.url] ?? ((_, res) => { res.writeHead(404); res.end(); }))(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("an archive from a file or a loopback URL is unpacked and checked; bad archives and URLs are refused", async (t) => {
  const w = await world(t);
  const file = await tarball(w, "agent-vault-1.0.0");
  const bytes = await readFile(file);
  const fromFile = await w.update({ archive: file, dryRun: true });
  assert.equal(fromFile.plan.source.version, "1.0.0");
  assert.match(fromFile.plan.source.origin, /^archive .*agent-vault-1\.0\.0\.tgz$/);

  const base = await serve(t, {
    "/ok.tgz": (_, res) => { res.writeHead(200); res.end(bytes); },
    "/big.tgz": (_, res) => { res.writeHead(200, { "content-length": String(70 * 1024 * 1024) }); res.flushHeaders(); setTimeout(() => res.destroy(), 50); },
    "/garbage.tgz": (_, res) => { res.writeHead(200); res.end("not a tarball"); },
  });
  const fromUrl = await w.update({ archive: `${base}/ok.tgz`, dryRun: true });
  assert.equal(fromUrl.plan.source.version, "1.0.0");
  await assert.rejects(w.update({ archive: `${base}/missing.tgz`, dryRun: true }), (error) => error.code === "download_failed" && /404/.test(error.message));
  await assert.rejects(w.update({ archive: `${base}/big.tgz`, dryRun: true }), (error) => error.code === "archive_too_large");
  await assert.rejects(w.update({ archive: `${base}/garbage.tgz`, dryRun: true }), (error) => error.code === "invalid_archive");
  await assert.rejects(w.update({ archive: "http://example.com/a.tgz", dryRun: true }), (error) => error.code === "invalid_archive_url");
  await assert.rejects(w.update({ archive: "ftp://127.0.0.1/a.tgz", dryRun: true }), (error) => error.code === "invalid_archive_url");
  await assert.rejects(w.update({ archive: path.join(w.root, "no-such.tgz"), dryRun: true }), (error) => error.code === "invalid_source");
  assert.deepEqual((await readdir(tmpdir())).filter((name) => name.startsWith("agent-vault-update-") && !name.includes("test")), [], "downloads are removed even when they fail");
});

test("an archive that carries a link inside the bundle is refused", async (t) => {
  const w = await world(t);
  const file = await tarball(w, "agent-vault-evil", async (top) => { await symlink("/etc/passwd", path.join(top, "lib", "passwd")); });
  await assert.rejects(w.update({ archive: file, dryRun: true }), /Unsupported bundled skill entry/);
});

test("the GitHub download tries the token first and falls back to the public archive", async (t) => {
  const w = await world(t);
  const bytes = await readFile(await tarball(w, "agent-vault-gh"));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.Authorization });
    return calls.length === 1 ? new Response("denied", { status: 401 }) : new Response(bytes, { status: 200 });
  };
  const result = await w.update({ ref: "v9.9.9", env: { GH_TOKEN: "t0ken" }, fetchImpl, dryRun: true });
  assert.deepEqual(calls, [
    { url: "https://api.github.com/repos/jung-geun/agent-vault/tarball/v9.9.9", authorization: "Bearer t0ken" },
    { url: "https://github.com/jung-geun/agent-vault/archive/v9.9.9.tar.gz", authorization: undefined },
  ]);
  assert.match(result.plan.source.origin, /^GitHub jung-geun\/agent-vault@v9\.9\.9$/);

  const refused = async () => new Response("no", { status: 404 });
  await assert.rejects(w.update({ ref: "nope", env: { GH_TOKEN: "t0ken" }, fetchImpl: refused, dryRun: true }), (error) => error.code === "download_failed" && /GH_TOKEN/.test(error.message) && /pass --from/.test(error.message));
});

test("the verification server runs in a scratch home and vault and never sees the real environment", async (t) => {
  const w = await world(t, { installed: null });
  const probe = path.join(w.root, "probe.json");
  const saved = { PROBE_FILE: process.env.PROBE_FILE, AGENT_VAULT_DB_DRIVER: process.env.AGENT_VAULT_DB_DRIVER, OMP_VAULT_PATH: process.env.OMP_VAULT_PATH };
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  Object.assign(process.env, { PROBE_FILE: probe, AGENT_VAULT_DB_DRIVER: "postgres", OMP_VAULT_PATH: "/real/vault" });

  assert.deepEqual(await smokeTest(await w.bundle("1.0.0"), "1.0.0"), { version: "1.0.0", tools: 1 });

  const seen = JSON.parse(await readFile(probe, "utf8"));
  assert.ok(seen.home.startsWith(tmpdir()) && seen.home !== process.env.HOME, "HOME is a scratch directory");
  assert.equal(seen.db, null, "the database driver of the real environment is not inherited");
  assert.equal(seen.vaultEnv, null);
  assert.equal(seen.harness, "omp");
  assert.equal(seen.args[0], "--path");
  assert.ok(seen.args[1].startsWith(tmpdir()) && seen.args[1] !== "/real/vault");
  assert.equal(existsSync(seen.args[1]), false, "the scratch vault is removed afterwards");
});

test("updating from this repository installs a bundle whose real server boots", async (t) => {
  const w = await world(t);
  const manifest = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const result = await w.update({ from: ROOT });
  assert.equal(result.applied.verified.version, manifest.version);
  assert.ok(result.applied.verified.tools > 20, `the installed server lists its tools (${result.applied.verified.tools})`);
  for (const rel of manifest.files.filter((file) => /^(bin|lib|integrations)\//.test(file))) {
    assert.ok(await lstat(path.join(w.paths.omp, rel)).catch(() => null), `${rel} is part of the installed bundle`);
  }
  assert.doesNotMatch(await readFile(w.paths.recorder, "utf8"), /memory-store\.mjs/, "the recorder no longer writes journals through the old store");
  assert.equal(JSON.parse(await readFile(path.join(w.paths.universal, "package.json"), "utf8")).version, manifest.version);
});

test("diagnose says when the installed bundle is older than the running build", async (t) => {
  const older = await world(t, { installed: "0.9.0" });
  const vault = path.join(older.root, "vault");
  await initVault(vault);
  const find = async (home) => (await diagnoseMemory(vault, {}, { home })).checks.find((check) => check.name === "install");
  const report = await find(older.home);
  assert.equal(report.status, "info");
  assert.match(report.detail, /omp 0\.9\.0/);
  assert.match(report.fix, /vault-cli update --dry-run/);

  const newer = await world(t, { installed: "99.0.0" });
  assert.equal(await find(newer.home), undefined, "an install newer than this build is not reported");
  const none = await world(t, { installed: null });
  assert.equal(await find(none.home), undefined, "nothing installed, nothing to report");
});

test("the update command prints a plan, applies with verification, lists backups, rolls back, and rejects misuse", async (t) => {
  const w = await world(t);
  const vault = path.join(w.root, "vault");
  await initVault(vault);
  await mkdir(path.join(vault, "projects/demo/worktrees/main"), { recursive: true });
  await writeFile(path.join(vault, "projects/demo/worktrees/main/2026-01-01-instruction-a.md"), "journal\n");
  const source = await w.bundle("1.0.0");
  const run = (...args) => exec(process.execPath, [cli, "update", ...args], { env: { ...process.env, HOME: w.home }, cwd: w.cwd })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));

  const dry = await run("--from", source, "--dry-run", "--path", vault);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /0\.9\.0 -> 1\.0\.0/);
  assert.match(dry.stdout, /Dry run: nothing was changed/);
  assert.equal(await w.version(w.paths.omp), "0.9.0");

  const real = await run("--from", source, "--path", vault);
  assert.equal(real.code, 0, real.stderr);
  assert.match(real.stdout, /Updated\. Backup \d{8}-\d{6}-\d{3}-[0-9a-f]{6}; undo with: vault-cli update --rollback/);
  assert.match(real.stdout, /Verified: the installed server answered as version 1\.0\.0 with 1 tools/);
  assert.match(real.stdout, /Restart OMP/);
  assert.match(real.stdout, /1 journal notes are Markdown files in the vault/);
  assert.equal(await w.version(w.paths.omp), "1.0.0");

  const listed = JSON.parse((await run("--backups", "--json")).stdout);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].to, "1.0.0");
  assert.match((await run("--backups")).stdout, /omp 0\.9\.0/);

  const back = await run("--rollback", "latest");
  assert.equal(back.code, 0, back.stderr);
  assert.match(back.stdout, /Rolled back update/);
  assert.equal(await w.version(w.paths.omp), "0.9.0");
  assert.match((await run("--backups")).stdout, /\(rolled back\)/);

  for (const [args, pattern] of [
    [["--rollback", "latest", "--from", source], /cannot be combined with --from/],
    [["--backups", "--dry-run"], /cannot be combined with --dry-run/],
    [["--backups", "--rollback", "latest"], /not both/],
    [["--ref", "v1", "--from", source], /--ref only applies/],
    [["--rollback", "nope"], /No update backup 'nope'/],
    [["--bogus"], /Unknown option: --bogus/],
    [["--archive"], /requires a value/],
    [["--from", path.join(w.root, "missing")], /does not exist/],
  ]) {
    const result = await run(...args);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, pattern, args.join(" "));
  }
  assert.equal(await w.version(w.paths.omp), "0.9.0", "misuse changes nothing");
});

// Instruction files that agents read at session start, written the way the pre-rename setup left them.
async function staleInstructions(w) {
  await mkdir(path.join(w.home, ".omp/agent"), { recursive: true });
  await writeFile(path.join(w.home, ".omp/agent/AGENTS.md"), "# Mine\n\nAt start call `vault_context`, then `memory_search`.\nStore with `short_memory_write` and `long_memory_write`.\nHost name mcp__agent_vault_vault_context is a different identifier.\nAlready new: `context`, `doc_search`.\n");
  await writeFile(path.join(w.home, ".omp/agent/RULES.md"), "No tool names here.\n");
  await writeFile(path.join(w.cwd, "AGENTS.md"), "Hand off with `agent_handoff`.\n");
}

test("instruction files that still name retired tools are found with line numbers and replacements, and never edited", async (t) => {
  const w = await world(t);
  await staleInstructions(w);
  const source = await w.bundle("1.0.0");
  const newServer = `${await readFile(path.join(source, "bin/vault-mcp.mjs"), "utf8")}\n// name: "context"\n`;
  await writeFile(path.join(source, "bin/vault-mcp.mjs"), newServer);
  const files = ["/.omp/agent/AGENTS.md", "/.omp/agent/RULES.md"].map((rel) => path.join(w.home, rel));
  const before = await Promise.all([...files, path.join(w.cwd, "AGENTS.md")].map((file) => readFile(file, "utf8")));

  const found = await findRetiredToolReferences({ sourceDir: source, home: w.home, cwd: w.cwd });
  assert.deepEqual(found.map((item) => [path.basename(path.dirname(item.path)) === "agent" ? "home" : "cwd", item.count]), [["home", 4], ["cwd", 1]]);
  assert.deepEqual(found[0].hits, [
    { line: 3, name: "vault_context", use: "context" }, { line: 3, name: "memory_search", use: "doc_search" },
    { line: 4, name: "short_memory_write", use: "short_write" }, { line: 4, name: "long_memory_write", use: "remember" },
  ], "a prefixed host identifier and already-renamed tools are not reported");
  assert.deepEqual(found[1].hits, [{ line: 1, name: "agent_handoff", use: "handoff" }]);

  const dry = await w.update({ from: source, dryRun: true });
  assert.deepEqual(dry.plan.instructions.map((item) => item.count), [4, 1]);
  const text = renderUpdate(dry, { dryRun: true });
  assert.match(text, /\[WARN\] These instruction files still tell agents to call tools that this build no longer has/);
  assert.match(text, /line 3: vault_context -> context/);
  assert.match(text, /run vault-cli init inside it/);
  const applied = await w.update({ from: source });
  assert.equal(applied.plan.instructions.length, 2, "the real update warns too");
  assert.deepEqual(await Promise.all([...files, path.join(w.cwd, "AGENTS.md")].map((file) => readFile(file, "utf8"))), before, "the user's files are not edited");
});

test("a tool the new build still provides is not reported, and a clean setup prints no warning", async (t) => {
  const w = await world(t);
  await staleInstructions(w);
  const source = await w.bundle("1.0.0");
  const server = await readFile(path.join(source, "bin/vault-mcp.mjs"), "utf8");
  await writeFile(path.join(source, "bin/vault-mcp.mjs"), `${server}\n// name: "vault_context", name: "memory_search", name: "short_memory_write", name: "long_memory_write", name: "agent_handoff"\n`);
  assert.deepEqual(await findRetiredToolReferences({ sourceDir: source, home: w.home, cwd: w.cwd }), []);

  const clean = await world(t);
  const plan = await clean.update({ from: await clean.bundle("1.0.0"), dryRun: true });
  assert.deepEqual(plan.plan.instructions, []);
  assert.doesNotMatch(renderUpdate(plan, { dryRun: true }), /\[WARN\]/);
});

test("an installed rule that the user edited is reported, one that the update replaces is not", async (t) => {
  const w = await world(t);
  const rule = path.join(w.home, ".agents/rules/agent-vault.md");
  await writeFile(rule, "My own copy: call `vault_context` first.\n");
  const result = await w.update({ from: await w.bundle("1.0.0"), dryRun: true });
  assert.deepEqual(result.plan.integrations.find((item) => item.label === "OMP user rule").status, "preserved existing file with different content");
  assert.deepEqual(result.plan.instructions.map((item) => item.path), [rule], "left alone by the update, so it still names a retired tool");
});

test("diagnose lists instruction files that name retired tools", async (t) => {
  const w = await world(t, { installed: null });
  const vault = path.join(w.root, "vault");
  await initVault(vault);
  const find = async () => (await diagnoseMemory(vault, {}, { home: w.home })).checks.find((check) => check.name === "instructions");
  assert.equal(await find(), undefined, "nothing to report on a clean home");
  await staleInstructions(w);
  const check = await find();
  assert.equal(check.status, "info");
  assert.match(check.detail, /AGENTS\.md \(4\)/);
  assert.match(check.detail, /vault_context -> context/);
  assert.match(check.fix, /vault-cli init/);
});

test("the update command prints the warning and includes it in JSON", async (t) => {
  const w = await world(t);
  await staleInstructions(w);
  const source = await w.bundle("1.0.0");
  const run = (...args) => exec(process.execPath, [cli, "update", ...args], { env: { ...process.env, HOME: w.home }, cwd: w.cwd });
  const text = (await run("--from", source, "--dry-run")).stdout;
  assert.match(text, /\[WARN\].*retired|\[WARN\] These instruction files/);
  assert.match(text, /vault_context -> context/);
  const json = JSON.parse((await run("--from", source, "--dry-run", "--json")).stdout);
  assert.deepEqual(json.plan.instructions.map((item) => item.count), [4, 1]);
});

test("the retired-name table matches the Obsidian plugin's and the real server", async () => {
  const plugin = await readFile(path.join(ROOT, "integrations/obsidian/agent-vault-wiki/data.cjs"), "utf8");
  const table = Object.fromEntries([...plugin.match(/const LEGACY_TOOL_NAMES = \{([\s\S]*?)\};/)[1].matchAll(/(\w+): "(\w+)"/g)].map((match) => [match[1], match[2]]));
  for (const [old, current] of Object.entries(table)) assert.equal(RETIRED_TOOL_NAMES[old], current, `${old} maps the same way in the plugin`);
  const server = await readFile(path.join(ROOT, "bin/vault-mcp.mjs"), "utf8");
  for (const [old, current] of Object.entries(RETIRED_TOOL_NAMES)) {
    assert.equal(server.includes(`name: "${old}"`), false, `${old} is really gone from the server`);
    assert.equal(server.includes(`name: "${current}"`), true, `${current} exists in the server`);
  }
});

test("a pre-rename rule that the update replaces is not reported, because it will no longer name retired tools", async (t) => {
  const w = await world(t);
  const rule = path.join(w.home, ".agents/rules/agent-vault.md");
  await writeFile(rule, await readFile(path.join(ROOT, "test/fixtures/agent-vault.rule.pre-tool-rename.md")));
  const before = await readFile(rule, "utf8");
  assert.match(before, /vault_context/);
  const result = await w.update({ from: await w.bundle("1.0.0"), dryRun: true });
  assert.equal(result.plan.integrations.find((item) => item.label === "OMP user rule").status, "updated from legacy version");
  assert.deepEqual(result.plan.instructions, [], "the stale rule is not listed: the update rewrites it");
  await w.update({ from: await w.bundle("1.0.0") });
  assert.doesNotMatch(await readFile(rule, "utf8"), /vault_context/);
});
