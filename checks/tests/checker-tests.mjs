// checker-tests.mjs : adversarial tests for the checkers in checks/.
// Zero dependencies. Node 16+.
//
// Each checker is run as a real subprocess, because the thing under test is the
// contract a gate depends on: the exit code and the combined output, not the
// internal functions.
//
// Three rules shape this suite:
//
//   1. Every absence assertion is tested twice. Once on clean input, which must
//      pass, and once on input that certainly contains what is forbidden, which
//      must fail. A checker that passes the first test and not the second is
//      the exact hazard the library warns about, so the pair is the test.
//   2. A failing run must never emit the success marker. A gate matches the
//      combined stream, so a marker anywhere in a failure would certify it.
//   3. Input that embeds the marker is treated as hostile. Files are supplied
//      by whoever is being checked, and a CSV cell reading UNLAZY-CHECK-OK must
//      not be able to launder a failure into a pass.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDocx, makeXlsx, writeUtf8 } from "./fixtures.mjs";
import { PASS_TOKEN } from "../lib/common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checksDir = join(here, "..");
const dir = mkdtempSync(join(tmpdir(), "unlazy-checkers-"));

let failures = 0;
let total = 0;

function run(checker, args) {
  const result = spawnSync(process.execPath, [join(checksDir, checker), ...args], {
    encoding: "utf8",
    cwd: dir,
  });
  return {
    status: result.status,
    combined: (result.stdout || "") + (result.stderr || ""),
  };
}

// A pass must exit 0 and carry a marker naming this checker, which is what a
// real gate puts in EXPECT.
function expectPass(name, checker, args) {
  total += 1;
  const { status, combined } = run(checker, args);
  const marker = PASS_TOKEN + " " + checker.replace(/\.mjs$/, "");
  if (status === 0 && combined.includes(marker)) {
    console.log("ok   " + name);
    return;
  }
  failures += 1;
  console.log("FAIL " + name + "  << exit=" + status + " :: " + combined.trim().split("\n")[0]);
}

// A measured failure must exit 1 and must not emit the marker anywhere, in any
// form, including a copy that came out of the file being checked.
function expectFail(name, checker, args, mustMention) {
  total += 1;
  const { status, combined } = run(checker, args);
  const problems = [];
  if (status !== 1) problems.push("exit=" + status + " (wanted 1)");
  if (combined.includes(PASS_TOKEN)) problems.push("failure output leaked the success marker");
  if (mustMention && !combined.includes(mustMention)) problems.push("did not mention " + mustMention);
  if (!problems.length) {
    console.log("ok   " + name);
    return;
  }
  failures += 1;
  console.log("FAIL " + name + "  << " + problems.join("; ") + " :: " + combined.trim().split("\n")[0]);
}

function expectUsage(name, checker, args) {
  total += 1;
  const { status, combined } = run(checker, args);
  const problems = [];
  if (status !== 2) problems.push("exit=" + status + " (wanted 2)");
  if (combined.includes(PASS_TOKEN)) problems.push("usage output leaked the success marker");
  if (!problems.length) {
    console.log("ok   " + name);
    return;
  }
  failures += 1;
  console.log("FAIL " + name + "  << " + problems.join("; ") + " :: " + combined.trim().split("\n")[0]);
}

// --help is documentation, so it exits 0 and does show the marker inside its
// worked gate example. That is the one deliberate exception, and it is safe
// only because no gate would ever declare --help as its oracle. Every other
// path is asserted marker-free above.
function expectHelp(name, checker) {
  total += 1;
  const { status, combined } = run(checker, ["--help"]);
  if (status === 0 && combined.includes("EXPECT:")) {
    console.log("ok   " + name);
    return;
  }
  failures += 1;
  console.log("FAIL " + name + "  << exit=" + status);
}

function section(title) {
  console.log("");
  console.log("# " + title);
}

// ------------------------------------------------------------ check-file ----
section("check-file");

const goodFile = join(dir, "report.txt");
writeUtf8(goodFile, "일일 점검 결과\n정상 종료\n");
const goodDigest = createHash("sha256").update("일일 점검 결과\n정상 종료\n", "utf8").digest("hex");

const emptyFile = join(dir, "empty.txt");
writeUtf8(emptyFile, "   \n\n  \n");

const staleFile = join(dir, "stale.txt");
writeUtf8(staleFile, "어제 만든 파일\n");
const longAgo = new Date(Date.now() - 72 * 3600 * 1000);
utimesSync(staleFile, longAgo, longAgo);

expectPass("file: an existing non-empty file passes", "check-file.mjs", ["report.txt"]);
expectPass("file: size floor met", "check-file.mjs", ["report.txt", "--min-bytes", "10"]);
expectPass("file: digest matches", "check-file.mjs", ["report.txt", "--sha256", goodDigest]);
expectPass("file: fresh file is within the age window", "check-file.mjs", ["report.txt", "--max-age-hours", "24"]);
expectFail("file: size floor not met", "check-file.mjs", ["report.txt", "--min-bytes", "999999"]);
expectFail("file: digest mismatch is caught", "check-file.mjs",
  ["report.txt", "--sha256", "0".repeat(64)]);
expectFail("file: a stale file fails the age window", "check-file.mjs",
  ["stale.txt", "--max-age-hours", "24"]);
expectFail("file: whitespace-only file has no content lines", "check-file.mjs",
  ["empty.txt", "--not-empty-lines"]);
expectUsage("file: a missing file is unreadable input, not a pass", "check-file.mjs", ["nope.txt"]);
expectUsage("file: unknown option is refused", "check-file.mjs", ["report.txt", "--bogus"]);
expectUsage("file: no path at all", "check-file.mjs", []);

// -------------------------------------------------------- check-encoding ----
section("check-encoding");

const utf8Csv = join(dir, "utf8.csv");
writeUtf8(utf8Csv, "거래번호,거래금액\nT001,1000\n");
const bomCsv = join(dir, "bom.csv");
writeUtf8(bomCsv, "거래번호,거래금액\nT002,2000\n", { bom: true });
const cp949Csv = join(dir, "cp949.csv");
// "거래번호,거래금액" then a data row, in CP949 bytes.
writeFileSync(cp949Csv, Buffer.concat([
  Buffer.from([0xb0, 0xc5, 0xb7, 0xa1, 0xb9, 0xf8, 0xc8, 0xa3]),
  Buffer.from(",", "ascii"),
  Buffer.from([0xb0, 0xc5, 0xb7, 0xa1, 0xb1, 0xdd, 0xbe, 0xd7]),
  Buffer.from("\nT003,3000\n", "ascii"),
]));
const utf16Csv = join(dir, "utf16.csv");
writeFileSync(utf16Csv, Buffer.from("﻿거래번호,거래금액\n", "utf16le"));

expectPass("encoding: utf8 file matches --expect utf8", "check-encoding.mjs", ["utf8.csv", "--expect", "utf8"]);
expectPass("encoding: BOM file matches --expect utf8-bom", "check-encoding.mjs", ["bom.csv", "--expect", "utf8-bom"]);
expectPass("encoding: cp949 file is detected as cp949", "check-encoding.mjs", ["cp949.csv", "--expect", "cp949"]);
expectPass("encoding: two utf8 files are consistent", "check-encoding.mjs", ["utf8.csv", "utf8.csv", "--consistent"]);
expectFail("encoding: cp949 file fails --expect utf8", "check-encoding.mjs", ["cp949.csv", "--expect", "utf8"]);
expectFail("encoding: BOM is caught by --no-bom", "check-encoding.mjs", ["bom.csv", "--no-bom"]);
expectFail("encoding: utf16 fails a utf8 expectation", "check-encoding.mjs", ["utf16.csv", "--expect", "utf8"]);
expectFail("encoding: mixed encodings are not consistent", "check-encoding.mjs",
  ["utf8.csv", "cp949.csv", "--consistent"]);
expectUsage("encoding: no file paths", "check-encoding.mjs", ["--expect", "utf8"]);
expectUsage("encoding: contradictory BOM options", "check-encoding.mjs",
  ["utf8.csv", "--no-bom", "--require-bom"]);

// ------------------------------------------------------------- check-csv ----
section("check-csv");

// The first amount is quoted because it carries a thousands separator. An
// unquoted 1,000.50 is two fields, not one, and the reconciliation gate below
// only means anything if the fixture is a CSV a real system would emit.
const ledgerCsv = join(dir, "ledger.csv");
writeUtf8(ledgerCsv,
  "거래일자,거래번호,계좌번호,거래금액\n" +
  '2026-03-05,T001,110-001,"1,000.50"\n' +
  "2026-03-05,T002,110-002,2500\n" +
  "2026-03-05,T003,110-003,(500)\n");

// Same totals, different row order and formatting: a real reconciliation must
// still balance, which is what makes this a fair test of the two-file path.
const settleCsv = join(dir, "settle.csv");
writeUtf8(settleCsv,
  "거래일자,거래번호,거래금액\n" +
  "2026-03-05,T003,-500\n" +
  "2026-03-05,T001,1000.50\n" +
  "2026-03-05,T002,2500.00\n");

const brokenCsv = join(dir, "settle-broken.csv");
writeUtf8(brokenCsv,
  "거래일자,거래번호,거래금액\n" +
  "2026-03-05,T003,-500\n" +
  "2026-03-05,T001,1000.50\n" +
  "2026-03-05,T002,2600.00\n");

const dupCsv = join(dir, "dup.csv");
writeUtf8(dupCsv, "거래번호,거래금액\nT001,10\nT001,20\n");

const holeCsv = join(dir, "hole.csv");
writeUtf8(holeCsv, "거래번호,거래금액\nT001,10\nT002,\n");

const quotedCsv = join(dir, "quoted.csv");
writeUtf8(quotedCsv,
  '거래번호,적요,거래금액\n' +
  '"T001","쉼표, 포함된 적요",100\n' +
  '"T002","줄바꿈\n포함",200\n');

expectPass("csv: required columns present", "check-csv.mjs",
  ["ledger.csv", "--require-columns", "거래일자,거래번호,계좌번호,거래금액"]);
expectPass("csv: row count floor", "check-csv.mjs", ["ledger.csv", "--min-rows", "3"]);
expectPass("csv: unique key column", "check-csv.mjs", ["ledger.csv", "--unique-column", "거래번호"]);
expectPass("csv: quoted fields with commas and newlines parse", "check-csv.mjs",
  ["quoted.csv", "--exact-rows", "2", "--unique-column", "거래번호"]);
expectPass("csv: cp949 file is auto-detected and parsed", "check-csv.mjs",
  ["cp949.csv", "--min-rows", "1"]);
expectPass("csv: two sources reconcile on sum and row count", "check-csv.mjs",
  ["ledger.csv", "--sum-column", "거래금액", "--reconcile-with", "settle.csv", "--reconcile-rows"]);
expectFail("csv: a real imbalance is caught", "check-csv.mjs",
  ["ledger.csv", "--sum-column", "거래금액", "--reconcile-with", "settle-broken.csv"]);
expectFail("csv: missing required column", "check-csv.mjs",
  ["ledger.csv", "--require-columns", "부서코드"]);
expectFail("csv: duplicate key is caught", "check-csv.mjs", ["dup.csv", "--unique-column", "거래번호"]);
expectFail("csv: empty cell in a required column is caught", "check-csv.mjs",
  ["hole.csv", "--no-empty-cells", "거래금액"]);
expectFail("csv: row floor not met", "check-csv.mjs", ["ledger.csv", "--min-rows", "99"]);
expectFail("csv: forcing the wrong encoding is caught as damage", "check-csv.mjs",
  ["cp949.csv", "--encoding", "utf8", "--min-rows", "1"]);
expectUsage("csv: sum comparison without a sum column", "check-csv.mjs",
  ["ledger.csv", "--sum-equals", "3000"]);
expectUsage("csv: unknown option", "check-csv.mjs", ["ledger.csv", "--sum-colum", "거래금액"]);

// ------------------------------------------------------------ check-docx ----
section("check-docx");

const cleanDocx = join(dir, "clean.docx");
makeDocx(cleanDocx, [
  { text: "일일 점검 보고서", style: "Heading1" },
  { text: "개요", style: "Heading2" },
  { text: "본 보고서는 2026년 3월 5일 정기 점검 결과를 정리한 것이다. ".repeat(12) },
  { text: "점검 결과", style: "Heading2" },
  { text: "모든 항목이 기준을 충족하였다. ".repeat(12) },
  { text: "결론", style: "Heading2" },
  { text: "특이사항 없음. 익일 정기 점검을 계속한다. ".repeat(8) },
  { table: [["항목", "결과"], ["디스크", "정상"]] },
]);

// The positive control. Same shape, but carrying the markers a finished report
// must not contain.
const dirtyDocx = join(dir, "dirty.docx");
makeDocx(dirtyDocx, [
  { text: "일일 점검 보고서", style: "Heading1" },
  { text: "개요", style: "Heading2" },
  { text: "본 보고서는 <작성자> 가 작성하였다. TODO: 수치 확인 필요" },
  { text: "점검 결과", style: "Heading2" },
  { text: "담당 부서: OOO 팀. 내용을 입력 하십시오." },
  { text: "결론", style: "Heading2" },
  { text: "샘플 문구가 남아 있다." },
  { table: [["항목", "결과"]] },
]);

expectPass("docx: required headings found", "check-docx.mjs",
  ["clean.docx", "--require-heading", "개요", "--require-heading", "점검 결과", "--require-heading", "결론"]);
expectPass("docx: word floor and table floor met", "check-docx.mjs",
  ["clean.docx", "--min-words", "40", "--min-tables", "1"]);
expectPass("docx: clean report has no placeholders", "check-docx.mjs",
  ["clean.docx", "--no-placeholders"]);
expectPass("docx: required text present", "check-docx.mjs",
  ["clean.docx", "--require-text", "정기 점검"]);
// The pair that makes the absence check trustworthy.
expectFail("docx: POSITIVE CONTROL, placeholders are detected", "check-docx.mjs",
  ["dirty.docx", "--no-placeholders"]);
expectFail("docx: forbidden text is detected", "check-docx.mjs",
  ["dirty.docx", "--forbid-text", "샘플"]);
expectFail("docx: missing heading is reported", "check-docx.mjs",
  ["clean.docx", "--require-heading", "예산 집행"]);
expectFail("docx: word floor not met", "check-docx.mjs", ["clean.docx", "--min-words", "99999"]);
expectUsage("docx: a non-docx file is unreadable input", "check-docx.mjs",
  ["report.txt", "--no-placeholders"]);
expectUsage("docx: missing file", "check-docx.mjs", ["nope.docx", "--no-placeholders"]);

// ------------------------------------------------------------ check-xlsx ----
section("check-xlsx");

const cleanXlsx = join(dir, "clean.xlsx");
makeXlsx(cleanXlsx, [
  { name: "대사요약", rows: [["항목", "건수", "금액"], ["원장계", 3, 3000.5], ["정산계", 3, 3000.5]] },
  { name: "상세", rows: [["거래번호", "금액"], ["T001", 1000.5], ["T002", 2500]] },
]);

// The positive control: an error cell and a placeholder, the two things the
// absence options claim are not there.
const dirtyXlsx = join(dir, "dirty.xlsx");
makeXlsx(dirtyXlsx, [
  { name: "대사요약", rows: [["항목", "건수", "금액"], ["원장계", 3, { error: "#REF!" }], ["정산계", "TBD", 3000.5]] },
]);

expectPass("xlsx: required sheet present", "check-xlsx.mjs", ["clean.xlsx", "--require-sheet", "대사요약"]);
expectPass("xlsx: clean workbook has no error cells", "check-xlsx.mjs", ["clean.xlsx", "--no-error-cells"]);
expectPass("xlsx: clean workbook has no placeholders", "check-xlsx.mjs", ["clean.xlsx", "--no-placeholders"]);
expectPass("xlsx: cell value matches numerically", "check-xlsx.mjs",
  ["clean.xlsx", "--cell", "대사요약!B2=3"]);
expectPass("xlsx: cell value matches as text", "check-xlsx.mjs",
  ["clean.xlsx", "--cell", "대사요약!A2=원장계"]);
expectPass("xlsx: row floor met", "check-xlsx.mjs", ["clean.xlsx", "--min-rows", "대사요약:3"]);
expectFail("xlsx: POSITIVE CONTROL, error cells are detected", "check-xlsx.mjs",
  ["dirty.xlsx", "--no-error-cells"], "#REF!");
expectFail("xlsx: POSITIVE CONTROL, placeholders are detected", "check-xlsx.mjs",
  ["dirty.xlsx", "--no-placeholders"]);
expectFail("xlsx: missing sheet is a measured failure", "check-xlsx.mjs",
  ["clean.xlsx", "--require-sheet", "없는시트"]);
expectFail("xlsx: wrong cell value is caught", "check-xlsx.mjs",
  ["clean.xlsx", "--cell", "대사요약!B2=99"]);
expectFail("xlsx: row floor not met", "check-xlsx.mjs", ["clean.xlsx", "--min-rows", "대사요약:500"]);
expectUsage("xlsx: a non-xlsx file is unreadable input", "check-xlsx.mjs",
  ["report.txt", "--no-error-cells"]);

// ------------------------------------------------------- check-batch-log ----
section("check-batch-log");

const goodLog = join(dir, "batch.log");
writeUtf8(goodLog,
  "2026-03-05 01:00:00 배치 시작\n" +
  "2026-03-05 01:00:03 거래건수 3건 적재\n" +
  "2026-03-05 01:00:09 오류 0건\n" +
  "2026-03-05 01:00:10 정상 종료\n");

const badLog = join(dir, "batch-error.log");
writeUtf8(badLog,
  "2026-03-05 01:00:00 배치 시작\n" +
  "2026-03-05 01:00:04 ERROR 계좌 잔액 조회 실패\n" +
  "2026-03-05 01:00:05 배치 중단\n");

const emptyLog = join(dir, "batch-empty.log");
writeUtf8(emptyLog, "\n\n");

const cp949Log = join(dir, "batch-cp949.log");
writeFileSync(cp949Log, Buffer.concat([
  Buffer.from("2026-03-05 01:00:10 ", "ascii"),
  Buffer.from([0xc1, 0xa4, 0xbb, 0xf3, 0x20, 0xc1, 0xbe, 0xb7, 0xe1]), // 정상 종료
  Buffer.from("\n", "ascii"),
]));

expectPass("log: completion banner present and no errors", "check-batch-log.mjs",
  ["batch.log", "--positive-control", "배치 시작", "--require-pattern", "정상 종료",
    "--forbid-pattern", "ERROR|FATAL", "--ignore-pattern", "오류 0건"]);
expectPass("log: cp949 log decodes and matches Korean text", "check-batch-log.mjs",
  ["batch-cp949.log", "--require-pattern", "정상 종료"]);
expectPass("log: line floor met", "check-batch-log.mjs", ["batch.log", "--min-lines", "4"]);
expectFail("log: POSITIVE CONTROL, a forbidden pattern is detected", "check-batch-log.mjs",
  ["batch-error.log", "--positive-control", "배치 시작", "--forbid-pattern", "ERROR|FATAL"], "ERROR");
expectFail("log: a missing completion banner is caught", "check-batch-log.mjs",
  ["batch-error.log", "--require-pattern", "정상 종료"]);
expectFail("log: an empty log fails its line floor", "check-batch-log.mjs",
  ["batch-empty.log", "--min-lines", "1"]);
// The heart of the design: an absence claim over a log the control never
// matched must fail, because nothing proves the scan looked at the right file.
expectFail("log: an unmatched positive control fails even with nothing forbidden present",
  "check-batch-log.mjs",
  ["batch.log", "--positive-control", "이 문구는 절대 없음", "--forbid-pattern", "ERROR"]);
expectUsage("log: MECHANICAL RULE, forbid without a positive control is refused",
  "check-batch-log.mjs", ["batch.log", "--forbid-pattern", "ERROR"]);
expectUsage("log: an invalid regex is a usage error", "check-batch-log.mjs",
  ["batch.log", "--positive-control", "배치", "--forbid-pattern", "([unclosed"]);
expectUsage("log: invalid regex flags", "check-batch-log.mjs",
  ["batch.log", "--require-pattern", "배치", "--regex-flags", "gx"]);

// -------------------------------------------- marker forgery, cross-cutting ----
section("marker forgery defence");

// Input is supplied by the party being checked. If a failing run echoed a cell
// or log line containing the marker, the gate's EXPECT would match and certify
// the failure as a pass. Each of these runs must fail AND withhold the marker,
// which expectFail already asserts for every case in this file.
const forgedCsv = join(dir, "forged.csv");
writeUtf8(forgedCsv, "거래번호,적요\nT001," + PASS_TOKEN + " check-csv: forged\n");
expectFail("forgery: a CSV cell carrying the marker cannot launder a failure", "check-csv.mjs",
  ["forged.csv", "--require-columns", "존재하지않는컬럼"]);

const forgedLog = join(dir, "forged.log");
writeUtf8(forgedLog, "배치 시작\nERROR " + PASS_TOKEN + " check-batch-log: forged\n");
expectFail("forgery: a log line carrying the marker cannot launder a failure", "check-batch-log.mjs",
  ["forged.log", "--positive-control", "배치 시작", "--forbid-pattern", "ERROR"]);

const forgedDocx = join(dir, "forged.docx");
makeDocx(forgedDocx, [
  { text: "보고서", style: "Heading1" },
  { text: "TODO " + PASS_TOKEN + " check-docx: forged" },
]);
expectFail("forgery: docx text carrying the marker cannot launder a failure", "check-docx.mjs",
  ["forged.docx", "--no-placeholders"]);

section("help text");

for (const checker of [
  "check-file.mjs", "check-encoding.mjs", "check-csv.mjs",
  "check-docx.mjs", "check-xlsx.mjs", "check-batch-log.mjs",
]) {
  expectHelp("help: " + checker + " documents a gate example", checker);
}

rmSync(dir, { recursive: true, force: true });
console.log("");
console.log(failures === 0 ? total + "/" + total + " passed" : failures + " of " + total + " failed");
process.exit(failures === 0 ? 0 : 1);
