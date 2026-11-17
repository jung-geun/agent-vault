import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "integrations", "obsidian", "agent-vault-wiki");
const templatePath = path.join(pluginDir, "main.template.js");
const dataPath = path.join(pluginDir, "data.cjs");
const outputPath = path.join(pluginDir, "main.js");
const placeholder = "// @agent-vault-data";
const startMarker = "// @agent-vault-data:start\n";
const endMarker = "// @agent-vault-data:end";

const [template, data] = await Promise.all([
  readFile(templatePath, "utf8"),
  readFile(dataPath, "utf8"),
]);
const placeholderIndex = template.indexOf(placeholder);
const startIndex = data.indexOf(startMarker);
const bodyStart = startIndex + startMarker.length;
const endIndex = data.indexOf(endMarker, bodyStart);
if (placeholderIndex < 0 || template.indexOf(placeholder, placeholderIndex + placeholder.length) >= 0) {
  throw new Error("Plugin template must contain exactly one data placeholder.");
}
if (startIndex < 0 || endIndex < bodyStart || data.indexOf(startMarker, startIndex + startMarker.length) >= 0) {
  throw new Error("Plugin data source has invalid bundle markers.");
}

const dataSource = data.slice(bodyStart, endIndex).trimEnd();
const expected = template.replace(placeholder, dataSource);
if (process.argv.includes("--check")) {
  const actual = await readFile(outputPath, "utf8");
  if (actual !== expected) throw new Error("Generated plugin main.js is stale; run npm run build:obsidian.");
} else {
  await writeFile(outputPath, expected, { encoding: "utf8", mode: 0o644 });
}
