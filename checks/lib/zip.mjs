// zip.mjs : minimal read-only ZIP reader for Office files.
// Zero dependencies. Node 16+.
//
// .docx and .xlsx are ZIP containers of XML. Node ships the only hard part
// (raw DEFLATE) in node:zlib, so reading them needs no third-party package and
// keeps the checks directory installable inside an air-gapped network.
//
// This reads the central directory rather than scanning for local headers,
// because only the central directory is authoritative about what the archive
// declares. Anything it cannot model exactly, including ZIP64 and encryption,
// fails closed with a named reason instead of returning partial content.

import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const MAX_COMMENT = 0xffff;

export class ZipError extends Error {}

function findEocd(buffer) {
  const minimum = 22;
  if (buffer.length < minimum) throw new ZipError("file is too small to be a ZIP archive");
  const earliest = Math.max(0, buffer.length - minimum - MAX_COMMENT);
  for (let i = buffer.length - minimum; i >= earliest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      // The comment length must account for every remaining byte, otherwise
      // this is a coincidental signature inside compressed data.
      const commentLength = buffer.readUInt16LE(i + 20);
      if (i + minimum + commentLength === buffer.length) return i;
    }
  }
  throw new ZipError("no ZIP end-of-central-directory record found");
}

export function openZip(buffer) {
  const eocd = findEocd(buffer);
  if (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR) {
    throw new ZipError("ZIP64 archives are not supported by this reader");
  }
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralStart = buffer.readUInt32LE(eocd + 16);
  if (centralStart === 0xffffffff || centralSize === 0xffffffff || entryCount === 0xffff) {
    throw new ZipError("ZIP64 fields present; this reader supports standard ZIP only");
  }
  if (centralStart + centralSize > buffer.length) {
    throw new ZipError("central directory extends past the end of the file");
  }

  const entries = new Map();
  let offset = centralStart;
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > buffer.length) throw new ZipError("truncated central directory entry");
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipError("bad central directory signature at entry " + i);
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (flags & 0x1) throw new ZipError("encrypted entry is not readable: " + name);
    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { buffer, entries };
}

export function hasEntry(zip, name) {
  return zip.entries.has(name);
}

export function entryNames(zip) {
  return [...zip.entries.keys()];
}

export function readEntry(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) throw new ZipError("archive has no entry named " + name);
  const { buffer } = zip;
  const local = entry.localOffset;
  if (local + 30 > buffer.length) throw new ZipError("truncated local header for " + name);
  if (buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw new ZipError("bad local header signature for " + name);
  }
  // The local header repeats the name and extra lengths, and they may differ
  // from the central directory values. Only the local pair locates the data.
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new ZipError("compressed data extends past the end of the file: " + name);
  const raw = buffer.subarray(start, end);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method !== 8) throw new ZipError("unsupported compression method " + entry.method + " for " + name);
  let inflated;
  try {
    inflated = inflateRawSync(raw);
  } catch (error) {
    throw new ZipError("cannot inflate " + name + ": " + (error && error.message));
  }
  if (entry.uncompressedSize !== 0 && inflated.length !== entry.uncompressedSize) {
    throw new ZipError("inflated size mismatch for " + name);
  }
  return inflated;
}

export function readEntryText(zip, name) {
  return readEntry(zip, name).toString("utf8");
}
