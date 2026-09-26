# 저장 binding 명시적 이관과 AcroForm 실문서 검증

실행일: 2026-09-25. 대상: `SKN34-4th-1Team`, branch `skn-13`. 공식 문서 원본·수정본과 API 키는 저장소에 넣지 않았다. 아래의 로컬 검증, 실제 OpenAI 호출, 원격 CI·배포를 구분한다.

## 1. 기존 binding 이관 흐름: Before / After

변경 전에는 새 AI pipelineVersion에서 저장 binding 또는 편집 scope가 달라지면 Core가 422로 중단했고, 사용자가 변경을 확인해 기존 작성본을 복구할 경로가 없었다. 변경 후에는 기존 생성 요청의 422 `ProblemDetail.mappingMigration`에 문항별 기존/새 위치 문맥, changeType 및 15분 승인 토큰을 포함한다. 승인 전 새 지도는 활성 MySQL 행에 쓰지 않고 기존 Redis에 짧게 보관한다. 사용자가 취소하면 기존 지도·답변·파일은 유지된다.

승인 `POST /api/v1/application-preparations/{id}/documents/mapping-migration/confirm`은 소유권, `inputRevision`, 원본 재수집 SHA-256, 현재 AI pipelineVersion과 기존 지도 상태를 확인한다. 하나라도 바뀌면 `APPLICATION_DOCUMENT_MAPPING_MIGRATION_STALE`로 거절한다. MySQL transaction은 승인된 작성본 전용 `approved-...` 양식 스냅샷을 만들고 그 작성본의 `form_version_id`만 CAS로 변경한다. 원래 공용 스냅샷과 다른 사용자의 작성본은 유지된다. 답변 revision을 올리거나 기존 생성 파일을 덮어쓰지 않는다. 반환 상태 `REGENERATION_REQUIRED` 뒤 새 초안 생성은 별도 사용자 클릭이다. 새 DB migration·외부 서비스·production 의존성은 추가하지 않았다. [상세 흐름](../binding-migration-20260925-v1/README.md)

## 2. Binding Diff contract

내부 비교는 fact ID·target ID·binding box, PDF 필드의 kind·page·widget/box 위치와 편집 scope를 사용한다. Semantic heading·reading-order metadata만 바뀌면 이관 대상으로 보지 않는다. 공개 응답은 native target ID를 노출하지 않고 문항명·기존/새 위치 문맥을 제공한다.

| changeType | 뜻 |
|---|---|
| `TARGET_ADDED` / `TARGET_REMOVED` | 문항의 입력 위치가 생기거나 없어짐 |
| `TARGET_CHANGED` | 하나 또는 여러 입력 target이 달라짐 |
| `BOX_CHANGED` | binding box 또는 PDF field/widget 페이지·위치가 달라짐 |
| `KIND_CHANGED` | 입력 방식이 달라짐 |
| `SCOPE_CHANGED` | 선택한 문서 편집 범위가 달라짐 |

## 3. 사용자 승인 흐름

Web 문서 결과 화면은 변경된 문항과 기존/새 위치를 보여주고 **새 입력 위치 적용**과 **취소하고 기존 작성 유지**를 분리한다. 취소는 확인 API를 호출하지 않는다. 승인 후 기존 파일은 계속 다운로드할 수 있으며 **새 초안 생성** 버튼을 따로 눌러야 한다. 다른 계정의 토큰 사용, 토큰 재사용, 답변 revision·공식 원본·AI pipeline 변경 뒤 확인은 거절한다.

## 4. MySQL 검증

격리 MySQL 8.4 통합 테스트에서 구버전 지도와 확인된 답변·revision 2·기존 파일을 저장한 뒤 새 버전 드리프트를 재현했다. 승인 전 기존 지도·fact·파일·revision 유지, 승인 후 작성본별 새 스냅샷과 이전 공용 스냅샷 분리, 다른 사용자의 formVersionId 보존, 재생성 시 별도 파일 추가를 확인했다. clone 삽입 뒤 revision CAS 실패를 일으킨 경우 transaction rollback으로 새 스냅샷 행이 남지 않았다. 운영 DB·실제 배포에는 적용하지 않았다.

## 5. 기존 Fact / Answer 보존

`application_preparation_fact.value_text`와 `application_preparation.input_revision`은 이관 승인 전후 동일했다. binding은 입력 위치이며 사용자가 확인한 Fact 자체를 옮기거나 삭제하지 않았다. 새 지도에서 위치가 없어진 선택 문항은 `TARGET_REMOVED`로 검토할 수 있지만, 필수 문항의 미매핑은 기존 지도 검증에서 계속 실패한다.

## 6. 생성 파일 재생성 정책

기존 `application_document_file` 행과 소유자 다운로드는 보존한다. AI pipelineVersion을 포함한 generation fingerprint가 바뀌므로 이전 파일이 새 버전 cache hit로 반환되지 않는다. 사용자가 새 초안 생성을 요청하면 새 파일 행을 추가한다. 자동 덮어쓰기나 승인 직후 자동 유료 생성은 없다.

## 7. AcroForm PDF 결과

[미국 EPA의 공식 보조금 신청용 Key Contacts Form](https://www.epa.gov/grants/epa-applicant-and-recipient-forms)의 [PDF](https://www.epa.gov/system/files/documents/2021-08/epa_form_5700_54.pdf)를 사용했다. 원본 250,983 B·2페이지·SHA-256 `0cb27836b74d5f469e4ddac81fd294555516ed529b9a8d7b49ee816fa7d9a89c`, 기존 텍스트 필드·위젯 60개, XFA 없음이다. Core/PDF MCP inspect와 사람 렌더 대조로 `Authorized Representative` 구역 7개 필드를 Ground Truth로 고정했다. 반복되는 이름의 다른 세 구역이 있었지만 실제 `gpt-5.6-luna` Mapping **1회**는 Correct **7/7**, Wrong **0**, Unmapped **0**, validator PASS였다. Ground Truth target ID는 모델 응답 후 채점에만 사용했다.

모델이 고른 위치 중 5개에 가상값을 쓰는 WritePlan은 추가 유료 호출 없이 검증해 PDF MCP → Core PDFBox로 전달했다. 처음에는 공식 위젯 높이 약 12.7pt가 기존 10pt·세로 4pt 여백 조건에 걸려 `OVERFLOW`였다. 최소 8pt 가독성 조건을 유지한 크기 조정 후 작성·재열기에서 값 **5/5**, 필드·위젯 **60/60**, appearance **5/5**, 다른 필드 값 **55/55** 보존을 확인했다. 두 페이지 렌더 변경 픽셀은 첫 페이지의 선택된 위젯 안에만 있었으며 Core 재inspect도 필드 60개를 읽었다. 공식 표본에는 checkbox/radio/choice가 없으므로 그 유형과 실제 Reader UI 재편집은 `NOT_RUN`이다. 한국 제공처의 AcroForm 수집 경로도 이 표본으로 검증한 것은 아니다. [실행 기록](../acroform-pdf-20260925-v1/README.md)

## 8. 오류 심각도

| 심각도 | 발견·처리 |
|---|---|
| CRITICAL 방지 | 승인 없는 공용 binding 변경은 기존 작성본을 다른 칸에 기입할 수 있으므로 공용 지도를 보존하고 작성본별 승인 스냅샷으로 분리. 실제 오기입 사례는 관찰하지 않음 |
| HIGH | AcroForm의 반복 필드명에서 wrong field를 막기 위해 실제 native field label을 지도에 포함; 7/7 실문서 선택 검증 |
| MEDIUM | 짧은 공식 AcroForm 위젯의 `OVERFLOW`를 재현하고 최소 8pt 조건 안에서 해결 |
| LOW | 이전 422의 포괄 질문 안내 대신 위치 변경 비교·승인 상태를 구체적으로 표시 |

## 9. 수정 파일

- Core: 지도 변경 비교, Redis 승인안, owner별 MySQL 스냅샷 복제·CAS, 문서 확인 API/DTO, 기존 AcroForm 필드 fit 검사와 관련 테스트.
- AI: `PDF_FIELD` native `fieldLabels`와 계약 회귀 테스트; `mapVersion=native-map-v13-pdf-field-labels`.
- Shared/Web: 이관 응답 타입·검증, 결과 화면의 비교·승인·취소·별도 재생성 및 관련 테스트.
- 평가·설명: `evaluation/application-document/`의 실파일 Ground Truth·결과, Core README와 아키텍처 문서.

## 10. 최종 전체 회귀

| 범위 | 실제 실행과 결과 |
|---|---|
| Shared | 전체 19 tests, typecheck, lint 통과 |
| Web | 전체 1,269 tests, lint, `tsc -b && vite build` 통과. 기존 500 kB 초과 번들 경고 있음 |
| AI | `uv run --locked --extra dev python -m pytest -q` 전체 통과. 첫 실행의 98개 실패는 로컬 tokenizer 캐시의 네트워크 차단이었고 새 AcroForm fixture 1개는 수정했다. 고정 AI 이미지의 동일 tokenizer 캐시를 임시 폴더에 제공한 최종 실행은 exit 0 |
| Core Windows/JDK 21 | `clean build`를 수행해 POSIX 전용 메서드 5개를 실행 장소별로 분리한 **1,529 tests, failures 0, skipped 0**, build 통과. 첫 무분리 실행은 1,534개 중 Windows POSIX 5개와 비밀번호 제한 상태 공유 1개가 실패했다 |
| Core Linux/JDK 21 | POSIX 해당 메서드를 포함한 `SupportProgramRepositoryIntegrationTest` 1개와 `SupportProgramCatalogSyncOnceServiceTest` 9개, 실제 MySQL 8.4에서 **10/10 통과**. 비밀번호 3개는 context 격리 후 통과 |

단일 Linux 전체 clean build는 확인하지 못했다. 첫 시도는 테스트 535개 후 검증 컨테이너 메모리 종료 137, 두 번째 시도는 Spring context 캐시 누적으로 진행을 중단했다. 임시 메모리·cache 제한으로 재시도한 전체 Linux 실행은 시간이 크게 늘어 완료 전 중단했다. 이는 성공으로 기록하지 않는다. Windows clean build와 Linux POSIX 선택 검증의 범위·실행 장소를 합쳐 결과를 판단한다. 원격 CI·배포 검증은 `NOT_RUN`이다. 최종 `git diff --check` 결과는 작업 완료 시 별도 확인한다.

## 11. 포맷 최종 상태

| 형식 | 상태 | 근거·한계 |
|---|---|---|
| HWP | `PARTIAL` | 이전 공식 표본 Mapping 8/8·hwplib write/reopen 8/8, 이번 Core 회귀 통과. 새 모델 재호출·한글 화면 미실행 |
| HWPX | `PARTIAL` | 이전 다수 공식 표본과 대형 양식 Mapping 10/10·native write 통과. 최신 v13에서 새 유료 재호출·한글 화면 미실행 |
| Flat PDF | `PARTIAL` | 이전 공식 부산 표본 FFDetr→Mapping 5/5→PDFBox 5/5. 다른 flat 공식 문서 일반화 미실행 |
| AcroForm PDF | `PARTIAL` | 이번 EPA 공식 텍스트 필드 Mapping 7/7·PDFBox write 5/5. 한국 제공처·선택형 필드·Reader UI 미실행 |

## 12. 3포맷 1차 안정화 판단

**`NEEDS_MORE_STABILIZATION`**. 현재 요청의 사용자 승인 경로와 AcroForm 텍스트 필드 실문서 검증은 완료됐지만, AcroForm 표본 1개의 결과를 모든 PDF 유형·제공처로 일반화할 수 없다. 실제 OpenAI WritePlan 선택, 선택형 AcroForm 및 배포 대상 커밋의 원격 CI는 남았다.

## 13. 다음 단계

**C. 추가 실제 PDF 일반화**를 권장한다. 한국 공식 제공처의 기존 AcroForm 또는 다른 공식 fillable PDF에서 동일한 native field Mapping·write를 확인하고, checkbox/radio/choice가 실제로 있으면 그 유형만 평가한다. 새 parser·DOCX·Docling 도입 근거는 이번 실패에서 확인되지 않았다.

## 14. Git 상태

현재 branch는 `skn-13`이며 기존 working tree를 유지했다. 이번 요청에서 commit·push·PR·배포·history rewrite는 하지 않았다. 원본 PDF와 출력 PDF는 임시 평가 폴더에만 있다.
