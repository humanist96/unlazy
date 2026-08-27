<div align="center">

# unlazy (한국어 포크)

**AI 에이전트의 "완료했습니다"를 실행 가능한 증거로 바꾸는 규율 도구.**

작업 전에 수락 기준을 원장에 적고, 검토한 명령만 실행하고, 보고 직전에 다시 검증한다.
증거가 뒷받침하는 것만 완료라고 말한다.

[빠른 시작](#빠른-시작) · [게이트 계약](#게이트-계약) · [업무 산출물 검증](#업무-산출물-검증) · [보안 경계](#보안-경계) · [이 포크가 추가한 것](#이-포크가-추가한-것)

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

Claude Code 기준으로 스킬 디렉터리에 클론한다.

```bash
git clone -b personal https://github.com/humanist96/unlazy ~/.claude/skills/unlazy
```

문서에 박힌 `<skill-dir>` 자리표시자를 실제 설치 경로로 바꾼다. 업스트림을 다시
받아온 뒤에도 이 명령 한 번이면 복원된다.

```bash
node ~/.claude/skills/unlazy/scripts/personalize.mjs
```

외부 패키지 의존성이 **0개**이고 Node 16 이상이면 동작한다. `npm install` 단계가
없으므로 폐쇄망에 그대로 반입할 수 있다. 반입 후 무결성 확인은 `npm test` 한 번이면
된다.

## 빠른 시작

새 세션에서 한국어로 지시하면 스킬이 자동으로 발동한다.

```text
3월 점검 보고서 작성해줘. 게이트 걸고 끝까지 완료해
원장계랑 정산계 대사해줘. 검증하고 보고해
```

명시적으로 부르려면 `/unlazy`를 쓴다. 사소한 수정이나 단순 질문에는 쓰지 않는다.

직접 다루는 흐름은 다음과 같다.

```text
GATES.md 작성 → --status로 명령 검토 → --approve로 승인·실행 → 증거 자동 기록 → --reverify로 재검증
```

```bash
node ~/.claude/skills/unlazy/scripts/gate-check.mjs --status GATES.md
```


어느 모드에든 `--json`을 붙이면 표준 출력에 기계 판독용 객체 하나가 나오고, 사람용
전사는 표준 오류로 간다. 부모가 자식을 검증할 때는 출력 문구를 substring으로 맞추지
말고 verdict를 읽는다.

```bash
node ~/.claude/skills/unlazy/scripts/gate-check.mjs --json --reverify GATES.md
```

`--status`는 어떤 경우에도 명령을 실행하지 않는다. 명령을 전부 읽고 이해한 뒤에만
승인한다.

```bash
node ~/.claude/skills/unlazy/scripts/gate-check.mjs --approve GATES.md
```

## 게이트 계약

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
```

- **성공 조건은 두 가지가 동시에** 성립해야 한다. 종료 코드 0, 그리고 `EXPECT:`가
  출력에 나타날 것. 실패한 프로세스의 오류 메시지에 기대 문자열이 우연히 들어
  있어도 통과가 아니다.
- **증거는 자동으로 기록된다.** 해석된 셸과 작업 디렉터리, 종료 코드, `PATH` 지문,
  출력의 SHA-256 해시, 검증이 끝난 시각(`verified-at`, ISO 8601 UTC)이 남는다.
  시각은 로컬 시계를 읽은 값이라 실행을 증명하지는 않고 날짜와 순서를 알려준다.
  성공한 출력의 원문은 저장하지 않으므로 산출물에 민감 정보가 있어도 원장에
  복사되지 않는다.
- **`DEPS:`는 선택 사항이다.** 명령이 실행하는 파일의 해시를 승인에 묶어, 그 스크립트를
  다시 쓰면 명령 텍스트가 같아도 재승인을 요구한다.
- **불가능해진 기준은 지우지 않는다.** `ABANDON: G3 <사유>`로 남기면 인계 상태로
  종결되며, 이는 절대 성공으로 집계되지 않는다.

전체 규격은 [references/gates.md](references/gates.md)에 있다. 원장을 작성한 뒤에는
품질 린터로 한 번 훑는다.

```bash
node ~/.claude/skills/unlazy/scripts/gate-lint.mjs GATES.md
```

## 업무 산출물 검증

코드가 아닌 산출물, 곧 보고서·데이터·배치 로그를 위한 검증기 6종이 있다. 전부
의존성 없이 동작하고 파일을 읽기만 한다.

| 검증기 | 대상 | 대표 확인 항목 |
|---|---|---|
| `check-file` | 모든 파일 | 존재, 최소 크기, SHA-256, 생성 시각(오늘 산출물인지) |
| `check-encoding` | 텍스트 여러 개 | UTF-8/CP949 판별, BOM, 문자 깨짐, 파일 간 일관성 |
| `check-csv` | CSV | 필수 컬럼, 행 수, 중복·공백 키, **두 파일 독립 측정 대사** |
| `check-docx` | Word 보고서 | 필수 절, 분량, 표 개수, 자리표시자 잔존 |
| `check-xlsx` | Excel | 시트·셀 값, `#REF!` 등 오류 셀 |
| `check-batch-log` | 배치 로그 | 완료 배너, 금지 문자열, 로그 신선도 |

한국어 게이트 템플릿을 복사해 쓰면 바로 시작할 수 있다.

```bash
cp ~/.claude/skills/unlazy/templates/gates-recon-ko.md GATES.md
```

자세한 옵션은 [checks/README.md](checks/README.md) 참조.

### 부재 검사에는 양성 대조가 필요하다

"오류가 없다", "자리표시자가 남아 있지 않다" 같은 주장은 탐지기가 고장 났을 때도,
경로가 틀렸을 때도, 대상이 비었을 때도 똑같이 통과한다. 통과했다는 사실만으로는
아무것도 증명되지 않는다.

`check-batch-log`는 이 규칙을 기계적으로 강제한다. `--forbid-pattern`을 쓰면서
`--positive-control`을 주지 않으면 종료 코드 2로 거부한다.

```bash
node ~/.claude/skills/unlazy/checks/check-batch-log.mjs "로그/야간배치.log" --positive-control "배치 시작" --forbid-pattern "ERROR|오류"
```

나머지 부재 옵션은 강제할 방법이 없으므로 규율로 남는다. 한국어 템플릿 두 개에는
그 확인용 수동 게이트가 미리 들어 있다.

## 한국어·Windows 환경 지원

- **CP949 출력 디코딩.** 콘솔 코드 페이지가 CP949인 환경에서 네이티브 도구는 CP949
  바이트를 낸다. 이를 UTF-8로 읽으면 오류가 아니라 **문자가 깨진 텍스트**가 되어,
  한국어 `EXPECT:`가 실제로 존재하는 문자열을 조용히 놓친다. `--output-encoding cp949`
  또는 `UNLAZY_OUTPUT_ENCODING`으로 선언하면 해결된다. 선언한 값은 승인에 묶인다.
- **원장은 UTF-8(BOM 없음)로 저장한다.** CP949로 저장하면 한국어 게이트 제목이
  파싱 단계에서 깨진다.
- **`EXPECT:`는 ASCII로 쓴다.** CP949 콘솔에서 한국어 EXPECT는 바이트가 어긋날 수
  있다. 검증기의 성공 표지가 ASCII(`UNLAZY-CHECK-OK`)인 이유다.
- **`cmd.exe`에서는 `~`가 확장되지 않는다.** 전체 경로를 쓰거나 Git Bash를 쓴다.
  공백이 있는 경로는 큰따옴표로 감싼다.

## 감사 자료

원장·승인 기록·상태 로그·디스패치 상태를 읽기 전용으로 모아 제출 가능한 형태로
묶는다. 한국어 Markdown, JSON, 엑셀용 CSV를 지원한다.

```bash
node ~/.claude/skills/unlazy/scripts/export-audit.mjs --format md GATES.md --actor "사번 홍길동" --out 감사자료.md
```

승인 없이 통과 기록만 있는 게이트, 고아 승인, 포기된 게이트 같은 지적 사항을 함께
보고하고, 원본 파일의 SHA-256 매니페스트로 사후 변조를 탐지할 수 있게 한다. 사용법은
[docs/audit-export-ko.md](docs/audit-export-ko.md) 참조.

## 보안 경계

**이것은 샌드박스가 아니다.** 안전 경계는 사람의 검토와 명시적 승인이다.

- `CHECK:`는 셸 코드다. `--status`, 린터, 감사 익스포트, Stop 훅은 **아무것도 실행하지
  않는다**. 실행은 `--approve` 경로 하나뿐이다.
- 승인은 명령 하나가 아니라 실행 문맥 전체에 묶인다. 명령, 기대값, 작업 디렉터리,
  셸 절대경로, 타임아웃, 출력·정규식 한도, 플랫폼, 상속된 `PATH` 전문, 그리고 선언한
  `DEPS:` 파일들의 해시. 하나라도 바뀌면 재승인을 요구한다.
- 배포 코드에 **네트워크 API가 전무**하다. 텔레메트리도 외부 전송도 없다.
- 승인 기록은 저장소 밖(`~/.unlazy/approved`)에 저장되며, 저장소 안을 가리키면 거부한다.

사내 보안 검토용 한국어 답변서가 있다. 주장마다 검토자가 직접 재현할 수 있는 확인
명령을 붙였다: [docs/security-review-ko.md](docs/security-review-ko.md).
그 문서의 사실 주장은 `tests/security-claims-tests.mjs`가 회귀 테스트로 고정한다.

전체 위협 모델(영문)은 [SECURITY.md](SECURITY.md)에 있다.

## 이 포크가 추가한 것

| 추가 | 내용 |
|---|---|
| 한국어 트리거 | "게이트 걸고", "끝까지 완료해" 같은 한국어 지시에 스킬이 발동 |
| `checks/` 검증기 6종 | 보고서·CSV·Excel·로그·인코딩 검증. 의존성 0, 순수 읽기 |
| 한국어 게이트 템플릿 | 보고서용·대사용 2종, 양성 대조 게이트 포함 |
| 감사 익스포트 | `scripts/export-audit.mjs` |
| SuperClaude 브리지 | 두 체계의 역할 분담과 용어 충돌 정리 (`bridge/`) |
| `DEPS:` 속성 | 호출 스크립트의 해시를 승인에 바인딩 |
| CP949 출력 디코딩 | `--output-encoding` |
| 보안 검토 답변서 | 재현 명령을 포함한 한국어 문서 |

`DEPS:`와 `--output-encoding`은 호스트 중립적 개선이라 업스트림 PR 후보로 별도
브랜치(`deps-digest-pr`, `output-encoding-pr`)에도 두었다. 둘 다 opt-in이며,
선언하지 않은 원장은 이전과 완전히 동일하게 동작한다.

## 테스트

```bash
npm test
```

업스트림 회귀 테스트와 이 포크가 추가한 테스트를 모두 실행한다. 오프라인에서 완결되므로
폐쇄망 반입 검증에 그대로 쓸 수 있다.

## 문서

- [checks/README.md](checks/README.md) 업무 산출물 검증기
- [docs/security-review-ko.md](docs/security-review-ko.md) 사내 보안 검토 답변서
- [docs/audit-export-ko.md](docs/audit-export-ko.md) 감사 자료 익스포트
- [references/gates.md](references/gates.md) 게이트 형식 규격 (영문)
- [SECURITY.md](SECURITY.md) 위협 모델 (영문)
- [README.en.md](README.en.md) 원본 영문 README

## 업스트림과의 관계

`main` 브랜치는 [Leonxlnx/unlazy](https://github.com/Leonxlnx/unlazy)의 미러이고,
이 포크의 작업은 `personal` 브랜치에 있다. 업스트림 갱신은 다음으로 받는다.

```bash
git fetch upstream && git rebase upstream/main personal && npm test
```

`UPSTREAM.lock`에 기준 커밋을 기록해 둔다.

## 라이선스

[MIT](LICENSE). 원 저작권자 Leonxlnx의 고지를 유지한다.

## 근거

원본 저장소가 인용하는 연구 목록과 재현 한계 고백은 [README.en.md](README.en.md)와
[research/validation-protocol.md](research/validation-protocol.md)에 있다. 이 도구는
특정한 성능 향상을 보증하지 않는다. 구조를 강제할 뿐이고, 그 구조가 유용한지는
쓰는 쪽이 측정해야 한다.
