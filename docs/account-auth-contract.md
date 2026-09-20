# 계정·인증 HTTP 계약

이메일 로그인과 세션 확인·로그아웃, 소셜 로그인(카카오·Google), 개발용 시드 로그인의 공개 API를 정리합니다. 계정 이메일
인증은 다음 단계에서 추가합니다. 구현 범위는 [구현 현황](implementation-status.md)을 참고하세요.

```text
Browser
  → POST /api/v1/auth/login · /logout, GET /api/v1/auth/me   (세션은 HttpOnly 쿠키 govbiz_session)
      → AccountAuthController → AccountLoginService · AccountSessionService
          → AccountRepository → MySQL (account, account_session)
  → GET /api/v1/auth/oauth/{provider}/authorize · /callback   (브라우저 최상위 이동, 302)
      → AccountOAuthController → AccountOAuthService → GoogleOAuthClient · KakaoOAuthClient → 공급자
          → AccountRepository → MySQL (account, account_oauth_identity, account_session)
  → POST /api/v1/auth/dev-login   (app.account.dev-login.enabled=true 일 때만 등록)
      → AccountDevLoginController → AccountDevLoginService
```

| Method·Path | 인증 | 성공 |
|---|---|---|
| `POST /api/v1/auth/login` | 없음 | 200 세션 응답 + `Set-Cookie` |
| `GET /api/v1/auth/oauth/providers` | 없음 | 200 설정된 소셜 로그인 공급자와 시작 주소 |
| `GET /api/v1/auth/oauth/{kakao\|google}/authorize` | 없음 | 302 공급자 로그인 화면 + 로그인 상태 쿠키 |
| `GET /api/v1/auth/oauth/{kakao\|google}/callback` | 로그인 상태 쿠키 | 302 프런트 + `Set-Cookie` (실패는 `/login?oauthError=`) |
| `POST /api/v1/auth/dev-login` | 없음 | 200 세션 응답 + `Set-Cookie` (개발 환경 전용) |
| `GET /api/v1/auth/me` | 세션 쿠키 | 200 계정 |
| `POST /api/v1/auth/logout` | 세션 쿠키 | 204 + 쿠키 만료 |
| `PUT /api/v1/me/password` | 세션 쿠키 + Origin | 204. 현재 비밀번호 없이 새 비밀번호만 받고 다른 기기 세션 종료 |
| `GET /api/v1/me/deletion-preview` | 세션 쿠키 | 200 삭제 시 함께 닫히는 것의 수 |
| `DELETE /api/v1/me` | 세션 쿠키 + Origin | 204 + 쿠키 만료 |

## 권한 단계

화면 권한은 역할 이름이 아니라 계정이 통과한 확인 단계 `tier`로 정합니다. 서버가 계정 상태로 계산해 모든 세션
응답에 내려 주고, 프런트의 `RequireAuth`는 이 값으로만 `/app` 아래 라우트를 나눕니다. `GuestOnly`(로그인·회원가입)와
`PublicOnly`(공개 화면)는 세션 유무만 보고 로그인한 사용자를 각각 복귀 경로와 같은 내용의 `/app` 화면으로 보냅니다.
서버는 프런트 판단을 믿지 않고 쓰기 API마다 같은 단계를 다시 검사합니다.

| `tier` | 조건 | 열리는 화면 |
|---|---|---|
| (익명) | 세션 없음 | 공개 화면: 검색·상세·원문 질문·요금제·파트너 모집 읽기(`/`, `/pricing`, `/partners`), 로그인·회원가입 |
| `MEMBER` | 로그인 | 사이드바 작업 화면(`/app/chat` `/app/pricing` `/app/partners` `/app/profile` …) |
| `COMPANY` | 사업자등록번호 조회(Bizno)로 확인한 기업 등록 | 파트너 모집글 작성. 이메일 인증 조건은 인증 기능이 생길 때 더함 |
| `ADMIN` | `account.role = ADMIN` | 위 전부 + `/app/admin/*`(계정 관리). 서버는 `/api/v1/admin/*`마다 역할을 다시 확인 |

## 세션 쿠키

세션 JWT는 응답 본문이 아니라 쿠키로만 전달합니다. 브라우저 스크립트는 토큰을 읽을 수 없고, 브라우저가
같은 호스트로 보내는 요청에 자동으로 붙입니다. 프런트는 `fetch`에 `credentials: 'include'`만 둡니다.

```http
Set-Cookie: govbiz_session=<JWT>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax
```

| 속성 | 값 |
|---|---|
| `HttpOnly` | 항상. XSS로 토큰을 읽지 못하게 함 |
| `Secure` | `ACCOUNT_COOKIE_SECURE`(기본 `true`). HTTPS가 없는 로컬 개발(Compose)만 `false` |
| `SameSite=Lax` | 다른 사이트에서 시작한 POST에는 붙지 않음. 링크로 들어오는 GET에는 붙어 로그인 상태가 유지됨 |
| `Max-Age` | `rememberMe=true`일 때만 `ACCOUNT_SESSION_TTL`(기본 30일). `false`면 속성이 없어 브라우저를 닫으면 사라짐 |
| `Domain` | 없음. 발급한 호스트에만 묶임 |

JWT는 HS256이며 `sub`=계정 ID, `iat`·`exp`=초 단위 epoch, `jti`=무작위입니다. Core는 토큰 원문을 저장하지
않고 SHA-256 해시와 절대 만료·마지막 사용 시각을 `account_session`에 둡니다.

### 만료

| 종류 | 값 | 설명 |
|---|---|---|
| 절대 만료(로그인 상태 유지) | `ACCOUNT_SESSION_TTL` = 30일 | JWT `exp`·세션 행 `expires_at`·쿠키 `Max-Age`가 같은 시각 |
| 절대 만료(유지 안 함) | `ACCOUNT_SESSION_SHORT_TTL` = 12시간 | 쿠키는 브라우저 세션 쿠키이고 서버 행이 12시간 뒤 만료 |
| 유휴 만료 | `ACCOUNT_SESSION_IDLE_TTL` = 7일 | 마지막 사용 뒤 7일이 지나면 절대 만료 전이라도 401 |

`GET /me`와 `Account` 파라미터를 받는 모든 API는 서명·만료를 먼저 검사한 뒤 해시로 세션 행을 찾고, 절대·유휴
만료를 확인한 다음 계정을 읽습니다. 마지막 사용 시각은 5분에 한 번만 갱신해 UPDATE를 줄입니다. 로그아웃(행 삭제)된
토큰은 JWT가 유효해도 401이고, 정지된 계정은 403입니다. 로그인할 때마다 새 세션을 만들고 같은 계정의 만료
세션을 정리합니다.

### CSRF

세션 쿠키가 붙은 상태 변경 요청(POST·PUT·PATCH·DELETE)은 두 겹으로 막습니다.

1. `SameSite=Lax`라 다른 사이트의 폼·스크립트가 보내는 POST에는 쿠키가 붙지 않습니다.
2. `Origin` 헤더가 `APP_CORS_ALLOWED_ORIGIN`(쉼표로 여러 개 가능) 중 하나여야 합니다. `Origin`이 없으면 `Referer`의
   origin으로 판단하고, 둘 다 없으면 브라우저 요청으로 볼 수 없어 403 `SESSION_ORIGIN_REJECTED`입니다. 허용되지 않은
   origin은 CORS 처리기가 먼저 403으로 거절하고 `/api/**`에 등록된 `SessionOriginInterceptor`가 한 번 더 막습니다.
   curl로 세션 쿠키를 흉내낼 때는 허용 origin을 함께 보냅니다. Compose 기본값은
   `-H "Origin: http://127.0.0.1:5173"`입니다. 세션 쿠키가 없는 요청은 검사하지 않습니다.

## 회원가입

```http
POST /api/v1/auth/signup
Content-Type: application/json

{ "email": "manager@company.co.kr", "password": "password1", "emailPassToken": "<43자 통행 토큰>" }
```

| 필드 | 규칙 |
|---|---|
| `email` | 이메일 형식, 320자 이하. Core가 앞뒤 공백 제거·소문자로 정규화해 저장하며 같은 이메일은 409. 탈퇴한 계정의 이메일은 익명화되므로 다시 가입할 수 있음 |
| `password` | 8~72자. 길이만 검사하고 문자 종류는 강제하지 않음. BCrypt 해시만 저장 |
| `emailPassToken` | 아래 회원가입 이메일 인증에서 인증번호를 맞히면 받는 43자 통행 토큰. 같은 이메일로 인증한 것이어야 하며 없거나 다르면 422 `EMAIL_VERIFICATION_REQUIRED` |

성공하면 201과 함께 아래 로그인과 같은 세션 응답을 돌려주고 브라우저 세션 쿠키(`rememberMe=false`와 같음)를
발급합니다. 계정은 `role=USER`, `tier=MEMBER`, `emailVerified=true`(가입 전 인증번호로 확인한 이메일)로 만들어지고 약관 동의
시각은 요청 시각으로 기록합니다. 통행 토큰은 가입에 한 번 쓰면 끝납니다. 가입 시도는 로그인과 같은 접속 주소 한도(분당 20회)를 함께 씁니다.

## 로그인

```http
POST /api/v1/auth/login
Content-Type: application/json

{ "email": "manager@company.co.kr", "password": "password1", "rememberMe": true }
```

| 필드 | 규칙 |
|---|---|
| `email` | 이메일 형식, 320자 이하. Core가 앞뒤 공백 제거·소문자로 정규화해 조회 |
| `password` | 1~72자. 규칙 검사는 가입 시에만 하며 로그인은 일치 여부만 확인 |
| `rememberMe` | 선택, 기본 `false`. `true`면 30일 영구 쿠키, `false`면 브라우저 세션 쿠키 + 12시간 |

세션 응답은 로그인과 개발용 로그인이 같습니다.

```json
{
  "expiresAt": "2026-10-06T12:00:00+09:00",
  "account": { "email": "manager@company.co.kr", "role": "USER", "tier": "MEMBER", "emailVerified": true, "hasPassword": true }
}
```

| 필드 | 설명 |
|---|---|
| `expiresAt` | 세션 절대 만료 시각(서울 offset). `rememberMe=true`면 쿠키의 Max-Age와 같음 |
| `account.role` | `USER` 또는 `ADMIN`. 가입 시에는 항상 `USER` |
| `account.tier` | 권한 단계 `MEMBER`·`COMPANY`·`ADMIN` |
| `account.emailVerified` | 이메일 인증 완료 여부. 이메일 가입은 인증번호를 거치고 소셜 가입은 공급자가 인증한 이메일만 받으므로 새 계정은 항상 `true`. 인증 기능 이전에 만든 계정만 `false`일 수 있음 |
| `account.hasPassword` | 비밀번호를 만든 계정인지. 소셜 로그인으로만 가입한 계정은 `false`이며 프로필이 비밀번호 항목을 숨기고 계정 삭제에 비밀번호를 묻지 않음 |

### 로그인 시도 제한

한 Core 프로세스의 메모리에서 계정과 접속 주소 기준으로 제한합니다. 넘으면 429 `LOGIN_RATE_LIMITED`이며
`Retry-After` 헤더와 본문 `retryAfterSeconds`에 다시 시도할 수 있는 초를 담습니다.

| 기준 | 규칙 |
|---|---|
| 계정(정규화한 이메일) | 연속 실패 5회부터 잠금. 30초에서 시작해 실패가 이어질 때마다 두 배, 최대 15분. 성공하면 초기화 |
| 접속 주소 | 최근 60초 20회 |

## 개발용 시드 로그인

`ACCOUNT_DEV_LOGIN_ENABLED=true`(Compose 기본값)일 때만 `POST /api/v1/auth/dev-login`이 등록됩니다.
본문 없이 부르면 `ACCOUNT_DEV_LOGIN_EMAIL`(기본 `admin@govbiz.local`)의 관리자 계정, `{ "role": "USER" }`를
보내면 `ACCOUNT_DEV_LOGIN_MEMBER_EMAIL`(기본 `member@govbiz.local`)의 회원 계정으로 30일 세션 쿠키를 발급합니다.
계정이 없으면 이메일 인증이 끝난 상태로 만들고 `ACCOUNT_DEV_LOGIN_PASSWORD`(기본 `govbiz-admin1`)를 비밀번호로
저장하므로 일반 로그인 화면에서도 같은 값으로 로그인됩니다. 회원가입 API가 붙기 전까지 로그인 흐름을 확인하는
용도이며, 운영 환경에서는 반드시 `false`로 두고 꺼져 있으면 404입니다. 프런트의 `개발 로그인 · 관리자`·`개발 로그인 · 회원`
버튼은 개발 빌드(`import.meta.env.DEV`)에서만 렌더링됩니다.

## 사업자등록번호 확인

기업 등록 전에 회원이 입력한 사업자등록번호를 국세청 조회(Bizno API)로 확인합니다. 조회 결과에서는 상호와 사업자 상태만
쓰고 법인번호·과세유형은 쓰지 않습니다. 세션 쿠키가 필요하며 국세청 조회 자체는 서버만 호출합니다.

```http
GET /api/v1/me/company/lookup?businessNumber=124-81-00998
Cookie: govbiz_session=<JWT>
```

```json
{ "businessNumber": "1248100998", "companyName": "삼성전자(주)", "businessStatus": "계속사업자", "isActive": true }
```

| 필드 | 설명 |
|---|---|
| `businessNumber` | 요청은 하이픈 선택, 응답은 숫자 10자리 |
| `companyName` `businessStatus` | 국세청 원문. 상태는 계속사업자·휴업자·폐업자 |
| `isActive` | 계속사업자(상태 코드 `01`)만 `true`. 기업 등록은 이 값이 `true`일 때만 허용할 예정 |

등록되지 않은 번호는 404 `BUSINESS_NOT_FOUND`이고, 국세청 조회가 안 되는 경우는 `BIZNO_*` 코드로 구분합니다.
## 기업 등록·프로필

기업은 계정당 하나이며 사업자등록번호는 Bizno 조회 API로 확인합니다. 조회 결과에서는 상호와 사업자 상태만 쓰고
소재지·업종·설립연도와 홈페이지(선택)는 담당자가 입력합니다. 모든 요청은 세션 쿠키가 필요합니다.

| 메서드·경로 | 용도 | 성공 |
|---|---|---|
| `GET /api/v1/me/company/lookup?businessNumber=` | 등록 전 미리보기. 하이픈 선택 | 200 `businessNumber`(10자리) `companyName` `businessStatus` `isActive` |
| `GET /api/v1/me/company` | 내 기업 | 200 기업 응답, 없으면 404 `COMPANY_NOT_REGISTERED` |
| `POST /api/v1/me/company` | 등록. 서버가 다시 조회해 계속사업자만 허용 | 201 기업 응답. 이후 `/auth/me`의 `tier`가 `COMPANY` |
| `PUT /api/v1/me/company` | 담당자 입력 항목 수정 | 200 기업 응답 |

```http
POST /api/v1/me/company
Content-Type: application/json
Cookie: govbiz_session=<JWT>

{ "businessNumber": "124-81-00998", "region": "서울특별시", "industry": "정보통신업", "foundedYear": 2020,
  "homepageUrl": "https://example.co.kr" }
```

| 필드 | 규칙 |
|---|---|
| `businessNumber` | 등록 때만. 숫자 10자리, 하이픈 선택. 상호·상태는 서버가 조회 결과로 채우므로 받지 않음 |
| `region` `industry` | 1~40자 / 1~80자. 프런트는 17개 시·도와 표준산업분류 대분류 목록에서 고름 |
| `foundedYear` | 1900~올해. 올해를 넘으면 400 `REQUEST_VALIDATION_FAILED`에 `errors[].field=foundedYear` |
| `homepageUrl` | 선택. `http(s)://`로 시작하고 공백이 없는 500자 이하 주소. 앞뒤 공백은 다듬고 빈 문자열은 비운 것으로 저장. 다른 스킴은 400 `errors[].field=homepageUrl` |

기업 응답은 요청 필드(`businessNumber`·`region`·`industry`·`foundedYear`·`homepageUrl`)에 `companyName` `businessStatus`
`businessVerifiedAt` `updatedAt`을 더한 것입니다. 세션·내 계정 응답의 `account.company`에는 `companyName`·`businessNumber` 요약이 실리고 기업이 없으면 `null`입니다.

### 협업·파트너 설정

기업이 파트너 모집에서 어떤 역할과 분야로 협업할지 밝히는 설정입니다. 모집글 상세와 기업 프로필 보기에서 다른 기업에게
보이며 담당자 연락처는 담지 않습니다. 기업이 없으면 404 `COMPANY_NOT_REGISTERED`입니다.

```http
GET /api/v1/me/company/partner-profile
PUT /api/v1/me/company/partner-profile
Cookie: govbiz_session=<JWT>

{ "roles": ["LEAD", "PARTICIPANT"], "interestAreas": ["기술", "사업화"],
  "introduction": "AI 문서 분류 SaaS를 만드는 팀입니다.", "capabilities": ["문서 분류 AI", "공공 레퍼런스"] }
```

| 필드 | 규칙 |
|---|---|
| `roles` | 모집글의 `PartnerRole`(`LEAD`·`PARTICIPANT`·`DEMAND`) 1개 이상, 중복 제거. 프런트는 주관기관·참여기관만 고름 |
| `interestAreas` | 최대 3개, 각 30자 이하. 지원사업 검색의 분야 이름을 씀. 빈 값은 버림 |
| `introduction` | 선택, 200자 이하. 앞뒤 공백을 다듬어 저장 |
| `capabilities` | 최대 5개, 각 30자 이하, 중복 불가. 모집글 역량 칩과 같은 형식 |

응답은 요청 필드에 `isSet`(저장한 적이 있는지)과 `updatedAt`을 더한 것입니다. 저장한 적이 없으면 `isSet=false`와
빈 목록·빈 문자열이고, `PUT`은 기업당 한 행을 만들거나 덮어씁니다.

## 파트너 모집글

모집글은 제공처에 현재 있는 공고 하나에 묶이며, 작성은 기업을 등록한 회원(`COMPANY`)만, 수정·마감은 작성자만 할 수 있습니다. 읽기는 세션 없이도
가능하고 쿠키가 있으면 `isMine`으로 내 글을 표시합니다. 담당자 이름·연락처는 응답에 싣지 않습니다.

| 메서드·경로 | 용도 | 성공 |
|---|---|---|
| `GET /api/v1/partners/recruitments` | 목록. `keyword`(제목·공고·기관·기업명, 100자) `seekingRole`(LEAD·PARTICIPANT·DEMAND, 여러 번 보내 함께 고름) `region`(시·도 또는 전국, 여러 번 보내 함께 고름) `sourceCode`(묶인 공고의 출처, 예: BIZINFO. 비우면 전체) `mine`(세션 필요) `sort`(DEADLINE·RECENT) `page` `pageSize`(1~50, 기본 20) | 200 `recruitments[]` `total` `page` `pageSize` `totalPages` |
| `GET /api/v1/partners/recruitments/{id}` | 상세 | 200 모집글 응답, 없으면 404 `RECRUITMENT_NOT_FOUND` |
| `POST /api/v1/partners/recruitments` | 작성. 서버가 공고 존재·접수 상태·마감일·중복을 확인 | 201 모집글 응답 |
| `PUT /api/v1/partners/recruitments/{id}` | 수정. 작성자만, 모집 중인 글만. 묶인 공고는 바꾸지 않으므로 본문은 작성 요청에서 `sourceCode`·`sourceProgramId`를 뺀 것. 마감일 규칙은 작성과 같음 | 200 모집글 응답. 남의 글 403 `RECRUITMENT_ACTION_FORBIDDEN`, 마감된 글 422 `RECRUITMENT_CLOSED` |
| `POST /api/v1/partners/recruitments/{id}/close` | 수동 마감. 작성자만. 대기 중인 제안은 조회 시점에 만료로 계산 | 200 모집글 응답(`status` CLOSED). 이미 끝난 글 422 `RECRUITMENT_CLOSED` |

```http
POST /api/v1/partners/recruitments
Content-Type: application/json
Cookie: govbiz_session=<JWT>

{ "sourceCode": "BIZINFO", "sourceProgramId": "PBLN_000000000112345", "title": "AI 실증 과제 참여기관 구합니다",
  "body": "라벨링 운영을 맡아 주실 참여기관을 찾습니다.", "ownRole": "LEAD", "seekingRole": "PARTICIPANT", "seekingCount": 1,
  "region": "서울", "minimumCompanyAgeYears": 3, "capabilities": ["데이터 구축", "라벨링"], "recruitmentDeadline": "2026-09-20" }
```

| 필드 | 규칙 |
|---|---|
| `sourceCode` `sourceProgramId` | 공고 검색·상세가 쓰는 제공처 식별자 조합. 제공처에서 사라진 공고는 404 |
| `title` `body` | 1~80자 / 1~2000자 |
| `ownRole` | `LEAD` 또는 `PARTICIPANT`. 수요처는 찾는 역할로만 씀 |
| `seekingRole` `seekingCount` | 찾는 역할과 기업 수(1~9곳) |
| `region` | 공고 분류와 같은 시·도 이름 또는 `전국`(20자 이하). 목록에서 지역을 고르면 그 지역들과 전국 모집글이 함께 보임 |
| `minimumCompanyAgeYears` | 찾는 기업의 최소 업력(년), 1~50. 생략·null이면 무관 |
| `capabilities` | 30자 이하 문자열 최대 10개. 중복은 한 번만 저장 |
| `recruitmentDeadline` | 오늘 이후이면서 공고 접수 마감 전날까지. 접수 마감일이 없는 공고는 제한 없음 |

모집글 응답은 요청 필드에 `id` `status`(OPEN·CLOSED, 마감일·공고 접수 마감·수동 마감으로 조회 시점에 계산) `isMine`
`proposalCount`(철회하지 않은 제안 수) `myProposal`(로그인한 회원이 이 모집글에 보낸 제안의 `id` `status`, 없으면 null) `company`(`companyName` `region` `industry` `foundedYear` `isEmailVerified` `isBusinessVerified`)
`program`(`sourceCode` `sourceProgramId` `title` `organization` `summary` `targetDescription` `applicationPeriod` `applicationEndDate` `sourceUrl`)
`createdAt` `updatedAt`을 더한 것입니다. 목록 항목은 `body`·`ownRole`·`minimumCompanyAgeYears`·`myProposal`·`updatedAt`과 공고 원문 없이
`program`에 `title` `organization` `applicationEndDate`만 싣습니다. 목록은 마감일·공고 접수 마감일·수동 마감으로 모집 중인 글만 고르고
`mine=true`는 마감된 내 글도 포함합니다. 접수 마감일이 없는 공고의 접수 종료 문구는 SQL로 거르지 않으므로 항목의 `status`로 마감을 확인합니다.
한 계정은 같은 공고에 모집글 하나만 쓸 수 있습니다(`uq_partner_recruitment_account_program`).

## 파트너 제안

제안은 기업을 등록한 회원이 모집 중인 남의 모집글에 한 번 보냅니다. 모든 요청은 세션이 필요하고 당사자(제안자·모집글 작성자)만
읽고 처리할 수 있습니다. 이메일 인증 조건은 인증 기능이 생길 때 더합니다.

| 메서드·경로 | 용도 | 성공 |
|---|---|---|
| `POST /api/v1/partners/recruitments/{id}/proposals` | 제안 보내기. `message`(1~500자) `shareProfile`(기본 true) | 201 제안 응답 |
| `GET /api/v1/partners/proposals/{id}` | 제안 하나. 당사자가 아니면 404 | 200 제안 응답 |
| `POST /api/v1/partners/proposals/{id}/accept` `.../decline` | 모집글 작성자의 수락·거절. 대기 중일 때만 | 200 제안 응답 |
| `POST /api/v1/partners/proposals/{id}/withdraw` | 제안자의 철회. 대기 중일 때만 | 200 제안 응답 |
| `GET /api/v1/me/proposals?box=received\|sent` | 제안함. 받은 제안은 내 모집글로 온 것, 보낸 제안은 내가 보낸 것. 다른 `box` 값은 400 `REQUEST_VALIDATION_FAILED` | 200 `box` `proposals[]` `pendingCount` |

제안 응답은 `id` `status` `message` `shareProfile` `isSent`(조회한 회원이 보낸 제안이면 true) `recruitment`(`id` `title` `status`
`recruitmentDeadline`) `counterpart` `createdAt` `expiresAt` `respondedAt`입니다. `status`는 저장하지 않고 조회 시점에 계산합니다.

| `status` | 조건 |
|---|---|
| `PENDING` | 응답·철회가 없고 보낸 지 7일 이내이며 모집글이 모집 중 |
| `ACCEPTED` / `DECLINED` | 작성자가 수락·거절 |
| `WITHDRAWN` | 제안자가 철회 |
| `EXPIRED` | 응답 없이 7일이 지났거나 모집글이 마감됨 |

`counterpart`는 조회한 회원의 상대 기업입니다. `companyName` `isEmailVerified` `isBusinessVerified`는 항상 있고,
`profile`(`region` `industry` `foundedYear` `homepageUrl`)은 제안자가 프로필 공유를 켰거나 제안이 수락됐을 때, `contact`(`email`
`businessNumber`)는 수락됐을 때만 양쪽에 실립니다. 모집글 상세 응답의 `proposalCount`는 철회하지 않은 제안 수이고,
로그인한 회원에게는 `myProposal`(`id` `status`)이 붙습니다. 같은 모집글에는 제안을 한 번만 보낼 수 있습니다
(`uq_partner_proposal_recruitment_proposer`). 거절·만료·철회된 뒤에도 다시 보낼 수 없습니다.

## 내 계정·로그아웃

```http
GET /api/v1/auth/me
Cookie: govbiz_session=<JWT>
```

```json
{ "account": { "email": "manager@company.co.kr", "role": "USER", "tier": "MEMBER", "emailVerified": true, "hasPassword": true } }
```

`POST /api/v1/auth/logout`은 세션 행을 삭제하고 `Max-Age=0` 쿠키로 브라우저의 쿠키를 지운 뒤 204를
돌려줍니다. 이미 없거나 만료된 세션도 204입니다. 쿠키가 없으면 401입니다.

Controller는 `Account` 파라미터를 선언하면 `AuthenticatedAccountArgumentResolver`가 세션 쿠키로 채웁니다.
non-null 파라미터는 세션이 없을 때 401이고, `Account?`는 쿠키가 없으면 null을 넣어 비로그인 조회를 허용합니다.

프런트는 토큰을 다루지 않으므로 앱 시작 시 `/me`를 부를지만 localStorage의 힌트(`govbiz.hasSession`)로
정합니다. 힌트가 틀려도 서버의 401·403이 바로잡고 힌트를 지웁니다. 세션 복원이 끝나기 전에는 `RequireAuth`가
리다이렉트하지 않으며, 로그인 화면은 `?next=`의 앱 안 경로로 돌아갑니다.

## 비밀번호 변경·계정 삭제

비밀번호 변경은 로그인한 세션을 본인 확인으로 삼아 **현재 비밀번호를 받지 않습니다.** 계정 삭제는 되돌릴 수 없으므로
**현재 비밀번호를 다시 확인**하며, 틀리면 422 `CURRENT_PASSWORD_MISMATCH`이고 세션은 그대로입니다(401이 아니라 로그아웃되지
않습니다). 접속 주소 한도(분당 20회)는 로그인과 같이 씁니다.

```http
PUT /api/v1/me/password
Cookie: govbiz_session=<JWT>
Origin: http://127.0.0.1:5173

{ "newPassword": "new-password-2" }
```

| 필드 | 규칙 |
|---|---|
| `newPassword` | 8~72자(가입과 같음) |

성공은 204입니다. 새 해시를 저장하고 **요청한 세션만 남긴 채 같은 계정의 다른 세션 행을 지워** 다른 기기는 401이 됩니다.

```http
GET /api/v1/me/deletion-preview
```

```json
{ "hasCompany": true, "openRecruitmentCount": 2, "receivedPendingProposalCount": 3, "sentPendingProposalCount": 1 }
```

삭제 확인 모달이 보여 주는 수이며 삭제하지 않습니다. `openRecruitmentCount`는 수동 마감하지 않은 내 모집글,
대기 제안 수는 조회 시점 상태로 셉니다.

```http
DELETE /api/v1/me
Cookie: govbiz_session=<JWT>
Origin: http://127.0.0.1:5173

{ "password": "password1" }
```

성공은 204와 `Max-Age=0` 쿠키입니다. 한 transaction에서 내가 보낸 대기 제안 철회, 내 모집글 수동 마감(받은 제안은
만료로 계산), 기업 행 삭제, Google 연결 삭제, 모든 세션 삭제, `deleted_at` 표시와 카카오 연결 해제 작업 저장을 합니다.
계정 행은 모집글·제안이 참조하므로 남기되 이메일을 `deleted+<id>+<시각>@deleted.invalid`로 바꿉니다.
같은 이메일로 다시 가입하면 새 계정이 되고, 옛 계정으로는 로그인할 수 없습니다. 같은 카카오 계정은 외부 연결 해제 성공
확인 전까지 identity UNIQUE를 유지해 재가입을 막습니다. 204는 로컬 탈퇴 완료이며 외부 연결 해제 완료는 아닙니다.
커밋 뒤 DB 작업을 RabbitMQ 또는 전용 직접 worker가 처리합니다. 어드민 키 누락은 FAILED, 불명확한 결과는 UNKNOWN으로
남기고 운영 확인 전까지 차단을 유지합니다. [설정·오류·수동 복구 정책](rabbitmq-account-oauth-unlink.md)을 참고하세요.
소셜 로그인으로만 가입해 비밀번호가 없는 계정(`account.hasPassword=false`)은 `password` 없이 `{}`를 보내 세션만으로 삭제합니다.
비밀번호가 있는 계정은 `password`가 없거나 틀리면 422 `CURRENT_PASSWORD_MISMATCH`입니다.

## 비밀번호 재설정

비밀번호를 잊은 회원이 로그인 없이 쓰는 흐름입니다. 가입 이메일로 30분짜리 일회용 링크를 보내고, 그 토큰으로 새
비밀번호를 저장합니다. 두 요청 모두 세션 쿠키가 없으므로 Origin 검사 대상이 아닙니다.

```http
POST /api/v1/auth/password-reset

{ "email": "manager@company.co.kr" }
```

가입 여부와 관계없이 **항상 204**라 응답으로 계정 존재가 드러나지 않습니다. 계정이 있으면 토큰을 만들어 SHA-256 해시만
`account_password_reset`에 저장하고 원문은 메일 링크 `<frontend-base-url>/reset-password#token=<43자>`에만 싣습니다.
토큰은 fragment라 HTTP 요청·접속 로그·Referer로 나가지 않습니다. 정지된 계정, 시간당 한도(기본 3회)를 넘긴 계정은 조용히
건너뜁니다. 접속 주소 한도(분당 20회)는 로그인과 같이 쓰며 넘기면 429 `LOGIN_RATE_LIMITED`입니다.

SMTP(`ACCOUNT_PASSWORD_RESET_MAIL_ENABLED=true`와 `SMTP_*`)가 없으면 개발용 로그인이 켜진 환경(Compose)에서만 토큰을
저장하고 링크를 Core API 로그(WARN)로 남깁니다. 둘 다 없으면 503 `PASSWORD_RESET_MAIL_UNAVAILABLE`입니다.

```http
POST /api/v1/auth/password-reset/confirm

{ "token": "<43자 URL-safe Base64>", "newPassword": "new-password-2" }
```

| 필드 | 규칙 |
|---|---|
| `token` | 메일 링크의 43자 토큰. 형식이 다르면 400 |
| `newPassword` | 8~72자(가입과 같음) |

성공은 204입니다. 새 해시를 저장하고 **같은 계정의 남은 재설정 토큰과 모든 세션을 지워** 새 비밀번호로 다시 로그인해야
합니다. 토큰이 없거나 만료됐거나 이미 쓴 토큰이면 422 `PASSWORD_RESET_TOKEN_INVALID`이며 셋을 구분하지 않습니다. 정지된
계정은 403 `ACCOUNT_SUSPENDED`입니다. 프런트의 `/forgot-password`는 이메일 하나를 받고, 메일 링크가 여는 `/reset-password`는
주소의 토큰과 새 비밀번호를 보냅니다.

## 회원가입 이메일 인증

가입 화면에서 이메일이 본인 주소인지 6자리 인증번호로 확인하는 흐름입니다. 계정이 아직 없으므로 기록은 이메일 기준이고
세션 쿠키가 없어 Origin 검사 대상이 아닙니다. 인증번호·통행 토큰은 SHA-256 해시만 `signup_email_verification`에 저장합니다.

```http
POST /api/v1/auth/signup/email-code

{ "email": "manager@company.co.kr" }
```

성공은 204이며 메일 제목과 본문에 6자리 인증번호를 보냅니다. 인증번호는 10분 동안 유효하고 한 번호에 5번까지 입력할 수
있습니다. 이미 가입된 이메일은 409 `EMAIL_ALREADY_REGISTERED`(가입 자체가 같은 409를 주므로 새로 드러나는 정보는 없음),
같은 이메일 재전송 대기(60초)나 10분 창 안 발송 한도(3회)를 넘기면 429 `EMAIL_CODE_RATE_LIMITED`와 `retryAfterSeconds`·
`Retry-After`입니다. 접속 주소 한도(분당 20회)는 로그인과 같이 씁니다. SMTP(`ACCOUNT_PASSWORD_RESET_MAIL_ENABLED=true`와
`SMTP_*`, 따로 주면 `ACCOUNT_EMAIL_VERIFICATION_*`)가 없으면 개발용 로그인이 켜진 환경에서만 인증번호를 Core API 로그(WARN)로
남기고, 둘 다 없으면 503 `EMAIL_VERIFICATION_MAIL_UNAVAILABLE`입니다.

```http
POST /api/v1/auth/signup/email-code/verify

{ "email": "manager@company.co.kr", "code": "482137" }
```

```json
{ "passToken": "<43자 URL-safe Base64>", "expiresAt": "2026-09-13T18:00:00+09:00" }
```

가장 최근에 보낸 인증번호와 비교합니다. 틀리면 422 `EMAIL_CODE_INVALID`이고 시도 횟수가 올라갑니다. 보낸 인증번호가 없거나
만료됐거나 시도를 다 썼으면 422 `EMAIL_CODE_EXPIRED`이며 새로 받아야 합니다. 맞으면 30분짜리 통행 토큰을 돌려주고, 가입
요청의 `emailPassToken`에 그대로 실어 보냅니다. 통행 토큰은 인증한 이메일과 짝이어야 하고 가입에 한 번 쓰면 끝납니다.
프런트 `/signup`은 이메일 옆 "인증번호 받기"로 보내고 바로 아래 인증번호 칸의 "확인"으로 맞힌 뒤에만 가입 버튼을 켭니다.
소셜 가입은 공급자가 인증한 이메일만 받으므로 이 흐름을 거치지 않습니다.

## 소셜 로그인(카카오·Google)

OAuth 2.0 인가 코드 흐름과 OpenID Connect입니다. Core가 client secret을 가진 confidential client로 코드를 교환하고 공급자
토큰은 저장하지 않으며, 끝나면 이메일 로그인과 같은 `govbiz_session` 쿠키를 발급합니다. 공급자마다 클라이언트 ID와 시크릿이
둘 다 설정돼야 켜지고, 꺼진 공급자는 목록에 나오지 않습니다. Spring Security OAuth2 Client는 쓰지 않고 `RestClient`로 공식
endpoint를 직접 부릅니다.

```text
Browser  → GET /api/v1/auth/oauth/providers                         설정된 공급자와 시작 주소(카카오·Google 순)
         → GET /api/v1/auth/oauth/{provider}/authorize?next=&rememberMe=
              ← 302 공급자 로그인 화면 + Set-Cookie govbiz_oauth (state·nonce·PKCE verifier·복귀 경로, 10분, HMAC 서명)
Provider → 302 GET /api/v1/auth/oauth/{provider}/callback?code=&state=
              → state를 쿠키와 대조 → 코드 교환(client secret, Google은 PKCE S256) → ID 토큰 iss·aud·exp·iat·nonce 확인
              → sub로 계정 찾기 또는 새 회원 → 302 <frontend>/oauth/complete?next= + Set-Cookie govbiz_session
              → 실패하면 302 <frontend>/login?oauthError=<사유>&next=
```

```json
GET /api/v1/auth/oauth/providers

{ "providers": [{ "provider": "kakao", "startUrl": "http://127.0.0.1:5173/api/v1/auth/oauth/kakao/authorize" }] }
```

| 요청 값 | 규칙 |
|---|---|
| `next` | 로그인 뒤 돌아갈 앱 안의 절대 경로. `//`로 시작하거나 역슬래시·제어 문자가 있으면 `/app/chat` |
| `rememberMe` | `true`면 이메일 로그인의 "로그인 상태 유지"와 같은 30일 세션. 기본은 브라우저 세션 |

**Redirect URI.** 공급자 콘솔에는 `<ACCOUNT_OAUTH_CALLBACK_BASE_URL>/api/v1/auth/oauth/{kakao|google}/callback`을 글자 그대로
등록합니다. callback base는 브라우저가 `/api`에 닿는 origin이며, 로컬 Compose는 Vite가 `/api`를 Core로 넘기므로
`http://127.0.0.1:5173`(`APP_CORS_ALLOWED_ORIGIN`과 같은 호스트)입니다. 시작 주소도 같은 호스트라 로그인 상태 쿠키와 세션
쿠키가 그 호스트에 붙습니다. 모두 GET이라 세션 쿠키 Origin 검사 대상이 아니고, CSRF는 쿠키에 묶인 일회용 state가 막습니다.

**계정 규칙.** 계정은 공급자 계정의 `sub`로만 찾습니다(`account_oauth_identity`, `(provider, subject)` UNIQUE).

| 상황 | 결과 |
|---|---|
| 연결된 `sub` | 그 계정으로 로그인. 공급자 쪽 이메일이 바뀌어도 같은 계정 |
| 처음 온 `sub`, 공급자가 인증한 이메일이 아직 없는 이메일 | 새 회원. 비밀번호 없음, `emailVerified=true`, 약관 동의 시각은 가입 시각(가입 화면 안내로 갈음) |
| 처음 온 `sub`, 그 이메일로 이미 가입한 계정이 있음 | **연결하지 않음** → `account-exists`. 미인증 계정을 먼저 만들어 두는 사전 탈취(pre-account hijacking) 방지 |
| 공급자가 인증한 이메일이 없음 | `email-required` |

비밀번호가 없는 계정은 이메일 로그인이 `INVALID_CREDENTIALS`이며, 응답의 `account.hasPassword=false`로 프로필이 비밀번호 항목을 숨깁니다.
비밀번호가 필요하면 비밀번호 재설정으로 더할 수 있습니다(API `PUT /api/v1/me/password`도 세션만으로 동작).

**ID 토큰 검증.** 토큰 endpoint에서 TLS로 직접 받은 ID 토큰이라 OpenID Connect Core 3.1.3.7(6)에 따라 서명(JWKS) 대신 TLS 서버
검증을 쓰고, 발급자(Google `https://accounts.google.com`·`accounts.google.com`, 카카오 `https://kauth.kakao.com`)·대상(여럿이면
`azp`)·만료·발급 시각(±60초)·nonce는 항상 확인합니다. 이메일은 Google이 ID 토큰의 `email_verified=true`일 때만, 카카오는 ID
토큰에 인증 여부가 없어 사용자 정보 API의 `is_email_valid`·`is_email_verified`가 둘 다 true일 때만 인정합니다. 요청 scope는
Google `openid email`(앱 검수가 필요 없는 범위), 카카오 `openid,account_email`입니다. 카카오 REST 문서에 PKCE가 없어 카카오는
client secret과 nonce로 막습니다.

| `oauthError` | 뜻 |
|---|---|
| `cancelled` | 공급자 화면에서 사용자가 취소(`error=access_denied`) |
| `expired` | 로그인 상태 쿠키가 없거나 10분이 지났거나 state·공급자가 다름 |
| `unavailable` | 모르거나 설정되지 않은 공급자 |
| `failed` | 공급자 오류, 코드 교환 거절, ID 토큰 검증 실패 |
| `unlink-pending` | 이전 카카오 탈퇴의 연결 해제가 확정되지 않아 재가입 차단. 지속 시 관리자 문의 |
| `email-required` | 인증된 이메일을 받지 못함(카카오 이메일 미동의·미인증, Google `email_verified=false`) |
| `account-exists` | 그 이메일로 가입한 계정이 있어 연결하지 않음 |
| `suspended` | 정지된 계정 |
| `rate-limited` | 로그인·회원가입과 같은 접속 주소 한도(분당 20회) 초과 |

프런트의 `/login`·`/signup`은 이 목록을 기다리지 않고 카카오·Google 버튼(두 공급자 디자인 가이드, "…계정으로 로그인/시작하기")을
화면이 뜨자마자 그리며, 버튼은 `/api/v1/auth/oauth/{provider}/authorize` 링크입니다. 키가 없는 공급자를 누르면 서버가
`oauthError=unavailable`로 돌려보내 로그인 화면이 "키가 설정되지 않아 사용할 수 없습니다"를 안내합니다. 목록 endpoint는 설정
확인용입니다. Google 인가 요청에는 `prompt`를 두지 않아, 이미 로그인·동의한 계정은 선택 화면 없이 돌아옵니다. 서버가 보내는 `/oauth/complete`는 세션 힌트를 남기고 `/auth/me`로 계정을 확인한 뒤 `next`로 이동합니다.

## 관심 공고함

로그인한 회원이 다시 볼 공고를 담아 둡니다. 세션이 없으면 401이고, 담기·빼기는 세션 쿠키가 붙은 상태 변경이라 Origin 검사도
거칩니다. 공고 내용은 저장하지 않고 조회 때 `support_program`을 함께 읽으므로 접수 상태는 현재 공고와 같고, 동기화로 더 이상
노출되지 않는 공고는 목록·상태에서 빠집니다(행은 남아 다시 노출되면 돌아옵니다).

| 메서드·경로 | 용도 | 성공 |
|---|---|---|
| `GET /api/v1/me/saved-programs` | 목록. 최근에 담은 순서 | 200 `programs[]`(`savedAt`, `program`(공고 상세 응답과 같음)) |
| `GET /api/v1/me/saved-programs/status?sourceCode=&sourceProgramId=` | 담겨 있는지 | 200 `{ "saved": true }` |
| `POST /api/v1/me/saved-programs` `{ "sourceCode": "BIZINFO", "sourceProgramId": "PBLN_…" }` | 담기. 이미 담긴 공고는 그대로 | 200 담은 항목. 없거나 숨겨진 공고 404 `SUPPORT_PROGRAM_NOT_FOUND`, 형식 오류 400 |
| `DELETE /api/v1/me/saved-programs?sourceCode=&sourceProgramId=` | 빼기. 담기지 않은 공고도 성공 | 204 |

원본 ID에는 `/`가 올 수 있어 경로가 아니라 본문·쿼리로 받습니다. 프런트의 `/app/saved-programs`가 목록을 보여 주고 공고 상세의
책갈피 아이콘 버튼이 담기·빼기를 오가며 결과 안내는 4초 뒤 사라집니다. 비로그인 공개 상세는 요청 없이 로그인 뒤 같은 공고로 돌아오는 링크만 둡니다(원문 질문·신청 문서 작성도 같은 방식).

## 관리자 계정 관리

`/api/v1/admin/accounts` 아래는 관리자 전용입니다. Controller가 `AdminPrincipal` 파라미터를 받으므로 세션이 없으면 401,
관리자가 아니면 403 `ADMIN_ACCESS_DENIED`입니다. 역할은 요청마다 DB에서 다시 읽어 권한을 내리면 같은 세션도 다음 요청부터
막힙니다. 조치(POST)는 세션 쿠키가 붙은 상태 변경이라 Origin 검사도 거칩니다. 삭제된 계정은 목록·상세에 나오지 않습니다.

| 메서드·경로 | 용도 | 성공 |
|---|---|---|
| `GET /summary` | 요약 수치 | 200 `total` `companyRegistered` `socialLinked` `suspended` `admins` `joinedRecently` `recentJoinDays`(7) |
| `GET /` | 목록. `keyword`(이메일·기업명, 숫자 3~10자리면 사업자등록번호 일부도, 100자) `status`(ACTIVE·SUSPENDED) `role`(USER·ADMIN) `loginMethod`(EMAIL·KAKAO·GOOGLE) `sort`(RECENT·OLDEST·LAST_LOGIN) `page` `pageSize`(1~50, 기본 20) | 200 `accounts[]` `total` `page` `pageSize` `totalPages` |
| `GET /{id}` | 상세 | 200 `account` `company` `activity` `actions[]`(최근 20건) `isSelf` |
| `POST /{id}/suspend` | 정지. 모든 세션을 지워 바로 로그아웃 | 200 상세 |
| `POST /{id}/unsuspend` | 정지 해제. 지운 세션은 돌아오지 않음 | 200 상세 |
| `POST /{id}/sessions/revoke` | 강제 로그아웃. 계정은 그대로 | 200 상세 |

조치 본문은 `{ "reason": "스팸 제안 반복" }`이고 사유는 앞뒤 공백을 뺀 1~500자입니다. 조치는 대상 계정 행을 잠근 한
transaction에서 상태를 바꾸고 `account_admin_action`(대상·관리자·종류·사유·시각)에 남깁니다. 자기 계정은 422
`ADMIN_SELF_ACTION`, 다른 관리자 계정은 422 `ADMIN_TARGET_PROTECTED`, 이미 그 상태면 409 `ADMIN_ACCOUNT_STATE_CONFLICT`입니다.
그래서 정지로 관리자가 모두 사라지지 않고, 활성 관리자가 한 명뿐이면 그 관리자의 탈퇴(`DELETE /api/v1/me`)도 422
`LAST_ADMIN_DELETION`입니다.

목록 한 줄은 `id` `email` `role` `tier` `status` `emailVerified` `hasPassword` `loginMethods[]`(비밀번호가 있으면 EMAIL, 연결된
소셜 공급자) `company`(`companyName` `businessNumber` 또는 null) `createdAt` `lastLoginAt` `suspendedAt`입니다. 시각은 서울 기준
ISO 로컬 시각(`2026-09-11T17:49:09.591286`, 초 아래 자리는 있을 때만)이며, `lastLoginAt`은 가입·로그인·소셜 로그인·개발 로그인으로 세션을 받을 때 V19의 `account.last_login_at`에
남깁니다(그 전의 로그인은 기록이 없어 null). 비밀번호 해시와 세션 토큰은 응답에 싣지 않습니다.

## 오류

모든 오류는 `application/problem+json`이며 `code` 속성으로 구분합니다. 비밀번호와 토큰 원문은 응답·로그에
포함하지 않습니다.

| 상황 | HTTP | `code` |
|---|---:|---|
| 이메일 형식·비밀번호 누락 등 요청 검증 실패 | 400 | `REQUEST_VALIDATION_FAILED` (`errors[].field`) |
| 이메일 없음 또는 비밀번호 불일치 | 401 | `INVALID_CREDENTIALS` |
| 이미 가입된 이메일로 회원가입 | 409 | `EMAIL_ALREADY_REGISTERED` |
| 계정 삭제의 현재 비밀번호 불일치 | 422 | `CURRENT_PASSWORD_MISMATCH` |
| 비밀번호 재설정 토큰이 없거나 만료·사용됨 | 422 | `PASSWORD_RESET_TOKEN_INVALID` |
| 회원가입 인증번호 불일치 | 422 | `EMAIL_CODE_INVALID` |
| 회원가입 인증번호 없음·만료·시도 초과 | 422 | `EMAIL_CODE_EXPIRED` |
| 회원가입 인증번호 재전송 대기·발송 한도 | 429 | `EMAIL_CODE_RATE_LIMITED` (`retryAfterSeconds`, `Retry-After`) |
| 가입 통행 토큰이 없거나 그 이메일로 인증한 것이 아님 | 422 | `EMAIL_VERIFICATION_REQUIRED` |
| 회원가입 인증번호 메일을 보낼 수 없음 | 503 | `EMAIL_VERIFICATION_MAIL_UNAVAILABLE` |
| SMTP가 없어 재설정 메일을 보낼 수 없음(개발용 로그인도 꺼짐) | 503 | `PASSWORD_RESET_MAIL_UNAVAILABLE` |
| 기업을 등록하지 않은 계정의 기업 조회·수정 | 404 | `COMPANY_NOT_REGISTERED` |
| 등록되지 않은 사업자등록번호 | 404 | `BUSINESS_NOT_FOUND` |
| 휴업·폐업 사업자 등록 시도 | 422 | `BUSINESS_NOT_ACTIVE` (`businessStatus`) |
| 이미 기업을 등록한 계정의 재등록 | 409 | `COMPANY_ALREADY_REGISTERED` |
| 다른 계정이 등록한 사업자등록번호 | 409 | `BUSINESS_NUMBER_ALREADY_REGISTERED` |
| 기업을 등록하지 않은 회원의 모집글 작성·제안 보내기 | 403 | `COMPANY_REQUIRED` |
| 모집글에 묶을 공고가 없거나 제공처에서 사라짐 | 404 | `RECRUITMENT_PROGRAM_NOT_FOUND` |
| 접수가 끝난 공고에 모집글 작성 | 422 | `RECRUITMENT_PROGRAM_CLOSED` |
| 모집 마감일이 오늘 이전이거나 공고 접수 마감 전날을 넘김 | 422 | `RECRUITMENT_DEADLINE_NOT_ALLOWED` (`latestAllowedDeadline`) |
| 같은 공고에 이미 쓴 모집글이 있음 | 409 | `RECRUITMENT_ALREADY_EXISTS` |
| 모집글 없음 | 404 | `RECRUITMENT_NOT_FOUND` |
| 제안이 없거나 당사자가 아님 | 404 | `PROPOSAL_NOT_FOUND` |
| 자기 모집글에 제안 | 422 | `PROPOSAL_OWN_RECRUITMENT` |
| 마감된 모집글에 제안 | 422 | `RECRUITMENT_CLOSED` |
| 같은 모집글에 이미 보낸 제안이 있음 | 409 | `PROPOSAL_ALREADY_SENT` |
| 대기 중이 아닌 제안의 수락·거절·철회 | 409 | `PROPOSAL_NOT_PENDING` |
| 작성자가 아닌 수락·거절, 제안자가 아닌 철회 | 403 | `PROPOSAL_ACTION_FORBIDDEN` |
| Bizno 조회 키 미설정 / 연결 실패 / 시간 초과 / 응답 오류 | 503 / 503 / 504 / 502 | `BIZNO_NOT_CONFIGURED` `BIZNO_UNAVAILABLE` `BIZNO_TIMEOUT` `BIZNO_UPSTREAM_ERROR`·`BIZNO_INVALID_RESPONSE` |
| 세션 쿠키 없음·서명 오류·절대/유휴 만료·로그아웃된 세션·삭제된 계정 | 401 | `AUTHENTICATION_REQUIRED` (`WWW-Authenticate: Bearer`) |
| 정지된 계정의 로그인 또는 세션 사용 | 403 | `ACCOUNT_SUSPENDED` |
| 활성 관리자가 한 명뿐인데 그 관리자가 탈퇴 | 422 | `LAST_ADMIN_DELETION` |
| 관리자가 아닌 계정의 관리자 API 호출 | 403 | `ADMIN_ACCESS_DENIED` |
| 관리자 API의 대상 계정이 없거나 삭제됨 | 404 | `ADMIN_ACCOUNT_NOT_FOUND` |
| 관리자가 자기 계정을 정지·강제 로그아웃 | 422 | `ADMIN_SELF_ACTION` |
| 다른 관리자 계정을 정지·강제 로그아웃 | 422 | `ADMIN_TARGET_PROTECTED` |
| 이미 정지된 계정 정지, 정지되지 않은 계정 정지 해제 | 409 | `ADMIN_ACCOUNT_STATE_CONFLICT` |
| 세션 쿠키가 붙은 상태 변경 요청의 Origin이 없거나 허용 목록에 없음 | 403 | `SESSION_ORIGIN_REJECTED` |
| 로그인·회원가입 시도 한도 초과 | 429 | `LOGIN_RATE_LIMITED` (`Retry-After`, `retryAfterSeconds`) |

```json
{
  "type": "urn:govbiz:problem:invalid-credentials",
  "title": "Invalid Credentials",
  "status": 401,
  "detail": "The email or password is incorrect.",
  "instance": "/api/v1/auth/login",
  "code": "INVALID_CREDENTIALS"
}
```

계정 없음과 비밀번호 불일치는 같은 응답이며, 계정이 없을 때도 해시 비교를 한 번 수행해 응답 시간으로
가입 여부가 드러나지 않게 합니다. 정지 여부는 비밀번호가 맞은 뒤에만 알립니다.

## 설정

| 환경변수 | 기본값 | 용도 |
|---|---|---|
| `ACCOUNT_SESSION_TTL` | `P30D` | "로그인 상태 유지" 세션의 절대 만료(ISO-8601). 쿠키 Max-Age와 같음 |
| `ACCOUNT_SESSION_SHORT_TTL` | `PT12H` | "로그인 상태 유지"를 끈 세션의 절대 만료. 쿠키는 브라우저 세션 쿠키 |
| `ACCOUNT_SESSION_IDLE_TTL` | `P7D` | 마지막 사용 뒤 세션을 끝내는 유휴 기간 |
| `ACCOUNT_JWT_SECRET` | 없음(필수. Compose·`.env.example`은 로컬 개발용 값) | HS256 서명 비밀키(32자 이상). 비어 있으면 기동 실패 |
| `ACCOUNT_COOKIE_SECURE` | `true` (Compose는 `false`) | 세션 쿠키의 `Secure` 속성. HTTPS 운영에서는 `true` |
| `ACCOUNT_DEV_LOGIN_ENABLED` | `false` (Compose는 `true`) | 개발용 시드 로그인 endpoint 등록 여부 |
| `ACCOUNT_DEV_LOGIN_EMAIL` | `admin@govbiz.local` | 관리자 시드 계정 이메일 |
| `ACCOUNT_DEV_LOGIN_MEMBER_EMAIL` | `member@govbiz.local` | 회원 시드 계정 이메일 |
| `ACCOUNT_DEV_LOGIN_PASSWORD` | `govbiz-admin1` | 시드 계정을 만들 때 저장하는 비밀번호(8~72자) |
| `ACCOUNT_PASSWORD_RESET_MAIL_ENABLED` | `false` | 재설정 메일 SMTP 전송 여부. `SMTP_*`(리포트와 공용)를 함께 설정 |
| `ACCOUNT_PASSWORD_RESET_FROM` | 빈 값 | 재설정 메일 발신 주소. 메일을 켜면 필수 |
| `ACCOUNT_PASSWORD_RESET_FRONTEND_BASE_URL` | `http://127.0.0.1:5173` | 메일 링크의 프런트 origin. 운영은 HTTPS |
| `ACCOUNT_PASSWORD_RESET_TOKEN_TTL` | `PT30M` | 재설정 토큰 유효 시간(최대 24시간) |
| `ACCOUNT_PASSWORD_RESET_MAX_REQUESTS_PER_HOUR` | `3` | 계정당 시간당 재설정 요청 한도. 넘기면 조용히 건너뜀 |
| `ACCOUNT_OAUTH_CALLBACK_BASE_URL` | `http://127.0.0.1:5173` | 브라우저가 `/api`에 닿는 origin. 공급자 콘솔 Redirect URI는 이 값 + `/api/v1/auth/oauth/{provider}/callback`. 운영은 HTTPS |
| `ACCOUNT_OAUTH_FRONTEND_BASE_URL` | `http://127.0.0.1:5173` | 소셜 로그인을 마친 뒤 돌아갈 프런트 origin |
| `ACCOUNT_OAUTH_GOOGLE_CLIENT_ID` / `ACCOUNT_OAUTH_GOOGLE_CLIENT_SECRET` | 빈 값 | Google Cloud Console 웹 애플리케이션 클라이언트. 둘 다 있어야 Google 버튼이 켜짐 |
| `ACCOUNT_OAUTH_KAKAO_CLIENT_ID` / `ACCOUNT_OAUTH_KAKAO_CLIENT_SECRET` | 빈 값 | 카카오 REST API 키와 Client Secret. 둘 다 있어야 카카오 버튼이 켜짐(OpenID Connect·이메일 동의항목 설정 필요) |
| `ACCOUNT_OAUTH_KAKAO_ADMIN_KEY` | 빈 값 | 탈퇴 연결 해제용 어드민 키. 없으면 FAILED 기록·재가입 차단 유지 |
| `ACCOUNT_OAUTH_UNLINK_ENABLED` / `ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED` | true / false (Compose true / true) | 연결 해제 worker / RabbitMQ 모드. 큐 off는 직접 실행이며 실행 중지가 아님 |
| `ACCOUNT_OAUTH_CONNECT_TIMEOUT` / `ACCOUNT_OAUTH_READ_TIMEOUT` | `2s` / `10s` | 공급자 호출 연결·응답 제한시간 |
| `BIZNO_API_KEY` | 빈 값 | 사업자등록번호 조회용 Bizno(bizno.net) API 키. 비어 있으면 기업 조회·등록이 503 |
| `BIZNO_URL` | `https://bizno.net/api/fapi` | Bizno 조회 endpoint. 경로는 `/api/fapi` 고정 |
