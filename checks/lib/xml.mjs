// xml.mjs : targeted extraction from Office XML parts.
// Zero dependencies. Node 16+.
//
// This is not a general XML parser and does not pretend to be one. Office
// parts are machine-generated with a narrow, stable shape, and the checkers
// only need text, paragraph boundaries, styles, and cell values. A regular
// expression pass over that shape is honest about its own limits; a homemade
// general parser would not be.
//
// Two rules keep the extraction from lying to a gate:
//   - Decode entities. `&amp;` in the part is `&` in the document, and a gate
//     searching for "R&D" must match the document, not the markup.
//   - Never let tag text leak into the extracted string. Searching raw XML for
//     a word would match attribute names and style ids that no reader sees.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function textOfRuns(fragment) {
  let out = "";
  const re = /<w:(t|delText)(?:\s[^>]*)?>([\s\S]*?)<\/w:\1>/g;
  let match;
  while ((match = re.exec(fragment)) !== null) {
    if (match[1] === "delText") continue; // tracked deletion: not visible text
    out += decodeEntities(match[2]);
  }
  // Word encodes tabs and breaks as empty elements, so they carry no run text.
  return out.replace(/\s+/g, " ").trim();
}

// Returns one record per paragraph: its visible text and its style id.
// Word writes built-in heading styles as Heading1..Heading9; the Korean UI
// writes the same ids, but a template can localise them, so callers should
// treat style matching as a hint and text matching as the assertion.
export function docxParagraphs(documentXml) {
  const body = documentXml.replace(/^[\s\S]*?<w:body[^>]*>/, "").replace(/<\/w:body>[\s\S]*$/, "");
  const paragraphs = [];
  const re = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p(?:\s[^>]*)?\/>/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const inner = match[1] || "";
    const styleMatch = /<w:pStyle\s[^>]*w:val="([^"]*)"/.exec(inner);
    const style = styleMatch ? decodeEntities(styleMatch[1]) : "";
    paragraphs.push({ text: textOfRuns(inner), style });
  }
  return paragraphs;
}

export function isHeadingStyle(style) {
  return /^(Heading[1-9]|Title|Subtitle|제목\s*[1-9]?|표제)/i.test(style);
}

export function countDocxTables(documentXml) {
  const matches = documentXml.match(/<w:tbl(?:\s[^>]*)?>/g);
  return matches ? matches.length : 0;
}

export function xlsxSharedStrings(sharedStringsXml) {
  if (!sharedStringsXml) return [];
  const strings = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g;
  let match;
  while ((match = re.exec(sharedStringsXml)) !== null) {
    const inner = match[1] || "";
    let value = "";
    const textRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let piece;
    while ((piece = textRe.exec(inner)) !== null) value += decodeEntities(piece[1]);
    strings.push(value);
  }
  return strings;
}

// Cell values come back as text plus a type, because a gate asking whether a
// cell equals "0" must not silently accept an error code that formats the same
// way. Type `e` is an Excel error such as #REF! or #DIV/0!.
export function xlsxCells(sheetXml, sharedStrings) {
  const cells = [];
  const re = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match;
  while ((match = re.exec(sheetXml)) !== null) {
    const attrs = match[1] || "";
    const inner = match[2] || "";
    const refMatch = /\br="([A-Z]+\d+)"/.exec(attrs);
    if (!refMatch) continue;
    const typeMatch = /\bt="([^"]+)"/.exec(attrs);
    const type = typeMatch ? typeMatch[1] : "n";
    let value = "";
    if (type === "inlineStr") {
      const textRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
      let piece;
      while ((piece = textRe.exec(inner)) !== null) value += decodeEntities(piece[1]);
    } else {
      const valueMatch = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
      const raw = valueMatch ? decodeEntities(valueMatch[1]) : "";
      if (type === "s") {
        const index = Number.parseInt(raw, 10);
        value = Number.isInteger(index) && index >= 0 && index < sharedStrings.length ? sharedStrings[index] : "";
      } else {
        value = raw;
      }
    }
    cells.push({ ref: refMatch[1], type, value });
  }
  return cells;
}

export function cellRow(ref) {
  const match = /\d+$/.exec(ref);
  return match ? Number.parseInt(match[0], 10) : 0;
}

// Maps sheet names to their part paths through the workbook relationships,
// because sheet order in workbook.xml does not have to match sheet1.xml naming.
export function xlsxSheetMap(workbookXml, relsXml) {
  const relations = new Map();
  const relRe = /<Relationship\s([^>]*?)\/>/g;
  let match;
  while ((match = relRe.exec(relsXml || "")) !== null) {
    const attrs = match[1];
    const id = /\bId="([^"]+)"/.exec(attrs);
    const target = /\bTarget="([^"]+)"/.exec(attrs);
    if (id && target) relations.set(id[1], decodeEntities(target[1]));
  }
  const sheets = [];
  const sheetRe = /<sheet\s([^>]*?)\/>/g;
  while ((match = sheetRe.exec(workbookXml || "")) !== null) {
    const attrs = match[1];
    const name = /\bname="([^"]*)"/.exec(attrs);
    const rid = /\br:id="([^"]+)"/.exec(attrs);
    if (!name) continue;
    let target = rid ? relations.get(rid[1]) : undefined;
    if (target === undefined) continue;
    if (target.startsWith("/")) target = target.slice(1);
    else if (!target.startsWith("xl/")) target = "xl/" + target;
    sheets.push({ name: decodeEntities(name[1]), path: target.replace(/^xl\/\.\.\//, "") });
  }
  return sheets;
}
