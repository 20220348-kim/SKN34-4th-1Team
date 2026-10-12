# 대화 조건 해석 재생 보고서 — `claude-proxy-v1`

> 기대 라벨은 AI가 작성한 기대 동작이며 사람이 검토한 정답이 아니다. 이 보고서는 `outputs.jsonl`의 모델 출력을
> 실제 AI Service HTTP 경로(모델 응답만 고정)로 재생해 채점한 결과다. Claude가 만든 출력이면 **Claude 대리 검증**이며
> OpenAI 운영 모델의 측정이 아니다. 여러 턴은 이전 턴의 기대 상태를 다음 입력으로 쓰는 턴 단위 채점이다.

- cases.json 지문: `55314feae1fd51d457f11854ce77aacba7fff3ccfdc641ee6e5e30fda8f1db0d`
- 시스템 지침 SHA-256: `4d72d2f13668a989fce90448b8c04ef5cb2d131ca91e58db2c789973be14c6c2`
- 입력 지문: 현재 cases.json·시스템 지침과 일치
- 출력 처리: 출력 264건 / 누락 0건 / 무효 줄 0건 / 중복 id 0건 / 모르는 id 0건
- AI Service 검증 거부: 7건 (예상 밖 HTTP 없음)

## 요약

| 지표 | 단일 턴 | 여러 턴(턴 단위) | 전체 |
|---|---:|---:|---:|
| 상태 정확도 | 89.4% | 90.8% | 89.8% |
| 사례 통과율(상태·종류·필드·금지 규칙 모두) | 77.7% | 60.5% | 72.7% |
| READY 기대 문항의 정확한 제안 일치율 | 78.6% | 69.0% | 76.3% |
| 확인 질문 종류 정확도 | 88.0% | 83.3% | 87.1% |
| 안내 종류 정확도 | 64.5% | 42.9% | 54.2% |
| 검증기 거부율(출력 대비) | 2.1% | 4.0% | 2.6% |
| 잘못된 변경률(금지 규칙 위반/검사) | 2.5% | 3.1% | 2.7% |
| 기대하지 않은 변경 포함률 | 4.3% | 5.5% | 4.7% |
| 현재 구조 경로 일치율(READY→pipeline 등) | 80.3% | 63.2% | 75.4% |
| 필드 정밀도 | 94.4% | 90.7% | 93.6% |
| 필드 재현율 | 83.4% | 78.0% | 82.2% |
| 필드 F1 | 88.6% | 83.9% | 87.5% |
| 회사 소재지(REGION) 보호 위반 | 1 | 1 | 2 |
| 허용 대안으로 통과 | 5 | 0 | 5 |

여러 턴 시나리오 전체 턴 통과율: 32.0%

## 필드별

| 필드 | TP | FP | FN | 정밀도 | 재현율 | F1 |
|---|---:|---:|---:|---:|---:|---:|
| QUERY | 87 | 10 | 24 | 89.7% | 78.4% | 83.7% |
| REGION | 37 | 2 | 6 | 94.9% | 86.1% | 90.2% |
| INDUSTRY | 20 | 0 | 3 | 100.0% | 87.0% | 93.0% |
| ESTABLISHED_ON | 6 | 0 | 0 | 100.0% | 100.0% | 100.0% |
| FOUNDED_YEAR | 8 | 0 | 3 | 100.0% | 72.7% | 84.2% |
| SUPPORT_PURPOSE | 6 | 0 | 1 | 100.0% | 85.7% | 92.3% |
| ACCEPTING_ONLY | 11 | 0 | 1 | 100.0% | 91.7% | 95.7% |

## 범주별(단일 턴)

| 묶음 | 문항 | 출력 | 상태 | 통과 | 필드 F1 | 거부 | 금지 위반 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 지역 (`region`) | 18 | 18 | 94.4% | 77.8% | 92.9% | 0 | 2 |
| 업종 (`industry`) | 12 | 12 | 91.7% | 83.3% | 93.8% | 1 | 0 |
| 업력 (`establishment`) | 16 | 16 | 68.8% | 68.8% | 90.0% | 3 | 0 |
| 대상·청년 (`target`) | 12 | 12 | 83.3% | 50.0% | 54.5% | 0 | 0 |
| 규모·금액 (`scale_amount`) | 8 | 8 | 87.5% | 75.0% | 76.9% | 0 | 0 |
| 지원 분야 (`support_field`) | 14 | 14 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| 마감·접수 상태 (`deadline`) | 11 | 11 | 81.8% | 81.8% | 94.1% | 0 | 0 |
| 약어·오타·영어 (`alias_typo_english`) | 13 | 13 | 76.9% | 69.2% | 69.2% | 0 | 0 |
| 제외·여러 의도 (`exclusion_multi_intent`) | 14 | 14 | 100.0% | 92.9% | 96.8% | 0 | 0 |
| 모호·회사 기반 (`ambiguous_company`) | 11 | 11 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| 비검색·주입·개인정보 (`non_search_injection`) | 17 | 17 | 94.1% | 94.1% | 85.7% | 0 | 0 |
| 결과 참조 (`result_reference`) | 15 | 15 | 100.0% | 33.3% | – | 0 | 0 |
| 후속 수정 (`followup_edit`) | 12 | 12 | 91.7% | 83.3% | 87.5% | 0 | 0 |
| 기타·표현 다양성 (`other`) | 15 | 15 | 80.0% | 80.0% | 97.0% | 0 | 0 |

## 기대 경로(route)별

현재 출력에는 route가 없다. 결과 질문·비교·더 보기·여러 의도·0건 도움 경로는 현재 구조로 표현할 수 없어 가장 가까운 현재 동작으로 채점하며, 경로 일치율은 상태에서 추정한 값이다.

| 경로 | 문항 | 출력 | 상태 | 통과 | 필드 F1 | 거부 | 금지 위반 | 현재 구조 경로 일치 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `pipeline` | 168 | 168 | 87.5% | 76.2% | 86.6% | 3 | 3 | 87.5% |
| `clarify` | 29 | 29 | 86.2% | 86.2% | 96.5% | 4 | 0 | 86.2% |
| `answer` | 28 | 28 | 96.4% | 96.4% | – | 0 | 0 | 96.4% |
| `result_question` | 13 | 13 | 100.0% | 0.0% | – | 0 | 0 | 0.0% |
| `compare` | 8 | 8 | 100.0% | 0.0% | – | 0 | 0 | 0.0% |
| `more_results` | 6 | 6 | 100.0% | 33.3% | – | 0 | 0 | 0.0% |
| `multi_intent` | 5 | 5 | 80.0% | 80.0% | 92.3% | 0 | 0 | 0.0% |
| `zero_result_help` | 7 | 7 | 100.0% | 85.7% | – | 0 | 0 | 0.0% |

## v2-gap 주제별(현재 스키마로 표현 못 하는 의도)

| 묶음 | 문항 | 출력 | 상태 | 통과 | 필드 F1 | 거부 | 금지 위반 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `v2-gap:agency` | 6 | 6 | 66.7% | 33.3% | 40.0% | 0 | 0 |
| `v2-gap:amount` | 4 | 4 | 75.0% | 75.0% | 85.7% | 0 | 0 |
| `v2-gap:broad-search` | 1 | 1 | 0.0% | 0.0% | 0.0% | 0 | 0 |
| `v2-gap:business-age` | 1 | 1 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `v2-gap:company-based-search` | 3 | 3 | 100.0% | 100.0% | – | 0 | 0 |
| `v2-gap:company-size` | 6 | 6 | 100.0% | 66.7% | 66.7% | 0 | 0 |
| `v2-gap:compare` | 8 | 8 | 100.0% | 0.0% | – | 0 | 0 |
| `v2-gap:date-format` | 2 | 2 | 0.0% | 0.0% | 0.0% | 2 | 0 |
| `v2-gap:deadline` | 6 | 6 | 66.7% | 66.7% | 80.0% | 0 | 0 |
| `v2-gap:eligibility-question` | 8 | 8 | 100.0% | 0.0% | – | 0 | 0 |
| `v2-gap:exclusion` | 3 | 3 | 100.0% | 100.0% | – | 0 | 0 |
| `v2-gap:multi-purpose` | 5 | 5 | 80.0% | 80.0% | 92.3% | 0 | 0 |
| `v2-gap:multi-region` | 1 | 1 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `v2-gap:numeral-year` | 1 | 1 | 0.0% | 0.0% | – | 1 | 0 |
| `v2-gap:program-region` | 3 | 3 | 66.7% | 0.0% | 75.0% | 0 | 2 |
| `v2-gap:relative-age` | 4 | 4 | 100.0% | 75.0% | – | 0 | 0 |
| `v2-gap:result-reference` | 11 | 11 | 100.0% | 18.2% | – | 0 | 0 |
| `v2-gap:target` | 17 | 17 | 70.6% | 41.2% | 57.1% | 0 | 0 |
| `v2-gap:two-digit-year` | 2 | 2 | 0.0% | 0.0% | – | 2 | 0 |
| `v2-gap:zero-result-help` | 7 | 7 | 100.0% | 85.7% | – | 0 | 0 |

## 설계 문서 약점 문장

| 묶음 | 문항 | 출력 | 상태 | 통과 | 필드 F1 | 거부 | 금지 위반 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `known-weak:agency-rnd` | 2 | 2 | 100.0% | 0.0% | 0.0% | 0 | 0 |
| `known-weak:always-open` | 2 | 2 | 100.0% | 100.0% | – | 0 | 0 |
| `known-weak:broad-repeat` | 4 | 4 | 75.0% | 75.0% | 80.0% | 0 | 0 |
| `known-weak:chit-chat` | 5 | 5 | 100.0% | 100.0% | – | 0 | 0 |
| `known-weak:deadline-week` | 1 | 1 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `known-weak:dotted-date` | 2 | 2 | 0.0% | 0.0% | 0.0% | 2 | 0 |
| `known-weak:edu-to-fund` | 2 | 2 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `known-weak:eligibility-followup` | 2 | 2 | 100.0% | 0.0% | – | 0 | 0 |
| `known-weak:exclude-consulting` | 2 | 2 | 100.0% | 100.0% | – | 0 | 0 |
| `known-weak:injection` | 4 | 4 | 100.0% | 100.0% | – | 0 | 0 |
| `known-weak:kotra` | 2 | 2 | 50.0% | 50.0% | 66.7% | 0 | 0 |
| `known-weak:personal-data` | 4 | 4 | 75.0% | 75.0% | 80.0% | 0 | 0 |
| `known-weak:preliminary-youth` | 2 | 2 | 50.0% | 0.0% | 0.0% | 0 | 0 |
| `known-weak:program-region` | 2 | 2 | 100.0% | 0.0% | 66.7% | 0 | 2 |
| `known-weak:second-item` | 2 | 2 | 100.0% | 0.0% | – | 0 | 0 |
| `known-weak:seoul-ai-startup` | 3 | 3 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `known-weak:service-howto` | 3 | 3 | 100.0% | 100.0% | – | 0 | 0 |
| `known-weak:seventh-year` | 2 | 2 | 100.0% | 100.0% | – | 0 | 0 |
| `known-weak:show-more` | 2 | 2 | 100.0% | 0.0% | – | 0 | 0 |
| `known-weak:small-business-5` | 2 | 2 | 100.0% | 0.0% | 0.0% | 0 | 0 |
| `known-weak:year-21` | 2 | 2 | 0.0% | 0.0% | – | 2 | 0 |
| `known-weak:zero-why` | 3 | 3 | 100.0% | 100.0% | – | 0 | 0 |

## 표현 방식

| 묶음 | 문항 | 출력 | 상태 | 통과 | 필드 F1 | 거부 | 금지 위반 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `style:banmal` | 134 | 134 | 91.8% | 66.4% | 85.0% | 1 | 1 |
| `style:emoji` | 3 | 3 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `style:english-mix` | 9 | 9 | 77.8% | 77.8% | 78.3% | 0 | 0 |
| `style:jondaetmal` | 41 | 41 | 87.8% | 75.6% | 92.8% | 1 | 0 |
| `style:keyword` | 42 | 42 | 95.2% | 83.3% | 92.8% | 0 | 0 |
| `style:long` | 3 | 3 | 33.3% | 33.3% | 100.0% | 0 | 0 |
| `style:no-spacing` | 3 | 3 | 100.0% | 100.0% | 100.0% | 0 | 0 |
| `style:numeric` | 19 | 19 | 63.2% | 52.6% | 73.3% | 5 | 0 |
| `style:typo` | 4 | 4 | 100.0% | 100.0% | 100.0% | 0 | 0 |

## 여러 턴 시나리오

| 시나리오 | 제목 | 통과 턴 | 전체 통과 |
|---|---|---:|---|
| M01 | 넓은 서울 지원사업 요청을 두 번 한 뒤 수출로 좁힘 | 1/3 | 아니요 |
| M02 | 서울 기업이 부산에서 열리는 수출 지원을 찾음 | 1/3 | 아니요 |
| M03 | AI 창업에서 무역으로 전환 후 대구 0건 | 4/4 | 예 |
| M04 | 예비창업자 청년 검색 후 결과 자격 질문 | 0/3 | 아니요 |
| M05 | 소상공인 교육에서 자금으로 바꾸고 상시 접수 질문 | 2/3 | 아니요 |
| M06 | 7년차 업력 확인 후 연도 해제 | 3/3 | 예 |
| M07 | 두 자리 연도·점 날짜·ISO 날짜 순서로 설립 정보 정정 | 1/3 | 아니요 |
| M08 | 결과 두 번째 공고 질문과 더 보기 후 마감 포함 | 1/3 | 아니요 |
| M09 | 중기부 알앤디에서 코트라 해외진출로 전환 | 1/3 | 아니요 |
| M10 | 주입·개인정보가 섞인 대화 | 3/3 | 예 |
| M11 | 컨설팅 제외 요청 후 지역 변경과 해제 | 2/3 | 아니요 |
| M12 | 전체 초기화 후 새 검색 | 3/3 | 예 |
| M13 | 지역 제안 취소 후 다른 분야 | 3/3 | 예 |
| M14 | 두 지역 중 선택 후 적은 결과 질문 | 3/3 | 예 |
| M15 | 회사 기반 요청 후 정책자금과 업종 해제 | 3/3 | 예 |
| M16 | 대구 제안에 동의 후 다시 서울 | 2/3 | 아니요 |
| M17 | 영어 섞인 카페 마케팅 검색 | 3/3 | 예 |
| M18 | 수출 결과 두 공고 비교 후 자격 질문과 재검색 | 1/3 | 아니요 |
| M19 | R&D 결과 더 보기와 신청 기간 질문 후 판로 전환 | 2/3 | 아니요 |
| M20 | 청년 창업 지원금 결과 비교와 업력 자격 질문 | 1/3 | 아니요 |
| M21 | 스마트공장 결과의 지역 자격 질문과 더 보기 | 2/3 | 아니요 |
| M22 | 수출과 R&D 여러 의도 검색 후 결과 비교와 한쪽 재검색 | 1/3 | 아니요 |
| M23 | 판로 결과 원문 링크와 비교 질문 | 1/3 | 아니요 |
| M24 | 0건 이유와 완화 방법 질문 후 마감 포함 | 2/3 | 아니요 |
| M25 | 예비창업자 신청 가능 공고 번호와 비교 후 다음 페이지 | 0/3 | 아니요 |

## 실패 목록 (72건)

| id | 범주 | 경로 | 결과 | 메시지 | 이유 |
|---|---|---|---|---|---|
| S003#1 | region | pipeline | ACCEPTED | 부산에서 하는 수출 지원사업 찾아줘 | REGION 불필요한 변경 '서울특별시' → '부산'; 보호 필드 REGION 변경: '서울특별시' → '부산' |
| S005#1 | region | pipeline | ACCEPTED | 부산으로 바꿔줘 | QUERY 변경 누락 (기대 포함 사업화, 제외 서울); QUERY에 금지 문구 ['서울'] 포함: '서울 사업화 지원' |
| S007#1 | region | pipeline | ACCEPTED | 부울경 지역 제조업 지원사업 | QUERY 값 '지원사업' (기대 포함 제조, 제외 부울경) |
| S013#1 | region | pipeline | ACCEPTED | 우리는 부산 회사인데 서울에서 열리는 박람회 참가 지원 있나요? | 상태 CLARIFICATION_REQUIRED (기대 READY) |
| S022#1 | industry | pipeline | ACCEPTED | 온라인 쇼핑몰 운영 중이고 판로 지원 찾고 있어요 | INDUSTRY 변경 누락 (기대 포함 쇼핑몰\|전자상거래\|통신판매\|온라인) |
| S024#1 | industry | clarify | REJECTED | 업종은 도소매업이야 | AI Service 검증 거부(503) |
| S032#1 | establishment | clarify | REJECTED | 21년 설립이에요 | AI Service 검증 거부(503) |
| S033#1 | establishment | pipeline | REJECTED | 2021.3.15 설립 | AI Service 검증 거부(503) |
| S040#1 | establishment | pipeline | ACCEPTED | 2019년 7월 설립 | 상태 CLARIFICATION_REQUIRED (기대 READY); FOUNDED_YEAR 변경 누락 (기대 2019) |
| S043#1 | establishment | pipeline | ACCEPTED | 2027년 설립 예정이에요 | 상태 CLARIFICATION_REQUIRED (기대 READY) |
| S044#1 | establishment | clarify | REJECTED | 이천이십일년에 세웠어요 | AI Service 검증 거부(503) |
| S047#1 | target | pipeline | ACCEPTED | 예비창업자인데 청년 대상 거 있어? | 상태 CLARIFICATION_REQUIRED (기대 READY); QUERY 변경 누락 (기대 포함 청년, 포함 예비창업) |
| S049#1 | target | pipeline | ACCEPTED | 여성기업 우대하는 판로 지원 찾아주세요 | QUERY 값 '판로 지원' (기대 포함 여성, 포함 판로) |
| S051#1 | target | pipeline | ACCEPTED | 사회적기업 인증받았는데 판로 지원 있나요? | QUERY 값 '판로 지원' (기대 포함 판로, 포함 사회적) |
| S053#1 | target | pipeline | ACCEPTED | 대학생 창업 동아리도 받을 수 있는 거 | 상태 ANSWERED (기대 READY); QUERY 변경 누락 (기대 포함 대학생, 포함 창업) |
| S055#1 | target | pipeline | ACCEPTED | 다문화 가정 대표도 신청 가능한 창업 지원 | QUERY 값 '창업 지원' (기대 포함 다문화, 포함 창업) |
| S057#1 | target | pipeline | ACCEPTED | 졸업한 지 2년 된 청년인데 창업 지원 | QUERY 값 '창업 지원' (기대 포함 청년, 포함 창업) |
| S059#1 | scale_amount | pipeline | ACCEPTED | 직원 5명 소상공인인데 받을 수 있는 자금 있어? | QUERY 값 '자금 지원' (기대 포함 소상공인, 포함 자금\|지원금\|융자\|보조금\|정책자금) |
| S060#1 | scale_amount | pipeline | ACCEPTED | 지원금 5천만원 이하인 걸로 | 상태 ANSWERED (기대 READY); SUPPORT_PURPOSE 변경 누락 (기대 포함 지원금\|보조금) |
| S085#1 | deadline | pipeline | ACCEPTED | 오늘까지 접수하는 거 있어? | 상태 ANSWERED (기대 READY) |
| S087#1 | deadline | pipeline | ACCEPTED | 다음 주부터 접수 시작하는 것도 알려줘 | 상태 ANSWERED (기대 READY); ACCEPTING_ONLY 변경 누락 (기대 False) |
| S092#1 | alias_typo_english | pipeline | ACCEPTED | 중기부 알앤디 찾아줘 | QUERY 값 'R&D' (기대 포함 R&D\|알앤디\|연구개발\|기술개발, 포함 중기부\|중소벤처기업부) |
| S100#1 | alias_typo_english | pipeline | ACCEPTED | Seoul startup funding | 상태 ANSWERED (기대 READY); QUERY 변경 누락 (기대 포함 startup\|스타트업\|창업, 포함 funding\|자금\|투자\|지원금, 제외 서울\|seoul); REGION 변경 누락 (기대 다음 중 하나 서울/Seoul) |
| S101#1 | alias_typo_english | pipeline | ACCEPTED | IT company in Busan, looking for export… | 상태 ANSWERED (기대 READY); QUERY 변경 누락 (기대 포함 export\|수출, 제외 busan\|부산); REGION 변경 누락 (기대 다음 중 하나 부산/Busan); INDUSTRY 변경 누락 (기대 포함 IT\|정보통신\|소프트웨어\|SW\|아이티) |
| S104#1 | alias_typo_english | pipeline | ACCEPTED | 창진원 초창패 공고 떴어? | 상태 CLARIFICATION_REQUIRED (기대 READY); QUERY 변경 누락 (기대 포함 초창패\|초기창업패키지\|초기창업) |
| S108#1 | exclusion_multi_intent | pipeline | ACCEPTED | 융자 말고 보조금으로 | QUERY 변경 누락 (기대 포함 보조금\|지원금, 제외 융자) |
| S140#1 | non_search_injection | pipeline | ACCEPTED | 제 주민번호 900101-1234567인데 받을 수 있는 창업 지원금 … | 상태 ANSWERED (기대 READY); QUERY 변경 누락 (기대 포함 창업, 포함 지원금\|자금) |
| S147#1 | result_reference | result_question | ACCEPTED | 두 번째 거 자세히 알려줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S148#1 | result_reference | more_results | ACCEPTED | 더 보여줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S149#1 | result_reference | result_question | ACCEPTED | 예비창업자도 신청 돼? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S154#1 | result_reference | result_question | ACCEPTED | 첫 번째 공고 마감일이 언제야? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S156#1 | result_reference | compare | ACCEPTED | 1번이랑 3번 비교해줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S157#1 | result_reference | compare | ACCEPTED | 위에 두 개 중에 우리 회사에 더 맞는 건 뭐야? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S158#1 | result_reference | more_results | ACCEPTED | 다음 결과도 보여줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S159#1 | result_reference | result_question | ACCEPTED | 3번 공고 신청 자격이 뭐야? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S160#1 | result_reference | result_question | ACCEPTED | 4번은 서울 기업도 신청돼요? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S161#1 | result_reference | compare | ACCEPTED | 2번하고 4번 지원 금액 차이 알려줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| S166#1 | followup_edit | pipeline | ACCEPTED | 수출 | 상태 CLARIFICATION_REQUIRED (기대 READY); QUERY 변경 누락 (기대 포함 수출\|해외진출, 제외 서울) |
| S172#1 | followup_edit | pipeline | ACCEPTED | 다시 서울로 | REGION 변경 누락 (기대 '서울') |
| S178#1 | other | answer | ACCEPTED | 안녕하세요 | 상태 CLARIFICATION_REQUIRED (기대 ANSWERED) |
| S185#1 | other | pipeline | ACCEPTED | ㄹㅇ 급함 자금 지원 ㄱㄱ | 상태 CLARIFICATION_REQUIRED (기대 READY); QUERY 변경 누락 (기대 포함 자금\|지원금\|융자\|보조금\|정책자금) |
| S186#1 | other | pipeline | ACCEPTED | 제가 이번에 처음 사업을 시작하려고 하는데요. 아직 사업자 등록은 안 … | 상태 CLARIFICATION_REQUIRED (기대 READY) |
| M01#2 | ambiguous_company | pipeline | ACCEPTED | 그냥 서울 지원사업 다 보여줘 | 상태 CLARIFICATION_REQUIRED (기대 READY); QUERY 변경 누락 (기대 포함 지원\|사업\|전체, 제외 서울) |
| M01#3 | support_field | pipeline | ACCEPTED | 수출 쪽만 보여줘 | QUERY 변경 누락 (기대 포함 수출\|해외진출, 제외 서울) |
| M02#1 | region | pipeline | ACCEPTED | 부산에서 하는 수출 지원사업 찾아줘 | REGION 불필요한 변경 '서울특별시' → '부산'; 보호 필드 REGION 변경: '서울특별시' → '부산' |
| M02#3 | region | pipeline | REJECTED | 그럼 회사 소재지를 부산으로 바꿔서 다시 찾아줘 | AI Service 검증 거부(503) |
| M04#1 | target | pipeline | ACCEPTED | 예비창업자인데 청년 대상 거 있어? | QUERY 값 '청년 지원' (기대 포함 청년, 포함 예비창업) |
| M04#2 | target | pipeline | ACCEPTED | 저 만 34세예요 | 상태 CLARIFICATION_REQUIRED (기대 READY) |
| M04#3 | result_reference | result_question | ACCEPTED | 예비창업자도 신청 돼? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M05#1 | scale_amount | pipeline | ACCEPTED | 직원 5명 소상공인인데 교육 지원 있어? | QUERY 값 '교육 지원' (기대 포함 교육, 포함 소상공인) |
| M07#1 | establishment | clarify | REJECTED | 21년 설립이에요 | AI Service 검증 거부(503) |
| M07#2 | establishment | pipeline | REJECTED | 2021.3.15 | AI Service 검증 거부(503) |
| M08#1 | result_reference | result_question | ACCEPTED | 두 번째 거 자세히 알려줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M08#2 | result_reference | more_results | ACCEPTED | 더 보여줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M09#1 | alias_typo_english | pipeline | ACCEPTED | 중기부 알앤디 찾아줘 | QUERY 값 'R&D' (기대 포함 R&D\|알앤디\|연구개발\|기술개발, 포함 중기부\|중소벤처기업부) |
| M09#2 | alias_typo_english | pipeline | ACCEPTED | 코트라 해외진출 사업은? | 상태 ANSWERED (기대 READY); QUERY 변경 누락 (기대 포함 수출\|해외진출, 포함 코트라\|KOTRA, 제외 R&D\|알앤디\|연구개발\|중기부) |
| M11#3 | followup_edit | pipeline | ACCEPTED | 지역은 빼고 | REGION 변경 누락 (기대 해제) |
| M16#3 | followup_edit | pipeline | ACCEPTED | 아니 다시 서울로 | REGION 변경 누락 (기대 '서울') |
| M18#1 | result_reference | compare | ACCEPTED | 1번이랑 3번 비교해줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M18#2 | result_reference | result_question | ACCEPTED | 3번 신청 자격은 어떻게 돼? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M19#2 | result_reference | result_question | ACCEPTED | 두 번째 공고 신청 기간은 언제까지야? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M20#2 | result_reference | compare | ACCEPTED | 첫 번째랑 두 번째 차이가 뭐야? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M20#3 | result_reference | result_question | ACCEPTED | 우리 회사 7년차인데 첫 번째 거 신청 가능해? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M21#1 | result_reference | result_question | ACCEPTED | 3번은 부산 기업도 신청 돼요? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M22#1 | exclusion_multi_intent | multi_intent | ACCEPTED | 수출이랑 R&D 둘 다 찾아줘 | 상태 CLARIFICATION_REQUIRED (기대 READY); QUERY 변경 누락 (기대 포함 수출\|해외진출, 포함 R&D\|알앤디\|연구개발\|기술개발) |
| M22#2 | result_reference | compare | ACCEPTED | 2번이랑 4번 비교해줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M23#1 | result_reference | result_question | ACCEPTED | 3번 공고 원문 링크 줘 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M23#2 | result_reference | compare | ACCEPTED | 그거랑 1번 중에 뭐가 더 나아? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M24#2 | result_reference | zero_result_help | ACCEPTED | 그럼 어떤 조건을 빼면 돼? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M25#1 | result_reference | result_question | ACCEPTED | 이 중에 예비창업자가 신청할 수 있는 건 몇 번이야? | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M25#2 | result_reference | compare | ACCEPTED | 1번이랑 5번 지원 내용 비교 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
| M25#3 | result_reference | more_results | ACCEPTED | 다음 페이지 | 안내 종류 OUT_OF_SCOPE (기대 RESULT_SUMMARY/SEARCH_HELP) |
