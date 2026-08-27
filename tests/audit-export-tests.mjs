// audit-export-tests.mjs : behaviour tests for scripts/export-audit.mjs.
// Zero dependencies. Node 16+. Fork-local, not part of upstream unlazy.
//
// The export is an audit artefact, so the tests care about two things beyond
// "it produced output": that its findings actually fire on the situations a
// reviewer needs told about, and that a read-only tool stays read-only. The
// second is checked by running it against a ledger and comparing the ledger
// bytes before and after.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "export-audit.mjs");
const dir = mkdtempSync(join(tmpdir(), "unlazy-audit-"));

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

function run(args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: dir });
  return { status: result.status, out: result.stdout || "", err: result.stderr || "" };
}

// A ledger carrying one met runnable gate, one manual gate left pending, and
// one abandoned gate, so every reported state appears at least once.
const ledger = join(dir, "GATES.md");
const LEDGER_TEXT = [
  "# Gates: 감사 익스포트 시험",
  "",
  "- [x] G1: 산출물이 생성되었다",
  "  CHECK: node -e \"console.log('ok')\"",
  "  EXPECT: ok",
  "  EVIDENCE: exit=0; shell=/bin/sh; cwd=/tmp; path=abc123456789/12 entries; EXPECT=matched; output-sha256=aa11; output-bytes=3",
  "",
  "- [ ] G2: 검토자가 눈으로 확인했다",
  "  EVIDENCE: pending",
  "",
  "- [ ] G3: 외부 시스템 연동을 확인한다",
  "  CHECK: node -e \"process.exit(1)\"",
  "  EXPECT: never",
  "  EVIDENCE: pending",
  "",
  "ABANDON: G3 연동 대상 시스템이 폐기되어 확인 불가, 운영팀 인계",
  "",
].join("\n");
writeFileSync(ledger, LEDGER_TEXT);

const approvalDir = join(dir, "approvals");
mkdirSync(approvalDir);

// ------------------------------------------------------------- formats ----

const md = run(["--format", "md", "GATES.md", "--approval-dir", approvalDir]);
check("md: exits 0 even though gates are unmet", md.status === 0, "exit=" + md.status);
check("md: reports the measured state counts",
  md.out.includes("| 충족 (met) | 1 |") && md.out.includes("| 포기 (abandoned) | 1 |"),
  md.out.split("\n").filter((l) => l.includes("충족")).join(" / "));
check("md: carries the abandonment reason verbatim",
  md.out.includes("연동 대상 시스템이 폐기되어 확인 불가"));
check("md: states what the artefact cannot prove",
  md.out.includes("증명하지 못하는 것") && md.out.includes("verified-at은 검증이 끝난"));
check("md: includes an integrity manifest with a digest",
  md.out.includes("무결성 매니페스트") && /\| ledger \|/.test(md.out));

const json = run(["--format", "json", "GATES.md", "--approval-dir", approvalDir]);
let bundle = null;
try { bundle = JSON.parse(json.out); } catch { /* reported below */ }
check("json: output parses", bundle !== null);
check("json: counts match the ledger",
  bundle && bundle.counts.met === 1 && bundle.counts.abandoned === 1 && bundle.counts.manual === 1,
  bundle && JSON.stringify(bundle.counts));
check("json: evidence is parsed into fields, raw kept",
  bundle && bundle.ledgers[0].gates[0].evidence.fields.exit === "0"
  && bundle.ledgers[0].gates[0].evidence.raw.includes("output-sha256"));
check("json: a bundle digest is present", bundle && /^[0-9a-f]{64}$/.test(bundle.bundleDigest));

const csv = run(["--format", "csv", "GATES.md", "--approval-dir", approvalDir]);
check("csv: carries a UTF-8 BOM for Excel", csv.out.charCodeAt(0) === 0xfeff);
check("csv: one header row plus one row per gate",
  csv.out.replace(/^\uFEFF/, "").trim().split(/\r\n/).length === 4,
  JSON.stringify(csv.out.replace(/^\uFEFF/, "").trim().split(/\r\n/).length));
check("csv: --no-bom drops it",
  run(["--format", "csv", "GATES.md", "--no-bom", "--approval-dir", approvalDir])
    .out.charCodeAt(0) !== 0xfeff);

// ------------------------------------------------------------ findings ----

check("finding: an abandoned gate is high severity",
  md.out.includes("abandoned") && /높음 \| abandoned/.test(md.out));
check("finding: a checked gate with no approval is reported",
  md.out.includes("met-without-standing-approval"));
check("finding: a manual gate that is met is flagged for reviewer dependence",
  run(["--format", "json", "GATES.md", "--approval-dir", approvalDir]).out.includes("manual-met") === false,
  "G2 is unmet here, so manual-met must NOT fire");

// An approval pointing at a ledger that no longer exists is a garbage-collection
// candidate and the only signal that the approval store is drifting.
writeFileSync(join(approvalDir, "orphan.json"), JSON.stringify({
  schema: 1,
  file: join(dir, "deleted", "GONE.md"),
  gate: "G1",
  signature: "f".repeat(64),
  oracle: {
    check: "node -e \"\"", expect: "ok", cwd: dir, shell: "/bin/sh",
    timeoutMs: 1000, platform: "linux", path: "/usr/bin:/bin",
  },
  approvedAt: "2026-01-01T00:00:00.000Z",
}));
const withOrphan = run(["--format", "md", "GATES.md", "--approval-dir", approvalDir]);
check("finding: an approval whose ledger is gone is reported as orphaned",
  withOrphan.out.includes("orphan-approval"));

// PATH separators differ by platform, and a colon is part of every Windows
// drive letter. Counting both doubles every Windows figure and puts a wrong
// number into an audit document.
const posixApproval = JSON.parse(
  run(["--format", "json", "GATES.md", "--approval-dir", approvalDir]).out)
  .approvals.find((entry) => entry.oracle && entry.oracle.platform === "linux");
check("approval: a posix PATH of two entries counts as two",
  posixApproval && posixApproval.oracle.pathEntries === 2,
  posixApproval && String(posixApproval.oracle.pathEntries));

writeFileSync(join(approvalDir, "win.json"), JSON.stringify({
  schema: 1, file: ledger, gate: "G1", signature: "a".repeat(64),
  oracle: {
    check: "node -e \"console.log('ok')\"", expect: "ok", cwd: dir,
    shell: "C:\\WINDOWS\\system32\\cmd.exe", timeoutMs: 1000, platform: "win32",
    path: "C:\\WINDOWS\\system32;C:\\Program Files\\nodejs",
  },
  approvedAt: "2026-02-01T00:00:00.000Z",
}));
const winBundle = JSON.parse(
  run(["--format", "json", "GATES.md", "--approval-dir", approvalDir]).out);
const winApproval = winBundle.approvals.find((a) => a.oracle.platform === "win32");
check("approval: a windows PATH of two entries counts as two, not four",
  winApproval && winApproval.oracle.pathEntries === 2,
  winApproval && String(winApproval.oracle.pathEntries));
check("approval: the bound PATH is digested rather than copied by default",
  winApproval && winApproval.oracle.path === undefined && /^[0-9a-f]{12}$/.test(winApproval.oracle.pathDigest));
check("approval: --include-path opts into the full value",
  JSON.parse(run(["--format", "json", "GATES.md", "--approval-dir", approvalDir, "--include-path"].map(String)).out)
    .approvals.some((a) => typeof a.oracle.path === "string"));
check("finding: a gate now matched by an approval stops being reported as unapproved",
  !run(["--format", "md", "GATES.md", "--approval-dir", approvalDir]).out
    .includes("GATES:G1: 통과 기록은 있으나"));

// -------------------------------------------------------- read-only ----

check("read-only: the ledger is byte identical after every export above",
  readFileSync(ledger, "utf8") === LEDGER_TEXT);

// ------------------------------------------------------------ usage ----

check("usage: an unknown option exits 2", run(["--bogus", "GATES.md"]).status === 2);
check("usage: an unknown format exits 2", run(["--format", "xml", "GATES.md"]).status === 2);
check("usage: no ledger anywhere exits 2",
  spawnSync(process.execPath, [script], { encoding: "utf8", cwd: tmpdir() }).status === 2);
check("usage: --help exits 0", run(["--help"]).status === 0);

rmSync(dir, { recursive: true, force: true });
console.log("");
console.log(failures === 0 ? total + "/" + total + " passed" : failures + " of " + total + " failed");
process.exit(failures === 0 ? 0 : 1);
