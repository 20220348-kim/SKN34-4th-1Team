# 공고 기반 신청 문서 작성 도우미 설계

[문서 목록](README.md) · [시스템 구조](architecture/README.md) · [계정·인증 계약](account-auth-contract.md)

- 관련 이슈: [#185 — skn-89 제약·계약](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-3rd-1Team/issues/185) · [#187 — skn-90 신청 준비 기본 흐름](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-3rd-1Team/issues/187) · [#189 — skn-92 문항별 질문과 사실 확인](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-3rd-1Team/issues/189) · [#199 — skn-96 공고 기반 양식 발견](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-3rd-1Team/issues/199) · [#207 — skn-100 작성 도우미 공고 검색](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-3rd-1Team/issues/207) · [#210 — skn-102 오류·삭제·선택 흐름](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-3rd-1Team/issues/210) · [#212 — skn-103 단계 분리·제공처 확장](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-3rd-1Team/issues/212) · [#230 — skn-112 전 제공처 공식 첨부](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-3rd-1Team/issues/230) · [#246 — skn-121 관심 공고 선택](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-3rd-1Team/issues/246)
- 상태: **작성 도우미 안에서 버튼으로 연 관심 공고 팝업 또는 전체 제공처 검색으로 공고를 선택하고, 기업마당·K-Startup·과기정통부·충남 수출지원 공식 PDF/HWP/HWPX의 신청 문서와 문항을 동적으로 발견해 기존 질문·사실 확인 흐름에 연결한다. 관심 공고는 팝업을 열 때 지연 조회하며 중복 지원 검토와 같은 선택 UI를 공유한다. 공고 선택과 발견 문서 확인은 두 단계로 분리한다. 답변 입력과 결과 페이지를 분리하고 공식 원본 양식에 기입한 HWP/HWPX/PDF 파일을 제공한다.**
- 설계 기준: 2026-09-11, 팀 `main` 커밋 `6fc41bc`에서 `skn-96` 전환.
- 기능 이름: 화면에서는 **신청 문서 작성 도우미**, 코드에서는 `applicationpreparation` / `application_preparation` / `application-preparation`을 사용한다.

## 1. 해결할 문제와 기능 정의

지원사업 공고를 찾은 사용자가 공식 신청 양식의 문항을 이해하고 빈 문서에서 초안을 시작하기 어렵다는 문제를 해결한다.
사용자가 특정 공고에서 `신청 문서 작성 시작`을 명시적으로 선택하면, 공식 첨부에서 찾은 신청 문서와 문항을 먼저 확인시키고
AI가 필요한 사실을 질문한다. 사용자가 확인한 답변을 원본 양식의 기입 위치에 넣어 편집 가능한 문서를 만들며, 미정 정보는
미정으로 남긴다.

이 기능은 기존 기능과 결과물이 다르다.

| 기능 | 사용자에게 남는 결과 |
|---|---|
| 지원사업 검색 | 지원을 검토할 공고 목록 |
| 공고 근거 질문 | 특정 공고 조건에 대한 근거 답변 |
| 중복 지원 검토 | 선택한 사업 조합의 단계별 제한·미확인 결과 |
| 신청 문서 작성 도우미 | 공식 문항에 대응하는 사용자 확인 가능 초안 |

다운로드한 파일을 사용자가 직접 확인·수정한다. 파일 생성은 기관 제출이나 기관 검수 완료를 의미하지 않는다.

## 2. 최초 검수 기준과 동적 지원 범위

기업마당의 **2026년 2차 중소기업 혁신바우처 사업 지원계획 공고** 한 건은 자동 추출 결과를 비교할 최초 검수 기준이다.
사용자 기능은 이 한 건에 제한하지 않고, 네 제공처의 검증된 공고 식별자와 공식 상세가 직접 연결한
PDF/HWP/HWPX를 명시적 요청에서 분석한다.

| 항목 | 고정 값 |
|---|---|
| 제공처·공고 ID | `BIZINFO` / `PBLN_000000000118979` |
| 공식 공고 | [기업마당 공고](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000118979) |
| 공고명 | 2026년 2차 중소기업 혁신바우처 사업 지원계획 공고 |
| 공식 첨부 | `(제2026-133호)_2026년_중소기업_혁신바우처_사업_2차_지원계획_공고.hwpx` |
| 파일 식별 | 136,375 bytes, SHA-256 `3ce95215a893ec1d058932ff4890cdcd7157c0c1940d1f4e86822acb45a0df01` |
| 문서 내부 양식 | `Contents/section0.xml`의 `【서식 1】사업 계획서`, 문단 688~729 |
| 지원 유형 | 일반형의 컨설팅·기술지원·마케팅 중 사용자가 실제 신청하는 분야 |

공식 첨부의 확인된 문항은 다음과 같다.

| 문항 키 | 공식 위치 | 첫 버전에서 다룰 내용 |
|---|---|---|
| `company-overview` | 문단 692~707 `기업 개요` | 업체·담당자 기본정보, 주요 연혁, 생산품, 판매처 |
| `voucher-plan` | 문단 709~724 `바우처 활용 계획` | 신청 분야, 과제명, 과제 내용, 일정, 목표 |
| `voucher-necessity` | 문단 726~729 `바우처 지원 필요성` | 기업활동과 활용계획의 관련성, 도입 필요성 |

공식 첨부는 사업 신청서를 플랫폼에서 온라인 작성하고, 별첨 사업계획서는 신청서 작성 시 업로드하도록 구분한다.
이 기준 manifest는 기존 준비 건 복원과 회귀 검증에 유지한다. 동적으로 발견한 양식도 원문 URL, 파일 hash, 파서·모델·
프롬프트 버전을 스냅샷으로 고정하며 같은 URL의 파일 내용이 달라지면 기존 버전을 덮어쓰지 않는다.

## 3. 포함 범위와 한계

- 네 공식 제공처에서 발견한 양식에 대해 특정 공고별 템플릿을 하드코딩하지 않고 문단·셀·페이지를 분석한다.
- HWP → HWP, HWPX → HWPX, PDF → PDF로 제공한다. 원본 파일 단위이며 여러 신청서가 한 첨부에 있으면 분리하지 않는다.
- 현재 준비 건은 사용자가 선택한 첨부 하나를 소유한다. 다른 첨부는 별도의 준비 건에서 작성한다.
- AI는 답변을 다시 쓰지 않고 기입 위치만 선택한다. 확인 값은 그대로 쓰고 UNKNOWN은 미정으로 기입한다.
- HWP는 hwplib 1.1.11의 문단·표 셀, HWPX는 ZIP/XML의 leaf 문단, PDF는 페이지 이미지에서 찾은 영역에 편집 가능한 AcroForm 필드를 사용한다.
- 모든 양식의 배치 정확성·원본과 동일한 페이지 수를 보장하지 않는다. 미매핑 답변·잘못된 위치 ID·PDF 영역 겹침·용량 초과는 명시적인 오류다.
- 원본/출력 32 MiB, ZIP 256개 entry/32 MiB 확장, 대상 3,000개/문맥 합 400,000자, 사실 200개, PDF 50페이지/이미지 base64 합 32 MiB를 제한한다.
- 암호화·배포용 HWP, 서명·암호화·XFA PDF, 지원되지 않는 객체의 기입은 거절한다. 현재 최초 문항 발견은 스캔 PDF/OCR를 지원하지 않는다.
- 정부 사이트 자동 제출·증명서 발급·임의 파일 업로드·DOCX/XLSX는 포함하지 않는다.
## 4. 사용자 흐름과 화면 경계

1. 로그인 사용자가 작성 도우미 안에서 공고명·기관명으로 전체 제공처 공고를 검색하고 공고를 선택하거나 공고 상세에서 진입한다.
   선택 공고는 검색 결과 위에 표시하고 같은 카드의 `신청 문서 찾기` 버튼으로 다음 행동을 이어간다.
2. 검색에서 찾지 못한 경우에만 기업마당 공식 URL·공고 ID를 직접 입력한다.
3. 사용자가 분석 버튼을 누르면 공식 PDF/HWP/HWPX를 수집하고 신청 문서·문항 후보를 추출한다.
4. 분석이 끝나면 별도 `신청 문서 확인` 단계로 전환한다. 사용자가 원문 위치와 발견 양식을 확인하고 생성 버튼을 누른다.
5. 공식 문항 목록과 문항별 작성 상태를 본다.
6. 선택 문항에서 AI 질문에 답하고 제안 사실·미정 정보를 확인하거나 정정한다.
7. 모든 필수 답변을 저장하고 이전·다음 항목 아래의 초안 생성하기를 누른다. 결과 페이지에서 원본 형식의 작성 파일을 다운로드한다.
8. 다운로드한 파일에서 직접 수정하거나 이전으로 돌아가 답변을 수정·저장한 뒤 다시 생성한다.

### skn-140 문서 생성 계약

입력 페이지는 `/app/application-preparations/:preparationId`, 결과 페이지는 그 아래 `/documents`이다.
생성 버튼은 저장하지 않은 답변 또는 필수 입력 누락이 있으면 비활성화한다. `?generate=입력revision`으로
결과 페이지에 진입하면 기존 파일을 조회한 뒤 없을 때만 생성한다. 일반 결과 조회는 AI를 호출하지 않는다.

- `GET /api/v1/application-preparations/{id}/documents`: 현재 revision 파일 메타데이터 목록.
- `POST /api/v1/application-preparations/{id}/documents`, body `{"expectedRevision":3}`: 원본 기입 및 결과 저장.
- `GET /api/v1/application-preparations/{id}/documents/{fileId}/download`: 소유자 확인 후 attachment binary, no-store.

원본은 기존 제공처 Client로 다시 수집하고 양식 스냅샷의 SHA-256과 대조한다. 원본이 바뀌었으면 다른 파일을
대신 제공하지 않는다. 입력과 모든 위치의 대응을 검증하고 실제 파일을 만든 다음 짧은 transaction에서
입력 revision을 잠금으로 재확인해 V32 `application_document_file`에 저장한다. 동시 입력 변경은 409다.
같은 revision은 저장된 파일을 재사용한다. 같은 프로세스의 동시 생성은 거절하며 다중 인스턴스의 중복 유료 호출까지
차단하는 분산 실행 예약은 구현하지 않았다. 사용자 로컬 수정은 서버 답변에 역으로 반영되지 않는다.

기존 V31 텍스트 작성본 계약은 호환성을 위해 남겨 두었지만 새 UI는 호출하지 않는다.
아래 6~8절 중 `contents`·문항별 draft/content/confirmation 관련 내용은 이 기존 계약의 명세이다.
## 5. 계층과 의존 방향

```text
Frontend
View → ViewModel → UseCase → Domain Repository
                              ↓
                    Data Repository → HTTP API

Core API
Controller → Service → Repository → MyBatis Mapper → Mapper XML → MySQL
                ↓
             AI Client → AI Service

AI Service
Router → Service → 구체 Agent → OpenAI
```

- Frontend View와 ViewModel은 `fetch`나 Repository 구현을 직접 생성하지 않는다.
- Core Controller는 Service만 호출하고, 소유권·입력 버전·실행 흐름은 Service가 담당한다.
- Domain에는 Spring, MyBatis, HTTP DTO와 OpenAI 계약을 넣지 않는다.
- Repository는 Domain과 `DbRow`를 변환하며 Mapper를 밖으로 노출하지 않는다.
- AI Service는 MySQL과 사용자 세션에 직접 접근하지 않는다.
- 외부 AI 호출은 DB transaction 밖에서 실행하고 검증된 결과 저장만 짧은 transaction으로 처리한다.
- 단일 production 구현을 위한 Repository interface, 범용 port·provider·registry·factory를 추가하지 않는다.
- 전달만 하는 Facade, Agent graph, handoff, 다른 LLM provider와 규칙 기반 정상 fallback을 추가하지 않는다.

제안 파일 경계:

```text
frontend/web/src/presentation/features/application-preparation/
frontend/web/src/domain/entities/ApplicationPreparation.ts
frontend/web/src/domain/repositories/ApplicationPreparationRepository.ts
frontend/web/src/domain/usecases/ApplicationPreparationUseCase.ts
frontend/web/src/data/api/applicationPreparationApi.ts
frontend/web/src/data/models/ApplicationPreparationDto.ts
frontend/web/src/data/repositories/ApplicationPreparationRepositoryImpl.ts

backend/core-service/src/main/kotlin/ai/govbiz/core/applicationpreparation/
  controller/  service/  domain/  repository/  repository/mapper/  client/ai/
backend/core-service/src/main/resources/mybatis/applicationpreparation/repository/
backend/core-service/src/main/resources/application-preparation/

backend/ai-service/app/application_preparation/
  router.py  service.py  agent.py  models.py  prompt.py  discovery_prompt.py
```

공식 첨부 수집·파싱은 신청 문서 발견과 중복 지원 검토가 실제로 함께 사용하므로 `supportprogram/client` 경계에서 공유한다.
추출 양식은 범용 registry 대신 `application_form_snapshot`이 파일·파서·모델·프롬프트 버전을 직접 소유한다.

## 6. 데이터와 상태 계약

### 신청 준비 건과 AI 실행은 다르다

- **신청 준비 건(Preparation)**: 사용자가 계속 편집하는 현재 작업. 소유자·공고·양식 버전·현재 revision을 가진다.
- **AI 실행(Run)**: 특정 문항, 확인 사실, 공식 근거와 입력 revision으로 수행한 질문 해석 또는 초안 생성 한 번.

`application_form_snapshot`은 사용자 작업과 분리된 공개 공식 자료의 추출 버전이다. 공고의 전체 첨부 URL·파일명·hash로
source fingerprint를 만들고, 파일 hash·파서·모델·추출 프롬프트가 같을 때만 재사용한다. 어느 값이든 바뀌면 새
`formVersionId`를 만들며 기존 준비 건이 참조하는 버전을 덮어쓰지 않는다.

```text
신청 준비 건 P1
  입력 v1 → 초안 실행 R1 → 작성본 d1 → 사용자 확인 d1
  입력 v2 → 기존 d1 재확인 필요 → 초안 실행 R2 → 작성본 d2
```

입력이 바뀌어도 이전 실행과 작성본을 삭제하거나 새 입력의 결과처럼 덮어쓰지 않는다. AI 실행 중 입력이 변경되면
늦게 도착한 결과를 현재 작성본에 자동 적용하지 않는다.

### 한 가지 완료 상태로 합치지 않는다

| 상태 축 | 값·의미 |
|---|---|
| 작성본 | 없음 / AI 초안 / 사용자 수정본 |
| 사용자 확인 | 미확인 / 특정 작성본 버전 확인 |
| 필수 정보 | 충족 / 추가 입력 필요 / 사용자가 미정으로 확인 |
| 현재성 | 현재 입력 기준 / 입력 변경으로 재확인 필요 |
| AI 실행 | RUNNING / SUCCEEDED / FAILED / INTERRUPTED |

사용자 사실은 `사용자 원문`, `구조화한 필드와 값`, `PROVIDED/UNKNOWN`, `확인 상태`, `입력 revision`을 구분한다.
AI가 답변에서 추출한 값은 제안이며 사용자 확인 전에는 초안 생성의 확정 사실로 사용하지 않는다. 값이 `UNKNOWN`이면
같은 질문을 반복하지 않고 문안에 미정으로 표시하거나 초안 생성 전에 필요한 이유를 설명한다.

## 7. 공개 API 계약

모든 주소는 `/api/v1` 뒤에 붙는다. 소유자는 요청에서 받지 않고 인증 세션의 Account로 결정한다.

| 메서드·경로 | 역할 |
|---|---|
| GET `/application-preparations/forms` | 기존 검수 기준 양식 조회. 이전 작업 호환용이며 새 작성 진입에서는 자동 호출하지 않음 |
| POST `/application-preparations/forms/discovery-jobs` | UUID 요청 키와 선택한 공고를 202로 접수. Worker가 공식 PDF/HWP/HWPX 문항을 추출하고 버전 스냅샷 저장·재사용 |
| GET `/application-preparations/forms/discovery-jobs` 및 `/{id}` | 본인 최근 분석 작업의 공고명·공식 원문 URL·상태 요약과 선택한 작업의 결과 복원. [V26 비동기 계약·구형 API 제한](rabbitmq-application-form-discovery.md) |
| POST `/application-preparations` | 공고·지원 분야·양식 버전으로 신청 준비 건 생성 |
| GET `/application-preparations` | 본인 신청 준비 목록 |
| GET `/application-preparations/{id}` | 본인 현재 입력·문항·작성 상태 조회 |
| DELETE `/application-preparations/{id}` | 본인 신청 준비 삭제. 하위 확인 사실·AI 실행 기록은 cascade 삭제하고 공용 양식 스냅샷은 유지 |
| POST `/application-preparations/{id}/sections/{sectionKey}/messages` | 사용자 답변 해석, 사실 제안·미정·다음 질문 반환 |
| PUT `/application-preparations/{id}/sections/{sectionKey}/inputs` | 사용자가 확인한 문항 입력 전체 스냅샷 저장 |
| POST `/application-preparations/{id}/sections/{sectionKey}/drafts` | 현재 확인 입력으로 명시적인 초안 실행 |
| PUT `/application-preparations/{id}/sections/{sectionKey}/content` | 사용자가 직접 수정한 전체 문안 저장 |
| POST `/application-preparations/{id}/sections/{sectionKey}/confirmations` | 특정 작성본 버전의 사용자 확인 |

답변 해석과 초안 생성을 분리한다. 답변 전송이 기존 문안을 덮어쓰거나, AI가 추출한 사실을 자동 확정하지 않는다.
쓰기 요청은 현재 상태의 `expectedRevision`을 받고, AI 실행 요청은 소문자 UUID `requestKey`를 추가로 받는다.
같은 신청 준비 건·요청 키·payload는 기존 실행을 반환하고, 같은 키의 다른 payload는 409로 거절한다.

양식 발견 응답의 `title`, `description`, `label`, `guidance`는 AI Service와 Core가 같은 규칙으로
공백·탭·줄바꿈을 단일 공백으로 정규화하고, 그 밖의 Unicode control/format 문자는 거부한다.
`evidenceQuote`는 표시 문자열과 달리 공식 원문에 존재하는 연속 부분 문자열을 그대로 보존하며 길이는 Unicode code point로 계산한다.
계약 위반 로그에는 응답 본문 대신 실패 경로·검증 사유·문자 길이·문서/블록/항목 개수만 남긴다.

문항 답변 해석은 현재 확인 사실을 자동 변경하지 않는다.

```json
{
  "expectedRevision": 2,
  "requestKey": "0a504895-77bd-4d34-bc61-3e6d12389042",
  "message": "업체명은 새봄테크이고 담당자는 아직 미정입니다."
}
```

응답의 `evidenceQuote`는 이번 `message`의 정확한 부분 문자열이다. `PROVIDED` 값은 확인 전 제안이며,
`UNKNOWN`은 사용자가 모름·미정이라고 명시한 경우에만 제안한다.

```json
{
  "runId": 31,
  "inputRevision": 2,
  "sectionKey": "company-overview",
  "suggestions": [
    {"fieldKey": "company-name", "status": "PROVIDED", "value": "새봄테크", "evidenceQuote": "업체명은 새봄테크"},
    {"fieldKey": "contact-person", "status": "UNKNOWN", "value": null, "evidenceQuote": "담당자는 아직 미정"}
  ],
  "missingFields": ["company-history", "main-products", "main-customers"],
  "nextQuestion": "주요 연혁을 확인된 연도와 함께 알려주세요."
}
```

사용자가 제안을 선택·수정한 뒤 `PUT .../inputs`에 해당 문항의 전체 사실 스냅샷을 보낸다. 성공하면 준비 건의
`inputRevision`이 정확히 1 증가한다. 빈 목록은 해당 문항의 현재 확인 사실을 모두 지우는 명시적 저장이다.

초안 생성 요청의 핵심 형태:

```json
{
  "expectedRevision": 3,
  "requestKey": "0a504895-77bd-4d34-bc61-3e6d12389042",
  "expectedVersionId": null
}
```

초안 생성·수정·확인은 현재 준비 건 상세를 반환하며 `contents`의 항목은 다음을 구분한다.

```json
{
  "id": 7,
  "inputRevision": 3,
  "sectionKey": "voucher-plan",
  "kind": "AI_DRAFT",
  "content": "사용자가 확인한 사실로 작성한 초안",
  "stale": false,
  "createdAt": "2026-09-13T10:00:00+09:00",
  "confirmedAt": null
}
```

공개 오류는 기존 `application/problem+json`과 `code`를 사용한다.

| HTTP | 계약 |
|---|---|
| 400 | 필드 형식·길이·revision·요청 키 검증 실패 |
| 401 | 로그인 세션 없음·만료 |
| 403 | 계정 접근 제한. 다른 사용자의 작업 여부는 공개하지 않음 |
| 404 | 없는 자원, 소유하지 않은 신청 준비 건, 미지원 문항 |
| 409 | revision 충돌, 같은 요청 키의 다른 payload, 진행 중 중복 실행 |
| 429 | 계정별 요청량 제한 |
| 503 | AI Service 또는 실행 용량 사용 불가 |
| 504 | AI 실행 시간 초과 |

필수 답변 미입력은 초안 요청 전에 화면에서 안내하며 API는 400으로 거절한다. 명시적으로 확인한 미정은 허용하고
문안에 `항목명: 미정`으로 표시한다. OpenAI 장애를 빈 초안이나 규칙 기반 성공 응답으로 숨기지 않는다.

## 8. AI 내부 계약과 생성 제약

Qdrant 양식 검색은 추가하지 않는다. 양식 발견에서는 Core가 공식 첨부에서 안전하게 추출한 위치 포함 블록만 전달하고,
입력 해석에서는 선택 문항의 작성 안내·현재 사용자 확인 사실과 이번 답변만 AI Service에 전달한다.

```text
GET  /internal/v1/application-preparations/configuration
POST /internal/v1/application-preparations/interpret
GET  /internal/v1/application-preparations/discovery/configuration
POST /internal/v1/application-preparations/discovery
GET  /internal/v1/application-preparations/draft/configuration
POST /internal/v1/application-preparations/draft
```

AI Service는 양식 발견·입력 해석·초안 작성의 역할별 typed Agent를 각각 `max_turns=1`로 실행한다. configuration은 LLM을 호출하지 않고
계약·모델·프롬프트 버전을 반환한다. Agent는 도구·handoff·fallback 없이 각 출력 계약을 검증한다.

Core는 AI 응답에서 다음을 검증한다.

- 초안 응답의 준비 건·문항·입력 revision·양식 버전·모델·프롬프트 버전이 요청과 일치한다.
- `usedFieldKeys`는 요청에 전달한 PROVIDED 필드 집합과 정확히 일치한다.
- UNKNOWN은 해당 필드의 `항목명: 미정` 표시를 포함한다.
- 초안 길이와 제어 문자를 검증한다. 개별 문장의 사실 정확성은 이 검증만으로 보장하지 않는다.
- 미정 값은 생성하지 않고 문안에 미정으로 표시한다.
- AI 문안을 사용자 확인 상태로 반환하지 않는다.
- 출력 길이·문자열·목록 수와 enum을 제한하고 알 수 없는 필드는 거절한다.

모델 요청은 저장을 끄고 민감한 trace를 남기지 않는다. 사용자 답변 전체를 모든 문항에 반복 전송하지 않고 현재 문항에
필요한 확인 사실만 전달한다. 모델·프롬프트·계약 버전과 입력 snapshot은 실행 이력에 남긴다.

## 9. 안전·소유권·운영 제약

- 로그인 계정만 사용하며 모든 조회·수정·실행을 owner Account로 제한한다.
- 사용자 ID·기업 설명·답변·문안을 URL, 공개 로그, 오류 응답에 넣지 않는다.
- 페이지 진입과 세션 복원만으로 DB 생성 또는 OpenAI 호출을 하지 않는다.
- 401 이후 쓰기·AI 요청을 로그인만으로 자동 재전송하지 않고 기존 반영 여부를 먼저 조회한다.
- 요청 취소만으로 OpenAI 실행 중단을 보장하지 않으며 늦은 결과는 입력 revision으로 격리한다.
- 공식 첨부 다운로드·파싱·AI 호출을 하나의 DB transaction 안에서 수행하지 않는다.
- 사용자가 직접 입력한 URL은 Frontend에서 기업마당 상세 URL의 공고 ID로만 정규화하며 Core는 임의 URL을 다운로드하지 않는다.
- Core는 카탈로그에서 제공처별 공식 상세를 다시 조회하고, 제공처·공고 ID·허용 호스트가 모두 일치하는 페이지가 직접 연결한 PDF/HWP/HWPX만 받는다. 충남은 API 제목·본문과 공식 게시판 상세가 하나로 일치할 때만 채택한다.
- 공식 파일 hash가 기존 값과 다르면 새 스냅샷으로 분석하고 사용자가 다시 선택하게 하며 기존 manifest를 덮어쓰지 않는다.
- 기관이 검수하지 않은 AI 초안을 공식 작성 지침이나 선정 가능성 판단으로 표시하지 않는다.

## 10. 기능별 이슈·브랜치·PR 경계

하나의 사용자 기능 단위마다 GitHub 이슈에서 `skn-번호`를 먼저 배정하고, 같은 번호의 브랜치 하나와 PR 하나를 사용한다.
PR이 병합된 브랜치는 후속 기능에 다시 사용하지 않는다. 다음 작업은 새 이슈와 새 `skn-번호`가 정해진 뒤 최신 팀
`main`에서 해당 번호 브랜치를 만들어 시작한다. 다음 번호를 임의로 배정하지 않는다.

```text
GitHub 이슈에서 skn-번호 확정
  → 최신 upstream/main에서 skn-번호 브랜치 생성
  → 해당 사용자 기능에 필요한 계층을 함께 구현
  → 기능 범위 전체 검증
  → 같은 번호의 PR 생성·병합
  → 브랜치 종료
  → 다음 기능의 새 이슈·번호 확인
```

`Domain`, `DB`, `AI Service`, `Core API`, `Frontend`는 PR을 나누는 기준이 아니라 한 기능 안의 구현 순서다. 기능에 필요한
계층을 모두 연결해야 사용자가 사용할 수 있는 수직 범위가 된다. 한 기능의 production 코드·관련 설정·테스트 코드를
모두 작성한 뒤 검증을 마지막 한 단계로 모아 실행한다.

현재와 후속 작업 단위 제안:

| 작업 단위 | 이슈·브랜치 | PR 결과물 | 필수 검증 |
|---|---|---|---|
| 제약·계약 확정 | `skn-89` / #185 | 이 문서, 공식 대상·범위·공개/AI 계약 | 링크·원문 위치·`git diff --check` |
| 신청 준비 기본 흐름 | `skn-90` / #187 | 검수 양식, 신청 준비 생성·목록·상세의 Domain·DB·Core API·Frontend | Core·MySQL 8.4·Frontend |
| 문항별 질문과 사실 확인 | `skn-92` / #189 | AI 답변 해석, 사실 제안·확인, 문항 입력 저장과 화면 | AI Service·Core 계약·Frontend |
| 공고 기반 양식 발견 전환 | `skn-96` / #199 | 기업마당 공식 첨부 수집·문항 추출·버전 스냅샷과 공고 상세·새 작성 연결 | AI Service·Core·MySQL 8.4·Frontend |
| 작성 도우미 공고 검색 | `skn-100` / #207 | 새 작성 안에서 기업마당 공고 검색·선택, URL·ID 입력은 보조 경로 | Frontend·`git diff --check` |
| 발견 오류·삭제·선택 흐름 보강 | `skn-102` / #210 | 원문 인용 공백 정규화, AI/출처 오류 구분, 신청 준비 삭제, 선택 공고 상단 행동 | AI Service·Core·MySQL 8.4·Frontend |
| 원본 문서 생성·다운로드 | `skn-140` / #285 | 입력/결과 페이지 분리, 원본 형식 기입·다운로드, 입력 수정 후 재생성 | AI Service·Core·MySQL 8.4·Frontend·Stub 계약 및 파일 재열기 |
| 전체 흐름 안정화 | 새 번호 배정 필요 | 로그인 복귀·세션 격리·장애·Compose 통합과 운영 문서 | 변경 서비스 전체·Compose·`git diff --check` |

후속 작업 단위와 범위는 새 이슈를 만들 때 다시 확인한다. Stub·자동 테스트 통과를 실제 신청 문서 품질이나 기관 검수
완료로 표현하지 않는다. 실제 OpenAI 품질 평가는 전송 자료와 호출 예산을 별도로 승인받은 뒤 실행한다.

## 11. 1장 완료 기준

- 첫 공고·첨부 파일·지원 문항과 파일 hash가 공식 자료와 일치한다.
- 작성 도우미와 제출서류 점검·자동 제출·내보내기의 경계가 구분된다.
- Frontend·Core API·AI Service의 책임과 의존 방향이 현재 프로젝트 구조와 일치한다.
- 답변 해석·확정 입력·초안 생성·직접 수정·사용자 확인이 서로 다른 행위로 정의된다.
- 소유권·revision·중복 요청·늦은 응답·미정 정보·AI 장애 처리 제약이 명시된다.
- 후속 사용자 기능마다 새 이슈·번호·브랜치·PR을 사용하도록 경계가 정해진다.

## 신청 문서 MCP 파이프라인

생성 경로는 Core의 공식 첨부·소유권·revision 관리와 AI Service의 형식별 MCP 실행을 연결한다. HWP는 내부 Windows 브리지, HWPX는 Hangeul 파일 모드, PDF는 MCP 정리 후 PDFBox AcroForm 처리이다. 기존 직접 HWP/HWPX 편집 코드는 생성 경로에서 호출하지 않는다. 새 fingerprint로 과거 생성 결과와 구분하고 다운로드 이력을 보존한다. 구현 범위와 미지원 구조·검증 상태는 [MCP 구조](application-document-mcp-architecture.md), [설치](application-document-mcp-setup.md), [검증 기록](application-document-mcp-validation.md)를 확인한다.
