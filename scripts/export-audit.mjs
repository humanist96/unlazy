#!/usr/bin/env node
// export-audit.mjs : bundle unlazy's own records into an audit artefact.
// Zero dependencies. Node 16+. Fork-local, not part of upstream unlazy.
//
// Why this exists. A regulated organisation asks a different question from a
// developer. Not "did it pass" but "show me who accepted what, on which
// evidence, and prove the record was not edited afterwards". unlazy already
// writes every piece of that: ledgers hold gate states and evidence, the
// approval store holds what was consented to and when, the status log holds an
// append-only event trail, and dispatch state holds launch history. They are
// simply scattered across three locations, two of them outside the repository.
//
// This reads all of it and emits one artefact. It is strictly read-only. It
// never executes a CHECK, never writes to the approval store, and never edits a
// ledger, so running it can neither repair nor damage the thing it reports on.
//
// It parses ledgers with the checker's own parser, so the report cannot
// disagree with the checker about what a ledger says. A second implementation
// would eventually drift, and an audit trail that contradicts the tool it
// audits is worse than no audit trail.
//
//   node scripts/export-audit.mjs [options] [ledger.md ...]
//
// exit codes: 0 exported, 2 usage or unreadable input.
// The exit code reports whether the export succeeded, not whether the gates
// passed. Findings live in the report.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, userInfo, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGates, gateState, qualify } from "./lib/gates.mjs";

const SELF = "export-audit";
const HELP = `usage: export-audit.mjs [options] [ledger.md ...]

Bundle ledgers, approval records, the status log and dispatch state into one
audit artefact. Read-only: never executes a CHECK and never edits a ledger.

  --format json|md|csv   output shape (default: md)
  --out FILE             write here instead of standard output
  --root DIR             repository root (default: current directory)
  --scope ID             include the .unlazy/<ID> pipeline
  --actor NAME           account recorded as having produced the export
                         (default: UNLAZY_ACTOR, else the OS user)
  --approval-dir DIR     approval store (default: UNLAZY_APPROVAL_DIR,
                         else <home>/.unlazy/approved)
  --include-path         record the full inherited PATH of each approval
                         instead of a digest of it
  --no-bom               omit the UTF-8 BOM from csv output

exit codes: 0 exported, 2 usage or unreadable input.`;

function die(reason) {
  console.error(SELF + ": " + reason);
  console.error("run export-audit.mjs --help for usage");
  process.exit(2);
}

// ------------------------------------------------------------------ CLI ----

const argv = process.argv.slice(2);
const opts = { format: "md", root: process.cwd(), bom: true };
const ledgerArgs = [];
let positionalOnly = false;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (!positionalOnly && arg === "--") { positionalOnly = true; continue; }
  if (!positionalOnly && (arg === "--help" || arg === "-h")) { console.log(HELP); process.exit(0); }
  if (!positionalOnly && arg.startsWith("-")) {
    const next = () => {
      const value = argv[++i];
      if (value === undefined) die("option needs a value: " + arg);
      return value;
    };
    if (arg === "--format") opts.format = next();
    else if (arg === "--out") opts.out = next();
    else if (arg === "--root") opts.root = resolve(next());
    else if (arg === "--scope") opts.scope = next();
    else if (arg === "--actor") opts.actor = next();
    else if (arg === "--approval-dir") opts.approvalDir = resolve(next());
    else if (arg === "--include-path") opts.includePath = true;
    else if (arg === "--no-bom") opts.bom = false;
    else die("unknown option " + arg);
    continue;
  }
  ledgerArgs.push(arg);
}

if (!["json", "md", "csv"].includes(opts.format)) die("unknown format: " + opts.format);
if (opts.scope && !/^[A-Za-z0-9._-]+$/.test(opts.scope)) die("invalid scope id: " + opts.scope);

const actor = opts.actor || process.env.UNLAZY_ACTOR || (() => {
  try { return userInfo().username; } catch { return "unknown"; }
})();
const actorDeclared = Boolean(opts.actor || process.env.UNLAZY_ACTOR);

const approvalDir = opts.approvalDir
  || (process.env.UNLAZY_APPROVAL_DIR ? resolve(process.env.UNLAZY_APPROVAL_DIR) : join(homedir(), ".unlazy", "approved"));

// -------------------------------------------------------------- gather ----

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const short = (value) => sha256(value).slice(0, 12);

function collectLedgers() {
  const found = [];
  const add = (file) => {
    const absolute = resolve(file);
    if (!found.includes(absolute)) found.push(absolute);
  };
  for (const file of ledgerArgs) add(file);
  if (opts.scope) {
    const scopeDir = join(opts.root, ".unlazy", opts.scope);
    if (!existsSync(scopeDir)) die("scope directory not found: " + scopeDir);
    const main = join(scopeDir, "GATES.md");
    if (existsSync(main)) add(main);
    const gatesDir = join(scopeDir, "gates");
    if (existsSync(gatesDir)) {
      for (const entry of readdirSync(gatesDir).sort()) {
        if (entry.endsWith(".md")) add(join(gatesDir, entry));
      }
    }
  }
  if (!found.length) {
    const fallback = join(opts.root, "GATES.md");
    if (existsSync(fallback)) add(fallback);
  }
  if (!found.length) die("no ledger found; name one, pass --scope, or run where GATES.md lives");
  return found;
}

// The evidence line is a flat key=value list written by the checker. Keeping
// the raw string alongside the parsed fields matters: if the format ever
// changes, the artefact still carries what was actually recorded.
function parseEvidence(raw) {
  if (!raw || /^pending$/i.test(raw)) return null;
  const fields = {};
  for (const part of String(raw).split(";")) {
    const text = part.trim();
    if (!text) continue;
    const eq = text.indexOf("=");
    if (eq === -1) continue;
    fields[text.slice(0, eq).trim()] = text.slice(eq + 1).trim();
  }
  return { raw: String(raw), fields };
}

const sources = [];
function recordSource(path, kind) {
  try {
    const stats = statSync(path);
    const body = readFileSync(path);
    sources.push({
      kind,
      path,
      bytes: stats.size,
      modified: stats.mtime.toISOString(),
      sha256: sha256(body),
    });
    return body;
  } catch (error) {
    sources.push({ kind, path, error: String(error && error.message) });
    return null;
  }
}

const ledgerPaths = collectLedgers();
const ledgers = [];

for (const path of ledgerPaths) {
  const body = recordSource(path, "ledger");
  if (body === null) die("cannot read ledger: " + path);
  const text = body.toString("utf8");
  const doc = parseGates(text, { requireGates: false });
  const label = qualify(path, "").replace(/:$/, "");
  ledgers.push({
    path,
    label,
    parseErrors: doc.errors,
    parseWarnings: doc.warnings,
    owns: doc.owns.map((entry) => (typeof entry === "string" ? entry : entry.glob || String(entry))),
    gates: doc.gates.map((gate) => ({
      id: gate.id,
      qualified: qualify(path, gate.id),
      title: gate.title,
      state: gateState(gate, doc.abandoned),
      runnable: Boolean(gate.check && gate.expect),
      check: gate.check,
      expect: gate.expect,
      cwd: gate.cwd,
      abandonReason: doc.abandoned.get(gate.id) || null,
      evidence: parseEvidence(gate.evidence),
    })),
  });
}

// --------------------------------------------------------- approvals ----

const approvals = [];
let approvalStore = { path: approvalDir, present: existsSync(approvalDir) };
if (approvalStore.present) {
  let entries = [];
  try {
    entries = readdirSync(approvalDir).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    approvalStore.error = String(error && error.message);
  }
  approvalStore.recordCount = entries.length;
  for (const name of entries) {
    const file = join(approvalDir, name);
    let record;
    let stats;
    try {
      stats = statSync(file);
      record = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      approvals.push({ file, error: String(error && error.message) });
      continue;
    }
    const oracle = record.oracle || {};
    approvals.push({
      file,
      ledger: record.file,
      gate: record.gate,
      signature: record.signature,
      approvedAt: record.approvedAt,
      recordModified: stats.mtime.toISOString(),
      oracle: {
        check: oracle.check,
        expect: oracle.expect,
        cwd: oracle.cwd,
        shell: oracle.shell,
        timeoutMs: oracle.timeoutMs,
        platform: oracle.platform,
        // The bound PATH is environment detail that can name accounts and
        // installed software. The evidence line already reduces it to a
        // fingerprint, so the default here matches that choice.
        path: opts.includePath ? oracle.path : undefined,
        pathDigest: oracle.path === undefined ? undefined : short(String(oracle.path)),
        // Split on the separator of the platform the approval was made on, not
        // on both. A colon is a PATH separator on POSIX but part of every drive
        // letter on Windows, and counting both doubles every Windows figure.
        pathEntries: oracle.path === undefined
          ? undefined
          : String(oracle.path).split(oracle.platform === "win32" ? ";" : ":").filter(Boolean).length,
      },
    });
  }
}

const approvalFor = (ledgerPath, gateId) =>
  approvals.filter((entry) => entry.ledger === ledgerPath && entry.gate === gateId);

// -------------------------------------------------- dispatch and log ----

let dispatch = null;
let statusLog = null;
if (opts.scope) {
  const dispatchPath = join(opts.root, ".unlazy", opts.scope, "dispatch.json");
  if (existsSync(dispatchPath)) {
    const body = recordSource(dispatchPath, "dispatch");
    if (body) {
      try { dispatch = JSON.parse(body.toString("utf8")); }
      catch (error) { dispatch = { error: String(error && error.message) }; }
    }
  }
  const logPath = join(opts.root, ".unlazy", opts.scope, "status.log");
  if (existsSync(logPath)) {
    const body = recordSource(logPath, "status-log");
    if (body) statusLog = body.toString("utf8").split(/\r?\n/).filter(Boolean);
  }
} else {
  const legacyLog = join(opts.root, "unlazy-status.log");
  if (existsSync(legacyLog)) {
    const body = recordSource(legacyLog, "status-log");
    if (body) statusLog = body.toString("utf8").split(/\r?\n/).filter(Boolean);
  }
}

// -------------------------------------------------------- findings ----

const findings = [];
const note = (severity, code, message) => findings.push({ severity, code, message });

let counts = { met: 0, unmet: 0, "unmet-no-evidence": 0, abandoned: 0, manual: 0, runnable: 0 };

for (const ledger of ledgers) {
  for (const error of ledger.parseErrors) {
    note("high", "ledger-parse-error", ledger.label + ": " + error);
  }
  for (const gate of ledger.gates) {
    counts[gate.state] = (counts[gate.state] || 0) + 1;
    if (gate.runnable) counts.runnable += 1; else counts.manual += 1;

    if (gate.state === "abandoned") {
      note("high", "abandoned", gate.qualified + ": 포기 선언됨, 인계 필요");
    }
    if (gate.state === "unmet") {
      note("medium", "unmet", gate.qualified + ": 미충족");
    }
    if (gate.state === "unmet-no-evidence") {
      note("high", "checked-without-evidence",
        gate.qualified + ": 체크됐으나 증거가 없어 미충족으로 계산됨");
    }
    if (gate.state === "met" && !gate.runnable) {
      note("medium", "manual-met",
        gate.qualified + ": 수동 게이트 충족, 증거의 신뢰도는 검토자에게 달려 있음");
    }
    if (gate.state === "met" && gate.runnable && approvalFor(ledger.path, gate.id).length === 0) {
      note("medium", "met-without-standing-approval",
        gate.qualified + ": 통과 기록은 있으나 대응하는 승인 레코드가 없음 " +
        "(승인이 삭제됐거나, 승인 이후 명령·경로·셸·PATH가 바뀌었을 수 있음)");
    }
  }
}

for (const approval of approvals) {
  if (approval.error) {
    note("high", "approval-unreadable", approval.file + ": " + approval.error);
    continue;
  }
  if (approval.ledger && !existsSync(approval.ledger)) {
    note("low", "orphan-approval",
      basename(approval.file) + ": 대상 원장이 존재하지 않음 (" + approval.ledger + ")");
  }
}

if (dispatch && dispatch.waves) {
  for (const [waveId, wave] of Object.entries(dispatch.waves)) {
    if (wave && wave.state && wave.state !== "complete") {
      note(wave.state === "abandoned" ? "high" : "medium", "dispatch-" + wave.state,
        "wave " + waveId + ": " + wave.state);
    }
  }
}

// ---------------------------------------------------------- manifest ----

const generatedAt = new Date().toISOString();
let toolVersion = "unknown";
try {
  const pkg = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
  toolVersion = pkg.version || "unknown";
} catch { /* version is informational */ }

const bundle = {
  schema: 1,
  generatedAt,
  actor,
  actorDeclared,
  host: (() => { try { return hostname(); } catch { return "unknown"; } })(),
  tool: { name: SELF, unlazyVersion: toolVersion, node: process.version, platform: process.platform },
  root: opts.root,
  scope: opts.scope || null,
  counts,
  ledgers,
  approvalStore,
  approvals,
  dispatch,
  statusLog,
  findings,
  sources,
};
// Tamper evidence, not tamper proofing. Recomputing this digest over the
// artefact's own body shows whether the body was edited after generation. It
// cannot stop anyone who regenerates the digest too, and the report says so.
bundle.bundleDigest = sha256(JSON.stringify({ ...bundle, bundleDigest: undefined }));

// ------------------------------------------------------------ output ----

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function renderCsv() {
  const header = [
    "원장", "게이트ID", "제목", "상태", "검증방식", "CHECK", "EXPECT",
    "종료코드", "EXPECT일치", "출력해시", "검증시각", "승인시각", "포기사유",
  ];
  const rows = [header.map(csvCell).join(",")];
  for (const ledger of ledgers) {
    for (const gate of ledger.gates) {
      const evidence = gate.evidence ? gate.evidence.fields : {};
      const approval = approvalFor(ledger.path, gate.id)[0];
      rows.push([
        ledger.label,
        gate.id,
        gate.title,
        gate.state,
        gate.runnable ? "runnable" : "manual",
        gate.check,
        gate.expect,
        evidence.exit,
        evidence.EXPECT,
        evidence["output-sha256"],
        evidence["verified-at"],
        approval ? approval.approvedAt : "",
        gate.abandonReason,
      ].map(csvCell).join(","));
    }
  }
  // Excel on a Korean Windows install reads a BOM-less UTF-8 CSV as CP949 and
  // renders every Korean cell as mojibake. The consumer of this file is Excel,
  // so the BOM is the default here even though the repository's own text
  // standard is BOM-less. check-encoding.mjs --no-bom will flag it; that is
  // expected for this artefact.
  return (opts.bom ? "﻿" : "") + rows.join("\r\n") + "\r\n";
}

function renderMarkdown() {
  const out = [];
  const severityLabel = { high: "높음", medium: "보통", low: "낮음" };
  out.push("# unlazy 게이트 감사 자료");
  out.push("");
  out.push("| 항목 | 값 |");
  out.push("|---|---|");
  out.push("| 생성 시각 | " + generatedAt + " |");
  out.push("| 생성 계정 | " + actor + (actorDeclared ? " (명시됨)" : " (OS 계정에서 추정)") + " |");
  out.push("| 호스트 | " + bundle.host + " |");
  out.push("| 저장소 루트 | " + opts.root + " |");
  out.push("| 파이프라인 | " + (opts.scope || "(scope 없음)") + " |");
  out.push("| 도구 | " + SELF + " / unlazy " + toolVersion + " / Node " + process.version + " |");
  out.push("| 번들 다이제스트 | `" + bundle.bundleDigest.slice(0, 32) + "` |");
  out.push("");

  out.push("## 요약");
  out.push("");
  out.push("| 상태 | 건수 |");
  out.push("|---|---:|");
  out.push("| 충족 (met) | " + (counts.met || 0) + " |");
  out.push("| 미충족 (unmet) | " + (counts.unmet || 0) + " |");
  out.push("| 체크됐으나 증거 없음 | " + (counts["unmet-no-evidence"] || 0) + " |");
  out.push("| 포기 (abandoned) | " + (counts.abandoned || 0) + " |");
  out.push("");
  out.push("실행형 게이트 " + counts.runnable + "건, 수동 게이트 " + counts.manual + "건. "
    + "승인 레코드 " + (approvalStore.recordCount || 0) + "건.");
  out.push("");

  out.push("## 게이트별 기록");
  out.push("");
  for (const ledger of ledgers) {
    out.push("### " + ledger.label + "");
    out.push("");
    out.push("경로: `" + ledger.path + "`");
    out.push("");
    out.push("| 게이트 | 제목 | 상태 | 방식 | 종료코드 | EXPECT | 출력 해시 | 검증 시각 | 승인 시각 |");
    out.push("|---|---|---|---|---|---|---|---|---|");
    for (const gate of ledger.gates) {
      const evidence = gate.evidence ? gate.evidence.fields : {};
      const approval = approvalFor(ledger.path, gate.id)[0];
      out.push("| " + [
        gate.id,
        gate.title.replace(/\|/g, "\\|"),
        gate.state,
        gate.runnable ? "runnable" : "manual",
        evidence.exit || "-",
        evidence.EXPECT || "-",
        evidence["output-sha256"] ? "`" + String(evidence["output-sha256"]).slice(0, 12) + "`" : "-",
        evidence["verified-at"] || "-",
        approval ? approval.approvedAt : "-",
      ].join(" | ") + " |");
    }
    out.push("");
    for (const gate of ledger.gates) {
      if (gate.abandonReason) {
        out.push("- **" + gate.qualified + " 포기 사유**: " + gate.abandonReason);
      }
    }
    if (ledger.parseErrors.length) {
      out.push("");
      out.push("원장 파싱 오류:");
      for (const error of ledger.parseErrors) out.push("- " + error);
    }
    out.push("");
  }

  out.push("## 승인 이력");
  out.push("");
  if (!approvals.length) {
    out.push("승인 레코드가 없다. 승인 저장소: `" + approvalStore.path + "`"
      + (approvalStore.present ? "" : " (존재하지 않음)"));
  } else {
    out.push("승인 저장소: `" + approvalStore.path + "`");
    out.push("");
    out.push("| 원장 | 게이트 | 승인 시각 | 셸 | PATH 지문 | 서명 |");
    out.push("|---|---|---|---|---|---|");
    for (const approval of approvals) {
      if (approval.error) continue;
      out.push("| " + [
        basename(String(approval.ledger || "-")),
        approval.gate || "-",
        approval.approvedAt || "-",
        approval.oracle.shell ? basename(String(approval.oracle.shell)) : "-",
        approval.oracle.pathDigest ? "`" + approval.oracle.pathDigest + "`/" + approval.oracle.pathEntries : "-",
        approval.signature ? "`" + String(approval.signature).slice(0, 12) + "`" : "-",
      ].join(" | ") + " |");
    }
  }
  out.push("");

  if (dispatch) {
    out.push("## 디스패치 상태");
    out.push("");
    out.push("```json");
    out.push(JSON.stringify(dispatch, null, 2).slice(0, 4000));
    out.push("```");
    out.push("");
  }

  if (statusLog && statusLog.length) {
    out.push("## 상태 로그 (최근 " + Math.min(statusLog.length, 50) + "건 / 전체 " + statusLog.length + "건)");
    out.push("");
    out.push("```text");
    for (const line of statusLog.slice(-50)) out.push(line);
    out.push("```");
    out.push("");
  }

  out.push("## 검토 필요 사항");
  out.push("");
  if (!findings.length) {
    out.push("자동 점검에서 지적 사항이 나오지 않았다. 아래 한계 절을 함께 읽을 것.");
  } else {
    out.push("| 심각도 | 코드 | 내용 |");
    out.push("|---|---|---|");
    for (const finding of findings) {
      out.push("| " + [
        severityLabel[finding.severity] || finding.severity,
        finding.code,
        finding.message.replace(/\|/g, "\\|"),
      ].join(" | ") + " |");
    }
  }
  out.push("");

  out.push("## 무결성 매니페스트");
  out.push("");
  out.push("| 종류 | 파일 | 바이트 | 수정 시각 | SHA-256 |");
  out.push("|---|---|---:|---|---|");
  for (const source of sources) {
    out.push("| " + [
      source.kind,
      "`" + source.path + "`",
      source.bytes === undefined ? "-" : source.bytes,
      source.modified || "-",
      source.sha256 ? "`" + source.sha256.slice(0, 16) + "`" : "(읽기 실패)",
    ].join(" | ") + " |");
  }
  out.push("");

  out.push("## 이 자료가 증명하는 것과 증명하지 못하는 것");
  out.push("");
  out.push("증명하는 것:");
  out.push("");
  out.push("- 각 게이트가 선언한 명령과 기대 문자열, 그리고 그 명령이 종료 코드 0으로");
  out.push("  끝나고 기대 문자열이 출력에 나타났다는 기록.");
  out.push("- 각 승인이 명령, 기대값, 작업 디렉터리, 셸, 타임아웃, 플랫폼, 상속된 PATH에");
  out.push("  묶여 있으며 그 중 하나라도 바뀌면 재승인이 필요하다는 사실.");
  out.push("- 위 매니페스트의 해시로, 이 자료 생성 이후 원본 파일이 바뀌었는지 여부.");
  out.push("");
  out.push("증명하지 못하는 것:");
  out.push("");
  out.push("- **게이트 제목이 명령이 실제로 측정한 것을 서술하는지.** 체커는 선언된");
  out.push("  명령만 증명하며, 한국어 제목과 셸 코드가 같은 뜻인지는 판단하지 못한다.");
  out.push("- **검증 시각이 정확한 시간임을.** 각 게이트의 verified-at은 검증이 끝난");
  out.push("  시점을 그 머신의 로컬 시계로 읽은 값이다. 시계가 틀렸거나 표준시와 어긋나");
  out.push("  있으면 그대로 어긋난 값이 남는다. 순서와 날짜를 알려줄 뿐 시각을 증명하지");
  out.push("  않는다. verified-at이 없는 항목은 이 필드가 생기기 전에 기록된 증거다.");
  out.push("- **누가 검토했는지.** 위 생성 계정은 이 자료를 뽑은 계정이지, 각 게이트를");
  out.push("  사람이 검토했다는 증거가 아니다. 승인 레코드에도 사용자 필드가 없다.");
  out.push("- **명령이 호출한 스크립트가 승인 당시와 같은 바이트인지.** 승인은 명령");
  out.push("  텍스트에 묶이며 그 명령이 실행하는 파일을 해시하지 않는다.");
  out.push("- **승인 저장소가 다른 계정으로부터 보호됐는지.** Windows에서는 소유자와");
  out.push("  권한 검사가 건너뛰어지므로 NTFS ACL에 의존하며, 이 자료는 그것을 확인하지");
  out.push("  않는다.");
  out.push("- **이 자료 자체의 위조 방지.** 번들 다이제스트는 변조 탐지용이며, 자료를");
  out.push("  다시 생성하면 해시도 함께 바뀐다. 원본 보관은 별도 절차가 필요하다.");
  out.push("");
  return out.join("\n") + "\n";
}

let output;
if (opts.format === "json") output = JSON.stringify(bundle, null, 2) + "\n";
else if (opts.format === "csv") output = renderCsv();
else output = renderMarkdown();

if (opts.out) {
  const target = isAbsolute(opts.out) ? opts.out : resolve(opts.out);
  writeFileSync(target, output, opts.format === "csv" ? "utf8" : "utf8");
  const summary = counts.met + " met, " + (counts.unmet || 0) + " unmet, "
    + (counts.abandoned || 0) + " abandoned, " + findings.length + " finding(s)";
  console.log(SELF + ": wrote " + relative(process.cwd(), target) + " (" + opts.format + "; " + summary + ")");
} else {
  process.stdout.write(output);
}
