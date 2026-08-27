#!/usr/bin/env node
// check-docx.mjs : verify the visible text of a Word report.
// Zero dependencies. Node 16+.
//
// A .docx is the most common thing an assistant hands back in an office, and
// the most common way it is wrong is not a crash. The file opens, the styling
// looks finished, and page 4 still says "TODO" or "<부서명>" because a section
// was outlined and never written. Nobody scrolls to the end before forwarding
// it. This checker scrolls to the end.
//
// It reads word/document.xml out of the ZIP container and extracts the text
// runs, so it measures what a reader would see: paragraph text, heading
// styles, table count, word count.
//
// What it cannot prove, stated plainly so a gate does not overclaim:
//   - It reads the document's text, not its meaning. A section titled "리스크
//     분석" that contains one vacuous sentence passes --require-heading just as
//     a real analysis does. Presence is not quality, and no measurement here
//     substitutes for a human reading the section.
//   - It does not check numbers against a source, so a table full of invented
//     figures passes every count.
//   - It reads the body only. Text living in headers, footers, footnotes,
//     comments, text boxes and SmartArt is invisible to it, which means
//     --forbid-text and --no-placeholders cannot see a placeholder parked in a
//     footer.
//   - Tracked deletions are excluded (they are not visible text) but tracked
//     insertions are counted, so a document reviewed but not accepted measures
//     as if every proposed edit were already applied.
//   - Style based heading detection depends on the template. Korean templates
//     routinely fake headings with direct formatting, so this checker falls
//     back to short standalone paragraphs and reports how many matches needed
//     that fallback.

import {
  parseArgs,
  requireInteger,
  readBuffer,
  ok,
  fail,
  usage,
} from "./lib/common.mjs";
import { openZip, readEntryText, ZipError } from "./lib/zip.mjs";
import { docxParagraphs, isHeadingStyle, countDocxTables } from "./lib/xml.mjs";

const CHECKER = "check-docx";

const HELP = `usage: check-docx.mjs [options] <report.docx>

Verify the visible body text of a Word document: required headings, required
and forbidden strings, leftover template placeholders, and size floors.

options:
  --require-heading TEXT     repeatable. A heading must contain TEXT. Matches a
                             paragraph with a heading style first; if no styled
                             heading matches, a short standalone paragraph
                             (under 80 characters) containing TEXT is accepted,
                             because many Korean templates fake headings with
                             direct formatting. The summary reports how many
                             matched by style and how many by that fallback.
  --require-text TEXT        repeatable. TEXT must appear in some paragraph.
  --forbid-text TEXT         repeatable. TEXT must appear nowhere in the body.
                             Every hit is reported with its paragraph index.
  --no-placeholders          fail if unfilled template markers remain: TODO,
                             TBD, FIXME, XXX as standalone tokens, Lorem ipsum,
                             <angle brackets>, [[double brackets]],
                             {{double braces}}, and the Korean markers 여기에,
                             내용을 입력, 작성 요망, 기재 요망, OOO, ○○○.
  --min-words N              at least N whitespace separated tokens.
  --max-words N              at most N whitespace separated tokens.
  --min-paragraphs N         at least N non-empty paragraphs.
  --min-headings N           at least N paragraphs with a heading style.
  --min-tables N             at least N tables.
  --require-table-count N    exactly N tables.
  -h, --help                 print this help.

All text matching is case-insensitive and normalises whitespace on both sides,
because Word splits one visible word across several runs. Paragraph indices are
1-based and count empty paragraphs, so they line up with what you see in Word.

Scope: the document body only. Headers, footers, footnotes, comments and text
boxes are not read, and neither is meaning: a heading that exists but says
nothing passes. Judge quality by reading, not by this exit code.

POSITIVE CONTROL, required before you trust --forbid-text or --no-placeholders.
An absence check is only worth anything once you have watched it fail. A typo
in the option, a placeholder that lives in a header, or a marker split across
runs all look exactly like a clean document. Run the same command once against
a copy of the report that still contains a placeholder, confirm it exits 1, and
record that run in the gate's manual review. Do this once per gate, not once
per project.

exit codes: 0 pass, 1 measured failure, 2 usage or unreadable input.

gate example:
  CHECK: node checks/check-docx.mjs out/보고서.docx --no-placeholders --min-words 800 --require-heading "결론" --require-heading "리스크" --min-tables 1
  EXPECT: UNLAZY-CHECK-OK check-docx`;

const spec = {
  flags: ["--no-placeholders"],
  values: [
    "--min-words",
    "--max-words",
    "--min-paragraphs",
    "--min-headings",
    "--min-tables",
    "--require-table-count",
  ],
  repeatable: ["--require-heading", "--require-text", "--forbid-text"],
};

const { opts, positional } = parseArgs(CHECKER, process.argv.slice(2), spec, HELP);

if (positional.length === 0) usage(CHECKER, "no .docx path given", HELP);
if (positional.length > 1) {
  usage(CHECKER, "expected exactly one .docx path, got " + positional.length, HELP);
}
const path = positional[0];

function intOption(name, min) {
  if (!(name in opts)) return null;
  return requireInteger(CHECKER, opts[name], name, HELP, { min });
}

const minWords = intOption("--min-words", 0);
const maxWords = intOption("--max-words", 0);
const minParagraphs = intOption("--min-paragraphs", 0);
const minHeadings = intOption("--min-headings", 0);
const minTables = intOption("--min-tables", 0);
const exactTables = intOption("--require-table-count", 0);
const noPlaceholders = opts["--no-placeholders"] === true;

if (minWords !== null && maxWords !== null && maxWords < minWords) {
  usage(CHECKER, "--max-words " + maxWords + " is below --min-words " + minWords, HELP);
}
if (exactTables !== null && minTables !== null && minTables > exactTables) {
  usage(
    CHECKER,
    "--min-tables " + minTables + " cannot be met with --require-table-count " + exactTables,
    HELP,
  );
}

// Whitespace is normalised on both sides of every comparison. The extractor
// already collapses runs, so a needle typed with a newline or a double space
// would otherwise never match text that a reader sees as identical.
function norm(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function needle(name, value) {
  const text = norm(value);
  if (!text) usage(CHECKER, name + " needs non-empty text", HELP);
  return { raw: text, lower: text.toLowerCase() };
}

const requiredHeadings = opts["--require-heading"].map((v) => needle("--require-heading", v));
const requiredTexts = opts["--require-text"].map((v) => needle("--require-text", v));
const forbiddenTexts = opts["--forbid-text"].map((v) => needle("--forbid-text", v));

const nothingAsserted =
  !requiredHeadings.length &&
  !requiredTexts.length &&
  !forbiddenTexts.length &&
  !noPlaceholders &&
  minWords === null &&
  maxWords === null &&
  minParagraphs === null &&
  minHeadings === null &&
  minTables === null &&
  exactTables === null;
if (nothingAsserted) {
  usage(
    CHECKER,
    "no assertion requested; a gate that only proves the file opens is not a gate",
    HELP,
  );
}

// An excerpt is bounded so a pasted-in wall of text cannot flood the gate
// transcript, and centred on the hit so the reviewer sees why it fired.
function excerpt(text, index, limit = 60) {
  const lead = index > 12;
  const start = lead ? index - 12 : 0;
  const prefix = lead ? "..." : "";
  let room = limit - prefix.length;
  let core = text.slice(start, start + room);
  let suffix = "";
  if (start + core.length < text.length) {
    suffix = "...";
    core = core.slice(0, room - suffix.length);
  }
  return prefix + core + suffix;
}

const buffer = readBuffer(CHECKER, path, HELP);

// An unreadable container is bad input, not a failed assertion: nothing was
// measured, so exit 2 rather than claiming the report is wrong.
let documentXml;
try {
  const zip = openZip(buffer);
  documentXml = readEntryText(zip, "word/document.xml");
} catch (error) {
  if (error instanceof ZipError) {
    const hint = /\.docx?$/i.test(path) && !/\.docx$/i.test(path)
      ? " (a .doc file is the old binary Word format, not a ZIP; open it in Word and Save As .docx)"
      : " (not a readable .docx; if it opens in Word, re-save it as .docx, and note that password-protected files cannot be read)";
    usage(CHECKER, "cannot read " + path + ": " + error.message + hint, HELP);
  }
  throw error;
}

const paragraphs = docxParagraphs(documentXml);
const bodyParagraphs = paragraphs.filter((p) => p.text !== "");
const tableCount = countDocxTables(documentXml);
const headingParagraphs = paragraphs.filter((p) => p.text !== "" && isHeadingStyle(p.style));
const wordCount = paragraphs.reduce((total, p) => {
  const tokens = p.text.split(/\s+/).filter(Boolean);
  return total + tokens.length;
}, 0);

// One entry per paragraph, pre-normalised and pre-lowered once, because every
// assertion below scans the same list.
const scan = paragraphs.map((p, i) => ({
  index: i + 1,
  text: norm(p.text),
  style: p.style,
}));
for (const row of scan) row.lower = row.text.toLowerCase();

const problems = [];
const details = [];

function report(headline, lines = []) {
  problems.push(headline);
  details.push(headline);
  for (const line of lines) details.push("  " + line);
}

// --- required headings -----------------------------------------------------

let matchedByStyle = 0;
let matchedByFallback = 0;
const missingHeadings = [];

for (const want of requiredHeadings) {
  const styled = scan.find((row) => isHeadingStyle(row.style) && row.lower.includes(want.lower));
  if (styled) {
    matchedByStyle += 1;
    continue;
  }
  // Fallback for templates that fake headings with direct formatting instead
  // of a style. A short standalone paragraph is the shape a heading has; a
  // sentence of body prose that happens to contain the word is not.
  const bare = scan.find(
    (row) => row.text !== "" && row.text.length < 80 && row.lower.includes(want.lower),
  );
  if (bare) {
    matchedByFallback += 1;
    continue;
  }
  missingHeadings.push(want.raw);
}

if (missingHeadings.length) {
  report(
    missingHeadings.length + " required heading(s) not found",
    missingHeadings.map((text) => "missing heading: " + text),
  );
}

// --- required text ---------------------------------------------------------

const missingTexts = [];
for (const want of requiredTexts) {
  const hit = scan.find((row) => row.lower.includes(want.lower));
  if (!hit) missingTexts.push(want.raw);
}
if (missingTexts.length) {
  report(
    missingTexts.length + " required string(s) not found in the body",
    missingTexts.map((text) => "missing text: " + text),
  );
}

// --- forbidden text --------------------------------------------------------

const forbiddenHits = [];
for (const want of forbiddenTexts) {
  for (const row of scan) {
    const at = row.lower.indexOf(want.lower);
    if (at === -1) continue;
    forbiddenHits.push(
      "forbidden text " + JSON.stringify(want.raw) + " at paragraph " + row.index +
        ": " + excerpt(row.text, at),
    );
  }
}
if (forbiddenHits.length) {
  report(forbiddenHits.length + " forbidden text hit(s)", forbiddenHits);
}

// --- placeholders ----------------------------------------------------------

// Standalone token boundaries are spelled out instead of using \b, because \b
// treats a Korean character as a non-word character and would let 작성TODO 요망
// count as a standalone TODO.
const PLACEHOLDER_PATTERNS = [
  { label: "TODO marker", re: /(^|[^0-9A-Za-z])TODO([^0-9A-Za-z]|$)/i },
  { label: "TBD marker", re: /(^|[^0-9A-Za-z])TBD([^0-9A-Za-z]|$)/i },
  { label: "FIXME marker", re: /(^|[^0-9A-Za-z])FIXME([^0-9A-Za-z]|$)/i },
  { label: "XXX marker", re: /(^|[^0-9A-Za-z])XXX([^0-9A-Za-z]|$)/i },
  { label: "OOO marker", re: /(^|[^0-9A-Za-z])OOO([^0-9A-Za-z]|$)/ },
  { label: "circle marker", re: /○○○/ },
  { label: "lorem ipsum filler", re: /lorem\s+ipsum/i },
  // <부서명>, <insert name>. Bounded and single line so a stray comparison in
  // running prose is unlikely to qualify.
  { label: "angle bracket placeholder", re: /<(?!\/)[^<>]{1,39}>/ },
  { label: "double bracket placeholder", re: /\[\[[^\][]{0,80}\]\]/ },
  { label: "double brace placeholder", re: /\{\{[^{}]{0,80}\}\}/ },
  { label: "Korean placeholder 여기에", re: /여기에/ },
  { label: "Korean placeholder 내용을 입력", re: /내용을\s*입력/ },
  { label: "Korean placeholder 작성 요망", re: /작성\s*요망/ },
  { label: "Korean placeholder 기재 요망", re: /기재\s*요망/ },
];

const placeholderHits = [];
if (noPlaceholders) {
  for (const row of scan) {
    if (row.text === "") continue;
    for (const pattern of PLACEHOLDER_PATTERNS) {
      const found = pattern.re.exec(row.text);
      if (!found) continue;
      placeholderHits.push(
        pattern.label + " at paragraph " + row.index + ": " + excerpt(row.text, found.index),
      );
    }
  }
  if (placeholderHits.length) {
    report(placeholderHits.length + " unfilled placeholder(s) remain", placeholderHits);
  }
}

// --- size floors and ceilings ---------------------------------------------

const sizeFailures = [];
if (minWords !== null && wordCount < minWords) {
  sizeFailures.push("words: " + wordCount + " < required " + minWords);
}
if (maxWords !== null && wordCount > maxWords) {
  sizeFailures.push("words: " + wordCount + " > allowed " + maxWords);
}
if (minParagraphs !== null && bodyParagraphs.length < minParagraphs) {
  sizeFailures.push("non-empty paragraphs: " + bodyParagraphs.length + " < required " + minParagraphs);
}
if (minHeadings !== null && headingParagraphs.length < minHeadings) {
  sizeFailures.push("styled headings: " + headingParagraphs.length + " < required " + minHeadings);
}
if (minTables !== null && tableCount < minTables) {
  sizeFailures.push("tables: " + tableCount + " < required " + minTables);
}
if (exactTables !== null && tableCount !== exactTables) {
  sizeFailures.push("tables: " + tableCount + " != required " + exactTables);
}
if (sizeFailures.length) {
  report(sizeFailures.length + " size assertion(s) failed", sizeFailures);
}

// --- verdict ---------------------------------------------------------------

function plural(count, one, many) {
  return count + " " + (count === 1 ? one : many);
}

const measured =
  plural(wordCount, "word", "words") + ", " +
  plural(bodyParagraphs.length, "non-empty paragraph", "non-empty paragraphs") +
  " (" + paragraphs.length + " total), " +
  plural(headingParagraphs.length, "styled heading", "styled headings") + ", " +
  plural(tableCount, "table", "tables");

if (problems.length) {
  const reason = problems.length === 1
    ? problems[0] + " in " + path + "; measured " + measured
    : problems.length + " assertion groups failed in " + path + "; measured " + measured;
  fail(CHECKER, reason, details);
}

const notes = [];
if (requiredHeadings.length) {
  notes.push(
    "headings matched " + matchedByStyle + " by style, " + matchedByFallback +
      " by direct-formatting fallback",
  );
}
if (requiredTexts.length) {
  notes.push(plural(requiredTexts.length, "required string", "required strings") + " present");
}
if (forbiddenTexts.length) {
  notes.push(plural(forbiddenTexts.length, "forbidden string", "forbidden strings") + " absent");
}
if (noPlaceholders) notes.push("no placeholders found (absence: confirm the positive control)");

ok(CHECKER, path + ": " + measured + (notes.length ? "; " + notes.join("; ") : ""));
