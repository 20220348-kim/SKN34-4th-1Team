# 새 pull 기준 프런트엔드 전체 감사·수정 보고서

> 작성 시점(`388bf91`)의 기록입니다. 이후 이메일 로그인·세션·로그아웃·보호 경로·관리자 권한 검사는 구현되었으므로
> 아래 "미구현" 항목 중 계정·세션·권한은 [구현 현황](implementation-status.md)과 [계정·인증 계약](account-auth-contract.md)을 기준으로 봅니다.

## 1. 기준과 결론

- 기준: `388bf91` — 로그인·가입·파트너 모집·프로필·관리자 화면이 합쳐진 새 코드.
- 이전 감사 결과를 그대로 재적용하지 않고 현재 `frontend/web/src`의 라우팅, 전체 feature, 공용 UI, Domain·Data·DI·상태·설정·테스트를 다시 검토했습니다.
- 범위: 현재 구현의 버그 수정, 오해를 만드는 데모 표시 정리, 응답 경계 방어, 회귀 검사. 실제 계정·모집·관리자 백엔드를 새로 만드는 작업은 포함하지 않았습니다.
- 발견된 주요 결함은 **중간 화면 폭에서 폼 붕괴**, **오류 재확인 중 검색 잠금 해제**, **재시도 시 다른 입력 유실**, **스크롤 대상 오류**, **잘못된 상세 복귀·모집 상세 연결**, **미구현 기능의 성공 오인**입니다.
- 현재의 기능별 MVVM·UseCase·Repository 구조 자체가 잘못된 것은 아닙니다. 실제 문제를 고치기 위해 새 범용 프레임워크나 계층을 추가하지 않았습니다.

## 2. 재현 가능한 결함과 조치

우선순위는 P1=주요 기능을 사용하기 어려운 결함, P2=상태·입력·복구·접근성 결함, P3=표현·보조 동작 결함으로 구분했습니다. 아래는 모두 이번 변경에 반영했습니다.

| ID | 우선순위 | 재현·영향 | 원인과 수정 |
|---|---|---|---|
| UI-01 | P1 | 768px 화면에서 모집글 작성 본문이 약 **49px**, 내부 입력 열은 0px까지 줄어 겹침 | 화면 전체 폭 기준 2열 + 고정 340px 패널이 사이드바 278px를 무시. 공용 `workspace`와 페이지 내부 `column`의 실제 가용 너비를 기준으로 열 전환 |
| UI-02 | P1 | 로그인·가입: 320px 화면에서 문서 460px, 768px에서 1048px까지 가로 넘침 | 고정 440px 카드와 560px 브랜드 열. 1100px 미만 단일 열, `min-w-0`, `w-full max-w-[440px]` 적용 |
| UI-03 | P2 | 공개 헤더: 320·375px에서 문서 폭 396px | 모바일 헤더 열과 메뉴의 최소 너비. 메뉴를 다음 행에 배치하고 줄바꿈 허용 |
| UI-04 | P2 | 긴 연속 문자열 입력 후 대화 폭 3885px 이상으로 늘어남. 줄바꿈도 사라짐 | flex 자식 최소 폭과 공백 처리. `min-w-0`, `overflow-wrap:anywhere`, `whitespace-pre-wrap` 적용. 상세 제목·본문·답변·인용·역량 칩도 긴 문자열 처리 |
| UI-05 | P2 | 공개·모바일 검색의 새 확인 카드가 화면 아래에 생겨 사용자가 직접 내려가야 함 | 문서가 스크롤되는데 타임라인의 `scrollTop`만 변경. 실제 내부 스크롤 여부를 구분하고 새 내용에만 문서 스크롤 적용 |
| UI-06 | P2 | 상태 조회 실패 후 ‘다시 확인’을 누른 순간, 새 응답 전에 과거 SEARCHABLE로 검색 허용 | 재요청 시작 시 `isError`를 지움. 실제 성공까지 오류·검색 차단 유지, 요청 중 버튼 비활성화 |
| UI-07 | P2 | 검색 실패 뒤 다른 문장을 쓰고 이전 검색 재시도 → 새 초안 삭제 | `searchStarted`가 무조건 draft 초기화. 실패한 검색과 다른 새 초안은 보존하고 확인한 기존 command만 재전송 |
| UI-08 | P2 | `/chat`의 검색 결과에서 상세·질문 왕복 후 공개 `/`로 이동 | 복귀 경로가 하드코딩됨. `/`·`/chat`만 라우트 상태로 전달하고 질문 왕복에 보존. `/chat/`는 `/chat`으로 정규화 |
| UI-09 | P2 | 상세 일시 실패·10초 시간 초과 후 같은 화면에서 복구 불가 | 오류 화면에 수동 재조회 버튼 추가. 이전 요청의 늦은 응답은 무시 |
| UI-10 | P2 | 원문 질문 501자 입력 시 버튼만 비활성화되고 오류를 알리지 않음 | 즉시 길이 오류·`aria-invalid`·`aria-describedby` 연결. 수정하면 오류 해제 |
| UI-11 | P2 | 상세 자격 주의문이 밝은 바탕에 흐리게 표시됨 | 어두운 원문 배너용 색을 재사용. 별도 스타일로 분리해 대비 **1.68:1 → 5.93:1** |
| UI-12 | P2 | 일반 안내·라벨·placeholder가 밝은 배경에서 대비 2.24~4.38:1 | 활성 정보에 낮은 대비 색 반복. 기존 `sample-muted` 토큰 재사용. 주요 밝은 배경에서 **5.83~6.18:1**. 비활성·장식 전용 스타일은 유지 |
| UI-13 | P2 | 가입 폼 공란·확인 비밀번호 불일치·안내한 길이 미달에도 작업 화면 이동 | 데모 입력의 이메일 형식·영문/숫자 포함 8자·확인 일치 검사. 로그인도 기본 입력 검사. 오류와 포커스 제공. 실제 인증은 하지 않음 |
| UI-14 | P2 | 필요 역량의 한글 조합 확정 Enter가 칩 추가·입력 삭제로 처리됨 | `isComposing`와 Safari 계열 `keyCode 229` 가드. 조합 중 Enter는 제출·칩 확정을 하지 않음 |
| UI-15 | P2 | ‘공고 마감일 이전’이라는 안내와 달리 같은 날도 모집 마감일로 선택 | 전날을 최대 날짜로 설정하고 제출 시 재검사. 제목·본문 필수 조건도 제출 전에 검사 |
| UI-16 | P2 | 다른 모집글·내 모집글도 모두 첫 번째 예시 상세로 연결 | 준비된 상세의 ID만 링크에 전달. 다른 카드는 준비 중. 알 수 없는·빈·중복 ID는 첫 상세로 대체하지 않음 |
| UI-17 | P2 | 저장하지 않았는데 ‘임시 저장됨 · 방금 전’, 계정 인증 없이 로그인 성공처럼 보임 | 데모·미저장·미전송 안내 및 정확한 버튼 이름. 실제 비밀번호 입력 금지. ‘로그아웃’은 실제 동작인 ‘공개 검색으로’로 변경 |
| UI-18 | P2 | Core 상태·SampleItem 요청이 응답하지 않으면 무기한 pending | 각 10초 제한, AbortController 취소, 명시적 오류·수동 재시도·늦은 응답 차단·타이머 정리 |
| UI-19 | P2 | React Hook Form 검증 완료 전에 입력 수정·화면 이탈해도 이전 값으로 요청 시작 가능 | 검증 시작 시 입력 세대 번호를 캡처하고 완료 시 mounted·세대 번호 검사 |
| UI-20 | P3 | 저장·신고·CSV·회원 정지·프로필 수정 등 미연결 버튼이 활성, 작동하지 않는 탭과 숨겨진 완료 상태 | 준비 중 동작 비활성화, 가짜 tab 역할 제거, 완료/미완료 텍스트 제공, 관리자 표 스크롤 키보드 접근, Core down·미확인도 재확인 제공 |

### 주요 변경 위치

- [공용 작업 레이아웃](../frontend/web/src/presentation/shared/workspace/WorkspacePage.styles.ts), [사이드바 스타일](../frontend/web/src/presentation/shared/app-sidebar/AppSidebar.styles.ts), [헤더](../frontend/web/src/presentation/shared/app-header/AppHeader.styles.ts)
- [채팅 ViewModel](../frontend/web/src/presentation/features/chat/viewmodel/useChatPageViewModel.ts), [준비 상태 Hook](../frontend/web/src/presentation/features/chat/hooks/useSupportProgramSearchReadiness.ts), [chat slice](../frontend/web/src/presentation/features/chat/state/chatSlice.ts), [채팅 View](../frontend/web/src/presentation/features/chat/view/ChatPage.tsx)
- [상세 ViewModel](../frontend/web/src/presentation/features/support-program-detail/viewmodel/useSupportProgramDetailViewModel.ts), [복귀 경로 검증](../frontend/web/src/presentation/features/support-program-detail/view/supportProgramNavigation.ts), [질문 View](../frontend/web/src/presentation/features/support-program-detail/view/SupportProgramEvidenceQuestionPage.tsx)
- [가입 ViewModel](../frontend/web/src/presentation/features/auth/viewmodel/useSignupViewModel.ts), [인증 화면 스타일](../frontend/web/src/presentation/features/auth/view/AuthPage.styles.ts)
- [모집 작성 ViewModel](../frontend/web/src/presentation/features/partner-recruitment/viewmodel/usePartnerRecruitmentCreateViewModel.ts), [모집 상세 ViewModel](../frontend/web/src/presentation/features/partner-recruitment/viewmodel/usePartnerRecruitmentDetailViewModel.ts)
- [Core 상태 Hook](../frontend/web/src/presentation/shared/core-api-status/useCoreApiHealth.ts), [Hook 예제](../frontend/web/src/presentation/features/sample-item/viewmodel/useSampleItemViewModel.ts), [Redux 예제](../frontend/web/src/presentation/features/sample-item/viewmodel/useReduxSampleItemViewModel.ts)

### 레이아웃·스크롤 검증에서 지킨 조건

- 데스크톱 `/chat`의 내부 대화 스크롤·하단 입력창은 새 pull에 이미 구현돼 있었습니다. 이번에 처음 만든 개선으로 집계하지 않았습니다.
- 모바일은 기존 문서의 의도대로 문서 전체가 스크롤됩니다. 모바일 입력창을 항상 고정하는 정책 변경은 하지 않았습니다.
- 새 내용에만 문서 이동을 적용합니다. 첫 공개 화면 진입·초안 편집·제안 취소가 임의로 화면을 이동시키지 않습니다.
- 상세에서 데스크톱 채팅으로 복귀하면 내부 타임라인의 마지막 내용을 보여 주고, 새 검색 초기화는 입력창으로 포커스를 돌립니다.
- 관리자 표의 내부 가로 스크롤은 의도된 동작입니다. 표 자체 폭을 문서 가로 넘침으로 오판하지 않았습니다.
- 접근성 상태 텍스트 추가 과정에서 프로필의 절대 위치 요소가 문서 높이를 늘리는 회귀도 잡았습니다. 체크리스트 항목을 위치 기준으로 한정한 뒤 작업 화면 외부 세로 넘침 검사를 통과했습니다.
- 컨테이너별 열 전환은 현재 Tailwind가 제공하는 [이름 있는 컨테이너 쿼리](https://tailwindcss.com/docs/responsive-design#container-queries)를 사용했습니다. 별도 resize listener나 화면 폭 Redux 상태는 없습니다.
- 일반 작은 텍스트의 대비 기준은 [WCAG 2.2 SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)의 4.5:1입니다. disabled·장식 예외와 구분했으며 전체 WCAG 적합성 인증을 의미하지는 않습니다.

## 3. 비정상 API 응답 방어 보강

아래는 **정상 운영 서버가 실제 잘못된 값을 반환했다는 주장과 다릅니다.** 프런트엔드 경계가 계약 위반을 안전하게 거부하도록 보강했습니다.

| 항목 | 이전 허점 | 보강·호환성 |
|---|---|---|
| 공고 날짜 | 문자열 모양만 검사해 `2026-02-30` 같은 날짜 통과 | 실제 ISO 날짜 검사. 정상 윤일·null 유지 |
| 자격 인용 | 근거 필드와 길이만 검사해 지정 본문에 없는 문장도 표시 가능 | `summary` 또는 `targetDescription`의 정확한 부분문자열인지 검사. 공백·대소문자를 임의 정규화하지 않음 |
| 중복 공고 | 같은 제공처·원본 ID가 반복되면 React key 충돌·중복 결과 | 복합 식별자 중복 거부. 다른 제공처의 같은 원본 ID는 허용 |
| 응답 검색어 | 요청과 다른 검색어의 결과를 현재 요청 결과처럼 수용 | `command.query.trim()`과 응답 query 대조. 빈 검색어 최신 목록 API 계약 유지 |
| 타입 설정 | 엄격 검사를 프로젝트 설정으로 보장하지 않음 | app/node `strict: true` 명시, 전체 타입 검사 통과 |

위치: [SupportProgramDto.ts](../frontend/web/src/data/models/SupportProgramDto.ts), [supportProgramApi.ts](../frontend/web/src/data/api/supportProgramApi.ts), [tsconfig.app.json](../frontend/web/tsconfig.app.json), [tsconfig.node.json](../frontend/web/tsconfig.node.json).

서버의 관련성 점수와 신청 자격 판정은 계속 별개입니다. 높은 관련도와 `REVIEW_REQUIRED`·`UNKNOWN`이 공존하는 응답은 유효합니다. 클라이언트는 자격 충족 여부를 재판정하거나 장애를 성공 fallback으로 숨기지 않습니다.

## 4. 아키텍처 평가와 유지한 구조

| 경계 | 점검 결론 |
|---|---|
| View / ViewModel | JSX·ARIA·순수 표시 포맷은 View, 입력·요청 수명·스크롤/IME는 ViewModel/Hook에 유지. 긴 파일이라는 이유만으로 여러 추상 계층으로 나누지 않음 |
| Domain / Data | HTTP·Zod·외부 응답은 Data 경계. Domain Repository 계약과 DTO 복사 변환 유지. Domain에 React·브라우저 상태 주입 없음 |
| DI | Awilix는 객체 조립, Redux는 화면 데이터. Hook의 제한된 Service Locator 사용을 생성자 DI와 혼동하지 않고 문서에 구분 |
| 상태 수명 | 채팅·Redux 예제는 앱 이동 동안 메모리 유지, 상세·질문·데모 입력은 페이지 로컬. 요청 controller·DOM ref를 Store에 넣지 않음 |
| 동시성 | 요청 ID·입력 세대·AbortController·timeout 정리로 이전 응답 차단. 자동 재시도나 새 검색 호출을 추가하지 않음 |
| Feature 연결 | 상세는 URL 식별자로 조회하고 복귀 경로만 라우트 상태로 전달. 채팅 내부 ViewModel/Store를 상세에서 import하지 않음 |
| 공용 UI | 실제 여러 화면이 공유하는 workspace 스타일을 사용. 페이지 고유 배치는 각 feature에 유지. 신규 공통 provider/factory 없음 |
| 프로토타입 | 실제 서비스 예시와 테스트 fixture를 구분. 새 화면의 예시 데이터는 데모로 명시하고 가짜 API·인증 성공·영구 저장을 만들지 않음 |
| 보안 경계 | 공식 제공처 URL allowlist·스킴·응답 식별자 검증·텍스트 렌더링 유지. 비밀번호/회사 입력의 URL·로그·storage·API 기록 코드는 새로 추가하지 않음 |
| 문서 | 오래된 ‘메시지 제출 전에 readiness 검사’ 설명을 실제 ‘해석은 독립, 확인 검색만 검사’ 흐름으로 정정 |

### 이전 문제·추정 중 이번 수정에서 제외한 사항

1. **새 검색 버튼 누락:** 새 pull에서 이미 해결됨. 버튼·초기화·취소·포커스 동작 유지 및 회귀 검사.
2. **자격 MATCH 우선 재정렬:** 새 pull이 서버 순서를 보존함. 이전 정렬을 재도입하지 않음.
3. **로그인 링크가 가짜 링크:** 이제 실제 로그인 데모 경로가 있으므로 `/chat` 직접 링크로 바꾸지 않음.
4. **changedFields가 변경 칩을 숨긴다:** 현재 View는 실제 before/after를 비교하므로 오탐. 임의의 추가 필드 일치 검증을 넣지 않음.
5. **모바일 입력창이 화면 아래에 고정되지 않는다:** 문서 스크롤 정책에 따른 기존 동작. 검색 결과가 자동으로 보이지 않는 실제 스크롤 대상 오류만 수정.
6. **관리자 경로가 열려 있으므로 실제 회원 정보가 유출된다:** 현재 예시 데이터만 있는 데모. 실제 데이터 유출로 단정하지 않으며 인증·권한 연결은 출시 조건으로 분리.

## 5. 아직 구현되지 않은 제품 기능

버그를 고쳤다고 아래 기능까지 완성된 것은 아닙니다. 화면에는 준비 중·데모·미저장을 표시했습니다.

| 출시 전 작업 | 필요한 범위 |
|---|---|
| 계정·세션·권한 | 실제 로그인·가입 API, 서버 세션/토큰, 로그아웃, 보호 경로, 관리자 권한 검사. 브라우저 라우트 가드만으로 서버 권한을 대체하면 안 됨 |
| 기업 프로필 | 영구 저장, 회원별 조회, 추천에 쓰는 조건과 편집 프로필의 명확한 연결, 공개 범위 서버 적용 |
| 모집글 | 실제 공고 선택, 등록/수정/조회, 게시물별 상세, 검색·필터·페이지네이션, 날짜 정책과 서버 검증 |
| 참여 제안 | 전송·수락·거절·메시지함·알림·동의에 따른 연락처 공개 |
| 관리자 | 실제 회원 조회, 상태 변경 권한·감사 기록, CSV·정책 저장·이메일 처리 |
| 부가 기능 | 관심 공고함, 대화 서버 저장, 실제 기업 인증·서류 검증 |

프런트엔드만으로 인증·저장을 흉내 내어 완료 처리하지 않았습니다. 이 항목은 데이터 모델·API·보안·운영 정책이 필요한 별도 개발 범위입니다.

## 6. 검증 기록

### 자동 테스트와 빌드

- 전체 Vitest: **33개 파일, 391개 테스트 통과** (최종 22.50초).
- TypeScript: app/node `strict` 포함 `tsc -b` 통과.
- Oxlint: 통과.
- Vite production build: 성공. 초기 JS **555.66KB / gzip 165.78KB**로 500KB chunk 경고는 남음.
- `git diff --check`: 통과.
- 실제 유료 API: **0회**. Core·AI·MySQL·Docker 서비스 변경이나 재시작 없음.

Node는 `24.19.0`입니다. 기본 pnpm은 `11.19.0`으로 프로젝트의 `11.22.x` 요구와 달라 `pnpm test`가 엔진 검사에서 거부됐습니다. 설치·package·lock 변경 없이 기존 설치본의 실행 파일을 직접 호출했습니다. 따라서 요구된 pnpm 버전으로 clean install한 CI 환경까지 검증했다고 표현하지 않습니다.

```powershell
node node_modules/vitest/vitest.mjs run
node node_modules/oxlint/bin/oxlint
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build
git -c core.safecrlf=false diff --check
```

신규 회귀 중 공란 가입·확인 비밀번호 불일치·IME·Safari 229, readiness 재확인, 입력 유실, 요청 시간 제한·검증 경쟁 조건, `/chat/` 상세 복귀는 수정 전 실패를 확인한 뒤 보완했습니다. 기존 검색·조건 해석·관련도/자격 분리·취소·이탈·공식 URL 검증 테스트도 유지했습니다.

### 실제 브라우저 회귀

[재실행 스크립트](../frontend/web/scripts/check-ui-layout.cjs)는 별도 설치된 Playwright와 Edge를 사용했습니다. 설치 방법을 실행 중 임의로 바꾸거나 새 production 의존성을 추가하지 않았습니다.

- 해상도: **320×568, 375×667, 768×800, 844×390, 1024×800, 1280×800, 1440×900**.
- 경로: 공개 검색, 작업 채팅, 로그인, 가입, 모집 목록·작성·상세, 프로필, 관리자, 공고 상세·질문, Hook·Redux 예제 — **13개**.
- **91개 화면 검사 + 28개 동작 흐름**.
- 검사: 문서 가로 넘침, 입력 최소 폭/폼 경계, 데스크톱 작업 화면 외부 세로 넘침, 제안 확인 버튼 노출, 확인 전 검색 금지, 긴 검색어·제목·본문·답변·인용·역량 칩, 새 검색 초기화·포커스, 질문 길이 오류.
- 변경한 활성 안내 토큰은 실제 렌더링된 단색 배경·전경으로 대비도 확인. 그라데이션·반투명 합성·화면 전체의 모든 접근성 기준을 검사하는 도구는 아님.
- 브라우저 미처리 오류 **0건**. API는 전부 가상 응답, 외부 주소 요청은 차단. 최종 mock 해석 14회·검색 14회·답변 7회는 실제 API 사용량이 아님.

### 남은 검증 한계·성능 관찰

1. 실제 OpenAI 조건 해석·검색·RAG 품질과 실제 백엔드 장애 복구는 이번 mock 검사로 증명하지 않았습니다.
2. Edge 검증이며 Safari·Firefox·실기기 키보드·VoiceOver/NVDA 전체 탐색·고대비 모드까지 확인한 것은 아닙니다. Safari 229는 자동 이벤트 회귀로 검증했습니다.
3. 초기 JS 단일 chunk가 500KB를 넘습니다. 현재 라우트의 정적 import와 예제 의존성이 함께 묶이는 구조가 성능 검토 대상입니다. 이 경고 자체를 기능 장애라고 단정하거나 경고 한도를 올려 숨기지 않았습니다. 실제 초기 로딩 지표를 측정한 뒤 라우트별 lazy load·청크 로딩 실패 UX를 함께 설계하는 것이 다음 최적화 후보입니다.
4. 검사 범위의 재현 가능한 결함을 수정한 것이며 모든 환경에서 버그가 없다는 보장은 아닙니다.

## 7. 후속 작업 순서

1. 이번 변경을 pnpm 11.22.x의 표준 CI 환경에서 확인하고 리뷰·병합.
2. 제품 공개 범위를 먼저 결정: 검색 서비스만 공개할지, 데모 작업 화면도 공개할지 구분.
3. 실제 계정·권한 기반을 만든 뒤 프로필 저장과 모집글 CRUD를 연결.
4. 전송·수락·공개 범위·관리자 기능은 서버 권한과 감사 기록을 포함해 구현.
5. 브라우저·보조기기 범위를 넓히고 실제 초기 로딩·AI 검색 품질을 각각 별도 측정.

커밋·push는 이 작업에서 수행하지 않았습니다.
