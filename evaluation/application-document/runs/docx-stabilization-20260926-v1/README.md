# DOCX 1차 안정화 검증

2026-09-26, `skn-14` 미커밋 상태. 원본·작성본 DOCX 바이너리는 로컬 임시 폴더에만 두었고 저장소에는 넣지 않았다. 더미 값 외의 사용자 답변은 사용하지 않았다.

## 공식 표본과 Ground Truth

Ground Truth는 Codex가 공식 OOXML의 라벨과 주소를 대조해 만든 기준값이다. 독립적인 사람·기관 검수는 수행하지 않았으며 모델 정답을 사람이 확인한 것으로 표시하지 않는다.

| 문서 | 공식 공고 | 원본 SHA-256 | 문단/표/내용 컨트롤 | Ground Truth | 후보 |
|---|---|---|---:|---:|---|
| KOTRA 참가신청서 | [기업마당](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000117178) | `26a761197b64aaf884cd6636851d423f7d1a51686249d418a1f2c3e57ab50cd7` | 150/1/0 | 10 | exact 10, ambiguous 0, wrong 0, unmapped 0 |
| 대전·세종 글로벌 진출 신청서 | [기업마당](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000124653) | `4679e04cb697c931352fa4f237b38e6c78817a651d777c335e07e1747f1e6b26` | 255/20/0 | 12 | exact 12, ambiguous 0, wrong 0, unmapped 0 |
| 의정부 시티온 신청서 | [기업마당](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000124572) | `7fcf8810dcd23441771f1e9696e7fc422d48ce5a0ec1b8a93c7fad75de117c7b` | 378/13/0 | 8 | exact 7, ambiguous 1, wrong 0, unmapped 0 |

의정부의 `기업명`은 첫 신청서와 뒤쪽 서식에 반복되어 후보 2개다. 인쇄된 `□ 동의 / □ 거부` 옆 빈 셀 5개는 native checkbox가 아니므로 `PRINTED_CHECKBOX_NOT_NATIVE`로 편집 후보에서 제외했다.

## OpenAI Mapping

- 기존 KOTRA 기록: `gpt-5.6-luna` 1회, Correct 10, Wrong 0, Unmapped 0, Wrong Target Rate 0.
- 대전·세종: `gpt-5.6-luna` 1회, Correct 12, Wrong 0, Unmapped 0, Wrong Target Rate 0. [평가 결과](../docx-daejeon-global-2026-v1/mapping.json).
- 의정부: 허용된 1회 호출의 structured JSON이 24,781자 지점에서 끝나 `ValidationError`로 파싱 실패했다. 유효한 binding을 받지 못했으므로 Correct/Wrong/Unmapped와 Wrong Target Rate는 계산하지 않는다. [호출 상태](../docx-uijeongbu-startup-2026-v1/mapping-attempt.json).
- 위 호출 뒤 DOCX 모델 입력에서 읽기 전용 target을 제외했다. 의정부 문서의 모델 전송 target은 352개에서 17개, target JSON은 약 228,300자에서 11,128자로 줄었다. 이 변경 후 추가 유료 호출은 실행하지 않았으므로 최종 매핑 정확도는 미검증이다.

## Native Write와 Word 렌더

| 문서 | 더미 값 작성·재열기 | 작성본 SHA-256 | Word 원본→작성본 페이지 | 관찰 |
|---|---:|---|---:|---|
| KOTRA | 5/5 | `badf9b3ac4914f7aa542974e48e2a7f2110a41bf1978ffb3d18ed9e932184030` | 2→2 | 대표 첫·끝 페이지에서 큰 밀림 관찰되지 않음 |
| 대전·세종 | 5/5 | `65ddc033454eb1be9ea400cb1ca243e001edb92a64006be241ab4090bf05fdbb` | 7→8 | 짧은 더미 값 5개로 페이지가 1장 증가. 값 없이 OOXML만 재직렬화한 대조본은 7페이지 |
| 의정부 | 4/4 | `0d2f146a33238e55cdc5c4231133e0e32845bebe6dbbba45e343c9b914a0f48a` | 12→12 | 첫 페이지 표와 주요 제목에 큰 차이 관찰되지 않음 |

세 작성본 모두 Word에서 복구 경고 없이 열렸다. KOTRA의 초기 작성본은 namespace alias가 빠져 Word 복구 경고를 냈고, 원본 namespace 선언을 보존하도록 수정한 뒤 위 SHA-256의 작성본으로 다시 검증했다. XML 검증은 대상 값, 다른 target 텍스트, 표·행·셀·병합, 내용 컨트롤 수와 스타일 속성을 검사했다. Word 시각 검토는 페이지 수 및 대표 첫·끝 페이지 표본에 한정된다. LibreOffice는 설치되지 않아 실행하지 않았다. 폰트 fallback의 모든 페이지와 실제 사용자 길이의 값을 검증한 것은 아니다.

빈 입력칸에 기존 run이 있으면 재사용하고, 새 run이 필요하면 문단의 `pPr/rPr` 문자 속성을 복사한다. 이 글꼴 보존 수정 후에도 대전·세종 표본의 페이지 수는 8페이지로 남았다.

세 공식 표본 모두 native content control과 native checkbox가 0개라 실문서 상태는 `OFFICIAL_SAMPLE_NOT_FOUND`다. 합성 DOCX의 text control·checkbox 편집과 상태 검증은 단위 테스트로 별도 유지한다.

## 서비스·버전·회귀

Core에는 공식 첨부 수집과 문항 파싱, DOCX 요청 DTO 전달, 결과 hash·engineVersion·재열기 상태 검사, MySQL 저장 및 다운로드의 관련 테스트를 추가했다. 공식 KOTRA 원본과 실제 AI adapter 작성본을 공급한 Core MockMvc→Service→MyBatis→MySQL 8.4→다운로드 테스트가 통과했다. AI MCP 호출 자체는 테스트 대역이다. AI 쪽 HTTP map/generate와 outputBase64는 실제 adapter·테스트 Agent로 검증했다. Web의 DOCX 응답·다운로드 계약은 HTTP 대역 테스트다. 로그인 브라우저의 unmocked Web→Core→AI 전체 E2E는 미실행이다. 현재 제품은 사용자 업로드가 아니라 공식 첨부 Client를 원본 진입점으로 사용한다.

기존 HWP/HWPX/PDF `mapVersion`과 공통 `pipelineVersion` hash `2cacb34e74db390dddd98402e5d2703823794b40781b2e24803db03254be867d`는 유지한다. DOCX 전용 `engineVersion`은 Word 호환성 수정 이후 `govbiz/ooxml-native@2`다. Core는 DOCX 저장 지도와 현재 engineVersion을 비교해 재매핑하고, 생성 fingerprint에도 DOCX engineVersion을 포함한다. 다른 세 포맷의 캐시·fingerprint 식은 유지한다.

회귀 결과:

- AI 전체 pytest: 최종 코드에서 실패 0·setup 오류 0. DOCX 15개 단위/HTTP 테스트 포함. 초기에 병렬 실행으로 기존 logging subprocess 3개가 timeout됐으나 단독 전체 재실행에서 통과했다.
- Core DOCX 영향 범위 전체: Linux JDK 21, 실제 MySQL 8.4의 `clean test`와 `bootJar`, 18개 suite·147개 테스트 전부 통과. application preparation, 문서 parser, mapping, 저장·다운로드, 네 제공처 첨부 Client가 포함된다. `live-source` tag는 기본 정책대로 제외했고 OpenAI 호출은 없다.
- Core 저장 map의 HWP/HWPX/PDF cache hit 3건, DOCX engine 변경 시 재매핑 및 기존 파일 유지 테스트 통과. 최종 MSIT DOCX 다운로드 패턴 수정 뒤 네 제공처 첨부 Client 4개 suite·20개 테스트와 `bootJar`를 다시 실행해 모두 통과했다.
- 전체 Core `clean build` 시도는 기존 `AccountPasswordResetFlowIntegrationTest.concurrentRequestsCannotReuseTheSamePasswordResetToken` 실패를 확인한 뒤 Docker engine 500/EOF로 중단됐다. 원래 checkout의 사용자 `DirtiesContext` 수정은 이 작업에 포함하지 않았다. 사용자 허가를 받아 Docker Desktop을 재시작한 뒤 위 관련 전체 검증을 완료했다. 전체 저장소 Core PASS로 보고하지 않는다.
- Web 전체 101개 파일·1,270개 테스트, lint, typecheck 및 production bundle 통과. 최종 검증은 worktree Shared 소스를 참조한다. 기존 500kB bundle 크기 경고는 남아 있다.
- Shared 전체 19개 테스트, typecheck, lint 통과.
- 원격 CI·배포는 미실행이며 commit/push/PR을 하지 않았다.
- 최종 `git diff --check`와 신규 파일의 JSON·Python 구문·공백 검사를 통과했다. 원본 DOCX·API key·사용자 개인정보 파일은 저장소에 포함하지 않았다.

이 1차 실행 당시 판정은 `PARTIAL`이었다. 대전·세종 페이지 증가·의정부 재평가·실제 Core↔AI HTTP의 후속 결과는 [최종 안정화 기록](../docx-stabilization-r2-20260926-v1/README.md)을 확인한다.
