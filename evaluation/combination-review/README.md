# 중복 지원·수혜 검토: 공식 근거와 검증 사례 초안

[기능 설계](../../docs/duplicate-support-review-design.md) · [검수표](REVIEW.md) · [문서 목록](../../docs/README.md)

**4-1 준비 결과다. 사람 검수·기관 해석 확인·LLM 평가를 완료한 자료가 아니다.**
`startup-jump-2026-v1`은 2026년 창업도약패키지 일반형·딥테크 특화형 공고를 고정한 작은 근거 묶음이다.
공식 모집공고 2종의 HWPX 원문 2개와 딥테크 PDF 대조본 1개, 인용 묶음 12개, AI 작성 가상 입력 사례 18개를 보관한다.
모든 프로그램의 `productionSupported`와 묶음의 `productionApproved`는 false다. 이 고정 검수 초안을 production 지원 목록으로 등록하지 않았다.
4-2~4-4의 runtime 자동 수집·분석은 별도 경로이며 아래 무료 통합 검증과 [현재 API 계약](../../docs/duplicate-support-review-design.md)을 참고한다.

## 원문과 식별자

| 구분 | 공식 게시처·원문 | 사용 범위 |
|---|---|---|
| 일반형 `G26` | [중기부 제2026-39호](https://mss.go.kr/site/smba/ex/bbs/View.do?bcIdx=1065016&cbIdx=310), 2026-01-23, [HWPX](data/startup-jump-2026-v1/sources/general.hwpx) | 인용의 바이트·XML 위치 기준 |
| 딥테크 `D26` | [중기부 제2026-672호](https://www.mss.go.kr/site/smba/ex/bbs/View.do?bcIdx=1064567&cbIdx=310), 2026-01-06, [HWPX](data/startup-jump-2026-v1/sources/deeptech.hwpx) | 인용의 바이트·XML 위치 기준. 공고번호는 원문 그대로 보존 |
| 딥테크 대조본 | [기업마당 공고](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000117172), [PDF](data/startup-jump-2026-v1/sources/deeptech.pdf) 24쪽 | 별도 규정 1건이 아니라 같은 공고의 시각 대조 자료 |
| 투자연계형 `I26_UNRESOLVED` | 별도 원문·공고 ID 미확보 | 다른 두 공고의 유형 안내·붙임 3에 등장하는 관계만 참고. 가상 공고 ID를 만들지 않음 |

일반형의 실제 기업마당 ID는 [PBLN_000000000117820](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000117820),
딥테크는 `PBLN_000000000117172`다. 서로 다른 공고이므로 같은 부모 ID의 가상 subProgramId로 만들지 않는다.
두 값 모두 `sourceCode=BIZINFO`, `subProgramId=null`로 기록했다. 이 기록은 production 지원 목록 등록이 아니다.
확보한 모집공고는 접수가 끝난 과거 자료이며 현재 신청 가능한 추천으로 표시하지 않는다.

`manifest.json`에 다운로드 URL, 게시일, 확보 시각, 원문 SHA-256·바이트 수·버전, 데이터 파일 해시를 기록했다.
원본 파일을 수정하지 않았다. 인용 기준은 **HWPX `Contents/section0.xml`의 1부터 시작하는 hp:p 순번**이다.
빈 문단·표를 감싸는 문단도 번호에 포함하고, 해당 문단의 직접 run 텍스트만 읽는다. 표 안 문단은 별도 위치다.
이는 시각적인 페이지 번호가 아니며 일반형의 PDF 페이지를 추정하지 않는다.

딥테크 PDF 1·6·9·10·12·13·18·19쪽을 렌더링해 문맥·각주·표를 AI가 시각 대조했다.
PDF의 겹친 글자 레이어 때문에 단순 텍스트 추출에서는 글자가 반복되어, 인용 문자열은 HWPX를 기준으로 고정했다.
일반형은 HWPX 텍스트·위치를 확인했으며 시각적인 페이지 검수와 사람 검수는 미실행이다.

## 근거 구성과 해석 범위

두 공고에 각각 아래 여섯 인용 묶음을 둔다. `G-`는 일반형, `D-`는 딥테크다.

| ID 접미사 | 내용 | 함께 읽을 근거 |
|---|---|---|
| `TYPES` | 세 유형 중복 신청 가능·1개 유형 수행 | CURRENT, COMMIT, PAST |
| `COMMIT` | 확약서 제출에 따른 타 사업 선정 절차 제외·최초 제출 사업의 협약·수행, 범위 각주 | CURRENT |
| `CURRENT` | 동일연도 사업의 동시수행/협약 제한, 이전 연도·지자체의 해당 조항상 신청 예외 | LIST, PAST |
| `LIST` | 붙임 3 중 창업도약패키지 세 유형 행 | 전체 타 사업 목록 검토로 확대하지 않음 |
| `PAST` | 누적 선정 후 협약 이력·과거 지원 사업 제한 | PAST-LISTS |
| `PAST-LISTS` | 붙임 2-1 횟수 산정 대상과 붙임 2-2 과거 제외 사업·예외 프로그램 | 해당 연도·세부사업과 “그 프로그램만” 참여했는지 확인 |

위 해석과 사례 기대 결과는 **AI 초안**이다. 인용이 원문과 일치하는 것과 규정 해석이 맞는 것은 별개다.
특히 다음을 구분한다.

- 신청·선정·확약·협약·수행·교부는 별도 사실이다. UNKNOWN을 NO로 바꾸거나 다음 단계를 추론하지 않는다.
- 이전 연도 사업에 관한 신청 예외만으로, 과거 창업도약패키지 사업화지원 협약 이력의 별도 제외 조항을 무시하지 않는다.
- 현재 공고의 지자체 사업 예외만으로 상대 지자체의 규정까지 허용된 것으로 판단하지 않는다.
- 최초 확약 철회·유형 전환·실제 선정 제외 처리 시점은 확보한 조항만으로 확정하지 않는다. 기관 해석은 미확인이다.
- 동일 비용 인정·교부·반환은 정산 지침·협약 등 추가 원문이 필요하다. 동시수행 제한만으로 반환액을 산정하지 않는다.
- 검색에서 못 찾은 공고·제한을 존재하지 않는 것으로 처리하지 않는다. 정정 공고 전수 조사나 전체 자격 심사를 완료한 자료가 아니다.

`relatedEvidenceIds`는 명시적으로 연결한 본문·각주·붙임의 누락을 검사하는 참조다.
자동 검사가 모든 관련 규정을 찾아 주거나 법적 우선순위를 정하는 규칙 엔진은 아니다.

## 사례와 검수 상태

[cases.json](data/startup-jump-2026-v1/cases.json)은 공식 원문을 참고한 가상 입력 15개, 근거 제거 1개,
인위적 상충 근거 1개, 기술 실패 1개로 구성한다. 실제 기업 참여 이력이나 사람이 확정한 정답은 없다.
`expected.executionStatus`는 **미래 실행에 기대하는 계약**이며 관측 결과가 아니다.
실제 실행 여부는 manifest의 `modelEvaluation.executed=false`로 구분한다.

CR15의 가상 문장은 해당 사례의 `syntheticContext` 안에만 있다. 공식 `evidence.json`에는 섞지 않았으며,
실제 공고에서 규정 충돌을 발견한 사례로 소개하면 안 된다. CR16은 원문 무결성 실패를 기술 오류로 구분하는 계약 초안이다.
API의 상태 코드·Agent 출력 스키마·모델 프롬프트는 아직 확정하지 않았다.

각 입력은 기존 참여 사실 여섯 필드를 사용하지만 `programId`, `additionalFacts`, `expected`는 **오프라인 검토용**이다.
현재 POST/PUT DTO에 그대로 보낼 수 없다. 시각·과거 이력·비용 관계·기관 확인 상태 등 후속 입력 요구를 설명하기 위한 자료다.

사람 검수 시 [REVIEW.md](REVIEW.md)의 원문·기대 판단·보류 항목을 확인하고 검수자·일시·근거 버전·수정 이유를 기록해야 한다.
현재 검수 수는 0이다. 이 초안의 검사 통과를 근거로 production 지원을 켜거나 유료 모델을 자동 호출하지 않는다.

## 무료 검증

저장소 루트에서 Python 3.10 이상으로 실행한다. 두 명령 모두 표준 라이브러리만 쓰며 API 키·Docker·DB가 필요 없다.

```bash
python -X utf8 -B evaluation/combination-review/validate_bundle.py
python -X utf8 -B -m unittest discover -s evaluation/combination-review -p 'test_*.py'
```

첫 명령은 원문/데이터 해시, 인용 문단의 정확한 문자열, ID·관련 근거 참조, 프로그램 식별자,
사례의 기본 입력·기대 상태·출처 구분을 검사한다. 누락·변조는 종료 코드 1로 실패한다.
결과의 `qualityScore`는 null, `modelExecuted`는 false다. 의미 정답률을 측정하지 않는다.
원문과 manifest를 함께 바꾸는 권한 있는 수정의 진실성을 해시만으로 보증하지 않으며, 그런 변경에는 새 버전·검수가 필요하다.

두 번째 명령은 실제 원문 바이트·인용·문단 위치 변조, 연결된 붙임 누락, 경로 이탈, 가상 공고 ID,
합성 자료 혼입, 기술 실패의 정상 판단 변환, 허위 검수/승인 표시 등의 거절을 검증한다.
`.gitattributes`로 원문과 JSON의 줄바꿈 자동 변환을 막았다.

2026-09-09 Windows의 Python 3.12.14에서 위 명령으로 **16개 테스트 통과**, 묶음 무결성 검사 통과를 확인했다.
원문·JSON의 Git text 변환 비활성화, 문서 상대 링크와 `git diff --check`도 확인했다.
3-2 검증 시 보관한 Core 소스·빌드 설정 264개 파일 해시와 대조해 이번 단계에서 변경되지 않았음을 확인했다.
이번 변경은 새 오프라인 평가 자료·도구·문서에 한정되어 Core/AI/Frontend 전체 테스트를 반복하지 않았다.
기존 `.github/workflows/ci.yml`에는 이 새 디렉터리의 검증 단계가 없으며, 이번에는 로컬에서 직접 실행했다.
이전 3-2의 Core 681개 통과를 이번 자료의 품질 평가 결과로 사용하지 않는다.

## 사람 검수·품질 평가에 남은 항목

1. 사람 검수 결과와 기관 확인이 필요한 해석을 구분하고, 확정할 지원 대상·근거 버전을 선택한다.
2. 구현된 Run의 입력·근거 버전·모델·프롬프트·계약 버전을 사용해 실제 평가 기록을 보존한다.
3. 현재 여섯 참여 사실에 없는 시각·과거 이력·관계·기관 확인 질문의 HTTP/Agent 계약을 구체화한다.
4. 구현된 단일 Agent의 실제 결과를 검수한다. Qdrant 검색·다중 Agent·규칙 fallback은 추가하지 않았다.
5. 유료 OpenAI 호출 전 **전송할 실제 근거·입력과 모델/호출 예산**을 별도로 확정한다. 현재 승인·실행된 유료 호출은 0회다.

## 자동 수집·서비스 연결의 무료 검증 (4-2~4-4)

다음 검증은 18개 사례의 의미 정확도를 평가한 것이 아니다. Core와 AI가 공유하는 최소 HTTP fixture에 고정 응답을 사용한다.
고정 원문 테스트 입력은 `backend/core-service/src/test/resources/combinationreview`에 보관한다.
원문 bytes는 4-1과 같으며 `contract-request.json`, `contract-response.json`은 가상 입력·고정 출력이다.
AI 테스트도 같은 파일을 읽어 생산자/소비자 계약을 확인한다.

일반형과 딥테크의 **실제 공식 사이트 다운로드·파싱만** 확인하려면 JDK 21에서 실행한다.

```bash
cd backend/core-service
./gradlew test -PincludeLiveSources --tests '*CombinationReviewLiveSourceTest' --no-daemon
```

확인한 원문은 일반형 HWPX 183,483 bytes와 딥테크 PDF 875,868 bytes이며, 각각 9블록·26,133자와 24블록·24,227자로 추출됐다.
전체 33블록·50,360자는 키워드로 줄인 근거가 아니다. 원문 SHA-256은 각각 아래와 같다.

- 일반형: `369ba0cdeed37e743ba54aa02169496fcac914bc3ff12f3420ac2f4ad5c4fbef`
- 딥테크: `b478d846bba479aad380e3310e427ea8b91697c9e5e5faec97b94af513ff4f79`

실제 Core → AI HTTP → MySQL까지 확인할 때는 먼저 저장소 루트에서 테스트 전용 서버를 시작한다.
이 서버는 OpenAI 클라이언트를 만들지 않고 실제 Router·Service·Agent에 LangChain RunnableLambda 고정 응답 한 개만 제공한다.
fixture의 인용문을 실제 요청의 인용 선택지에 대응시키며, 일치하는 원문이 없으면 실패한다.
고정 fixture는 모델 평가 기록이 아니므로 응답의 `promptVersion`은 AI 단위 테스트와 동일하게 현재 Service 설정을 사용한다.
LangChain ChatOpenAI의 Responses API 전송·파싱은 AI Service의 `tests/combination_review/test_review.py`에서 HTTP 모의 응답으로 별도 검증한다.
production 앱에 테스트 모드나 fallback을 추가한 것이 아니며 서버를 재사용하면 호출 수 검증이 실패하므로 매 검증마다 새로 시작한다.

```bash
uv run --project backend/ai-service --locked --extra dev python \
  evaluation/combination-review/serve_contract_agent.py \
  --fixture backend/core-service/src/test/resources/combinationreview/contract-response.json

# 별도 터미널, JDK 21 + Docker(MySQL Testcontainers)
cd backend/core-service
GOVBIZ_TEST_AI_URL=http://127.0.0.1:18042 ./gradlew test -PincludeLiveSources \
  --tests '*CombinationReviewLiveFlowIntegrationTest' --no-daemon
```

Core를 컨테이너에서 실행하면 `GOVBIZ_TEST_AI_URL`은 그 컨테이너가 접근 가능한 테스트 서버 주소여야 한다.
실제 AI 서비스를 잘못 가리키지 않도록 `__test__/calls`의 고정 응답 호출 수를 먼저 확인한다.
별도 무료 흐름에서 공고 2개·원문 2개·블록 33개를 저장했고, 재전송을 포함한 ScriptedModel 호출은 1회·유료 호출은 0회였다.
원문 수집·세션 API·MyBatis/MySQL·AI HTTP·인용 계약을 검증한 결과이며 실제 OpenAI 판단이나 사람 검토 정답률이 아니다.

이 두 테스트는 `live-source` 태그로 기본 Core/CI 실행에서 제외한다. `includeLiveSources`로 명시한 경우에만 공식 사이트에 접근한다.
최종 전체 검증에는 해당 태그를 포함해 별도 테스트 서버와 함께 실행하며, 검증 결과는 기능 설계 문서에 기록한다.

최종 기록 [automatic-source-contract-20260909-v1](runs/automatic-source-contract-20260909-v1.json):
Core 71개 스위트·718개 통과(실패·오류·건너뜀 0), AI 725개 통과, AI 패키지 빌드 및 로컬 CI 컨테이너 통합 검증 통과.
이는 구현·계약 검증이며 `qualityScore=null`, 실제 OpenAI 호출 0회·사람 검수 0건이다.
