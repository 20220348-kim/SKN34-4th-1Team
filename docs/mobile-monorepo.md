# GovBiz 웹·앱 공동 관리

기존 React 웹과 Expo React Native 앱이 같은 Core API·AI Service를 사용합니다. pnpm workspace와
루트 `pnpm-lock.yaml` 하나로 설치 버전을 관리하고, 각 앱의 React 런타임과 화면은 분리합니다.
공통 패키지에는 React 의존성이 없습니다. 웹 배포와 앱 네이티브 빌드·스토어 배포는 각각 진행합니다.

```text
frontend/                      사용자 클라이언트
  web/                         React·Vite 웹, 브라우저 UI·쿠키·Vercel middleware
  mobile/                      Expo React Native 앱, 네이티브 UI·내비게이션·세션 보관
  packages/shared/src/
    domain/                    entities, 업무 오류, Repository 계약, 유스케이스
    data/models/               Zod 응답 검증 및 DTO → domain 변환
    data/api/                  주소/fetch를 주입하는 공고 HTTP 클라이언트
    design/                    색·모서리 디자인 토큰(웹 Tailwind 변수와 모바일 colors의 원본)
backend/                       웹과 앱 공용 Core API·AI Service
```

`frontend/web/src/domain`과 `frontend/web/src/data/models`는 이전 import를 유지하기 위한 재수출입니다.
실제 구현을 추가·수정할 곳은 `frontend/packages/shared/src`입니다. 기존 웹의 domain·DTO 테스트는 이 재수출을
통해 공통 구현을 계속 검증합니다. UI·Redux·DI·브라우저 저장소 코드는 웹에 남겨 둡니다.
shared는 TypeScript 소스를 export하며 Vite와 Metro가 각 앱의 번들에 맞게 처리합니다.
이 패키지는 웹·모바일 전용이며 백엔드가 직접 사용하는 공통 라이브러리가 아닙니다.
패키지 이름 `@govbiz/shared`와 루트 workspace·lockfile은 유지합니다.
기업 조회·저장, 관심 공고 조회·저장·해제, 가입 이메일 인증은 모바일 `src/api`에서 HTTP 응답을 검증하고 내부 모델로 변환합니다. 해당 화면은 URL·Zod 스키마·DTO 변환을 소유하지 않습니다. 가입 이메일 인증 응답 스키마는 shared에서 웹·앱이 함께 사용합니다.

모바일 진입점은 `검색 · 관심함 · 리포트 · 전체` 4탭입니다. 전체 안의 Stack에서 계정·기업·수신 설정·
신청 준비 목록·협업으로 진입하며 내부 화면에서도 전체 탭을 유지합니다. 검색 안에서 기존 AI/필터 화면을
전환하며, 기존 `/chat`은 검색의 AI 모드로 연결합니다. 협업은 모집글·제안함의 조회와 제안 처리에
기존 Core 파트너 API를 사용합니다. 모집글 작성·수정은 앱 내부 폼에서 기존 shared 입력 규칙과
모바일 Bearer API를 사용하며, 수정에서는 연결 공고를 바꾸지 않습니다. 관심함·공고 상세의 준비 요약과 진행 단계 변경은 기존
신청 준비·중복 검토 API를 Bearer 인증으로 호출하며, 작성·결과·파일 저장/공유는 모바일 독립 화면으로 연결합니다. 리포트는
`모바일 화면 → 모바일 Bearer API → 기존 Core 리포트·기업·관심 공고 API`로 조회·설정합니다.
화면 진입만으로 유료 미리보기를 생성하지 않습니다. 원본 시안·공통 UI 및 현재 구현 범위는
[모바일 README](../frontend/mobile/README.md#화면-기준-skn-78--1단계)를 따릅니다.

## 설치와 실행

Node.js 24.x와 pnpm 11.22.x에서 **저장소 루트**로 이동해 실행합니다.

```bash
pnpm install --frozen-lockfile
pnpm dev:web
# 별도 터미널에서 실행
pnpm dev:mobile
```

웹의 API 설정은 `frontend/web/.env.example`, 앱 설정·에뮬레이터/실기기 연결은
[모바일 README](../frontend/mobile/README.md)를 따릅니다. 공개 API 주소에는 접근 가능한 Core API 또는
앱 접근을 지원하는 프록시 주소를 지정합니다. 앱에 OpenAI·DB·프록시 비밀값을 넣지 않습니다.
기존 웹 전용 Vercel 프록시가 앱에 동일하게 허용된다고 가정하지 않습니다.

공통 클라이언트는 환경변수를 읽거나 세션을 저장하지 않습니다.

```ts
import { createSupportProgramClient } from '@govbiz/shared/data/api/supportProgramClient'
import { toSupportProgram } from '@govbiz/shared/data/models/SupportProgramDto'

const client = createSupportProgramClient({ baseUrl: 'https://api.example.com' })
const dto = await client.getDetail({ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_123' })
const program = dto ? toSupportProgram(dto) : null
```

`baseUrl`은 문자열 또는 값을 반환하는 함수이며, `fetch`를 주입해 플랫폼 세션·시간 제한을
추가할 수 있습니다. 검색·검색 복원 요청의 쿠키 정책은 기본 `omit`이고 웹만 명시적으로 `include`를 사용합니다.
검색 응답의 복합 식별자·원문 도메인·페이지 계약 검증과 요청 취소는 웹·앱이 같은 구현을 사용합니다.
실패를 빈 결과나 다른 검색 방식으로 자동 대체하지 않습니다.

## 검증

```bash
pnpm --filter @govbiz/shared typecheck
pnpm --filter @govbiz/shared test
pnpm --filter @govbiz/shared lint
pnpm --filter govbiz-web test
pnpm --filter govbiz-web lint
pnpm --filter govbiz-web build
pnpm --filter @govbiz/mobile typecheck
pnpm --filter @govbiz/mobile test
pnpm --filter @govbiz/mobile lint
pnpm --filter @govbiz/mobile export
```

GitHub Actions에서도 루트 frozen install 뒤 같은 검증을 실행합니다. 모바일 export는 iOS·Android용
JavaScript·리소스 번들 확인이며, 실제 네이티브 빌드·기기 실행·스토어 제출 검증을 대신하지 않습니다.
API 계약이나 인증 서버를 바꾸면 기존 Core API 테스트와 소비하는 두 앱 검증을 함께 실행합니다.

## 기존 배포 경로

- Vercel: Root Directory를 `frontend/web`로 지정하고 **Include source files outside of the Root Directory in the Build Step**을 켭니다.
  `vercel.json`은 두 단계 위 저장소 루트에서 웹 dependency subset을 frozen install하고 웹만 빌드합니다.
  이전 Root Directory가 `frontend`인 프로젝트는 콘솔에서도 `frontend/web`로 변경해야 합니다. 실제 프로젝트 설정 변경과 배포는 별도 작업입니다.
  [Vercel 모노레포 설정 안내](https://vercel.com/docs/monorepos/monorepo-faq)를 참고하세요.
- Docker Compose: 웹 build context는 저장소 루트, Dockerfile은 `frontend/web/Dockerfile.dev`입니다.
  웹·공통 패키지만 설치·복사하며 프론트엔드 서버는 `/app/frontend/web`에서 실행합니다.
  빌드·실행 시 같은 pnpm store를 사용하고 시작 명령을 웹 패키지로 제한합니다.
  Docker에서만 `verify-deps-before-run=false`로 실행 전 자동 설치를 끄며, 의존성 변경 시 웹 subset을 frozen install합니다.
  공유 소스 변경도 개발 서버에 반영되고 각 `node_modules`는 호스트 경로와 섞이지 않습니다.
  루트 `compose.yaml`도 이 구성을 include해 Django Ops와 함께 실행합니다. `python3 -B infrastructure/scripts/check-compose.py`로
  통합 경로·환경·볼륨 구성을 컨테이너 시작 없이 확인할 수 있습니다.
  이전 `web-node-modules` 캐시 대신 새 `web-workspace-node-modules`를 쓰며, 기존 데이터 재사용 override에서도
  Node 캐시는 새로 만듭니다. 기존 DB·검색·메시지 볼륨의 이름과 데이터는 유지합니다.
- Expo: 앱 폴더에서 Metro를 실행하며 Expo의 기본 모노레포 해석을 사용합니다.
  웹 React와 앱 React Native의 버전을 강제로 같은 의존성으로 합치지 않습니다.
