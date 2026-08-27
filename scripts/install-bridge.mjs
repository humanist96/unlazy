#!/usr/bin/env node
// install-bridge.mjs : install the SuperClaude bridge into the user's Claude
// configuration directory.
// Zero dependencies. Node 16+. Fork-local, not part of upstream unlazy.
//
// The bridge tells an agent how this skill and the SuperClaude framework divide
// responsibility, so it has to live where Claude Code loads global context,
// which is outside this repository. That would normally mean an important file
// exists only on one machine and is never version controlled.
//
// This resolves it in one direction only: bridge/UNLAZY-BRIDGE.md in the
// repository is the source of truth, and this script copies it into place. Edit
// the repository copy and re-run. The script refuses to overwrite a differing
// installed file without --force, so a local edit is reported rather than lost.
//
//   node scripts/install-bridge.mjs [--force] [--dir <claude-config-dir>]
//
// exit codes: 0 installed or already current, 1 differing file without --force,
//             2 usage or unreadable input.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = "install-bridge";
const HELP = `usage: install-bridge.mjs [--force] [--dir <claude-config-dir>]

Copy bridge/UNLAZY-BRIDGE.md into the Claude configuration directory and report
whether the entry point imports it.

  --force   overwrite an installed file whose contents differ
  --dir     target configuration directory (default: <home>/.claude)

exit codes: 0 installed or already current, 1 differing file without --force,
            2 usage or unreadable input.`;

const args = process.argv.slice(2);
let force = false;
let targetDir = join(homedir(), ".claude");

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") { console.log(HELP); process.exit(0); }
  else if (arg === "--force") force = true;
  else if (arg === "--dir") {
    const value = args[++i];
    if (value === undefined) { console.error(SELF + ": --dir needs a value"); process.exit(2); }
    targetDir = resolve(value);
  } else {
    console.error(SELF + ": unknown option " + arg);
    console.error("run install-bridge.mjs --help for usage");
    process.exit(2);
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "bridge", "UNLAZY-BRIDGE.md");
if (!existsSync(source)) {
  console.error(SELF + ": source not found: " + source);
  process.exit(2);
}
// The repository copy carries the <skill-dir> placeholder rather than a real
// path, because this fork is public and a committed home directory is both
// machine-specific and needlessly identifying. Substitution happens here, at
// install time, so the installed copy still hands the agent a command it can
// run verbatim. This script sits inside the skill, so its own location is the
// answer: no configuration, and it stays correct if the skill is moved.
const SKILL_DIR_PLACEHOLDER = "<skill-dir>";
const body = Buffer.from(
  readFileSync(source, "utf8").split(SKILL_DIR_PLACEHOLDER).join(repoRoot), "utf8");

// Compare content, not line endings. Git checks this repository out with CRLF
// on Windows, so a byte comparison against a file written with LF reports a
// difference on every run and trains the reader to ignore the warning. The
// digest is taken over normalised text for the same reason: it has to mean the
// same thing on both platforms.
const normalise = (buffer) => Buffer.from(buffer.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
const digest = (buffer) => createHash("sha256").update(normalise(buffer)).digest("hex").slice(0, 12);
const sameContent = (a, b) => normalise(a).equals(normalise(b));

const target = join(targetDir, "UNLAZY-BRIDGE.md");
if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

if (existsSync(target)) {
  const installed = readFileSync(target);
  if (sameContent(installed, body)) {
    console.log(SELF + ": already current at " + target + " (" + digest(body) + ")");
  } else if (!force) {
    console.error(SELF + ": installed copy differs from the repository copy");
    console.error("  installed:  " + target + " (" + digest(installed) + ", " + installed.length + " bytes)");
    console.error("  repository: " + source + " (" + digest(body) + ", " + body.length + " bytes)");
    console.error("Edit the repository copy and re-run, or pass --force to discard the installed edits.");
    process.exit(1);
  } else {
    writeFileSync(target, body);
    console.log(SELF + ": overwrote " + target + " (" + digest(body) + ")");
  }
} else {
  writeFileSync(target, body);
  console.log(SELF + ": installed " + target + " (" + digest(body) + ")");
}

// The file is inert until the entry point imports it, and a silently unimported
// bridge is worse than none: the agent keeps the terminology collisions this
// document exists to resolve, and nothing announces that it is missing.
const entry = join(targetDir, "CLAUDE.md");
const IMPORT_LINE = "@UNLAZY-BRIDGE.md";
if (!existsSync(entry)) {
  console.log("");
  console.log("NEXT: " + entry + " does not exist. Create it containing:");
  console.log("  " + IMPORT_LINE);
} else if (!readFileSync(entry, "utf8").includes(IMPORT_LINE)) {
  console.log("");
  console.log("NEXT: add this line to " + entry + " so the bridge is loaded:");
  console.log("  " + IMPORT_LINE);
} else {
  console.log(SELF + ": " + entry + " imports the bridge");
}
console.log("");
console.log("Global context is read once when a session starts, so an already");
console.log("running session will not see this until it is restarted.");
