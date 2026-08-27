// common.mjs : shared contract for every checker in checks/.
// Zero dependencies. Node 16+.
//
// Every checker in this directory is an oracle for a gate. The gate contract
// requires two things that a hand-written script gets wrong easily, so they are
// centralised here instead of repeated per checker:
//
//   1. A success marker that only a full pass can produce. `ok()` is the single
//      place that prints PASS_TOKEN, and it is called once, after every
//      assertion. No failure path can reach it.
//   2. A failure diagnostic that cannot forge the marker. Checkers read files
//      the caller does not control, so a CSV cell or a log line containing the
//      token would otherwise make a failing gate match its EXPECT. `fail()`
//      redacts the token from everything it echoes.
//
// exit codes: 0 pass, 1 measured failure, 2 usage or unreadable input.

import { readFileSync, statSync } from "node:fs";

// ASCII only. A Korean marker cannot survive a CP949 pipeline intact, and
// EXPECT matches the bytes the shell actually produced.
export const PASS_TOKEN = "UNLAZY-CHECK-OK";

// Written with escapes on purpose. A literal U+2028 or U+2029 inside a regex
// literal is a line terminator to the JavaScript parser and silently breaks
// the file, which is exactly the quiet failure this library exists to catch.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

// Repository-controlled text reaches a terminal and a gate transcript. Strip
// control and bidirectional characters the way the checker engine does, so a
// crafted filename or cell cannot rewrite the surrounding output.
export function clean(value) {
  return String(value).replace(CONTROL, " ");
}

function redact(value) {
  return clean(value).split(PASS_TOKEN).join("[redacted-marker]");
}

export function ok(checker, summary) {
  console.log(PASS_TOKEN + " " + checker + ": " + clean(summary));
  process.exit(0);
}

export function fail(checker, reason, details = []) {
  console.error("CHECK FAILED " + checker + ": " + redact(reason));
  for (const line of details) console.error("  " + redact(line));
  process.exit(1);
}

// A usage error prints the reason and a pointer, never the whole help text.
// The help contains a worked gate example, and that example contains the
// success marker. Dumping it here would put the marker into the output of a
// run that failed, which is precisely what this module promises cannot happen.
// The repository's own gate-lint.mjs resolves it the same way.
export function usage(checker, reason) {
  console.error(checker + ": " + redact(reason));
  console.error("run " + checker + ".mjs --help for usage");
  process.exit(2);
}

// Option parsing is strict on purpose. A misspelled option must not be ignored
// into a weaker check: `--min-rows` silently dropped would leave a gate that
// only proves the file parses.
export function parseArgs(checker, argv, spec, help) {
  const flags = new Set(spec.flags || []);
  const values = new Set(spec.values || []);
  const repeatable = new Set(spec.repeatable || []);
  const opts = Object.create(null);
  const positional = [];
  for (const name of repeatable) opts[name] = [];

  let onlyPositional = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!onlyPositional && arg === "--") { onlyPositional = true; continue; }
    if (!onlyPositional && (arg === "--help" || arg === "-h")) {
      console.log(help);
      process.exit(0);
    }
    if (!onlyPositional && arg.startsWith("-") && arg !== "-") {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      const inline = eq === -1 ? null : arg.slice(eq + 1);
      if (flags.has(name)) {
        if (inline !== null) usage(checker, "option does not take a value: " + name, help);
        opts[name] = true;
        continue;
      }
      if (values.has(name) || repeatable.has(name)) {
        const value = inline !== null ? inline : argv[++i];
        if (value === undefined) usage(checker, "option needs a value: " + name, help);
        if (repeatable.has(name)) opts[name].push(value);
        else if (name in opts) usage(checker, "option given twice: " + name, help);
        else opts[name] = value;
        continue;
      }
      usage(checker, "unknown option " + name, help);
    }
    positional.push(arg);
  }
  return { opts, positional };
}

export function requireInteger(checker, raw, name, help, { min = 0 } = {}) {
  if (!/^-?\d+$/.test(String(raw).trim())) usage(checker, name + " needs an integer, got " + raw, help);
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (parsed < min) usage(checker, name + " must be at least " + min + ", got " + parsed, help);
  return parsed;
}

// Accepts 1,234.56 and (123) as negative, because exported ledgers and Korean
// accounting tools both produce those forms. Returns null when the text is not
// a number at all, which the caller reports as a measured failure.
export function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).trim().replace(/[\s, ]/g, "");
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  if (text.startsWith("+")) text = text.slice(1);
  else if (text.startsWith("-")) { negative = !negative; text = text.slice(1); }
  text = text.replace(/[%₩$]/g, "");
  if (!/^\d*\.?\d+$/.test(text)) return null;
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

export function readBuffer(checker, path, help) {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) usage(checker, "not a regular file: " + path, help);
    return readFileSync(path);
  } catch (error) {
    if (error && error.code === "ENOENT") usage(checker, "file not found: " + path, help);
    if (error && error.code === "EACCES") usage(checker, "file not readable: " + path, help);
    throw error;
  }
}

export const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);

export function hasUtf8Bom(buffer) {
  return buffer.length >= 3 && buffer.subarray(0, 3).equals(BOM_UTF8);
}

// A strict UTF-8 decode is the only reliable way to tell UTF-8 from CP949 here:
// CP949 lead bytes are 0x81-0xFD followed by bytes that almost never form a
// valid UTF-8 sequence, so an invalid decode is strong evidence of CP949.
export function isValidUtf8(buffer) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export function decodeText(checker, buffer, encoding, help) {
  const normalized = String(encoding || "auto").toLowerCase();
  let body = buffer;
  let bom = false;
  if (hasUtf8Bom(body)) { body = body.subarray(3); bom = true; }

  let label = normalized;
  if (normalized === "auto") {
    label = bom || isValidUtf8(body) ? "utf8" : "cp949";
  }
  if (label === "utf8" || label === "utf-8") {
    return { text: new TextDecoder("utf-8").decode(body), encoding: "utf8", bom };
  }
  if (label === "cp949" || label === "euc-kr" || label === "euckr" || label === "ms949") {
    let decoder;
    try {
      decoder = new TextDecoder("euc-kr", { fatal: false });
    } catch {
      usage(checker, "this Node build cannot decode cp949 (needs full-ICU); re-run with --encoding utf8", help);
    }
    return { text: decoder.decode(body), encoding: "cp949", bom };
  }
  usage(checker, "unknown encoding: " + encoding + " (use utf8, cp949, or auto)", help);
}

// Mojibake is what a gate actually suffers from: the file decoded, so no error
// was raised, but the text is wrong and a Korean EXPECT can never match it.
// U+FFFD is a decode casualty; the Latin-1 run is UTF-8 Korean read as CP949.
const MOJIBAKE_RUN = /[À-ÿ][-¿]{1,}/;

export function findMojibake(text) {
  if (text.includes("�")) return "replacement character U+FFFD is present";
  if (MOJIBAKE_RUN.test(text)) return "Latin-1 run typical of UTF-8 Korean decoded as CP949";
  return null;
}

export function pluralRows(count) {
  return count + (count === 1 ? " row" : " rows");
}
