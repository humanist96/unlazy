# 포크 전용 문서

업스트림 unlazy에는 없고 이 포크에서만 관리하는 문서 모음이다. 사내 도입과 운영에
필요한 내용을 담는다.

| 문서 | 용도 | 독자 |
|---|---|---|
| [security-review-ko.md](security-review-ko.md) | 사내 보안 검토 질의 답변서. 주장마다 검토자가 직접 재현할 수 있는 확인 명령을 포함 | 정보보호팀, 반입 심의 |
| [audit-export-ko.md](audit-export-ko.md) | 감사 자료 익스포트 사용법과 지적 사항 코드별 대응 | 감사 대응 담당, 운영 |

관련 위치.

- 문서·데이터 검증기와 사용법: [`../checks/README.md`](../checks/README.md)
- 한국어 게이트 템플릿: [`../templates/gates-report-ko.md`](../templates/gates-report-ko.md),
  [`../templates/gates-recon-ko.md`](../templates/gates-recon-ko.md)
- SuperClaude 결합 규칙: [`../bridge/UNLAZY-BRIDGE.md`](../bridge/UNLAZY-BRIDGE.md)
- 원본 위협 모델(영문): [`../SECURITY.md`](../SECURITY.md)

보안 검토 답변서의 사실 주장은 `tests/security-claims-tests.mjs`가 회귀 테스트로
고정한다. 코드가 바뀌어 주장이 거짓이 되면 `npm test`가 실패하므로, 문서가 조용히
낡는 일을 막는다.
