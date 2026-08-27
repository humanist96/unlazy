// security-claims-tests.mjs : keep docs/security-review-ko.md true.
// Zero dependencies. Node 16+. Fork-local, not part of upstream unlazy.
//
// The security review document makes factual claims about this code: no runtime
// dependencies, no network capability, exactly three files that can start a
// process, and checkers that never write. Those claims were verified by hand
// once. Prose cannot notice when it stops being true, and a security document
// that quietly went stale is worse than none, because it was believed.
//
// These tests fail the build the moment a claim stops holding, which forces the
// document to be updated in the same change rather than years later.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = "docs/security-review-ko.md";

let failures = 0;
let total = 0;
function check(name, condition, detail) {
  total += 1;
  if (condition) {
    console.log("ok   " + name);
  } else {
    failures += 1;
    console.log("FAIL " + name + (detail === undefined ? "" : "  << " + detail));
  }
}

// Shipped code is everything an installed skill runs. Tests are excluded: they
// legitimately spawn processes to exercise the tools, and they are not
// installed into a user's workflow.
function shippedFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "tests" || entry === "node_modules" || entry === ".git") continue;
        walk(full);
      } else if (entry.endsWith(".mjs")) {
        found.push(full);
      }
    }
  };
  walk(join(root, "scripts"));
  walk(join(root, "checks"));
  return found;
}

const files = shippedFiles();
const read = (file) => readFileSync(file, "utf8");
const rel = (file) => relative(root, file).split(sep).join("/");

check("claim: the shipped tree is non-empty and was actually scanned", files.length >= 10,
  files.length + " file(s)");

// Section 2: no runtime dependencies.
const pkg = JSON.parse(read(join(root, "package.json")));
check("claim 2: package.json declares no dependencies",
  pkg.dependencies === undefined && pkg.devDependencies === undefined,
  JSON.stringify({ dependencies: pkg.dependencies, devDependencies: pkg.devDependencies }));

// Section 2: only Node built-ins and relative paths are imported.
const badImports = [];
for (const file of files) {
  for (const match of read(file).matchAll(/^\s*import[\s\S]{0,200}?from\s+["']([^"']+)["']/gm)) {
    const specifier = match[1];
    if (!specifier.startsWith("node:") && !specifier.startsWith("./") && !specifier.startsWith("../")) {
      badImports.push(rel(file) + " -> " + specifier);
    }
  }
}
check("claim 2: shipped code imports only node built-ins and local files",
  badImports.length === 0, badImports.join(", "));

// Section 4: no network capability anywhere in shipped code.
const NETWORK = /node:(https?|net|dgram|tls|http2)|\bfetch\s*\(|XMLHttpRequest|WebSocket|navigator\.sendBeacon/;
const networked = files.filter((file) => NETWORK.test(read(file))).map(rel);
check("claim 4: no shipped file has network capability", networked.length === 0, networked.join(", "));

// Section 3.1: exactly three shipped files can start a process, and they are
// the three the document names.
const EXPECTED_SPAWNERS = [
  "scripts/gate-check.mjs",
  "scripts/lib/check-supervisor.mjs",
  "scripts/lib/process-tree.mjs",
];
const spawners = files.filter((file) => /from\s+["']node:child_process["']/.test(read(file))).map(rel).sort();
check("claim 3.1: exactly the three documented files can start a process",
  JSON.stringify(spawners) === JSON.stringify([...EXPECTED_SPAWNERS].sort()),
  "found: " + spawners.join(", "));

// Section 3.1 and 5: the Stop hook never executes anything.
check("claim 3.1: the Stop hook cannot start a process",
  !spawners.includes("scripts/stop-hook.mjs"));

// Section 5: the deliverable checkers are pure readers.
const WRITES = /\b(writeFileSync|appendFileSync|mkdirSync|unlinkSync|renameSync|rmSync|createWriteStream|writeSync)\b/;
const writingCheckers = files
  .filter((file) => rel(file).startsWith("checks/"))
  .filter((file) => WRITES.test(read(file)))
  .map(rel);
check("claim 5: no checker or checker library writes to the filesystem",
  writingCheckers.length === 0, writingCheckers.join(", "));

// Section 3.3: approval identity binds the execution context, not just the
// command. The document lists these by name, so the tokens must still be there.
const gateCheck = read(join(root, "scripts", "gate-check.mjs"));
// The oracle function is what gets serialised and hashed into the approval
// signature, so these field names are the binding the document describes.
const oracleBody = (gateCheck.split("function oracle(")[1] || "").split("function signature(")[0];
check("claim 3.3: the oracle builder was located", oracleBody.length > 50, "len " + oracleBody.length);
for (const field of ["check", "expect", "cwd", "shell", "timeoutMs", "platform", "path"]) {
  check("claim 3.3: approval identity still binds " + field, oracleBody.includes(field));
}
check("claim 3.3: the approval store must stay outside the repository",
  /must be outside the repository root/.test(gateCheck));

// Section 6: successful raw output is fingerprinted, never persisted.
check("claim 6: evidence records an output digest rather than the output",
  /output-sha256/.test(gateCheck) && /output-bytes/.test(gateCheck));

// The document itself must exist and still carry the sections referenced above.
const security = read(join(root, doc));
for (const heading of [
  "## 2. 반입 대상과 공급망",
  "## 3. 명령 실행 경계",
  "## 4. 네트워크 통신",
  "## 5. 파일시스템 쓰기 범위",
  "## 6. 데이터 취급과 잔존",
  "## 8. 알려진 제약과 잔존 위험",
]) {
  check("document: " + doc + " still contains " + heading.slice(3), security.includes(heading));
}
check("document: the three spawning files are named in the document",
  EXPECTED_SPAWNERS.every((file) => security.includes(file.split("/").pop())));

console.log("");
console.log(failures === 0 ? total + "/" + total + " passed" : failures + " of " + total + " failed");
process.exit(failures === 0 ? 0 : 1);
