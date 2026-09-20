# 중복 지원·중복 수혜 검토 설계
[문서 목록](README.md) · [시스템 구조](architecture/README.md) · [계정·인증 계약](account-auth-contract.md)

> **2026-09-12 비동기 전환:** 현재 실행 계약은 [RabbitMQ 중복 검토 분석](rabbitmq-combination-review.md)을 따른다.
> 아래 최초 설계·검증 시점의 동기 POST/201·120초 대기·프로세스당 2개·RUNNING 복구 설명은 과거 기록이다.
> 현재는 202 QUEUED 접수, DB Outbox, 검토 큐 소비자 1개, 계정별 미완료 최대 3개, 상태 자동 조회를 사용한다.
> UNKNOWN은 자동 재실행 및 같은 검토의 새 실행을 막으며 운영 확인이 필요하다. 최초 모델 품질·사람 검수 기록은 그대로 보존한다.

> 2026-09-09 최신 팀 main 통합 시 main의 V6~V9를 보존하고 중복 검토 migration을 V6→V10, V7→V11로 이동했다. SQL 내용은 유지했다. 아래 과거 검증 기록의 V6/V7은 당시 브랜치 버전이다. 이전 브랜치의 V6/V7을 적용한 개발 DB는 새 버전과 이력이 다르므로 그대로 업그레이드하지 말고 별도 DB를 사용해야 한다. 이번 통합에서는 기존 DB를 변경하지 않았다.

- 관련 이슈: [#123 — skn-59](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-3rd-1Team/issues/123) · [#230 — skn-112 전 제공처 공식 첨부](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-3rd-1Team/issues/230) · [#246 — skn-121 관심 공고 선택](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-3rd-1Team/issues/246)
- 상태: **입력 API와 공식 근거 초안에 이어 네 제공처 자동 첨부 수집·PDF/HWP/HWPX 파싱·단일 Agent·실행 이력을 연결했다. 실제 모델 품질·사람 검수·운영 배포는 별도 검증 범위다.**
- 설계 기준: 2026-09-09, 소스 커밋 `f238d993bd0a4c4f109ff109d39f09e5c0e54c8c`.
- V10은 검토 입력, V11은 실행 스냅샷·원본 파일을 정의한다. 공식 원문과 AI Service 호출은 분석 POST에서만 실행한다.

## 1. 기능 범위

사용자가 관심 공고함 또는 전체 공고 검색에서 비교할 사업 2개와 지원 상태를 입력하면 공식 근거를 대조하여 단계별 제한·허용 범위·미확인 사항을 보여준다.
메뉴명은 **중복 지원 검토**, 기능 식별 이름은 `combinationreview` / `combination_review`로 제안한다.

| 포함 | 제외 |
|---|---|
| 중복 신청, 선정·확약·협약, 동시 수행, 수혜·비용의 구분 | 신청서 작성 도우미, 증빙 업로드·누락 점검, DOCX 출력 |
| 필요한 과제 관계·지원 이력 확인 질문 | 정부의 개인 지원 이력 자동 조회 |
| 검토 저장·이어보기·입력 변경 후 재검토 | 신청·기관 문의 자동 전송, 선정·지급 보장 |
| 근거 자료 검수와 제한된 운영·실행 이력 | 모든 정부사업의 완전한 검토, 최적 수령액 계산 |

기관 확인이 필요한 해석은 미확인으로 남긴다. 연락이 되지 않는 것을 허용·제한의 근거로 사용하지 않는다.
일반 회원은 직접 정보를 입력해 사용할 수 있게 하며, 미구현 기업 등록을 선행 조건으로 만들지 않는다.
검토의 소유자는 우선 계정이다. 예시 기업 프로필이나 관리자 역할만으로 다른 계정의 자료에 접근하지 않는다.

## 2. 현재 구조에 연결하는 책임

| 영역 | 책임 | 연결 원칙 |
|---|---|---|
| Frontend | 입력 초안·질문·결과 표시, 로딩·취소 | View → ViewModel → UseCase → Repository 구현 → HTTP API |
| Core API | 인증·소유권·사업 식별·입력 버전·실행·결과 저장 | Controller → Service → Repository → MyBatis Mapper → XML → MySQL |
| AI Service | 공식 조항과 사용자 사실의 의미 대조, 질문·설명 생성 | Router → Service → 구체 Agent → OpenAI |
| 공식 자료 | 문서 식별·불변 버전·원문 위치·검수 상태 | 검수된 자료 버전만 검토 기준으로 사용 |

Core의 Service는 AI Client를 호출하고, AI Service는 MySQL에 직접 접근하지 않는다.
복잡한 하위 호출·검증·변환을 감춰야 할 때만 Facade를 추가한다. 전달만 하는 계층, 범용 규칙 엔진,
Protocol·registry·Agent graph를 먼저 만들지 않는다. 기존 객체 조립 위치에 구체 구현을 등록한다.

규정의 의미·예외 적용은 LLM이 해석한다. 사업쌍 생성, 접근 권한, ID·버전 검증, 확인된 값의 계산은 코드가 처리한다.
계산 대상과 제외 조건이 확인되지 않은 상태에서는 합계가 맞더라도 충족으로 판정하지 않는다.
OpenAI 장애를 규칙 기반 정상 답변으로 바꾸는 fallback은 두지 않는다.

## 3. 로그인 전후 화면

| 상황 | 설계 동작 |
|---|---|
| 비로그인 공개 검색·공고 상세 | 기존 기능 유지. 검토 시작 버튼은 로그인으로 연결 |
| 로그인 완료 | 선택한 공개 공고 식별자를 유지한 시작 화면으로 복귀 |
| 시작 화면 | 사업·유형을 확인한 뒤 명시적인 생성 버튼으로 검토 건 생성 |
| 회원 작업 | `/app/combination-reviews`의 목록·세부 작업을 기존 사이드바에서 제공 |
| 관리자 | 기존 ADMIN 가드를 재사용하되 서버에서 각 운영 행위의 권한도 검사 |

제안 경로:

```text
/app/combination-reviews
/app/combination-reviews/new
/app/combination-reviews/:id/programs
/app/combination-reviews/:id/history
/app/combination-reviews/:id/questions
/app/combination-reviews/:id/results
```

`new` 진입, 로그인 복귀, 페이지 마운트만으로 생성·LLM 요청을 실행하지 않는다.
로그인 복귀 정보에는 공개 공고 ID·작업 종류만 넣고 기업 설명·지원 이력은 URL에 넣지 않는다.
복귀 URL은 정규화 후 동일 origin과 허용된 내부 경로인지 검증한다. 선택된 공고도 서버에서 다시 검증한다.
기존 `appPaths`, `RequireAuth`, `WorkspaceLayout`, 세션 쿠키를 재사용한다.

세션 확인 중에는 개인 데이터 요청을 대기한다. 세션 없음·만료와 세션 조회 장애를 구분할 필요가 있다.
로그아웃·계정 전환에는 검토 기능의 메모리 상태를 비우고 이전 요청의 늦은 응답을 차단한다.
401 이후 쓰기·유료 요청은 로그인만으로 자동 재전송하지 않고, 기존 반영·실행 여부부터 확인한다.

공통 인증의 세션 복원 오류·로그아웃 실패 표현 등 기존 문제는 별도 영향 검토 대상으로 기록한다.
이 이슈에서는 신규 기능의 데이터 격리와 진입에 필요한 최소 수정만 연결하고 인증 전체를 일괄 재작성하지 않는다.

## 4. 데이터 모델

### 검토 건과 검토 실행은 다르다

- **검토 건(Review)**: 사용자가 계속 편집하고 이어 보는 작업. 소유자와 현재 입력 버전을 가진다.
- **검토 실행(Run)**: 특정 입력·자료 버전으로 수행한 분석 한 번. 당시 입력과 결과를 보존한다.

```text
검토 건 R1
  입력 v1 → 실행 E1 → 당시 결과
  입력 v2 → 실행 E2 → 새 결과
```

입력이 바뀌면 이전 결과를 삭제하거나 새 입력의 결과인 것처럼 덮어쓰지 않는다.
첫 버전은 입력 변경 시 검토 전체를 재실행한다. 영향받은 사업쌍만 재실행하는 최적화는 이후 검토한다.

### 사업·상태·관계

| 모델 | 핵심 정보 |
|---|---|
| 사업 식별 | `sourceCode + sourceProgramId`, 필요하면 검수된 `subProgramId` |
| 선택 사업 | 검토 안의 `selectionId`, 사업 식별자, 선택한 연도·회차·유형의 기준 |
| 사업별 상태 | 신청, 선정, 확약서, 협약, 수행, 교부·수혜 상태와 관련 시각 |
| 사업 간 관계 | 같은 과제·산출물·비용 여부, 사용자의 설명·출처·확인 시점 |
| 추가 이력 | 관련 규정이 요구할 때만 다른 수행·수혜 이력을 수집 |
| 검토 실행 | 입력 버전·스냅샷, 공식 자료 버전, 모델·프롬프트·계약 버전, 실행 상태 |

미입력은 `UNKNOWN`으로 처리한다. `null` 날짜는 미정이지 미신청·미수혜의 근거가 아니다.
신청·선정·교부 상태를 하나의 순차 enum으로 합치지 않는다. 선정됐지만 교부 전인 경우를 표현해야 한다.
LLM이 사용자 설명에서 추출한 중요한 상태 변경은 제안으로 보관하고 사용자 확인 후 적용한다.
자료·회사·사업 이름이 비슷하다는 이유로 같은 대상으로 합치지 않는다.

### 실행 상태와 판단 상태

| 구분 | 제안 값 | 의미 |
|---|---|---|
| 실행 | RUNNING / SUCCEEDED / FAILED / INTERRUPTED | 기술적으로 분석을 처리했는지 |
| 단계별 판단 | RESTRICTION_APPLIES | 확인한 조건에서 제한 적용 |
| 단계별 판단 | PERMISSION_IN_SCOPE | 명시된 범위의 허용만 확인 |
| 단계별 판단 | NEEDS_FACTS | 적용 여부를 가르는 사용자 정보 부족 |
| 단계별 판단 | INSUFFICIENT_EVIDENCE | 공식 자료 부족 |
| 단계별 판단 | CONFLICTING_EVIDENCE | 근거 관계를 확정하기 어려움 |

판단에는 적용 단계, 설명, 근거 ID, 사용한 사실 ID, 검토 범위, 미확인 사항을 함께 반환한다.
허용 문구를 찾은 것과 사용자 전체 자격이 충족된 것은 구분한다. 사업쌍 결과와 전체 이력 조건도 구분한다.
전체 이력을 검토하지 않았다면 그 범위를 표시하고, 사업쌍 결과로 전체 동시수혜를 허용하지 않는다.

## 5. API 계약

생성·목록·상세·입력 수정·삭제와 runs·AI 내부 분석 경로를 구현했다. messages 경로는 아직 미구현 설계다.

| API | 동작 |
|---|---|
| POST `/api/v1/combination-reviews` | 선택 사업으로 검토 건 생성. 소유자는 서버 세션에서 결정 |
| GET `/api/v1/combination-reviews` | 본인 검토 목록 조회 |
| GET `/api/v1/combination-reviews/{id}` | 본인 현재 입력·버전 조회. 실행은 별도 runs 경로에서 조회 |
| DELETE `/api/v1/combination-reviews/{id}` | 본인 검토 삭제. 선택 공고·실행 이력·보관 원문은 FK cascade로 함께 삭제 |
| PUT `/api/v1/combination-reviews/{id}/inputs` | 확인한 입력 저장. `expectedRevision`으로 동시 수정 검출 |
| POST `/api/v1/combination-reviews/{id}/messages` | 답변 해석·상태 변경 제안. 확정 입력은 자동 덮어쓰지 않음 |
| POST `/api/v1/combination-reviews/{id}/runs` | 지정 입력 버전으로 검토 실행 |
| GET `/api/v1/combination-reviews/{id}/runs/{runId}` | 해당 검토에 속하는 실행 조회 |
| GET `/api/v1/combination-reviews/{id}/runs` | 본인 실행 목록·커서 조회 |
| GET `/api/v1/combination-reviews/{id}/runs/{runId}/sources/{documentIndex}` | 실행 당시 원본 파일 다운로드 |
| GET `/internal/v1/combination-reviews/configuration` | AI 모델·프롬프트·계약 버전 확인. LLM 호출 없음 |
| POST `/internal/v1/combination-reviews/analyze` | Core가 구성한 근거·사실을 AI Service에서 분석 |

쓰기 요청에는 세션 쿠키를 전달하고 기존 Origin 검사를 유지한다. CORS의 GET·POST 허용에 PUT·DELETE를 추가했다.
401 인증 만료, 403 접근 제한, 404 없는/접근 불가 자원, 409 입력 버전 충돌, 429 요청 제한,
503 서비스 불가, 504 시간 초과를 각 계약에서 일관되게 처리한다. 자료 부족은 모델 장애와 구분한다.
권한 있는 요청의 정상 분석에서 근거가 부족하면 성공 결과에 `INSUFFICIENT_EVIDENCE`를 담는다.
새 실행 POST 성공은 201, 저장된 실행 재조회는 200이다. 기술 실패는 정상 판단 결과로 변환하지 않는다.

첫 버전의 POST `/runs`는 **동기 요청**이다. 서버가 결과를 저장하고 응답하며, GET은 저장된 실행을 읽는 용도다.
백그라운드 queue·worker가 있는 것처럼 설명하거나 동작시키지 않는다.

실행 절차:

1. 인증·소유권·입력·지원 대상 확인, 요청량·동시 실행 허용 여부 검사.
2. 짧은 transaction에서 입력 스냅샷과 RUNNING 실행 생성.
3. DB transaction 밖에서 AI 호출.
4. 근거·사실 ID, 사업쌍·단계, 자료 버전과 응답 스키마 검증.
5. 짧은 transaction에서 성공/실패를 기록. 입력이 바뀌었으면 현재 결과로 적용하지 않음.

동일 계정·검토·실행 요청 키는 DB 고유성으로 중복 실행을 막는다. 같은 키와 다른 payload는 충돌로 거절한다.
실패 후 재시도는 같은 검토 아래 새 키·새 실행으로 남긴다. 별도 retryOfRunId 필드는 없으며 이전 실행을 덮어쓰지 않는다.
브라우저 취소만으로 OpenAI 중단을 보장하지 않는다. 강제 종료로 남은 RUNNING은 경과 시간만으로 재실행하지 않는다.
실제 실행 주체 종료를 확인한 뒤 아래 운영 복구 절차로 INTERRUPTED 처리한다. 자동 복구 worker는 없다.

## 6. 공식 근거와 첫 검증 대상

4-1의 고정 원문·인용·사례는 [중복 검토 평가 자료](../evaluation/combination-review/README.md)에 있다.
일반형·딥테크 두 모집공고 원문, 인용 12개, 가상 입력 18개를 준비했다. 투자연계형 별도 공고는 미확보이며
사람이 검수한 정답은 0건이다. [검수표](../evaluation/combination-review/REVIEW.md)에서 해석 범위와 보류 항목을 확인한다.

첫 표본은 [2026년 창업도약패키지 일반형 공식 공고](https://mss.go.kr/site/smba/ex/bbs/View.do?bcIdx=1065016&cbIdx=310)의 유형별 관계다.
확보한 원문·정확한 인용·내용 해시를 구현 단계에서 검수해 고정하고, 기대 결과는 사람 검수 전까지 AI 초안으로 표시한다.
과거 접수 공고를 현재 신청 가능한 추천으로 표시하지 않는다.

기존 검색은 현재 공개 카탈로그 중심이므로 과거 검증 공고가 검색에 항상 나온다고 가정하지 않는다.
자동 수집은 네 제공처의 검증된 공고 식별자와 공식 상세가 직접 연결한 PDF·HWP·HWPX를 지원한다.
4-1 고정 검수 초안과 runtime 자동 수집을 구분하며 자동 근거의 상태는 `AUTOMATIC_UNREVIEWED`다.
다른 제공처·미검증 세부사업 ID는 거절한다. 기존 공고 DB에 가상 사업을 주입하지 않는다.

최초에는 작은 근거 묶음을 직접 Agent에 전달해 검색 오류와 해석 오류를 분리한다.
자료가 늘면 Qdrant에서 사업·유형·문서 버전으로 제한하여 검색하되, 연결된 정의·예외·참조 조항은 함께 가져온다.
현재 단일 공고 질문의 청크 수·상위 5개 검색 계약을 그대로 충분하다고 가정하지 않는다.
하나의 통합공고가 여러 사업의 관계를 명시할 수도 있으므로 근거 문서 수가 아니라 검토 범위를 확인한다.

| 사례 | 기대 동작 초안 |
|---|---|
| 같은 연도의 여러 유형에 신청하려 함 | 신청과 수행의 제한을 구분하고 전체 자격은 별도 표시 |
| 관련 사업에 확약서를 제출했음 | 어떤 사업에 언제 제출했는지 반영 |
| 확약서 제출 여부를 모름 | 미제출로 추정하지 않고 추가 확인 |
| 다른 연도의 참여 이력이 있음 | 동일연도 제한과 과거 참여 제한을 각각 확인 |
| 관련 예외·상대 지침이 없음 | 검토 범위를 표시하고 전체 허용으로 확대하지 않음 |
| 입력 v1 분석 중 v2로 변경 | v1 결과 보존, 현재 입력 결과로 적용 금지 |
| 다른 계정의 검토·실행 ID로 조회 | 개인 데이터 노출 금지 |
| 모델 실패·시간 초과 | 명시적인 기술 오류, 규칙 기반 정상 응답으로 대체 금지 |

기관 해석 미확인 관계와 연도 표기가 다른 자료는 단독 확정 근거로 사용하지 않는다.
유료 모델 평가는 전송할 자료와 호출 예산을 정한 뒤 승인 범위 안에서만 실행한다.

## 7. 구현된 Domain과 남은 경계

Core 기본 패키지의 `combinationreview/domain`에 다음 타입을 둔다.

| 타입 | 구현된 책임 |
|---|---|
| `ReviewProgramIdentity` | 제공처·원본 ID·선택적 세부사업 ID의 값 검증과 동등성 |
| `ProgramParticipation` | 신청·선정·확약·협약·교부 사실의 YES/NO/UNKNOWN 및 독립적인 수행 상태 |
| `SelectedReviewProgram` | 한 사업 식별자와 참여 사실의 결합 |
| `CombinationReviewInput` | 서로 다른 사업 2개를 확정 입력으로 검증하고 목록 스냅샷 보존 |
| `ReviewProgramPair` | 서로 다른 두 식별자를 정규화한 비교 대상 |

`programPairs()`는 선택한 2개 사업의 비교쌍 하나를 반환한다. 입력 순서를 바꿔도 같은 쌍과 비교 순서를 반환하고,
화면 표시용 입력 순서는 보존한다. 문자열 구분자 연결 대신 식별자 필드별로 비교한다.
동일 제공처·원본 ID라도 세부사업 ID가 다르면 별도 값이다. 부모 공고와 세부사업이 실제로 별도 비교 대상인지,
해당 자료가 검수됐는지는 추후 Service에서 지원 목록을 기준으로 검사한다.

미입력 사실은 UNKNOWN이다. 선정 사실이 YES여도 확약서·협약·교부 사실을 자동 생성하지 않는다.
이 타입은 사실 스냅샷이지 상태 전이 엔진이 아니다. 시각·출처·수혜/반환 이력·진술 충돌 확인은 후속 계약이 필요하다.
검토 건의 현재 입력은 HTTP DTO·Controller·Service를 통해 아래 Repository로 저장한다. Run·AI 연결의 현재 범위는 아래 4-2~4-4 절을 따른다.
Spring annotation·MyBatis mapping·네트워크 의존성은 새 Domain에 넣지 않았다.

검증은 기존 변경 범위별 규칙에 따라 JDK 21에서 Core 전체 테스트를 실행한다.
Domain 테스트는 정확히 2개인 사업 수, ID 길이·특수문자·중복, 제공처·세부사업 분리와 스냅샷 보호를 확인한다.
이 테스트 통과는 실제 규정 해석이나 LLM 품질 검증을 의미하지 않는다.

### MyBatis 저장 경로

```text
CombinationReviewDraft(Domain)
  → CombinationReviewRepository
    → CombinationReviewDbRow / CombinationReviewProgramDbRow
    → CombinationReviewMapper
    → mybatis/combinationreview/repository/CombinationReviewMapper.xml
    → MySQL
  → StoredCombinationReview(Domain)
```

| 테이블 | 저장 내용·제약 |
|---|---|
| `combination_review` | 소유 계정 FK, 제목, 양수 입력 버전, 서울 기준 생성·수정 시각 |
| `combination_review_program` | 검토 FK, 0~2 표시 순서, 공고·세부사업 식별자, 독립적인 참여 사실과 수행 상태 |

선택 사업 배열은 JSON이 아닌 자식 행으로 저장한다. DbRow의 enum 문자열 변환과 표시 순서 복원은 Repository가 담당한다.
사업의 고유성은 `(review_id, source_code, source_program_id, sub_program_key)`로 보장한다.
`sub_program_key`는 nullable `sub_program_id`의 NULL을 빈 문자열로 바꾸는 DB 생성 컬럼이며, 실제 빈 ID는 허용하지 않는다.
MySQL UNIQUE가 NULL 여러 개를 허용해 같은 부모 공고가 중복 저장되는 것을 막기 위한 표현이다.
식별자 컬럼은 `utf8mb4_0900_bin`으로 대소문자·악센트 차이를 보존한다. 모든 한글·특수문자는 utf8mb4로 저장한다.

표시 순서 PK와 CHECK는 DB에서 최대 3행을 제한한다. 최소 2개 및 완성된 입력 검증은 Domain과 Repository transaction이 맡는다.
수동 SQL까지 포함한 최소 행 수를 DB에서 보장한다고 주장하지 않는다. 비정상 저장 자료를 읽으면 Domain 검증 오류를 숨기지 않는다.
기존 공고 카탈로그에는 FK를 걸지 않는다. 현재 공개 목록에서 빠진 과거 공고도 검토 자료로 사용할 수 있기 때문이다.
공식 자료·지원 목록에 실제로 존재하는 사업인지는 후속 Service에서 검증해야 한다.

Repository 공개 메서드:

- `create(ownerAccountId, draft)`: 검토 건과 모든 선택 사업을 한 transaction에서 생성한다.
- `findOwned(ownerAccountId, reviewId)`: 소유자 조건으로 조회한다. 두 SELECT는 REPEATABLE_READ transaction에서 같은 스냅샷을 읽는다.
- `listOwned(ownerAccountId, beforeId, limit)`: 소유자·ID 커서로 부모 행 메타데이터만 조회한다. ID 내림차순이며 Service의 다음 페이지 확인용 1건을 포함해 최대 51건이다.
- `replaceOwned(ownerAccountId, reviewId, expectedRevision, draft)`: 소유자·버전이 일치한 부모 행만 수정하고 자식 목록을 교체한다.

교체 중 하나의 SQL이 실패하면 제목·버전·삭제·삽입을 함께 rollback한다. 같은 버전의 동시 수정은 한 요청만 성공한다.
조건 불일치는 false로 반환하며 Service가 소유자 조건 재조회로 없음·타인 자료(404)와 본인 버전 충돌(409)을 구분한다.
읽기 메서드는 Repository가 소유하는 REPEATABLE_READ 경계에서 호출하며, 향후 더 낮은 격리 수준의 외부 transaction으로 감싸지 않는다.
인증된 계정 결정·정지/삭제된 계정 확인은 기존 Account 세션 Service의 책임이며, ID 필터만으로 인증을 구현했다고 표현하지 않는다.

V10은 기존 migration을 수정하지 않고 새 테이블만 추가한다. 계정을 물리적으로 삭제하면 해당 검토·자식 행은 FK cascade로 정리된다.
기존 계정의 논리 삭제는 행을 물리 삭제하지 않으며 위 인증 검사로 접근을 제한해야 한다.
3-1에서는 현재 입력만 저장했다. 현재는 V11 Run에 당시 입력·원문·분석 결과를 별도로 보존한다.
목록·페이지네이션·공개 API는 아래 3-2 계약으로 연결했다.

### 3-2 입력 저장 HTTP 계약

모든 경로는 non-null `Account` 인자를 기존 `AuthenticatedAccountArgumentResolver`로 해석한다.
쿠키의 JWT뿐 아니라 저장된 세션·계정 상태를 기존 `AccountSessionService`로 확인한다.
요청 body·query의 계정 ID는 소유자 결정에 사용하지 않는다. ADMIN에도 소유자 예외를 두지 않는다.
로그인 또는 GET 호출만으로 검토 건을 만들지 않으며, 이 API에서 AI Service를 호출하지 않는다.

생성 요청 예시 (`Content-Type: application/json`):

```json
{
  "title": "2026 창업도약 유형 비교",
  "programs": [
    {
      "sourceCode": "BIZINFO",
      "sourceProgramId": "example-notice",
      "subProgramId": "general",
      "participation": {
        "applicationSubmitted": "YES",
        "selected": "UNKNOWN",
        "commitmentSubmitted": "NO",
        "agreementSigned": "UNKNOWN",
        "executionStatus": "NOT_STARTED",
        "fundingReceived": "UNKNOWN"
      }
    },
    {
      "sourceCode": "BIZINFO",
      "sourceProgramId": "example-notice",
      "subProgramId": "deep-tech"
    }
  ]
}
```

위 ID는 계약 설명용 예시이며 검수된 공식 사업 ID가 아니다. 3-2는 식별자 형식과 입력만 검증한다.
공식 자료·지원 목록에 실제 존재하는 공고·세부사업인지 확인하는 기능은 4-1 이후에 연결한다.
기존 공개 카탈로그만을 기준으로 과거 공고를 배제하거나 미검수 자료를 검토 가능한 자료로 표시하지 않는다.

- 제목은 앞뒤 공백 없는 1~200 Unicode code point이고 Unicode 기타 문자(제어 문자 등)를 거절한다.
- `programs`는 정확히 2개다. 동일 제공처·공고·세부사업 조합은 중복으로 거절하고 표시 순서를 유지한다.
- 정책 변경 전에 저장된 3개 공고 검토와 당시 실행 결과는 조회할 수 있지만, 입력을 2개로 줄이기 전에는 새 분석을 실행하지 않는다.
- 제공처는 `[A-Z][A-Z0-9_]{0,63}`, 공고·세부사업 ID는 Domain의 정규화·최대 255 code point 규칙을 따른다.
  세부사업 ID 생략/null은 부모 공고를 뜻하고 빈 문자열은 거절한다.
- participation 또는 개별 사실 생략은 UNKNOWN이다. 신청·선정·확약·협약·교부는 YES/NO/UNKNOWN,
  수행은 UNKNOWN/NOT_STARTED/IN_PROGRESS/COMPLETED/STOPPED다. 명시적인 null·잘못된 값은 400이다.
- 생성은 201, `Location: /api/v1/combination-reviews/{id}`와 상세 본문을 반환한다.
  상세 본문은 `id`, `title`, `inputRevision`, `programs`, `createdAt`, `updatedAt`이고 소유자 ID는 노출하지 않는다.
  생성 버전은 1이며 시각은 서울 offset `+09:00`이다.
- PUT은 생성과 같은 제목·전체 사업 배열 및 `expectedRevision`(1~Long.MAX_VALUE-1 정수)을 받는다.
  부분 수정이 아니므로 생략한 참여 사실은 UNKNOWN으로 교체된다. 성공하면 버전을 1 올리고 204를 반환한다.
  재조회 응답에 다른 요청의 입력이 섞이지 않게 PUT 응답에는 본문을 넣지 않는다. 최신 입력은 GET으로 조회한다.
- 목록은 `size` 기본 20·범위 1~50, 선택적 `beforeId` 양수 ID 커서다.
  `items`에 상세의 메타데이터(사업 배열 제외), `nextBeforeId`에 다음 조회 커서 또는 null을 반환한다.
  생성 ID 내림차순이며 커서보다 작은 본인 ID만 조회한다. 수정으로 순서를 바꾸지 않고 전체 건수는 반환하지 않는다.
- 성공 응답은 `Cache-Control: no-store`다. 프런트의 로그아웃·계정 전환 메모리 격리는 화면 단계에서 별도로 연결한다.

| 상태 | 오류 code / 조건 |
|---|---|
| 400 | `REQUEST_VALIDATION_FAILED`: 잘못된 JSON·필수 값·타입·입력·ID·페이지 범위 |
| 401 | `AUTHENTICATION_REQUIRED`: 세션 없음·만료·로그아웃·삭제 계정 |
| 403 | `ACCOUNT_SUSPENDED` 또는 `SESSION_ORIGIN_REJECTED`: 정지 계정 또는 쿠키 쓰기 요청의 Origin 검사 실패 |
| 404 | `COMBINATION_REVIEW_NOT_FOUND`: 없는 검토와 타인 검토를 동일하게 처리 |
| 409 | `COMBINATION_REVIEW_REVISION_CONFLICT`: 본인 검토의 expectedRevision 불일치 |
| 415 | `UNSUPPORTED_MEDIA_TYPE`: JSON 이외 요청 본문 |

오류는 기존 ProblemDetail(`application/problem+json`) 형식을 재사용하며 입력값·타인 정보·DB 오류 내용을 담지 않는다.
허용되지 않은 Origin의 CORS 요청은 기존 Spring CORS 처리기가 먼저 403으로 거절할 수 있으며 그 응답에는 위 JSON code가 없다.
허용된 Origin 또는 기존 Referer 대체 검사는 유지한다. 저장 자료 손상·DB 장애를 400이나 성공 결과로 바꾸지 않는다.

## 8. Domain 추가 후 검증 (2026-09-09)

Linux Temurin JDK 21.0.12에서 Core 작업 디렉터리를 기준으로 다음을 실행했다.

```bash
bash ./gradlew clean test --tests 'ai.govbiz.core.combinationreview.domain.*' --no-daemon --project-cache-dir /root/.gradle/skn59-project
bash ./gradlew clean test --no-daemon
```

| 검증 범위 | 결과 |
|---|---|
| 신규 Domain | 3개 스위트, 17개 통과 |
| Core 전체 | 62개 스위트, 641개 통과; 신규 17개 포함 |
| 실패·오류·건너뜀 | 모두 0 |
| DB 검증 | 실제 `mysql:8.4` Testcontainers 사용; 기존 계정·지원사업·근거 답변 통합 테스트 포함 |
| 소스 일치 | 테스트 컨테이너의 소스·빌드 설정 247개 파일과 작업 파일의 SHA-256 일치 |

전체 검증은 소스와 캐시를 Linux 내부로 복사한 환경에서 수행했다. Windows JVM loopback 오류로 시작하지
못한 실행과 공유 폴더 지연으로 중단한 실행은 통과 결과에 포함하지 않았다.
기존 `AiSupportProgramConversationClientTest`의 deprecated API 경고는 남아 있다.
위 결과는 Domain 추가 시점 기록이다. 이후 영속성 변경의 검증과 구분하며 HTTP API·LLM 품질 검증으로 해석하지 않는다.

## 9. 저장 경로 추가 후 검증 (2026-09-09)

Linux Temurin JDK 21.0.12·실제 MySQL 8.4 Testcontainers에서 관련 테스트를 먼저 확인한 뒤,
최종 소스로 `bash ./gradlew test --no-daemon`을 실행했다.

- Core 전체: **64개 스위트·657개 통과**, 실패·오류·건너뜀 0.
- 이번 추가: Repository 통합 14개, 검토 제목 입력 검증 2개. 이전 Domain 17개도 전체 실행에 포함된다.
- 확인 범위: 한글·특수문자, NULL 세부사업, 대소문자·악센트 구분, FK·고유성·상태 제약,
  다른 소유자 차단, 버전 충돌, 동시 수정의 단일 성공, 조회 스냅샷 일관성, 생성·교체 중 SQL 실패 rollback.
- 테스트 소스·빌드 설정 256개 파일의 SHA-256이 작업 파일과 일치했다.
- 기존 deprecated API 경고는 유지된다. 신규 HTTP API·LLM·화면과 운영 배포는 검증 범위가 아니다.

V6는 테스트 DB에서 적용·검증했으며 이번 작업으로 운영 DB에 migration을 실행하지 않았다.

## 10. 인증 기반 입력 API 추가 후 검증 (3-2, 2026-09-09)

Linux Temurin JDK 21.0.12·실제 MySQL 8.4 Testcontainers에서 실행했다.
소스는 Windows bind mount 대신 테스트 컨테이너의 `/workspace`로 복사하고 Linux Gradle 캐시를 사용했다.
Docker 소켓과 `TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal`을 테스트 컨테이너에만 연결했다.

```bash
# 관련 테스트를 먼저 실행
bash ./gradlew test --tests 'ai.govbiz.core.combinationreview.*' --no-daemon
# revision 타입·명시적 null 검증 사례를 보강한 최종 소스의 Core 전체 검증
bash ./gradlew test --no-daemon
```

| 범위 | 실제 결과 |
|---|---|
| 관련 테스트 선행 실행 | 6개 스위트·54개 통과, 실패·오류·건너뜀 0 |
| 최종 Core 전체 | **65개 스위트·681개 통과**, 실패·오류·건너뜀 0 |
| 최종 중복 검토 테스트 | 6개 스위트·57개: 신규 API 통합 24개, 기존 Repository 14개·Domain 19개 |
| 실행 환경 일치 | 테스트 소스·빌드 설정 264개 파일과 작업 파일의 SHA-256 일치 |

확인한 동작:

- 기존 세션 쿠키·Account 확인 → Controller → Service → Repository → MyBatis → 실제 MySQL의 생성·목록·상세·입력 수정.
- 요청의 소유자 ID 주입 무시, 일반 회원 사용, 타인 자료·없는 자료의 동일 404와 ADMIN 소유권 제한.
- 세션 없음·잘못된 토큰·만료·로그아웃·논리 삭제 계정의 401, 정지 계정의 403; 모든 신규 경로에서 쓰기 차단.
- 독립적인 참여 사실·UNKNOWN 기본값, 정확히 2개인 사업 수·중복·ID·제목·Unicode 경계·revision 타입·null 입력 검증.
- 동일 입력 버전의 동시 PUT 중 한 요청만 성공(204), 다른 요청은 409; 거절한 입력은 저장하지 않음.
- 소유자별 목록·기본 20건/최대 50건·커서·빈 목록과 신규 생성·수정 사이 페이지 순서 유지.
- PUT preflight 허용, 악성 Origin·Origin/Referer 누락 차단, 기존 Referer 대체 검사, 성공 응답 no-store·서울 offset.
- 기존 Repository 생성·교체 transaction rollback과 조회 스냅샷 일관성도 최종 전체 실행에 포함.

`git diff --check`, 기능 Kotlin package와 디렉터리 일치, 변경 문서의 상대 링크를 확인했다.
기존 deprecated API 및 JVM class sharing 경고는 남아 있으며 테스트 실패로 집계되지 않았다.
이번 결과는 로컬 자동 검증이다. 원격 CI·프런트 브라우저·AI Service·유료 OpenAI 평가·실제 규정 해석 품질·운영 배포는 검증하지 않았다.
지원 대상·공식 근거 검수, Run 저장, 화면·로그인 복귀·계정 전환 메모리 격리는 후속 단계다.
V6는 테스트 DB에서만 적용됐으며, 운영 컨테이너·운영 데이터는 변경하지 않았다. 변경은 아직 미커밋·미푸시 상태다.

## 11. 공식 근거·검증 사례 준비 (4-1, 2026-09-09)

- 데이터 ID: `startup-jump-2026-v1`. 중기부 일반형·딥테크 HWPX 원문 2개와 기업마당 딥테크 PDF 대조본 1개를 바이트 그대로 고정했다.
- 원문·자료 SHA-256과 인용의 HWPX XML 문단 위치를 기록했다. PDF의 글자 중복 추출 문제로 인용은 HWPX를 기준으로 삼았다.
- PDF 8개 관련 페이지를 AI가 시각 대조했다. 일반형의 시각 검수·사람의 원문/해석 검수는 미실행이다.
- 본문·각주·붙임을 연결한 인용 묶음 12개, 공식 근거 기반 가상 입력 15개와 방어 사례 3개를 준비했다.
- 인위적 충돌 사례는 공식 근거와 분리했다. 실제 공고 충돌을 발견했다고 주장하지 않는다.
- 오프라인 검증기 및 변조/누락 거절 테스트 16개 통과. 실제 모델 호출 0회, 모델·프롬프트 버전과 품질 점수는 null이다.
- 변경은 `evaluation/combination-review`와 문서에 한정된다. Core·AI·Frontend 실행 코드를 바꾸지 않아 이전 전체 테스트를 반복하지 않았다.

현재 수행한 경로는 `로컬 manifest → 원문 해시·HWPX 인용 위치·참조/출처 구분 검사 → 무결성 보고서`다.
Core HTTP → AI/LLM 호출 흐름은 추가하지 않았다. 새 자료 검증은 기존 CI에 아직 연결하지 않았으며 README 명령으로 로컬 실행했다.

공식 카탈로그 ID를 확보한 두 유형도 production 지원 목록에는 등록하지 않았다. 투자연계형 원문, 정산·반환 지침,
기관 해석과 사람 검수는 미완료다. 다음 4-2에서 사용할 근거 버전·지원 범위와 추가 입력 계약을 검토해야 한다.
4-1 시점에는 유료 OpenAI 전송 자료·모델·호출 예산을 승인/실행하지 않았으며 Run·Agent 연결 전이었다.

## 12. 자동 수집·분석·실행 이력 (4-2~4-4)

### 현재 계층 책임

| 구성 요소 | 책임 |
|---|---|
| Controller·공개 DTO | 세션 Account를 받아 Service 호출, 공개 입력/응답 변환 |
| Run Service | 실행 예약·수집/변환 순서·근거 묶음 구성·상태 저장·공개 오류 분류 |
| AI Facade | AI 설정/분석 호출과 응답 검증을 하나의 경계로 제공. Service/DB 호출 없음 |
| Client | 공식 원문 또는 AI HTTP 통신. 자체 경계 예외 사용 |
| client/mapper | PDF/HWP/HWPX 디코딩·첨부 DTO→문서 모델, AI 요청/응답 DTO 변환 |
| Repository·MyBatis | 원자적 예약·보존·조회와 DbRow/JSON 변환. Service 참조 없음 |
| Domain·domain/exception | 검토 모델과 검토 없음·버전·실행 충돌 같은 업무 실패. 프레임워크 참조 없음 |

PDFBox/XML 의존성은 문서 Mapper에 있다. 파일 바이트 상한은 수집·디코딩이 함께 사용하는 첨부 전송 계약에 둔다.
공개 입력 변환 실패는 `controller/exception`, 실행 오류는 `service/exception`에서 소유한다.
AI Client·Facade의 실패를 Service에서 해석하며 AI 계약 검증 오류와 무관한 내부 오류를 ANALYSIS_INVALID로 묶지 않는다.
공개 API·요청 키·DB transaction 범위와 원문 파싱 규칙은 유지한다.

### 실행 API와 스냅샷

```http
POST /api/v1/combination-reviews/{id}/runs
Content-Type: application/json
Origin: <configured-origin>
Cookie: <existing-session-cookie>

{
  "expectedRevision": 1,
  "requestKey": "0a504895-77bd-4d34-bc61-3e6d12389042",
  "additionalFacts": "선정 통보는 받았지만 확약서 제출 시각은 확인이 필요합니다."
}
```

- 소유자는 세션 Account다. 기존 입력 API와 같은 Origin·계정 상태 검사를 거친다.
- `requestKey`는 소문자 UUID 형식이다. 같은 검토·키·내용은 RUNNING/성공/실패 상태 그대로 200으로 반환한다.
  같은 키에 다른 expectedRevision/additionalFacts를 보내면 409다. 기존 실행이 있으면 현재 검토 버전이 달라도 재조회한다.
- 새 키는 현재 입력 버전과 일치해야 한다. 실행 중인 검토에 다른 키를 보내면 409다.
- `additionalFacts`는 최대 8,000 UTF-16 길이의 실행별 추가 진술이다. Run 입력 스냅샷에 저장되며 검토의 현재 입력을 자동 수정하지 않는다.
  `inputRevision`은 저장된 제목·선택 사업·참여 상태의 버전이다. 추가 진술까지 포함한 실행은 requestKey와 당시 input을 함께 식별한다.
- 서울 기준 `asOfDate`, 당시 제목·사업·참여 상태·추가 진술을 입력 스냅샷으로 고정한다.
  실행 중 PUT으로 입력이 바뀌어도 과거 Run의 입력·결과는 바뀌지 않는다. 검토 건에 결과를 덮어쓰는 현재 결과 포인터는 없다.
- 성공한 새 POST는 201과 Location, 기존 실행은 200을 반환한다. 로그인·GET·생성·입력 PUT으로 분석을 자동 시작하지 않는다.
- GET 목록은 `size=20` 기본·1~50 범위, 선택적 양수 `beforeId` 커서로 ID 내림차순이다. 상세·목록·원본 다운로드는 모두 본인만 가능하다.
- 새 실행은 기존 공개 요청 제한을 계정별 키로 사용한다(기본 계정 6회/분, 공유 글로벌 60회/분, 공유 동시 4개/프로세스).
  중복 검토 자체는 최대 2개/프로세스, DB는 검토당 RUNNING 1개를 보장한다. 설정된 기존 한도가 기본값보다 우선한다.
  거절한 새 예약은 FAILED로 남기며 분당 한도 응답은 Retry-After를 포함한다. 이 제한은 일별 과금 예산이나 분산 전체 한도가 아니다.

### 파싱 후 보관 방식

| 저장 위치 | 내용 |
|---|---|
| `combination_review` / `combination_review_program` | 사용자가 편집 중인 최신 제목·사업·참여 상태·버전 |
| `combination_review_run.input_json` | 당시 입력·추가 진술·서울 기준 날짜 |
| `combination_review_run.evidence_json` | 문서 URL·파일명·형식·원본/텍스트 해시·파서 버전·수집 시각, 위치를 포함한 전체 텍스트 블록, 수집 한계 |
| `combination_review_run.configuration_json` | 호출 전 확인한 AI 계약·모델·프롬프트 버전. 성공 응답과 일치해야 저장 성공 |
| `combination_review_run.analysis_json` | 사업쌍별 여섯 단계의 판단·범위·설명·질문·인용 및 전체 한계 |
| `combination_review_run_source.raw_bytes` | 각 실행에서 다운로드한 원본 바이트(MEDIUMBLOB)와 SHA-256 |

인용 ID `E0`, `E1` 등은 **해당 Run 내부에서만 유일**하다. PDF 페이지/분할 위치 또는 HWPX section/문단 범위로 원문을 추적한다.
사업쌍의 firstProgramIndex/secondProgramIndex도 해당 Run의 input.programs 배열을 기준으로 한다. 현재 편집 중인 사업 순서로 해석하지 않는다.
원본 파일은 `/runs/{runId}/sources/{documentIndex}`에서 내려받으며 documentIndex는 응답 documents 배열의 0 기반 위치다.
다운로드 전 저장 바이트 해시를 다시 확인하고 attachment·no-store·nosniff 헤더를 사용한다.
텍스트는 전체를 위치가 있는 약 3,000 UTF-16 길이 이하 블록으로 나누며 서로게이트 쌍을 깨지 않는다.
키워드 검색으로 일부 조항만 보관하지 않는다. 이 경로는 기존 Qdrant 색인·top-5 검색과 연결하지 않았다.

수집·파싱이 모두 끝난 뒤 원문과 근거를 한 transaction에 저장한다. 중간 수집 실패에서는 부분 자료로 AI를 호출하지 않는다.
AI 실패가 발생해도 이미 확보한 원문·입력·확인된 설정은 해당 FAILED Run에 남는다. 설정 확인 전 실패하면 configuration은 null이다.
실패 Run의 configuration은 호출 전 확인값이며, 원격 실패 때문에 실제 사용 모델을 확정하지 못할 수 있다.

### 자동 수집의 정확한 범위

1. `BIZINFO:PBLN_<숫자>`는 식별자로 기업마당 공식 상세 페이지를 구성한다. `MSIT:<숫자>`와 `KSTARTUP:<숫자>`는 카탈로그의 공식 상세 URL과 공고 ID를 다시 검증한다. `CNTRADE_NOTICE:<숫자>`는 API 제목·본문으로 공식 게시판을 검색해 단 하나의 동일 상세만 채택한다. null이 아닌 subProgramId는 미지원이다.
2. 제공처의 공고 상세 영역이 직접 연결한 첨부를 추출한다. 기업마당에서 연결된 중기부 사업공고 페이지가 있으면 그 페이지의 첨부도 확인한다.
3. HTTPS·정확한 허용 호스트·경로·파일 쿼리만 사용한다. 첨부 다운로드 redirect는 거절하며 다른 호스트로 자동 추적하지 않는다.
4. PDF/HWP/HWPX를 읽는다. HWP5는 Apache Tika로 문단을 추출하고 암호화 문서는 거절한다. 기업마당 공고에서 같은 표제의 중기부 HWPX가 있으면 기업마당 변환본보다 우선하고 선택 사유를 기록한다.
5. 미지원 부속 자료는 coverageWarnings에 기록한다. 같은 공고에 읽을 수 있는 공식 문서가 하나 이상 있으면 크기 제한 초과·
   텍스트 추출 불가 첨부는 파일명과 제외 사유를 coverageWarnings에 남기고 계속한다. 공고 하나의 모든 지원 형식 첨부가
   제외되거나 수집 자체가 실패하면 정상 판단 대신 기술 오류다.

한 파일 최대 16 MiB, 공고당 기업마당 최대 4개·그 밖의 제공처 최대 8개 및 32 MiB, 실행당 원본 최대 12개,
PDF 80쪽, HWPX 256 ZIP 항목·압축 해제 합계 24 MiB,
문서당 120,000 UTF-16 길이·256블록, 전체 120,000 길이·512블록을 제한한다. 초과 내용을 잘라내지 않는다.
ZIP 내부 첨부 탐색·스캔 PDF OCR·암호화 문서는 미지원이다. 빈/이미지만 있는 PDF 페이지는 해당 파일을 제외하고 경고하며,
같은 공고에 분석 가능한 다른 공식 문서가 없으면 필요한 예외를 놓칠 수 있으므로 실행을 거절한다.
전체 텍스트란 추출 가능한 텍스트 영역을 뜻한다. 혼합 문서의 이미지 속 글자와 복잡한 표 관계의 완전성까지 보증하지 않으며 원본 대조가 필요하다.
HWPX XML의 외부 엔티티/DTD를 차단하고 압축 파일을 로컬 경로에 풀어 실행하지 않는다.

자동 수집 상태는 `AUTOMATIC_UNREVIEWED`다. 공식 출처라는 사실과 사람 검수·기관 해석 완료를 구분한다.
실행 근거 문서에는 검증한 공고 상세 `sourcePageUrl`과 수집 첨부 `sourceUrl`을 별도로 보존하며, 화면도 공고 페이지 열기와
세션 인증이 필요한 보관 원본 다운로드를 서로 다른 동작으로 제공한다. 과거 실행처럼 `sourcePageUrl`이 없는 근거는 다운로드만 제공한다.
연결되지 않은 타 기관 지침·협약·정산 규정과 정정 공고를 전수 확보하지 않는다. 미확보를 허용으로 해석하지 않도록 Agent에 전달한다.

### 분석과 오류 계약

AI는 모든 사업쌍의 신청·선정·확약·협약·수행·교부 여섯 단계를 반환한다. `PERMISSION_IN_SCOPE`는 좁은 명시 범위만 허용한다.
정확히 두 사업과 한 비교쌍만 받는 AI 내부 계약은 `combination-review-v2`다.
원문을 800자 이하의 인용 선택지로 나누고 AI는 번호만 선택하며, 코드가 근거 ID와 정확한 원문을 복원한다. 다른 사업쌍의
선택지나 범위 밖 번호, 기관 확인이 필요한 확정 판단, 누락/중복 사업쌍·단계는 저장 성공으로 바꾸지 않는다.
사용자 사실 부족·공식 근거 부족·규정 충돌은 정상 분석의 서로 다른 판단 상태다. 기술 실패는 analysis=null인 FAILED다.

| HTTP | code / 조건 |
|---|---|
| 400 | REQUEST_VALIDATION_FAILED: 입력·UUID·버전·커서 형식 오류 |
| 401 / 403 | 기존 세션 없음/만료/삭제 계정 또는 정지·Origin 제한 |
| 404 | COMBINATION_REVIEW_NOT_FOUND: 없는/타인 검토·실행·원본 |
| 409 | COMBINATION_REVIEW_REVISION_CONFLICT 또는 COMBINATION_REVIEW_RUN_CONFLICT |
| 422 | SOURCE_UNSUPPORTED 또는 SOURCE_TOO_LARGE |
| 429 | RUN_RATE_LIMITED 또는 RUN_CAPACITY_EXCEEDED |
| 503 | SOURCE_NOT_FOUND / SOURCE_UNAVAILABLE / SOURCE_INVALID / ANALYSIS_UNAVAILABLE / ANALYSIS_INVALID / RUN_FAILED |

Run을 예약한 뒤 실패하면 ProblemDetail에 runId를 포함한다. 예외 원문·개인 입력·원본 파일 내용은 오류 본문에 싣지 않는다.
AI 모델 `60s`·Agent 실행 `70s`·Core 전용 읽기 `75s`를 사용한다. AI 내부 timeout은 504
`COMBINATION_REVIEW_TIMEOUT`과 민감정보 없는 진단 로그로 구분하며, Core 실행 이력에는 기존 공개 계약인
`ANALYSIS_UNAVAILABLE`로 저장해 정상적인 근거 부족과 구분한다. AI가 503 `COMBINATION_REVIEW_FAILED`를 반환한
응답 계약·인용 검증 실패는 연결 장애와 구분해 `ANALYSIS_INVALID`로 저장한다.
같은 키로 실패 실행을 재조회해도 재시도하지 않는다. 새 키로 다시 실행할지는 호출자가 결과를 확인하고 결정한다.

### 비정상 종료 복구

프로세스 강제 종료·DB 단절로 상태 기록 자체가 실패하면 RUNNING이 남을 수 있다. 시간만 보고 실패로 간주하거나 자동 재실행하지 않는다.
운영자는 해당 환경의 실행 주체가 실제 종료되었음을 확인한 뒤 대상 run ID·runner_instance_id·현재 RUNNING 상태를 함께 대조한다.
그 조건에 일치한 행만 `status=INTERRUPTED`, `failure_code=RUNNER_TERMINATED`, 서울 기준 finished_at으로 갱신한다.
기존 입력·원문·설정은 보존하며 성공 행은 변경하지 않는다. 상태 변경으로 생성된 running_slot이 NULL이 되어 새 실행 예약이 가능해진다.
DB 관리자 도구에서 확인 후 수행하는 수동 복구이며 자동 스케줄러·관리자 복구 API는 아직 없다. OpenAI 측 계산의 취소까지 보장하지 않는다.
이번 개발 작업에서는 운영 DB의 복구·migration·배포를 실행하지 않았다.

## 13. 4-2~4-4 최종 검증 (2026-09-09)

기록 ID는 `automatic-source-contract-20260909-v1`이며 [기계 판독용 결과](../evaluation/combination-review/runs/automatic-source-contract-20260909-v1.json)에
소스 해시·환경·명령·범위와 한계를 보존했다. 최종 코드에 대해 아래를 실행했다.

| 검증 | 환경·명령 | 결과 |
|---|---|---|
| Core clean build·전체 테스트 | Linux Temurin 21.0.12, 실제 MySQL 8.4 Testcontainers, `bash ./gradlew clean build -PincludeLiveSources --no-daemon --max-workers=2` | **71개 스위트·718개 통과**, 실패·오류·건너뜀 0 |
| AI Service 전체 테스트 | Linux Python 3.11, uv 0.12.5, `uv run --locked --extra dev python -m pytest` | **725개 통과** |
| AI 패키지 | `uv build` | sdist·wheel 빌드 통과 |
| 4-1 원문·사례 무결성 | `validate_bundle.py` 및 해당 디렉터리 unittest | 무결성 통과, **16개 테스트 통과** |
| 실제 공식 수집 | 명시적으로 포함한 live-source 테스트 | 일반형 HWPX·딥테크 PDF 2개, 33블록·50,360자 |
| Core→AI HTTP→MySQL 무료 흐름 | 공식 사이트는 실제 수집, Agent는 ScriptedModel 고정 응답 | 저장·인용·원본 조회·재전송 통과. 모의 모델 1회, 유료 호출 0회 |
| CI 컨테이너 통합 스크립트의 로컬 실행 | 새 `skn59-step44-verify` 프로젝트, 외부 API는 모두 모의 서버 | 빌드·기동·MySQL 조회·검색·Qdrant/AI 장애 격리·복구 통과 |
| 최종 정적 확인 | package/경로·문서 링크·Git diff 검사 | 통과 |

Core의 실제 테스트 소스·빌드 설정 291개 파일, AI 소스·잠금 파일·테스트 73개 파일이 작업본과 SHA-256 기준으로 일치했다.
Core 수치에는 opt-in 공식 수집 및 무료 HTTP 흐름 테스트 2개가 포함된다. 원격 GitHub Actions를 실행한 기록은 아니다.
Windows에서는 CI 스크립트의 실행 위치·임시 응답 폴더만 고정한 개인 작업 사본을 사용하고 응답 파일을 보관했다.
검증 assertion과 Docker 정리 로직은 원본과 동일하며 저장소 CI/Compose 스크립트 자체는 수정하지 않았다.

개발 중 V7 초안의 FK/생성 컬럼 조합으로 실패한 실행은 통과 결과에 포함하지 않았다.
MySQL에서 `running_slot = CASE WHEN status='RUNNING' THEN 1 ELSE NULL END`와 `(review_id, running_slot)` 고유키로 검증했다.
AI 테스트 컨테이너의 저장소 경로 누락도 복원한 뒤 전체 실행을 완료했다. 기존 deprecated API·JVM class sharing 경고는 남아 있다.

실제 OpenAI 결과·18개 사례의 의미 정확도·기관 해석·사람 검수·신규 프런트 화면·운영 배포는 미검증이다.
테스트용 컨테이너·Compose 자원은 정리했고, 컴퓨터 재시작 후 종료된 기존 운영 스택과 데이터를 변경하지 않았다.
V6/V7은 분리된 테스트 DB에서만 적용했다. 이번 변경은 미커밋·미푸시 상태이며 이슈/PR 게시·병합을 하지 않았다.

## 14. Core 계층 경계 정리

기존 기능 중심 레이어드 구조에 맞춰 하위 경계에서 Service 타입을 참조하던 부분을 정리했다.

- 검토 없음·입력 버전·실행 예약 충돌은 `domain/exception`의 프레임워크 독립적인 업무 예외로 옮겼다.
  Repository는 원자적인 예약 조건을 검사하고, 공개 HTTP 상태는 기존 ApiExceptionHandler가 매핑한다.
- 입력 DTO의 변환 실패는 `controller/exception`이 소유한다.
- 원문 수집·디코딩 오류는 공용 `supportprogram/client/document/SupportProgramDocumentException`으로 표현한다.
  바이트 상한은 첨부 전송 계약에 두고 Client가 Service의 파서 상수를 참조하지 않게 했다.
- PDFBox/HWPX 처리는 신청 문서 발견도 함께 사용하는 `supportprogram/client/document/SupportProgramDocumentParser`가 담당한다.
- `AiCombinationReviewFacade`가 AI 설정/분석 호출·응답 검증을 감추고, `client/mapper/AiCombinationReviewMapper`가 요청/응답 변환을 맡는다.
  Facade의 공개 메서드는 내부 모델을 받고 반환하며 상위 Service·Repository를 호출하지 않는다.
- Run Service는 실행 예약·근거 묶음 구성·상태 저장과 하위 경계 실패의 공개 코드 변환을 담당한다.
  AI 경계 밖의 내부 오류를 AI 계약 위반으로 일괄 분류하지 않는다.

Repository interface·Protocol·범용 Base/Factory를 추가하지 않았다. 이는 프로젝트의 Core 분리 규칙을 적용한 것이며,
모든 외부 의존성을 Domain port로 역전한 엄격한 클린 아키텍처를 새로 도입한 작업은 아니다.
공개 요청/응답, 원문 파싱 버전, SQL과 migration, 입력·실행 이력 정책은 유지했다.

검증은 코드·구조·관련 테스트·문서 수정을 완료한 뒤 Core clean build 전체 테스트와 무료 서비스 간 HTTP 흐름으로 모아서 수행한다.
AI production 코드와 공개 서비스 간 계약은 변경하지 않았으므로 AI 전체 테스트를 다시 실행하는 대신 기존 AI Router·Service·Agent를 사용하는
고정 응답 HTTP 통합으로 연결을 확인한다. 유료 OpenAI 호출과 화면 구현은 이 구조 정리 범위에 포함하지 않는다.

2026-09-09 최종 검증은 Linux Temurin JDK 21·실제 MySQL 8.4 Testcontainers에서
`bash ./gradlew clean build -PincludeLiveSources --no-daemon --max-workers=2`로 한 번에 수행했다.
**72개 스위트·723개 통과**, 실패·오류·건너뜀 0이며 AI Facade 경계 검증 5개를 추가했다.
공식 원문 2개·33블록의 무료 Core→AI HTTP·저장·재전송 흐름도 통과했다. 해당 흐름의 ScriptedModel 호출은 1회, 유료 호출은 0회다.

하위 계층의 Service 참조와 이전 파서 경로가 없음을 확인했고, Kotlin 48개 파일의 package/경로 및 문서 상대 링크·`git diff --check`를 확인했다.
테스트 소스·빌드 설정 298개 파일은 작업본과 SHA-256이 일치했다. V6/V7 바이트는 이전 검증본과 같으며 SQL·migration을 바꾸지 않았다.
테스트 컨테이너는 정리했다. AI/Frontend 전체 테스트·원격 CI·운영 배포는 이번 내부 구조 변경 범위에서 다시 실행하지 않았다.


## 15. 사용자 화면 (5-1, 2026-09-09)

`/app/combination-reviews` 아래 목록·새 검토·상세 입력 수정·분석 실행·실행 이력 화면을 연결했다. 새 검토와 상세는
`제목·공고 선택 → 참여 상태 설정 → 공고 분석` 3단계로 나누며, 단계 이동 시 화면 상단으로 이동한다. 목록에서는 결과를 바로 열고 확인 후 검토를 삭제할 수 있다.
기존 RequireAuth·WorkspaceLayout·appPaths·Awilix DI·세션 쿠키를 재사용한다.
`View → ViewModel → CombinationReviewUseCase → Domain Repository 계약 → Data 구현 → HTTP/Zod → Core API`로 호출하며
공고 선택은 BrowseSavedSupportProgramsUseCase의 관심 공고함과 기존 BrowseSupportProgramsUseCase의 무료 카탈로그 조회를 함께 사용한다. 관심 공고는 버튼으로 연 팝업에서만 지연 조회하고 선택 요약은 고정 높이 한 줄로 유지해 선택 전후 레이아웃 이동을 막는다.

- 본인 검토와 실행 이력에 커서 더 보기를 제공한다. 로딩·빈 결과·오류·인증 만료를 구분한다.
- 실행 이력은 분석 화면 아래에 결과를 펼치지 않고 `/:reviewId/runs/:runId` 전용 화면으로 이동해 자동 표시한다. 결과 주소는 새로고침과 직접 접근을 지원하며, 같은 화면의 실행 선택 목록에서 다른 이력으로 전환할 수 있다.
- 제공처/공고 ID로 중복 선택을 막고 정확히 2개 사업을 저장한다. 선택한 검색 결과는 같은 자리에서 색과 버튼으로 확인·해제하며 UNKNOWN과 독립적인 수행 상태를 유지한다.
- expectedRevision으로 전체 입력을 수정하고 409에서도 편집을 보존한다. 최신 저장 입력 조회와 편집 폐기는 별도 버튼이다.
- 두 번째 단계의 `입력 저장 후 분석 시작` 버튼만 저장과 분석 POST를 연속 실행한다. 응답 유실 시 탭 sessionStorage에 보관한 같은 키·버전·추가 설명으로 수동 확인한다.
  조회·새로고침·로그인에서 POST하지 않는다. 버전 충돌로 예약이 거절된 요청만 사용자가 명시적으로 정리할 수 있다.
- 단계 이동에 성공하면 이전 단계의 검증 오류를 제거한다. 제공처·원본 ID는 사용자 화면에서 숨기고 실행별 추가 설명은 참여 상태 단계에서만 입력한다.
- 신청·선정·확약·협약·수행·교부 항목의 초록색 도움말 버튼은 마우스 hover와 키보드 focus에서 각 상태의 의미를 설명한다.
- 비동기 POST 접수와 저장된 QUEUED/RUNNING을 구분하며 시간 경과만으로 실패 처리하거나 새 실행을 만들지 않는다.
  422·429·503 및 runId가 있는 오류를 구분하고 실패 실행을 조회할 수 있다.
- Run 입력 스냅샷의 사업 순서·버전·추가 설명으로 결과를 표시한다. 신청·선정·확약·협약·수행·교부의
  판단 상태는 먼저 요약하고, 선택한 한 단계의 범위·질문·기관 확인·원문 위치·인용·다운로드만 펼쳐 제공한다.
  FAILED/INTERRUPTED는 정상 판단이 아니다.
- HTTP 응답에서 enum·참조·원문 인용과 요청의 reviewId/requestKey/입력 버전/추가 설명 일치를 검사한다.
- 로그아웃·계정 전환 시 미확인 요청 기록을 지우고 요청을 취소한다. 세션 참조 검사를 통해 늦은 결과 반영도 막는다.

### 실행한 검증과 한계

Windows Node 24.18.0에서 임시로 준비한 pnpm 11.22.0으로 실행했다. 저장소 의존성·잠금 파일은 변경하지 않았다.
모든 구현·테스트 코드를 준비한 뒤 검증을 시작했으며 실패·보완 이후 영향 범위만 다시 확인했다.

| 검증 | 명령·환경 | 실제 결과 |
|---|---|---|
| 최초 Frontend 전체 | `pnpm test` | 45개 파일·551개 통과 |
| 타입·상수 분리 수정 후 전체 재확인 | `pnpm test --maxWorkers=2 --reporter=json --outputFile=./node_modules/.tmp/skn59-tests.json` | 550개 통과·기존 App 검색 왕복 테스트 1개 일시 실패 |
| 실패 파일 및 신규 화면 재확인 | `pnpm test src/App.test.tsx src/presentation/features/combination-review/view/CombinationReviewPages.test.tsx --maxWorkers=1 --reporter=verbose` | 2개 파일·77개 통과. 실패했던 기존 테스트도 통과 |
| 최종 보완 영향 범위 | `pnpm test src/App.test.tsx src/presentation/features/combination-review/view/CombinationReviewPages.test.tsx src/data/api/__tests__/combinationReviewApi.test.ts --maxWorkers=1 --reporter=json --outputFile=./node_modules/.tmp/skn59-final-affected.json` | 3개 파일·93개 통과(기존 App 66, 신규 HTTP 15, 신규 화면 12), 실패·건너뜀 0 |
| 최종 Frontend 전체 | `pnpm test --maxWorkers=1 --testTimeout=15000 --reporter=json --outputFile=./node_modules/.tmp/skn59-final-all.json` | **45개 파일·553개 통과**, 실패·건너뜀 0 |
| 정적 검사 | `pnpm lint` | 통과, 경고 없음 |
| 최종 빌드 | `pnpm build` | 통과. JS 667.06 kB / gzip 191.43 kB, 500 kB 초과 경고 유지 |
| 실제 브라우저·모의 HTTP | 별도 localhost Vite 5175 + loopback mock API 4181 | 공고 선택·저장·중복 방지·접수 종료 표시, 결과/인용, 원본 GET, 409 입력 보존/최신 적용, 응답 유실/새로고침/같은 키 재전송, 422/429/503, RUNNING, 만료·로그아웃·계정 전환·늦은 결과 차단, 빈 목록 확인 |

최종 보완으로 테스트 2개를 추가했고 영향 범위 93개를 확인한 뒤, 최종 전체 553개도 통과했다.
최종 전체 실행은 동시 worker 1개·테스트별 제한 15초로 실행했으며 테스트 assertion이나 기존 검색 코드는 바꾸지 않았다.
`git diff --check`와 신규 소스 22개 파일의 공백 검사를 통과했다. 검증용 서버·브라우저 탭은 정리했다.
브라우저 검증은 `frontend/web/scripts/combination-review-mock.mjs`의 가상 응답만 사용했다. 원본 다운로드도 모의 바이트의
전송 경로 확인이며 공식 PDF 품질 검증이 아니다. 실제 Core/MySQL/AI 통합·유료 OpenAI·규정 해석 품질·사람 검수·원격 CI·배포는 미실행이다.
이번에는 Backend 코드·공개 API·migration을 수정하지 않았으므로 Core/AI 전체 테스트를 반복하지 않았다.
5-2 비로그인 선택 유지·로그인 복귀 확장·작업 이어보기와 신청서 작성 도우미는 구현하지 않았다. 변경은 미커밋·미푸시다.


## 16. 실제 저장 실패 진단과 응답 계약 수정 (2026-09-09)

실행 중인 로컬 Core의 `/api/v1/combination-reviews`는 일반 404를 반환했다. 실행 JAR에
combinationreview Controller가 없고 migration도 V1~V5만 들어 있었다. Frontend 소스 갱신과 달리
Core 실행 이미지에 신규 API가 반영되지 않은 상태이며, 기존 DB나 볼륨을 재생성할 사유는 아니다.
Core를 최신 코드로 재빌드·재시작하면 Flyway가 V10/V11을 반영한다. 분석에는 최신 AI Service도 필요하다.
이번에는 기존 실행 컨테이너를 교체하거나 DB migration을 적용하지 않았다.

별도로 실제 PUT 계약은 204인데 프런트와 모의 서버가 JSON 응답을 기대했던 오류를 수정했다.
Repository는 빈 성공 응답을 반환하고 ViewModel은 제출 입력·확정된 다음 버전을 유지한다.
다른 편집이 섞이지 않도록 자동 GET은 하지 않는다. 일반 404와 COMBINATION_REVIEW_NOT_FOUND를
구분하며 오류 영역에 포커스를 보내 긴 폼 아래에서 눌러도 실패 이유를 확인할 수 있게 했다.
이전 모의 응답이 실제 PUT 계약과 달라 자동 검증에서 해당 오류를 놓쳤음을 명시한다.

검증 환경은 Windows Node 24.18.0·pnpm 11.22.0이다.
`pnpm test --maxWorkers=1 --testTimeout=15000 --reporter=json --outputFile=./node_modules/.tmp/skn59-save-fix.json`,
`pnpm lint`, `pnpm build`를 실행했다. 새 검토 POST 201 이동·일반 404 입력 보존, 실제 PUT 204,
불필요한 GET/분석 미호출을 모의 HTTP 테스트로 확인했다. 실제 브라우저에서는 기존 서버의 404와
개선된 안내·기존 입력 복원을 확인했으며 실제 저장 성공은 Core 실행 이미지 갱신 전이라 미검증이다.
유료 OpenAI 호출·Backend 코드 수정·기존 DB 변경·배포는 하지 않았다.

최종 결과: 전체 45개 파일·559개 통과, 실패·건너뜀 0. 테스트 코드의 타입 옵션 수정 뒤
신규 화면 파일 16개도 재확인하여 통과했다. lint·build·git diff --check 통과,
JS 번들 667.54 kB(500 kB 초과 경고 유지)다. 변경은 미커밋·미푸시 상태다.
