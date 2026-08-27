// fixtures.mjs : build real Office and text fixtures for the checks tests.
// Zero dependencies. Node 16+. Test-only code.
//
// The checkers read .docx and .xlsx, so the tests must present genuine ZIP
// containers rather than mocks. Writing the archives here, with a writer that
// shares no code with checks/lib/zip.mjs, keeps the test independent of the
// reader it is testing: a shared bug cannot cancel itself out.
//
// Fixtures are written with DEFLATE, which is what Word and Excel emit, so the
// inflate path is the path under test.

import { deflateRawSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// entries: [{ name, data: string|Buffer }]
export function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const deflated = deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(8, 8);            // method: deflate
    local.writeUInt16LE(0, 10);           // time
    local.writeUInt16LE(0x2821, 12);      // date: a fixed valid DOS date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    locals.push(local, name, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x2821, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);             // extra
    dir.writeUInt16LE(0, 32);             // comment
    dir.writeUInt16LE(0, 34);             // disk
    dir.writeUInt16LE(0, 36);             // internal attrs
    dir.writeUInt32LE(0, 38);             // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + deflated.length;
  }

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, eocd]);
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

// blocks: [{ text, style?, splitRuns?: true }] and { table: [[cell, cell]] }
export function makeDocx(path, blocks) {
  const body = blocks.map((block) => {
    if (block.table) {
      const rows = block.table.map((row) => {
        const cells = row.map((cell) =>
          `<w:tc><w:p><w:r><w:t>${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`).join("");
        return `<w:tr>${cells}</w:tr>`;
      }).join("");
      return `<w:tbl>${rows}</w:tbl>`;
    }
    const style = block.style ? `<w:pPr><w:pStyle w:val="${escapeXml(block.style)}"/></w:pPr>` : "";
    // splitRuns reproduces Word's habit of breaking one visible word across
    // several runs, which is what defeats naive substring search on raw XML.
    const runs = block.splitRuns
      ? [...String(block.text)].map((ch) => `<w:r><w:t xml:space="preserve">${escapeXml(ch)}</w:t></w:r>`).join("")
      : `<w:r><w:t xml:space="preserve">${escapeXml(block.text)}</w:t></w:r>`;
    return `<w:p>${style}${runs}</w:p>`;
  }).join("");

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr/></w:body>
</w:document>`;

  const buffer = buildZip([
    { name: "[Content_Types].xml", data: DOCX_CONTENT_TYPES },
    { name: "_rels/.rels", data: DOCX_RELS },
    { name: "word/document.xml", data: document },
  ]);
  writeFileSync(path, buffer);
  return buffer;
}

const XLSX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>`;

const XLSX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

function columnName(index) {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

// sheets: [{ name, rows: [[value, ...]] }]
// A cell value may be a number, a string, or { error: "#REF!" }.
// Strings go through sharedStrings, which is what Excel actually does and what
// forces the checker to resolve the index rather than reading a literal.
export function makeXlsx(path, sheets) {
  const shared = [];
  const sharedIndex = new Map();
  const intern = (text) => {
    if (sharedIndex.has(text)) return sharedIndex.get(text);
    const index = shared.length;
    shared.push(text);
    sharedIndex.set(text, index);
    return index;
  };

  const sheetParts = sheets.map((sheet, sheetNumber) => {
    const rows = sheet.rows.map((row, rowIndex) => {
      const cells = row.map((value, colIndex) => {
        if (value === null || value === undefined || value === "") return "";
        const ref = columnName(colIndex) + (rowIndex + 1);
        if (typeof value === "object" && value.error) {
          return `<c r="${ref}" t="e"><v>${escapeXml(value.error)}</v></c>`;
        }
        if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
        return `<c r="${ref}" t="s"><v>${intern(String(value))}</v></c>`;
      }).filter(Boolean).join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join("");
    return {
      path: `xl/worksheets/sheet${sheetNumber + 1}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    };
  });

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) =>
    `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((s, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}
<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">
${shared.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join("")}
</sst>`;

  const buffer = buildZip([
    { name: "[Content_Types].xml", data: XLSX_CONTENT_TYPES },
    { name: "_rels/.rels", data: XLSX_RELS },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/sharedStrings.xml", data: sharedStrings },
    ...sheetParts.map((p) => ({ name: p.path, data: p.data })),
  ]);
  writeFileSync(path, buffer);
  return buffer;
}

// Encodes Korean text as CP949 using a small table built from the round trip
// that Node itself can perform. Node decodes euc-kr but cannot encode it, so
// the fixture carries the bytes for the few strings the tests need.
export const CP949 = {
  // "일일 점검 결과: 정상 종료" and friends, as CP949 bytes.
  "정상 종료": Buffer.from([0xc1, 0xa4, 0xbb, 0xf3, 0x20, 0xc1, 0xbe, 0xb7, 0xe1]),
  "오류 발생": Buffer.from([0xbf, 0xc0, 0xb7, 0xf9, 0x20, 0xb9, 0xdf, 0xbb, 0xfd]),
  "거래건수": Buffer.from([0xb0, 0xc5, 0xb7, 0xa1, 0xb0, 0xc7, 0xbc, 0xf6]),
};

export function writeBytes(path, buffer) {
  writeFileSync(path, buffer);
}

export function writeUtf8(path, text, { bom = false } = {}) {
  const body = Buffer.from(text, "utf8");
  writeFileSync(path, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body);
}
