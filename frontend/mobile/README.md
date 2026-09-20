# GovBiz Mobile

기존 웹과 같은 계정·API·데이터를 사용하는 Expo React Native iOS·Android 앱입니다.
웹은 `frontend/web/`, 공통 TypeScript 업무 계약·응답 검증은 `frontend/packages/shared/`에서 관리합니다.

## 현재 제공하는 기능

- 공고 키워드·지역·분야·출처·접수 상태 검색, K-Startup 추가 필터, 정렬·페이지 이동
- 공고 상세, 공식 원문 열기, 관심 공고 저장·해제·목록
- AI 대화 → 검색 조건 제안 → 사용자 확인 → 공고 검색, 공고 원문 질문·근거 인용
- 이메일 인증 회원가입·로그인·로그아웃, 보안 저장소에서 세션 복원·만료 처리
- Google·Kakao 소셜 로그인(아래 서버 설정과 네이티브 빌드 필요)
- 사업자 조회와 기업 프로필 등록·수정

파트너 모집·제안, 신청 문서 작성, 중복 검토, 리포트, 관리자 화면은 현재 웹에서 제공합니다.
이번 앱에는 아직 해당 화면, 푸시 알림, 오프라인 공고 저장을 구현하지 않았습니다.
앱을 추가해도 백엔드·DB·AI 서비스를 복제하거나 새 클라우드 리소스를 생성하지 않습니다.

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
