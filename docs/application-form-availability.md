# 신청 양식 사전분석과 공고별 가용성

## 호출 흐름

- 제공처 전체 수집·검증 성공 → SupportProgramCatalogPublicationService의 공개 snapshot transaction → 공고별 `application_form_availability` PENDING 등록. 같은 제공처 transaction이 rollback되면 분석 작업도 남지 않는다.
- ApplicationFormAnalysisWorker → ApplicationFormAnalysisService → ApplicationFormDiscoveryService → 제공처 AttachmentClient → 공식 첨부 다운로드 → SupportProgramDocumentParser → AiApplicationPreparationFacade → AI Service discovery → OpenAI.
- 외부 I/O가 모두 끝나면 분석·백필 Service가 소유하는 짧은 transaction에서 application_form_snapshot 저장과 AVAILABLE 활성화를 함께 commit한다.
- 작성 화면에서 공고 선택 → **저장된 신청 양식 확인** 버튼 클릭 → GET `/api/v1/application-preparations/forms/availability?sourceCode=...&sourceProgramId=...` → DB 상태와 활성 snapshot 직접 조회. 공고 선택만으로 조회하지 않으며 계정별 Discovery Job POST·폴링을 실행하지 않는다. AVAILABLE이면 첫 양식을 선택해 신청 문서 확인 단계로 이동하고, 그 외 상태는 빈 양식 목록과 함께 상태·실패 원인을 표시한다.
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
| TOO_LARGE | 파서 또는 전체 입력 크기 초과 | 24시간 후 첨부 재확인 |
| RETRY_WAITING | 일시적 503·timeout 등 | 총 3회 시도; 첫 실패 5분, 두 번째 30분 후 |
| STALE | 공고·첨부·분석 버전 변경 또는 원본 해시 불일치 | 재분석 대기 |
| REVIEW_REQUIRED | 계약 위반·결과 불명·3회 재시도 소진 | 운영자 확인. 24시간 후 지문만 확인하며 동일 입력에 AI 재호출 없음 |

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

## 읽기 전용 입력 dry-run과 일회성 백필

배포용 입력 JSON은 `infrastructure/seed/application-form-openai-analysis-20260915-v2.json`에 보관한다.
서버에서 실행하는 절차는 [신청양식 백필 안내](../infrastructure/seed/application-forms.md)를 따른다.
`infrastructure/scripts/seed-application-forms.py`가 기존 Kotlin 검증·적재 기능을 호출하며,
입력은 컨테이너에 읽기 전용으로 마운트한다. resources, jar, Docker 이미지에 포함하지 않는다.

Core 디렉터리에서 JDK 21로 실행한다.

```powershell
./gradlew applicationFormBackfillDryRun --no-daemon '-PinputFile=<JSON 절대 경로>' '-PinputSha256=<승인된 SHA-256>'
```

v2 재검사 성공 558건(양식 발견 408건, 양식 없음 150건)은 최종 aiAnalysis에 model·prompt·contract를 반복하지 않는다. importer는 originalAiAnalysis와 originalReport의 동일 모델·프롬프트 기록을 검증한 뒤 메모리에서만 이 메타데이터를 상속한다. 근거가 없거나 상충하면 거부하며 파일을 수정하지 않는다.

이 명령은 Spring·DB·외부 API를 시작하지 않는다. SHA-256, schemaVersion, 1,459개 복합 ID 유일성, 최종 aiAnalysis 상태, FORM_FOUND 676건, 공고별 후보 양식 수를 검증한다. dry-run에서 후보 양식 수는 AVAILABLE 또는 저장된 snapshot 수가 아니다.

실제 반영은 별도 요청한 DB에서만 수행한다. 먼저 전체 검증을 완료하고 Worker·제공처 동기화 스케줄러를 끈 단발성 Core 실행에 다음 속성을 명시한다.

- `app.application-form-backfill.apply=true`
- `app.application-form-backfill.input=<외부 JSON 절대 경로>`
- `app.application-form-backfill.sha256=<SHA-256>`
- `app.application-form-backfill.expected-jdbc-url=<정확한 대상 JDBC URL>`

접속한 JDBC URL이 지정값과 다르면 반영을 중단한다. 비밀번호는 환경변수로 제공한다. importer는 OpenAI를 호출하지 않는다. FORM_FOUND는 공식 첨부를 다시 수집·파싱하고 입력의 URL·SHA-256·순서를 확인한 뒤 기존 AI 계약 검증(근거 block·quote·필드·options)과 Domain 검증을 통과해야 한다. 지문이 다르면 STALE, 계약이 깨지면 REVIEW_REQUIRED로 저장한다. 입력에 전체 원문·locator가 없으므로 JSON 후보만으로 AVAILABLE을 만들지 않는다.

NO_FORM, NOT_ELIGIBLE, FAILED, UNKNOWN_AFTER_START는 최종 aiAnalysis를 사용하며 원문 failureCodes를 보존한다. 같은 파일 해시로 이미 반영한 공고와 더 최신 검증 결과·실행 중인 공고는 건너뛴다. 중간 실패 후 재실행도 완료된 snapshot을 중복 생성하지 않는다. 각 공고 단위 commit이므로 전체 파일 적용이 실패하면 완료 건수와 미완료 범위를 확인하고 같은 입력으로 재실행한다.

반영 후 importer 출력의 상태별 공고 수, AVAILABLE 공고 수, 활성 snapshot 수를 비교한다. FORM_FOUND 676과 AVAILABLE이 다른 경우 STALE·검증 실패·기존 최신 결과 보존 건을 따로 확인한다. 실제 대상 DB 반영 전에는 이 숫자를 운영 가용 공고 수라고 보고하지 않는다.
