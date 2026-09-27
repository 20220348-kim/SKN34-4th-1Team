# XLSX 안정화 r2 — PR_READY

판정은 아래 지원 범위의 로컬 안정화·PR 준비 가능 여부다. 전체 repository/원격 CI 통과 또는 배포 완료를 의미하지 않는다. 커밋·push·PR·history rewrite는 수행하지 않았다.

## 1. Excel 실제 Open

설치된 Microsoft Excel을 computer-use로 직접 열었다. 원본 binary는 보존하고 저장은 저장소 밖 별도 사본에만 수행했다.

| 공식 문서 | 원본/작성본 | 복구·손상 경고 | Sheet | 작성값 육안 확인 | 시각 이상 |
|---|---|---|---|---|---|
| 공공구매 기업목록 | 모두 PASS | 관찰 없음 | 기업목록 1개 | B4 테스트기업, C4 홍길동, D4 테스트제품, G4 02-0000-0000, H4 demo@example.org | 관찰 없음 |
| KSC 국문 신청서 | 모두 PASS | 관찰 없음 | 신청서(국문) 1개 | B3 미국 시애틀, B6 홍길동, B7 테스트기업, F7 Test Company, G14 demo@example.org | 관찰 없음 |
| 책임보험료 계산기 | 모두 PASS | 관찰 없음 | 2025년 1개 | C5 테스트서비스, D5/E5 날짜, F6 1,000,000 | 관찰 없음 |

폰트·정렬·border·fill·number format·행/열 치수에 작성으로 인한 눈에 띄는 차이가 없었다. 기존 두 작성본을 Excel Save As→닫기→재열기 했고 같은 5개 값이 유지됐다. 계산기는 원본/작성본 open만 수행했다. 복구 경고와 recovery log는 관찰되지 않았다. [실제 열기·저장 증거](excel-structure-evidence.json).

## 2. Formula

기존 두 표본은 formula 0개다. 추가 공식 계산기는 17개: G6:G9 DATEDIF, H6:H9 MIN/IFERROR, I6:I9 지원금 계산, F10/I10 SUM, F13/F14/F15 계산이다. 대표 G6=`=DATEDIF(D6,E6,"D")`, F13=`=F10`. 전부 editable=false이며 Mapping scope의 4개 안전 입력에 들어가지 않는다. 계산 결과 4개 GT probe도 전부 unmapped, overwrite 0. 주소·문자열·styleId 및 원본 XML cached value가 native 작성 후 동일하다. Python 재계산은 하지 않았다.

## 3. Protected

추가 공식 표본은 sheet protection=true, workbook protection 없음. 잠긴 셀은 후보·write에서 제외된다. C5/D5/E5/F6은 명시적으로 unlocked인 안전 입력이며 실제 작성 4개가 성공했다. sheet protection·locked/unlocked 속성은 원본과 동일하다. 보호 우회 0. Workbook structure protection 차단은 synthetic 단위 테스트에서 확인했다.

## 4. Hidden

세 공식 workbook 모두 hidden/veryHidden sheet·hidden row·hidden column 없음: **OFFICIAL_SAMPLE_NOT_FOUND**. 공식 hidden 일반화는 검증하지 않았다. Synthetic veryHidden sheet, hidden row, grouped hidden column, 숨긴 label, named lookup table 테스트는 후보 제외·계획 거절·Mapping scope 차단을 확인했고 unsafe write 0이다. [안전 경계 증거](safety-evidence.json). 공식 근거와 synthetic 근거를 구분한다.

## 5. Data Validation

KSC는 list 규칙 2개. B3 allowed option `미국 시애틀`을 실제 작성했고 Excel native dropdown의 7개 option·값·재열기 유지까지 확인했다. 비허용값 `공식 목록에 없는 국가`는 파일에 쓰지 않고 validator가 `APPLICATION_DOCUMENT_MAPPING_FAILED / UNRESOLVED_OPTION`으로 거절함을 확인했다. 다른 option의 원문 leading space도 그대로 유지하며 의미를 추정하지 않는다.
추가 계산기의 8개 규칙은 type 생략(None), formula 없음인 안내문이다. 이를 제약 list로 오인하던 동작만 수정했다. 단일 안내문은 promptOnly로 보존하며 numeric/date 검증은 유지한다. 새 관련 테스트 4개 통과. 실제 whole/decimal/date/custom constraint·동적 option은 자동 작성 미지원, 공식 표본 검증 없음.

## 6. 추가 공식 XLSX

기존 표본에 formula/protection이 없어 기업마당의 [2025 금융 테스트베드 책임보험료 지원금 계산기](https://www.bizinfo.go.kr/see/seeh/selectSmesPblancView.do?pblancId=PBLN_000000000107933)를 **한 개** 추가했다. [공식 첨부](https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_000000000709686&fileSn=0), SHA-256 `c014d40d7648f8c43dd71f07a37c784fa5fa6720ae157a80364e5b39c9614517`. Sheet 1, raw XML dimension A2:I21(openpyxl snapshot A1:I21), merge 0, formula 17, validation 8, 보호 sheet, hidden 없음.
GT 8개=실제 입력 4개+계산 결과 차단 probe 4개. 정답 ID·writability는 모델 입력에서 제외했다. 허용된 OpenAI Mapping 1회: 안전 입력 Correct 4/Wrong 0/unmapped 0, 읽기 전용 unmapped 4/4, unsafe binding 0. 기존 16개 정답은 재호출하지 않았으며 Wrong 0을 유지한다. GT는 agent 작성이며 독립 사용자 검토 정답이 아니다. [Mapping](../xlsx-fintech-stabilization-r2-20260927-v1/mapping.json), [구조·후보](../xlsx-fintech-stabilization-r2-20260927-v1/preflight.json), [작성](../xlsx-fintech-stabilization-r2-20260927-v1/write-verification.json).
검색 중 검토한 광주콘텐츠 지원금 양식은 VML object/잘못된 style index가 있어 제외했다(SHA `b1ed33598aa3386116de124f410c8e9cf711bcaf3c14adcf4aa9247b92a428c6`). 바이너리 수리·object 제거·유료 호출 없이 미지원으로 남겼다.

## 7. 구조 보존

세 native 작성본의 sheet names/count, merged ranges(1/36/0), formula, validation, hidden, protection, freeze panes, defined names, row heights/column widths, conditional formatting이 원본과 동일하다. 작성 셀의 값 payload 외 모든 worksheet XML과 ZIP part를 검증했고 style/font/fill/border/alignment/number format을 보존했다.
Excel 재저장은 직렬화·치수를 정규화한다. purchase viewport topLeftCell C4→B4(동결 split 유지), 행7 17.25→18, 열 너비 소폭 변화; startup 일부 열 너비 정규화·빈 셀 D3/G28/H28 vertical alignment 기본값화가 있었다. **원본도 같은 Excel Save As로 저장하자 작성본 사본과 구조·스타일이 완전히 동일**했다. 작성값도 유지됐다. 이를 native writer 손상이나 byte-identical Excel Save As로 표현하지 않는다. [원본 저장 대조군과 실제 diff](excel-structure-evidence.json).

## 8. Core ↔ AI ↔ Storage ↔ Download

안정화 이후 실제 TCP Core HTTP→AI HTTP inspect→기존 Mapping fixture→WritePlan fixture→native generate→MySQL 8.4 storage→download HTTP 200→reopen을 **한 번** 실행해 PASS. Redis도 실제 Testcontainer다. 유료 모델 경계와 공식 binary 획득만 fixture이며 API 호출 0회. Content-Type XLSX, filename .xlsx, 원본 SHA 불변, output SHA 생성, dummy 값 5개, merge/style/formula/validation 구조 확인 PASS. [단계별 결과](http-smoke-evidence.json).

## 9. Version / Cache

XLSX `govbiz/xlsx-native@2+openpyxl-3.1.5`. 안내문 validation 판정 수정으로 @1→@2, XLSX 지도·생성 fingerprint만 변경한다. 실제 latest main의 HWP/HWPX/PDF/DOCX 엔진·mapVersion·planVersion은 동일하며 pipeline SHA `2cacb34e74db390dddd98402e5d2703823794b40781b2e24803db03254be867d` 유지. 기존 cache-hit와 XLSX engine 전용 invalidate 테스트가 전체 회귀에서 통과했다. [버전 증거](version-evidence.json).

## 10. Regression

실제 fetch 후 latest main `b5f8ab05125185a48197d468c7ec672af93e82b0`의 깨끗한 별도 checkout과 skn-17을 실행 비교했다. [실패별 비교](regression-comparison.json).

| 영역 | latest main 실제 결과 | skn-17 실제 결과 | 신규 실패 |
|---|---|---|---|
| AI full | 1460 passed / 2 failed | 1512 passed / 2 failed | 0, 같은 bootstrap FakeChatOpenAI.model_name 누락 |
| Core clean build | 1547 tests / 6 failed / 1 skipped | 1553 tests / 6 failed / 2 skipped | 0, 실패 identity/type/message 동일 |
| XLSX·문서 관련 | 관련 suite 실패 0 | 관련 suite 실패 0; XLSX AI 52개 통과 | 0 |
| Web full | 실패 파일 46개 단독 PASS | 1270 passed / 1 async 실패; 실패 파일 46개 재실행 PASS | 지속 재현 신규 0, full run은 FAIL |
| Web lint·typecheck·build | 비교 목적의 전체 실행 안 함 | PASS(tsc -b + vite build) | 관련 새 오류 없음 |
| Shared full·lint·typecheck | 전체 baseline 미실행 | 19 passed·lint/typecheck PASS | 실행 범위 실패 0 |

Core 6개는 account concurrent reset HTTP429 1개, Windows POSIX attribute 미지원 5개이며 **모두 main에서도 실제 재현**했다. opt-in XLSX HTTP skip은 별도 실행 PASS로 보완했다. Web async heading 조회 실패는 main/skn-17 해당 파일이 모두 통과해 일시적 full-run 실패로 구분하며 테스트/timeout을 완화하지 않았다. 기존 큰 Vite chunk 경고 유지.
명령: AI `uv run --locked --extra dev python -m pytest --basetemp=tmp/pytest-{main,skn17}-r2`; Core JDK21 `./gradlew.bat clean build --no-daemon`; Web `pnpm --filter govbiz-web test --maxWorkers=1`, `lint`, `build`; Shared `pnpm --filter @govbiz/shared test`, `lint`, `typecheck`. 로컬 Windows AF_UNIX는 프로세스 임시 경로 설정으로 JDK TCP fallback을 사용했으며 production 설정 변경 없음. 최종 diff/신규 파일/JSON·Python syntax 검증은 [최종 점검](final-checks.json)에 기록한다. 원격 CI는 commit/push 금지로 미실행·검증 대기다.

## 11. Frontend 분류

Frontend - Web: XLSX MIME·확장자·download adapter 연결과 관련 테스트, full tests/lint/typecheck/production build 검증.
Frontend - Mobile: 변경 없음. Shared 지원형식 오류 문구 변경의 full tests/lint/typecheck를 수행했다. Mobile 전체 번들·실기기 검증은 실행하지 않았다.

## 12. XLSX 지원 범위

| 기능 | 상태 | 경계 |
|---|---|---|
| Basic Cell Form | STABLE | 라벨 근거가 있는 빈 native 입력 셀 |
| Merged Cell | STABLE | master만 작성, child 제외; 공식 merge36개 포함 |
| Formula Preservation | STABLE | 공식17개 보존·후보 차단; 재계산 엔진 제공 아님 |
| Data Validation / Dropdown | PARTIAL | 해석 가능한 list와 단일 promptOnly; 실제 non-list constraint 미지원 |
| Hidden Sheet/Row/Column | NOT_FULLY_TESTED | 차단 synthetic PASS, 공식 hidden 표본 없음 |
| Protected Cell/Sheet | PARTIAL | 공식 sheet locked 제외/unlocked 작성 PASS; workbook 보호 synthetic |
| Style Preservation | STABLE | native exact 보존, Excel 저장 원본 대조군 동일 |
| Complex Workbook | UNSUPPORTED | macro/external link/drawing/embedded/ActiveX/form control/signature 차단 |

## 13. 남은 limitation

공식 hidden 표본·독립 GT 검토·원격 CI 미완료. 반복 표의 첫 슬롯만 후보로 쓰므로 계산기의 모든 unlocked 입력을 자동화하지 않는다. 지원하지 않는 validation/objects/복잡 구조는 오류로 중단하며 보호를 우회하거나 fallback으로 성공 처리하지 않는다. 모델 품질 일반화·성능 효과를 측정하지 않았다. 추가 유료 호출 한도는 이미 사용했으며 재시도하지 않는다. full AI/Core/Web의 기존/일시적 실패는 남아 있다.

## 14. 최종 판정

**PR_READY — 명시된 지원 범위에서 XLSX PR 준비 가능.** Excel 실제 open·기존 두 문서 Save As/reopen, Wrong Target 0, formula/unsafe scope 차단, native 구조 보존, 실제 서비스 smoke, 기존 네 형식 버전/cache·관련 회귀를 확인했다. 관찰된 미해결 XLSX CRITICAL/HIGH 0. 전체 repository·CI 성공을 선언하지 않는다.

## 15. 다음 단계

**XLSX PR 준비.** 별도 요청 시 최신 main 반영 후 검증 상태·기존 실패를 포함해 단일 커밋과 push까지 준비한다. 이번에는 실행하지 않는다.

## 16. Git 상태

branch skn-17. 모든 현재 작업은 미커밋·unstaged. 신규 commit 0, push 없음, PR 없음, history rewrite 없음. 사용자 기존 skn-13 계정 테스트 변경은 보존했다. 원본/작성 XLSX·API key·사용자 개인정보·base64 payload·임시 파일·Excel lock file은 평가 저장소에 넣지 않았다. [Git 최종 점검](final-checks.json).
