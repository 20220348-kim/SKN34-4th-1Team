# 발표용 Android APK와 Firebase App Distribution

[문서 목록](README.md) · [모바일 README](../frontend/mobile/README.md) · [웹·앱 공동 관리](mobile-monorepo.md)

발표 참석자가 Expo Go나 개발 PC의 Metro 서버 없이 설치해 사용하는 Android APK를 만든다.
`frontend/mobile/eas.json`의 `preview` 프로필로 EAS Cloud Build를 실행하고, 완료된 APK를
Firebase App Distribution 콘솔에 수동 업로드한다. 발표용 변경은 사용자가 지정한 작업 브랜치에서
검증하며, 원격 push·PR·APK 배포·실기기 확인·병합은 각각 별도 단계다.

## 구성과 호출 경로

```text
모바일·shared 소스 → EAS Cloud Build → 서명된 Android APK
                                         ↓
                         Firebase App Distribution → 참석자 설치

설치된 앱 → 공개 HTTPS API/기존 프록시 → Core → 기능별 AI·DB·검색 서비스
```

Firebase는 APK 전달과 테스터 접근을 관리한다. 회원 인증·DB·업무 API는 기존 서비스를 사용한다.
배포만을 위해 Firebase Auth/DB/앱 SDK를 추가하지 않는다. EAS Cloud Build는 필요한 저장소 소스를
Expo 서버에 업로드해 빌드하는 외부 빌드 서비스다. Firebase 콘솔에는 완성된 APK를 업로드한다.

| 파일 | 책임 |
|---|---|
| [eas.json](../frontend/mobile/eas.json) | `preview` 환경, 개발 클라이언트 없는 internal APK, Node 24.18.0·pnpm 11.22.0 |
| [app.config.ts](../frontend/mobile/app.config.ts) | 이름·패키지·scheme·버전·아이콘·Expo 프로젝트·선택적 FCM 설정, preview 입력 검증 |
| [icon.png](../frontend/mobile/assets/icon.png) | 최초 선택한 G 모노그램 원본, 기본 아이콘 |
| [adaptive-icon.png](../frontend/mobile/assets/adaptive-icon.png) | G를 줄이고 투명 여백을 늘린 Android adaptive icon 전경 |
| [.env.example](../frontend/mobile/.env.example) | 기존 로컬 개발 환경변수 목록 |
| [.env.preview.example](../frontend/mobile/.env.preview.example) | 사용자가 준비해 EAS `preview`에 등록할 배포 환경변수 목록 |
| [.gitignore](../frontend/mobile/.gitignore) | 실제 환경파일·서명키·Firebase 인증·APK 제외 |
| [루트 .easignore](../.easignore) | 기존 제외 규칙과 모바일 생성·인증파일 제외 유지, 다른 서비스·자료·작업용 체크아웃 업로드 제외 |

현재 설정은 `version=0.1.0`, `android.versionCode=7`, 패키지 `ai.govbiz.mobile`, scheme `govbiz`다.
기존 versionCode 6 APK에서 업데이트할 수 있도록 7로 올렸다. 기본 아이콘은 최초 선택한 G 모노그램
원본 `frontend/mobile/assets/icon.png`를 사용한다. Android 전경은 중앙 G를 줄이고 투명 여백을 늘린
`frontend/mobile/assets/adaptive-icon.png`를 `android.adaptiveIcon.foregroundImage`에 연결했다.
배경색은 `#E7F6ED`다. 아이콘 변경은 새 APK 빌드·설치 후 실제 런처에서 확인하며, JavaScript
업데이트만으로 적용되지 않는다.

## 사용자가 먼저 준비할 정보

| 항목 | 준비할 값·위치 | 필요 조건 |
|---|---|---|
| Expo 소유 계정/조직 | config의 소유자 `seop1026`에 접근할 로그인 계정 | 필수. APK와 서명키를 계속 관리할 소유자 확인 |
| Expo 프로젝트 UUID | 실제 `@seop1026/govbiz` 프로젝트의 UUID | 필수. `EXPO_PUBLIC_EAS_PROJECT_ID`로 사용 |
| 공개 API origin | 휴대폰에서 접근 가능한 `https://...` | 필수. `/api`·하위 경로·인증정보·쿼리 없이 지정 |
| 공개 웹 origin | 공유 링크가 열리는 `https://...` | 모집글 공유 링크를 제공할 때 필요 |
| Firebase 프로젝트 | 실제 프로젝트 ID와 관리 권한 | APK 업로드에 필수. 이미 푸시용 프로젝트가 있으면 확인 후 재사용 |
| Firebase Android 앱 | 패키지명 `ai.govbiz.mobile`과 등록된 Firebase App ID | 필수. 실제 APK의 패키지명과 일치해야 함 |
| Android 서명키 | 기존 배포키 또는 최초 생성할 EAS 관리 키 | 최초 빌드에서 준비하고 이후 같은 키 유지 |
| Firebase Android 설정 파일 | `google-services.json` | 앱 푸시를 제공할 때 필요 |
| FCM v1 서비스 계정 | Expo Android Push Credentials에 등록할 키 | 앱 푸시를 제공할 때 필요 |
| OAuth 공급자·서버 설정 | Google/Kakao callback과 `govbiz://oauth/complete` 허용 | 소셜 로그인을 제공할 때 필요 |
| 테스터 그룹 | 예: 팀원 검증 그룹과 발표 참석자 그룹 | Firebase 콘솔에서 실제 그룹을 생성 |

Expo UUID, Firebase 프로젝트 ID, Firebase Android App ID는 서로 다르다. Firebase ID와 테스터 그룹은
콘솔 업로드의 관리 정보이며 모바일 환경변수에 추가하지 않는다. 서비스 계정 키와 서명키는 APK에 넣지 않는다.

## 배포 환경변수

[.env.preview.example](../frontend/mobile/.env.preview.example)은 값 준비용 목록이다. Expo가 이 파일을
자동으로 읽지는 않는다. 개발 중인 `.env.local`을 이 파일로 덮어쓰거나 실제 값을 Git에 기록하지 않는다.
Expo 프로젝트의 **Environment variables** 화면에서 아래 값을 환경 **preview**에 등록한다.

| 변수 | 필수 여부·값 | EAS 등록 방식 |
|---|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | 필수. 실제 공개 HTTPS API origin | String / Plain text |
| `EXPO_PUBLIC_EAS_PROJECT_ID` | 필수. 실제 Expo 프로젝트 UUID | String / Plain text |
| `EXPO_PUBLIC_WEB_BASE_URL` | 공유 링크 제공 시 HTTPS 웹 origin, 그 외 생략 | String / Plain text |
| `EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN` | 기본 `false`. 서버·공급자 설정 완료 후 `true` | String / Plain text |
| `EXPO_PUBLIC_ASSISTANT_AI_ENABLED` | 기본 `false`. 로그인 회원 도우미 자유 질문 제공 시 `true` | String / Plain text |
| `GOOGLE_SERVICES_JSON` | 푸시 제공 시 Android 설정 JSON | File / Secret. 로컬 PC 경로 문자열을 등록하지 않음 |

`EXPO_PUBLIC_` 값은 앱 번들에 포함되는 공개 값이다. OpenAI 키·DB 비밀번호·OAuth client secret·
Vercel 프록시 비밀값을 등록하지 않는다. 도우미 자유 질문 플래그는 AI 검색 전체를 끄는 설정이 아니다.

로컬 `.env.local`은 Git에서 제외되므로 클라우드 빌드에 전달되지 않는다. `eas.json`의
`environment=preview`가 EAS 환경값을 선택한다. API origin·기능 플래그 같은 앱 번들 설정을
변경하면 새 APK를 빌드·배포해야 한다.

### 공개 API와 서버 환경

기존 Vercel 운영 origin을 API 입구로 사용할 수 있지만, 웹 페이지의 HTTP 200만으로 API 연결을
확인한 것으로 판단하지 않는다. 실제 `/api/v1/health`, 모바일 로그인, 공개 검색과 Bearer 인증 요청의
전달을 확인한다. 현재 Vercel middleware는 `Authorization`을 전달하며 서버 전용 프록시 비밀값을 붙인다.
앱은 프록시 비밀값을 직접 만들거나 CloudFront 접근 제한을 우회하지 않는다.

Vercel Production의 `GOVBIZ_FRONTEND_ORIGIN`, `GOVBIZ_API_ORIGIN`, `GOVBIZ_PROXY_SECRET`과
실제 운영 서버의 Core·AI·DB·검색 데이터를 먼저 준비한다. 주소·인증·기동은
[AWS/Vercel 배포](deployment-aws-vercel.md)와 [EKS/Vercel 배포](../infrastructure/eks/continuous-deployment.md)를 따른다.
Firebase에 APK를 배포해도 기존 서버가 가동되지 않으면 업무 기능은 사용할 수 없다.

소셜 로그인은 서버 `ACCOUNT_MOBILE_OAUTH_REDIRECT_URIS=govbiz://oauth/complete`와 기존 공급자 설정을
준비한 뒤 앱 플래그를 켠다. 리포트·마감 푸시는 실제 사용하는 서버 실행 설정과 발송 인증도 준비한다.
운영 Compose의 `DAILY_REPORT_ENABLED` 고정값처럼 실제 실행 설정이 환경파일과 다를 수 있으므로
로컬 `.env` 변경만으로 운영 기능이 켜졌다고 판단하지 않는다.

### 푸시를 제공할 때

`google-services.json`은 Android 앱의 Firebase 등록 설정이다. 로컬 모바일 폴더에 두면
`.env.local`에서 `GOOGLE_SERVICES_JSON=./google-services.json`으로 지정할 수 있다. EAS에서는 같은
이름의 File 환경변수로 파일을 등록한다. 빌드 서버가 파일을 복원해 그 경로를 제공하면 기존 config가 읽는다.
Secret File은 로컬 config 평가에서 내려받을 수 없으므로, 로컬에서 이 설정을 확인할 때는 로컬 파일 경로를 사용한다.

**FCM v1 서비스 계정 JSON은 다른 파일**이다. Expo 프로젝트의 Android 앱 `ai.govbiz.mobile`에 대한
Push Credentials에 등록하며 `GOOGLE_SERVICES_JSON`, 앱 assets 또는 공개 환경변수에 넣지 않는다.
상세 경로와 서버 발송 설정은 [모바일 푸시](mobile-report-push.md)를 따른다.

## 프로젝트 연결과 최종 로컬 확인

Node 24.x·pnpm 11.22.x를 준비하고 저장소 루트에서 `pnpm install --frozen-lockfile`을 실행한다.
의존성·lockfile은 루트에서 관리하고 EAS 명령은 `frontend/mobile`에서 실행한다.
EAS 프로필은 `pnpm: 11.22.0`으로 설치 버전을 지정하며 `corepack: true`를 함께 지정하지 않는다.
두 설정을 함께 사용하면 Corepack shim과 EAS의 pnpm 전역 설치가 `EEXIST`로 충돌할 수 있다.
네이티브 폴더는 현재 Git 제외 대상이므로 EAS가 소스에서 Prebuild한다. 루트 workspace·lockfile과
`frontend/packages/shared`를 업로드에서 제외하지 않는다. 루트 `.easignore`는 기존 root/mobile 제외 규칙을
포함하고 backend·web·인프라·평가·문서·작업용 체크아웃을 APK 업로드에서 제외한다. 실제 archive 단계에서
모바일·shared·루트 workspace/lockfile 포함과 환경파일·인증파일 제외를 함께 확인한다.

아래 PowerShell 예시의 값은 모두 실제 값으로 바꾼다. 별도 터미널 세션의 환경변수를 사용하면
기존 개발용 `.env.local`을 덮어쓰지 않고 프로젝트 연결과 preview 설정을 확인할 수 있다.

```powershell
Set-Location frontend/mobile # 저장소 루트에서 실행

$env:EXPO_PUBLIC_EAS_PROJECT_ID = '실제-Expo-프로젝트-UUID'
$env:EXPO_PUBLIC_API_BASE_URL = 'https://실제-공개-API-origin'
# 공유 링크를 제공한다면 공개 웹 origin도 설정한다.
$env:EXPO_PUBLIC_WEB_BASE_URL = 'https://실제-공개-웹-origin'
$env:EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = 'false'
$env:EXPO_PUBLIC_ASSISTANT_AI_ENABLED = 'false'

pnpm.cmd dlx eas-cli@latest login --browser
pnpm.cmd dlx eas-cli@latest whoami
pnpm.cmd dlx eas-cli@latest init --id $env:EXPO_PUBLIC_EAS_PROJECT_ID
pnpm.cmd dlx eas-cli@latest project:info
```

프로젝트를 새로 만들어야 하면 Expo에서 실제 계정/조직에 프로젝트를 생성해 UUID를 먼저 확보한다.
`pnpm.cmd`는 Windows PowerShell에서 `pnpm.ps1` 실행 정책에 막히지 않고 실행한다. 브라우저 로그인은
웹에서 사용하는 소셜 로그인도 지원하며 Google 계정 비밀번호를 CLI의 Expo Password에 입력하지 않는다.
동적 `app.config.ts`는 EAS가 자동 수정할 수 없다. config의 `owner: 'seop1026'`, `slug: 'govbiz'`를
실제 Expo 프로젝트 `@seop1026/govbiz`에 맞췄고 프로젝트 UUID는 기존 환경변수 방식으로 반영한다.
소유자나 slug 덮어쓰기 안내가 나오면 실제 프로젝트 정보를 확인해 config를 직접 맞춘 뒤 연결 명령을 다시 실행한다.
연결 결과의 소유 계정·프로젝트 ID를 확인하고 EAS `preview` 환경값도 별도로 등록한다.
EAS CLI는 명령 실행용으로 사용하며 production 의존성에는 추가하지 않는다.

설정·문서·관련 테스트를 모두 작성한 뒤 최종 검증을 모아서 수행한다.

```powershell
# 위의 실제 배포 환경값을 지정한 모바일 디렉터리의 터미널에서 실행
pnpm.cmd test --runTestsByPath src/test/appConfig.test.ts src/api/client.test.ts
pnpm.cmd typecheck
pnpm.cmd lint

$env:EAS_BUILD_PROFILE = 'preview'
pnpm.cmd exec expo config --type public
pnpm.cmd export
Remove-Item Env:EAS_BUILD_PROFILE

# 저장소 루트로 이동한 뒤 실행
git diff --check
```

`preview` config는 Expo UUID 누락·형식 오류와 API의 HTTP/하위 경로/인증정보/쿼리/fragment를 오류로
중단한다. 선택적인 웹 origin도 값이 있으면 HTTPS origin이어야 한다. 로컬 개발과 일반 CI export는
프로젝트 정보 없이 기존대로 실행할 수 있다. 형식 검사는 실제 프로젝트 소유권·서버 연결의 확인을 대신하지 않는다.
EAS는 빌드 작업에 `EAS_BUILD_PROFILE`을 제공하며, 위 로컬 확인에서는 이를 직접 지정한다.

## APK 빌드와 팀원 배포

변경한 영역의 필수 CI가 실제로 통과한 소스를 대상으로 APK를 빌드한다. 현재 CI는 Mobile의
test·typecheck·lint·iOS/Android JS export를 수행한다. app config와 EAS 설정은 모바일 변경 범위에
포함되며 lint도 `app.config.ts`를 확인한다. CI export는 네이티브 APK 빌드나 실기기 확인을 대신하지 않는다.

```powershell
# frontend/mobile에서 실행. 실제 프로젝트 연결과 EAS preview 환경값 등록 후 실행한다.
pnpm.cmd dlx eas-cli@latest build --platform android --profile preview
```

클라우드 빌드는 EAS에 등록한 환경값으로 수행한다. 최초 빌드에서는 Android 서명키를 선택·생성하고
이후 동일 키를 유지한다. EAS 관리 키를 사용하는 이 구성에서는 앱에 로컬 `credentials.json`을 만들 필요가 없다.
생성된 APK는 EAS 빌드 화면에서 내려받는다. APK·서명키·실제 환경파일은 Git에 넣지 않는다.

1. Firebase 프로젝트에 Android 앱을 패키지 `ai.govbiz.mobile`로 등록하거나 기존 등록을 확인한다.
2. App Distribution을 시작하고 팀원 검증 그룹을 만든다.
3. APK를 업로드하고 실제 변경 내용·버전·확인할 기능으로 릴리스 노트를 작성한다.
4. 팀원 그룹에 배포하고 초대를 수락해 설치한다.
5. 아래 실기기 확인을 마친 APK만 발표 참석자 그룹에 배포한다.

## 실기기 확인과 발표 QR

| 확인 대상 | 실제로 확인할 결과 |
|---|---|
| 설치·첫 실행 | Expo Go·Metro 서버 없이 홈 화면에서 실행 |
| Wi-Fi·LTE | 공개 API 접속과 오류 표시 |
| 공개 기능 | 검색·필터·공고 상세·공식 원문 열기 |
| 회원 기능 | 로그인·로그아웃·관심 공고·본인 데이터 접근 |
| 발표할 추가 기능 | 리포트·문서 다운로드/공유·소셜 로그인 등 제공 범위 |
| 푸시 제공 시 | 권한·등록·수신·알림 선택 후 본인 화면 이동 |
| 후속 APK | 같은 서명키와 증가한 versionCode로 업데이트 |

기기에 같은 패키지의 개발 APK가 있으면 다른 서명키 때문에 설치가 실패할 수 있다. 기존 앱 제거가
필요한 경우 저장 데이터·로그인 상태의 영향을 확인하며, 기존 앱이나 데이터를 자동 삭제하지 않는다.
실제 AI 호출 검증은 승인된 전송 데이터·호출 예산 안에서 실행하며, mock 테스트를 실제 검색 품질로 보고하지 않는다.

Firebase에서 발표 참석자 전용 그룹을 만들고 확인된 APK를 그 그룹에 배포한다. Invite links에서
해당 그룹의 초대 링크를 만들고 그 링크를 QR로 제공한다. 그룹 링크는 해당 그룹이 접근할 수 있는
모든 앱·릴리스를 제공하므로 참석자 그룹에는 제공할 앱·릴리스만 연결한다.

참석자는 이메일 등록 → Google 계정으로 초대 수락 → APK 다운로드·설치 → GovBiz 실행 순서로 이용한다.
기기에 따라 알 수 없는 앱 설치 허용이 필요하다. Firebase 초대 수락과 GovBiz 회원 로그인은 별개다.
QR을 사전 안내에도 제공하면 발표 현장의 설치 시간을 줄이는 데 도움이 된다.

버전·실제 소스 커밋 SHA(커밋된 경우)·EAS Build ID·Firebase 릴리스·실기기 확인 범위를 기록한다.
미커밋 소스 빌드는 해당 상태를 함께 표시하며, EAS에 표시된 SHA만으로 로컬 변경까지 검증되었다고 판단하지 않는다.
설정 추가·CI 통과·APK 빌드·Firebase 배포·실기기 연결을 각각 구분해 보고한다.

## 업데이트와 제공 종료

다음 APK는 `app.config.ts`의 `android.versionCode`를 증가시키고 필요하면 사용자 표시 `version`도
변경한 뒤 검증·빌드·같은 그룹 배포를 반복한다. 로컬 버전 소스를 사용하므로 자동 증가에 의존하지 않는다.
API 주소·아이콘·네이티브 인증·앱 번들 설정 변경도 새 APK에 반영한다.

병합과 실제 배포는 사용자가 요청한 범위에서 진행하고, 실기기 확인 여부를 별도로 기록한다.
발표 후에는 초대 링크의 유지 여부, 서버·AI 기능 제공 기간과 문의처를 정한다. Firebase 빌드는
150일 동안 제공되고 초대 수락 기한은 30일이다. 실제 기능 제공 기간은 기존 서버 운영 기간에도 달려 있다.

## 공식 참고

- [Expo 모노레포 EAS 설정](https://docs.expo.dev/build-reference/build-with-monorepos/)
- [EAS 빌드 프로필](https://docs.expo.dev/build/eas-json/) · [APK 생성](https://docs.expo.dev/build-reference/apk/)
- [EAS 환경변수](https://docs.expo.dev/eas/environment-variables/) · [빌드에서 사용](https://docs.expo.dev/eas/environment-variables/usage/)
- [Expo FCM 인증](https://docs.expo.dev/push-notifications/fcm-credentials/)
- [Firebase APK 콘솔 배포](https://firebase.google.com/docs/app-distribution/android/distribute-console)
- [Firebase 초대 링크](https://firebase.google.com/docs/app-distribution/create-invite-links)
- [Android 테스터 설치](https://firebase.google.com/docs/app-distribution/get-set-up-as-a-tester?platform=android)
