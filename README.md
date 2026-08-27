<div align="center">

# unlazy (한국어 포크)

**AI 에이전트의 "완료했습니다"를 실행 가능한 증거로 바꾸는 규율 도구.**

작업 전에 수락 기준을 원장에 적고, 검토한 명령만 실행하고, 보고 직전에 다시 검증한다.
증거가 뒷받침하는 것만 완료라고 말한다.

[설치](#설치) · [5분 따라하기](#5분-따라하기) · [원장 작성법](#원장-작성법) · [명령 레퍼런스](#명령-레퍼런스) · [업무 산출물 검증](#업무-산출물-검증) · [보안 경계](#보안-경계)

</div>

> [Leonxlnx/unlazy](https://github.com/Leonxlnx/unlazy)의 포크입니다.
> 한국어 환경과 사무 업무 자동화에 맞춰 확장했습니다.
> 원본 영문 문서는 [README.en.md](README.en.md)에 그대로 두었습니다.

## 무엇을 해결하는가

AI 에이전트는 여러 단계로 이뤄진 작업을 절반만 하고 자신 있게 "완료"라고 보고하는
경향이 있다. 문제는 그 보고가 틀렸다는 게 아니라, **틀렸는지 확인할 방법이 없다**는
것이다.

unlazy는 완료를 문장이 아니라 **명령의 결과**로 정의한다. 각 수락 기준마다 검증
명령과 기대 출력을 미리 선언하고, 그 명령이 종료 코드 0으로 끝나고 기대 문자열이
출력에 나타날 때만 충족으로 인정한다. 충족되지 않은 기준이 하나라도 있으면 완료
보고를 만들지 않는다.

## 설치

```bash
git clone -b personal https://github.com/humanist96/unlazy ~/.claude/skills/unlazy
```

문서에 박힌 `<skill-dir>` 자리표시자를 실제 설치 경로로 바꾼다. 업스트림을 다시
받아온 뒤에도 이 한 번이면 복원된다.

```bash
node ~/.claude/skills/unlazy/scripts/personalize.mjs
```

반입 무결성 확인은 오프라인에서 완결된다.

```bash
cd ~/.claude/skills/unlazy && npm test
```

외부 패키지 의존성이 **0개**이고 Node 16 이상이면 동작한다. `npm install` 단계가
없으므로 폐쇄망에 그대로 반입할 수 있다.

> **Windows 주의.** `cmd.exe`에서는 물결표가 확장되지 않는다. 그 셸에서 명령을 칠 때는
> 설치 경로를 전체 경로로 적거나 Git Bash를 쓴다. 원장 안의 `CHECK:`는 셸과 무관하게
> 항상 절대 경로를 써야 한다. 아래 [원장 작성법](#원장-작성법)을 볼 것.

## 두 가지 사용 방식

**① 에이전트에게 맡기기.** 새 세션에서 한국어로 지시하면 스킬이 자동 발동한다.

```text
3월 점검 보고서 작성해줘. 게이트 걸고 끝까지 완료해
원장계랑 정산계 대사해줘. 검증하고 보고해
```

명시적으로 부르려면 `/unlazy`. 사소한 수정이나 단순 질문에는 쓰지 않는다.

**② 직접 원장을 돌리기.** 아래 튜토리얼이 그 방법이다. 스케줄러에 걸어 반복 점검으로
쓸 때도 이 방식이다.

## 5분 따라하기

빈 폴더에서 그대로 따라 하면 된다.

**1. 스킬 경로를 절대 경로로 잡고 산출물을 만든다.**

원장 안의 `CHECK:`는 **체커 자신의 셸**을 통해 실행된다. Windows 기본 셸은
`cmd.exe`이고 물결표를 확장하지 않으므로, 게이트 명령에는 물결표를 쓰면 안 된다.
아래 한 줄이 어느 플랫폼에서든 쓸 수 있는 절대 경로를 만들어 준다.

```bash
SKILL=$(node -e "const p=require('path');console.log(p.join(require('os').homedir(),'.claude','skills','unlazy').split(p.sep).join('/'))")
```

```bash
mkdir -p 산출물 && printf '%s\n' "매출,금액" "1월,1000" "2월,2000" > 산출물/실적.csv
```

**2. 원장을 쓴다.** 작업 *전에* 쓰는 것이 핵심이다.

따옴표 없는 heredoc이라 `$SKILL`이 지금 펼쳐져 원장에는 실제 경로가 박힌다.

```bash
cat > GATES.md <<EOF
# Gates: 월간 실적 산출물

- [ ] G1: 실적 파일이 오늘 생성되었고 비어 있지 않다
  CHECK: node $SKILL/checks/check-file.mjs "산출물/실적.csv" --min-bytes 10 --max-age-hours 24
  EXPECT: UNLAZY-CHECK-OK check-file
  EVIDENCE: pending

- [ ] G2: 필수 컬럼이 있고 금액에 빈 칸이 없다
  CHECK: node $SKILL/checks/check-csv.mjs "산출물/실적.csv" --require-columns "매출,금액" --no-empty-cells "금액" --min-rows 2
  EXPECT: UNLAZY-CHECK-OK check-csv
  EVIDENCE: pending
EOF
```

**3. 실행하지 않고 먼저 읽는다.** `--status`는 어떤 경우에도 명령을 실행하지 않는다.

```bash
node $SKILL/scripts/gate-check.mjs --status GATES.md
```

**4. 원장 품질을 점검한다.** 실패할 수 없는 오라클을 저작 시점에 잡아 준다.

```bash
node $SKILL/scripts/gate-lint.mjs GATES.md
```

**5. 한 게이트씩 승인해서 실행한다.** 읽고 이해한 명령만 승인한다.

```bash
node $SKILL/scripts/gate-check.mjs --approve --gate G1 GATES.md
```

G1은 통과하지만 판정은 여전히 `UNMET`이다. **좁혀 실행해도 판정은 원장 전체를
대상으로** 하므로 일부만 통과시켜 완료 증명서를 받을 수 없다. 나머지도 승인하면
`ALL MET`이 된다.

```bash
node $SKILL/scripts/gate-check.mjs --approve --gate G2 GATES.md
```

**6. 보고 직전에 다시 검증한다.** 옛 증거는 재실행이 아니다.

```bash
node $SKILL/scripts/gate-check.mjs --reverify GATES.md
```

원장을 열어 보면 각 게이트에 증거가 자동으로 기록돼 있다. 종료 코드, 해석된 셸과
작업 디렉터리, `PATH` 지문, 출력의 SHA-256, 그리고 **검증이 끝난 시각**(`verified-at`)이
남는다. 성공한 출력의 원문은 저장하지 않으므로 산출물에 민감 정보가 있어도 원장에
복사되지 않는다.

## 원장 작성법

```markdown
# Gates: 일일 점검 보고서

- [ ] G1: 보고서가 오늘 날짜로 생성되었다
  CHECK: node <skill-dir>/checks/check-file.mjs "산출물/보고서.docx" --min-bytes 20000 --max-age-hours 24
  EXPECT: UNLAZY-CHECK-OK check-file
  EVIDENCE: pending

- [ ] G2: 검증 스크립트가 통과한다
  CHECK: node scripts/verify.mjs
  EXPECT: verification passed
  DEPS: scripts/verify.mjs
  EVIDENCE: pending

- [ ] G3: 담당자가 문구를 검토했다
  EVIDENCE: pending
```

| 속성 | 뜻 |
|---|---|
| `CHECK:` | 검증 명령. 셸 코드로 취급되며 승인 없이는 실행되지 않는다 |
| `EXPECT:` | 기대 문자열. 슬래시로 감싸면 정규식 |
| `CWD:` | 명령을 실행할 디렉터리(선택) |
| `DEPS:` | 명령이 실행하는 파일들. 해시가 승인에 묶여 그 파일을 고치면 재승인을 요구한다(선택) |
| `EVIDENCE:` | 체커가 채운다. 처음엔 `pending` |

규칙 몇 가지.

- **성공 조건은 두 가지가 동시에** 성립해야 한다. 종료 코드 0, 그리고 `EXPECT:`가
  출력에 나타날 것. 실패한 프로세스의 오류 메시지에 기대 문자열이 우연히 들어
  있어도 통과가 아니다.
- **`CHECK:`가 없으면 수동 게이트**다. 사람이 판단하고 증거를 직접 적는다.
- **불가능해진 기준은 지우지 않는다.** 파일 맨 왼쪽에 `ABANDON: G3 <사유>`를 적으면
  인계 상태로 종결되며, 이는 절대 성공으로 집계되지 않는다.

`<skill-dir>`는 설치 시 `personalize.mjs`가 실제 경로로 바꿔 주는 자리표시자다. 직접
원장을 쓸 때는 절대 경로를 적는다. **`CHECK:` 안에 물결표를 쓰면 안 된다**: 게이트
명령은 체커의 셸을 통해 실행되고, Windows 기본 셸인 `cmd.exe`는 물결표를 확장하지
않는다.

전체 규격은 [references/gates.md](references/gates.md)(영문)에 있다.

## 명령 레퍼런스

### gate-check.mjs

| 옵션 | 용도 |
|---|---|
| (기본) | 미충족 게이트를 실행하고 원장을 갱신 |
| `--status` | 보고만. **절대 실행·승인·기록하지 않음** |
| `--approve` | 미승인 오라클을 승인하고 실행 |
| `--gate ID` | 이 게이트만 실행·승인(반복 가능). 판정은 여전히 전체 대상 |
| `--reverify` | 충족된 것 포함 전부 재실행, 실패 시 강등 |
| `--json` | stdout에 기계 판독 객체 하나, 사람용 전사는 stderr |
| `--output-encoding` | CHECK 출력 디코딩: `utf8`(기본) 또는 `cp949` |
| `--jobs N` | 독립 게이트 병렬 실행(기본 1) |
| `--timeout S` | 게이트당 제한 시간(기본 120초) |
| `--shell PATH` | 명령 셸 지정 |
| `--scope ID` | `.unlazy/<ID>` 파이프라인 대상 |

종료 코드: `0` 전부 충족, `1` 미충족 또는 인계 필요, `2` 사용법·파싱·인프라 오류,
`3` 소유권 충돌.

### 그 외 스크립트

| 스크립트 | 용도 |
|---|---|
| `gate-lint.mjs` | 원장 품질 점검(비실행). `--strict`로 경고를 실패 처리 |
| `export-audit.mjs` | 감사 자료 생성(md/json/csv) |
| `personalize.mjs` | 문서의 `<skill-dir>`를 실제 경로로 치환 |
| `install-bridge.mjs` | SuperClaude 브리지를 `~/.claude/`에 설치 |
| `install-hooks.mjs` | Stop 훅 설치(동의 필요). `--uninstall`로 제거 |

## 업무 산출물 검증

코드가 아닌 산출물, 곧 보고서·데이터·배치 로그를 위한 검증기 6종. 전부 의존성 없이
동작하고 **파일을 읽기만 한다**.

| 검증기 | 대표 옵션 |
|---|---|
| `check-file` | `--min-bytes` `--max-age-hours` `--sha256` `--newer-than` |
| `check-encoding` | `--expect` `--no-bom` `--no-mojibake` `--consistent` |
| `check-csv` | `--require-columns` `--unique-column` `--no-empty-cells` `--sum-column` `--reconcile-with` |
| `check-docx` | `--require-heading` `--forbid-text` `--no-placeholders` `--min-words` `--min-tables` |
| `check-xlsx` | `--require-sheet` `--cell` `--no-error-cells` `--no-placeholders` |
| `check-batch-log` | `--positive-control` `--require-pattern` `--forbid-pattern` `--ignore-pattern` |

모든 검증기는 통과 시에만 `UNLAZY-CHECK-OK <이름>: <측정값>`을 출력하고, 실패 시에는
그 표지를 절대 내지 않는다. 그래서 `EXPECT:`에 검증기 이름까지 적는 것이 안전하다.
전체 옵션은 `--help`와 [checks/README.md](checks/README.md) 참조.

**데이터 대사**가 가장 실용적이다. 두 파일을 각각 독립 측정해 비교한다.

```bash
node ~/.claude/skills/unlazy/checks/check-csv.mjs "입력/원장계.csv" --sum-column "거래금액" --reconcile-with "입력/정산계.csv" --reconcile-rows
```

### 한국어 게이트 템플릿

```bash
cp ~/.claude/skills/unlazy/templates/gates-report-ko.md GATES.md
```

```bash
cp ~/.claude/skills/unlazy/templates/gates-recon-ko.md GATES.md
```

자리표시자를 실제 파일명과 절 이름으로 바꾸면 바로 쓸 수 있다.

### 부재 검사에는 양성 대조가 필요하다

"오류가 없다", "자리표시자가 남아 있지 않다" 같은 주장은 탐지기가 고장 났을 때도,
경로가 틀렸을 때도, 대상이 비었을 때도 똑같이 통과한다. **통과했다는 사실만으로는
아무것도 증명되지 않는다.**

`check-batch-log`는 이 규칙을 기계적으로 강제한다. `--forbid-pattern`을 쓰면서
`--positive-control`을 주지 않으면 종료 코드 2로 거부한다.

```bash
node ~/.claude/skills/unlazy/checks/check-batch-log.mjs "로그/야간배치.log" --positive-control "배치 시작" --require-pattern "정상 종료" --forbid-pattern "ERROR|오류"
```

나머지 부재 옵션은 강제할 수 없으므로 규율로 남는다. 자리표시자나 오류 셀이 확실히
든 사본으로 같은 명령을 한 번 돌려 **실패하는 것**을 확인하고 그 결과를 수동 게이트의
증거로 남긴다. 한국어 템플릿 두 개에는 그 게이트가 미리 들어 있다.

## 한국어·Windows 환경

- **CP949 출력.** 콘솔 코드 페이지가 CP949인 환경에서 네이티브 도구는 CP949 바이트를
  낸다. 이를 UTF-8로 읽으면 오류가 아니라 **문자가 깨진 텍스트**가 되어, 한국어
  `EXPECT:`가 실제로 존재하는 문자열을 조용히 놓친다. `--output-encoding cp949` 또는
  `UNLAZY_OUTPUT_ENCODING`으로 선언한다. 선언한 값은 승인에 묶인다.
- **원장은 UTF-8(BOM 없음)로 저장한다.** CP949로 저장하면 한국어 게이트 제목이 파싱
  단계에서 깨진다.
- **`EXPECT:`는 ASCII로 쓴다.** CP949 콘솔에서 한국어 EXPECT는 바이트가 어긋날 수
  있다. 검증기의 성공 표지가 ASCII인 이유다.
- **경로에 공백이 있으면 큰따옴표로 감싼다.** `cmd.exe`에서 작은따옴표는 인용부호가
  아니다.

## 반복 점검 자동화

일일 점검이나 데이터 대사처럼 "매일 다시 참이어야 하는" 항목은 원장을 상시 유지하고
스케줄러에서 `--reverify`를 돌린다. 실패하면 체크박스가 해제되므로 원장 자체가
"언제부터 무엇이 깨졌는가"의 기록이 된다.

```bash
node ~/.claude/skills/unlazy/scripts/gate-check.mjs --reverify GATES.md
```

승인은 명령·작업 디렉터리·셸·`PATH`에 묶이므로, 스케줄러 실행 계정과 환경을 승인
시점과 같게 고정해야 재승인 루프를 피할 수 있다. 승인 저장소가 계정 홈 아래
(`~/.unlazy/approved`)에 있으므로 같은 계정으로 돌려야 한다.

## 감사 자료

원장·승인 기록·상태 로그·디스패치 상태를 읽기 전용으로 모아 제출 가능한 형태로 묶는다.

```bash
node ~/.claude/skills/unlazy/scripts/export-audit.mjs --format md GATES.md --actor "사번 홍길동" --out 감사자료.md
```

승인 없이 통과 기록만 있는 게이트, 고아 승인, 포기된 게이트 같은 지적 사항을 함께
보고하고, 원본 파일의 SHA-256 매니페스트로 사후 변조를 탐지한다. CSV는 엑셀용으로
UTF-8 BOM을 붙인다. 사용법은 [docs/audit-export-ko.md](docs/audit-export-ko.md).

## 보안 경계

**이것은 샌드박스가 아니다.** 안전 경계는 사람의 검토와 명시적 승인이다.

- `CHECK:`는 셸 코드다. `--status`, 린터, 감사 익스포트, Stop 훅은 **아무것도 실행하지
  않는다**. 실행 경로는 `--approve` 하나뿐이다.
- 승인은 명령 하나가 아니라 실행 문맥 전체에 묶인다. 명령, 기대값, 작업 디렉터리,
  셸 절대경로, 타임아웃, 출력·정규식 한도, 플랫폼, 상속된 `PATH` 전문, 출력 인코딩,
  그리고 선언한 `DEPS:` 파일들의 해시. 하나라도 바뀌면 재승인을 요구한다.
- `--gate`로 **한 번에 하나씩 승인**할 수 있다. 파일 안의 모든 명령을 한꺼번에
  승인하지 않아도 된다.
- 배포 코드에 **네트워크 API가 전무**하다. 텔레메트리도 외부 전송도 없다.
- 승인 기록은 저장소 밖(`~/.unlazy/approved`)에 저장되며, 저장소 안을 가리키면 거부한다.

사내 보안 검토용 한국어 답변서가 있다. 주장마다 검토자가 직접 재현할 수 있는 확인
명령을 붙였다: [docs/security-review-ko.md](docs/security-review-ko.md).
그 문서의 사실 주장은 `tests/security-claims-tests.mjs`가 회귀 테스트로 고정한다.

전체 위협 모델(영문)은 [SECURITY.md](SECURITY.md).

## 이 포크가 추가한 것

| 추가 | 내용 |
|---|---|
| 한국어 트리거 | "게이트 걸고", "끝까지 완료해" 같은 지시에 스킬이 발동 |
| `checks/` 검증기 6종 | 보고서·CSV·Excel·로그·인코딩 검증. 의존성 0, 순수 읽기 |
| 한국어 게이트 템플릿 | 보고서용·대사용 2종, 양성 대조 게이트 포함 |
| 감사 익스포트 | `scripts/export-audit.mjs` |
| SuperClaude 브리지 | 두 체계의 역할 분담과 용어 충돌 정리(`bridge/`) |
| `DEPS:` 속성 | 호출 스크립트의 해시를 승인에 바인딩 |
| `--output-encoding` | CP949 출력 디코딩 |
| `verified-at` 증거 | 검증이 끝난 시각을 증거에 기록 |
| `--json` | 기계 판독 판정 출력 |
| `--gate` | 게이트 단위 승인 |
| 보안 검토 답변서 | 재현 명령을 포함한 한국어 문서 |

아래 다섯은 호스트 중립적 개선이라 업스트림 PR 후보로 각각 독립 브랜치에도 두었다:
`deps-digest-pr`, `output-encoding-pr`, `evidence-timestamp-pr`, `json-output-pr`,
`gate-filter-pr`. 전부 opt-in이며, 선언하지 않은 원장은 이전과 동일하게 동작한다.

## 테스트

```bash
npm test
```

업스트림 회귀 테스트와 이 포크가 추가한 테스트를 모두 실행한다. 오프라인에서
완결되므로 폐쇄망 반입 검증에 그대로 쓸 수 있다.

## 문서

- [checks/README.md](checks/README.md) 업무 산출물 검증기
- [docs/security-review-ko.md](docs/security-review-ko.md) 사내 보안 검토 답변서
- [docs/audit-export-ko.md](docs/audit-export-ko.md) 감사 자료 익스포트
- [references/gates.md](references/gates.md) 게이트 형식 규격(영문)
- [SECURITY.md](SECURITY.md) 위협 모델(영문)
- [README.en.md](README.en.md) 원본 영문 README

## 업스트림과의 관계

`main` 브랜치는 [Leonxlnx/unlazy](https://github.com/Leonxlnx/unlazy)의 미러이고,
이 포크의 작업은 `personal` 브랜치에 있다.

```bash
git fetch upstream && git rebase upstream/main personal && npm test
```

`UPSTREAM.lock`에 기준 커밋을 기록해 둔다. 이 README는 한국어이므로 업스트림이
`README.md`를 고치면 충돌한다. 해결은 항상 ours를 유지하고, 업스트림의 실질 변경분만
`README.en.md`에 반영한다.

## 라이선스

[MIT](LICENSE). 원 저작권자 Leonxlnx의 고지를 유지한다.
