# Gates: <대사 업무 이름, 예: 일일 거래내역 대사>

Scope: <한 문장, 예: 원장계 추출본과 정산계 추출본의 거래건수와 금액이 일치함을 확인하고 차이 목록을 남긴다>

- [ ] G1: 양쪽 추출 파일이 오늘 생성되었고 비어 있지 않다
  CHECK: node <skill-dir>/checks/check-file.mjs "입력/원장계_거래내역.csv" --min-bytes 1000 --max-age-hours 24
  EXPECT: UNLAZY-CHECK-OK check-file
  EVIDENCE: pending

- [ ] G2: 두 추출 파일의 인코딩이 서로 같고 문자 깨짐이 없다
  CHECK: node <skill-dir>/checks/check-encoding.mjs "입력/원장계_거래내역.csv" "입력/정산계_거래내역.csv" --consistent --no-mojibake
  EXPECT: UNLAZY-CHECK-OK check-encoding
  EVIDENCE: pending

- [ ] G3: 원장계 파일이 필수 컬럼을 갖추고 키 컬럼에 중복과 공백이 없다
  CHECK: node <skill-dir>/checks/check-csv.mjs "입력/원장계_거래내역.csv" --require-columns "거래일자,거래번호,계좌번호,거래금액" --unique-column "거래번호" --no-empty-cells "거래금액" --min-rows 1
  EXPECT: UNLAZY-CHECK-OK check-csv
  EVIDENCE: pending

- [ ] G4: 두 계통의 거래금액 합계와 건수가 일치한다
  CHECK: node <skill-dir>/checks/check-csv.mjs "입력/원장계_거래내역.csv" --sum-column "거래금액" --reconcile-with "입력/정산계_거래내역.csv" --reconcile-rows --tolerance 0.01
  EXPECT: UNLAZY-CHECK-OK check-csv
  EVIDENCE: pending

- [ ] G5: 대사 결과 산출물에 오류 셀과 미기재 항목이 없다
  CHECK: node <skill-dir>/checks/check-xlsx.mjs "산출물/대사결과.xlsx" --require-sheet "대사요약" --no-error-cells --no-placeholders --min-rows "대사요약:2"
  EXPECT: UNLAZY-CHECK-OK check-xlsx
  EVIDENCE: pending

- [ ] G6: G5의 오류 셀 탐지가 실제로 동작함을 양성 대조로 확인했다
  EVIDENCE: pending

<!--
사용법: 이 파일을 GATES.md로 복사한 뒤 모든 <자리표시자>와 컬럼명을 실제 값으로
교체한다.

대사 설계에서 가장 중요한 한 가지
- G4는 두 파일을 각각 독립적으로 측정해 비교한다(--reconcile-with). 이것이 진짜
  대사다.
- 반대로 --sum-equals 1234567 처럼 기대값을 직접 적어 넣으면, 작성자가 이미 믿고
  있던 숫자를 파일이 따라오는지만 확인하게 된다. 통제 합계가 다른 시스템에서
  독립적으로 나온 값일 때만 --sum-equals를 쓰고, 그 출처를 게이트 제목에 밝힌다.

작성 규칙
- 게이트 제목과 ABANDON 사유는 한국어로 쓴다. CHECK, EXPECT, EVIDENCE, CWD,
  OWNS, ABANDON 키워드는 파서 계약이므로 영어를 유지한다.
- EXPECT는 반드시 ASCII로 쓴다. CP949 콘솔에서 한국어 EXPECT는 깨질 수 있다.
- 원장계 추출본이 CP949로 내려오면 --encoding cp949를 명시하거나 기본값 auto에
  맡긴다. 인코딩이 섞여 있으면 G2가 먼저 잡아 준다.
- 경로에 공백이 있으면 큰따옴표로 감싼다.

G6이 왜 별도 게이트인가
- G5의 --no-error-cells는 부재 검사다. 시트 이름을 잘못 적어 아무 셀도 읽지 않은
  실행과, 모든 셀이 정상인 실행은 똑같이 통과한다. 그래서 #REF! 오류가 확실히 있는
  사본을 만들어 같은 명령이 실패하는 것을 확인한 뒤에야 G5를 믿는다.
- 확인 방법: 대사결과 사본의 셀 하나를 참조가 깨지도록 수정하고 G5의 CHECK를 그대로
  실행한다. exit=1과 오류 셀 위치 보고가 나와야 한다. 결과를 G6의 EVIDENCE에 적는다.
  예: EVIDENCE: 2026-03-05 사본 대사요약!C7을 #REF!로 만든 뒤 동일 명령 실행,
  exit=1 및 "대사요약!C7 = #REF!" 보고 확인 (검토자: 홍길동)

검증기 목록과 옵션은 <skill-dir>/checks/README.md 참조.
-->
