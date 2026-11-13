import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const installerPath = fileURLToPath(new URL("../install.sh", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-installer-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archiveRoot = path.join(root, "archive-root");
  const packageRoot = path.join(archiveRoot, "agent-vault-main");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "bin", "vault-cli.mjs"),
    'import fs from "node:fs"; fs.writeFileSync(process.env.AGENT_VAULT_INSTALL_TEST_RESULT, JSON.stringify(process.argv.slice(2)));\n',
  );
  const archive = path.join(root, "fixture.tar.gz");
  await execFileAsync("tar", ["-czf", archive, "-C", archiveRoot, "agent-vault-main"]);
  return { root, archive };
}

function installerEnv(archive, resultPath) {
  return {
    ...process.env,
    AGENT_VAULT_ARCHIVE_URL: `file://${archive}`,
    AGENT_VAULT_INSTALL_TEST_RESULT: resultPath,
  };
}

test("installer downloads an archive and runs the existing global install flow", async (t) => {
  const { root, archive } = await fixture(t);
  const resultPath = path.join(root, "result.json");
  await execFileAsync("/bin/bash", [installerPath], {
    env: installerEnv(archive, resultPath),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), ["install", "--global"]);
});

test("installer forwards local scope to the existing CLI", async (t) => {
  const { root, archive } = await fixture(t);
  const resultPath = path.join(root, "result.json");
  await execFileAsync("/bin/bash", [installerPath, "--local"], {
    env: installerEnv(archive, resultPath),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), ["install", "--local"]);
});

test("installer rejects invalid archives before running the CLI", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-installer-invalid-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = path.join(root, "invalid.tar.gz");
  const resultPath = path.join(root, "result.json");
  await writeFile(archive, "not a tar archive");

  await assert.rejects(
    execFileAsync("/bin/bash", [installerPath], {
      env: installerEnv(archive, resultPath),
      encoding: "utf8",
    }),
    (error) => error.code !== 0 && /Downloaded archive is invalid/.test(error.stderr),
  );
  await assert.rejects(readFile(resultPath), { code: "ENOENT" });
});
