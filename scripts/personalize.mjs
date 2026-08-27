#!/usr/bin/env node
// Fork-local helper: replace <skill-dir> and <path-to-skill> placeholders in the
// documentation with this installation's real absolute path, so agents can run
// the printed commands verbatim. Re-run after every upstream rebase (the rebase
// restores the placeholders). Zero dependencies, Node 16+.
//
// Usage: node scripts/personalize.mjs [--dry-run]

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

const targets = [
  "SKILL.md",
  "README.md",
  "SECURITY.md",
  ...readdirSync(join(skillDir, "references")).filter((f) => f.endsWith(".md")).map((f) => join("references", f)),
  ...readdirSync(join(skillDir, "templates")).filter((f) => f.endsWith(".md")).map((f) => join("templates", f)),
];

const PLACEHOLDERS = [/<skill-dir>/g, /<path-to-skill>/g];
let totalFiles = 0;
let totalHits = 0;

for (const rel of targets) {
  const abs = join(skillDir, rel);
  const before = readFileSync(abs, "utf8");
  let after = before;
  let hits = 0;
  for (const re of PLACEHOLDERS) {
    after = after.replace(re, () => {
      hits += 1;
      return skillDir;
    });
  }
  if (hits > 0) {
    totalFiles += 1;
    totalHits += hits;
    if (!dryRun) writeFileSync(abs, after);
    console.log(`${dryRun ? "would update" : "updated"} ${rel}: ${hits} placeholder(s)`);
  }
}

console.log(`personalize ${dryRun ? "dry run" : "done"}: ${totalHits} placeholder(s) in ${totalFiles} file(s) -> ${skillDir}`);
