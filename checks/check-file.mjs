#!/usr/bin/env node
// check-file.mjs : prove a deliverable file exists, is plausibly complete, is
// the expected bytes, and is fresh.
// Zero dependencies. Node 16+.
//
// This is the foundational checker because the most common way a gate lies is
// the cheapest one: the work never wrote a file at all, or wrote a 0-byte stub,
// or the batch failed silently and yesterday's file is still sitting there
// looking plausible. Every one of those passes a gate whose CHECK only greps a
// log. Size, digest and mtime are the three facts a filesystem can answer
// without opening the format, so they are the three facts this checker measures.
//
// What this checker CANNOT prove:
//   - That the content is correct. A 40 KB report of the wrong quarter passes
//     --min-bytes just as well as the right one. Size is a proxy for "not
//     truncated", never a proxy for "accurate".
//   - That today's run produced the file. mtime is trivially refreshed by a
//     copy, a `touch`, an editor save, or a sync client. --max-age-hours rules
//     out a clearly stale artifact; it does not attest to authorship.
//   - That the file is well-formed. This never parses the file. A .xlsx that is
//     really a truncated ZIP has bytes and an mtime like any other.
//   - That the digest is the right digest. --sha256 proves the file matches a
//     hex string someone typed into the gate. If that string was copied from a
//     bad build, the gate faithfully certifies the bad build.
//   - Anything about clock skew. Freshness is measured against this machine's
//     clock and the filesystem's recorded mtime, both of which can be wrong.
//
// exit codes: 0 pass, 1 measured failure, 2 usage or unreadable input.

import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { PASS_TOKEN, ok, fail, usage, parseArgs, requireInteger, readBuffer } from "./lib/common.mjs";

const CHECKER = "check-file";

const HELP = `usage: check-file.mjs [options] <path>

Measure a single deliverable file: its size, its digest, and its mtime. With no
assertion options this still checks something real: that the path exists, is a
regular file, and is readable, and it reports the measured size and mtime.

options:
  --min-bytes N        fail if the file is smaller than N bytes
  --max-bytes N        fail if the file is larger than N bytes
  --sha256 HEX         fail unless the SHA-256 digest matches (64 hex chars,
                       compared case-insensitively)
  --max-age-hours N    fail if the mtime is older than N hours from now.
                       N may be a decimal, e.g. 0.5
  --newer-than PATH    fail unless this file's mtime is strictly newer than
                       PATH's mtime
  --not-empty-lines    fail if no line holds a non-whitespace character
  -h, --help           print this help

All failing assertions are reported together, not just the first one.

exit codes: 0 pass, 1 measured failure, 2 usage or unreadable input.

gate example:
  CHECK: node checks/check-file.mjs --min-bytes 20000 --max-age-hours 24 out/daily-report.xlsx
  EXPECT: ${PASS_TOKEN} ${CHECKER}`;

const SPEC = {
  flags: ["--not-empty-lines"],
  values: ["--min-bytes", "--max-bytes", "--sha256", "--max-age-hours", "--newer-than"],
};

const { opts, positional } = parseArgs(CHECKER, process.argv.slice(2), SPEC, HELP);

if (positional.length === 0) usage(CHECKER, "needs exactly one file path, got none", HELP);
if (positional.length > 1) {
  usage(CHECKER, "needs exactly one file path, got " + positional.length + ": " + positional.join(" "), HELP);
}
const target = positional[0];

// Every option is validated before the file is touched, so a typo in the gate
// reports as a usage error rather than hiding behind a read failure.
const minBytes = "--min-bytes" in opts
  ? requireInteger(CHECKER, opts["--min-bytes"], "--min-bytes", HELP, { min: 0 })
  : null;
const maxBytes = "--max-bytes" in opts
  ? requireInteger(CHECKER, opts["--max-bytes"], "--max-bytes", HELP, { min: 0 })
  : null;
if (minBytes !== null && maxBytes !== null && minBytes > maxBytes) {
  usage(CHECKER, "--min-bytes " + minBytes + " is above --max-bytes " + maxBytes + ", no file could pass", HELP);
}

let expectedDigest = null;
if ("--sha256" in opts) {
  const raw = String(opts["--sha256"]).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    usage(CHECKER, "--sha256 needs 64 hex characters, got " + raw.length + ": " + raw, HELP);
  }
  expectedDigest = raw.toLowerCase();
}

let maxAgeHours = null;
if ("--max-age-hours" in opts) {
  const raw = String(opts["--max-age-hours"]).trim();
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    usage(CHECKER, "--max-age-hours needs a positive finite number of hours, got " + opts["--max-age-hours"], HELP);
  }
  maxAgeHours = parsed;
}

let reference = null;
if ("--newer-than" in opts) {
  const referencePath = String(opts["--newer-than"]);
  let referenceStats;
  try {
    referenceStats = statSync(referencePath);
  } catch (error) {
    if (error && error.code === "ENOENT") usage(CHECKER, "--newer-than file not found: " + referencePath, HELP);
    if (error && error.code === "EACCES") usage(CHECKER, "--newer-than file not readable: " + referencePath, HELP);
    throw error;
  }
  reference = { path: referencePath, mtimeMs: referenceStats.mtimeMs, iso: referenceStats.mtime.toISOString() };
}

const wantNotEmptyLines = opts["--not-empty-lines"] === true;

// readBuffer reports missing, unreadable and non-regular paths as usage errors,
// which is right: a gate cannot measure what it cannot open.
const buffer = readBuffer(CHECKER, target, HELP);
const stats = statSync(target);
const size = buffer.length;
const mtimeIso = stats.mtime.toISOString();

// Assertions run in a fixed order and every failure is collected. A user
// repairing a deliverable wants the whole list, not one finding per re-run.
const failures = [];
const measured = [];
let assertions = 0;

if (minBytes !== null) {
  assertions += 1;
  if (size < minBytes) failures.push("size " + size + " bytes is below --min-bytes " + minBytes);
  else measured.push("size >= " + minBytes);
}

if (maxBytes !== null) {
  assertions += 1;
  if (size > maxBytes) failures.push("size " + size + " bytes is above --max-bytes " + maxBytes);
  else measured.push("size <= " + maxBytes);
}

if (expectedDigest !== null) {
  assertions += 1;
  const actualDigest = createHash("sha256").update(buffer).digest("hex");
  if (actualDigest !== expectedDigest) {
    failures.push("sha256 is " + actualDigest + ", expected " + expectedDigest);
  } else {
    measured.push("sha256 " + actualDigest.slice(0, 12) + " matches");
  }
}

if (wantNotEmptyLines) {
  assertions += 1;
  // Lenient UTF-8 on purpose and only here: this test asks whether any visible
  // character exists at all, and a mis-decoded byte is still not whitespace.
  // Encoding correctness is a different question and a different checker.
  const text = new TextDecoder("utf-8").decode(buffer);
  const lines = text.split(/\r\n|\r|\n/);
  const filled = lines.filter((line) => /\S/.test(line)).length;
  if (filled === 0) {
    failures.push("no line holds a non-whitespace character across " + lines.length + " line(s)");
  } else {
    measured.push(filled + " non-empty line(s)");
  }
}

if (maxAgeHours !== null) {
  assertions += 1;
  const ageHours = (Date.now() - stats.mtimeMs) / 3600000;
  const shownAge = ageHours.toFixed(2);
  if (ageHours > maxAgeHours) {
    failures.push("mtime " + mtimeIso + " is " + shownAge + "h old, above --max-age-hours " + maxAgeHours);
  } else {
    measured.push("age " + shownAge + "h <= " + maxAgeHours + "h");
  }
}

if (reference !== null) {
  assertions += 1;
  if (!(stats.mtimeMs > reference.mtimeMs)) {
    failures.push(
      "mtime " + mtimeIso + " is not strictly newer than " + reference.path + " at " + reference.iso,
    );
  } else {
    measured.push("newer than " + reference.path);
  }
}

if (failures.length) {
  fail(CHECKER, target + ": " + failures.length + " of " + assertions + " assertion(s) failed", failures);
}

const parts = [size + " bytes", "mtime " + mtimeIso];
if (measured.length) parts.push(...measured);
else parts.push("exists, regular file, no assertions requested");

ok(CHECKER, target + ": " + parts.join(", "));
