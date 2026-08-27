#!/usr/bin/env node
// check-batch-log.mjs : prove an overnight batch log is today's, is readable
// Korean text, is populated, says what it should say, and does not say what it
// must not say.
// Zero dependencies. Node 16+.
//
// This checker exists because of one asymmetry. A presence check that fails to
// run reports a failure and someone investigates. An ABSENCE check that fails
// to run reports a pass, and nobody investigates anything. "No ERROR in the
// log" is equally cheerful when the log is empty, when the path pointed at
// yesterday's file, when the operator typed the wrong directory, when the file
// decoded into mojibake so no Korean error word could ever match, and when the
// pattern was misspelled and could not have matched anything at all. Every one
// of those is a green gate over a batch that did not run.
//
// So the rule this checker enforces MECHANICALLY, rather than trusting anyone
// to remember it: you may not assert that something is absent until you have
// shown this checker could have found something. Passing --forbid-pattern
// without at least one --positive-control is a usage error, exit 2, not a
// permissive default. The positive control is a pattern you know appears in a
// healthy log, a start banner or a timestamp prefix. When it matches, the
// checker has demonstrated on this exact run that it opened the right file,
// decoded it correctly, and can match text in it. Only then is "and I found no
// ERROR" a measurement instead of a shrug.
//
// Catastrophic backtracking is a real risk when the gate author supplies the
// regex. The mitigation here is structural: every pattern is matched one line
// at a time, never against the whole file, so the input to any single match is
// bounded by a log line rather than by the file size.
//
// What this checker CANNOT prove:
//   - That the batch was CORRECT. A log can be fresh, populated, Korean, free
//     of the word ERROR, and carry a completion banner, while the job wrote
//     zeroes into every row. Log text is the job's own account of itself.
//   - That the forbidden words are the right forbidden words. It matches the
//     patterns the gate hands it. A failure mode that prints "WARN" and exits
//     0 passes a gate that only forbids "ERROR".
//   - That a passing positive control covers the whole file. It proves the
//     checker read a populated, correctly decoded log. It does not prove the
//     log is complete, or that the batch did not die after the last line.
//   - That the run is today's. --max-age-hours reads this machine's clock and
//     the recorded mtime. A copy, a touch, an editor save or a sync client
//     refreshes mtime without a batch running.
//   - Anything at all about the part of the file that --tail-lines skipped.
//
// exit codes: 0 pass, 1 measured failure, 2 usage or unreadable input.

import { statSync } from "node:fs";
import {
  PASS_TOKEN,
  ok,
  fail,
  usage,
  parseArgs,
  requireInteger,
  readBuffer,
  decodeText,
  findMojibake,
} from "./lib/common.mjs";

const CHECKER = "check-batch-log";

const HELP = `usage: check-batch-log.mjs [options] <log-path>

Scan one batch log and report measured facts about it: encoding, line counts,
age, and how many lines each pattern matched. Korean batch systems commonly
write CP949, so the default decode is auto-detected and a garbled decode is a
failure rather than a silent scan of nonsense.

THE POSITIVE CONTROL RULE
  --forbid-pattern without --positive-control is a usage error. An absence
  proves nothing unless the checker can show it would have found something.
  The positive control is a pattern a healthy log always contains, for example
  a start banner. When it matches, this run has demonstrated that the file was
  found, decoded and searchable, which is what makes "no ERROR" a measurement.

options:
  --encoding utf8|cp949|auto   how to decode the bytes (default auto)
  --forbid-pattern REGEX       fail if any scanned line matches. Repeatable.
                               Requires at least one --positive-control.
  --require-pattern REGEX      fail unless at least one line matches, for
                               example a completion banner. Repeatable.
  --positive-control REGEX     must match at least one line. Its only job is
                               to prove the absence checks were real.
                               Repeatable.
  --ignore-pattern REGEX       lines matching are dropped BEFORE forbid
                               scanning, so a benign "0 errors" summary line
                               does not fail the gate. Ignored lines still
                               count toward --min-lines and are still eligible
                               for --positive-control and --require-pattern.
                               Repeatable.
  --regex-flags FLAGS          flags for every pattern (default i). Only
                               characters from imsu, no duplicates. g and y
                               are rejected because a global or sticky regex
                               carries lastIndex from line to line.
  --max-age-hours N            fail if the file mtime is older than N hours.
                               N may be a decimal, e.g. 0.5
  --min-lines N                fail if the file holds fewer non-empty lines.
                               A near-empty log is itself evidence the job
                               never ran.
  --tail-lines N               scan only the last N non-empty lines. This
                               WEAKENS forbid checks: an error printed earlier
                               in the file is never seen. --min-lines is still
                               measured against the whole file.
  -h, --help                   print this help

Stages are evaluated in this order and the first failing stage stops the run,
because a later result would be meaningless: file age, decode and mojibake,
minimum lines, positive controls, required patterns, forbidden patterns.

exit codes: 0 pass, 1 measured failure, 2 usage or unreadable input.

gate example (note the positive control, it is not optional):
  CHECK: node checks/check-batch-log.mjs --max-age-hours 12 --min-lines 20 --positive-control "BATCH START|배치 시작" --require-pattern "BATCH COMPLETED|정상 종료" --ignore-pattern "0 errors" --forbid-pattern "ERROR|FATAL|실패" logs/nightly.log
  EXPECT: ${PASS_TOKEN} ${CHECKER}`;

const SPEC = {
  values: ["--encoding", "--regex-flags", "--max-age-hours", "--min-lines", "--tail-lines"],
  repeatable: ["--forbid-pattern", "--require-pattern", "--positive-control", "--ignore-pattern"],
};

const { opts, positional } = parseArgs(CHECKER, process.argv.slice(2), SPEC, HELP);

if (positional.length === 0) usage(CHECKER, "needs exactly one log path, got none", HELP);
if (positional.length > 1) {
  usage(CHECKER, "needs exactly one log path, got " + positional.length + ": " + positional.join(" "), HELP);
}
const target = positional[0];

const forbidSources = opts["--forbid-pattern"];
const requireSources = opts["--require-pattern"];
const controlSources = opts["--positive-control"];
const ignoreSources = opts["--ignore-pattern"];

// The mechanical rule. This is checked before anything else is validated or
// read, because it is a defect in the gate itself and no amount of clean log
// would make the resulting pass mean anything.
if (forbidSources.length > 0 && controlSources.length === 0) {
  usage(
    CHECKER,
    "--forbid-pattern was given with no --positive-control. An absence proves nothing unless "
      + "you first show the checker could have found something: an empty log, a wrong path, a "
      + "mis-decoded file and a misspelled pattern all report 'no matches' exactly like a healthy "
      + "run does. Add --positive-control with a pattern a healthy log always contains, such as "
      + "the start banner, so this run demonstrates the file was read and is searchable.",
    HELP,
  );
}

// Every option is validated before the file is touched, so a typo in the gate
// surfaces as a usage error instead of hiding behind a read failure.
const rawFlags = "--regex-flags" in opts ? String(opts["--regex-flags"]) : "i";
if (!/^[imsu]*$/.test(rawFlags)) {
  usage(
    CHECKER,
    "--regex-flags may only contain characters from imsu, got " + JSON.stringify(rawFlags),
    HELP,
  );
}
if (new Set(rawFlags).size !== rawFlags.length) {
  usage(CHECKER, "--regex-flags has a duplicate character: " + JSON.stringify(rawFlags), HELP);
}
const regexFlags = rawFlags;

let maxAgeHours = null;
if ("--max-age-hours" in opts) {
  const raw = String(opts["--max-age-hours"]).trim();
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    usage(CHECKER, "--max-age-hours needs a positive finite number of hours, got " + opts["--max-age-hours"], HELP);
  }
  maxAgeHours = parsed;
}

const minLines = "--min-lines" in opts
  ? requireInteger(CHECKER, opts["--min-lines"], "--min-lines", HELP, { min: 1 })
  : null;
const tailLines = "--tail-lines" in opts
  ? requireInteger(CHECKER, opts["--tail-lines"], "--tail-lines", HELP, { min: 1 })
  : null;

function compile(sources, label) {
  return sources.map((source) => {
    let regex;
    try {
      regex = new RegExp(source, regexFlags);
    } catch (error) {
      usage(
        CHECKER,
        label + " is not a valid regex: " + JSON.stringify(source)
          + " (flags " + JSON.stringify(regexFlags) + "): " + (error && error.message ? error.message : error),
        HELP,
      );
    }
    return { source, regex };
  });
}

const forbids = compile(forbidSources, "--forbid-pattern");
const requires = compile(requireSources, "--require-pattern");
const controls = compile(controlSources, "--positive-control");
const ignores = compile(ignoreSources, "--ignore-pattern");

const CAP = 20;

// Failure lists are capped so a log with ten thousand ERROR lines still
// produces a diagnostic an operator can read, while the true count stays in
// the reason line.
function capped(items) {
  if (items.length <= CAP) return items;
  return items.slice(0, CAP).concat("... and " + (items.length - CAP) + " more");
}

// Bounded excerpt. A single log line can be a whole serialised payload, and a
// gate transcript is read by a person.
function excerpt(line) {
  const text = line.trim();
  return text.length <= 120 ? text : text.slice(0, 117) + "...";
}

function describe(source) {
  return "/" + source + "/" + regexFlags;
}

// Stage 0: open the file. Unreadable input is a usage error, not a measured
// failure: a gate cannot measure what it cannot open.
const buffer = readBuffer(CHECKER, target, HELP);
const stats = statSync(target);
const mtimeIso = stats.mtime.toISOString();
const ageHours = (Date.now() - stats.mtimeMs) / 3600000;
const shownAge = ageHours.toFixed(2);

// Stage 1: file age. Checked first because scanning yesterday's log carefully
// tells you about yesterday.
if (maxAgeHours !== null && ageHours > maxAgeHours) {
  fail(
    CHECKER,
    target + " is stale, so nothing scanned from it describes the current run",
    [
      "mtime " + mtimeIso + " is " + shownAge + "h old, above --max-age-hours " + maxAgeHours,
      "the batch may not have run, or it wrote to a different path",
    ],
  );
}

// Stage 2: decode, then mojibake. A garbled log cannot be scanned for Korean
// error words, and reporting a clean scan of nonsense is exactly the failure
// this library exists to prevent.
const decoded = decodeText(CHECKER, buffer, opts["--encoding"] || "auto", HELP);
const encodingLabel = decoded.encoding
  + (("--encoding" in opts) ? " (declared)" : " (auto-detected)")
  + (decoded.bom ? ", utf8 BOM" : "");

const mojibake = findMojibake(decoded.text);
if (mojibake) {
  fail(
    CHECKER,
    target + " decoded as " + decoded.encoding + " but the text is garbled, so no pattern result from it can be believed",
    [
      "evidence: " + mojibake,
      "a Korean error word cannot match garbled text, so an absence result here would be meaningless",
      "re-run with --encoding cp949 or --encoding utf8 to state the encoding explicitly",
    ],
  );
}

const allLines = decoded.text.split(/\r\n|\r|\n/);
// Line numbers stay 1-based against the ORIGINAL file, so a reported number is
// the number an operator sees in their editor.
const nonEmpty = [];
for (let i = 0; i < allLines.length; i += 1) {
  if (/\S/.test(allLines[i])) nonEmpty.push({ number: i + 1, text: allLines[i] });
}

// Stage 3: minimum lines. Measured against the whole file, not the tail
// window, because "the log is nearly empty" is a fact about the log.
if (minLines !== null && nonEmpty.length < minLines) {
  fail(
    CHECKER,
    target + " holds only " + nonEmpty.length + " non-empty line(s), below --min-lines " + minLines,
    [
      "file has " + allLines.length + " line(s) total, encoding " + encodingLabel,
      "a near-empty log is evidence the job did not run, not evidence that it ran cleanly",
    ],
  );
}

// The scan window. Everything from here on looks at these lines only.
const scanned = tailLines !== null ? nonEmpty.slice(-tailLines) : nonEmpty;
const windowNote = tailLines !== null
  ? "scanned last " + scanned.length + " of " + nonEmpty.length + " non-empty line(s) (--tail-lines " + tailLines + ")"
  : "scanned " + scanned.length + " non-empty line(s)";

function countMatches(regex) {
  let hits = 0;
  // One line per match call. The bounded input is the mitigation against a
  // pathological pattern running away over the whole file.
  for (const line of scanned) if (regex.test(line.text)) hits += 1;
  return hits;
}

// Stage 4: positive controls. This is the stage that gives every later
// absence result its meaning, so it runs before the absence checks and its
// failure says so in plain words.
const controlCounts = [];
const controlMisses = [];
for (const pattern of controls) {
  const hits = countMatches(pattern.regex);
  controlCounts.push(describe(pattern.source) + " matched " + hits + " line(s)");
  if (hits === 0) controlMisses.push("positive control " + describe(pattern.source) + " matched 0 of " + scanned.length + " scanned line(s)");
}
if (controlMisses.length) {
  fail(
    CHECKER,
    target + ": a positive control did not match, so this run cannot show it would have found anything"
      + (forbids.length ? " and the --forbid-pattern result is NOT trustworthy" : ""),
    capped(controlMisses).concat([
      "encoding " + encodingLabel + ", " + windowNote,
      "an absence is only evidence when the checker has demonstrated it can find text in this file",
      "suspect the path, the encoding, --tail-lines, or the control pattern itself before trusting any clean result above",
    ]),
  );
}

// Stage 5: required patterns. The positive form, for example a completion
// banner.
const requireCounts = [];
const requireMisses = [];
for (const pattern of requires) {
  const hits = countMatches(pattern.regex);
  requireCounts.push(describe(pattern.source) + " matched " + hits + " line(s)");
  if (hits === 0) requireMisses.push("required pattern " + describe(pattern.source) + " matched 0 of " + scanned.length + " scanned line(s)");
}
if (requireMisses.length) {
  fail(
    CHECKER,
    target + ": " + requireMisses.length + " of " + requires.length + " required pattern(s) never matched",
    capped(requireMisses).concat(["encoding " + encodingLabel + ", " + windowNote]),
  );
}

// Stage 6: forbidden patterns, over the scan window minus ignored lines.
// Ignored lines were already counted for --min-lines and were eligible for the
// controls and the required patterns above, so dropping them here narrows the
// absence check without weakening the proof that the file was really read.
const forbidTargets = [];
let ignoredCount = 0;
for (const line of scanned) {
  let skip = false;
  for (const pattern of ignores) {
    if (pattern.regex.test(line.text)) { skip = true; break; }
  }
  if (skip) ignoredCount += 1;
  else forbidTargets.push(line);
}

const forbidCounts = [];
const forbidHits = [];
for (const pattern of forbids) {
  let hits = 0;
  for (const line of forbidTargets) {
    if (pattern.regex.test(line.text)) {
      hits += 1;
      forbidHits.push("line " + line.number + " " + describe(pattern.source) + ": " + excerpt(line.text));
    }
  }
  forbidCounts.push(describe(pattern.source) + " matched " + hits + " line(s)");
}
if (forbidHits.length) {
  fail(
    CHECKER,
    target + ": " + forbidHits.length + " line(s) matched a forbidden pattern",
    capped(forbidHits).concat([
      "encoding " + encodingLabel + ", " + windowNote + ", " + ignoredCount + " line(s) ignored",
      "positive controls passed, so these matches are real findings and not a scanning artefact",
    ]),
  );
}

// Summary reports what was measured, not what was requested.
const parts = [
  "encoding " + encodingLabel,
  allLines.length + " line(s), " + nonEmpty.length + " non-empty",
  windowNote,
  "mtime " + mtimeIso + " (" + shownAge + "h old)",
];
if (ignores.length) parts.push(ignoredCount + " line(s) ignored by " + ignores.length + " ignore pattern(s)");
if (controlCounts.length) parts.push("positive control " + controlCounts.join(" + "));
if (requireCounts.length) parts.push("required " + requireCounts.join(" + "));
if (forbidCounts.length) parts.push("forbidden " + forbidCounts.join(" + "));
else parts.push("no forbid patterns requested, so this run asserts nothing about absence");

ok(CHECKER, target + ": " + parts.join(", "));
