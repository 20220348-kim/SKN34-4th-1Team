# 대화 조건 해석 재생 보고서 — `claude-proxy-sonnet-v1`

> 기대 라벨은 AI가 작성한 기대 동작이며 사람이 검토한 정답이 아니다. 이 보고서는 `outputs.jsonl`의 모델 출력을
> 실제 AI Service HTTP 경로(모델 응답만 고정)로 재생해 채점한 결과다. Claude가 만든 출력이면 **Claude 대리 검증**이며
> OpenAI 운영 모델의 측정이 아니다. 여러 턴은 이전 턴의 기대 상태를 다음 입력으로 쓰는 턴 단위 채점이다.

- cases.json 지문: `55314feae1fd51d457f11854ce77aacba7fff3ccfdc641ee6e5e30fda8f1db0d`
- 시스템 지침 SHA-256: `4d72d2f13668a989fce90448b8c04ef5cb2d131ca91e58db2c789973be14c6c2`
- 입력 지문: 현재 cases.json·시스템 지침과 일치
- 출력 처리: 출력 264건 / 누락 0건 / 무효 줄 0건 / 중복 id 0건 / 모르는 id 0건
- AI Service 검증 거부: 0건 (예상 밖 HTTP 없음)

## 요약

| 지표 | 단일 턴 | 여러 턴(턴 단위) | 전체 |
|---|---:|---:|---:|
| 상태 정확도 | 98.4% | 100.0% | 98.9% |
| 사례 통과율(상태·종류·필드·금지 규칙 모두) | 92.0% | 80.3% | 88.6% |
| READY 기대 문항의 정확한 제안 일치율 | 94.7% | 95.2% | 94.8% |
| 확인 질문 종류 정확도 | 100.0% | 100.0% | 100.0% |
| 안내 종류 정확도 | 76.5% | 55.2% | 66.7% |
| 검증기 거부율(출력 대비) | 0.0% | 0.0% | 0.0% |
| 잘못된 변경률(금지 규칙 위반/검사) | 1.1% | 5.7% | 2.5% |
| 기대하지 않은 변경 포함률 | 1.6% | 2.6% | 1.9% |
| 현재 구조 경로 일치율(READY→pipeline 등) | 89.4% | 71.0% | 84.1% |
| 필드 정밀도 | 98.1% | 96.2% | 97.6% |
| 필드 재현율 | 97.5% | 100.0% | 98.1% |
| 필드 F1 | 97.8% | 98.0% | 97.9% |
| 회사 소재지(REGION) 보호 위반 | 1 | 1 | 2 |
| 허용 대안으로 통과 | 5 | 1 | 6 |

여러 턴 시나리오 전체 턴 통과율: 56.0%

## 필드별

| 필드 | TP | FP | FN | 정밀도 | 재현율 | F1 |
|---|---:|---:|---:|---:|---:|---:|
| QUERY | 109 | 3 | 2 | 97.3% | 98.2% | 97.8% |
| REGION | 39 | 2 | 1 | 95.1% | 97.5% | 96.3% |
| INDUSTRY | 23 | 0 | 0 | 100.0% | 100.0% | 100.0% |
| ESTABLISHED_ON | 6 | 0 | 0 | 100.0% | 100.0% | 100.0% |
| FOUNDED_YEAR | 11 | 0 | 0 | 100.0% | 100.0% | 100.0% |
| SUPPORT_PURPOSE | 6 | 0 | 1 | 100.0% | 85.7% | 92.3% |
| ACCEPTING_ONLY | 11 | 0 | 0 | 100.0% | 100.0% | 100.0% |

## 범주별(단일 턴)

| 묶음 | 문항 | 출력 | 상태 | 통과 | 필드 F1 | 거부 | 금지 위반 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 지역 (`region`) | 18 | 18 | 100.0% | 88.9% | 92.0% | 0 | 1 |
| 업종 (`industry`) | 12 | 12 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| 업력 (`establishment`) | 16 | 16 | 93.8% | 93.8% | 100.0% | 0 | 0 |
| 대상·청년 (`target`) | 12 | 12 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| 규모·금액 (`scale_amount`) | 8 | 8 | 87.5% | 75.0% | 92.3% | 0 | 0 |
| 지원 분야 (`support_field`) | 14 | 14 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| 마감·접수 상태 (`deadline`) | 11 | 11 | 90.9% | 90.9% | 100.0% | 0 | 0 |
| 약어·오타·영어 (`alias_typo_english`) | 13 | 13 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| 제외·여러 의도 (`exclusion_multi_intent`) | 14 | 14 | 100.0% | 92.9% | 93.8% | 0 | 0 |
| 모호·회사 기반 (`ambiguous_company`) | 11 | 11 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| 비검색·주입·개인정보 (`non_search_injection`) | 17 | 17 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| 결과 참조 (`result_reference`) | 15 | 15 | 100.0% | 46.7% | – | 0 | 0 |
| 후속 수정 (`followup_edit`) | 12 | 12 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| 기타·표현 다양성 (`other`) | 15 | 15 | 100.0% | 100.0% | 100.0% | 0 | 0 |

## 기대 경로(route)별

현재 출력에는 route가 없다. 결과 질문·비교·더 보기·여러 의도·0건 도움 경로는 현재 구조로 표현할 수 없어 가장 가까운 현재 동작으로 채점하며, 경로 일치율은 상태에서 추정한 값이다.

| 경로 | 문항 | 출력 | 상태 | 통과 | 필드 F1 | 거부 | 금지 위반 | 현재 구조 경로 일치 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `pipeline` | 168 | 168 | 98.2% | 94.6% | 97.6% | 0 | 3 | 98.2% |
| `clarify` | 29 | 29 | 100.0% | 100.0% | 100.0% | 0 | 0 | 100.0% |
| `answer` | 28 | 28 | 100.0% | 100.0% | – | 0 | 0 | 100.0% |
| `result_question` | 13 | 13 | 100.0% | 0.0% | – | 0 | 0 | 0.0% |
| `compare` | 8 | 8 | 100.0% | 0.0% | – | 0 | 0 | 0.0% |
| `more_results` | 6 | 6 | 100.0% | 100.0% | – | 0 | 0 | 0.0% |
| `multi_intent` | 5 | 5 | 100.0% | 100.0% | 100.0% | 0 | 0 | 0.0% |
| `zero_result_help` | 7 | 7 | 100.0% | 100.0% | – | 0 | 0 | 0.0% |

## v2-gap 주제별(현재 스키마로 표현 못 하는 의도)

| 묶음 | 문항 | 출력 | 상태 | 통과 | 필드 F1 | 거부 | 금지 위반 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `v2-gap:agency` | 6 | 6 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `v2-gap:amount` | 4 | 4 | 100.0% | 75.0% | 85.7% | 0 | 0 |
| `v2-gap:broad-search` | 1 | 1 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `v2-gap:business-age` | 1 | 1 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `v2-gap:company-based-search` | 3 | 3 | 100.0% | 100.0% | – | 0 | 0 |
| `v2-gap:company-size` | 6 | 6 | 83.3% | 83.3% | 100.0% | 0 | 0 |
| `v2-gap:compare` | 8 | 8 | 100.0% | 0.0% | – | 0 | 0 |
| `v2-gap:date-format` | 2 | 2 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `v2-gap:deadline` | 6 | 6 | 83.3% | 83.3% | 100.0% | 0 | 0 |
| `v2-gap:eligibility-question` | 8 | 8 | 100.0% | 0.0% | – | 0 | 0 |
| `v2-gap:exclusion` | 3 | 3 | 100.0% | 66.7% | 0.0% | 0 | 1 |
| `v2-gap:multi-purpose` | 5 | 5 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `v2-gap:multi-region` | 1 | 1 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `v2-gap:numeral-year` | 1 | 1 | 100.0% | 100.0% | – | 0 | 0 |
| `v2-gap:program-region` | 3 | 3 | 100.0% | 33.3% | 75.0% | 0 | 2 |
| `v2-gap:relative-age` | 4 | 4 | 100.0% | 75.0% | – | 0 | 0 |
| `v2-gap:result-reference` | 11 | 11 | 100.0% | 54.5% | – | 0 | 0 |
| `v2-gap:target` | 17 | 17 | 94.1% | 94.1% | 100.0% | 0 | 0 |
| `v2-gap:two-digit-year` | 2 | 2 | 100.0% | 100.0% | – | 0 | 0 |
| `v2-gap:zero-result-help` | 7 | 7 | 100.0% | 100.0% | – | 0 | 0 |

## 설계 문서 약점 문장

| 묶음 | 문항 | 출력 | 상태 | 통과 | 필드 F1 | 거부 | 금지 위반 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `known-weak:agency-rnd` | 2 | 2 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `known-weak:always-open` | 2 | 2 | 100.0% | 100.0% | – | 0 | 0 |
| `known-weak:broad-repeat` | 4 | 4 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `known-weak:chit-chat` | 5 | 5 | 100.0% | 100.0% | – | 0 | 0 |
| `known-weak:deadline-week` | 1 | 1 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `known-weak:dotted-date` | 2 | 2 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `known-weak:edu-to-fund` | 2 | 2 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `known-weak:eligibility-followup` | 2 | 2 | 100.0% | 0.0% | – | 0 | 0 |
| `known-weak:exclude-consulting` | 2 | 2 | 100.0% | 50.0% | 0.0% | 0 | 1 |
| `known-weak:injection` | 4 | 4 | 100.0% | 100.0% | – | 0 | 0 |
| `known-weak:kotra` | 2 | 2 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `known-weak:personal-data` | 4 | 4 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `known-weak:preliminary-youth` | 2 | 2 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `known-weak:program-region` | 2 | 2 | 100.0% | 0.0% | 66.7% | 0 | 2 |
| `known-weak:second-item` | 2 | 2 | 100.0% | 0.0% | – | 0 | 0 |
| `known-weak:seoul-ai-startup` | 3 | 3 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `known-weak:service-howto` | 3 | 3 | 100.0% | 100.0% | – | 0 | 0 |
| `known-weak:seventh-year` | 2 | 2 | 100.0% | 100.0% | – | 0 | 0 |
| `known-weak:show-more` | 2 | 2 | 100.0% | 100.0% | – | 0 | 0 |
| `known-weak:small-business-5` | 2 | 2 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `known-weak:year-21` | 2 | 2 | 100.0% | 100.0% | – | 0 | 0 |
| `known-weak:zero-why` | 3 | 3 | 100.0% | 100.0% | – | 0 | 0 |

## 표현 방식

| 묶음 | 문항 | 출력 | 상태 | 통과 | 필드 F1 | 거부 | 금지 위반 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `style:banmal` | 134 | 134 | 99.2% | 83.6% | 98.3% | 0 | 1 |
| `style:emoji` | 3 | 3 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `style:english-mix` | 9 | 9 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `style:jondaetmal` | 41 | 41 | 95.1% | 90.2% | 100.0% | 0 | 0 |
| `style:keyword` | 42 | 42 | 100.0% | 97.6% | 100.0% | 0 | 0 |
| `style:long` | 3 | 3 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `style:no-spacing` | 3 | 3 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `style:numeric` | 19 | 19 | 94.7% | 89.5% | 97.0% | 0 | 0 |
| `style:typo` | 4 | 4 | 100.0% | 100.0% | 100.0% | 0 | 0 |

## 여러 턴 시나리오

| 시나리오 | 제목 | 통과 턴 | 전체 통과 |
|---|---|---:|---|
| M01 | 넓은 서울 지원사업 요청을 두 번 한 뒤 수출로 좁힘 | 3/3 | 예 |
| M02 | 서울 기업이 부산에서 열리는 수출 지원을 찾음 | 2/3 | 아니요 |
| M03 | AI 창업에서 무역으로 전환 후 대구 0건 | 4/4 | 예 |
| M04 | 예비창업자 청년 검색 후 결과 자격 질문 | 2/3 | 아니요 |
| M05 | 소상공인 교육에서 자금으로 바꾸고 상시 접수 질문 | 3/3 | 예 |
| M06 | 7년차 업력 확인 후 연도 해제 | 3/3 | 예 |
| M07 | 두 자리 연도·점 날짜·ISO 날짜 순서로 설립 정보 정정 | 3/3 | 예 |
| M08 | 결과 두 번째 공고 질문과 더 보기 후 마감 포함 | 2/3 | 아니요 |
| M09 | 중기부 알앤디에서 코트라 해외진출로 전환 | 3/3 | 예 |
| M10 | 주입·개인정보가 섞인 대화 | 3/3 | 예 |
| M11 | 컨설팅 제외 요청 후 지역 변경과 해제 | 2/3 | 아니요 |
| M12 | 전체 초기화 후 새 검색 | 3/3 | 예 |
| M13 | 지역 제안 취소 후 다른 분야 | 3/3 | 예 |
| M14 | 두 지역 중 선택 후 적은 결과 질문 | 3/3 | 예 |
| M15 | 회사 기반 요청 후 정책자금과 업종 해제 | 3/3 | 예 |
| M16 | 대구 제안에 동의 후 다시 서울 | 3/3 | 예 |
| M17 | 영어 섞인 카페 마케팅 검색 | 3/3 | 예 |
| M18 | 수출 결과 두 공고 비교 후 자격 질문과 재검색 | 1/3 | 아니요 |
| M19 | R&D 결과 더 보기와 신청 기간 질문 후 판로 전환 | 2/3 | 아니요 |
| M20 | 청년 창업 지원금 결과 비교와 업력 자격 질문 | 1/3 | 아니요 |
| M21 | 스마트공장 결과의 지역 자격 질문과 더 보기 | 2/3 | 아니요 |
| M22 | 수출과 R&D 여러 의도 검색 후 결과 비교와 한쪽 재검색 | 2/3 | 아니요 |
| M23 | 판로 결과 원문 링크와 비교 질문 | 1/3 | 아니요 |
| M24 | 0건 이유와 완화 방법 질문 후 마감 포함 | 3/3 | 예 |
| M25 | 예비창업자 신청 가능 공고 번호와 비교 후 다음 페이지 | 1/3 | 아니요 |

## 실패 목록 (30건)

| id | 범주 | 경로 | 결과 | 메시지 | 이유 |
|---|---|---|---|---|---|
| S003#1 | region | pipeline | ACCEPTED | 부산에서 하는 수출 지원사업 찾아줘 | REGION 불필요한 변경 '서울특별시' → '부산'; 보호 필드 REGION 변경: '서울특별시' → '부산' |
| S006#1 | region | pipeline | ACCEPTED | 수도권 기업 대상 R&D 지원 찾아줘 | QUERY 값 '수도권 기업 대상 R&D 지원' (기대 포함 R&D\|알앤디\|연구개발\|기술개발, 제외 수도권); REGION 변경 누락 (기대 '수도권') |
| S043#1 | establishment | pipeline | ACCEPTED | 2027년 설립 예정이에요 | 상태 CLARIFICATION_REQUIRED (기대 READY) |
| S060#1 | scale_amount | pipeline | ACCEPTED | 지원금 5천만원 이하인 걸로 | SUPPORT_PURPOSE 변경 누락 (기대 포함 지원금\|보조금) |
| S062#1 | scale_amount | pipeline | ACCEPTED | 매출 10억 이하 중소기업이에요 | 상태 CLARIFICATION_REQUIRED (기대 READY) |
| S085#1 | deadline | pipeline | ACCEPTED | 오늘까지 접수하는 거 있어? | 상태 ANSWERED (기대 READY) |
| S114#1 | exclusion_multi_intent | pipeline | ACCEPTED | 대출 말고 갚을 필요 없는 지원금 | QUERY 값 '대출 제외 갚을 필요 없는 지원금' (기대 포함 지원금\|보조금, 제외 대출\|융자) |
| S147#1 | result_reference | result_question | ACCEPTED | 두 번째 거 자세히 알려줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S149#1 | result_reference | result_question | ACCEPTED | 예비창업자도 신청 돼? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S154#1 | result_reference | result_question | ACCEPTED | 첫 번째 공고 마감일이 언제야? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S156#1 | result_reference | compare | ACCEPTED | 1번이랑 3번 비교해줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S157#1 | result_reference | compare | ACCEPTED | 위에 두 개 중에 우리 회사에 더 맞는 건 뭐야? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S159#1 | result_reference | result_question | ACCEPTED | 3번 공고 신청 자격이 뭐야? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S160#1 | result_reference | result_question | ACCEPTED | 4번은 서울 기업도 신청돼요? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S161#1 | result_reference | compare | ACCEPTED | 2번하고 4번 지원 금액 차이 알려줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M02#1 | region | pipeline | ACCEPTED | 부산에서 하는 수출 지원사업 찾아줘 | REGION 불필요한 변경 '서울특별시' → '부산'; 보호 필드 REGION 변경: '서울특별시' → '부산' |
| M04#3 | result_reference | result_question | ACCEPTED | 예비창업자도 신청 돼? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M08#1 | result_reference | result_question | ACCEPTED | 두 번째 거 자세히 알려줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M11#1 | exclusion_multi_intent | pipeline | ACCEPTED | 컨설팅 빼고 | QUERY 불필요한 변경 '마케팅 지원' → '마케팅 지원 컨설팅 제외'; QUERY에 금지 문구 ['컨설팅'] 포함: '마케팅 지원 컨설팅 제외' |
| M18#1 | result_reference | compare | ACCEPTED | 1번이랑 3번 비교해줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M18#2 | result_reference | result_question | ACCEPTED | 3번 신청 자격은 어떻게 돼? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M19#2 | result_reference | result_question | ACCEPTED | 두 번째 공고 신청 기간은 언제까지야? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M20#2 | result_reference | compare | ACCEPTED | 첫 번째랑 두 번째 차이가 뭐야? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M20#3 | result_reference | result_question | ACCEPTED | 우리 회사 7년차인데 첫 번째 거 신청 가능해? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M21#1 | result_reference | result_question | ACCEPTED | 3번은 부산 기업도 신청 돼요? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M22#2 | result_reference | compare | ACCEPTED | 2번이랑 4번 비교해줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M23#1 | result_reference | result_question | ACCEPTED | 3번 공고 원문 링크 줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M23#2 | result_reference | compare | ACCEPTED | 그거랑 1번 중에 뭐가 더 나아? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M25#1 | result_reference | result_question | ACCEPTED | 이 중에 예비창업자가 신청할 수 있는 건 몇 번이야? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M25#2 | result_reference | compare | ACCEPTED | 1번이랑 5번 지원 내용 비교 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
