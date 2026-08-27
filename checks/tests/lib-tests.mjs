// lib-tests.mjs : behaviour tests for the shared checker libraries.
// Zero dependencies. Node 16+.
//
// These test the reading side (checks/lib/) against archives built by the
// writing side (checks/tests/fixtures.mjs), which share no code. The fixtures
// deliberately reproduce the two Office habits that defeat naive extraction:
// a visible word split across many runs, and strings interned into
// sharedStrings.xml rather than written into the cell.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDocx, makeXlsx } from "./fixtures.mjs";
import { openZip, readEntryText, entryNames, ZipError } from "../lib/zip.mjs";
import {
  docxParagraphs, isHeadingStyle, countDocxTables,
  xlsxSharedStrings, xlsxCells, xlsxSheetMap, cellRow, decodeEntities,
} from "../lib/xml.mjs";
import { parseNumber, clean, isValidUtf8, hasUtf8Bom, findMojibake } from "../lib/common.mjs";

const dir = mkdtempSync(join(tmpdir(), "unlazy-checks-lib-"));
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

// ---------------------------------------------------------------- common ----
check("common: parseNumber handles grouped decimals", parseNumber("1,234.56") === 1234.56);
check("common: parseNumber handles accounting negatives", parseNumber("(500)") === -500);
check("common: parseNumber rejects text", parseNumber("abc") === null);
check("common: parseNumber rejects empty", parseNumber("   ") === null);
check("common: parseNumber keeps zero", parseNumber("0") === 0);
check("common: clean strips control and bidi", clean("ab‮c") === "a b c", JSON.stringify(clean("ab‮c")));
check("common: clean keeps Korean intact", clean("정상 종료") === "정상 종료");
check("common: isValidUtf8 accepts Korean utf8", isValidUtf8(Buffer.from("정상", "utf8")));
check("common: isValidUtf8 rejects cp949 bytes", !isValidUtf8(Buffer.from([0xc1, 0xa4, 0xbb, 0xf3])));
check("common: hasUtf8Bom", hasUtf8Bom(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x")])));
check("common: findMojibake flags replacement char", findMojibake("보고서�") !== null);
check("common: findMojibake passes clean Korean", findMojibake("보고서 정상") === null);

// ------------------------------------------------------------------- xml ----
check("xml: decodeEntities named", decodeEntities("R&amp;D") === "R&D");
check("xml: decodeEntities numeric", decodeEntities("&#54620;&#44397;") === "한국");
check("xml: decodeEntities hex", decodeEntities("&#xD55C;") === "한");
check("xml: decodeEntities leaves unknown alone", decodeEntities("&bogus;") === "&bogus;");
check("xml: isHeadingStyle matches Word ids", isHeadingStyle("Heading1") && isHeadingStyle("Title"));
check("xml: isHeadingStyle matches Korean style ids", isHeadingStyle("제목 1"));
check("xml: isHeadingStyle rejects body", !isHeadingStyle("Normal") && !isHeadingStyle(""));
check("xml: cellRow reads the row number", cellRow("AB123") === 123);

// ------------------------------------------------------------------ docx ----
const docxPath = join(dir, "report.docx");
makeDocx(docxPath, [
  { text: "일일 점검 보고서", style: "Heading1" },
  { text: "1. 개요", style: "Heading2" },
  { text: "본 보고서는 R&D 예산 <금액> 집행 내역을 정리한다.", splitRuns: true },
  { text: "2. 결론", style: "Heading2" },
  { text: "특이사항 없음. TODO: 검토 필요" },
  { table: [["항목", "금액"], ["예산", "1,000"]] },
]);
const dzip = openZip(readFileSync(docxPath));
check("zip: docx central directory lists the main part", entryNames(dzip).includes("word/document.xml"));
const documentXml = readEntryText(dzip, "word/document.xml");
const paragraphs = docxParagraphs(documentXml);
const headings = paragraphs.filter((p) => isHeadingStyle(p.style));
check("docx: paragraphs extracted", paragraphs.length >= 5, "got " + paragraphs.length);
check("docx: three styled headings", headings.length === 3, "got " + headings.length);
check("docx: split runs rejoin into one word",
  paragraphs.some((p) => p.text.includes("R&D 예산")),
  JSON.stringify(paragraphs.map((p) => p.text)));
check("docx: entities decoded in body text", paragraphs.some((p) => p.text.includes("R&D")));
check("docx: angle placeholder survives extraction", paragraphs.some((p) => p.text.includes("<금액>")));
check("docx: table counted", countDocxTables(documentXml) === 1);
check("docx: style ids never leak into text",
  !paragraphs.some((p) => p.text.includes("Heading")),
  JSON.stringify(paragraphs.map((p) => p.text)));

// ------------------------------------------------------------------ xlsx ----
const xlsxPath = join(dir, "book.xlsx");
makeXlsx(xlsxPath, [
  { name: "요약", rows: [["항목", "금액"], ["예산", 1000], ["집행", { error: "#REF!" }]] },
  { name: "Sheet2", rows: [["a", "b"], ["c", "TBD"]] },
]);
const xzip = openZip(readFileSync(xlsxPath));
const sheets = xlsxSheetMap(
  readEntryText(xzip, "xl/workbook.xml"),
  readEntryText(xzip, "xl/_rels/workbook.xml.rels"));
check("xlsx: both sheets mapped", sheets.length === 2, JSON.stringify(sheets));
check("xlsx: Korean sheet name preserved", sheets[0] && sheets[0].name === "요약", JSON.stringify(sheets));
check("xlsx: relationship resolved to a part path",
  sheets[0] && sheets[0].path === "xl/worksheets/sheet1.xml", JSON.stringify(sheets));
const sharedStrings = xlsxSharedStrings(readEntryText(xzip, "xl/sharedStrings.xml"));
const cells = xlsxCells(readEntryText(xzip, sheets[0].path), sharedStrings);
check("xlsx: shared string resolved through its index",
  cells.some((c) => c.ref === "A1" && c.value === "항목"), JSON.stringify(cells));
check("xlsx: numeric cell value", cells.some((c) => c.ref === "B2" && c.value === "1000"));
const errorCell = cells.find((c) => c.type === "e");
check("xlsx: error cell keeps type e and its code",
  !!errorCell && errorCell.value === "#REF!", JSON.stringify(cells));
const sheet2 = xlsxCells(readEntryText(xzip, sheets[1].path), sharedStrings);
check("xlsx: second sheet read independently", sheet2.some((c) => c.value === "TBD"));

// ------------------------------------------------------- zip failure paths ----
let threw = null;
try { openZip(Buffer.from("not a zip at all")); } catch (error) { threw = error; }
check("zip: a non-archive fails closed with ZipError", threw instanceof ZipError, String(threw));

threw = null;
const truncated = readFileSync(docxPath).subarray(0, 40);
try { openZip(truncated); } catch (error) { threw = error; }
check("zip: a truncated archive fails closed", threw instanceof ZipError, String(threw));

threw = null;
try { readEntryText(dzip, "word/missing.xml"); } catch (error) { threw = error; }
check("zip: a missing entry fails closed", threw instanceof ZipError, String(threw));

rmSync(dir, { recursive: true, force: true });
console.log("");
console.log(failures === 0 ? total + "/" + total + " passed" : failures + " of " + total + " failed");
process.exit(failures === 0 ? 0 : 1);
