import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";

const PACKAGE_ENTRIES = ["SKILL.md", "package.json", "bin", "lib", "integrations"];
const LEGACY_RULE_SHA256 = new Set([
  "99420e12daa5a61c72ae963495ce3f9084f680489020a64f51f78b6b70f23e19",
  "2e1eb64d07bddc2434a2e2da6a6117907cb71fc09444bf485ba2a0261d4e80d4",
  "6a30f4ebde027f1cf6d6d0e64d7a5103b4bc4af7519cd2e5982b6a6a1602478b",
  "8872023aa3a9f463aa9b671ec3fbefafb930cecd9c364d7df224a6aecc64ae7a",
  "4b908f1cd584938a5465e17d766088e8da07622f5227fafa4ced54972c23c352",
  "4cbc6c77b39e44de3f435b97a902d9be2bc27f7f24cb7ae48eed87e180e6bc9b",
]);
export const RECORDER_MARKER = "// agent-vault-recorder: managed by agent-vault install.";

async function entryStat(target) {
  try { return await lstat(target); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Trust the supplied home, working directory and OS temporary root, but not their child symlinks.
async function unsafeParent(target) {
  const trustedRoots = new Set([os.homedir(), os.tmpdir(), process.cwd()].map((root) => path.resolve(root)));
  for (let parent = path.dirname(path.resolve(target)); ; parent = path.dirname(parent)) {
    if (trustedRoots.has(parent)) return null;
    const info = await entryStat(parent);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) return parent;
    if (parent === path.dirname(parent)) return null;
  }
}

export async function writeAtomic(targetPath, data, mode = 0o644) {
  const temp = `${targetPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, data, { mode, flag: "wx" });
  await rename(temp, targetPath);
}

export async function installManagedFile(sourcePath, targetPath, marker, { dryRun = false } = {}) {
  const source = await readFile(sourcePath);
  const unsafe = await unsafeParent(targetPath);
  if (unsafe) return `preserved unsafe parent: ${unsafe}`;
  const info = await entryStat(targetPath);
  if (info && !info.isFile()) return "preserved non-regular destination";
  const existing = info ? await readFile(targetPath) : undefined;
  if (existing?.equals(source)) return "already current";
  if (existing && !existing.toString("utf8").startsWith(marker)) return "preserved existing file with different content";
  if (!dryRun) {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeAtomic(targetPath, source);
  }
  return existing ? "updated" : "installed";
}

export async function installRule(sourcePath, targetPath, { dryRun = false } = {}) {
  const source = await readFile(sourcePath);
  const unsafe = await unsafeParent(targetPath);
  if (unsafe) return `preserved unsafe parent: ${unsafe}`;
  const info = await entryStat(targetPath);
  if (info && !info.isFile()) return "preserved non-regular destination";
  const existing = info ? await readFile(targetPath) : undefined;
  if (existing?.equals(source)) return "already current";
  if (existing && !LEGACY_RULE_SHA256.has(createHash("sha256").update(existing).digest("hex"))) {
    return "preserved existing file with different content";
  }
  if (!dryRun) {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeAtomic(targetPath, source);
  }
  return existing ? "updated from legacy version" : "installed";
}

export async function registerMcpServer(configPath, entry, { dryRun = false } = {}) {
  const unsafe = await unsafeParent(configPath);
  if (unsafe) return `preserved unsafe parent: ${unsafe}`;
  const info = await entryStat(configPath);
  if (info && !info.isFile()) return "preserved non-regular destination";
  let config = { mcpServers: {} };
  if (info) {
    try { config = JSON.parse(await readFile(configPath, "utf8")); }
    catch (error) { throw new Error(`${configPath} is not valid JSON (${error.message}); fix it before installing the MCP server.`); }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)
    || (config.mcpServers != null && (typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)))) {
    return "preserved config with unsupported structure";
  }
  config.mcpServers ??= {};
  const current = config.mcpServers["agent-vault"];
  const desired = { ...entry, env: { ...current?.env, ...entry.env } };
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(desired)) return "already current";
  const owned = Array.isArray(current?.args) && String(current.args[0]).replaceAll("\\", "/").endsWith("skills/agent-vault/bin/vault-mcp.mjs");
  if (current !== undefined && !owned) return "preserved existing entry that differs";
  config.mcpServers["agent-vault"] = desired;
  if (!dryRun) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`, info ? info.mode & 0o777 : 0o600);
  }
  return current === undefined ? "registered" : "updated";
}

export async function getInstallTargets({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const definitions = [
    ["universal", "Universal", "Codex and agents using .agents/skills", ".agents/skills", ".agents/skills"],
    ["omp", "OMP", "Skill; global install also configures MCP, rule and recorder", ".omp/agent/skills", ".omp/skills"],
    ["claude", "Claude Code", "Skill files; configure MCP manually", ".claude/skills", ".claude/skills"],
    ["cursor", "Cursor", "Skill files; configure MCP manually", ".cursor/skills", ".cursor/skills"],
  ];
  return Promise.all(definitions.map(async ([id, label, description, globalDir, localDir]) => ({
    id, label, description,
    globalPath: path.resolve(home, globalDir, "agent-vault"),
    localPath: path.resolve(cwd, localDir, "agent-vault"),
    detected: Boolean(await entryStat(path.resolve(home, globalDir.split("/")[0])))
      || Boolean(await entryStat(path.resolve(cwd, localDir.split("/")[0]))),
    required: id === "universal",
  })));
}

async function packageFiles(sourceDir) {
  const files = [];
  async function visit(relative) {
    const source = path.join(sourceDir, relative);
    const info = await lstat(source);
    if (info.isDirectory()) {
      files.push({ relative, directory: true });
      for (const child of await readdir(source)) await visit(path.join(relative, child));
    } else if (info.isFile()) files.push({ relative, mode: info.mode & 0o777 });
    else throw new Error(`Unsupported bundled skill entry: ${source}`);
  }
  for (const entry of PACKAGE_ENTRIES) await visit(entry);
  return files;
}

async function ownedSkillDirectory(targetDir) {
  const manifestPath = path.join(targetDir, "package.json");
  const skillPath = path.join(targetDir, "SKILL.md");
  if (!(await entryStat(manifestPath))?.isFile() || !(await entryStat(skillPath))?.isFile()) return false;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    return manifest.name === "agent-vault-skill" && /^name:\s*agent-vault\s*$/m.test(await readFile(skillPath, "utf8"));
  } catch { return false; }
}

export async function installSkillFiles(sourceDir, targetDir, { dryRun = false, replaceLink = false } = {}) {
  sourceDir = path.resolve(sourceDir);
  targetDir = path.resolve(targetDir);
  const unsafe = await unsafeParent(targetDir);
  if (unsafe) return `preserved unsafe parent: ${unsafe}`;
  const info = dryRun && replaceLink ? null : await entryStat(targetDir);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) return "preserved non-directory or symlink destination";
  if (info && await realpath(sourceDir) === await realpath(targetDir)) return "already current";
  if (info && !await ownedSkillDirectory(targetDir)) return "preserved unowned directory";
  const files = await packageFiles(sourceDir);
  // Preflight the entire destination before changing any bundled file.
  for (const file of dryRun && replaceLink ? [] : files) {
    const target = path.join(targetDir, file.relative);
    const existing = await entryStat(target);
    if (existing && (existing.isSymbolicLink() || (file.directory ? !existing.isDirectory() : !existing.isFile()))) {
      return `preserved conflicting bundled path: ${target}`;
    }
  }
  if (!dryRun) {
    await mkdir(targetDir, { recursive: true });
    for (const file of files) {
      const target = path.join(targetDir, file.relative);
      if (file.directory) await mkdir(target, { recursive: true });
      else await writeAtomic(target, await readFile(path.join(sourceDir, file.relative)), file.mode);
    }
  }
  return info ? "updated" : "installed";
}

async function installSkillLink(canonical, target, relative, { dryRun = false } = {}) {
  const unsafe = await unsafeParent(target);
  if (unsafe) return `preserved unsafe parent: ${unsafe}`;
  const info = await entryStat(target);
  if (info) {
    if (info.isSymbolicLink()) {
      const resolved = await realpath(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      const canonicalResolved = await realpath(canonical).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (resolved && resolved === canonicalResolved) return "already current";
      if (dryRun && !resolved && !canonicalResolved && path.resolve(path.dirname(target), await readlink(target)) === canonical) return "already current";
      return "preserved existing symlink";
    }
    return info.isDirectory() && await ownedSkillDirectory(target)
      ? "preserved existing directory or file; choose Copy to upgrade, or move it manually before switching to symlink"
      : "preserved existing directory or file; move it manually before switching to symlink";
  }
  if (!dryRun) {
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(relative ? path.relative(path.dirname(target), canonical) : canonical, target, "dir");
  }
  return "linked";
}

async function installSkillCopy(sourceDir, target, canonical, { dryRun = false, canonicalReady = false } = {}) {
  const info = await entryStat(target);
  if (!info?.isSymbolicLink()) return installSkillFiles(sourceDir, target, { dryRun });
  const unsafe = await unsafeParent(target);
  if (unsafe) return `preserved unsafe parent: ${unsafe}`;
  const canonicalInfo = await entryStat(canonical);
  if (dryRun && canonicalReady && !canonicalInfo && !await unsafeParent(canonical)
    && path.resolve(path.dirname(target), await readlink(target)) === canonical) {
    return installSkillFiles(sourceDir, target, { dryRun, replaceLink: true });
  }
  if (await unsafeParent(canonical) || !canonicalInfo?.isDirectory() || !await ownedSkillDirectory(canonical)) {
    return "preserved existing symlink";
  }
  const resolved = await realpath(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (resolved !== await realpath(canonical)) return "preserved existing symlink";
  // Validate the stable source before removing only this installer-owned link.
  await packageFiles(sourceDir);
  if (dryRun) return installSkillFiles(sourceDir, target, { dryRun, replaceLink: true });
  await unlink(target);
  return installSkillFiles(sourceDir, target);
}

/** Inspect the same ownership and conflict rules as installation, without writing files. */
export async function previewInstallAgents(options) {
  return runInstallation(options, true);
}

export async function recommendedInstallMethod({ home = os.homedir(), cwd = process.cwd(), scope = "global", targets = ["omp", "universal"] } = {}) {
  if (!targets.includes("omp")) return "symlink";
  const available = await getInstallTargets({ home, cwd });
  const target = available.find(({ id }) => id === "omp")[scope === "global" ? "globalPath" : "localPath"];
  if (await unsafeParent(target)) return "symlink";
  const info = await entryStat(target);
  return info?.isDirectory() && await ownedSkillDirectory(target) ? "copy" : "symlink";
}

export async function installAgents(options) {
  return runInstallation(options, false);
}

async function runInstallation({ sourceDir, home = os.homedir(), cwd = process.cwd(), scope = "global", method = "copy", targets = ["omp", "universal"] }, dryRun) {
  if (!["global", "local"].includes(scope)) throw new Error("Install scope must be global or local.");
  if (!["copy", "symlink"].includes(method)) throw new Error("Install method must be copy or symlink.");
  const available = await getInstallTargets({ home, cwd });
  const selected = new Set(targets);
  if (!selected.size) throw new Error("Select at least one agent target.");
  for (const id of selected) if (!available.some((target) => target.id === id)) throw new Error(`Unknown agent target: ${id}`);
  sourceDir = await realpath(sourceDir);
  if (method === "symlink") selected.add("universal");
  const pathKey = scope === "global" ? "globalPath" : "localPath";
  const canonical = available.find((target) => target.id === "universal")[pathKey];
  const results = [];
  for (const target of available.filter((target) => selected.has(target.id))) {
    let status;
    if (method === "symlink" && target.id !== "universal") {
      const canonicalResult = results.find((result) => result.id === "universal");
      status = canonicalResult.status.startsWith("preserved") ? "preserved: canonical bundle was not installed" : await installSkillLink(canonical, target[pathKey], scope === "local", { dryRun });
    } else if (method === "copy" && target.id !== "universal") {
      const canonicalResult = results.find((result) => result.id === "universal");
      const canonicalReady = Boolean(canonicalResult && !canonicalResult.status.startsWith("preserved"));
      status = await installSkillCopy(sourceDir, target[pathKey], canonical, { dryRun, canonicalReady });
    } else status = await installSkillFiles(sourceDir, target[pathKey], { dryRun });
    results.push({ id: target.id, path: target[pathKey], status });
  }
  const integrations = [];
  const omp = results.find((result) => result.id === "omp");
  if (scope === "global" && omp && !omp.status.startsWith("preserved")) {
    const bundled = (...segments) => path.join(dryRun ? sourceDir : omp.path, "integrations", "omp", ...segments);
    const rulePath = path.resolve(home, ".agents/rules/agent-vault.md");
    integrations.push({ label: "OMP user rule", path: rulePath, status: await installRule(bundled("agent-vault.rule.md"), rulePath, { dryRun }) });
    const configPath = path.resolve(home, ".omp/agent/mcp.json");
    integrations.push({ label: "MCP server agent-vault", path: configPath, status: await registerMcpServer(configPath, {
      type: "stdio", command: "node", args: [path.join(omp.path, "bin/vault-mcp.mjs")], env: { AGENT_VAULT_HARNESS: "omp" }, enabled: true,
    }, { dryRun }) });
    const recorderPath = path.resolve(home, ".omp/agent/extensions/agent-vault-recorder.ts");
    integrations.push({ label: "worktree recorder extension", path: recorderPath, status: await installManagedFile(bundled("agent-vault-recorder.ts"), recorderPath, RECORDER_MARKER, { dryRun }) });
  }
  const notes = results.filter((result) => !result.status.startsWith("preserved") && (result.id !== "omp" || scope !== "global"))
    .map((result) => `${result.id}: skill files only; configure the agent-vault MCP server manually with node ${path.join(result.path, "bin/vault-mcp.mjs")}.`);
  if (scope === "global" && omp?.status.startsWith("preserved")) {
    notes.push("OMP MCP, rule and recorder preserved because the OMP skill target was preserved.");
    if (omp.status.includes("choose Copy to upgrade")) notes.push("Choose Copy to upgrade an existing owned copy.");
  }
  return { scope, method, targets: results, integrations, notes };
}
