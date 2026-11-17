import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const source = fileURLToPath(new URL("..", import.meta.url));

test("npm package excludes ignored private helpers and local state even inside runtime directories", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, "source");
  await mkdir(fixture);
  const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  for (const name of ["package.json", "README.md", ...manifest.files]) {
    const destination = path.join(fixture, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(source, name), destination, { recursive: true });
  }
  const privateFiles = [
    "AGENTS.md", ".env", ".npmrc", ".vaultrc", ".agent-vault/memory.db", ".vault/user/profile.md",
    "lib/facts-release-private.mjs", "lib/curate.mjs", "bin/build-project-index.mjs", "test/private-fixture.mjs",
  ];
  for (const name of privateFiles) {
    const target = path.join(fixture, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, name === ".npmrc" ? "audit=false\n" : "PRIVATE_PACKAGE_FIXTURE_DO_NOT_DISTRIBUTE\n");
  }
  await writeFile(path.join(fixture, ".gitignore"), privateFiles.join("\n") + "\n");
  const { stdout } = await exec("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", "--cache", path.join(root, "cache")], {
    cwd: fixture, env: { ...process.env, NPM_CONFIG_USERCONFIG: path.join(root, "empty-npmrc") }, maxBuffer: 1024 * 1024,
  });
  const [packed] = JSON.parse(stdout);
  const files = new Set(packed.files.map((file) => file.path));
  for (const name of privateFiles) assert.equal(files.has(name), false, `private file shipped: ${name}`);
  assert.ok(files.has("bin/vault-cli.mjs"));
  assert.ok(files.has("bin/vault-mcp.mjs"));
  assert.ok(files.has("lib/knowledge-review.mjs"));
  assert.ok(files.has("integrations/obsidian/agent-vault-wiki/main.js"));
});
