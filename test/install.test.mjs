import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

async function mockCurlEnv(root, archive, resultPath, token) {
  const commandDir = path.join(root, "commands");
  const argsPath = path.join(root, "curl-args.txt");
  const configPath = path.join(root, "curl-config.txt");
  await mkdir(commandDir);
  for (const command of ["node", "tar", "gzip", "mkdir", "mktemp", "rm", "chmod", "cat", "cp"]) {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
    await symlink(stdout.trim(), path.join(commandDir, command));
  }
  const curlPath = path.join(commandDir, "curl");
  await writeFile(curlPath, `#!/bin/sh
: > "$INSTALL_TEST_CURL_ARGS"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      cat "$2" > "$INSTALL_TEST_CURL_CONFIG"
      shift 2
      ;;
    --output)
      cp "$INSTALL_TEST_ARCHIVE" "$2"
      shift 2
      ;;
    *)
      printf '%s\\n' "$1" >> "$INSTALL_TEST_CURL_ARGS"
      shift
      ;;
  esac
done
`);
  await chmod(curlPath, 0o755);
  const env = {
    ...process.env,
    PATH: commandDir,
    INSTALL_TEST_ARCHIVE: archive,
    AGENT_VAULT_INSTALL_TEST_RESULT: resultPath,
    INSTALL_TEST_CURL_ARGS: argsPath,
    INSTALL_TEST_CURL_CONFIG: configPath,
  };
  delete env.AGENT_VAULT_ARCHIVE_URL;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  if (token) env.GH_TOKEN = token;
  return { env, argsPath, configPath };
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

test("installer uses GH_TOKEN with GitHub API tarballs when GitHub CLI is unavailable", async (t) => {
  const { root, archive } = await fixture(t);
  const resultPath = path.join(root, "result.json");
  const { env, argsPath, configPath } = await mockCurlEnv(root, archive, resultPath, "test-token");
  await execFileAsync("/bin/bash", [installerPath], { env, encoding: "utf8" });

  assert.match(await readFile(argsPath, "utf8"), /https:\/\/api\.github\.com\/repos\/jung-geun\/agent-vault\/tarball\/main/);
  assert.match(await readFile(configPath, "utf8"), /Authorization: Bearer test-token/);
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), ["install", "--global"]);
});

test("installer fetches public archives without gh or tokens and reaches the install CLI", async (t) => {
  const { root, archive } = await fixture(t);
  const resultPath = path.join(root, "result.json");
  const { env, argsPath, configPath } = await mockCurlEnv(root, archive, resultPath);
  await execFileAsync("/bin/bash", [installerPath], { env, encoding: "utf8" });

  assert.match(await readFile(argsPath, "utf8"), /https:\/\/github\.com\/jung-geun\/agent-vault\/archive\/main\.tar\.gz/);
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), ["install", "--global"]);
  await assert.rejects(readFile(configPath), { code: "ENOENT" });
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
