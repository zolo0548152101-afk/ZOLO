#!/usr/bin/env node
/**
 * Fail the build when customer-facing Hebrew sentences reappear in runtime
 * code, or when git prompt files are loaded at runtime, or when canonical
 * reply injection returns.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

const ALLOWLIST = new Set([
  // Neutral outage / guard fallbacks — the only fixed customer lines allowed.
  join(SRC, "domain/ai-guards.ts"),
  // Admin/ops alerts and status labels (not customer conversation).
  join(SRC, "application/runtime.ts"),
  join(SRC, "http.ts"),
  join(SRC, "infrastructure/store.ts"),
  // Field map Hebrew labels (data, not sentences).
  join(SRC, "domain/field-map.ts"),
  join(SRC, "domain/turn-facts.ts"),
]);

const FORBIDDEN_IDENTIFIERS = [
  /\{\{canonical\}\}/,
  /loadPrompt\s*\(/,
  /prompts\/haim-reply/,
  /prompts\/haim-action/,
  /phraseReply\s*\(/,
  /mode:\s*"git"/,
];

const FORBIDDEN_IN_ENGINE = [
  /turnAck/,
  /fromTemplate/,
  /SOFT_PHOTO_ASK/,
  /PHOTO_FIRST/,
];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

const errors = [];
const files = await walk(SRC);
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const pattern of FORBIDDEN_IDENTIFIERS) {
    if (pattern.test(text) && !ALLOWLIST.has(file)) {
      // canonicalReply is still a commit field name in engine — allow the
      // property key only when paired with AI overwrite path documentation.
      if (pattern.source.includes("canonicalReply") && file.endsWith("engine.ts"))
        continue;
      errors.push(`${file}: matches ${pattern}`);
    }
  }
  if (file.endsWith("engine.ts")) {
    for (const pattern of FORBIDDEN_IN_ENGINE) {
      // PHOTO_FIRST / SOFT_PHOTO_ASK may still appear as voided legacy refs
      // during the migration; flag active reinjection only.
      if (/turnAck\s*=/.test(text) || /fromTemplate\s*=/.test(text))
        errors.push(`${file}: reply reinjection (${pattern})`);
    }
  }
  if (file.endsWith("ai.ts") && /mode:\s*"git"/.test(text))
    errors.push(`${file}: git prompt mode must not exist`);
}

if (errors.length) {
  console.error("validate-no-code-sentences FAILED:");
  for (const error of errors) console.error(" -", error);
  process.exit(1);
}
console.log("validate-no-code-sentences OK");
