# GovBiz Mobile

기존 웹과 같은 계정·API·데이터를 사용하는 Expo React Native iOS·Android 앱입니다.
웹은 `frontend/web/`, 공통 TypeScript 업무 계약·응답 검증은 `frontend/packages/shared/`에서 관리합니다.

## 현재 제공하는 기능

- 하단 5탭: **검색 · 관심함 · 협업 · 리포트 · 내 정보**. 검색 탭의 `AI 검색 / 필터 검색`에서
  기존 검색 기능을 전환합니다. 각 검색은 처음 선택할 때 열고, 전환 중 입력·결과·스크롤 화면을
  유지합니다. 숨겨진 패널은 터치·스크린리더 탐색에서 제외하며 AI 요청은 사용자 동작으로만 실행합니다.
- `/?mode=filter`는 필터 검색으로, 기존 `/chat` 주소는 `/?mode=ai`로 이동합니다.
  로그인 이동과 공고 상세의 `sourceCode + sourceProgramId` 계약은 유지합니다.
- 협업은 현재 준비 중 안내 화면입니다. 리포트 탭은 본인 최신 리포트·수신 설정·기업 등록 진입을
  제공합니다. 지난 날짜별 리포트 목록과 임의의 추천 결과는 표시하지 않습니다.

리포트의 반복적인 관련도·신청 자격 안내는 카드 설명에 한 번만 표시합니다. 제공처 누락이나
원문 근거 확인 실패처럼 추천 범위를 바꾸는 경고는 추천 카드 앞에 짧게 표시하고,
내부 진단용 최근 수집 시각은 사용자 화면에 표시하지 않습니다. 새로 추가된 경고는 그대로 표시합니다.

- 공고 키워드·지역·분야·출처·접수 상태 검색, K-Startup 추가 필터, 정렬·페이지 이동
- 공고 상세, 공식 원문 열기, 관심 공고 저장·해제·목록
- AI 대화 → 검색 조건 제안 → 사용자 확인 → 공고 검색, 공고 원문 질문·근거 인용
- 이메일 인증 회원가입·로그인·로그아웃, 보안 저장소에서 세션 복원·만료 처리
- Google·Kakao 소셜 로그인(아래 서버 설정과 네이티브 빌드 필요)
- 사업자 조회와 기업 프로필 등록·수정

파트너 모집·제안, 신청 문서 작성, 중복 검토, 관리자 화면은 현재 웹에서 제공합니다.
이번 앱에는 아직 해당 화면, 푸시 알림, 오프라인 공고 저장을 구현하지 않았습니다.

## 맞춤 리포트 (skn-83)

리포트 탭은 로그인 후 `GET /api/v1/me/daily-reports/settings`, `/latest`,
`/api/v1/me/company`를 모바일 Bearer 인증으로 조회합니다. 추천 카드가 있으면 본인 저장 공고 목록도
조회해 책갈피 상태를 표시합니다. 카드의 상세 보기·공식 원문·책갈피는 기존 공고 상세와 저장 API에
연결됩니다. 원문은 제공처가 보낸 공식 HTTPS 주소만 사용하며 리포트 자체의 AI 점수는 선정 확률이 아닙니다.

리포트가 없을 때는 기업 지역·업종과 지원 목적의 3항목으로 조건 완성도를 계산합니다. 다음 리포트
안내는 기업 등록·수신 동의·주소 확인·SMTP·스케줄러 상태에 따라 달라집니다. 수신 설정에서 지원 목적
수정, 명시적인 정기 수신 동의, 확인 메일 요청을 할 수 있습니다. 확인 메일의 링크는 기존 웹에서
확인하며, 메일 서버 접수는 받은 편지함 도착 보장이 아닙니다. 오늘의 리포트는 그날 생성 당시 조건을
보존하므로 이후 설정 변경으로 결과가 바뀌지 않습니다.

화면 진입이나 새로고침으로 유료 AI 미리보기를 생성하지 않습니다. 생성 요청은 웹의 별도 명시적
버튼에서만 가능하며, 최신 조회는 `GENERATING`·`READY`·`FAILED`와 발송 상태를 구분합니다.
앱을 추가해도 백엔드·DB·AI 서비스를 복제하거나 새 클라우드 리소스를 생성하지 않습니다.

## 화면 기준 (skn-78 · 1단계)

[확정 시안 10장](https://govbiz-mobile-review-v2.kds20001026.chatgpt.site)을 디자인 기준으로 사용합니다.
`src/ui.tsx`의 색·글자 크기/굵기·간격·알약 버튼·카드와 `src/components/AppIcon.tsx`의 원본 SVG 경로를
공유합니다. 관심함 아이콘은 책갈피이며 `react-native-svg`는 Expo SDK 57의 호환 버전으로 고정합니다.
글꼴은 현재 기기의 기본 한글 글꼴을 사용합니다. 시안의 웹 글꼴과 실제 기기 차이는 실기기 시각 검증 대상입니다.
세그먼트는 흰색 선택 면과 회색 트랙을 사용하며 글자 확대 시 높이가 늘어납니다.
짧은 버튼도 터치 영역은 최소 44를 확보합니다.

라우트는 `app/`, 화면 상태는 `src/screens/`, 업무 계약은 기존 `@govbiz/shared`에 둡니다.
Root/Tab 내비게이터가 헤더·탭 안전 영역을 담당하고 `Page`는 본문·키보드 회피를 담당합니다.
검색 세그먼트의 실제 높이를 키보드 오프셋에 포함합니다. API·세션·유료 호출 정책은 변경하지 않습니다.
협업·관심함 세부 화면과 준비 관련 독립 화면은 후속 단계이며, 앱에서 시안 전체가 구현된 것으로
취급하지 않습니다.

## 로컬 실행

Node.js **24.x**, pnpm **11.22.x**에서 저장소 루트에서 설치합니다.

```bash
pnpm install --frozen-lockfile
cp frontend/mobile/.env.example frontend/mobile/.env.local
pnpm dev:mobile
```

`EXPO_PUBLIC_API_BASE_URL`에는 `/api`를 제외한 API origin을 지정합니다. 공개되는 설정이므로
OpenAI 키, DB 비밀번호, Vercel 프록시 비밀값, OAuth client secret을 넣지 않습니다.

| 실행 환경 | 개발 API 예시 |
|---|---|
| iOS 시뮬레이터 | `http://localhost:8080` |
| Android 에뮬레이터 | `http://10.0.2.2:8080` |
| 같은 Wi-Fi의 실기기 | `http://192.168.0.10:8080` 등 개발 PC의 LAN 주소 |
| 운영 앱 | HTTPS 공개 API origin 또는 `/api`를 제공하는 Vercel origin |

Core API·MySQL·AI Service와 검색 데이터가 먼저 준비되어야 합니다. 시작 방법은
[인프라 README](../../infrastructure/README.md)를 따릅니다. 기기의 `localhost`는 개발 PC가 아닙니다.
방화벽 및 API listen 주소가 기기의 접근을 허용하는지도 확인합니다.
API 장애를 가짜 공고·정상 빈 결과로 대체하지 않습니다.

기본 Compose는 API 포트를 PC의 `127.0.0.1`에만 노출합니다. 실기기에서 PC LAN 주소를 쓰려면
별도의 개발용 바인딩/HTTPS 개발 주소가 필요합니다. USB로 연결한 Android 기기에서는
`adb reverse tcp:8080 tcp:8080` 후 앱 API를 `http://localhost:8080`으로 지정할 수 있습니다
(Core 호스트 포트를 바꿨다면 reverse 포트도 맞춥니다). 기본 Compose만 켜고 PC LAN 주소를
설정하는 것으로는 실기기에서 연결되지 않습니다.

설치된 Expo Go가 SDK 57을 지원하면 일반 화면을 실행할 수 있습니다. 소셜 로그인은 고정 앱 scheme이
필요하므로 Expo Go가 아닌 네이티브 개발 빌드를 사용합니다.

```bash
# Android Studio/SDK와 JDK가 설치된 환경
pnpm --filter @govbiz/mobile android
# macOS와 Xcode가 설치된 환경
pnpm --filter @govbiz/mobile ios
```

`ios/`와 `android/`는 Expo가 생성하며 Git에 넣지 않습니다. 네이티브 설정은 `app.config.ts`와
Expo config plugin으로 관리합니다. store 등록 전 bundle identifier `ai.govbiz.mobile`과 앱 아이콘,
서명·개발자 계정은 실제 프로젝트에 맞게 확정해야 합니다. EAS 계정·유료 빌드는 필수로 사용하지 않습니다.

## 인증과 소셜 로그인

이메일 로그인·회원가입은 `/api/v1/auth/mobile/login`, `/signup`에서 Bearer 세션을 발급받습니다.
앱은 세션 토큰을 SecureStore에 API origin별로 저장하고 브라우저 쿠키와 섞지 않습니다.
기존 웹은 HttpOnly 쿠키와 Origin 검증을 계속 사용합니다.

소셜 로그인을 활성화하려면 서버에 기존 Google·Kakao client 설정과 함께
`ACCOUNT_MOBILE_OAUTH_REDIRECT_URIS=govbiz://oauth/complete`를 설정하고,
앱에는 `EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN=true`를 지정해 다시 빌드합니다.
공급자에 등록한 callback은 기존 HTTPS `/api/v1/auth/oauth/{google|kakao}/callback`을 유지합니다.
앱은 시스템 브라우저를 열고 state·PKCE를 검증해 60초 일회용 코드를 세션으로 교환합니다.
API 응답에는 토큰이 포함되지만 앱 복귀 URL에는 포함되지 않습니다.

프로덕션은 HTTPS가 필요합니다. 공개 API 및 프록시가 Authorization을 전달하고 앱 요청을 처리하는지
확인하세요. 네이티브 네트워크 스택의 redirect·cookie 동작과 실제 OAuth 공급자 설정은 기기에서 검증해야 합니다.
앱에서 프록시의 비밀 헤더를 직접 만들지 않습니다.

## 검증과 공동 개발

```bash
pnpm --filter @govbiz/mobile typecheck
pnpm --filter @govbiz/mobile lint
pnpm --filter @govbiz/mobile test
EXPO_PUBLIC_API_BASE_URL=https://api.example.com pnpm --filter @govbiz/mobile export
```

export는 iOS·Android JavaScript/리소스 번들 생성이며 `.ipa`/`.apk` 생성이나 실제 기기 검증이 아닙니다.
테스트는 mock API로 인증 경계·복원 경합·화면 동작을 확인합니다. 유료 AI 호출이나 실제 OAuth 로그인을
실행하지 않으므로 실제 검색 품질·공급자 로그인 동작 검증과 구분합니다.

공고 응답/필터/업무 규칙을 바꾸면 `frontend/packages/shared/`를 수정하고 웹·앱 검증을 함께 실행합니다.
화면과 기기 저장소 코드는 각 앱에서 수정합니다. 서버 인증·API가 바뀌면 Core API 테스트도 실행합니다.
전체 구조와 Vercel/Docker 변경사항은 [웹·앱 공동 관리](../../docs/mobile-monorepo.md)를 참고하세요.
