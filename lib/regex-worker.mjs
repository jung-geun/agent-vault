import { parentPort, workerData } from "node:worker_threads";

const FIELDS = ["title", "path", "tags", "content"];
const MAX_MATCHES = 50;
const EXCERPT_CHARS = 200;

function excerptAt(text, index, length) {
  const center = index + Math.floor(length / 2);
  const start = Math.max(0, Math.min(center - EXCERPT_CHARS / 2, text.length - EXCERPT_CHARS));
  return text.slice(start, start + EXCERPT_CHARS).replace(/\r\n|[\n\r\u2028\u2029]/g, " ");
}

const { items, pattern, flags } = workerData;
const regex = new RegExp(pattern, flags + "g");
const matches = [];
for (const { key, texts } of items) {
  let count = 0;
  let field, excerpt;
  for (const name of FIELDS) {
    const text = texts[name];
    if (text === undefined) continue;
    regex.lastIndex = 0;
    while (count < MAX_MATCHES) {
      const hit = regex.exec(text);
      if (!hit) break;
      if (count === 0) {
        field = name;
        excerpt = excerptAt(text, hit.index, hit[0].length);
      }
      count++;
      if (hit[0].length === 0) {
        // AdvanceStringIndex: with `u`, skip a full surrogate pair, not half of it.
        regex.lastIndex += regex.unicode && text.codePointAt(regex.lastIndex) > 0xffff ? 2 : 1;
      }
    }
    if (count === MAX_MATCHES) break;
  }
  if (count > 0) matches.push({ key, count, field, excerpt });
}
parentPort.postMessage(matches);
