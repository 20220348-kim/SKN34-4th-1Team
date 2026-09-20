# 신청 문서 편집 설치와 실행

## Docker 전용 실행

HWP는 Core API 컨테이너의 `kr.dogfoot:hwplib:1.1.11`로 읽고 수정한다. Windows, 한컴 한글 COM, 별도 브리지 프로세스는 필요하지 않다. HWPX/PDF는 AI 이미지에 설치된 MCP 도구를 사용한다. OpenAI는 입력 위치·작성 계획에 계속 사용하며 규칙 기반 답변 fallback은 없다.

| 형식 | 실행 위치 | 편집 도구 |
|---|---|---|
| HWP | Core JVM | hwplib 1.1.11 |
| HWPX | AI의 격리 Python 환경 | Hangeul-mcp 0.6.0 + 구간 편집 확장 |
| PDF | AI MCP → Core JVM | FFDetr 입력칸 탐지 + pdf-edit-mcp 0.2.0 / engine 0.2.0 → PDFBox |
| HWPX/PDF 읽기 보조 | AI Node 프로세스 | 고정 kordoc checkout |

MCP 도구의 정확한 commit·의존성은 `backend/ai-service/document-tools/versions.json` 및 남은 형식별 `.lock`에 기록한다. AI는 MCP SDK 2.1.0, 편집 도구는 격리된 SDK 1.27.2 환경을 사용한다. AI 이미지는 Python 3.12를 사용한다.

FFDetr는 별도 API 키 없이 CPU에서 실행한다. 기존 OpenAI·내부 인증 토큰은 계속 필요하다. Docker 빌드 시 Hugging Face의 `jbarrow/FFDetr` revision `56f4e4235e28dcb2953513dc020bb191a2f54cfe`의 가중치(134,960,879바이트)를 다운로드하고 SHA-256 `f852e1bac18c8f435b82270fc8ff8e2ca4a2cd8869c411fa8f473f16e69585ef`를 확인한다. 실행 중에는 다운로드하지 않는다. `pdf.lock`은 Python 3.12/Linux x86_64 CPU 런타임을 기준으로 생성한다. FFDetr/PyTorch 의존성은 PDF 도구 가상환경에만 설치한다.

저장소 운영 Compose의 AI `mem_limit`은 1g이며 개발 Compose에는 해당 제한이 없다. FFDetr 단독 CPU 평가의 최대 RSS 약 758MiB는 AI 컨테이너 전체·동시 업무의 필요 메모리가 아니다. 운영 메모리 제한과 worker 수는 실제 배포 환경에서 확인해야 한다. 이번 구현은 운영 메모리 제한을 임의로 늘리지 않는다.

kordoc의 PDF 읽기에 필요한 `pdfjs-dist@4.10.38`은 `document-tools/kordoc-pdf/package-lock.json`으로 별도 고정한다. upstream 잠금 파일에서는 개발 의존성으로 표시되어 production prune 시 제거되므로 Docker 빌드가 별도로 설치하고 import를 확인한다. PDF 스모크는 기본 PDF 도구와 kordoc 보조 읽기를 모두 실행한다.

문서 위치 매핑과 작성 계획은 `APPLICATION_FORM_DISCOVERY_MODEL_TIMEOUT_SECONDS`(기본 210초), `APPLICATION_FORM_DISCOVERY_RUN_TIMEOUT_SECONDS`(기본 240초)를 공유한다. 일반 질문의 25초/30초 제한은 바뀌지 않는다. 문서 HTTP 요청 전체 제한은 240초이며 Core의 기본 읽기 제한은 270초다. 모델·실행·HTTP 제한 초과는 구분하여 기록하고, 매핑 요청의 제한 초과는 `PLAN_TIMEOUT`으로 반환한다. 도구 오류 로그는 엔진·도구명·고정 사유 코드만 남기며 문서 본문과 답변은 기록하지 않는다.

Core의 첫 문서 생성은 위치 매핑과 생성을 순서대로 호출하므로 브라우저의 문서 생성 POST 제한은 660초, Nginx의 해당 `/api/v1/application-preparations/{id}/documents` 경로 읽기 제한은 600초다. 일반 요청 제한과 프록시 인증·헤더 처리는 유지한다. 이 값은 최대 대기 한도이며 실제 처리 시간 보장이 아니다. 운영 Vercel/CloudFront의 외부 중계 시간 제한은 별도 배포 환경에서 확인해야 한다.

이미 실행 중인 요청을 조회로 복구할 때도 660초 동안 기다리며 유료 생성 POST를 자동으로 반복하지 않는다. HWPX 본문 주소는 공백 문단을 포함한 실제 문단 순서를 사용한다. inspect·preview·apply·verify가 같은 순서를 사용하므로 빈 문단을 채워도 뒤쪽 문단 주소가 이동하지 않는다. 지원하지 않는 제어 구조는 입력 대상에서 제외한다.

매핑 응답의 입력 대상과 scope ID는 원본의 편집 가능한 말단 위치만 허용하는 동적 `pattern` 제약을 사용한다([OpenAI Structured Outputs의 지원 제약](https://developers.openai.com/api/docs/guides/structured-outputs)). 부모 셀과 자식 문단의 중복 입력, 반복 문맥·보조 원문은 모델 입력에서 줄이고 원본 전체 map은 검증용으로 유지한다. PDF 겹침 검사는 좌표의 십진 표현을 비교하여 맞닿은 경계를 부동소수 오차 때문에 겹침으로 거절하지 않도록 한다. 실제로 겹친 영역은 계속 거절한다.

## 로컬 Docker

PDF는 기존 입력 필드 또는 FFDetr 탐지 결과를 원문 글자·표 선과 대조한 입력 영역(`PDF_INPUT`)을 선택한다. 모델은 좌표를 만들지 않으며 서버가 선택된 영역의 좌표를 Core PDFBox에 전달한다. 입력 영역을 확인할 수 없는 선택 문항은 원문 직접 작성으로 표시하고, 필수 문항 또는 답변이 있는 문항을 조용히 누락하지 않는다. 매핑의 라벨·영역 검증 실패는 근거를 전달해 최대 한 번 수정 요청하며, 계속 실패하면 오류를 반환한다. 매핑 HTTP 전체 제한 240초와 최대 2회 모델 호출은 유지한다. `govbiz_pdf_text_regions`는 기존 pdfminer 의존성으로 CropBox·회전 적용 좌표를 제공한다. 원문은 읽기 전용으로 보존하며 작성 계획은 제공된 답변 ID만 사용한다. Core가 제공한 HWP 표·필드 문맥은 축약하지 않는다.

1. 루트 `.env`에 `DOCUMENT_INTERNAL_TOKEN`을 설정한다. 무작위 32자 이상 비밀값을 Core와 AI가 함께 사용한다. 생성 예: `python -c "import secrets; print(secrets.token_hex(32))"`.
2. `docker compose --env-file .env -f infrastructure/compose.yaml up -d --build core-service ai-service web`으로 새 코드를 적용한다. 기존 DB 볼륨은 삭제하지 않는다.
3. 저장된 신청 준비를 열어 원본 양식을 분석하거나 문서 생성을 다시 실행한다. 새 HWP 엔진의 pipeline fingerprint가 과거 Windows 엔진 지도·결과의 재사용을 막는다. 기존 답변과 파일 다운로드 이력은 유지한다.

이전 HWPX 분석이 표 전체를 하나의 질문으로 추출했다면 기존 작성본에서 **기존 답변을 보관하고 새 양식 확인**으로 이동해 **입력칸별 양식 다시 분석**을 누른다. 재분석 결과는 새 활성 양식으로 게시되고 이전 작성본·답변은 보존된다. 새 양식으로 작성본을 만들고 실제 입력칸별 질문에 답한다. 기존 포괄 답변을 여러 칸에 임의 분배하지 않는다.

`DOCUMENT_HWP_BRIDGE_URL`, `DOCUMENT_HWP_BRIDGE_TOKEN` 및 Windows 실행 명령은 더 이상 사용하지 않는다. 기존 `.env`에 남아 있어도 코드와 Compose에서 읽지 않는다. 고객 PC에 편집기를 설치할 필요가 없다.

## 운영 Compose

`infrastructure/.env.production.example`의 `DOCUMENT_INTERNAL_TOKEN`을 운영 secret으로 설정하고 Core·AI의 새 이미지로 배포한다. `compose.prod.yaml`은 동일 토큰을 두 서비스에 전달한다. `.env` 변경은 기존 컨테이너에 자동 반영되지 않으므로 컨테이너 재생성이 필요하다. 이 안내는 배포가 실제 수행되었다는 뜻이 아니다.

- 운영에서는 개발용 Compose와 합치지 않고 `infrastructure/compose.prod.yaml`을 사용한다.
- 토큰은 EC2의 `/opt/govbiz/.env.production`(권한 600)에 설정하며 Git 또는 Vercel 환경변수에는 넣지 않는다.
- 환경 파일 변경이나 `docker compose restart`만으로는 반영되지 않는다. 운영 Compose의 전달 설정도 확인한 뒤 AI Service, Core API 순으로 컨테이너를 재생성하고 건강 상태를 확인한다. 호스트의 고정 IP 등 기존 설정은 덮어쓰지 않는다.
- 자동 배포는 이미지 참조만 갱신하므로 기존 운영 호스트에는 Compose 전달 설정을 별도로 반영해야 한다.
- 토큰 등록은 내부 인증 설정이며 문서 도구가 포함된 새 이미지 배포를 대신하지 않는다. HWP Windows 브리지는 필요하지 않다.

## 지원 범위와 오류

- HWP: 구조 주소가 확인된 일반 문단·표 셀의 문자열 구간 편집, 실제 체크박스/라디오 선택, 예시 구간 삭제를 처리한다. 저장 후 전체 방문 문단·체크값·셀 주소/너비·임베디드 데이터 보존을 다시 확인한다.
- 암호/배포용 HWP, 누름틀 등 지원하지 않는 제어 문자가 포함된 문단, 범위 주석, 보조 평면 문자 등 검증하지 못한 편집은 명시적으로 거절한다. 기존 제목·고지·서명 문구를 모델이 임의로 덮어쓰도록 허용하지 않는다.
- hwplib의 줄 배치·셀 높이 처리는 한글의 전체 페이지 렌더러가 아니다. 실제 양식의 페이지 넘김·복잡한 도형·겹침 품질은 별도 확인이 필요하다. 설치 의존성 제거가 모든 HWP의 지원·시각 품질을 보장하지 않는다.
- `MCP_NOT_READY`: 공통 토큰 또는 HWPX/PDF 도구 구성을 확인한다. HWP Windows 설치 안내는 더 이상 표시하지 않는다.
- `MAPPING_FAILED` / `UNSUPPORTED`: 양식 범위·문항 위치·지원 구조를 확인한다. 실패를 임의 위치 기입이나 다른 형식 변환으로 숨기지 않는다.
- `OUTCOME_UNKNOWN`: 기존 Redis 실행 잠금의 소유 작업이 종료됐는지 확인한 뒤 처리한다. 기존 잠금을 자동으로 삭제하지 않는다.
- 유료 OpenAI 품질 평가는 별도의 전송 데이터·호출 예산 안에서 실행한다.

## 검증 진입점

- Core: `ApplicationHwpPlanTest`(실제 HWP 수정·재열기), `ApplicationPreparationApiIntegrationTest`(생성·저장·소유자 다운로드).
- AI: `tests/test_document_mcp_contract.py`의 Core HWP 위치 계약·HTTP map/generate 테스트. OpenAI는 테스트 대역을 사용한다.
- HWPX/PDF: `document-tools/smoke.py`. 이 스크립트는 HWP를 별도 MCP 서버로 실행하지 않는다.

## LICENSE / NOTICE

hwplib과 고정 Hangeul-mcp, pdf-edit-mcp, kordoc의 LICENSE 및 전이 의존성 고지를 배포 시 유지한다. kordoc의 NOTICE·THIRD_PARTY와 저장소 NanumGothic 라이선스도 유지한다. 고객 원본·상용 글꼴·비밀값은 저장소에 추가하지 않는다.
