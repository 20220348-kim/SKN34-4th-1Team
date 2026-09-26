# 서초구 HWPX Mapping Agent 비교 평가

상태: `COMPLETED_RUN_C` (2026-09-25). 사용자가 공식 빈 HWPX의 구조 정보와 문서
메타데이터 전송 및 `gpt-5.6-luna` 유료 호출 2회를 승인했다. 공식 URL에서 받은 원본의
SHA-256을 확인한 뒤 Run A/B를 각각 1회 실행했다. 이전 2026-09-23 시도는 모델 호출 전
승인 검토에서 중단됐으며 당시 호출 수는 0회였다.

## 실제 2회 결과

| 지표 | Run A: production context | Run B: 동일 근거의 구조화 context |
|---|---:|---:|
| OpenAI 호출 | 1 | 1 |
| Correct / 10 | 8 | 8 |
| Wrong / 10 | 2 | 2 |
| Unmapped / Ambiguous | 0 / 0 | 0 / 0 |
| Wrong Target Rate | 20% | 20% |
| production `validate_mapping` | PASS | PASS |

두 Run의 오답은 동일하다. `applicant:representative-name`은 Ground Truth
`t1.r1.c2.p2` 대신 `t1.r1.c2.p1`, `applicant:phone-email`은 `t1.r1.c8.p2` 대신
`t1.r1.c8.p1`을 선택했다. 각 셀의 `.p1`은 빈 문단이고 `.p2`에는 괄호형 입력 서식이
있다. 둘 다 파서상 editable이고 같은 `fieldLabels`를 갖는다. 이는 관찰된 구조 차이이며
모델 선택 원인이 입증된 것은 아니다. validator PASS는 계약상 허용 여부이지 사람이 검토한
정답과의 일치를 뜻하지 않는다.

Run B는 Correct를 늘리지 않았고 Wrong Target Rate도 낮추지 않았다. 우선 기준인 오답률
개선 근거가 없으므로 이 결과만으로 구조화 context를 production에 반영하지 않는다. 한 문서의
10개 필드에 대한 1차 결과이며 모델 반복 실행의 재현성이나 다른 신청서로의 일반화는 검증하지
않았다. 추가 유료 호출은 실행하지 않았다. 상세 응답 채점은 `run-a.json`, `run-b.json`,
`comparison.json`에 기록했다.

## 2026-09-25 같은 셀 다문단 후보 후속 검증

두 오답의 native 근거를 읽기 전용으로 대조했다. `t1.r1.c2`와 `t1.r1.c8`은 모두 Hangeul
`inspect_editable_regions`에서 `paragraph_count=2`이고 두 자식이 editable이다. 부모 셀의
`get_table_map` 텍스트는 각각 `(             )`, `(                    )`이다.
`analyze_form`은 두 셀에 필드를 반환하지 않아 `formFields`, `insert_after`, `capacity_hint`로
자식 문단을 판정할 수 없다. 두 자식은 부모에서 받은 같은 `fieldLabels`·`rowLabels`·표 좌표를
갖는다. 원본 XML에서 `.p1`은 텍스트가 없는 `<hp:run charPrIDRef="33"/>`이고, `.p2`는
공백 괄호를 담은 `<hp:t>`가 있는 문단이다. 두 문단의 `paraPrIDRef`와 `charPrIDRef`는 같지만
line segment의 세로 위치는 0과 1920으로 다르다. 이 문서에서 `.p1`은 빈 상단 문단,
`.p2`는 인쇄된 입력 서식 문단이라는 근거다. 현재 코드의 판정은 문단 순번이나 특정 라벨에
의존하지 않는다. 두 셀의 전체 `nativeLocator`, 형제 문단, MCP inspect·table map·form 응답과
원본 XML 문단은 `same-cell-native-evidence.json`에 보존했다.

세 방식을 비교했다. Logical Candidate를 새로 만들고 leaf를 나중에 해석하는 Candidate Collapse는
이 사례에서 유일한 인쇄 서식 문단을 이미 식별할 수 있어 불필요한 계약·resolver가 된다.
Candidate Ranking은 빈 `.p1`을 유효 후보로 남겨 기존 오답을 계속 허용한다. 따라서 라벨이
있는 셀의 본문 전체가 유일한 공백 괄호 서식이고 나머지 형제 문단이 모두 빈 경우에만
**Binding Eligibility**로 빈 형제를 제외했다. `formFields`가 있거나 입력 서식이 유일하지
않으면 제외하지 않는다. 기존 native ID·parent 주소·editable 및 WritePlan의 native leaf 계약은
유지한다.

무료 로컬 Ground Truth 재평가(`local-candidate-followup.json`):

| 지표 | 변경 전 | 변경 후 |
|---|---:|---:|
| Exact 후보 1개 | 2/10 | 3/10 |
| Ambiguous | 8/10 | 7/10 |
| Expected candidate coverage | 10/10 | 10/10 |
| Wrong / Unmapped | 0 / 0 | 0 / 0 |
| 대표자성명 후보 | 26 | 25 |
| 전화번호(이메일 주소) 후보 | 2 | 1 |

후보에서 제거된 주소는 두 오답의 `.p1`뿐이다. 나머지 8개 field의 후보 집합은 그대로이고
새 후보는 없다. 대표자성명은 같은 셀 안에서는 `.p2`만 남았지만 다른 표의 같은 라벨 후보가
있으므로 문서 전체에서는 여전히 ambiguous다. 전화번호는 문서 전체에서도 `.p2` 하나가 남았다.
실제 native 쓰기 6건은 모두 통과했고 원본 SHA-256은 유지됐다. 추가로 공식 일반형 1,921
targets와 딥테크 1,646 targets를 검사했으며 이 규칙으로 제외된 자식 문단은 각각 0건,
native target ID 중복도 0건이었다. `tests/test_document_mcp_contract.py`와
`tests/application_preparation`의 로컬 회귀 210개가 통과했다. 첫 테스트 시도의 5개 setup
오류는 기존 pytest 임시 디렉터리 접근 권한 문제였고, 새 임시 경로에서 전부 통과했다.
Core의 `ApplicationDocumentMappingServiceTest`도 JDK 21에서 통과했다. 첫 Gradle 실행은
Windows loopback 연결 오류로 테스트 전에 중단됐고, 검증 JVM에만 존재하지 않는
`jdk.net.unixdomain.tmpdir`을 지정해 재실행했다. 원격 CI는 실행하지 않았다.

### 구조 개선 후 실제 Run C

사용자가 동일한 공식 빈 문서·10개 field의 현재 production Mapping context 단일 유료 호출을
추가 승인했다. 정답 ID가 없는 `blind-seocho-2026-v1.json`만 모델 입력 준비에 사용했고,
Ground Truth와 Run A 결과는 모델 응답을 받은 뒤 열었다. `gpt-5.6-luna`, 자동 재시도 0,
실제 호출 1회였다. Run A/B의 2회와 합쳐 이 평가 기록의 완료된 OpenAI 호출은 총 3회다.

| 지표 | 개선 전 Run A | 개선 후 Run C |
|---|---:|---:|
| Correct / 10 | 8 | 10 |
| Wrong / 10 | 2 | 0 |
| Unmapped / Ambiguous | 0 / 0 | 0 / 0 |
| Wrong Target Rate | 20% | 0% |
| production `validate_mapping` | PASS | PASS |

전화번호는 유일한 후보 `t1.r1.c8.p2`를, 대표자성명은 남은 25개 후보 중 같은 부모 셀의
`t1.r1.c2.p2`를 선택했다. 기존 정답 8개도 모두 CORRECT를 유지해 새 Wrong은 0건이다.
대표자 후보에는 다른 표의 중복 라벨이 남아 있으나 이번 응답에서는 잘못 선택하지 않았다.
따라서 이 한 문서·한 번의 실행에서는 Binding Eligibility 변경을 `EFFECTIVE`로 판단한다.
반복 실행 안정성이나 다른 공식 신청서에 대한 일반화, 실제 사용자 입력·배포 결과까지
입증한 것은 아니다. Run C의 필드별 expected/actual target, 상태, 후보 수, 선택 target의
문맥은 `run-c.json`에 기록했다. 이번 승인 범위를 넘는 OpenAI 호출은 하지 않았다.

## 고정 입력과 호출 계획

- Ground Truth: `../../expected/seocho-2026-v1.json`의 10개 field. 정답 target ID는
  채점할 때만 읽으며 모델 입력에는 넣지 않는다.
- 문서: 기업마당 공식 빈 HWPX 양식, SHA-256
  `8d253d5c0f5af214caf28d20f108b106d7261c79334b77f167c3886b4b552c91`.
- 모델: 기본 `gpt-5.6-luna` (`OPENAI_MODEL` 환경변수 또는 `--model`로 명시 가능).
- Run A: production `ApplicationPreparationAgent.map_document` 입력 그대로, 10개 field
  일괄 처리, OpenAI 1회.
- Run B: 동일한 production mapping 메서드와 문서를 사용하되, 실제 파싱된 후보별
  `semanticSection`, `sectionPath`, `tableHeadings`, `fieldLabels`, `rowLabels`,
  `columnLabels`, `tableClassification`을 scope·section·table별 평가용 메시지에 정리해 추가한다.
  10개 field 일괄 처리, OpenAI 1회.
- 총 계획: 2회. 평가 도구가 각 Run당 모델 호출을 1회로 제한하며 자동 재시도하지 않는다.
  Production 서비스의 오류 교정 재호출을 포함한 end-to-end 결과와 구분한다.

**이 평가는 semantic metadata 유무 비교가 아니다.** Run A에도 production DocumentMap의
metadata가 이미 포함된다. Run B는 새로운 문서 근거를 생성하지 않고 **동일한 production
evidence의 제시 방식만** scope·section·table별로 바꾼다. 따라서 전후 차이는 metadata 자체의
신규 제공 효과가 아니라 구조화된 근거 제시 효과로 해석해야 한다. 이 구분은 각 Run 결과와
`comparison.json`에도 기록한다.

Ground Truth JSON의 field ID·label은 두 Run의 공통 질문을 만드는 데만 사용한다. 정답
`expectedTargetId`, `sourceCellId`, `writeValue`와 heading 정답은 모델 요청에 넣지 않는다.
원문 DocumentMap에는 모든 native target ID가 포함되므로 정답으로 지정된 주소 문자열도 일반
후보 주소로 보일 수 있으나, 그 주소가 정답이라는 표시는 전달하지 않는다. 정답 target과
실제 선택 target의 비교는 응답을 받은 뒤 채점 단계에서만 수행한다.

## 실행

AI Service의 잠금 환경에서 실행했다. 원본은 저장소에 복사하지 않았다.

```text
cd backend/ai-service
uv run --locked --extra dev python ../../evaluation/application-document/evaluate_agent_mapping.py \
  --source <SHA-256이 일치하는 공식 HWPX의 로컬 경로>
```

실행 전 `OPENAI_API_KEY`가 필요하다. 키 값은 기록하지 않는다. 각 결과에는 실제 모델과
호출 수, 질문별 선택, production validator 통과 여부를 기록한다. `AMBIGUOUS`는 구조화
응답에서 한 field에 복수 binding이 있거나 하나의 target을 복수 field가 공유한 경우다.
모델이 `null`을 반환하면 `UNMAPPED`로 기록한다. `coverage`는 correct와 wrong의 합이다.

결과 해석에서 **Wrong Target Rate 증가 여부를 Correct 증가보다 먼저 본다**.

- Run A도 높고 Wrong 0이면 현재 production Mapping의 충분성을 검토한다.
- Run B의 Correct가 증가하고 Wrong 0을 유지하면 구조화된 evidence의 production 반영 후보로 본다.
- Correct와 Wrong이 함께 증가하면 production 반영을 보류한다.
- A/B 모두 낮으면 candidate collapse, hierarchical sectionPath 등 구조 개선을 검토한다.

`comparison.json`의 `interpretation`은 1개 문서의 예비 판단이다. 1차 2회 결과를 먼저
분석한 뒤에만 추가 평가 필요성을 판단한다. 재현성, 다른 공식 신청서로 일반화, 특정
ambiguous field 유형, scope/section evidence 개선안 중 명확한 검증 목적이 있을 때만
추가 호출을 고려한다. 그 전에 목적·호출 수·문서와 field·검증할 가설을 보고한다.
