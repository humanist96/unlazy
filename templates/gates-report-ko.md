# Gates: <보고서 이름, 예: 2026년 3월 일일 시스템 점검 보고서>

Scope: <이 원장이 책임지는 완성 산출물 한 문장, 예: 점검 결과 보고서 1건을 작성해 지정 폴더에 docx로 저장한다>

- [ ] G1: 보고서 파일이 지정 위치에 오늘 날짜로 생성되었다
  CHECK: node <skill-dir>/checks/check-file.mjs "산출물/일일점검_보고서.docx" --min-bytes 20000 --max-age-hours 24
  EXPECT: UNLAZY-CHECK-OK check-file
  EVIDENCE: pending

- [ ] G2: 보고서가 요구된 모든 절을 포함하고 분량 기준을 충족한다
  CHECK: node <skill-dir>/checks/check-docx.mjs "산출물/일일점검_보고서.docx" --require-heading "개요" --require-heading "점검 결과" --require-heading "특이사항" --require-heading "결론" --min-words 800 --min-tables 1
  EXPECT: UNLAZY-CHECK-OK check-docx
  EVIDENCE: pending

- [ ] G3: 보고서에 채우지 않은 템플릿 자리표시자가 남아 있지 않다
  CHECK: node <skill-dir>/checks/check-docx.mjs "산출물/일일점검_보고서.docx" --no-placeholders --forbid-text "샘플"
  EXPECT: UNLAZY-CHECK-OK check-docx
  EVIDENCE: pending

- [ ] G4: 첨부 데이터 파일의 인코딩이 사내 표준(UTF-8, BOM 없음)을 따른다
  CHECK: node <skill-dir>/checks/check-encoding.mjs "산출물/점검_상세내역.csv" --expect utf8 --no-bom --no-mojibake
  EXPECT: UNLAZY-CHECK-OK check-encoding
  EVIDENCE: pending

- [ ] G5: G3의 자리표시자 탐지기가 실제로 탐지에 성공함을 양성 대조로 확인했다
  EVIDENCE: pending

<!--
사용법: 이 파일을 GATES.md로 복사한 뒤 모든 <자리표시자>를 실제 값으로 교체한다.

작성 규칙
- 게이트 제목과 ABANDON 사유는 한국어로 쓴다. CHECK, EXPECT, EVIDENCE, CWD,
  OWNS, ABANDON 키워드와 대문자 상태 어휘는 파서·프로토콜 계약이므로 영어를
  그대로 유지한다.
- EXPECT는 반드시 ASCII로 쓴다. 사내 표준 콘솔이 CP949라서 한국어 EXPECT는
  바이트가 깨져 매칭에 실패할 수 있다. 검증기의 성공 표지는 항상 ASCII다.
- GATES.md 자체는 UTF-8(BOM 없음)로 저장한다. CP949로 저장하면 파서 단계에서
  한국어 제목이 깨진다.
- 경로에 공백이 있으면 큰따옴표로 감싼다. 기본 셸이 cmd.exe이므로 작은따옴표는
  인용부호로 동작하지 않는다.

G5가 왜 별도 게이트인가
- G3은 "없음"을 주장하는 부재 검사다. 부재 검사는 탐지기가 고장 나 있어도, 경로가
  틀려 엉뚱한 파일을 읽어도 똑같이 통과한다. 그래서 자리표시자가 확실히 들어 있는
  파일 하나를 만들어 같은 명령을 돌려 보고, 그 실행이 실패로 끝나는 것을 눈으로
  확인한 뒤에야 G3의 통과를 믿을 수 있다.
- 확인 방법: 보고서 사본에 "TODO"를 한 줄 넣고 G3의 CHECK를 그대로 실행한다.
  종료 코드 1과 CHECK FAILED 메시지가 나와야 한다. 그 결과를 G5의 EVIDENCE에
  적는다. 예: EVIDENCE: 2026-03-05 사본에 TODO 삽입 후 동일 명령 실행, exit=1
  및 placeholder 1건 보고 확인 (검토자: 홍길동)

검증기 목록과 옵션은 <skill-dir>/checks/README.md 참조.
불가능해진 게이트는 삭제하지 말고 아래를 파일 왼쪽 끝에 추가한다.

```text
ABANDON: G<번호> <비어 있지 않은 사유와 인계 내용>
```
-->
