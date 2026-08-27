#!/usr/bin/env node
// check-csv.mjs : make a delivered CSV prove its own totals.
// Zero dependencies. Node 16+.
//
// Why this exists. Reconciliation (대사) is the work this library was built for:
// somebody exports a file, eyeballs a total, and reports "맞습니다". The eyeball
// is the weak link. It cannot see a row that lost its amount, a duplicated trade
// id, a CP949 export that decoded into garbage, or a total that is off by one
// cell. This checker re-measures those properties from the bytes on disk and
// exits non-zero when the file does not hold up, so a gate cannot be met by
// confidence alone.
//
// The reconciliation design point, and it is the whole reason to prefer one
// option over the other:
//
//   --sum-equals VALUE copies a number the caller already believed into the
//   assertion. It proves the file agrees with the caller. If the caller read
//   the number off this same file, the gate proves nothing at all: it is the
//   file agreeing with itself.
//
//   --reconcile-with PATH measures BOTH sides independently, from two files
//   neither of which supplied the expected figure, and requires them to agree.
//   That is a real 대사 and it is the form to use. This mirrors the repository
//   rule for authoring gates: a figure in an assertion must be measured, not
//   copied from the thing being checked.
//
// What this checker CANNOT prove:
//   - That the numbers are right. Two files can agree and both be wrong,
//     because they were generated from the same broken upstream query.
//   - That these are the right files, or today's files. It checks the paths it
//     was given, not their provenance, freshness, or authorisation.
//   - That rows correspond one to one. Totals are compared, not matched line by
//     line, so an offsetting pair of errors cancels out and passes.
//   - Any business rule not named on the command line. An unlisted column is
//     never inspected, so a check that names nothing measures almost nothing.
//   - Anything about column meaning under --no-header, where columns are only
//     positions.
//
// A file that decodes into mojibake is failed rather than checked. A garbled
// file may still parse and still add up, and passing it silently is the exact
// failure this library exists to prevent.
//
// A malformed file (an unterminated quoted field) is reported as a measured
// failure, not a usage error: the invocation was fine, the delivered work
// product is not.
//
// exit codes: 0 pass, 1 measured failure, 2 usage or unreadable input.

import {
  parseArgs,
  usage,
  fail,
  ok,
  readBuffer,
  decodeText,
  findMojibake,
  parseNumber,
  requireInteger,
  pluralRows,
} from "./lib/common.mjs";

const CHECKER = "check-csv";

const HELP = `usage: check-csv.mjs [options] <file.csv>

Re-measure a CSV: row counts, required columns, empty cells, duplicate keys,
and column totals. Reconcile a total against a second file.

options:
  --encoding utf8|cp949|auto   how to decode the bytes (default auto)
  --delimiter CHAR             field separator, or the words tab or semicolon
                               (default ",")
  --no-header                  every record is data; name columns by 1-based
                               position instead of by name
  --require-columns a,b,c      header must contain these columns (repeatable)
  --min-rows N                 at least N data rows (header excluded)
  --max-rows N                 at most N data rows
  --exact-rows N               exactly N data rows
  --no-empty-cells COLUMN      no blank value in COLUMN (repeatable)
  --unique-column COLUMN       no duplicate value in COLUMN (repeatable)
  --sum-column COLUMN          column to total
  --sum-equals VALUE           total must equal VALUE (within --tolerance)
  --reconcile-with PATH        total must equal the total of a second CSV
  --reconcile-column COLUMN    column to total in that second CSV
                               (default: same name as --sum-column)
  --reconcile-rows             also require both files to have the same row count
  --tolerance N                absolute tolerance for totals (default 0.001)
  --empty-as-zero              count a blank cell in the summed column as 0
                               (without this, a blank is a failure)
  -h, --help                   print this help

Numbers are read the way exported ledgers write them: 1,234.56 and (123) for a
negative and a leading currency symbol are all accepted. A cell that is not a
number is reported as a failure with its row number, never skipped.

Reported row numbers are CSV record numbers as they appear in the file, so the
header is row 1 unless --no-header is given. Fully blank lines are ignored and
do not consume a row number.

Which comparison to use:
  --sum-equals copies a figure you already believed into the assertion, so it
  only proves the file agrees with you. Use it for a total that came from an
  independent source, such as a counterparty statement.
  --reconcile-with measures both sides from the files themselves and is the
  stronger form. Prefer it for real reconciliation.

exit codes: 0 pass, 1 measured failure, 2 usage or unreadable input.

gate example:
  CHECK: node checks/check-csv.mjs out/settlement.csv --require-columns trade_id,amount --unique-column trade_id --no-empty-cells amount --min-rows 1 --sum-column amount --reconcile-with out/ledger.csv
  EXPECT: UNLAZY-CHECK-OK check-csv`;

const SPEC = {
  flags: ["--no-header", "--reconcile-rows", "--empty-as-zero"],
  values: [
    "--encoding",
    "--delimiter",
    "--min-rows",
    "--max-rows",
    "--exact-rows",
    "--sum-column",
    "--sum-equals",
    "--tolerance",
    "--reconcile-with",
    "--reconcile-column",
  ],
  repeatable: ["--require-columns", "--no-empty-cells", "--unique-column"],
};

const REPORT_CAP = 20;

// ---------------------------------------------------------------- parsing ---

// RFC 4180 by hand, because a dependency is not allowed and the edge cases are
// exactly the ones that hide reconciliation errors: an amount containing the
// delimiter, an address containing a newline, a doubled quote inside a name.
function parseCsv(text, delimiter) {
  const records = [];
  let cells = [];
  let field = "";
  let fieldStarted = false;
  let inQuotes = false;
  let quoteStart = 0;
  let recordNo = 1;
  let started = false;

  const endField = () => {
    cells.push(field);
    field = "";
    fieldStarted = false;
    started = true;
  };
  const endRecord = () => {
    endField();
    records.push({ no: recordNo, cells });
    recordNo += 1;
    cells = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; continue; }
        inQuotes = false;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      quoteStart = recordNo;
      continue;
    }
    if (ch === delimiter) { endField(); continue; }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      endRecord();
      continue;
    }
    if (ch === "\n") { endRecord(); continue; }
    field += ch;
    fieldStarted = true;
  }

  if (inQuotes) {
    return { records: [], error: "unterminated quoted field starting at row " + quoteStart };
  }
  // A trailing newline must not manufacture a phantom record.
  if (started || fieldStarted || field !== "" || cells.length > 0) endRecord();

  // Fully blank lines carry no data anywhere in the file. Dropping them keeps
  // row counts honest while the retained record numbers still point at the
  // real line the reader will open in Excel.
  const kept = records.filter((r) => !(r.cells.length === 1 && r.cells[0] === ""));
  return { records: kept, error: null };
}

function stripBom(value) {
  return String(value).replace(/^[﻿￾]+/, "");
}

function cellAt(record, index) {
  return index < record.cells.length ? record.cells[index] : "";
}

function isBlank(value) {
  return String(value).trim() === "";
}

function capList(items) {
  if (items.length <= REPORT_CAP) return items.map(String);
  return items
    .slice(0, REPORT_CAP)
    .map(String)
    .concat(["... and " + (items.length - REPORT_CAP) + " more"]);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

// ------------------------------------------------------------- validation ---

const { opts, positional } = parseArgs(CHECKER, process.argv.slice(2), SPEC, HELP);

if (positional.length === 0) usage(CHECKER, "need exactly one CSV path", HELP);
if (positional.length > 1) {
  usage(CHECKER, "need exactly one CSV path, got " + positional.length + ": " + positional.join(" "), HELP);
}
const csvPath = positional[0];

const noHeader = opts["--no-header"] === true;
const hasSumColumn = typeof opts["--sum-column"] === "string";
const hasSumEquals = typeof opts["--sum-equals"] === "string";
const hasReconcile = typeof opts["--reconcile-with"] === "string";

if (hasSumEquals && hasReconcile) {
  usage(CHECKER, "--sum-equals and --reconcile-with are two different comparisons; give only one", HELP);
}
if (hasSumEquals && !hasSumColumn) usage(CHECKER, "--sum-equals needs --sum-column", HELP);
if (hasReconcile && !hasSumColumn) usage(CHECKER, "--reconcile-with needs --sum-column", HELP);
if (typeof opts["--reconcile-column"] === "string" && !hasReconcile) {
  usage(CHECKER, "--reconcile-column needs --reconcile-with", HELP);
}
if (opts["--reconcile-rows"] === true && !hasReconcile) {
  usage(CHECKER, "--reconcile-rows needs --reconcile-with", HELP);
}
if (typeof opts["--exact-rows"] === "string" && typeof opts["--min-rows"] === "string") {
  usage(CHECKER, "--exact-rows already fixes the count; drop --min-rows", HELP);
}
if (typeof opts["--exact-rows"] === "string" && typeof opts["--max-rows"] === "string") {
  usage(CHECKER, "--exact-rows already fixes the count; drop --max-rows", HELP);
}

const requiredColumns = [];
for (const group of opts["--require-columns"]) {
  for (const name of String(group).split(",")) {
    const trimmed = name.trim();
    if (trimmed) requiredColumns.push(trimmed);
  }
}
if (requiredColumns.length && noHeader) {
  usage(CHECKER, "--require-columns needs a header row, so it cannot be used with --no-header", HELP);
}

let delimiter = opts["--delimiter"] === undefined ? "," : String(opts["--delimiter"]);
if (delimiter === "tab") delimiter = "\t";
else if (delimiter === "semicolon") delimiter = ";";
if (delimiter.length !== 1) {
  usage(CHECKER, "--delimiter needs exactly one character, or the word tab or semicolon, got " + JSON.stringify(delimiter), HELP);
}
if (delimiter === '"' || delimiter === "\r" || delimiter === "\n") {
  usage(CHECKER, "--delimiter cannot be a quote or a line break", HELP);
}

let tolerance = 0.001;
if (opts["--tolerance"] !== undefined) {
  const parsed = parseNumber(opts["--tolerance"]);
  if (parsed === null || parsed < 0) {
    usage(CHECKER, "--tolerance needs a non-negative decimal, got " + opts["--tolerance"], HELP);
  }
  tolerance = parsed;
}

let expectedSum = null;
if (hasSumEquals) {
  expectedSum = parseNumber(opts["--sum-equals"]);
  if (expectedSum === null) {
    usage(CHECKER, "--sum-equals needs a number, got " + opts["--sum-equals"], HELP);
  }
}

const minRows = opts["--min-rows"] === undefined ? null : requireInteger(CHECKER, opts["--min-rows"], "--min-rows", HELP, { min: 0 });
const maxRows = opts["--max-rows"] === undefined ? null : requireInteger(CHECKER, opts["--max-rows"], "--max-rows", HELP, { min: 0 });
const exactRows = opts["--exact-rows"] === undefined ? null : requireInteger(CHECKER, opts["--exact-rows"], "--exact-rows", HELP, { min: 0 });
if (minRows !== null && maxRows !== null && minRows > maxRows) {
  usage(CHECKER, "--min-rows " + minRows + " is greater than --max-rows " + maxRows + ", no file can satisfy both", HELP);
}

const encodingOption = opts["--encoding"] || "auto";

// -------------------------------------------------------------- load file ---

function loadCsv(path, label) {
  const buffer = readBuffer(CHECKER, path, HELP);
  const decoded = decodeText(CHECKER, buffer, encodingOption, HELP);
  const garbled = findMojibake(decoded.text);
  if (garbled) {
    fail(CHECKER, "decoded text is garbled, so " + label + " cannot be reconciled", [
      path,
      "reason: " + garbled,
      "decoded as: " + decoded.encoding + (decoded.bom ? " (with BOM)" : ""),
      "re-run with --encoding utf8 or --encoding cp949 if the wrong one was guessed",
      "if both look wrong, the export itself is damaged and must be produced again",
    ]);
  }
  const parsed = parseCsv(decoded.text, delimiter);
  if (parsed.error) {
    fail(CHECKER, label + " is not well-formed", [path, parsed.error]);
  }
  if (parsed.records.length === 0) {
    fail(CHECKER, label + " contains no CSV records", [path, "decoded as " + decoded.encoding + ", 0 bytes of data after blank lines were dropped"]);
  }

  let header = null;
  let dataRecords = parsed.records;
  if (!noHeader) {
    header = parsed.records[0].cells.map((cell, i) => (i === 0 ? stripBom(cell) : cell).trim());
    dataRecords = parsed.records.slice(1);
  }

  let width = header ? header.length : 0;
  for (const record of parsed.records) width = Math.max(width, record.cells.length);

  return { path, label, header, dataRecords, width, encoding: decoded.encoding, bom: decoded.bom };
}

// Resolve a column reference against a file. A name wins; an all-digit
// reference falls back to a 1-based position, which is the only way to name a
// column under --no-header.
function resolveColumn(file, reference) {
  const key = String(reference).trim();
  if (file.header) {
    const matches = [];
    file.header.forEach((name, index) => { if (name === key) matches.push(index); });
    if (matches.length > 1) {
      return { index: -1, error: "column " + JSON.stringify(key) + " appears " + matches.length + " times in the header of " + file.path + ", so which one to measure is ambiguous" };
    }
    if (matches.length === 1) return { index: matches[0], error: null };
  }
  if (/^\d+$/.test(key)) {
    const index = Number.parseInt(key, 10) - 1;
    if (index >= 0 && index < file.width) return { index, error: null };
    return { index: -1, error: "column position " + key + " is out of range in " + file.path + ", which has " + file.width + " columns" };
  }
  if (file.header) {
    return { index: -1, error: "column " + JSON.stringify(key) + " is not in the header of " + file.path + "; header is: " + file.header.join(", ") };
  }
  return { index: -1, error: "with --no-header a column must be a 1-based position, got " + JSON.stringify(key) };
}

// Kahan summation: a settlement file with many cents-level rows drifts under
// naive float addition, and drift inside a 0.001 tolerance is indistinguishable
// from a real break.
function sumColumn(file, index, emptyAsZero) {
  let total = 0;
  let compensation = 0;
  let counted = 0;
  const notNumbers = [];
  const empties = [];
  for (const record of file.dataRecords) {
    const raw = cellAt(record, index);
    if (isBlank(raw)) {
      if (!emptyAsZero) empties.push("row " + record.no);
      else counted += 1;
      continue;
    }
    const value = parseNumber(raw);
    if (value === null) {
      notNumbers.push("row " + record.no + ": " + JSON.stringify(String(raw).trim()));
      continue;
    }
    const y = value - compensation;
    const t = total + y;
    compensation = t - total - y;
    total = t;
    counted += 1;
  }
  return { total, counted, notNumbers, empties };
}

// --------------------------------------------------------------- measuring --

const problems = [];
const addProblem = (reason, details = []) => problems.push({ reason, details });

const main = loadCsv(csvPath, "the CSV");
const rowCount = main.dataRecords.length;
const emptyAsZero = opts["--empty-as-zero"] === true;

// required columns: report every missing one, not the first.
if (requiredColumns.length) {
  const present = new Set(main.header);
  const missing = requiredColumns.filter((name) => !present.has(name));
  if (missing.length) {
    addProblem(missing.length + " required column(s) missing from the header of " + main.path, [
      "missing: " + missing.join(", "),
      "header:  " + main.header.join(", "),
    ]);
  }
}

// row counts
if (exactRows !== null && rowCount !== exactRows) {
  addProblem("expected exactly " + pluralRows(exactRows) + " of data, measured " + pluralRows(rowCount), [main.path]);
}
if (minRows !== null && rowCount < minRows) {
  addProblem("expected at least " + pluralRows(minRows) + " of data, measured " + pluralRows(rowCount), [main.path]);
}
if (maxRows !== null && rowCount > maxRows) {
  addProblem("expected at most " + pluralRows(maxRows) + " of data, measured " + pluralRows(rowCount), [main.path]);
}

// empty cells
for (const reference of opts["--no-empty-cells"]) {
  const resolved = resolveColumn(main, reference);
  if (resolved.error) { addProblem("--no-empty-cells " + reference + ": " + resolved.error); continue; }
  const offenders = [];
  for (const record of main.dataRecords) {
    if (isBlank(cellAt(record, resolved.index))) offenders.push("row " + record.no);
  }
  if (offenders.length) {
    addProblem(
      offenders.length + " of " + pluralRows(rowCount) + " have an empty " + JSON.stringify(String(reference).trim()) + " in " + main.path,
      capList(offenders),
    );
  }
}

// duplicates
for (const reference of opts["--unique-column"]) {
  const resolved = resolveColumn(main, reference);
  if (resolved.error) { addProblem("--unique-column " + reference + ": " + resolved.error); continue; }
  const seen = new Map();
  for (const record of main.dataRecords) {
    const value = String(cellAt(record, resolved.index)).trim();
    if (!seen.has(value)) seen.set(value, []);
    seen.get(value).push(record.no);
  }
  const duplicated = [];
  for (const [value, rowNumbers] of seen) {
    if (rowNumbers.length > 1) {
      duplicated.push(JSON.stringify(value) + " on rows " + rowNumbers.join(", "));
    }
  }
  if (duplicated.length) {
    addProblem(
      duplicated.length + " duplicated value(s) in " + JSON.stringify(String(reference).trim()) + " in " + main.path,
      capList(duplicated),
    );
  }
}

// totals
let sumIndex = -1;
let sumResult = null;
if (hasSumColumn) {
  const resolved = resolveColumn(main, opts["--sum-column"]);
  if (resolved.error) {
    addProblem("--sum-column " + opts["--sum-column"] + ": " + resolved.error);
  } else {
    sumIndex = resolved.index;
    sumResult = sumColumn(main, sumIndex, emptyAsZero);
    if (sumResult.notNumbers.length) {
      addProblem(
        sumResult.notNumbers.length + " cell(s) in " + JSON.stringify(String(opts["--sum-column"]).trim()) + " are not numbers in " + main.path,
        capList(sumResult.notNumbers),
      );
    }
    if (sumResult.empties.length) {
      addProblem(
        sumResult.empties.length + " cell(s) in " + JSON.stringify(String(opts["--sum-column"]).trim()) + " are empty in " + main.path,
        capList(sumResult.empties).concat(["pass --empty-as-zero if an empty amount really means zero"]),
      );
    }
  }
}

let sumEqualsDiff = null;
if (hasSumEquals && sumResult) {
  sumEqualsDiff = Math.abs(sumResult.total - expectedSum);
  if (!(sumEqualsDiff <= tolerance)) {
    addProblem("total does not match --sum-equals", [
      "measured: " + formatNumber(sumResult.total) + " from " + main.path,
      "expected: " + formatNumber(expectedSum),
      "difference " + formatNumber(sumEqualsDiff) + " exceeds tolerance " + formatNumber(tolerance),
    ]);
  }
}

// reconciliation
let other = null;
let otherSum = null;
let otherReference = null;
let reconcileDiff = null;
if (hasReconcile && hasSumColumn) {
  other = loadCsv(opts["--reconcile-with"], "the reconciliation CSV");
  otherReference = opts["--reconcile-column"] === undefined ? opts["--sum-column"] : opts["--reconcile-column"];
  const resolved = resolveColumn(other, otherReference);
  if (resolved.error) {
    addProblem("--reconcile-column " + otherReference + ": " + resolved.error);
  } else {
    otherSum = sumColumn(other, resolved.index, emptyAsZero);
    if (otherSum.notNumbers.length) {
      addProblem(
        otherSum.notNumbers.length + " cell(s) in " + JSON.stringify(String(otherReference).trim()) + " are not numbers in " + other.path,
        capList(otherSum.notNumbers),
      );
    }
    if (otherSum.empties.length) {
      addProblem(
        otherSum.empties.length + " cell(s) in " + JSON.stringify(String(otherReference).trim()) + " are empty in " + other.path,
        capList(otherSum.empties).concat(["pass --empty-as-zero if an empty amount really means zero"]),
      );
    }
    if (sumResult) {
      reconcileDiff = Math.abs(sumResult.total - otherSum.total);
      if (!(reconcileDiff <= tolerance)) {
        addProblem("the two files do not reconcile", [
          main.path + " " + JSON.stringify(String(opts["--sum-column"]).trim()) + " = " + formatNumber(sumResult.total) + " over " + pluralRows(rowCount),
          other.path + " " + JSON.stringify(String(otherReference).trim()) + " = " + formatNumber(otherSum.total) + " over " + pluralRows(other.dataRecords.length),
          "difference " + formatNumber(reconcileDiff) + " exceeds tolerance " + formatNumber(tolerance),
        ]);
      }
    }
  }
  if (opts["--reconcile-rows"] === true && rowCount !== other.dataRecords.length) {
    addProblem("row counts do not match", [
      main.path + ": " + pluralRows(rowCount),
      other.path + ": " + pluralRows(other.dataRecords.length),
      "difference: " + Math.abs(rowCount - other.dataRecords.length),
    ]);
  }
}

// ---------------------------------------------------------------- verdict ---

if (problems.length === 1) {
  fail(CHECKER, problems[0].reason, problems[0].details);
}
if (problems.length > 1) {
  const details = [];
  for (const problem of problems) {
    details.push(problem.reason);
    for (const line of problem.details) details.push("  " + line);
  }
  fail(CHECKER, problems.length + " checks failed on " + csvPath, details);
}

const parts = [];
parts.push(csvPath + ": " + pluralRows(rowCount) + " of data");
parts.push("encoding " + main.encoding + (main.bom ? " with BOM" : ""));
parts.push("delimiter " + JSON.stringify(delimiter));
parts.push((main.header ? main.header.length + " header columns" : main.width + " columns, no header"));
if (requiredColumns.length) parts.push("required columns present: " + requiredColumns.join(", "));
for (const reference of opts["--no-empty-cells"]) {
  parts.push("no empty " + String(reference).trim() + " in " + pluralRows(rowCount));
}
for (const reference of opts["--unique-column"]) {
  parts.push(String(reference).trim() + " unique across " + pluralRows(rowCount));
}
if (sumResult) {
  parts.push("sum(" + String(opts["--sum-column"]).trim() + ") = " + formatNumber(sumResult.total) + " over " + sumResult.counted + " counted cells");
}
if (hasSumEquals && sumEqualsDiff !== null) {
  parts.push("matches supplied " + formatNumber(expectedSum) + " (diff " + formatNumber(sumEqualsDiff) + " <= tolerance " + formatNumber(tolerance) + ")");
}
if (otherSum && reconcileDiff !== null) {
  parts.push(
    "reconciles with " + other.path + " sum(" + String(otherReference).trim() + ") = " + formatNumber(otherSum.total) +
    " over " + pluralRows(other.dataRecords.length) +
    " (diff " + formatNumber(reconcileDiff) + " <= tolerance " + formatNumber(tolerance) + ")",
  );
}
if (opts["--reconcile-rows"] === true && other) {
  parts.push("row counts equal at " + rowCount);
}

ok(CHECKER, parts.join("; "));
