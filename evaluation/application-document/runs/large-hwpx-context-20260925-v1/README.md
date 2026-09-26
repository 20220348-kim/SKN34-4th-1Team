# 대형 공식 HWPX Mapping 문맥 예산 검증

실행일: 2026-09-25. 원본은 [경기도 디자인상용화 지원사업 공식 신청서](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000120050)의 `FILE_000000000748788/1` 첨부다. 크기 166,147 B, SHA-256 `18c8bf9978731bbca37fe88df4d2548138a854ba0467161a6db54bf27baea420`. 원본과 수정본은 저장소에 넣지 않았다.

## 실패 조건과 축소 근거

[측정 결과](context-diagnosis.json)에 따르면 Hangeul MCP는 2,564 targets와 편집 가능한 말단 1,520개를 읽었다. 모든 target의 본문·context 합계 864,876자가 production `inspect_document`의 400,000자 제한을 초과해 모델 호출 전에 `LIMIT_EXCEEDED`였다. 기존 Mapping 직렬화 입력의 추정 크기는 아래와 같다.

| 범위 | 말단 targets | 입력 문자 | UTF-8 bytes | 토큰 추정 |
|---|---:|---:|---:|---:|
| 기존 전체 | 1,542 | 2,428,665 | 3,214,696 | 약 607,167 |
| 후보가 속한 표 전체 | 409 | 542,485 | 616,862 | 약 135,622 |
| 라벨 후보만 | 51 | 71,688 | 82,500 | 약 17,922 |
| 변경 후 실제 production Mapping 입력 | 51 | 72,064 | 82,876 | 약 18,016 |

토큰 값은 `문자 수/4` 휴리스틱이며 모델의 실제 과금 토큰이 아니다. 로컬 `tiktoken` 인코딩 자료가 없어 정확한 토크나이저 계산으로 보고하지 않는다. 실제 입력은 documentAnalysis metadata를 포함해 진단용 후보 직렬화보다 376자 길다.

10개 질문의 기존 native 라벨 후보 합집합이 51개였다. 사람 검토 [Ground Truth](../../expected/design-commercialization-2026-v1.json) target **10/10이 이 후보 안에 남았다**. production `validate_mapping`은 후보가 있는 질문을 그 후보 밖에 bind하지 못하게 한다. 따라서 대형 HWPX에서는 모든 질문에 native 라벨 후보가 있을 때만 그 법적으로 선택 가능한 말단을 모델에 보내며, 전체 DocumentMap과 물리 주소는 검증용으로 유지한다. 하나라도 후보가 없거나 축소된 입력도 400,000자를 넘으면 모델 호출 전에 명시적 오류로 중단한다.

## 실제 모델과 작성 경로

실제 [OpenAI Mapping 결과](mapping.json)는 `gpt-5.6-luna` **1회**, Correct 10/10, Wrong 0, Unmapped 0, Wrong Target Rate 0%, production validator PASS다. 정답 target ID는 모델 응답 후 채점할 때만 읽었다. API 재호출은 하지 않았다.

생성 단계는 모델이 고른 10개 binding ID를 허용 scope로 사용한 무료 검증이다. 실제 `inspect_document` → scoped `ApplicationPreparationAgent.plan_document` 입력 구축 → `validate_plan` → Hangeul MCP native apply/verify를 거쳤다. 계획 연산은 평가 코드가 가상값 3개로 공급했으며 유료 WritePlan 모델 호출은 0회다. 모델 계획 입력은 10 targets, 17,141자/19,045 UTF-8 bytes였다. [결과](plan-write.json)는 requested/resolved/applied/verified **3/3**, unresolved 0, XML 통과, 원본 SHA 보존이다. 한글 화면 렌더링은 `NOT_RUN`이다.

`mapVersion`은 `native-map-v12-hwpx-context-budget`로 갱신했다. 대형 양식에서는 Mapping의 선택 가능 scope가 라벨 후보로 제한되므로 다른 예시·보조 칸의 자동 정리까지 검증한 결과로 해석하지 않는다. 이전보다 큰 문서를 무제한 허용한 것이 아니라 질문 후보와 저장 scope의 실제 모델 입력에 400,000자 예산을 적용한다.
