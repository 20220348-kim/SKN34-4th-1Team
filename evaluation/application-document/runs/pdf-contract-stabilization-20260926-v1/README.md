# PDF field 계약·선택형 값과 3포맷 1차 안정화 판정

실행일: 2026-09-26. 저장소 `SKN34-4th-1Team`, branch `skn-13`. 이 실행에서 commit·push·PR·배포는 하지 않았다. 고객 원본 PDF, 수정본, base64 요청, API 키는 저장소에 넣지 않았다. 이전 관세청 PDF는 `TECHNICAL_AUX_SAMPLE`이며 제품 제공처의 품질 표본으로 승격하지 않는다.

## 1. Validator mismatch

[이전 관세청 Mapping 채점](../customs-acroform-20260925-v1/mapping.json)은 target 선택 5/5 Correct·Wrong 0이지만 `validate_mapping`이 `MAPPING_TARGET_NOT_EDITABLE_OR_OUT_OF_SCOPE`로 실패했다. [보존된 진단](../customs-acroform-20260925-v1/validator-diagnosis.json)에서 선택된 target 5개가 모두 편집 가능한 `PDF_FIELD`임을 확인했다. 원래 모델의 `scopeTargetIds` 원시 응답은 저장되지 않아 누락된 정확한 target ID는 복원할 수 없다. 따라서 적어도 한 binding target이 scope에 없었다는 결론은 validator 조건과 저장된 target 메타데이터에 근거한 추론이다. 이 Mapping 단계에는 `operation`·`expectedText`·`start`·`end`가 없다. 사람이 구성한 별도 WritePlan 값과 섞어 원래 모델 payload라고 주장하지 않는다.

AcroForm은 모델이 선택한 native `PDF_FIELD` binding만 최소 scope로 구성한다. 저장 binding으로 작성할 때 코드는 현재 필드의 `currentText`를 `expectedText`로, `start=0`, `end=len(currentText)`, `operation=set_field`, `box=null`로 만든다. 다른 형식과 flat PDF의 기존 계획 경로는 유지한다. [저장된 target 선택의 무과금 재현](../customs-acroform-20260925-v1/validator-replay-v15.json)에서 scope가 비어 있으면 같은 reason, binding scope를 만들면 validator PASS였다. 실제 v15 OpenAI 재호출은 0회이므로 이 결과는 실모델 재평가가 아니다.

## 2. 사용자 의미값과 PDF native 선택지

Core inspect가 기존 `options`·`widgets`·`fieldType`에 PDF 원본에서 유일하게 읽힌 `optionMappings[{displayLabel,nativeValue}]`를 추가한다. `PdfFieldInfo`는 이 메타데이터를 AI 문서 지도에 보존한다. Core PDFBox는 사용자 Fact를 다시 원본 필드 선택지와 대조한 뒤 native 값으로 작성한다. 대응이 없거나 중복되어 모호하면 `APPLICATION_DOCUMENT_UNRESOLVED_OPTION`으로 오류를 반환하고 출력 파일을 공개하지 않는다. Web/Shared는 직접 확인 안내를 표시한다. 다른 provider나 새 실행 계층은 추가하지 않았다.

| 유형 | synthetic 회귀 입력 | native 결과 | 검증 |
|---|---|---|---|
| Radio | 위젯 caption `YES/NO`, 중복 export label, 사용자 `NO` | 인덱스 `1`, 위젯 `[Off,1]` | 작성·재열기 PASS; caption 제거 시 `UNRESOLVED_OPTION` |
| Checkbox | caption `Agree`, 사용자 `Agree` / `false` | `Yes` / `Off` | 같은 필드만 on/off, 다른 checkbox 보존; 모르는 값 거절 |
| Choice | 표시 `Alpha/Beta`, export `A/B`, 사용자 `Beta` | `B` | 원본 option 목록 보존·재열기 PASS; `Gamma` 거절 |

관세청 기술 보조 표본에는 radio YES/NO의 native `/0`·`/1` 위젯이 있으나, 위젯에 확정 가능한 option caption 메타데이터가 없어 일반 사용자 `NO`를 자동으로 `1`로 추측하지 않는다. 이전의 사람이 지정한 native `1` 작성 성공과 구분한다.

## 3. 실제 제품 제공처 PDF

[기업마당 부산 치의학산업 신청서와 문화산업 완성보증 동의서](../product-pdf-sample-20260926-v1/README.md)를 우선 확인했다. 각각 9페이지와 1페이지이며 두 문서 모두 기존 AcroForm 필드·위젯 0개인 flat PDF다. 현재 로컬 DB에 수집·추천됐는지는 확인하지 못했으므로 제공처 실공고 첨부 검증으로 한정한다. 이 범위의 선택형 AcroForm은 `PRODUCT_REAL_SAMPLE_NOT_FOUND`; 새 유료 OpenAI Mapping 호출은 0회다. 기존 실제 기업마당 flat PDF는 [이전 FFDetr→Mapping 5/5→PDFBox 5/5 평가](../pdf-e2e-20260925-v1/README.md)가 있다.

## 4. 승인 토큰·binding migration

격리 MySQL 8.4·Redis Testcontainers의 `ApplicationPreparationApiIntegrationTest` **26/26 PASS**. 발급 토큰의 15분 TTL과 TTL 내 정상 승인, 만료 후 거절, 다른 사용자·작성본 거절, 저장 mapVersion 변경 거절, stale answerRevision·원본/pipeline 거절, 승인 후 재사용 거절, 정상 승인 후 작성본 전용 snapshot·Fact·기존 파일 보존을 실제 실행했다. 기존 transaction rollback 테스트도 전체 Core suite에 포함됐다. 실제 운영 DB·배포 검증은 수행하지 않았다.

## 5. 최종 회귀

| 범위 | 최종 실행 결과 |
|---|---|
| AI | `uv run --locked --extra dev python -m pytest tests/test_document_mcp_contract.py tests/application_preparation`: **218 passed** |
| Shared | 전체 19 tests, typecheck, lint PASS |
| Web | 전체 1,269 tests, lint, `tsc -b && vite build` PASS. 병행 실행의 기존 관심 공고 테스트 timeout은 단독 전체 재실행에서 통과 |
| Core | 임시 JDK 21 컨테이너 내부의 현재 Core 소스 복사본에서 `gradle clean build --offline --no-daemon --max-workers=1`: **168 classes, 1,539 tests, failures 0, errors 0, skipped 0**, build PASS. 실제 MySQL·Redis·RabbitMQ·Elasticsearch Testcontainers 포함 |
| 공통 | `git diff --check` PASS. 원격 CI·배포 `NOT_RUN` |

최종 Core 실행 전에 Windows 바인드 마운트 경로의 느린 classpath 탐색과 캐시 1개 설정의 MySQL 연결 timeout을 겪었다. 컨테이너 내부 파일시스템의 첫 전체 실행은 임시 복사본에 저장소의 `infrastructure/elasticsearch/Dockerfile`을 누락해 1,531개 중 해당 통합 테스트 1개가 실패했다. 파일을 임시 컨테이너에 포함한 뒤 실패 클래스 단독 PASS, 이어 동일 소스의 최종 전체 clean build가 PASS했다. 이 실패들을 최종 통과 결과로 덮어 쓰지 않고 실행 조건·원인을 구분한다.

## 6. 범위별 판정

| 영역 | 상태 | 근거·한계 |
|---|---|---|
| HWP | `STABLE` | 이전 공식 표본 Mapping/Write/재열기 8/8, Wrong 0; 이번 관련·전체 Core 회귀 PASS |
| HWPX | `STABLE` | 이전 여러 공식 표본 Mapping 10/10, Wrong 0·native write; 대형 후보 축소·이관 경로·전체 회귀 PASS |
| Flat PDF | `STABLE` | 이전 기업마당 실제 신청서 FFDetr→Mapping 5/5·PDFBox 5/5·렌더; 전체 회귀 PASS |
| AcroForm Text | `PARTIAL` | EPA 공식 문서 Mapping 7/7·write 5/5, 관세청 기술 표본 text write 4/4; 제품 제공처 fillable 미확보 |
| AcroForm Radio | `NOT_FULLY_TESTED` | 관세청 native 실파일 작성과 synthetic 의미값 변환 PASS, 제품 제공처 실문서 미확보 |
| AcroForm Checkbox / Choice | `NOT_FULLY_TESTED` | synthetic 작성·거절 회귀 PASS, 제품 제공처 실문서 미확보 |
| Binding migration / Approval Security | `STABLE` | 작성본 전용 승인·보존·rollback 및 26개 MySQL/Redis 통합 테스트 PASS |

`STABLE`은 확인한 공식 표본과 현재 프로젝트의 지원 범위에 대한 **1차 안정화**이며 모든 문서·선택형 PDF의 자동 작성을 뜻하지 않는다. 한국 제품 제공처의 fillable checkbox/choice, 실제 Reader UI 재편집, v15에서의 신규 OpenAI AcroForm Mapping, 원격 CI·배포는 미검증이다. 유일하게 기존 실모델 run에서 확인된 validator reason은 코드 생성 scope와 저장 target 재현에서 해결됐으나, 원래 저장되지 않은 모델 scope 원문을 복원한 것은 아니다.

## 7. 결정과 다음 단계

**`READY_FOR_NEXT_FORMAT`**. 확인된 Wrong Target는 0이고, 관측한 validator mismatch의 원인 경로를 코드가 소유하며, 불명확한 선택형 값은 미작성 오류로 중단한다. binding migration·승인 보안·전체 clean regression이 통과했다. 남은 AcroForm 선택형 문제는 현재 검사 범위의 제품 실문서 표본 부재와 운영 QA다. 다음 단계는 **A. DOCX Adapter 시작**이다. 이 판정은 DOCX를 이번 작업에서 구현하거나 제품 PDF 전종의 지원을 선언하는 뜻이 아니다.

## 8. Git 상태

`skn-13`의 기존 미커밋 작업을 보존했다. 이번 요청에서 새 commit 0, push 0, PR 0, history rewrite 0이다. 평가 원본과 결과 PDF는 저장소에 포함하지 않았다.
