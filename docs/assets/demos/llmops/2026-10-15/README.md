# LLMOps 운영 화면 GIF · 2026-10-15

메인 README의 [11. LLMOps 운영 화면 시연](../../../../../README.md#llmops-운영-화면-시연)에 사용하는 파일입니다.

- 촬영 대상: `https://govbiz.vercel.app`의 실제 운영 관리자 화면
- 촬영 크기: 브라우저 뷰포트 1440×900. 최종 GIF는 화면을 폭 1200px로 축소하고 하단 자막을 붙인 1200×814px입니다.
- 형식: 실제 조회·화면 전환 장면을 순서대로 연결한 반복 GIF입니다. 연속 화면 녹화나 실제 처리 시간을 나타내지 않습니다.
- 공개 처리: 계정 이메일·검토자 식별 정보·내부 메타데이터를 불투명하게 가린 뒤 축소·인코딩했습니다. 원본 캡처는 저장소에 포함하지 않습니다.
- 촬영 범위: 기존 기록 조회, 저장하지 않은 자료 입력, 무료 설정·예산·연결 점검입니다. 새 모델 호출·평가 접수·검토 저장·한도 변경·일정 활성화는 하지 않았습니다.

## 파일 목록

| 기능 | GIF | 화면 경로 | 장면 | 재생 길이 |
| --- | --- | --- | ---: | ---: |
| 성능 대시보드 | [ops-dashboard.gif](ops-dashboard.gif) | `/ops/dashboard` | 5 | 14.2초 |
| 실사용 모니터링 | [ops-usage.gif](ops-usage.gif) | `/ops/usage` | 4 | 11.4초 |
| AI 실행 추적 | [ops-traces.gif](ops-traces.gif) | `/ops/traces` | 5 | 14초 |
| 운영 표본 품질 | [ops-production-quality.gif](ops-production-quality.gif) | `/ops/production-quality` | 5 | 15.1초 |
| 평가 이력·답변 검토 | [ops-evaluations.gif](ops-evaluations.gif) | `/ops/evaluations` | 5 | 15.3초 |
| 평가 자료 관리 | [ops-datasets.gif](ops-datasets.gif) | `/ops/datasets` | 3 | 9.5초 |
| 새 평가 준비 | [ops-new-evaluation.gif](ops-new-evaluation.gif) | `/ops/evaluations/new` | 4 | 11.7초 |
| 평가 예산 관리 | [ops-budget.gif](ops-budget.gif) | `/ops/budget` | 4 | 11.6초 |
| 정기 실행 | [ops-schedules.gif](ops-schedules.gif) | `/ops/schedules` | 4 | 10.2초 |

촬영 시 정기 접수는 비활성, 등록 계획은 0건, 일별 예산은 미설정이었습니다.
정기 실행 GIF는 실행 성공이 아니라 준비 조건과 무료 연결 점검 통과를 보여줍니다.
표시되는 성능·비용·검토 상태는 촬영 시점의 기록이며 전체 서비스 품질을 보증하지 않습니다.

## 갱신 방법

1. 실제 화면 변경 시 같은 기능의 조회·입력 단계를 다시 촬영합니다. 기록 생성이나 유료 실행이 필요하면 촬영과 구분해 승인된 범위에서 수행합니다.
2. 이메일·연락처·계정 및 검토자 정보·인증 정보·내부 식별 정보가 모든 장면에서 가려졌는지 확인합니다. 닫힌 패널의 좌표가 보이는 입력란을 덮지 않도록 검사합니다.
3. 가림 처리한 최종 GIF만 새 날짜 폴더에 넣고 메인 README의 이미지 경로와 설명을 함께 바꿉니다. 같은 파일명 덮어쓰기보다 날짜 경로를 바꿔 이미지 캐시를 구분합니다.
4. 모든 프레임의 자막·줄바꿈·가림 상태, 반복 재생과 이미지 링크를 확인하고 `git diff --check`를 실행합니다.
