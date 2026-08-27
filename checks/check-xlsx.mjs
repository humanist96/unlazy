#!/usr/bin/env node
// check-xlsx.mjs : prove an Excel workbook holds the sheets, the values and the
// data depth it is supposed to, and that no cell carries an Excel error.
// Zero dependencies. Node 16+.
//
// A broken spreadsheet does not announce itself. It opens, it prints, it looks
// finished, and somewhere on the fourth sheet a column of #REF! sits where a
// deleted row used to be, or a ratio reads #DIV/0! because a denominator came
// back empty this month. Nobody scrolled there. A gate whose CHECK only proves
// the .xlsx exists, or that Excel opened it, passes every one of those files.
// This checker reads the cells instead, so the gate measures the numbers the
// reader will actually see.
//
// What this checker CANNOT prove:
//   - That the formulas are right. It reads the STORED value Excel last wrote
//     into the file. A workbook whose formulas were never recalculated (built
//     by a script, edited with calculation set to manual, or saved by a tool
//     that writes formulas without results) reports yesterday's values, or an
//     empty string where a formula has no cached result at all. The formula
//     text is never evaluated and never checked for correctness.
//   - That a number means what it looks like. Cells hold raw stored values, not
//     the formatted display: a date is a serial number such as 45292, a percent
//     cell is 0.15 and not "15%", and a value rounded to two places on screen
//     is stored in full. Compare against the stored form.
//   - That the workbook is the right workbook. Correct sheet names and a
//     matching cell prove structure and one value, never that the source data,
//     the period, or the business logic behind them was correct.
//   - Anything about charts, pivot tables, conditional formatting, macros,
//     defined names, data validation, or hidden and very-hidden sheets beyond
//     their cells. A pivot table stale by one refresh looks identical here.
//   - Anything about a cell it did not scan. --sheet narrows the scan on
//     purpose, and what is outside the scan is simply unmeasured.
//
// exit codes: 0 pass, 1 measured failure, 2 usage or unreadable input.

import { PASS_TOKEN, ok, fail, usage, parseArgs, requireInteger, readBuffer, parseNumber } from "./lib/common.mjs";
import { ZipError, openZip, hasEntry, readEntryText } from "./lib/zip.mjs";
import { xlsxSheetMap, xlsxSharedStrings, xlsxCells, cellRow } from "./lib/xml.mjs";

const CHECKER = "check-xlsx";

const HELP = `usage: check-xlsx.mjs [options] <workbook.xlsx>

Open an .xlsx (or .xlsm) workbook without Excel and measure it: how many sheets
it has, which sheets are present, what individual cells hold, how far the data
reaches, and whether any cell carries an Excel error value such as #REF! or
#DIV/0!. With no assertion options this still measures something real, and
reports the sheet names, the row counts and the cell counts it found.

options:
  --no-error-cells      fail if any scanned cell is an Excel error value
                        (#REF!, #DIV/0!, #N/A, #VALUE!, #NAME?, #NULL!, #NUM!)
  --no-placeholders     fail if any scanned cell holds leftover placeholder
                        text: TODO, TBD, FIXME or XXX as a standalone token, or
                        the Korean placeholders 여기에, 입력 요망, 기재 요망,
                        OOO, ○○○
  --require-sheet NAME  repeatable. fail if the named sheet is absent
  --forbid-sheet NAME   repeatable. fail if the named sheet is present, e.g. to
                        prove a scratch sheet was removed before delivery
  --cell REF=VALUE      repeatable. fail unless the cell equals VALUE. REF is
                        Sheet!A1, or plain A1 for the first sheet. A missing or
                        blank cell fails as "empty or absent"
  --min-rows SHEET:N    repeatable. fail unless the highest row of the sheet
                        holding at least one non-empty cell is N or greater.
                        Written as :N the check applies to the first sheet
  --sheet NAME          repeatable. restrict --no-error-cells, --no-placeholders
                        and the reported counts to these sheets. Reading every
                        sheet is the default, so this is how a large workbook is
                        bounded to the sheets that matter
  --min-sheets N        fail if the workbook has fewer than N sheets
  --exact-sheets N      fail unless the workbook has exactly N sheets
  -h, --help            print this help

notes:
  Sheet names are compared after trimming. An exact, case-sensitive match wins.
  A match differing only in case is also accepted, because Excel looks sheet
  names up case-insensitively while preserving the case you typed, and any such
  match is reported in the summary so the difference is visible.
  Excel forbids ! in a sheet name, so --cell splits its reference on the FIRST
  ! and takes everything before it as the sheet name. REF=VALUE splits on the
  LAST =, so the expected value may itself contain =.
  Sheet names in --cell and --min-rows may contain spaces and Korean text; quote
  them for the shell. Excel also forbids : in a sheet name, which is what lets
  --min-rows use it as the separator.
  Values are compared as trimmed text, except when both the expectation and the
  stored cell parse as numbers, which are compared numerically with a 1e-9
  relative tolerance, so 1000 matches 1000.0 and 1,000.
  A sheet named by any option but absent from the workbook is a MEASURED
  failure, not a usage error, because the workbook is the thing under test.
  An unreadable file is a usage error instead. Note that .xls, the old binary
  format, is not a ZIP and is not supported here: re-save it as .xlsx.

All failing checks are reported together, not just the first one. Each list of
findings is capped at 20 items followed by a count of the rest.

exit codes: 0 pass, 1 measured failure, 2 usage or unreadable input.

gate example:
  CHECK: node checks/check-xlsx.mjs --no-error-cells --no-placeholders --require-sheet "요약" --min-rows "명세:20" out/report.xlsx
  EXPECT: ${PASS_TOKEN} ${CHECKER}`;

const SPEC = {
  flags: ["--no-error-cells", "--no-placeholders"],
  values: ["--min-sheets", "--exact-sheets"],
  repeatable: ["--require-sheet", "--forbid-sheet", "--cell", "--min-rows", "--sheet"],
};

const MAX_REPORTED = 20;
const EXCERPT_LIMIT = 60;
const NAMES_IN_SUMMARY = 8;

// Standalone tokens only: a part number like "XXXA-12" or a column headed
// "TBDR" is not a placeholder, and flagging it would teach users to ignore
// this check. The Korean forms are matched as substrings because they appear
// inside a sentence ("여기에 금액을 기재"), with flexible spacing because the
// same phrase is typed both with and without a space.
const PLACEHOLDER_PATTERNS = [
  { label: "TODO", re: /(^|[^0-9A-Za-z])TODO([^0-9A-Za-z]|$)/i },
  { label: "TBD", re: /(^|[^0-9A-Za-z])TBD([^0-9A-Za-z]|$)/i },
  { label: "FIXME", re: /(^|[^0-9A-Za-z])FIXME([^0-9A-Za-z]|$)/i },
  { label: "XXX", re: /(^|[^0-9A-Za-z])XXX([^0-9A-Za-z]|$)/i },
  { label: "여기에", re: /여기에/ },
  { label: "입력 요망", re: /입력\s*요망/ },
  { label: "기재 요망", re: /기재\s*요망/ },
  { label: "OOO", re: /(^|[^0-9A-Za-z])OOO/i },
  { label: "○○○", re: /○○○/ },
];

const { opts, positional } = parseArgs(CHECKER, process.argv.slice(2), SPEC, HELP);

if (positional.length === 0) usage(CHECKER, "needs exactly one workbook path, got none", HELP);
if (positional.length > 1) {
  usage(CHECKER, "needs exactly one workbook path, got " + positional.length + ": " + positional.join(" "), HELP);
}
const target = positional[0];

if (/\.xls$/i.test(target)) {
  usage(CHECKER, ".xls is the old binary format, not a ZIP of XML, and cannot be read here: re-save " + target + " as .xlsx", HELP);
}

// Every option is validated before the workbook is opened, so a typo in the
// gate reports as a usage error rather than hiding behind a parse failure.
const minSheets = "--min-sheets" in opts
  ? requireInteger(CHECKER, opts["--min-sheets"], "--min-sheets", HELP, { min: 0 })
  : null;
const exactSheets = "--exact-sheets" in opts
  ? requireInteger(CHECKER, opts["--exact-sheets"], "--exact-sheets", HELP, { min: 0 })
  : null;
if (minSheets !== null && exactSheets !== null && minSheets > exactSheets) {
  usage(CHECKER, "--min-sheets " + minSheets + " is above --exact-sheets " + exactSheets + ", no workbook could pass", HELP);
}

const requiredSheets = opts["--require-sheet"].map((name) => String(name).trim());
for (const name of requiredSheets) {
  if (!name) usage(CHECKER, "--require-sheet needs a sheet name, got an empty value", HELP);
}
const forbiddenSheets = opts["--forbid-sheet"].map((name) => String(name).trim());
for (const name of forbiddenSheets) {
  if (!name) usage(CHECKER, "--forbid-sheet needs a sheet name, got an empty value", HELP);
}
const scanRequests = opts["--sheet"].map((name) => String(name).trim());
for (const name of scanRequests) {
  if (!name) usage(CHECKER, "--sheet needs a sheet name, got an empty value", HELP);
}

// REF=VALUE splits on the LAST =, so the expected value may contain one.
// Sheet!A1 splits on the FIRST !, which Excel forbids inside a sheet name.
const cellChecks = opts["--cell"].map((raw) => {
  const text = String(raw);
  const split = text.lastIndexOf("=");
  if (split === -1) usage(CHECKER, "--cell needs REF=VALUE, got " + text, HELP);
  const reference = text.slice(0, split).trim();
  const expected = text.slice(split + 1);
  if (!reference) usage(CHECKER, "--cell needs a cell reference before =, got " + text, HELP);
  const bang = reference.indexOf("!");
  const sheetName = bang === -1 ? null : reference.slice(0, bang).trim();
  const ref = (bang === -1 ? reference : reference.slice(bang + 1)).trim().toUpperCase();
  if (bang !== -1 && !sheetName) usage(CHECKER, "--cell needs a sheet name before !, got " + text, HELP);
  if (!/^[A-Z]{1,3}[0-9]{1,7}$/.test(ref)) {
    usage(CHECKER, "--cell reference must look like A1 or Sheet!A1, got " + reference, HELP);
  }
  return { source: text, sheetName, ref, expected: expected.trim() };
});

// Excel forbids : in a sheet name too, so the last : is an unambiguous split.
const rowChecks = opts["--min-rows"].map((raw) => {
  const text = String(raw);
  const split = text.lastIndexOf(":");
  if (split === -1) usage(CHECKER, "--min-rows needs SHEET:N or :N, got " + text, HELP);
  const sheetName = text.slice(0, split).trim();
  const minimum = requireInteger(CHECKER, text.slice(split + 1), "--min-rows " + text, HELP, { min: 1 });
  return { source: text, sheetName: sheetName || null, minimum };
});

const wantNoErrorCells = opts["--no-error-cells"] === true;
const wantNoPlaceholders = opts["--no-placeholders"] === true;

// readBuffer reports missing, unreadable and non-regular paths as usage errors,
// which is right: a gate cannot measure what it cannot open.
const buffer = readBuffer(CHECKER, target, HELP);

// A file that is not a readable ZIP is bad input, not a failed assertion. The
// distinction matters to whoever reads the gate transcript: exit 1 says the
// workbook is wrong, exit 2 says the gate was pointed at the wrong thing.
function unreadable(reason) {
  usage(
    CHECKER,
    target + " is not a readable .xlsx workbook: " + reason
      + ". An .xlsx is a ZIP of XML parts; .xls (the old binary format) is not a ZIP and is unsupported, "
      + "and a partially written, encrypted, or renamed file will land here too",
    HELP,
  );
}

let zip;
try {
  zip = openZip(buffer);
} catch (error) {
  if (error instanceof ZipError) unreadable(error.message);
  throw error;
}

function readPart(name) {
  try {
    return readEntryText(zip, name);
  } catch (error) {
    if (error instanceof ZipError) unreadable(error.message);
    throw error;
  }
}

if (!hasEntry(zip, "xl/workbook.xml")) {
  unreadable("the archive has no xl/workbook.xml part, so it is a ZIP of something else (a renamed .docx, .ods or .zip looks like this)");
}

const workbookXml = readPart("xl/workbook.xml");
const relsXml = hasEntry(zip, "xl/_rels/workbook.xml.rels") ? readPart("xl/_rels/workbook.xml.rels") : "";
const sheets = xlsxSheetMap(workbookXml, relsXml);
if (sheets.length === 0) {
  unreadable("no worksheets are declared in xl/workbook.xml and its relationships, which no workbook saved by Excel can be");
}

const sharedStrings = xlsxSharedStrings(
  hasEntry(zip, "xl/sharedStrings.xml") ? readPart("xl/sharedStrings.xml") : null,
);

// Sheet lookup: exact trimmed match first, then a case-insensitive match, which
// Excel itself would accept. A case-only match is recorded so the summary can
// say the workbook does not spell the sheet the way the gate does.
const caseNotes = [];
function findSheet(name) {
  const wanted = String(name).trim();
  const exact = sheets.find((sheet) => sheet.name.trim() === wanted);
  if (exact) return exact;
  const lowered = wanted.toLowerCase();
  const insensitive = sheets.find((sheet) => sheet.name.trim().toLowerCase() === lowered);
  if (!insensitive) return null;
  const note = "asked for \"" + wanted + "\", matched \"" + insensitive.name + "\" (case differs)";
  if (!caseNotes.includes(note)) caseNotes.push(note);
  return insensitive;
}

// Sheet parts are read at most once each: --cell, --min-rows and the scan can
// all name the same sheet, and a large sheet is expensive to inflate and parse.
const cellCache = new Map();
function cellsOf(sheet) {
  const cached = cellCache.get(sheet.path);
  if (cached) return cached;
  const parsed = xlsxCells(readPart(sheet.path), sharedStrings);
  cellCache.set(sheet.path, parsed);
  return parsed;
}

function isFilled(cell) {
  return String(cell.value).trim() !== "";
}

function excerpt(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_LIMIT ? flat : flat.slice(0, EXCERPT_LIMIT) + "...";
}

function numericallyEqual(a, b) {
  // Relative tolerance with a floor of 1, so 1000 matches 1000.0 without
  // demanding exact equality of a value that survived a float round trip, and
  // without silently accepting a large absolute gap on a large number.
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

const failures = [];
const details = [];
const measured = [];
let assertions = 0;

function report(header, items) {
  failures.push(header);
  details.push(header);
  for (const item of items.slice(0, MAX_REPORTED)) details.push("  " + item);
  if (items.length > MAX_REPORTED) details.push("  ... and " + (items.length - MAX_REPORTED) + " more");
}

// --- sheet inventory -------------------------------------------------------

if (minSheets !== null) {
  assertions += 1;
  if (sheets.length < minSheets) {
    report("sheet count " + sheets.length + " is below --min-sheets " + minSheets, [
      "sheets present: " + sheets.map((sheet) => sheet.name).join(" | "),
    ]);
  } else {
    measured.push("sheets >= " + minSheets);
  }
}

if (exactSheets !== null) {
  assertions += 1;
  if (sheets.length !== exactSheets) {
    report("sheet count " + sheets.length + " is not --exact-sheets " + exactSheets, [
      "sheets present: " + sheets.map((sheet) => sheet.name).join(" | "),
    ]);
  } else {
    measured.push("sheets == " + exactSheets);
  }
}

if (requiredSheets.length) {
  assertions += 1;
  const missing = requiredSheets.filter((name) => findSheet(name) === null);
  if (missing.length) {
    report(missing.length + " of " + requiredSheets.length + " required sheet(s) absent", [
      ...missing.map((name) => "missing: " + name),
      "sheets present: " + sheets.map((sheet) => sheet.name).join(" | "),
    ]);
  } else {
    measured.push(requiredSheets.length + " required sheet(s) present");
  }
}

if (forbiddenSheets.length) {
  assertions += 1;
  const found = forbiddenSheets.filter((name) => findSheet(name) !== null);
  if (found.length) {
    report(found.length + " of " + forbiddenSheets.length + " forbidden sheet(s) still present", [
      ...found.map((name) => "present: " + name),
    ]);
  } else {
    measured.push(forbiddenSheets.length + " forbidden sheet(s) absent");
  }
}

// --- scan selection --------------------------------------------------------

let scanned = sheets;
if (scanRequests.length) {
  assertions += 1;
  const resolved = [];
  const missing = [];
  for (const name of scanRequests) {
    const sheet = findSheet(name);
    if (!sheet) missing.push(name);
    else if (!resolved.includes(sheet)) resolved.push(sheet);
  }
  if (missing.length) {
    report(missing.length + " of " + scanRequests.length + " sheet(s) named by --sheet are absent", [
      ...missing.map((name) => "missing: " + name),
      "sheets present: " + sheets.map((sheet) => sheet.name).join(" | "),
    ]);
  } else {
    measured.push("scan limited to " + resolved.length + " named sheet(s)");
  }
  scanned = resolved;
}

// --- cell scan -------------------------------------------------------------

const errorCells = [];
const placeholderCells = [];
let cellsScanned = 0;
let filledCells = 0;
let rowsWithData = 0;

for (const sheet of scanned) {
  const cells = cellsOf(sheet);
  const rows = new Set();
  for (const cell of cells) {
    cellsScanned += 1;
    const filled = isFilled(cell);
    if (filled) {
      filledCells += 1;
      rows.add(cellRow(cell.ref));
    }
    if (cell.type === "e") {
      errorCells.push(sheet.name + "!" + cell.ref + " = " + (String(cell.value).trim() || "#unknown-error"));
    }
    if (filled && wantNoPlaceholders) {
      const hit = PLACEHOLDER_PATTERNS.find((pattern) => pattern.re.test(String(cell.value)));
      if (hit) {
        placeholderCells.push(sheet.name + "!" + cell.ref + " [" + hit.label + "] " + excerpt(cell.value));
      }
    }
  }
  rowsWithData += rows.size;
}

if (wantNoErrorCells) {
  assertions += 1;
  if (errorCells.length) {
    report(errorCells.length + " cell(s) hold an Excel error value", errorCells);
  } else {
    measured.push("no error cells in " + cellsScanned + " scanned cell(s)");
  }
}

if (wantNoPlaceholders) {
  assertions += 1;
  if (placeholderCells.length) {
    report(placeholderCells.length + " cell(s) hold placeholder text", placeholderCells);
  } else {
    measured.push("no placeholder text in " + cellsScanned + " scanned cell(s)");
  }
}

// --- cell values -----------------------------------------------------------

if (cellChecks.length) {
  assertions += 1;
  const wrong = [];
  for (const check of cellChecks) {
    const sheet = check.sheetName === null ? sheets[0] : findSheet(check.sheetName);
    if (!sheet) {
      wrong.push(check.source + ": sheet \"" + check.sheetName + "\" is absent from the workbook");
      continue;
    }
    const label = sheet.name + "!" + check.ref;
    const cell = cellsOf(sheet).find((candidate) => candidate.ref === check.ref);
    if (!cell || !isFilled(cell)) {
      wrong.push(label + " is empty or absent, expected \"" + check.expected + "\"");
      continue;
    }
    const actual = String(cell.value).trim();
    if (actual === check.expected) continue;
    const expectedNumber = parseNumber(check.expected);
    const actualNumber = parseNumber(actual);
    if (expectedNumber !== null && actualNumber !== null && numericallyEqual(expectedNumber, actualNumber)) continue;
    const marker = cell.type === "e" ? " (Excel error value)" : "";
    wrong.push(label + " is \"" + excerpt(actual) + "\"" + marker + ", expected \"" + check.expected + "\"");
  }
  if (wrong.length) {
    report(wrong.length + " of " + cellChecks.length + " cell value(s) do not match", wrong);
  } else {
    measured.push(cellChecks.length + " cell value(s) match");
  }
}

// --- row depth -------------------------------------------------------------

if (rowChecks.length) {
  assertions += 1;
  const short = [];
  for (const check of rowChecks) {
    const sheet = check.sheetName === null ? sheets[0] : findSheet(check.sheetName);
    if (!sheet) {
      short.push(check.source + ": sheet \"" + check.sheetName + "\" is absent from the workbook");
      continue;
    }
    let lastRow = 0;
    for (const cell of cellsOf(sheet)) {
      if (!isFilled(cell)) continue;
      const row = cellRow(cell.ref);
      if (row > lastRow) lastRow = row;
    }
    if (lastRow < check.minimum) {
      short.push(
        sheet.name + ": last row with data is " + (lastRow || "none") + ", below the required " + check.minimum,
      );
    }
  }
  if (short.length) {
    report(short.length + " of " + rowChecks.length + " --min-rows check(s) failed", short);
  } else {
    measured.push(rowChecks.length + " row-depth check(s) met");
  }
}

// --- verdict ---------------------------------------------------------------

if (failures.length) {
  fail(CHECKER, target + ": " + failures.length + " of " + assertions + " check(s) failed", details);
}

const scannedNames = scanned.map((sheet) => sheet.name);
const shownNames = scannedNames.length > NAMES_IN_SUMMARY
  ? scannedNames.slice(0, NAMES_IN_SUMMARY).join(" | ") + " | +" + (scannedNames.length - NAMES_IN_SUMMARY) + " more"
  : scannedNames.join(" | ");

const parts = [
  sheets.length + " sheet(s)",
  "scanned " + scanned.length + ": " + (shownNames || "none"),
  rowsWithData + " row(s) with data",
  cellsScanned + " cell(s) scanned, " + filledCells + " non-empty",
];
if (caseNotes.length) parts.push("case-insensitive sheet match: " + caseNotes.join("; "));
if (measured.length) parts.push(...measured);
else parts.push("read stored values only, no assertions requested");

ok(CHECKER, target + ": " + parts.join(", "));
