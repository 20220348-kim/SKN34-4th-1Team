# Docker 전용 HWP 변경 검증

## HWP 경로 보존·Hangeul 분석·FFDetr PDF — 로컬 적용 완료 (2026-09-17)

기준 소스는 main `6f156cf`이며 이전 HWP 성공 이미지와 비교했다. HWP 단독 질문 추출의 이전 프롬프트·한도를 유지하고 Core HWP/PDF 기입기 코드는 변경하지 않았다. HWPX는 실제 표 구조를 먼저 읽은 뒤 문항을 추출하고 Hangeul 분석 도구로 위치를 검증한다. PDF는 로컬 FFDetr가 입력 후보를 탐지하고 원문 글자·표 경계로 대조한 뒤 기존 PDFBox가 기입한다. Extend 호출·키 설정은 사용하지 않았다. 기존 답변·파일·DB·볼륨과 운영 메모리 제한은 유지했다.

### 자동 검증

- Core: JDK 21/Linux에서 `./gradlew test bootJar --no-daemon --max-workers=2` **1,465개 통과, 실패·오류·skip 0**. 실제 MySQL 8.4 Testcontainers에서 큰 지도 JSON과 기본 262,144바이트 정렬 버퍼 조회를 검증했다. 이후 HWPX 내부 원본 전달 계약 수정 범위의 discovery HTTP·가용성·AI Client·queue·신청 API 테스트 **47개 통과** 후 최신 JAR를 패키징했다.
- AI: `uv run --locked --extra dev python -m pytest` 전체 **1,344개 통과**(248.43초). 실제 PDF에서 확인한 전화번호 칸 높이 보완 후 관련 신청 문서 테스트 **199개 통과**. 단위 테스트의 모델 대역과 아래 실제 API 검증을 구분한다.
- Docker: 고정 CPU PyTorch·RF-DETR 의존성과 모델 SHA-256을 포함한 이미지 빌드 성공. 최초 PyTorch 다운로드 DNS 실패는 같은 고정 의존성으로 재시도했다. 최종 diff 검사 통과. 이번 단계는 Frontend 코드를 바꾸지 않아 해당 테스트를 반복하지 않았다.

### 실제 공개 원본·가상 답변 검증

- HWPX: 서초구 융자 신청서의 실제 MCP 구조를 질문 추출 전에 제공했다. 공식 문항 **95개 중 90개 연결, 5개 수동 작성**으로 검증됐다. 같은 위치를 반복 반환하는 응답은 문항별 단일 대상과 위치별 포함 여부를 반환하도록 변경했다. 연도만 적힌 문항은 안내문의 행 근거도 확인한다.
- HWPX 생성: 대표자·기업명·연혁·제품·기술인력·담보·자금계획 및 12개 연도별 실적 칸에 **가상 답변 26개**를 기입했다. 독립 XML 대조에서 예상한 26개 셀만 변경됐고 다른 셀과 ZIP 자원은 동일했다. 최종 이미지에서도 기록된 계획으로 실제 MCP 편집·재검증 26개를 무료 재현했다. 너비 추정 17개 확인이며 한컴 페이지 렌더링은 실행하지 않았다.
- PDF: 서울 소상공인 온라인 홍보관 공개 PDF를 실제 AI HTTP 경로로 매핑해 **10개 입력칸 연결**을 확인했다. 동의 체크박스는 명시적인 수동 작성 항목이다. 탐지 박스와 원본 경계를 교집합으로 좁힐 때 전화번호 칸이 최소 글자 높이보다 작아지는 실패를 확인하고, 충분히 겹치는 원본 입력칸의 경계를 사용하도록 수정했다.
- 최종 PDF: **가상 답변 10개**의 실제 작성 계획을 받은 뒤 최신 Core JAR의 PDFBox 기입기를 실행했다. 재열기 시 AcroForm 값 10개·페이지 위젯 10개·appearance가 일치했다. 렌더 이미지에서 두 전화번호와 두 줄 홍보문을 확인했고 입력칸 밖 변경 픽셀은 **0개**였다. 사용자 답변을 사용하거나 DB에 가상 작성 건을 만들지 않았다.
- 이 단계의 실제 OpenAI 호출은 중간 실패·보정까지 **18회**이며 공개 원본·공식 문항·가상 답변만 사용했다. Extend 등의 별도 외부 PDF 분석 API는 호출하지 않았다.

### 메모리·로컬 적용·남은 범위

- FFDetr 단독 CPU 2개 평가: 모델 로딩 24.8초, 한 페이지 탐지 1.16초, 프로세스 최대 RSS 757.76MiB. 이는 서버 전체 메모리나 일반 성능 보장이 아니다.
- 실제 AI 서버를 **1GiB, 추가 스왑 없음, CPU 2개**로 제한한 별도 컨테이너에서 PDF 매핑(29.83초)·최종 생성 계획(33.16초)을 확인했다. 파일 캐시를 포함한 cgroup 최고 사용량은 한도 1GiB에 도달했고 메모리 회수 이벤트가 발생했으나 OOM·OOM kill·컨테이너 재시작은 0이었다. 공개 PDF 한 건의 순차 요청 결과이며 여러 업무의 동시 부하·운영 서버 용량을 보증하지 않는다.
- 로컬 AI 이미지: `sha256:25db7e28e5bd8a8f3ae3dcfb7f1ff57345213bd091992c4f6a7c9b632c68b454`. Core 이미지: `sha256:84b05b66b69f8229f45af78121c6b6d7c0d338e05813b14014dcce776f680a92`.
- AI 소스 11개와 실제 컨테이너 파일 hash가 일치한다. Core JAR SHA-256은 `3f2b554e63a301fc7f0a5f04e46d658d80981c0f870c53e2db7e461e7abea3d5`로 검증 JAR와 일치한다. 웹 `/`, `/api/v1/health`, `/api/v1/health/ai-service`는 모두 200. 자동 공고 분석은 비활성 상태를 유지했다.
- 운영 배포·원격 CI·실제 사용자 답변의 브라우저 전체 흐름과 모든 양식의 시각 품질은 미검증이다. 과거 작성 건은 보존되므로 기존의 포괄적인 문항은 화면의 입력칸별 재분석 경로로 새 양식을 확인해야 한다. 이번 변경은 미커밋·미푸시 상태다.

## skn-175 커밋 준비 시 최신 main 반영

- 원본 저장소 `main`의 `08ed0137ee588341b9fe420bb39a50e0b22f2df5`를 `pull --rebase`로 반영했다. 설치 문서 충돌은 새 AWS 토큰 안내를 보존하고 Docker 전용 실행 설명과 통합했다.
- 자동 병합으로 중복된 운영 토큰 선언을 제거해 해당 Compose·환경변수 예제는 최신 main과 같게 유지했다. 관련 운영 설정 계약 테스트 **14개 통과** 및 최종 diff 검사를 수행했다. Windows 실행에는 `DOCKER_CONFIG`와 Git Bash의 `sh` 경로를 명시했다.
- 문서 기능의 production 코드·테스트는 직전 검증본과 동일하다. 아래 전체 테스트·로컬 이미지 적용 기록은 main 반영 전 기준이며 새 main 전체 테스트·이미지 재빌드는 반복하지 않았다. 당시 기록한 채팅 테스트 실패를 새 main에서도 재현했다고 주장하지 않는다.

## skn-175 질문·입력칸 의미 대응 후속 수정 — 자동 검증·로컬 적용 완료

실제 사용자 결과에서 표 전체를 묻는 질문이 직위·구분 등 첫 열에 연결된 문제를 확인했다. 질문 추출을 실제 칸 단위로 변경하고, HWPX 표 제목·열 이름·첫 입력 행을 매핑에 전달하며 포괄적인 이전 질문은 재분석 대상으로 거절한다. PDF는 실제 선과 인쇄 글자로 구성한 빈 입력 영역을 선택하고 좌표는 서버가 원본에서 확정한다. 선택 항목의 미지원 입력칸은 명시적으로 기록하고 입력된 답변을 조용히 누락하지 않는다. UI는 입력 확인 수와 원문 직접 작성 항목을 표시하며 기존 작성본을 유지한 재분석 경로를 제공한다.

사용자 요청에 따라 이 단계에서는 추가 유료 모델 호출·실제 파일 반복 대조를 하지 않고 코드 수정·전체 자동 테스트·로컬 적용까지만 진행한다. 아래 과거 실제 모델 검증은 이 새 질문·매핑 정책의 품질 검증 결과로 재사용하지 않는다.

- Core 전체 `clean build --no-daemon`는 JDK 21/Linux 및 실제 Testcontainers 환경에서 **1,462개 통과, 실패·오류·skip 0**이었다.
- AI 전체 pytest는 **1,284개 통과 / 1개 실패**였다. 기존 `combination_review/test_review.py`의 50ms 제한 테스트가 모의 호출 진입 전에 종료되어 호출 수 단언에 실패했다. 제한·코드를 바꾸지 않고 해당 파일을 다시 실행하여 **34개 모두 통과**했다.
- Frontend 전체는 **1,234개 통과 / 3개 실패**였다. 카탈로그의 5초 제한 실패 2개는 해당 파일 재실행 **40개 통과**로 확인했다. 남은 `App.guestChatNavigation.test.tsx`의 기대 호출 수 2/실제 3 실패는 앞서 변경 없는 main에서도 재현한 기존 항목이다. lint/build는 통과했고 기존 번들 크기 경고는 남아 있다.
- 전체 실행 뒤 확인한 재분석 활성화 연결은 별도 수정했다. 요청한 공고의 실행권을 확보하고 검증된 결과를 활성 snapshot으로 게시하며, 진행 중 실행권과 이전 snapshot을 보존한다. 최초 추가 검증의 트랜잭션 경계 실패를 수정한 뒤 `ApplicationFormAvailabilityIntegrationTest`와 `ApplicationFormDiscoveryContractIntegrationTest`를 실제 MySQL에서 재실행해 **14개 통과, 실패·오류·skip 0**을 확인했다. 같은 실행에서 최신 `bootJar`를 만들었다. 전체 Core 1,462개 실행 뒤 변경한 범위에 대한 추가 검증이며 전체 테스트를 다시 실행한 것은 아니다.
- 최신 테스트 JAR로 production Dockerfile과 같은 runtime stage를 빌드하고 AI 이미지와 함께 로컬 `govbiz`의 Core·AI 컨테이너에 적용했다. 이전 이미지 태그, DB·볼륨·답변을 보존했다. 실행 JAR SHA-256 및 변경 AI 소스 6개의 hash가 검증본과 같고 이미지 ID도 일치했다. Web `/`, `/api/v1/health`, `/api/v1/health/ai-service`가 모두 HTTP 200이며 Vite가 재분석 버튼 코드를 제공한다. 추가 유료 호출·새 실제 문서 품질 대조·원격 CI·운영 배포는 실행하지 않았다. 작업은 `skn-175`, 미커밋·미푸시 상태다.

## skn-175 추가 오류 재현 및 수정 — 최종 검증

최신 main `4c0530d`를 pull --rebase로 반영하고 작업을 복원했으며 충돌은 없었다. 이후 공개 원본·공식 문항만 사용한 실제 매핑 재현에서 PDF는 사무실/휴대폰 칸 경계의 이진 부동소수 오차로 겹침이 잘못 검출되었다. HWPX는 존재하지 않는 scope ID, 반복 ID, 보호된 제목 문단 선택을 확인했으며 원본의 빈 본문 문단이 upstream 도구에서 누락된 원인도 확인했다. 최초 재현은 파일별 1회이며 입력한 회사 답변은 전송하지 않았다.

PDF 십진 좌표 비교, HWPX 빈 문단의 구조 주소 일치, 편집 가능한 실제 ID로 응답 제약, 중복 모델 입력 축소, 기존 요청 복구의 2분 대기 제한을 660초로 맞추는 수정을 추가했다. 실제 생성 단계에서 추가로 발견한 PDF 전화번호 라벨 침범과 미입력 동의·서명·날짜를 필수 누락으로 오인하는 문제도 보완했다. 인쇄 글자 좌표를 제공하고 겹침을 검증하며, 제한된 1회 모델 수정 요청과 제공된 답변 ID만 허용하는 계획 제약을 적용한다. PDF 원문과 새 입력 칸의 값은 분리하고 HWP의 Core 표 문맥은 유지한다.

### 실제 문서·모델 검증

- 사용자 승인 아래 공개 원본·공식 문항과 가상 값만 사용해 실제 OpenAI `gpt-5.6-luna` 진단 **10회**를 실행했다. 입력 413,114 / 출력 20,978 tokens이며 캐시 입력을 포함한다. 결제 금액으로 환산한 수치는 아니다. 저장된 사용자 답변은 전송하거나 변경하지 않았다.
- PDF 실제 매핑 11개 문항 통과 후 가상 기본정보 **9개**로 실제 모델 계획과 AI 생성 단계를 통과했다. 해당 응답의 bytes·placements를 기존 빌드 Core PDFBox 편집기에 전달하여 **9개 필드 기입·재열기**를 확인했다. 렌더링 화면에서 한글 값, 전화번호와 인쇄된 사무실/핸드폰 라벨, 제목·고지·동의·서명 영역 보존을 확인했다. 미입력 동의·날짜·서명은 생성하지 않았다.
- HWPX 실제 매핑 **34개** 문항 통과 후 동의 항목을 제외한 **32개** 가상 값으로 실제 모델 계획 → MCP preview/apply/verify를 통과했다. 요청·해결·적용·검증 모두 32, 미해결 0이며 재열기와 ZIP CRC를 확인했다. 변경된 ZIP 항목은 `Contents/section0.xml` 하나이고 다른 리소스는 원본과 byte 단위로 같았다. 한컴의 전체 페이지 렌더링 검증은 아니다.
- 별도 HWPX 빈 본문 검사에서는 663개 위치 중 두 곳만 가상 값으로 바뀌고 나머지 위치 ID·텍스트가 유지됐다. 완성 이미지의 네트워크를 차단한 실제 모델 계획 재생에서도 PDF 9개·HWPX 32개 생성 경로를 확인했다. 재생은 추가 모델 호출 없는 실행 엔진 검증이다.
- PDF 좌표 도구는 CropBox가 있는 0/90/180/270도 합성 PDF를 PDFBox로 독립 렌더링한 글자 픽셀과 대조해 네 방향 모두 통과했다.

### 회귀 검증 범위와 한계

- AI 전체 pytest **1,277개 통과**. Windows 임시 디렉터리 권한 오류는 새 작업 전용 `--basetemp`와 cache 경로로 분리해 재검증했다. 최종 HWP 문맥 보존 점검을 추가한 뒤 영향 범위인 `tests/application_preparation` 및 `test_document_mcp_contract.py` **171개 통과**, 최종 Docker 빌드 통과.
- Frontend 전체는 **1,231개 통과 / 2개 실패**였다. 기존 카탈로그 테스트의 5초 제한 초과는 코드·제한 변경 없이 재실행해 통과했다. 남은 `App.guestChatNavigation.test.tsx:207`의 호출 횟수 불일치(예상 2/실제 3)는 문서 변경이 없는 최신 main `4c0530d`의 독립 복사본에서도 동일하게 실패했다. 해당 채팅 코드는 수정하지 않았다. 문서 대기 회귀 테스트, lint/build는 통과했다. 기존 번들 크기 경고는 남아 있다.
- 이번 추가 수정은 Core 코드·DB 스키마를 변경하지 않아 Core 전체 테스트·MySQL 통합 테스트를 반복하지 않았다. Core PDF 소비 경로는 기존 빌드 편집기로 실제 응답을 기입해 확인했다. 전체 Compose 검증은 아래 이전 기록과 구분한다. 운영 Vercel/CloudFront 경유·원격 CI·사용자의 실제 답변 생성은 이번 진단 범위가 아니다.
- 작업 번호는 `skn-175`다. 최신 main 반영과 작업 복원에 충돌이 없었으며 백업 stash를 유지했다. 변경은 미커밋·미푸시 상태다.
- 최종 검증 이미지 `govbiz-skn175:validation`을 로컬 AI에 적용했다. 실행 이미지 ID와 주요 소스 8개 hash가 검증본과 일치하고 Web `/`, `/api/v1/health`, `/api/v1/health/ai-service`는 모두 HTTP 200이었다. Vite의 결과 복구 대기 코드 660초 반영도 확인했다. Core·DB·기존 답변·볼륨은 변경하지 않았다. 최종 `git diff --check` 통과.

## 2026-09-16 PDF·HWPX 오류 후속 검증

- PDF 공고 `PBLN_000000000126232`의 공식 신청서 SHA-256 `97aa18019e760bf0ba4d69a21e109fe2c0b04143c31a8acf83a95b9c66a3e5b2`로 실제 장애를 재현했다. 기본 PDF 도구 3개는 통과했지만 kordoc `parse_document`가 `MISSING_DEPENDENCY`로 실패했다. 고정 upstream lock의 `pdfjs-dist`가 dev로 표시되어 production prune에서 제거된 것이 원인이다. 별도 production lock으로 `pdfjs-dist@4.10.38`을 설치하고 빌드 시 import를 검사한다.
- HWPX의 위치·계획 분석이 일반 질문의 모델 25초/실행 30초 제한을 사용하던 연결 오류를 수정했다. 두 분석 메서드는 기존 문서 분석 설정 210초/240초를 사용하며 일반 질문의 제한은 유지한다. 실제 모델의 소요 시간과 최종 생성 성공은 이번 무과금 검증으로 입증하지 않는다.
- AI 전체 pytest 최초 실행: **1,246개 통과, 1개 실패**. 실패는 기존 `test_logging.py`의 root handler 하위 프로세스 30초 제한 초과였다. 코드·제한 변경 없이 해당 1개만 재실행하여 **통과**했다. 새 시간 제한·오류 코드·로그 비노출 테스트와 앞선 HWP 계획 범위 테스트도 포함된다. pytest cache 디렉터리 권한 경고는 남아 있다.
- `uv lock --check`, `uv pip check`, `uv build --offline --quiet` 및 AI Docker 빌드 통과. OpenAI는 테스트 대역이며 Qdrant 단위 테스트는 메모리 환경이다.
- 네트워크를 끈 새 Docker 이미지에서 실제 PDF 기본 읽기·문단 분석·kordoc 보조 읽기 스모크 통과. 기존 빌드 Core PDFBox 편집기가 만든 실제 페이지 메타데이터를 AI `inspect_document`에 전달하여 **31개 targets**, 보조 텍스트 일치와 원본 hash 보존을 확인했다(1회 8.09초).
- HWPX 공고 `PBLN_000000000118098`의 실제 저장 원본 SHA-256 `8d253d5c0f5af214caf28d20f108b106d7261c79334b77f167c3886b4b552c91`도 같은 읽기 경로에서 **641개 targets**, 보조 텍스트 일치와 원본 보존을 확인했다(1회 16.79초). 이 시간은 해당 환경의 읽기 측정이며 모델 성능 개선율이 아니다.
- Frontend 문서 생성 제한 120초도 순차 매핑·생성보다 짧아 660초로 조정했다. Node 24 / pnpm 11.22에서 `pnpm test --maxWorkers=1` **98개 파일·1,227개 테스트 통과**, `pnpm lint`, `pnpm build` 통과. 가상 시계로 540초에도 요청이 유지되고 상한에서 한 번만 종료되는 것을 확인했다. 기존 500 kB 번들 경고는 남아 있다.
- 실제 Nginx+가상 Core 검증: 문서 경로만 읽기 제한 600초로 설정했다. 최초 검증에서 중첩 location의 rewrite 단계 인증·upstream 설정이 기대대로 상속되지 않는 문제를 발견하여 해당 검사를 명시했다. 재검증은 인증 없는/위조 요청 403, 클라이언트 IP 없는 요청 400, 정상 본문·쿠키·정규화 헤더 전달과 기존 프록시 전체 검사를 통과했다. 장시간 실제 모델 호출이나 운영 Vercel/CloudFront 경유 검증은 아니다.
- 별도 Compose 프로젝트 `govbiz-document-fix-20260916-2`에서 최신 AI 이미지의 `verify-compose.sh` 전체 통과. Web→Core→AI 연결, 신청 준비 저장, Redis 복구, 제공처·검색·큐 장애 격리를 확인하고 검증 프로젝트를 정리했다. 외부 제공처/OpenAI는 스텁이다. 이후 추가한 브라우저 대기 제한은 위 Frontend 검사, Nginx 설정은 위 실제 프록시 검사로 별도 확인했으며 전체 Compose를 반복하지 않았다.
- 검증한 AI 이미지를 개발 `govbiz-ai-service-1`에 적용하고 실행 코드 hash와 PDF 엔진 버전을 확인했다. Core·DB 볼륨과 `.env`는 변경하지 않았다. Web `/`, `/api/v1/health`, `/api/v1/health/ai-service` 모두 HTTP 200이며 Vite가 제공하는 코드의 문서 제한 660초도 확인했다. 로컬 변경은 미커밋·미푸시 상태다.
- 검증 대상은 문서 분석·오류 처리·실제 도구 의존성이다. 유료 OpenAI 위치 선정·최종 파일 생성·시각 품질 평가, 운영 배포는 실행하지 않았다. 기존 개발 DB 답변과 원본은 변경하지 않았다.

## 이전 입력 위치 오류 후속 수정 기록

창원시 긴급 융자 지원 신청서에서 map HTTP 200 이후 generate HTTP 503을 확인했다. 저장된 공식 문항 20개의 bindings 중 상호는 편집 가능한 빈 문단에 연결되어 있었다. 기존 로그에는 작성 계획의 구체적인 거절 조건이 남지 않아 해당 실패가 어느 검사에서 발생했는지는 확정하지 못했다.

생성 단계에서 답변이 없는 문항의 bindings와 선택 양식 밖의 HWP 위치까지 모델에 제공하던 구조를 보완했다. HWP 계획 입력은 저장된 선택 범위의 targets로 제한하고, bindings는 현재 제공된 facts에 해당하는 것만 전달한다. 선택 범위 안의 미답변 예시는 삭제 판단에 필요하므로 targets에서 임의로 제외하지 않는다. 범위·binding·값 보존 검사는 그대로 유지한다. 정적 사유 코드만 남기는 거절 로그와 회귀 테스트를 추가하고 계획 정책 버전을 갱신했다.

당시에는 검증을 중지했으며, 이후 사용자가 해당 제한은 충돌 없는 main 반영에만 적용한다고 명확히 했다. 이 후속 수정의 AI 회귀 테스트와 빌드는 위 최신 검증에 포함된다. 아래 기록은 과거 실행 결과이며 최신 코드의 Core 전체 테스트를 다시 실행했다는 뜻이 아니다. Frontend는 추가 시간 제한 변경 때문에 위와 같이 전체 재검증했다.

HWP는 Windows COM에서 Core hwplib으로 변경했다. 아래 구분선 이후 실행 수치는 이전 커밋의 기록이며 새 변경의 통과 수치로 재사용하지 않는다.

## Docker 전용 변경 검증 기록

- AI: Python 3.12 / uv 0.12.5에서 전체 pytest **1,231개 통과**. HWP map/generate는 Core 구조 메타데이터를 사용하고 Windows 프로세스나 보조 MCP를 호출하지 않는 HTTP 계약을 검사했다. OpenAI는 테스트 대역이다.
- AI 패키지: `uv lock --check`, `uv pip check`, `uv build --offline --quiet` 통과. wheel에 새 HWP adapter가 포함되고 삭제한 Windows bridge/worker 모듈이 없는 것을 확인했다.
- Frontend: Node 24 / pnpm 11.22에서 전체 97개 파일·1,209개 테스트 실행. 처음에는 1,207개 통과, 기존 UI 테스트 2개가 5초 제한으로 실패했다. Core 검증 컨테이너를 중단해 부하를 줄인 뒤 해당 2개 파일의 43개 테스트를 기본 시간 제한으로 다시 실행하여 모두 통과했다. 코드 수정 없이 재검증했고 lint/build도 통과했다. 기존 500 kB bundle 경고는 남아 있다.
- 인프라: Windows 실행에서는 Compose CLI 환경·fcntl·셸 경로 차이로 실패했다. Linux Docker CLI/Python 환경의 `python3 -B -m unittest discover -s infrastructure/scripts -p 'test_*.py'`는 **57개 통과 / 16개 skip**. skip은 이번 변경과 무관한 기존 운영·신청 데모 시드 MySQL 테스트이며 `RUN_SEED_MYSQL_TESTS=1`을 지정하지 않아 실행하지 않았다. 운영 Compose 토큰 전달 테스트는 통과했다.
- Core: Linux/JDK 21에서 전체 `clean build`를 실행해 159개 suite 중 **1,445개 테스트 통과**, Elasticsearch suite는 검증 컨테이너에 상대 경로의 production Dockerfile이 없어 초기화에 실패했다. 저장소 디렉터리 구조를 보완한 뒤 `clean test --tests '*ElasticsearchSupportProgramClientIntegrationTest' build --no-daemon --max-workers=2 -Pkotlin.incremental=false`로 **9개 모두 통과**, clean build 성공을 확인했다. 최초 전체 실행과 누락 환경 보완 후 재실행을 구분하며, 전체 명령이 처음부터 성공했다고 보고하지 않는다. HWP 편집 5개·신청 문서 API 18개·신청 문서 Repository 13개는 최초 전체 실행에서 통과했다. 실제 MySQL 8.4·Redis 및 production Elasticsearch/Nori를 사용했다.
- 실제 HWP Docker 스모크: 최신 Core jar로 원본 HWP fixture의 위치 211개를 읽고, 최신 AI 이미지의 실제 `generate_document`에 사람이 지정한 팀원 수 한 칸의 테스트 계획을 공급했다. 네트워크를 끈 Docker 컨테이너에서 Python/JVM 계획 hash 일치 → Core `applyHwpPlan` → 값 `3명` 재열기 확인 → 원본 hash 보존을 확인했다. 편집기 내부의 다른 문단·체크값·셀 구조·임베디드 리소스 보존 검사도 통과했다. 실제 OpenAI의 위치 선정이나 전체 한글 페이지 렌더링 품질 검증은 아니다.
- 수동 검증 도구: 새 요청 타입에 맞춘 `PdfSmoke.java`와 HWP 스모크 도구의 JDK 21 컴파일 통과. 이번 변경에서 PDF 편집 자체를 새로 평가한 것은 아니다.
- Nginx: `verify-production-proxy.py`의 실제 Nginx/모의 Core 경계 검증 통과.
- Compose: 전용 프로젝트 `govbiz-hwp-docker-verify-20260916`에서 최신 이미지 빌드와 `verify-compose.sh` 전체 실행 통과. 신청 준비 질문·확정값 저장, Web → Core → AI 연결, 제공처 수집 실패 시 데이터 보존, Elasticsearch·Redis·RabbitMQ·Qdrant·AI 장애 격리 및 복구를 확인했다. 외부 제공처와 OpenAI는 로컬 stub이다. 검증용 컨테이너·네트워크·볼륨은 스크립트 종료 후 정리됐음을 확인했다.
- 로컬 적용: 기존 `govbiz`의 Core·AI·Web을 최신 이미지로 재생성하고 MySQL·Redis·RabbitMQ·Elasticsearch·Qdrant를 다시 기동했다. 기존 DB 볼륨과 `.env`는 유지했다. Web `/`, `/api/v1/health`, `/api/v1/health/ai-service`가 모두 HTTP 200을 반환했다. 실제 AI 컨테이너에서 `kr.dogfoot/hwplib@1.1.11+govbiz-ranges-v1`과 Windows bridge 모듈 부재, Core/AI 공통 토큰 일치를 비밀값 출력 없이 확인했다. 실행 중인 Core jar와 Compose 검증 이미지의 jar SHA-256도 일치했다.
- 최종 `git diff --check` 및 삭제한 Windows 파일·스크립트의 활성 참조 검사 통과. 이 변경은 로컬 `main`의 미커밋 상태이며 신규 push·PR·운영 배포는 하지 않았다.

검증을 병렬 실행했을 때 PC 여유 메모리가 약 460 MiB까지 줄어 첫 Core 실행은 컴파일 중 중단했다. 사용자 디스크 압축을 위해 다음 실행도 중지했다. 재개 후 Docker 클라이언트 연결이 끊겼지만 컨테이너의 테스트는 계속 실행되어, 복구 후 실제 종료 코드와 XML 결과를 확인했다. 자원 확보를 위해 기존 개발 스택을 잠시 정지한 뒤 위 로컬 적용 단계에서 복구했다. 개발 DB 볼륨은 삭제하지 않았다. 유료 모델 평가는 실행하지 않았다.

---

# 신청 문서 MCP 검증 기록

검증 결과는 아래 최종 실행 기록에 업데이트한다. 자동 테스트와 MCP 통신 성공을 실제 문서의 위치·레이아웃 품질 완료로 해석하지 않는다.

## 검증 명령

- AI Service: `uv run --locked --extra dev python -m pytest`
- 의존성: `uv lock --check`, `uv pip check --python .venv/Scripts/python.exe`, `uv build`
- Core (JDK 21): `./gradlew clean build --no-daemon` — MySQL 8.4 Testcontainers 포함
- Frontend (Node 24/pnpm 11.22): `pnpm test`, `pnpm lint`, `pnpm build`
- Compose: `docker compose -f infrastructure/compose.yaml config --quiet`, `infrastructure/scripts/verify-compose.sh`
- 최종 변경: `git diff --check`

실제 MCP, OpenAI 호출 없는 스모크(AI Service 디렉터리):

```text
python document-tools/smoke.py --format hwpx --fixture ../core-service/src/test/resources/combinationreview/general.hwpx
python document-tools/smoke.py --format hwpx --fixture <공식 HWPX> --target <사람이 확인한 native target> --output <새 결과 경로>
python document-tools/smoke.py --format pdf --fixture ../core-service/src/test/resources/combinationreview/deeptech.pdf
```

스모크는 job 복사본만 수정한다. 예시값은 가상기업이며 출력 경로 덮어쓰기를 거절한다. HWPX 텍스트/XML 검사와 한글 렌더링은 별도이다. HWP 파일을 HWPX에서 이름만 바꿔 만들지 않는다.

## 수동 실파일·재편집 절차

1. 각 공식 원본의 hash와 선택 양식 범위를 기록한다. 가상 회사 답변만 사용한다.
2. 사람이 입력할 셀/문단/누름틀/PDF 영역과 지워도 되는 예시 구간을 확인한다. 제목·고지·서명·표·이미지 보존 여부를 비교한다.
3. HWP/HWPX 결과를 실제 한글로 열어 짧은 셀·다문단·병합 셀·체크 항목 및 예시 제거를 확인한다. 미지원 항목은 실패로 남긴다.
4. PDF를 다운로드한 후 Reader/브라우저에서 한국어 값을 변경하고 새 파일로 저장한다. 재열어 변경값과 AcroForm 편집 가능 상태, 글자 잘림·겹침·테두리를 확인한다.
5. 같은 답변 revision 재생성은 같은 fingerprint 결과를 반환하고, 엔진 변경 시 새 결과가 생기며 이전 파일도 소유자에게 다운로드되는지 확인한다.
6. 마지막으로 승인된 API 예산 안에서 OpenAI 질문/계획부터 결과까지 실제 웹 흐름을 확인한다. 현재 구현 작업에 별도 유료 호출 예산은 지정되지 않았으므로 임의 과금 평가를 하지 않는다.

## 이전 Windows 엔진 검증 당시의 잔여 범위

- HWP 일반 표·병합 셀·체크 컨트롤의 신뢰할 수 있는 COM 위치 조회/편집 확장과 실제 한글 설치 환경 검증.
- HWPX 누름틀/체크 컨트롤 지원, 복잡한 다중 변경·특수 컨트롤, HTML/PNG 및 독립 한글 렌더링 검증. 단순한 하나의 구간 변경은 기존 run 서식을 유지하며, 모호한 반복 텍스트 변경은 거절한다.
- PDF 중복 예시의 위치 지정 삭제 범위 확장 및 실제 사용자 PDF 앱의 한국어 재편집 확인.
- 이 범위가 남아 있으므로 세 형식 전체 요구사항 완료/배포 완료로 보고하지 않는다.

## 최종 실행 기록

2026-09-16 로컬 검증 결과. 실제 커밋·push·PR·배포는 하지 않았다.

| 구분 | 실제 실행 | 결과 |
|---|---|---|
| AI 단위·계약 전체 | Python 3.12.10 / uv 0.12.5, `uv run --locked --extra dev python -m pytest --basetemp=<작업별 임시 경로> -o cache_dir=<작업 캐시>` | **1,229 passed**. 실제 OpenAI 호출 없음 |
| Frontend 전체 | Node 24.18.0 / pnpm 11.22.0, `pnpm test --maxWorkers=2`, `pnpm lint`, `pnpm build` | **96 files / 1,189 tests passed**, lint/build 통과. 500 kB 초과 bundle 경고 있음 |
| Core 최신 컴파일 | JDK 21.0.12.1, `gradlew clean bootJar compileTestKotlin --no-daemon --max-workers=2 -Pkotlin.incremental=false` | production·테스트 clean 컴파일 및 bootJar 통과 |
| Core 변경 관련 단위·HTTP 계약 | `gradlew test --no-daemon --max-workers=2 --tests '*ApplicationDocumentEditorTest' --tests '*ApplicationDocumentMcpClientTest' --tests '*ApplicationFormManifestTest'` | **18 tests passed** (편집 11, HTTP client 2, manifest 5) |
| Core 전체 / 실제 MySQL 8.4 | Windows JDK 21 `gradlew clean build --no-daemon --max-workers=2 -Pkotlin.incremental=false`, 실패 영향 범위 Linux 재검증 | 전체 **1,447개 실행: 최초 1,440 통과 / 7 실패**. 계약 fixture 2건 보완 및 Windows POSIX 권한 미지원 5건을 포함한 4개 클래스 **79개를 Linux에서 재실행하여 모두 통과**, clean 빌드 성공. 아래 재검증 기록 참고 |
| Docker / Compose | 최신 코드로 `infrastructure/scripts/verify-compose.sh`, 실제 Nginx 검증 | **최신 이미지 빌드·Compose 전체 스모크·Nginx 경계 검증 통과**. 외부 API는 로컬 stub 사용. 최신 AI 이미지의 실제 HWPX 편집 및 PDF 읽기 MCP 스모크 통과 |
| 환경·패키지 | `uv lock --check`, `uv pip check`, `uv build` | 실행 시점 통과. 이후 추가 모듈의 최종 패키지 확인은 아래 보완 기록 참고 |
| 브라우저 PDF UI | 연결 브라우저 도구 실행, reset 후 재시도 | `failed to write kernel assets ... os error 3`로 열기 전에 실패. 실제 Reader/브라우저 조작 검증으로 보고하지 않음 |

Windows JDK의 AF_UNIX loopback 오류는 검증 JVM에만 `-Djdk.net.unixdomain.tmpdir=<존재하지 않는 작업별 임시 하위 경로>`를 설정하여 JDK의 TCP 대체 경로로 실행했다. OS 보안 설정은 바꾸지 않았다. Linux/Windows 산출물 혼용을 피하려고 clean 컴파일했다. 테스트 환경의 Spring context cache는 2로 제한하도록 설정했다.

### 실제 HWPX MCP / 원본 신청서

- 원본: [서초구 2026년 융자 신청서 및 사업계획서](https://bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000118098)의 공식 첨부.
- 다운로드: `https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_000000000742548&fileSn=1`
- 원본 SHA-256: `8d253d5c0f5af214caf28d20f108b106d7261c79334b77f167c3886b4b552c91`.
- 사람이 주변 `③ 기업체명`을 대조한 native `t1.r2.c2`에 `가상기업`을 넣었다. 해당 원본 셀은 열 4칸·행 2칸 병합 셀이다.
- 실제 SDK initialize → tools/list → inspect → preview/apply → 값 검증 및 XML 검사 통과. production `HwpxDocumentAdapter.apply` 경로를 사용했다.
- 원본 bytes 유지 확인. **한글 프로그램에서의 렌더링 및 전체 신청서 자동 작성 품질은 확인하지 않았다.**

### 실제 PDF MCP → Core PDFBox → 재편집

- 원본: [부산 항공부품산업 기술고도화 지원사업 신청서](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000122391)의 공식 PDF 첨부(11페이지).
- 다운로드: `https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_000000000756959&fileSn=1`
- 원본 SHA-256: `4c90df4a5282dd62ae550bb1676766a550089dce7509192008feee988b24bde3`.
- `PdfSmoke inspect`가 실제 Core PDFBox로 원본을 읽어 source/fact/pageImages 요청을 만들었다.
- 실제 MCP에서 1페이지 업종 칸의 `예시 : (31321)항공기용 엔진 제조업 ` 구간 하나를 삭제했다. 새 버전 검증은 삭제된 native 문자 위치가 선택한 문자열 위치와 일치하고, 남는 텍스트 객체·페이지 좌표·글꼴 및 이미지 스트림 내용이 보존되는지 확인한다.
- 위치 보정 생략 경고는 7개 텍스트 객체 전체 삭제임을 검증한 뒤 사유를 기록했다. 다른 degradation/overflow/glyph 누락은 여전히 실패 처리한다.
- Core PDFBox로 기업명 칸에 AcroForm 텍스트 필드 하나를 추가하여 `가상기업`을 넣었다. 중복 정적 텍스트·flatten은 사용하지 않았다.
- PDFBox에서 `수정한 가상기업`으로 바꿔 저장·재열기 성공. 독립 pypdf에서도 필드 수 1개와 정확한 `/V`를 확인했다.
- 독립 Poppler 렌더 이미지에서 기업명 위치, 예시 제거, 빨간 `표준산업분류표 참고` 문구와 표·제목·제출 조건·서명란 보존을 확인했다. 겹침/잘림은 이 테스트의 입력 영역에서 발견하지 않았다.
- PDFBox 시스템 글꼴 검색 중 format 14 cmap 무시 경고가 있었다. 이 검증은 위 한국어 값에 한정하며 모든 글꼴/문자 조합을 보장하지 않는다.
- **회사의 모든 항목을 AI가 자동 배치한 결과가 아니다.** 사람이 지정한 입력 영역 1개·예시 1개에 대한 실행·보존 스모크다. 나머지 예시/미입력 항목은 이 수동 계획에 포함하지 않았다.

### HWP 및 아직 실행하지 못한 검증

- HWPFrame.HwpObject가 등록되어 있지 않아 Windows COM 실제 MCP/한글 저장·재열기·화면 검증 미실행.
- HWP 일반 표/체크 컨트롤, HWPX 누름틀/체크 컨트롤의 미지원 범위는 남아 있다. 다른 형식으로 내보내 성공 처리하지 않는다.
- 최종 Repository/Mapper JSON 지도 저장과 fingerprint 제약은 **실제 MySQL 8.4 통합 검증 통과**. H2로 대체하지 않았다. 기존 스냅샷의 지도 누락을 재현하여 실제 `JSON_SET` 경로와 기존 문항 보존도 확인했다.
- 실제 OpenAI 질문·지도 선정·작성 계획의 end-to-end 품질 평가는 호출 예산이 지정되지 않아 미실행. mock 계약 테스트를 AI 품질 검증으로 표시하지 않는다.
- 실제 사용자 PDF 앱의 입력 변경 UI는 브라우저 도구 장애로 미검증이며, PDFBox/pypdf 재편집 검사와 구분한다.



### 최종 보완 기록

- Windows 동시 요청 테스트를 추가했다. 실행 중인 동일 브리지의 작업은 RUN_CONFLICT로 구분하고, 프로세스 재시작·실패 뒤 남은 잠금은 OUTCOME_UNKNOWN으로 유지한다. 관련 계약 테스트 32개 통과 후 AI 전체를 다시 실행하여 1,229개 통과했다.
- 최종 사용 중 오류 안내를 포함하여 Frontend 전체 1,189개·lint·build 재검증 통과.
- 해당 Core HTTP client 변경은 관련 2개 테스트를 다시 실행해 통과했다. 앞서 통과한 편집 11개·manifest 5개와 구분한다.
- `uv lock --check`, 설치 의존성 확인 통과. 온라인 `uv build`는 일시적 DNS 오류가 났고, 확보된 캐시를 사용하는 `uv build --offline --quiet`는 통과했다. 생성 wheel에 신규 pipeline·HWPX/PDF 확장·Windows bridge 모듈 포함 확인.
- 고정 kordoc checkout을 package-lock으로 설치·빌드하고 실제 MCP initialize/tools/list/parse_document를 실행했다. 실제 서초구 신청서 읽기 전용 복사본에서 주 편집기와 정확히 일치하는 텍스트 1,577자를 확인했으며 상태는 READ_ONLY_EXACT_TEXT_MATCHED였다.
- 최종 PDF 삭제 검증은 단순히 텍스트 객체가 비었는지만 보지 않고, 원문에서 선택한 native 문자 위치와 실제 삭제된 문자 위치가 정확히 일치하는지도 확인한다. 문서 저장 시 갱신될 수 있는 XMP 메타데이터 및 파일 저장용 object/xref 스트림은 시각 리소스 비교와 구분한다.
- 첫 검증 시 Docker의 default/desktop-linux 두 연결이 시간 초과되어 MySQL/Redis/Compose가 남았다. 이후 재시도 결과는 다음 절과 같다.
- `git diff --check` 통과. 미커밋·미푸시·PR 미생성·미배포 상태이다.

### Docker 복구 후 재검증 (2026-09-16)

- Docker 29.7.2 Linux 엔진 응답을 확인한 뒤 전체 Core clean 빌드를 실행했다. 158개 suite / 1,447개 테스트가 실행됐고 1,440개 통과, 7개 실패, skip 0이었다. 기본 설정에서 제외하는 `live-source` 태그의 실제 제공처 호출은 실행하지 않았다.
- 문서 관련 실패 2건은 새 `/document/configuration`·`/document/map` HTTP fixture 누락과 가짜 PDF 바이트가 원인이었다. 계약 테스트에 인증 헤더·원본 hash·사용자 답변 미포함 검사 및 기존 스냅샷의 지도 복원 검사를 추가하고, PDF fixture를 PDFBox로 생성한 실제 PDF로 바꿨다. 운영 코드는 이 재검증에서 변경하지 않았다.
- 나머지 5건은 기존 일회성 색인 서비스가 사용하는 `posix:permissions` 초기 속성을 Windows 파일시스템이 지원하지 않아 실패했다. 권한 처리를 약화하거나 테스트를 skip하지 않고 Linux/JDK 21에서 확인했다.
- Linux 컨테이너의 별도 `/workspace`에 소스를 복사하고 실제 MySQL 8.4·Redis Testcontainers를 사용했다. 다음 4개 클래스의 **79개 모두 통과**, `clean` 컴파일·테스트·패키징 성공:

  ```text
  ./gradlew clean test \
    --tests '*ApplicationFormDiscoveryContractIntegrationTest' \
    --tests '*ApplicationPreparationApiIntegrationTest' \
    --tests '*SupportProgramRepositoryIntegrationTest' \
    --tests '*SupportProgramCatalogSyncOnceServiceTest' \
    build --no-daemon --max-workers=2 -Pkotlin.incremental=false
  ```

  각각 4 / 16 / 50 / 9개다. 최초 전체 실행과 실패·수정 영향 범위 재실행을 합쳐 확인한 결과이며, Windows 전체 명령이 한 번에 성공했다고 보고하지 않는다.
- `docker compose ... config --quiet` 통과. 사용하지 않던 전용 프로젝트 `govbiz-document-mcp-verify-20260916`에서 최신 이미지와 `verify-compose.sh` 전체 실행 통과. Web → Core → AI 상태 확인, 신청 준비 질문·확정값 저장, 네 제공처 모의 데이터 동기화, MySQL 조회, Elasticsearch·Qdrant·Redis·RabbitMQ·AI 장애 격리와 복구, Core 재시작 및 소유자별 결과 복원을 확인했다. 실제 제공처·OpenAI 품질 검증은 아니다.
- `python infrastructure/scripts/verify-production-proxy.py` 통과. 실제 Nginx와 로컬 모의 Core로 우회 차단, IP 정규화, HTTP 메서드·body 전달, 2 MB 제한, 다중 쿠키·캐시·리다이렉트를 검증했다.
- 최신 AI 이미지에서 `/opt/document-tools/smoke.py` 실행: 공식 서초구 HWPX의 `t1.r2.c2`에 기업명 입력 후 initialize/tools-list/preview/apply/verify 통과, 공식 부산 PDF는 11페이지의 텍스트·배치 읽기 통과. 이 재실행에서 PDF 편집이나 한글 화면 렌더링을 추가로 확인한 것은 아니다.
- 검증용 Compose 컨테이너·볼륨은 완료 후 정리했다. 기존 개발 스택·운영 데이터에는 적용하지 않았으며 유료 API 호출, 커밋, push, PR, 배포는 하지 않았다.
