import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../bin/vault-cli.mjs", import.meta.url));

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
