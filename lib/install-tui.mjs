import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";

const ESC = "\u001b[";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function terminalText(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function cellWidth(text) {
  const point = text.codePointAt(0);
  if (/^\p{Mark}/u.test(text)) return 0;
  return /\p{Extended_Pictographic}/u.test(text) || point >= 0x1100 && (
    point <= 0x115f || point >= 0x2329 && point <= 0x232a ||
    point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3 ||
    point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f ||
    point >= 0xff01 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6 ||
    point >= 0x20000 && point <= 0x3fffd
  ) ? 2 : 1;
}

function firstFitting(options, width) {
  return options.find((text) => {
    let size = 0;
    for (const { segment } of segmenter.segment(text)) size += cellWidth(segment);
    return size <= width;
  }) ?? "";
}

function clip(text, width) {
  let result = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = cellWidth(segment);
    if (used + size > width) break;
    result += segment;
    used += size;
  }
  return result;
}

function wrap(text, width) {
  const lines = [];
  let line = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = cellWidth(segment);
    if (used + size > width && line) {
      lines.push(line);
      line = "";
      used = 0;
    }
    // A one-column terminal cannot display a two-column grapheme safely.
    if (size > width) {
      line += "?";
      used += 1;
    } else {
      line += segment;
      used += size;
    }
  }
  lines.push(line);
  return lines;
}

/** Collect an installation choice. This interface never writes installation files. */
export async function runInstallTui({
  targets,
  initialScope = "global",
  initialMethod = "symlink",
  defaultTargets = ["universal", "omp"],
  skill,
  preview,
  input = process.stdin,
  output = process.stdout,
}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive installation requires a TTY for input and output. Use explicit install flags in non-interactive sessions.");
  }
  if (!Array.isArray(targets) || !targets.some((target) => target.id === "universal")) {
    throw new Error("Interactive installation requires the Universal canonical target.");
  }
  if (!["global", "local"].includes(initialScope) || !["symlink", "copy"].includes(initialMethod)) {
    throw new Error("Invalid initial installation scope or method.");
  }

  const completion = Promise.withResolvers();
  const selected = new Set(targets.filter((target) =>
    target.required || target.id === "universal" || defaultTargets.includes(target.id)).map((target) => target.id));
  const required = (target) => target.required || target.id === "universal";
  const destination = (target) => terminalText(scope === "global" ? target.globalPath : target.localPath);
  let scope = initialScope;
  let method = initialMethod;
  let step = 0;
  let focus = 0;
  let filter = "";
  let proceed = false;
  let summaryOffset = 0;
  let summaryLength = 0;
  let bodyHeight = 1;
  let done = false;
  let previewResult;
  let previewPending = false;
  let previewGeneration = 0;
  let screenEntered = false;
  let rawChanged = false;
  const originalRaw = Boolean(input.isRaw);
  const originalFlowing = input.readableFlowing === true;
  // Keep readline's decoder and internal listeners off the caller's input stream.
  const keys = new PassThrough();

  function visibleTargets() {
    const query = filter.toLocaleLowerCase();
    return targets.filter((target) =>
      `${target.label} ${target.id} ${target.description ?? ""}`.toLocaleLowerCase().includes(query));
  }

  function plannedStatus(status) {
    status = terminalText(status);
    if (status.startsWith("preserved")) return `Preserve / conflict: ${status}`;
    if (status === "already current") return "Already current";
    if (status === "linked") return "Will link";
    if (status.startsWith("updated")) return `Will update (${status})`;
    if (status === "registered") return "Will register";
    return `Will install (${status})`;
  }

  function checkPreview() {
    const generation = ++previewGeneration;
    previewResult = undefined;
    previewPending = Boolean(preview);
    if (!preview) return;
    const result = preview({ scope, method, targets: targets.filter((target) => selected.has(target.id)).map((target) => target.id) });
    if (!result || typeof result.then !== "function") {
      previewResult = result;
      previewPending = false;
      return;
    }
    Promise.resolve(result).then((value) => {
      if (done || step !== 3 || generation !== previewGeneration) return;
      previewResult = value;
      previewPending = false;
      render();
    }).catch((error) => {
      if (!done && step === 3 && generation === previewGeneration) finish(null, error);
    });
  }

  function summary() {
    const canonical = targets.find((target) => target.id === "universal");
    const lines = [
      "Installation summary",
      `Skill: ${terminalText(skill?.name)} ${terminalText(skill?.version)}`.trimEnd(),
      `Source: ${terminalText(skill?.source)}`,
      `Scope: ${scope === "global" ? "Global (all projects)" : "Project (current directory)"}`,
      `Method: ${method === "symlink" ? "Symlink" : "Copy"}`,
      "",
      "Canonical skill (copied):",
      destination(canonical),
      previewPending ? "Checking destinations (read-only)..." : previewResult
        ? plannedStatus(previewResult.targets.find(({ id }) => id === "universal")?.status ?? "preserved: target not checked")
        : "Destination not checked.",
    ];
    for (const target of targets) {
      if (!selected.has(target.id) || target.id === "universal") continue;
      lines.push("", `${terminalText(target.label)} (${method === "copy" ? "copy" : "symlink to canonical"}):`, destination(target));
      if (previewResult) {
        const result = previewResult.targets.find(({ id }) => id === target.id);
        lines.push(plannedStatus(result?.status ?? "preserved: target not checked"));
      }
    }
    lines.push("", "Integrations:");
    if (previewPending) {
      lines.push("Checking OMP MCP, rule and recorder; confirmation disabled.");
    } else if (scope === "global" && selected.has("omp")) {
      const omp = previewResult?.targets.find(({ id }) => id === "omp");
      if (omp?.status.startsWith("preserved")) {
        lines.push("OMP: preserve MCP, rule and recorder; OMP target was preserved.");
        if (omp.status.includes("choose Copy to upgrade")) lines.push("Choose Copy to upgrade an existing owned OMP copy.");
      } else if (previewResult) {
        for (const integration of previewResult.integrations) {
          lines.push(`${terminalText(integration.label)}: ${plannedStatus(integration.status)}`, terminalText(integration.path));
        }
      } else lines.push("OMP MCP, rule and recorder: not checked.");
    } else if (selected.has("omp")) {
      lines.push("OMP: project skill only; no global MCP, rule or recorder changes.");
    } else {
      lines.push("OMP not selected: no OMP integration changes.");
    }
    lines.push("Other agents: skill only; configure MCP manually.", "No installation files change until you choose Yes and press Enter.");
    return lines;
  }

  function render() {
    if (done) return;
    const columns = Math.max(1, Math.floor(output.columns || 80));
    const rows = Math.max(1, Math.floor(output.rows || 24));
    // Leave one column unused to prevent the terminal's automatic line wrap.
    const width = Math.max(1, columns - 1);
    const titles = ["Choose agent targets", "Installation scope", "Installation method", "Review and proceed"];
    const header = rows >= 9 ? [
      `AGENT VAULT  /  ${terminalText(skill?.name)} ${terminalText(skill?.version)}`.trimEnd(),
      `Source: ${terminalText(skill?.source)}`,
      `${step + 1}/4  ${titles[step]}`,
      "",
    ] : rows >= 5 ? [`${step + 1}/4  ${titles[step]}`] : [];
    let hints;
    let status;
    let content;
    if (step === 0) {
      const visible = visibleTargets();
      focus = Math.max(0, Math.min(focus, visible.length - 1));
      hints = "Up/Down move  Space select  Ctrl+A toggle visible  Enter next  Ctrl+C cancel";
      status = `Search: ${terminalText(filter) || "(type to filter)"}  |  ${selected.size} selected`;
      content = visible.map((target, index) =>
        `${index === focus ? ">" : " "} [${required(target) ? "*" : selected.has(target.id) ? "x" : " "}] ${terminalText(target.label)}${required(target) ? " (required)" : ""}${target.detected ? " (detected)" : ""}${target.description ? ` - ${terminalText(target.description)}` : ""}`);
      if (!content.length) content = ["No matching agents. Backspace clears your search; selected targets stay selected."];
    } else if (step === 1) {
      content = [
        `${scope === "global" ? ">" : " "} Global  - Available across all projects`,
        `${scope === "local" ? ">" : " "} Project - Current project only`,
      ];
      status = `Selected: ${scope === "global" ? "Global" : "Project"}`;
      hints = "Up/Down choose  Enter next  Esc back  Ctrl+C cancel";
    } else if (step === 2) {
      content = [
        `${method === "symlink" ? ">" : " "} Symlink - One canonical copy, linked agent targets`,
        `${method === "copy" ? ">" : " "} Copy    - Independent skill copy for each target`,
      ];
      status = `Selected: ${method === "symlink" ? "Symlink" : "Copy"}`;
      hints = "Up/Down choose  Enter review  Esc back  Ctrl+C cancel";
    } else {
      content = summary().flatMap((line) => wrap(line, width));
      status = previewPending ? "Checking destinations; confirmation disabled." : `Proceed with installation? ${proceed ? "  No  / > Yes" : "> No  /   Yes"}`;
      hints = previewPending ? "Checking read-only preflight  Esc back  Ctrl+C cancel" : "Left/Right choose  Enter confirm  Up/Down scroll  PgUp/PgDn  Esc back  Ctrl+C cancel";
    }
    hints = firstFitting([
      hints,
      step === 3
        ? "L/R choose Enter OK Up/Down scroll Esc ^C"
        : step === 0
          ? "Arrows Space ^A Enter next Esc ^C"
          : "Arrows choose Enter next Esc back ^C cancel",
      step === 3 ? "L/R Enter Up/Down Esc ^C" : "Arrows Space Enter Esc ^C",
      "Enter Esc ^C",
      "Enter ^C",
      "^C",
    ], width);
    if (step === 3 && width < 48) status = previewPending ? "Checking; confirm disabled" : `Proceed? ${proceed ? "No / > Yes" : "> No / Yes"}`;
    const footer = rows >= 3 ? [status, hints] : [step === 3 ? previewPending ? "Checking ^C" : `${proceed ? "Yes" : "No"} Enter ^C` : hints];
    bodyHeight = Math.max(0, rows - header.length - footer.length);
    let body;
    if (step === 3) {
      summaryLength = content.length;
      summaryOffset = Math.max(0, Math.min(summaryOffset, Math.max(0, content.length - bodyHeight)));
      body = content.slice(summaryOffset, summaryOffset + bodyHeight);
      if (rows >= 3 && content.length > bodyHeight) {
        const range = `${summaryOffset + 1}-${Math.min(content.length, summaryOffset + bodyHeight)}/${content.length}`;
        const more = summaryOffset + bodyHeight < content.length ? "more below" : "more above";
        footer[0] = firstFitting([
          `${status} | ${range} ${more}`,
          `${status} | ${range}`,
          previewPending ? `Checking | ${range} ${more}` : `Proceed? ${proceed ? "Yes" : "No"} | ${range} ${more}`,
          previewPending ? `Checking ${range}` : `${proceed ? "Yes" : "No"} ${range}`,
          previewPending ? "Checking" : `${proceed ? "Yes" : "No"}`,
        ], width);
      }
    } else if (step === 0) {
      const start = Math.max(0, Math.min(focus - Math.floor(bodyHeight / 2), content.length - bodyHeight));
      body = content.slice(start, start + bodyHeight);
    } else {
      const index = step === 1 ? Number(scope === "local") : Number(method === "copy");
      body = bodyHeight === 1 ? [content[index]] : content.slice(0, bodyHeight);
    }
    while (body.length < bodyHeight) body.push("");
    const lines = [...header, ...body, ...footer].slice(-rows).map((line) => clip(line, width));
    output.write(`${ESC}H${ESC}2J${lines.join("\r\n")}`);
  }

  function finish(value, error) {
    if (done) return;
    done = true;
    input.removeListener("data", onData);
    input.removeListener("end", onEnd);
    input.removeListener("close", onEnd);
    input.removeListener("error", onError);
    output.removeListener("resize", onResize);
    output.removeListener("error", onError);
    keys.removeListener("keypress", onKey);
    keys.destroy();
    let cleanupError;
    try {
      if (rawChanged) input.setRawMode(originalRaw);
    } catch (cause) {
      cleanupError = cause;
    }
    try {
      if (!originalFlowing) input.pause();
      if (screenEntered) output.write(`${ESC}?25h${ESC}?1049l`);
    } catch (cause) {
      cleanupError ??= cause;
    }
    if (error || cleanupError) completion.reject(error ?? cleanupError);
    else completion.resolve(value);
  }

  function onKey(text, key = {}) {
    if (done) return;
    try {
      if (key.ctrl && key.name === "c" || key.ctrl && key.name === "d") {
        finish(null);
        return;
      }
      if (key.name === "escape") {
        if (step > 0) {
          step -= 1;
          previewGeneration += 1;
          previewPending = false;
        }
        else finish(null);
      } else if (key.name === "return" || key.name === "enter") {
        if (step === 3 && previewPending) return;
        if (step === 3) {
          finish(proceed ? { scope, method, targets: targets.filter((target) => selected.has(target.id)).map((target) => target.id) } : null);
          return;
        }
        step += 1;
        proceed = false;
        summaryOffset = 0;
        if (step === 3) checkPreview();
      } else if (step === 0) {
        const visible = visibleTargets();
        if (key.name === "up") focus = Math.max(0, focus - 1);
        else if (key.name === "down") focus = Math.min(visible.length - 1, focus + 1);
        else if (key.ctrl && key.name === "a") {
          const selectable = visible.filter((target) => !required(target));
          const allSelected = selectable.every((target) => selected.has(target.id));
          for (const target of selectable) {
            if (allSelected) selected.delete(target.id);
            else selected.add(target.id);
          }
        } else if (key.name === "space" || text === " ") {
          const target = visible[focus];
          if (target && !required(target)) {
            if (selected.has(target.id)) selected.delete(target.id);
            else selected.add(target.id);
          }
        } else if (key.name === "backspace") {
          filter = [...segmenter.segment(filter)].slice(0, -1).map(({ segment }) => segment).join("");
          focus = 0;
        } else if (!key.ctrl && !key.meta && text && !/[\u0000-\u001f\u007f-\u009f]/.test(text)) {
          filter += text;
          focus = 0;
        }
      } else if (step === 1 || step === 2) {
        if (["up", "down", "left", "right", "space"].includes(key.name)) {
          if (step === 1) scope = scope === "global" ? "local" : "global";
          else method = method === "symlink" ? "copy" : "symlink";
        }
      } else if (step === 3) {
        if (previewPending && !["up", "down", "pageup", "pagedown", "home", "end"].includes(key.name)) return;
        if (key.name === "left") proceed = false;
        else if (key.name === "right") proceed = true;
        else if (key.name === "space") proceed = !proceed;
        else if (text?.toLowerCase() === "y") proceed = true;
        else if (text?.toLowerCase() === "n") proceed = false;
        else if (key.name === "up") summaryOffset -= 1;
        else if (key.name === "down") summaryOffset += 1;
        else if (key.name === "pageup") summaryOffset -= Math.max(1, bodyHeight);
        else if (key.name === "pagedown") summaryOffset += Math.max(1, bodyHeight);
        else if (key.name === "home") summaryOffset = 0;
        else if (key.name === "end") summaryOffset = summaryLength;
      }
      render();
    } catch (error) {
      finish(null, error);
    }
  }

  function onData(data) {
    try { keys.write(data); } catch (error) { finish(null, error); }
  }
  function onEnd() { finish(null); }
  function onError(error) { finish(null, error); }
  function onResize() {
    try { render(); } catch (error) { finish(null, error); }
  }

  try {
    if (input.readableEnded || input.destroyed || output.destroyed) {
      finish(null);
      return completion.promise;
    }
    emitKeypressEvents(keys);
    keys.on("keypress", onKey);
    input.on("end", onEnd);
    input.on("close", onEnd);
    input.on("error", onError);
    output.on("resize", onResize);
    output.on("error", onError);
    rawChanged = true;
    input.setRawMode(true);
    screenEntered = true;
    output.write(`${ESC}?1049h${ESC}?25l`);
    render();
    input.on("data", onData);
    input.resume();
  } catch (error) {
    finish(null, error);
  }
  return completion.promise;
}
