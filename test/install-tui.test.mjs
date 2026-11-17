import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { runInstallTui } from "../lib/install-tui.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getInstallTargets, installAgents, previewInstallAgents, RECORDER_MARKER } from "../lib/installer.mjs";

const ENTER = "\r";
const UP = "\u001b[A";
const DOWN = "\u001b[B";
const RIGHT = "\u001b[C";
const PAGE_DOWN = "\u001b[6~";
const END = "\u001b[F";
const CTRL_A = "\u0001";
const CTRL_C = "\u0003";
const BACKSPACE = "\u007f";

function fixture(t, options = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = options.raw ?? false;
  const rawCalls = [];
  input.setRawMode = (value) => {
    rawCalls.push(value);
    input.isRaw = value;
    return input;
  };
  const chunks = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  output.isTTY = true;
  output.columns = options.columns ?? 110;
  output.rows = options.rows ?? 40;
  const targets = [
    { id: "universal", label: "Universal", required: true, description: "All compatible agents", globalPath: "/home/operator/.agents/skills/agent-vault", localPath: "/work/project/.agents/skills/agent-vault" },
    { id: "omp", label: "OMP", detected: true, description: "Open Model Provider", globalPath: "/home/operator/.omp/agent/skills/agent-vault", localPath: "/work/project/.omp/skills/agent-vault" },
    { id: "claude", label: "Claude Code", description: "Claude terminal agent", globalPath: "/home/operator/.claude/skills/agent-vault", localPath: "/work/project/.claude/skills/agent-vault" },
    { id: "codex", label: "Codex", globalPath: "/home/operator/.codex/skills/agent-vault", localPath: "/work/project/.codex/skills/agent-vault" },
  ];
  const skill = { name: "agent-vault", version: "1.0.0", source: "/source/agent-vault" };
  const baseline = {
    input: Object.fromEntries(["data", "end", "close", "error", "keypress", "newListener"].map((name) => [name, input.listeners(name)])),
    output: Object.fromEntries(["resize", "error"].map((name) => [name, output.listeners(name)])),
  };
  const state = {
    input, output, rawCalls, chunks, targets, skill, baseline,
    start(overrides = {}) {
      const preview = ({ scope, method, targets: selected }) => ({
        targets: targets.filter(({ id }) => selected.includes(id)).map((target) => ({
          id: target.id, path: target[scope === "global" ? "globalPath" : "localPath"],
          status: method === "symlink" && target.id !== "universal" ? "linked" : "installed",
        })),
        integrations: scope === "global" && selected.includes("omp") ? [
          { label: "OMP user rule", path: "/home/operator/.agents/rules/agent-vault.md", status: "installed" },
          { label: "MCP server agent-vault", path: "/home/operator/.omp/agent/mcp.json", status: "registered" },
          { label: "worktree recorder extension", path: "/home/operator/.omp/agent/extensions/agent-vault-recorder.ts", status: "installed" },
        ] : [],
      });
      state.result = runInstallTui({ targets, skill, input, output, preview, ...overrides });
      return state.result;
    },
    key(value) { input.write(value); },
    async escape() { input.write("\u001b"); await delay(550); },
    frame() {
      return chunks.findLast((chunk) => chunk.startsWith("\u001b[H\u001b[2J"))?.slice(7) ?? "";
    },
    resize(columns, rows) {
      output.columns = columns;
      output.rows = rows;
      output.emit("resize");
    },
    assertRestored() {
      assert.equal(input.isRaw, options.raw ?? false);
      assert.equal(input.isPaused(), true);
      for (const [name, listeners] of Object.entries(baseline.input)) assert.deepEqual(input.listeners(name), listeners, `input ${name}`);
      for (const [name, listeners] of Object.entries(baseline.output)) assert.deepEqual(output.listeners(name), listeners, `output ${name}`);
      assert.equal(chunks.at(-1), "\u001b[?25h\u001b[?1049l");
    },
  };
  t.after(async () => {
    if (state.result) {
      input.emit("close");
      await state.result.catch(() => {});
    }
    input.destroy();
    output.destroy();
  });
  return state;
}

function review(ui) {
  ui.key(ENTER);
  ui.key(ENTER);
  ui.key(ENTER);
}

function accept(ui) {
  ui.key(RIGHT);
  ui.key(ENTER);
}

test("search preserves selection through navigation, filtering and back navigation", async (t) => {
  const ui = fixture(t);
  ui.start();
  ui.key("cla");
  assert.match(ui.frame(), /Search: cla/);
  assert.match(ui.frame(), /> \[ \] Claude Code/);
  ui.key(" ");
  ui.key(DOWN);
  assert.match(ui.frame(), /> \[x\] Claude Code/);
  ui.key(ENTER);
  await ui.escape();
  assert.match(ui.frame(), /Search: cla/);
  assert.match(ui.frame(), /\[x\] Claude Code/);
  ui.key(BACKSPACE.repeat(3));
  ui.key("codex");
  assert.match(ui.frame(), /Search: codex/);
  ui.key(" ");
  review(ui);
  accept(ui);
  assert.deepEqual(await ui.result, { scope: "global", method: "symlink", targets: ["universal", "omp", "claude", "codex"] });
  ui.assertRestored();
});

test("Ctrl+A toggles only visible selectable targets, never required Universal", async (t) => {
  const ui = fixture(t);
  ui.start({ defaultTargets: [] });
  ui.key(" ");
  ui.key(CTRL_A);
  ui.key(CTRL_A);
  assert.match(ui.frame(), /\[\*\] Universal \(required\)/);
  ui.key("codex");
  ui.key(CTRL_A);
  ui.key(BACKSPACE.repeat(5));
  review(ui);
  accept(ui);
  assert.deepEqual((await ui.result).targets, ["universal", "codex"]);
  ui.assertRestored();
});

test("empty search results retain required targets and cannot produce an empty choice", async (t) => {
  const ui = fixture(t);
  ui.start({ defaultTargets: [] });
  ui.key("no-such-agent");
  assert.match(ui.frame(), /No matching agents/);
  ui.key(CTRL_A);
  ui.key(" ");
  review(ui);
  accept(ui);
  assert.deepEqual((await ui.result).targets, ["universal"]);
});

test("scope and method survive back navigation and produce exact selected project paths", async (t) => {
  const ui = fixture(t);
  ui.start();
  ui.key(ENTER);
  ui.key(DOWN);
  ui.key(ENTER);
  ui.key(DOWN);
  ui.key(ENTER);
  assert.match(ui.frame(), /Scope: Project/);
  assert.match(ui.frame(), /Method: Copy/);
  assert.match(ui.frame(), /\/work\/project\/\.agents\/skills\/agent-vault/);
  assert.match(ui.frame(), /\/work\/project\/\.omp\/skills\/agent-vault/);
  assert.match(ui.frame(), /no global MCP, rule or recorder changes/);
  await ui.escape();
  assert.match(ui.frame(), /Selected: Copy/);
  await ui.escape();
  assert.match(ui.frame(), /Selected: Project/);
  ui.key(ENTER);
  ui.key(ENTER);
  accept(ui);
  assert.deepEqual(await ui.result, { scope: "local", method: "copy", targets: ["universal", "omp"] });
  ui.assertRestored();
});

test("summary shows canonical destination, symlink targets and only selected integrations", async (t) => {
  const ui = fixture(t);
  ui.start();
  review(ui);
  const frame = ui.frame();
  assert.match(frame, /Canonical skill \(copied\):\r\n\/home\/operator\/\.agents\/skills\/agent-vault/);
  assert.match(frame, /OMP \(symlink to canonical\)/);
  assert.match(frame, /OMP user rule: Will install/);
  assert.match(frame, /MCP server agent-vault: Will register/);
  assert.match(frame, /worktree recorder extension: Will install/);
  assert.doesNotMatch(frame, /\.claude\/skills/);
  ui.key(ENTER);
  assert.equal(await ui.result, null);
  ui.assertRestored();
});

test("Enter defaults to cancellation and revisiting summary resets Yes to No", async (t) => {
  const ui = fixture(t);
  ui.start();
  review(ui);
  ui.key(RIGHT);
  assert.match(ui.frame(), /> Yes/);
  await ui.escape();
  ui.key(ENTER);
  assert.match(ui.frame(), /> No/);
  ui.key(ENTER);
  assert.equal(await ui.result, null);
  ui.assertRestored();
});

test("Ctrl+C cancels and restores existing raw state without process listener changes", async (t) => {
  const ui = fixture(t, { raw: true });
  const processListeners = new Map(process.eventNames().map((name) => [name, process.listeners(name)]));
  ui.start();
  ui.key(CTRL_C);
  assert.equal(await ui.result, null);
  assert.deepEqual(ui.rawCalls, [true, true]);
  ui.assertRestored();
  for (const [name, listeners] of processListeners) assert.deepEqual(process.listeners(name), listeners);
});

test("Escape cancels from the first step", async (t) => {
  const ui = fixture(t);
  ui.start();
  await ui.escape();
  assert.equal(await ui.result, null);
  ui.assertRestored();
});

test("EOF and input close cancel without waiting for another key", async (t) => {
  for (const event of ["end", "close"]) {
    const ui = fixture(t);
    ui.start();
    if (event === "end") ui.input.end();
    else ui.input.emit("close");
    assert.equal(await ui.result, null);
    ui.assertRestored();
  }
});

test("output errors reject and restore input state", async (t) => {
  const ui = fixture(t);
  ui.start();
  const error = new Error("output disconnected");
  const rejection = assert.rejects(ui.result, error);
  ui.output.emit("error", error);
  await rejection;
  ui.assertRestored();
});

test("input errors reject and restore terminal state", async (t) => {
  const ui = fixture(t);
  ui.start();
  const error = new Error("input disconnected");
  const rejection = assert.rejects(ui.result, error);
  ui.input.emit("error", error);
  await rejection;
  ui.assertRestored();
});

test("render errors restore raw mode and cursor", async (t) => {
  const ui = fixture(t);
  const write = ui.output.write.bind(ui.output);
  let shouldFail = true;
  ui.output.write = (chunk) => {
    if (shouldFail && chunk.startsWith("\u001b[H")) {
      shouldFail = false;
      throw new Error("render failed");
    }
    return write(chunk);
  };
  await assert.rejects(ui.start(), /render failed/);
  ui.assertRestored();
});

test("resize clamps frames, preserves action hints and keeps focused targets visible", async (t) => {
  const ui = fixture(t);
  ui.start();
  ui.key(DOWN.repeat(3));
  ui.resize(30, 6);
  let lines = ui.frame().split("\r\n");
  assert.ok(lines.length <= 6);
  assert.ok(lines.every((line) => line.length <= 29));
  assert.match(ui.frame(), /> \[ \] Codex/);
  assert.match(lines.at(-1), /Enter.*\^C/);
  review(ui);
  assert.match(ui.frame(), /Proceed\? > No/);
  ui.resize(16, 4);
  lines = ui.frame().split("\r\n");
  assert.ok(lines.length <= 4);
  assert.ok(lines.every((line) => line.length <= 15));
  assert.match(lines.at(-1), /Enter.*\^C/);
  ui.resize(110, 40);
  assert.match(ui.frame(), /Canonical skill/);
  accept(ui);
  assert.notEqual(await ui.result, null);
  ui.assertRestored();
});

test("80x24 multi-target review keeps complete hints and visible overflow status", async (t) => {
  const ui = fixture(t, { columns: 80, rows: 24 });
  ui.start();
  ui.key(CTRL_A);
  review(ui);
  let lines = ui.frame().split("\r\n");
  assert.equal(lines.length, 24);
  assert.ok(lines.every((line) => line.length <= 79));
  assert.match(lines.at(-1), /Enter.*Up\/Down scroll.*Esc \^C$/);
  assert.match(lines.at(-2), /> No.*1-18\/\d+ more below$/);
  ui.key(END);
  lines = ui.frame().split("\r\n");
  assert.match(lines.at(-2), /more above$/);
  assert.match(ui.frame(), /Integrations:/);
  assert.match(ui.frame(), /OMP user rule: Will install/);
  ui.key(ENTER);
  assert.equal(await ui.result, null);
  ui.assertRestored();
});

test("long exact paths wrap and summary scroll reaches integration effects", async (t) => {
  const ui = fixture(t, { columns: 42, rows: 10 });
  const fullPath = `/home/operator/${"long-directory/".repeat(8)}agent-vault`;
  ui.targets[0].globalPath = fullPath;
  ui.start();
  review(ui);
  const observed = [];
  for (let index = 0; index < 70; index += 1) {
    const lines = ui.frame().split("\r\n");
    assert.ok(lines.every((line) => line.length <= 41));
    observed.push(...lines.slice(4, -2));
    ui.key(DOWN);
  }
  assert.ok(observed.join("").includes(fullPath));
  ui.key(END);
  assert.match(ui.frame(), /Other agents: skill only/);
  ui.key(PAGE_DOWN);
  ui.key(ENTER);
  assert.equal(await ui.result, null);
});

test("an already ended input cancels without entering raw mode", async (t) => {
  const ui = fixture(t);
  ui.input.destroy();
  assert.equal(await ui.start(), null);
  assert.deepEqual(ui.rawCalls, []);
  assert.equal(ui.chunks.length, 0);
});

test("non-TTY input rejects immediately without listeners or raw-mode changes", async (t) => {
  const ui = fixture(t);
  ui.input.isTTY = false;
  await assert.rejects(ui.start(), /requires a TTY/);
  assert.deepEqual(ui.rawCalls, []);
  assert.equal(ui.chunks.length, 0);
  assert.deepEqual(ui.input.listeners("data"), ui.baseline.input.data);
});

test("the required canonical target cannot be omitted", async (t) => {
  const ui = fixture(t);
  await assert.rejects(ui.start({ targets: ui.targets.slice(1) }), /Universal canonical target/);
  assert.deepEqual(ui.rawCalls, []);
});

test("pending preflight blocks Yes and Enter, then shows preserved OMP before exact confirmation", async (t) => {
  const ui = fixture(t);
  const pending = Promise.withResolvers();
  const calls = [];
  ui.start({ preview: (choice) => { calls.push(choice); return pending.promise; } });
  review(ui);
  assert.match(ui.frame(), /Checking destinations; confirmation disabled/);
  accept(ui);
  assert.equal(ui.input.isRaw, true);
  assert.doesNotMatch(ui.frame(), /> Yes/);
  pending.resolve({
    targets: [
      { id: "universal", status: "updated" },
      { id: "omp", status: "preserved existing directory or file; choose Copy to upgrade" },
    ],
    integrations: [],
  });
  await delay(0);
  assert.match(ui.frame(), /Will update/);
  assert.match(ui.frame(), /Preserve \/ conflict/);
  assert.match(ui.frame(), /OMP: preserve MCP, rule and recorder/);
  assert.match(ui.frame(), /Choose Copy to upgrade an existing owned OMP copy/);
  assert.doesNotMatch(ui.frame(), /Will register|configure MCP, install/);
  assert.deepEqual(calls, [{ scope: "global", method: "symlink", targets: ["universal", "omp"] }]);
  accept(ui);
  assert.deepEqual(await ui.result, calls[0]);
  ui.assertRestored();
});

test("back navigation ignores stale preflight results and still blocks confirmation for the new choice", async (t) => {
  const ui = fixture(t);
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  let count = 0;
  ui.start({ preview: () => ++count === 1 ? first.promise : second.promise });
  review(ui);
  await ui.escape();
  ui.key(DOWN);
  ui.key(ENTER);
  first.resolve({ targets: [{ id: "omp", status: "preserved old selection" }], integrations: [] });
  await delay(0);
  assert.match(ui.frame(), /Checking destinations; confirmation disabled/);
  assert.doesNotMatch(ui.frame(), /old selection/);
  accept(ui);
  assert.equal(ui.input.isRaw, true);
  second.resolve({ targets: [{ id: "universal", status: "updated" }, { id: "omp", status: "updated" }], integrations: [] });
  await delay(0);
  assert.match(ui.frame(), /Method: Copy/);
  assert.doesNotMatch(ui.frame(), /> Yes/);
  accept(ui);
  assert.deepEqual(await ui.result, { scope: "global", method: "copy", targets: ["universal", "omp"] });
  ui.assertRestored();
});

test("preflight failure restores terminal and cancellation ignores a late failure", async (t) => {
  const failed = fixture(t);
  const failure = Promise.withResolvers();
  failed.start({ preview: () => failure.promise });
  const rejected = assert.rejects(failed.result, /preflight unavailable/);
  review(failed);
  failure.reject(new Error("preflight unavailable"));
  await rejected;
  failed.assertRestored();
  const cancelled = fixture(t);
  const pending = Promise.withResolvers();
  cancelled.start({ preview: () => pending.promise });
  review(cancelled);
  cancelled.key(CTRL_C);
  assert.equal(await cancelled.result, null);
  pending.reject(new Error("late cancelled preflight failure"));
  await delay(0);
  cancelled.assertRestored();
});

test("actual Copy preflight and cancellation leave prior copied OMP sentinels unchanged", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-vault-ui-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  await mkdir(home);
  await mkdir(cwd);
  const options = { home, cwd, sourceDir: fileURLToPath(new URL("..", import.meta.url)) };
  await installAgents(options);
  const recorder = path.join(home, ".omp/agent/extensions/agent-vault-recorder.ts");
  const server = path.join(home, ".omp/agent/skills/agent-vault/bin/vault-mcp.mjs");
  const configPath = path.join(home, ".omp/agent/mcp.json");
  await writeFile(recorder, `${RECORDER_MARKER}\n// unchanged until Yes\n`);
  await writeFile(server, "// unchanged MCP until Yes\n");
  const config = await readFile(configPath, "utf8");
  const ui = fixture(t);
  ui.targets.splice(0, ui.targets.length, ...await getInstallTargets(options));
  let pending;
  ui.start({ initialMethod: "copy", preview: (choice) => pending = previewInstallAgents({ ...options, ...choice }) });
  review(ui);
  await pending;
  await delay(0);
  assert.match(ui.frame(), /Will update/);
  ui.key(ENTER);
  assert.equal(await ui.result, null);
  assert.equal(await readFile(recorder, "utf8"), `${RECORDER_MARKER}\n// unchanged until Yes\n`);
  assert.equal(await readFile(server, "utf8"), "// unchanged MCP until Yes\n");
  assert.equal(await readFile(configPath, "utf8"), config);
  ui.assertRestored();
});
