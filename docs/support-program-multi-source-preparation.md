# 6단계: API 없는 다중 제공처 준비

[문서 목록](README.md) · [구현 현황](implementation-status.md) · [HTTP 계약](support-program-search-contract.md)

> 이 문서는 2026-09-07의 준비 단계 기록입니다. 2026-09-09에는 실제 K-Startup 수집·색인·전용 필터를 구현했습니다.
> 현재 실행 흐름·수집 범위는 [아키텍처](architecture.md#k-startup-수집-범위와-추가-분류),
> HTTP 계약은 [직접 조건 검색](support-program-catalog.md)을 참고하세요. 아래 미구현 설명은 당시 기준입니다.

기준일: 2026-09-07. K-Startup API 없이 구현·검증할 수 있는 제공처별 준비 상태, 검색 범위,
색인 복구와 화면 경계를 정리합니다. 실제 수집기는 기업마당(`BIZINFO`) 하나이며, 이번 준비를 위해
K-Startup 외부 API 호출·가짜 공고 영속화·새 스키마·새 production 의존성·제공처 Registry를 추가하지 않았습니다.

## 구현한 범위

| 구분 | 현재 동작 |
|---|---|
| 준비 상태 | 기존 전체 필드를 유지하고 필수 `sources` 배열에 제공처별 이름·상태·공고 수·색인 준비·동기화 시각 제공 |
| 일부 제공처만 준비 | 전체 상태는 `SEARCHABLE_WITH_PARTIAL_SOURCES`; 준비된 제공처 이름을 안내하고 검색 허용 |
| 자연어 검색 | `findSearchablePresent`의 공고/상태 JOIN으로 공개 세대·지문이 있고 `index_ready=true`인 제공처만 선택 |
| 빈 검색어 최신 목록 | `findPublishedPresent`로 공개된 DB 스냅샷을 읽어, 공개 이후 색인 장애에도 기존 공고 유지 |
| 누락 벡터 복구 | 제공처별 색인·조건부 상태 갱신·legacy 채택. 한 제공처 실패 뒤에도 나머지를 처리하고 마지막에 실패 전달 |
| K-Startup 공식 URL | Frontend에서 `KSTARTUP`과 `k-startup.go.kr` 및 하위 도메인의 HTTP(S) URL 조합 허용 |
| 원문 근거 질문 | `BIZINFO` 상세에서 별도 질문 페이지로 이동. K-Startup 등 다른 제공처는 미지원 안내·원문 링크를 표시하고 전송 차단 |
| 평가용 신규 읽기 | fixture 내보내기와 실제 capture 모두 운영 검색과 같은 준비된 제공처 범위 사용 |

## 준비 상태와 검색 범위

`SupportProgramController → SupportProgramSearchReadinessService → SupportProgramRepository → MyBatis Mapper
→ Mapper XML → MySQL` 흐름으로 읽습니다. 공개 계약은 `controller/dto`의
`SupportProgramSearchReadinessResponse`·`SupportProgramSourceReadinessResponse`, 내부 결과는 `service/dto`의
`SupportProgramSearchReadinessResult`·`SupportProgramSourceReadinessResult`가 소유합니다.
준비 상태 조회는 외부 API·AI Service·Qdrant를 호출하지 않습니다.

`sources`는 새 필수 응답 필드이고 부분 검색 상태도 추가했으므로 Core와 Frontend를 함께 갱신해야 합니다.
이전 Core 응답을 새 Frontend가 임의의 기본값으로 보완하지 않습니다.

`sources`에는 저장된 제공처 상태와 현재 공개 공고의 제공처를 포함합니다. 상태 행 없는 legacy 공고도
누락하지 않고 준비 확인 불가(`UNAVAILABLE`, `indexReady=false`, 동기화 시각 `null`)로 안내합니다.
빈 초기 DB에는 현재 구성된 `BIZINFO`만 초기 준비 상태로 표시합니다. K-Startup URL을 허용했다는 이유로
K-Startup 상태 행이나 빈 수집기를 등록하지 않습니다. `PREPARING`은 공개 공고도 없는 초기 상태나
아직 성공·실패가 기록되지 않은 첫 동기화에 해당합니다.

각 제공처의 상태는 기존 `PREPARING`, `SEARCHABLE`, `SEARCHABLE_WITH_SYNC_FAILURE`, `UNAVAILABLE`
네 가지입니다. 제공처별 `programCount`는 저장된 공개 공고 수이므로 미준비 상태에서도 공고가 있을 수 있습니다.
전체 `programCount`는 준비된 제공처의 합계이며 `indexReady`는 한 제공처 이상 준비되었는지입니다.
전체 성공/실패 시각은 각각 제공처별 시각 중 가장 최근 값입니다.

전체 상태는 다음 순서로 계산합니다.

1. 준비된 제공처와 미준비 제공처가 함께 있으면 `SEARCHABLE_WITH_PARTIAL_SOURCES`.
2. 모두 준비되었고 최신 동기화 실패가 있으면 `SEARCHABLE_WITH_SYNC_FAILURE`.
3. 모두 준비되었으면 `SEARCHABLE`(성공한 빈 스냅샷도 포함).
4. 준비된 제공처가 없고 하나라도 `UNAVAILABLE`이면 `UNAVAILABLE`, 그 외에는 `PREPARING`.

Frontend는 부분 준비에서도 검색을 허용하고, 제공처별 실패 상태를 별도로 표시합니다. 초기 준비 중인
제공처가 있으면 5초마다 다시 확인하며, 부분 준비/검색 불가 화면에는 수동 확인도 제공합니다.
색인 준비는 마지막으로 기록된 결과이며 실시간 외부 서비스 Health 보장은 아닙니다.

검색은 `SupportProgramSearchService → SupportProgramRepository.findSearchablePresent → Mapper → XML`
흐름으로 `support_program`과 `support_program_sync_status`를 `source_code`로 JOIN합니다.
현재 공개 공고이면서 해당 제공처가 준비된 경우만 의미·키워드 검색 후보에 포함합니다. 빈 검색어는
`findPublishedPresent`로 공개 세대·지문이 있는 DB 공고를 읽으므로 이후 색인 장애에도 목록을 유지합니다.
미공개 제공처와 미채택 legacy 공고를 빈 검색어로 우회해 노출하지는 않습니다. 자연어 검색에 필요한 모든
색인이 불가하고 기존 공개 스냅샷 또는 미복구 공고가 있다면 빈 결과 대신 503으로 알립니다. 최초 빈 DB나
준비된 제공처의 정상 0건 스냅샷은 빈 목록을 유지하며, 일부 준비 상태에서는 준비된 제공처만 검색합니다.
선택된 범위 안에서 AI·벡터 검색이 실패해도 기존처럼 오류를 반환합니다.
상세 GET은 현재 공개 공고를 복합 식별자로 조회하므로 색인 준비 상태와 별개입니다.

## 동기화 실패와 복구 실패

새 동기화의 수집·공개 전 필수 색인이 실패하면 이전 공개 공고와 `indexReady`를 유지하고 해당 제공처의
실패 시각만 기록합니다. 이전 스냅샷이 준비되어 있었다면 `SEARCHABLE_WITH_SYNC_FAILURE`로 검색을 계속합니다.

`SupportProgramIndexSyncService.repair`는 미준비 공고를 포함한 현재 공고와 상태를 제공처별로 묶습니다.
공고가 0개인 공개 상태도 처리하며, 상태가 없는 비어 있지 않은 legacy 공고는 해당 제공처 전체 색인이
성공한 뒤에만 sentinel 세대 `0`으로 조건부 채택합니다.

복구가 실패하면 해당 제공처의 공개 세대·지문·공고 수가 읽은 스냅샷과 여전히 같은 경우에만 미준비로
갱신합니다. 다른 제공처 처리를 계속하고 전체 처리가 끝난 후 오류를 전달합니다. 늦게 끝난 복구가
새 스냅샷 상태를 덮지 않으며, 제공처별 저장·비활성화·실패 상태의 범위도 유지합니다.
자동 벡터 삭제는 연결하지 않았습니다.

## URL과 원문 질문

K-Startup 도메인은 [공식 사이트](https://www.k-startup.go.kr/web/main/index.do)를 읽기 전용으로 확인했습니다.
이 확인은 API 명세 검증이나 실제 공고 수집의 증거는 아닙니다.

Frontend는 `BIZINFO`에 `bizinfo.go.kr`, `KSTARTUP`에 `k-startup.go.kr`와 각 하위 도메인을 대응시킵니다.
`k-startup.go.kr.attacker.example` 같은 위장 호스트, 타 제공처 공식 URL, userinfo, 비표준 포트,
`javascript:` 등 다른 스킴과 알 수 없는 제공처는 거부합니다. 잘못된 한 건이 섞인 검색 응답도 전체를
거부하고 정상 공고만 조용히 남기지 않습니다.

K-Startup 공식 URL 표시는 서버의 원문 수집을 허용하는 설정이 아닙니다. 원문 질문은 여전히 기업마당만
지원하며 기업마당 상세에서 `/support-programs/detail/question`으로 이동해 질문합니다. 다른 제공처 상세에는
미지원 안내와 원문 링크를 유지하고, 질문 페이지로 직접 접속해도 입력을 렌더링하지 않으며 ViewModel에서 HTTP 요청 전송을 막습니다.
현재 공개된 미지원 제공처에 대한 서버의 422 계약은 유지합니다.

## 검증과 남은 범위

Frontend 전체 20개 파일·162개 테스트, lint, production build가 통과했습니다. 검증은 설치된 Node
v26.7.0에서 실행했으며 프로젝트 권장 버전은 24.x입니다. Core API는 JDK 21에서 전체
`./gradlew clean test --no-daemon` 최종 363개를 통과했습니다(실패·오류·건너뜀 0개).
MySQL 8.4 Testcontainers와 상태 없는 legacy 제공처 집계 검증을 포함합니다.
원문 근거 평가 도구는 118개, 검색 평가 도구는 167개와 subtest 167개를 통과했습니다.
두 평가 폴더를 한 pytest 명령에 넣으면 기존 `evaluate`
모듈명이 충돌해 수집이 실패하므로, 각 도구의 공식 실행법에 따라 폴더별로 분리 실행했습니다.
이 실행 방식 보완을 위한 소스 변경이나 추가 API 호출은 없습니다.

테스트는 제공처별 준비/미준비, 동일 원본 ID, 복구 중간 실패 격리, 기존 스냅샷에서 새 동기화 실패 후
검색 유지, 혼합 제공처 URL 검증, 비지원 질문 폼·HTTP 차단을 확인합니다. 이번 준비의 유료 API 호출은
0회입니다. 실제 K-Startup API·Client·페이지 수집·정규화·동기화, 기업마당 대비 추가 공고 가치의 표본 비교,
로그인·기업 프로필·북마크는 구현하거나 실행하지 않았습니다.
API가 제공되면 먼저 실제 응답·페이지 완전성과 공고 표본으로 추가 가치를 확인하고, 채택한 뒤
Client·정규화·제공처별 동기화를 구현합니다.

신규 평가 fixture/capture는 준비된 제공처만 읽으며 API 없이 내보내는 fixture에는 참조 판정이 없습니다.
실제 capture 실행은 AI 호출 비용이 발생할 수 있지만 이번 작업에서는 실행하지 않았습니다.
기존 고정 평가 스냅샷·판정 원표·capture·5단계 보고서는 당시 조건의 결과로 그대로 보존합니다.
이번 조회 조건을 소급 적용하거나 과거 품질 지표를 다시 해석하지 않습니다.
