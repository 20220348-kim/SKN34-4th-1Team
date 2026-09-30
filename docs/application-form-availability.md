# 신청 양식 분석과 공고별 가용성

## 호출 흐름

- 제공처 전체 수집·검증 성공 → SupportProgramCatalogPublicationService의 공개 snapshot transaction → 공고별 `application_form_availability` PENDING 등록. 같은 제공처 transaction이 rollback되면 분석 작업도 남지 않는다.
- ApplicationFormAnalysisWorker → ApplicationFormAnalysisService → ApplicationFormDiscoveryService → 제공처 AttachmentClient → 공식 첨부 다운로드 → SupportProgramDocumentParser → AiApplicationPreparationFacade → AI Service discovery → OpenAI.
- 외부 I/O가 모두 끝나면 분석 Service가 소유하는 짧은 transaction에서 application_form_snapshot 저장과 AVAILABLE 활성화를 함께 commit한다.
- 작성 화면에서 공고를 선택하면 바로 GET `/api/v1/application-preparations/forms/availability?sourceCode=...&sourceProgramId=...`와 GET `forms/discovery-jobs`를 읽는다(AI 호출 없음). AVAILABLE이면 저장된 양식을 즉시 표시하고, 진행 중인 job이 있으면 폴링을 이어받는다. PENDING 또는 STALE이면 **입력칸별로 분석** 클릭에서만 기존 계정별 Discovery Job을 요청·폴링하여 공식 첨부 수집·분석 결과를 저장한 뒤 표시한다. 다른 실패 상태는 자동 재분석하지 않고 상태·실패 원인을 표시한다. 공고 선택만으로 유료 분석을 시작하지 않는다.
- 새 작성 POST는 같은 transaction에서 활성 공고 행을 잠그고 formVersionId를 확인한다. 기존 작성은 원래 formVersionId를 계속 사용한다.
- 최종 문서 생성은 공식 첨부를 재다운로드해 attachmentSha256을 대조한다. 불일치·소실이면 생성하지 않고 STALE로 등록한다. 이미 만들어진 파일 조회·다운로드는 기존 작성 버전을 유지한다.

## 저장과 실행권

V36은 공고 복합 식별자 `(source_code, source_program_id)`를 PK로 사용한다. 상태 행이 시스템 Outbox를 겸한다. 기존 계정별 RabbitMQ discovery job의 계정 한도·요청 키와 분리된다.

`sourceFingerprint + parserVersion + extractionModel + extractionPromptVersion`으로 완료된 성공·NO_FORM·확정 실패 결과를 재사용한다. 공고 metadata 변경은 STALE이지만 공식 첨부 지문과 버전이 같으면 완료 결과를 복원하고 AI를 호출하지 않는다. 첨부 또는 버전 변경은 STALE 후 재분석하며 과거 snapshot은 보존한다.

`activeFormVersionId`는 FK로 snapshot에 연결된다. 공고에 여러 양식이 있으면 같은 공고·지문·파서·모델·프롬프트 조합의 snapshot 전체가 활성 집합이며 대표 포인터가 그 집합 안에 있어야 한다. AVAILABLE 공고 수와 snapshot 수는 다를 수 있다.

Worker는 `FOR UPDATE SKIP LOCKED`로 한 공고를 선점한다. generation과 UUID lease token이 바뀌면 이전 실행은 활성화할 수 없다. OpenAI 직전 `ai_started`를 기록하고, 호출 시작 이후 실행권이 유실되면 UNKNOWN_AFTER_START / REVIEW_REQUIRED로 남겨 중복 유료 호출을 막는다. Worker는 기본 비활성화이며 대상 환경에서 `APPLICATION_FORM_ANALYSIS_ENABLED=true`로 켠다.

## 상태와 재시도

| 상태 | 의미 | 다음 작업 |
| --- | --- | --- |
| PENDING | 신규 또는 미분석 공고 | 즉시 분석 |
| AVAILABLE | 검증된 활성 snapshot 존재 | 24시간 후 첨부 재확인 |
| NO_FORM | 분석 성공, 양식 없음 | 24시간 후 지문 확인; 동일하면 AI 미호출 |
| DOCUMENT_UNAVAILABLE | NOT_FOUND / UNSUPPORTED / INVALID 등 확정 수집·파싱 실패 | 24시간 후 첨부 재확인 |
| TOO_LARGE | 파서·전체 입력 크기 초과, 또는 HWPX native 입력 대상이 3,000개를 넘어 AI Service가 `APPLICATION_DOCUMENT_LIMIT_EXCEEDED`(413)로 확정한 첨부만 남은 경우 | 24시간 후 첨부 재확인 |
| RETRY_WAITING | 일시적 503·timeout, 양식은 찾았으나 입력칸 매핑만 실패(`APPLICATION_DOCUMENT_PLAN_FAILED`·`MAPPING_FAILED`·`PLAN_TIMEOUT`) | 총 3회 시도; 첫 실패 5분, 두 번째 30분 후. 사용자 재분석 요청은 회차를 1부터 다시 센다 |
| STALE | 공고·첨부·분석 버전 변경 또는 원본 해시 불일치 | 재분석 대기 |
| REVIEW_REQUIRED | 계약 위반·결과 불명·3회 재시도 소진 | 운영자 확인. 24시간 후 지문만 확인하며 동일 입력에 AI 재호출 없음 |

사용자가 요청한 재분석(discovery job)도 같은 표로 기록한다. 양식 없음·크기 초과·수집 불가 같은 문서 확정 사유는 NO_FORM·TOO_LARGE·DOCUMENT_UNAVAILABLE로, 일시 장애·시한 초과·입력칸 매핑 실패는 RETRY_WAITING으로 두며, 계약 위반과 결과 불명만 REVIEW_REQUIRED다. 사유 코드는 `APPLICATION_FORM_` 접두를 유지하고 결과는 캐시하지 않는다.

nextRetryAt은 다음 분석 또는 지문 재확인 시각이다. REVIEW_REQUIRED도 새 공식 첨부나 분석 버전으로 바뀌었는지 확인하되, 같은 입력의 유료 분석을 다시 시도하지 않는다.

attemptCount는 현재 분석·재시도 회차의 시도 수이다. 완료 결과를 재확인하는 새 회차나 입력 변경 시 1부터 시작하며, 일시 실패의 연속 재시도는 최대 3회로 제한한다. 평상시 지문 재확인 횟수가 쌓여 첫 일시 실패를 재시도 소진으로 오판하지 않는다. 상태와 별도로 reasonCode, verifiedAt, nextRetryAt, durationMs, timeoutStage를 저장한다. 시간은 서울 기준 DB DATETIME이다.

## Discovery 전용 timeout

| 설정 | 초기 운영 기본값 |
| --- | --- |
| APPLICATION_FORM_DISCOVERY_MODEL_TIMEOUT_SECONDS | 210초 |
| APPLICATION_FORM_DISCOVERY_RUN_TIMEOUT_SECONDS | 240초 |
| APPLICATION_FORM_DISCOVERY_READ_TIMEOUT | 270초 |
| APPLICATION_FORM_WORKER_LEASE | 1,800초 |

AI Service는 model < run을 검증하고 discovery configuration에 두 값을 알린다. Core는 실제 configuration을 읽어 run < 전용 read timeout을 검증한다. Core 기동 설정은 read < Worker lease를 검증한다. 입력 해석·초안 작성·최종 문서 배치는 기존 전역 timeout을 유지한다.

2026-09-15 재검사는 model 180초 / run 210초 / 하네스 HTTP 190초 / 동시 실행 2개로 수행되어 기존 timeout 157건 중 43건이 FORM_FOUND, 114건이 timeout으로 남았다. 하네스 HTTP 시간이 run보다 짧았으므로 운영값으로 그대로 사용하지 않는다. 성공 요청별 durationMs가 보존되지 않아 최대 성공 시간은 알 수 없다. model 기본값은 재검사 180초에 30초 여유를 둔 초기값이며 성능 개선 실측값이 아니다. 운영 durationMs와 AI_MODEL / AI_RUN / CORE_READ timeoutStage를 근거로 재조정한다.
