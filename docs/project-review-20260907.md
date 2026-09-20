# 기획 대조를 위한 추가 프로젝트 검수

[문서 목록](README.md) · [개발 전략·백로그](development-strategy-20260907.md)

검수일: 2026-09-07. 대상은 현재 작업 트리의 Frontend·Core API·AI Service·평가 도구·실행 스크립트다.
이 문서는 같은 날 앞서 작성된 [기존 검수 기록](code-audit-20260907.md)을 덮어쓰지 않는 **추가 검수**다.
당시 통과한 테스트 수·실제 모델 평가 결과를 이번 실행 결과로 재사용하지 않는다.

## 검수 판단

현재 구현은 기업마당 단발 검색 → 추천 카드 → 상세 → 선택 공고 HTML 근거 질문까지다.
기획서의 기업 조건 기반 후속 대화·관심 공고·알림·비교·신청 준비는 빠져 있다.
이들은 기존 코드 버그와 구분해 [기획 정합성 및 신규 개발 백로그](development-strategy-20260907.md)에 기록했다.
신규 기능을 임의로 한꺼번에 구현하거나, 검증을 통과시키기 위한 fallback·불필요한 추상화를 추가하지 않았다.

## 확인된 버그와 조치

| ID | 관찰한 실패와 영향 | 조치/검증 |
|---|---|---|
| BUG-F01 | 상세 요청의 fetch가 완료되지 않으면 무기한 로딩 | 상세 조회 10초 상한, 요청 취소·안전한 실패 화면. 늦은 응답 무시와 완료/이탈 시 timer 정리. 기존 구현에서 실패하던 회귀 테스트 통과 |
| BUG-F02 | 원문 질문 응답이 없으면 입력창·전송이 무기한 잠김 | 70초 상한, 시간 초과 안내, 입력 보존·수동 재전송. 이전 응답이 재요청 결과를 덮어쓰지 않음. ViewModel 및 App 화면 회귀 통과 |
| BUG-C01 | Core가 120 UTF-16 단위로 추천 이유 길이를 검사하여 AI 계약상 유효한 120 코드포인트 이유(한글 119자+보조 평면 문자)를 잘못 거부 | 내부 이유 길이를 `codePointCount`로 통일. 초과 길이 거부는 유지. 수정 전 새 회귀의 실패 확인 |
| BUG-C02 | 후보 제목/기관/요약/대상/기간/분야/지역을 `.take(n)`로 줄이며 보조 평면 문자를 반으로 잘라 손상된 문자열을 전달 | 같은 private 경계에서 `offsetByCodePoints`로 절단. 수정 전 실제 요청 DTO의 문자 손상을 회귀로 확인. 실제 AI HTTP에서 특정 오류 코드가 발생하는지는 별도 측정하지 않음 |
| BUG-I01 | Windows `core.autocrlf=true` 체크아웃으로 `verify-compose.sh`가 CRLF가 되어 WSL에서 `set ... pipefail` 이전에 종료 | root `.gitattributes`에 shell script LF 규칙, 해당 파일 줄바꿈 정규화. 실패하던 Fake Docker 안전장치 테스트 5개 재실행 통과 |
| BUG-E01 | 평가 도구가 기본 Windows 인코딩으로 한글 JSON/프롬프트를 읽고 쓰면서 Unicode 오류 또는 재현 불가능한 기록 생성 | UTF-8 읽기/쓰기와 신규 출력 LF 명시. cp949 환경을 모사하는 회귀 추가. 원문 평가 도구 122개 통과 |
| BUG-E02 | 고정 fixture/공식 HTML/캡처를 Git이 CRLF로 자동 변환하여 원본 바이트 SHA 검증 실패 | 해당 범위 `.gitattributes`에 원본 바이트 보존 규칙. 현재 줄바꿈을 원래 커밋 바이트로 복원. 총 21개 자료의 `git hash-object --no-filters`와 HEAD blob 일치 독립 확인. 과거 해시/점수/내용 수정 없음 |
| BUG-E03 | 검색 평가 CLI 테스트가 자격증명 차단을 위해 환경을 비우면서 Windows 필수 `SYSTEMROOT`도 제거해 asyncio 초기화 실패 | `SYSTEMROOT`만 선택적으로 보존. 자격증명·API 설정은 계속 상속하지 않음. CLI의 UTF-8 입력 회귀와 함께 관련 6개 테스트 통과 |

상세의 시간 초과 화면에는 새 재시도 버튼을 추가하지 않았다. 기존 검색 결과 돌아가기/재진입으로 다시 조회한다.
원문 질문의 70초는 화면 고착 방지 상한이며 응답속도 목표가 아니다. 브라우저 취소가 서버에서 이미 시작한 모델 실행·비용 취소를 보장하지 않는다.

공개 검색어·질문은 기존 UTF-16 500 단위 제한을 유지한다. 변경한 Unicode 기준은 AI 내부 후보와 추천 이유 계약이다.
Frontend 입력 길이 처리는 공개 Core 계약과 일치했으므로 임의 변경하지 않았다.

## 실행한 검증

| 대상 | 이번 실행 결과 | 조건과 해석 |
|---|---|---|
| Frontend | 21 files / **184 tests 통과**, lint 0 warnings/errors, TypeScript 및 Vite build 성공 | Node 24.19.0으로 설치된 프로젝트 CLI 직접 실행. 신규 회귀 5개. jsdom/mock HTTP이며 실제 브라우저 E2E 아님 |
| AI Service | **209 tests 통과**, 설치 의존성 66 packages compatible | Python 3.12.13, 잠금 개발 의존성. OpenAI HTTP stub 및 in-memory Qdrant 기준 |
| Compose 정리 안전장치 | **5 tests 통과** | WSL `/bin/bash`, Fake Docker만 사용. 실제 Docker 자원 변경/삭제 없음 |
| Core API 승인 전 비DB 회귀 | **40 suites / 336 tests 통과**, failures/errors/skipped 모두 0 | Linux JDK 21. Docker 의존 3개 스위트는 테스트용 임시 설정에서 명시적으로 제외. production·저장소 테스트 설정에 skip 추가 없음 |
| Core 수정 경계 별도 검증 | **16 tests 통과** | Unicode 경계 포함 RankingFacade 13개 + HTTP 프로토콜/redirect/150ms timeout 3개. 위 336개와 중복이므로 합산하지 않음 |
| Core 승인 후 전체 회귀·DB 통합 검증 | **43 suites / 379 tests 통과**, failures/errors/skipped 모두 0 | JDK 21.0.12 + 실제 MySQL 8.4.11. 기존에 막혔던 통합 43개 포함. 제외 설정·init-script 없이 clean test 전체 실행 |
| 원문 평가 도구 | **122 tests 통과** | 실제 모델 호출 없이 저장 기록·UTF-8 입출력·무결성 검사. 신규 회귀 1개 |
| 검색 평가 도구 | Windows 전체 **61개 중 59 통과·2 환경 오류**; 관련 replay **6 tests 통과** | 두 오류는 심볼릭 링크 생성 `WinError 1314`. 테스트 제외/검증 완화 없이 결과 보존 |
| 검색 평가 Linux 보완 | 관련 두 파일 **22/22 tests 통과** | WSL 기본 Python에서 `test_compare_captures`, `test_ranking_replay` 전체 실행. Windows에서 막혔던 두 심볼릭 링크 검증 포함. 다른 실행의 중복 테스트를 합산해 전체 테스트 수를 부풀리지 않음 |

### 실행 환경에서 구분한 실패

- 설치된 pnpm 11.19.0과 프로젝트가 지정한 11.22.x가 달라 `pnpm test`는 실행 전 차단됐다.
  의존성이나 engine을 느슨하게 변경하지 않고 `node node_modules/vitest/vitest.mjs run --maxWorkers=4`,
  `node node_modules/oxlint/bin/oxlint`, `node node_modules/typescript/bin/tsc -b`,
  `node node_modules/vite/bin/vite.js build`로 같은 로컬 도구를 실행했다.
- AI 첫 실행에서 기존 5초 SDK stub 테스트 1개가 신규 Windows 환경의 최초 로딩 중 timeout됐다.
  단독 재실행은 1.25초에 통과했고 전체 재실행도 209개 통과했다. 이를 제품 버그로 단정해 timeout을 늘리거나 테스트를 제외하지 않았다.
- Bash용 infra 테스트를 Windows Python으로 직접 실행하면 `/bin/bash` 부재로 실패한다.
  WSL에서 실행한 뒤 실제 CRLF 결함을 분리해 재현·수정했다.
- Windows JDK 21의 Gradle 통신에서 `UnixDomainSockets ... Invalid argument`가 발생하여 준비된 Linux JDK 21
  컨테이너로 검증을 옮겼다. 호스트 Docker 소켓을 컨테이너에 연결하면 테스트가 호스트 Docker 자원을 제어할 수 있어
  자동 승인 심사가 거절했다. 이 제한을 우회하지 않았고, 이후 사용자의 명시적 소켓 연결 승인을 받아 전체 MySQL 8.4 검증을 재개했다.
- Linux 검증에서 기존 `usesHttp11WithoutAttemptingH2cUpgrade` 테스트가 최초 Jackson 로딩 중 1초 제한에
  두 번 걸렸다. 이 테스트의 검증 대상은 HTTP/1.1·Upgrade 헤더·정상 응답이며 1초 성능이 아니므로,
  해당 테스트의 읽기 상한만 운영 기본과 같은 35초로 맞췄다. 실제 timeout을 검증하는 150ms 지연 테스트,
  redirect 테스트, production 제한시간은 바꾸지 않았다. 이는 테스트 안정화이며 제품 응답속도 개선이 아니다.

Core 첫 `./gradlew clean test --no-daemon` 시도는 379개 중 335 통과·44 실패였다.
43개는 Docker 접근 없는 `CoreApiApplicationTest` 2개·`SupportProgramRepositoryIntegrationTest` 37개·
`SupportProgramEvidenceIntegrationTest` 4개의 실행 환경 실패이며, 나머지 1개가 위 HTTP 테스트였다.
테스트 안정화 후 비DB 실행은 336개 모두 통과했다. 당시에는 이 성공으로 43개 통합 테스트의 성공을 대체하지 않았고,
사용자 승인 후 실제 MySQL 전체 실행으로 별도 검증을 완료했다.
최초 전체 XML은 `tmp/core-audit-full-test-results`, 중간 비DB 실패는 `tmp/core-audit-nondb-test-results`,
경계 16개는 `tmp/core-audit-targeted-test-results`, 최종 336개는 `tmp/core-audit-final-nondb-test-results`에
로컬 진단 자료로 보존했다. 마지막 XML의 개수·실패·skip 집계를 별도로 다시 확인했다.
최종 비DB 실행은 `./gradlew test --no-daemon --no-watch-fs`에 전용 Linux 캐시 경로와 로컬 임시
`backend/core-service/.gradle/core-audit-nondb.init.gradle`을 지정했다. 이 init-script는 위 3개 스위트만 제외한다.
사용자 승인 후에는 **이 제외 설정 없이** JDK 21에서 `./gradlew clean test --no-daemon --no-watch-fs`와
전용 Linux 프로젝트 캐시 경로만 지정해 실제 MySQL 8.4 및 379개 전체 결과를 다시 확인했다.

### 사용자 소켓 연결 승인 후 최종 검증

- 사용자 승인 범위인 이번 임시 테스트 runner에만 Docker 소켓을 연결했다. API 키나 실제 모델 평가 환경변수는 전달하지 않았다.
- JDK `21.0.12+8-LTS`, 실제 MySQL `8.4.11`, 테스트 DB `govbiz_test`를 사용했다. Flyway와 JDBC의 실제 MySQL 연결 로그를 확인했다.
- `BUILD SUCCESSFUL`, 5분 1초, 7개 작업 모두 실행. `clean` 이후 새 XML은 UTC `2026-09-07T04:41:01.968`부터 `04:43:58.549` 사이의 테스트 결과다.
- 전체 43개 스위트·379개 테스트, 실패/오류/건너뜀 0. 이전에 막혔던 `CoreApiApplicationTest` 2개,
  `SupportProgramRepositoryIntegrationTest` 37개, `SupportProgramEvidenceIntegrationTest` 4개가 모두 통과했다.
- 루트 검수에서도 보존된 XML 전체를 다시 파싱하여 379개·실패/오류/건너뜀 0과 위 세 스위트의 2/37/4개 결과를 확인했다.
- 최신 원문 질문 캡처는 `completed=true`, 기대/실제 질문 6개, `aiTransport=http-fixture`, `officialSourceTransport=frozen-official-html-fragments`다.
  실제 MySQL/HTTP/원문 조각을 통과한 검증이며, 실제 모델 품질을 새로 평가한 결과는 아니다.
- 최종 XML은 `tmp/core-audit-approved-full-test-results`, 원문 캡처는 `tmp/core-audit-approved-evidence-capture.json`에 보존했다.
- 정확한 실행 명령·이미지 ID·MySQL 버전 로그·정리 기록은 `tmp/core-audit-approved-runtime-evidence.txt`에 보존했다.
  runner는 소켓용 `DOCKER_HOST=unix:///var/run/docker.sock`과 동적 MySQL 포트 접근용
  `TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal`을 사용했다. 테스트 제외 환경변수나 init-script는 없었다.
- runner와 이번 Testcontainers 세션의 MySQL·Ryuk 컨테이너는 정리됐다. 실행 전 기록한 기존 사용자 컨테이너 5개의 ID·상태는 유지됐다.

따라서 앞선 **Core 전체 DB 통합 검증 승인 차단은 해소됐으며 검증을 완료했다.**
이 결과는 사용자 기능 개발 백로그, 실제 모델 의미 품질, 운영 부하·배포 검증까지 완료했다는 뜻은 아니다.

AI·평가 재현은 잠금 의존성을 설치한 `backend/ai-service/.venv/Scripts/python.exe`로 실행했다.
AI 디렉터리에서 `python -m pytest`와 `python -m pytest ../../evaluation/support-program-evidence`,
검색 평가 디렉터리에서 같은 Python의 `-B -m unittest discover`를 사용한다.
`-X utf8`로 결함을 숨기는 대신 파일 읽기/쓰기의 UTF-8을 코드에서 명시했다.
WSL 보완 명령은 검색 평가 디렉터리에서 `python3 -B -m unittest test_compare_captures test_ranking_replay`다.
문서의 로컬 링크 검사와 최종 `git diff --check`도 통과했다.

## 검증 한계와 보존 범위

- 이번 검수의 실제 유료 OpenAI 호출은 0회다. 과거 실제 모델 기록의 품질 수치를 새 측정으로 소개하지 않는다.
- 검색·추천의 일반 정확도, 실제 사용자 자격 판단, 운영 부하·비용·알림 전달은 검증하지 않았다.
- 경쟁 서비스는 공식 공개 자료로 기능 전략을 비교했으며 로그인/유료 기능이나 고객 성과를 실측하지 않았다.
- 기존 기획서 PDF, 과거 평가 점수·판정·캡처 내용, 학습용 SampleItem, 공개 API 필드·DB 스키마는 유지한다.
- 서버 신규 기능과 사용자 데이터는 만들지 않았다. API 활용신청·인증 서비스 선택·외부 알림 발송·운영 배포는 이번 범위가 아니다.

테스트 컨테이너는 `--rm`으로 실행 후 제거하며 기존 사용자 컨테이너·volume은 정리하지 않았다.
이번에 만든 `govbiz-core-audit-gradle-20260907` volume은 Linux Gradle 의존성/프로젝트 캐시만 포함하고
이번 승인된 통합 검증에서 재사용했고 이후 개발 검증의 캐시로 보존한다. 운영 DB volume이 아니다.

실제 호출 흐름은 기존 [아키텍처](architecture.md)를 유지한다.
AI 부분은 `HTTP API → Service → Agent → OpenAI → Response`이며,
이번 버그 회귀 테스트는 OpenAI 자리에 HTTP stub을 사용한다.
