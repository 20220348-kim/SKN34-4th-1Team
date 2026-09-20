# 공고별 RAG 검수와 고정 근거 답변 평가

[문서 목록](../../docs/README.md) · [구현 현황](../../docs/implementation-status.md)

현재 실행기는 production의 LangChain Agent를 사용합니다. 고정 HTTP 응답으로 실행 경로와 계약을
검증하며, 이 전환으로 새 유료 평가나 의미 품질 측정을 수행한 것은 아닙니다. `runs/`의 과거 코드·
캡처·보고서는 당시 구현과 설정에 대한 기록으로 유지합니다.

## 현재 검증 범위

기존 기업마당 HTML RAG를 검수하고, 고정 근거 답변 평가와 실제 공개 공고의 전체 경로 검증을 분리합니다.
[이전 부분 평가](runs/README.md)와 [2026-09-07 후속 검증](runs/official-flow-20260907-v1/README.md)에
실행 원본·실패·AI 의미 검토·표본 한계를 보존합니다. 첨부파일·PDF/OCR은 이번 범위가 아닙니다.
최신 [대상 조건 요약 보완 검증](runs/official-flow-20260907-v2/README.md)에서는 추가 20회로 가상 6건·공식 6건을
확인했고, 공식 H01의 누락 보완과 기존 사례의 비회귀를 단회 AI-only 평가에서 관찰했습니다.

E12 추가 실행에서 모델이 64자리 인용 ID를 63자리로 복사한 오류를 확인했습니다. 이제 모델은 전달받은
청크의 짧은 배열 번호만 선택하고, Agent가 원래 ID를 복원합니다. 공개 API의 `citationChunkIds` 계약은
변경하지 않았으며 잘못된 번호·중복·근거 부족 상태의 인용은 계속 거부합니다.

| 구분 | 확인한 내용 | 아직 확인하지 않은 내용 |
|---|---|---|
| 기존 코드 검수 | 공식 URL·공고 식별자·리다이렉트·HTML 추출, 캐시·본문 해시, 현재 청크만 검색/인용, UI 오류·취소 처리 | 모든 실제 기업마당 HTML 변형에서의 수집 성공 |
| Core 회귀 테스트 | 원문 갱신 실패 시 후속 호출 차단, 잘못된 검색·인용 응답 거부, 검색된 최대 5개만 답변에 전달 | 모델 답변의 의미 정확성 |
| AI 기존 테스트 | 출력 계약, Agent 요청 설정·시간 제한, 근거 청크 검색/색인 | 다양한 실데이터에서의 모델 품질 |
| 고정 근거 답변 평가 | 질문·근거·기대 상태/인용 고정, 기록 재계산, 호출 안전장치, 계약 실패 진단 | 전체 원문 수집·DB·벡터 검색 경로 |
| 공식 HTML 전체 경로 | 고정한 공식 HTML → Core 공개 HTTP → 실제 MySQL·Qdrant → 실제 임베딩·답변 → 인용, API 없는 기록 검증 | 모든 공고의 HTML 변형·다수 청크 검색 품질·운영 부하 |

이전 E01 실패는 당시 생성 텍스트가 저장되지 않아 원인을 확정할 수 없습니다. 이번 E12의 확인 가능한
오류와 구별합니다. Core 전체 344개는 기존 통합 검증에서, AI 전체 207개는 최신 프롬프트 수정 후 통과했습니다.
최신 평가 도구·기록 검증 테스트는 118개 통과했습니다.
테스트 통과를 무결함이나 운영 품질 보장으로 해석하지 않습니다.

관련 테스트: [Facade](../../backend/core-service/src/test/kotlin/ai/govbiz/core/supportprogram/facade/AiSupportProgramEvidenceFacadeTest.kt),
[Service](../../backend/core-service/src/test/kotlin/ai/govbiz/core/supportprogram/service/evidence/SupportProgramEvidenceServiceTest.kt),
[AI 근거 기능](../../backend/ai-service/tests/support_program_evidence), [평가 도구](test_evaluate.py).

## 대상 조건 요약 보완 — 실제 모델 검증 완료

이전 공식 H01에서 빠진 ‘중소·중견 제조기업’ 범위는 저장 원문·색인 청크·AI 답변 요청에 모두 있었습니다.
실제 OpenAI 출력에서 처음 빠졌으므로 검색·청킹을 바꾸지 않고 답변 프롬프트만 보완했습니다.

- 질문과 관련된 명시적 대상 범위·필수 자격·제외·예외를 간결함 때문에 생략하지 않도록 지시
- 필수·우대·선택 조건과 원문 AND/OR 관계 유지, 없는 제한이나 불분명한 신청 가능성은 확정 금지
- 조건이 여러 청크에 나뉘면 각각을 뒷받침하는 청크를 함께 인용
- 모델·호출 수·HTTP 계약·인용 ID 복원·오류 처리·production 의존성은 변경하지 않음

[target-coverage-fixture.json](target-coverage-fixture.json)은 **추가 가상 공고 3건·고정 청크 9개·질문 6개**입니다.
기존 `fixture.json`, 공식 자료와 H01의 부분 일치 기록은 바꾸지 않았습니다. 새 참조는 AI 작성 자료이며
이미 관측한 실패를 바탕으로 만든 회귀용 자료입니다. 숨겨 둔 평가 자료나 사람 검토 정답이 아닙니다.
청크 번호와 원문 구절을 붙인 참조는 출처 확인을 위한 것이며 답변의 단어 포함 여부로 의미 정답을 채점하지 않습니다.

```bash
# API 키·서버 없이 새 입력 검증. 지표는 null이며 품질 평가가 아님
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/evaluate.py \
  --fixture evaluation/support-program-evidence/target-coverage-fixture.json

# 명시적으로 유료 평가를 선택한 경우에만 실행: 답변 최대 6회, 임베딩 없음
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/evaluate.py \
  --fixture evaluation/support-program-evidence/target-coverage-fixture.json \
  --execute --output-dir work/evidence-target-coverage-v1
```

**승인된 추가 20회로 실제 검증을 완료했습니다.** 가상 6건·공식 6건 모두 기대 상태가 일치했고, 원문 대조
AI 의미 검토도 일치로 판단했습니다. H01은 기존에 빠진 ‘중소·중견 제조기업’ 범위를 보존했습니다.
공식 전후 비교는 질문·원문·Core→AI 요청을 동일하게 유지했으며, 기존 나머지 5건의 새 오류는 발견하지 못했습니다.
단위 테스트와 실제 모델 의미 검토는 별개이며, 단회 결과를 일반 정확도나 통계적 개선으로 주장하지 않습니다.
프롬프트가 달라진 결과를 과거 실행과 섞어 단일 정확도로 계산하지 않습니다.

프롬프트 수정 후 AI Service 전체 207개, 새 공유 결과 추가 후 평가 도구 전체 118개와 `git diff --check`가
통과했습니다. 공식 라이브 통합 테스트도 공개 HTTP 질문 6건을 완료했습니다.
Core·DB·Frontend 코드는 변경하지 않아 이번에는 해당 전체 회귀 테스트를 재실행하지 않았습니다.

- 변경 전 프롬프트: 커밋 `88aa61f`, SHA-256 `588a36e7afe2b3e8b8d5467b24397edbb40ed045f6a7b77bdeec8c55ada0cde1`
- 변경 후 프롬프트 SHA-256: `560ad134d3ce657561e6dfa67793078c7526c5b5f1ebb691e6e972b27924655c`
- 추가 fixture SHA-256: `7cc1224e143f772e80713f267ed9b3b6d0262cabe75383b64f3e6b77ad496f8b`

새 질문의 답변 6회와 공식 전체 경로 14회(답변 6 + 임베딩 8), 합계 20회를 사용했고 재시도는 없었습니다.
사용량·의미 판정·전후 차이와 API 없는 재계산 명령은 [검증 보고서](runs/official-flow-20260907-v2/README.md)에 있습니다.
기존 캡처는 덮지 않았으며, 이번 검증이 끝난 뒤 평가용 서버와 임시 Qdrant를 종료했습니다.

관측 오류에 맞춘 명확한 지침과 별도 실제 모델 평가를 사용하는 방식은
[공식 OpenAI 프롬프트 안내](https://developers.openai.com/api/docs/guides/prompt-engineering)와
[평가 안내](https://developers.openai.com/api/docs/guides/evaluation-best-practices)를 참고했습니다.

## 자료와 해석 범위

평가 JSON은 UTF-8·LF로 기록하고 UTF-8로 읽습니다. `.gitattributes`는 해시 대상 fixture·실행 기록의
자동 줄바꿈 변환을 막으며, Core의 공식 HTML/manifest 표본도 원본 바이트로 보존합니다.
Windows 체크아웃에서도 같은 원본을 재검증하기 위한 규칙이며 기존 캡처의 해시나 측정 결과를 바꾸지 않습니다.
관련 검수 결과는 [추가 프로젝트 검수](../../docs/project-review-20260907.md)에 기록합니다.

[fixture.json](fixture.json)은 **AI가 작성한 가상 공고 3개·10개 청크·12개 질문**입니다.
실제 기업마당 공고나 사람 검토 정답으로 소개하면 안 됩니다.

- 신청 대상 2개, 제출 서류 3개, 없는 정보 3개, 다른 공고 정보 혼입 2개, 지시문 공격 2개
- 기대 상태: `ANSWERED` 7개 / `INSUFFICIENT_EVIDENCE` 5개
- 별첨에만 서류가 있고 별첨 본문은 없는 경우, 미기재 금액·기간을 지어내면 안 되는 경우 포함
- 지시문 공격은 기초적인 사례이며 광범위한 공격 내성 평가가 아님

각 질문에는 선택한 공고의 고정 청크만 전달합니다. 다른 공고 혼입 사례는 질문에 섞인 다른 공고의 정보를
선택한 공고의 조건으로 받아들이는지 확인합니다. 검색기가 다른 공고를 반환하는 상황은 이 도구의 평가 대상이 아닙니다.
`referenceFacts`·`forbiddenClaims`는 답변의 의미를 검토할 때 쓰는 참조입니다. 단어가 등장하는지만으로
정오를 채점하면 부정문과 긍정문을 혼동하므로 자동 문자열 점수에 사용하지 않습니다.

| 출력 | 뜻과 제한 |
|---|---|
| `measured` / `completed` | 모델 실행 기록 유무 / 선택한 사례 모두 오류 없이 응답했는지. 품질 합격 여부가 아님 |
| `caseCount` / `fixtureCaseCount` | 이번 선택 사례 수 / 전체 고정 질문 수. 일부 질문만 실행한 결과를 전체로 오인하지 않도록 분리 |
| `statusAccuracy` | 기대 `ANSWERED`·`INSUFFICIENT_EVIDENCE` 상태 일치 비율 |
| `referenceCitationRecall` | 답변 가능한 질문에서 기대 청크를 인용에 포함한 비율의 평균. 불필요한 인용을 벌점주지 않으므로 전체 청크를 인용해도 1.0일 수 있음 |
| `semanticFaithfulness` | 항상 `null`. 위 두 지표가 높아도 답변 내용의 사실성은 입증되지 않음 |
| `semanticReviewRequired` | 의미 검토가 별도로 필요함. 사람 검토를 강제하는 필드가 아님 |

구조 검증과 의미 평가를 구분하고 일반·경계·공격 사례를 고정하는 방식은
[OpenAI의 평가 안내](https://developers.openai.com/api/docs/guides/evaluation-best-practices)를 참고했습니다.
이번 참조는 AI 작성 가상 자료이고 별도 사람 검증이 없어 실제 공고의 일반화 성능을 주장할 수 없습니다.

## 실행 방법

저장소 루트에서 실행합니다. AI Service 의존성을 먼저 설치해야 합니다
([설치 안내](../../backend/ai-service/README.md)). 서버·MySQL·Qdrant·Excel은 필요 없습니다.

```bash
# 입력 검증만: API 키 불필요, 파일 쓰기 없음, 품질 지표는 null
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/evaluate.py

# 테스트: 실제 Agent/SDK 경로도 HTTP 스텁으로만 검증하며 외부 호출 없음
backend/ai-service/.venv/bin/python -m pytest evaluation/support-program-evidence
```

실제 모델 평가를 선택한 경우에만 아래 명령을 실행합니다. `OPENAI_API_KEY`는 기존 보안 환경변수 주입
방식으로 설정하며, 이 도구는 `.env`를 자동으로 읽지 않습니다. 키를 명령행 인자로 넣지 마세요.

```bash
# 유료: 최대 12회 답변 생성. 기존 폴더가 아닌 새 경로를 지정
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/evaluate.py \
  --execute --output-dir work/evidence-evaluation-v1

# 저장된 결과 재계산: API 호출 없음
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/evaluate.py \
  --capture work/evidence-evaluation-v1/capture.json
```

- OpenAI 공식 API에만 전송하며 기본 모델·타임아웃과 기존 답변 Service·Agent를 사용합니다.
- 순차 실행, SDK 재시도 0회, 질문당 Agent 1턴, 첫 오류 즉시 중단입니다. 임베딩 호출은 없습니다.
- `--case-id E01`로 특정 사례만 진단할 수 있습니다. 여러 사례는 fixture 순서대로 옵션을 반복합니다.
  이미 호출한 실패 사례도 비용·실패 집계에서 제외하지 마세요.
- 모델은 현재 AI Service 기본값을 사용합니다. 실제 값·프롬프트/도구/fixture/요청 해시를 캡처에 기록합니다.
- 매 질문 후 `capture.json`을 저장하며 오류 메시지 원문·키·인증 헤더는 저장하지 않습니다.
  계약 실패 진단용 생성 답변 텍스트(`outputTexts`)와 하위 예외 종류(`causeType`)는 기록합니다.
  API 응답에서 제공한 토큰 사용량과 질문별 지연을 기록하며, 사용량 미제공은 0이 아니라 `null`입니다.
  임시 파일을 끝까지 쓴 후 교체하므로 쓰기·교체 실패가 이전 캡처를 잘라내지 않습니다. 저장 실패가 발생해도
  API 클라이언트는 종료합니다. 남은 `capture.partial.json`은 미완성 기록일 수 있으므로 평가 입력으로 사용하지 마세요.
- 끝나면 `report.json`을 저장합니다. 미완료 실행은 종료 코드 1이며 부분 결과로 전체 점수를 내지 않습니다.
- 재계산 시 fixture·요청 해시·질문 순서·인용·완료 여부를 검사합니다. 해시는 파일 일치를 확인하는 것이며,
  캡처가 실제 API에서 생성됐음을 암호학적으로 증명하지는 않습니다.
- `work/`는 기존 임시 출력 제외 경로입니다. 도구·질문·참조·문서는 모두 Git 공유 대상입니다.
  실제 실행 기록을 팀에 공유할 때는 민감정보를 확인한 뒤 별도 버전 폴더에 보존해야 합니다.

## 공식 HTML 전체 경로 재실행

[Core 통합 테스트](../../backend/core-service/src/test/kotlin/ai/govbiz/core/supportprogram/service/evidence/SupportProgramEvidenceIntegrationTest.kt)는
기본적으로 실제 MySQL 8.4와 고정 HTML·AI HTTP 스텁을 사용하므로 OpenAI 비용이 없습니다.
공식 HTML의 제목·본문 조각과 출처·원본/조각 해시는
[테스트 자료](../../backend/core-service/src/test/resources/support-program-evidence/official-sources.json)에 보관합니다.
이 테스트는 운영 DB가 아닌 Testcontainers DB만 사용합니다.

유료 모델 연결을 선택할 때만 아래처럼 실행합니다. 먼저 Docker로 **비어 있는 별도 Qdrant**를 준비하고,
API 키는 보안 환경변수로 주입합니다. `serve_flow.py`는 별도 production 서버가 아니라 기존 AI 앱을
호출 한도·기록 장치로 감싼 로컬 평가 실행기입니다. 동기화·랭킹 endpoint는 허용하지 않습니다.

```bash
# 저장소 루트: 평가 전용 빈 Qdrant. 운영 볼륨은 연결하지 않음
docker run --detach --rm --name govbiz-rag-evaluation \
  --publish 127.0.0.1:17333:6333 qdrant/qdrant:v1.17.1

# 저장소 루트, 터미널 1: API 비용 발생 가능. 출력은 매번 새 경로
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/serve_flow.py \
  --execute --port 18009 --qdrant-url http://127.0.0.1:17333 \
  --max-api-calls 14 --output-dir work/evidence-flow-v2/api

# 터미널 2: JDK 21·Docker 환경에서 실행. capture 경로는 실제 절대 경로로 지정
cd backend/core-service
GOVBIZ_EVIDENCE_FLOW_AI_URL=http://127.0.0.1:18009 \
GOVBIZ_EVIDENCE_FLOW_CAPTURE_DIR=/absolute/path/to/work/evidence-flow-v2/core \
./gradlew test \
  --tests '*SupportProgramEvidenceIntegrationTest.runsSixFixedOfficialQuestionsThroughThePublicHttpApi' \
  --rerun-tasks --no-daemon
```

빈 Qdrant 기준 공고 임베딩 2회·질문 임베딩 6회·답변 6회, 최대 14회가 예상됩니다. 이미 벡터가 있는
Qdrant를 사용하면 호출 조건이 달라지므로 같은 조건 비교가 아닙니다. SDK 재시도는 없고 첫 오류에서
중단합니다. 예산은 서버에만 적용되므로 다른 평가 실행의 호출도 합산해야 합니다.
평가 서버 내부의 예기치 않은 예외도 중단 상태로 기록하고 이후 요청을 거부하며, 최초 요청의 HTTP 500을
정상 응답으로 바꾸지 않습니다.
`--rerun-tasks`는 이전 Gradle 결과 재사용을 막습니다. 라이브 환경변수를 켠 채 전체 테스트를 실행하지 마세요.
실행 후 서버를 종료하고 평가용 Qdrant만 정리합니다.
위 예제에서 직접 만든 컨테이너라면 `docker stop govbiz-rag-evaluation`으로 종료합니다.
`--rm`이므로 임시 벡터는 제거되지만 별도 출력 경로의 캡처 파일은 유지됩니다.

공유 결과는 API 없이 다시 검사할 수 있습니다.

```bash
backend/ai-service/.venv/bin/python evaluation/support-program-evidence/verify_flow.py \
  --run-dir evaluation/support-program-evidence/runs/official-flow-20260907-v1
```

원문 HTTPS 다운로드 자체는 별도로 확인했고, 반복 가능한 전체 흐름에서는 그때 받은 HTML 조각을
공식 URL의 HTTP 응답으로 재생합니다. 따라서 최신 공식 사이트를 실시간으로 다시 수집한 평가와는 다릅니다.
이 평가의 Core→AI 읽기 제한은 60초이므로 production 제한·지연 검증으로 사용하지 않습니다.

## 실제 호출 흐름과 해석

기존 사용자 기능은 **HTTP API → Service → 원문 수집/Repository → AI Facade → AI HTTP API → Service → Agent → OpenAI → Response**입니다.
그 과정에서 근거 청크를 별도 Qdrant 컬렉션에 색인·검색하며 Core가 최종 인용문을 원래 청크에서 구성합니다.
자세한 내용은 [기존 호출 흐름](../../docs/architecture.md)을 따릅니다.

이 평가 도구는 **고정 fixture → 기존 AI 답변 Service → Agent → OpenAI → 캡처/보고서**입니다.
HTTP API·원문 수집·DB·청킹·임베딩·Qdrant를 생략하므로 `scope=fixed-answer-context-only`로 기록합니다.

전체 흐름은 `scope=core-http-mysql-frozen-html-ai-evidence-flow`로 별도 기록합니다.
`completed`는 실행·계약 검증의 완료이며 모델 의미의 정답 판정은 아닙니다. 상태 일치·인용 무결성과
답변 의미 검토를 구분하고, AI-only 검토를 사람 검토로 소개하지 않습니다. 현재 공식 자료는 공고당
청크 1개뿐이므로 이 결과로 다수 청크 중 검색 성능이나 일반적인 RAG 정확도를 주장하지 않습니다.

첨부파일·PDF/OCR 확장과 새로운 제공처 추가는 이번 검수에 포함하지 않습니다.
