#!/usr/bin/env node
// check-encoding.mjs : prove a file carries the encoding the next step expects.
// Zero dependencies. Node 16+.
//
// This checker exists because encoding damage is silent. A CSV written as CP949
// and read as UTF-8 raises no error anywhere: the reader either substitutes
// U+FFFD or hands the next stage a string of Latin-1 rubble, and every gate
// after that point faithfully measures the rubble. Row counts still match,
// totals still add up, the file still opens. Catching the damage at the file
// boundary costs one stat and one read; catching it three gates later costs an
// afternoon. On Windows, where the console code page is CP949 and files move
// between tools that disagree about defaults, the boundary is the only cheap
// place to look.
//
// What this checker CANNOT prove:
//   - That a file "is" any encoding. Encoding is not recorded in the bytes, so
//     every answer here is INFERENCE from byte patterns, not metadata read back
//     from the file. There is no field to consult and no authority to ask.
//   - Anything at all about a short ASCII-only file. "date,amount" is valid
//     UTF-8 and valid CP949 and valid Latin-1 simultaneously, and no
//     examination of those bytes can separate them, now or ever. Such a file is
//     reported as ascii, which is a statement about its bytes and not about the
//     intent of whatever wrote it.
//   - That a file failing a strict UTF-8 decode is Korean text. It could be
//     CP949, Shift_JIS, Latin-1, a JPEG or a truncated ZIP. That is why the
//     detected label is cp949-or-binary and not cp949.
//   - That text which decodes cleanly is correct. --no-mojibake catches the two
//     classic damage signatures, U+FFFD and the Latin-1 run left by UTF-8
//     Korean read as CP949. Text mangled some other way decodes without
//     complaint and passes.
//   - That the producer will keep doing this. The measurement covers the bytes
//     on disk at this instant, not the pipeline that wrote them.
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
  hasUtf8Bom,
  isValidUtf8,
  decodeText,
  findMojibake,
} from "./lib/common.mjs";

const CHECKER = "check-encoding";

const HELP = `usage: check-encoding.mjs [options] <path ...>

Measure the encoding of one or more files and report, per file, the detected
encoding, whether a UTF-8 BOM is present, and the byte size. Takes many paths on
purpose, so one gate can assert that a whole output directory is consistent.

With neither --expect nor --consistent this is a SURVEY: it reports what each
file looks like and passes. A gate must not rely on the survey form, because it
asserts nothing about encoding. Use --expect or --consistent to make it an
oracle.

options:
  --expect KIND     require every named file to be KIND, one of:
                      utf8      the bytes decode as strict UTF-8. A BOM is
                                allowed unless --no-bom is also given. Pure
                                ASCII passes, being valid UTF-8.
                      utf8-bom  valid UTF-8 AND a leading EF BB BF BOM.
                      cp949     high bytes are present AND a strict UTF-8 decode
                                fails. A pure ASCII file cannot be PROVEN to be
                                CP949, because those bytes are identical in both
                                encodings, so it is reported as ascii and passes
                                rather than failing. Pass --strict-cp949 to
                                treat that ambiguity as a failure instead.
                      ascii     every byte is below 0x80.
  --no-bom          fail if a UTF-8 BOM is present. A BOM matters: it makes the
                    first CSV header cell read as "\\ufeffdate" instead of
                    "date", so naive header parsing misses the column, and it
                    breaks a shell script's shebang line.
  --require-bom     fail if a UTF-8 BOM is absent. Excel on Windows needs one to
                    open a UTF-8 CSV as Korean instead of CP949. Mutually
                    exclusive with --no-bom.
  --strict-cp949    with --expect cp949, treat a pure ASCII file as a failure
                    instead of reporting it as ascii.
  --no-mojibake     decode with the expected encoding, or with the detected one
                    when no --expect is given, then fail if the text shows
                    mojibake damage, reporting which signature was found.
  --max-bytes N     per-file ceiling, so a gate over a directory does not read a
                    huge file by accident. A file above the ceiling fails and is
                    NOT read. Default 0, meaning unlimited.
  --consistent      assert that every named file shares the SAME detected
                    encoding, and report which one. The cheap check for "did
                    this export write mixed encodings". Requires no --expect.
                    Pure ASCII files never break the group, since their bytes
                    are compatible with every encoding here. utf8 and utf8-bom
                    ARE different for this purpose, on purpose: a directory
                    where Excel wrote the BOM and a script did not is exactly
                    the mixed output this flag is for.
  -h, --help        print this help

UTF-16 fails --expect and --consistent, whatever the expected kind, and is
detected from a leading FF FE or FE FF or from a high proportion of NUL bytes in
the first 512. This is the single most useful thing this checker can tell you on
Windows: UTF-16LE is what you get by ACCIDENT there. Windows PowerShell 5.1
redirection (cmd > out.txt) and Out-File without -Encoding both write UTF-16LE,
which every UTF-8 reader downstream sees as NUL-riddled nonsense and which no
amount of CP949 or UTF-8 debugging will explain. If this checker reports
utf-16le on a file you meant to be UTF-8, fix the producer: use
Out-File -Encoding utf8 or Set-Content -Encoding utf8, not the bare redirect.

All failing assertions across all files are reported together, not just the
first one.

exit codes: 0 pass, 1 measured failure, 2 usage or unreadable input.

gate example:
  CHECK: node checks/check-encoding.mjs --expect utf8 --no-bom --no-mojibake out/trades.csv out/positions.csv
  EXPECT: ${PASS_TOKEN} ${CHECKER}`;

const SPEC = {
  flags: ["--no-bom", "--require-bom", "--strict-cp949", "--no-mojibake", "--consistent"],
  values: ["--expect", "--max-bytes"],
};

const { opts, positional } = parseArgs(CHECKER, process.argv.slice(2), SPEC, HELP);

if (positional.length === 0) usage(CHECKER, "needs at least one file path, got none", HELP);

const EXPECT_KINDS = ["utf8", "utf8-bom", "cp949", "ascii"];

// Every option is validated before any file is touched, so a typo in the gate
// reports as a usage error instead of hiding behind a read failure, and a
// combination no file could satisfy is rejected rather than silently failing.
let expected = null;
if ("--expect" in opts) {
  expected = String(opts["--expect"]).trim().toLowerCase();
  if (!EXPECT_KINDS.includes(expected)) {
    usage(CHECKER, "--expect must be one of " + EXPECT_KINDS.join(", ") + ", got " + opts["--expect"], HELP);
  }
}

const wantNoBom = opts["--no-bom"] === true;
const wantRequireBom = opts["--require-bom"] === true;
const strictCp949 = opts["--strict-cp949"] === true;
const wantNoMojibake = opts["--no-mojibake"] === true;
const wantConsistent = opts["--consistent"] === true;

if (wantNoBom && wantRequireBom) {
  usage(CHECKER, "--no-bom and --require-bom are mutually exclusive, no file could pass both", HELP);
}
if (wantConsistent && expected !== null) {
  usage(CHECKER, "--consistent requires no --expect: it asserts the files agree with each other, not with a named kind", HELP);
}
if (strictCp949 && expected !== "cp949") {
  usage(CHECKER, "--strict-cp949 only means something with --expect cp949, and would otherwise be silently ignored", HELP);
}
if (wantNoBom && expected === "utf8-bom") {
  usage(CHECKER, "--no-bom contradicts --expect utf8-bom, no file could pass", HELP);
}
if (wantRequireBom && (expected === "ascii" || expected === "cp949")) {
  usage(CHECKER, "--require-bom contradicts --expect " + expected + ": the BOM bytes EF BB BF are high bytes and mark the file as UTF-8, so no file could pass", HELP);
}

const maxBytes = "--max-bytes" in opts
  ? requireInteger(CHECKER, opts["--max-bytes"], "--max-bytes", HELP, { min: 0 })
  : 0;

// UTF-16 is checked before anything else, because FF FE is not a UTF-8 BOM and
// would otherwise land in cp949-or-binary, which hides the one Windows cause a
// user can act on immediately.
const NUL_SAMPLE_BYTES = 512;
const NUL_SAMPLE_MIN = 16;
const NUL_RATIO = 0.2;

function detectUtf16(buffer) {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return { label: "utf-16le", why: "leading FF FE byte order mark, or FF FE 00 00 for UTF-32LE" };
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return { label: "utf-16be", why: "leading FE FF byte order mark" };
    }
  }
  const sample = buffer.subarray(0, NUL_SAMPLE_BYTES);
  if (sample.length < NUL_SAMPLE_MIN) return null;
  let nuls = 0;
  let odd = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0x00) {
      nuls += 1;
      if (i % 2 === 1) odd += 1;
    }
  }
  const ratio = nuls / sample.length;
  if (ratio < NUL_RATIO) return null;
  const why = Math.round(ratio * 100) + "% NUL bytes in the first " + sample.length + " bytes, no BOM";
  // Western text as UTF-16LE puts the NUL of each unit at an odd offset, and as
  // UTF-16BE at an even one. Mixed offsets mean this is probably not text.
  if (nuls > 0 && odd === nuls) return { label: "utf-16le", why: why + ", all at odd offsets" };
  if (odd === 0) return { label: "utf-16be", why: why + ", all at even offsets" };
  return { label: "utf-16?", why: why + ", offsets mixed, so this is UTF-16 or a binary file" };
}

// Order matters and is the whole method: BOM, then pure ASCII, then a strict
// UTF-8 decode, and only what survives all three is called cp949-or-binary.
function detect(buffer) {
  if (hasUtf8Bom(buffer)) return "utf8-bom";
  if (firstHighByte(buffer) === -1) return "ascii";
  return isValidUtf8(buffer) ? "utf8" : "cp949-or-binary";
}

function firstHighByte(buffer) {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] >= 0x80) return i;
  }
  return -1;
}

// The encoding to decode with for --no-mojibake: what the gate asked for, or
// failing that, what the bytes look like. Decoding with the wrong one would
// manufacture the very damage this flag reports.
function mojibakeEncoding(kind, label) {
  if (kind === "cp949") return "cp949";
  if (kind !== null) return "utf8";
  return label === "cp949-or-binary" ? "cp949" : "utf8";
}

function statFile(path) {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) usage(CHECKER, "not a regular file: " + path, HELP);
    return stats;
  } catch (error) {
    if (error && error.code === "ENOENT") usage(CHECKER, "file not found: " + path, HELP);
    if (error && error.code === "EACCES") usage(CHECKER, "file not readable: " + path, HELP);
    throw error;
  }
}

const asserting = expected !== null || wantConsistent;
const records = [];
const failures = [];

for (const path of positional) {
  const stats = statFile(path);

  // The ceiling is enforced from the stat, before the read, which is the only
  // way it can protect a gate that globbed a directory holding a 2 GB dump.
  if (maxBytes > 0 && stats.size > maxBytes) {
    records.push({ path, size: stats.size, label: "not read", bom: null, skipped: true });
    failures.push(path + ": " + stats.size + " bytes is above --max-bytes " + maxBytes + ", so the file was not read or classified");
    continue;
  }

  const buffer = readBuffer(CHECKER, path, HELP);
  const bom = hasUtf8Bom(buffer);
  const body = bom ? buffer.subarray(3) : buffer;
  const validUtf8 = isValidUtf8(body);
  const utf16 = detectUtf16(buffer);
  const label = utf16 ? utf16.label : detect(buffer);
  // bom reports the UTF-8 BOM, which is what --no-bom and --require-bom are
  // about. A UTF-16 file usually carries a BOM of its own, and printing "no"
  // for it would read as "this file has no byte order mark", so it is named.
  const bomLabel = bom ? "yes" : (utf16 && utf16.why.includes("byte order mark") ? "utf-16-bom-not-utf-8" : "no");
  records.push({ path, size: buffer.length, label, bom, bomLabel, skipped: false });

  if (utf16 && asserting) {
    failures.push(
      path + ": detected " + label + " (" + utf16.why + "), which cannot satisfy any expected encoding. "
      + "On Windows this is usually PowerShell redirection or Out-File without -Encoding; "
      + "re-run the producer with Out-File -Encoding utf8 or Set-Content -Encoding utf8",
    );
  }

  if (expected !== null && !utf16) {
    if (expected === "utf8") {
      if (!validUtf8) {
        failures.push(path + ": expected utf8, but a strict UTF-8 decode failed, detected " + label);
      }
    } else if (expected === "utf8-bom") {
      if (!bom) failures.push(path + ": expected utf8-bom, but no EF BB BF BOM is present, detected " + label);
      else if (!validUtf8) failures.push(path + ": expected utf8-bom, the BOM is present but a strict UTF-8 decode of the remaining bytes failed");
    } else if (expected === "cp949") {
      if (label === "ascii") {
        if (strictCp949) {
          failures.push(path + ": expected cp949, but every byte is below 0x80, so CP949 cannot be proven from these bytes (--strict-cp949)");
        }
      } else if (label !== "cp949-or-binary") {
        failures.push(path + ": expected cp949, but the bytes decode as strict UTF-8, detected " + label);
      }
    } else if (expected === "ascii") {
      if (label !== "ascii") {
        const at = firstHighByte(buffer);
        const where = at === -1
          ? "detected " + label
          : "first byte at or above 0x80 is 0x" + buffer[at].toString(16).padStart(2, "0") + " at offset " + at;
        failures.push(path + ": expected ascii, detected " + label + ", " + where);
      }
    }
  }

  // The BOM flags are independent assertions and apply whatever --expect says,
  // including in survey mode, where they are the only assertion being made.
  if (wantNoBom && bom) {
    failures.push(path + ": a UTF-8 BOM (EF BB BF) is present and --no-bom was given");
  }
  if (wantRequireBom && !bom) {
    failures.push(path + ": no UTF-8 BOM (EF BB BF) is present and --require-bom was given");
  }

  if (wantNoMojibake && !utf16) {
    const decodeAs = mojibakeEncoding(expected, label);
    const decoded = decodeText(CHECKER, buffer, decodeAs, HELP);
    const reason = findMojibake(decoded.text);
    if (reason) failures.push(path + ": decoded as " + decodeAs + " and found mojibake, " + reason);
  }
}

// Consistency is judged across every file that was actually read. ASCII is
// deliberately not a group of its own: its bytes are identical under UTF-8 and
// CP949, so an ASCII header file sitting beside Korean CP949 exports is not
// evidence of a mixed export, and failing on it would train users to ignore
// this flag.
let sharedLabel = null;
if (wantConsistent) {
  const readable = records.filter((record) => !record.skipped);
  const groups = new Map();
  for (const record of readable) {
    if (record.label === "ascii") continue;
    if (!groups.has(record.label)) groups.set(record.label, []);
    groups.get(record.label).push(record.path);
  }
  if (groups.size > 1) {
    failures.push("files do not share one encoding, found " + groups.size + " distinct encodings among " + readable.length + " file(s):");
    for (const [label, paths] of groups) failures.push("  " + label + ": " + paths.join(", "));
    sharedLabel = "mixed";
  } else if (groups.size === 1) {
    sharedLabel = [...groups.keys()][0];
  } else {
    sharedLabel = "ascii";
  }
}

const measured = records.map((record) => {
  if (record.skipped) return record.path + " " + record.size + " bytes, not read";
  return record.path + " " + record.label + ", bom=" + record.bomLabel + ", " + record.size + " bytes";
});

if (failures.length) {
  fail(
    CHECKER,
    failures.length + " encoding failure(s) across " + positional.length + " file(s)",
    failures.concat(["measured: " + measured.join("; ")]),
  );
}

let headline;
if (expected !== null) {
  headline = positional.length + " file(s) match --expect " + expected;
} else if (wantConsistent) {
  const detail = sharedLabel === "ascii"
    ? "ascii, meaning every file is pure ASCII, which is valid UTF-8 and valid CP949 at once, so this proves only that none of them carries a high byte"
    : sharedLabel;
  headline = positional.length + " file(s) share encoding " + detail;
  if (positional.length === 1) headline += " (one file, so consistency is trivially true)";
} else {
  headline = "survey of " + positional.length + " file(s), no encoding assertion requested";
}

const notes = [];
if (wantNoBom) notes.push("no UTF-8 BOM present");
if (wantRequireBom) notes.push("UTF-8 BOM present on every file");
if (wantNoMojibake) notes.push("no mojibake signature found");
if (maxBytes > 0) notes.push("every file at or below " + maxBytes + " bytes");
if (notes.length) headline += ", " + notes.join(", ");

ok(CHECKER, headline + ": " + measured.join("; "));
