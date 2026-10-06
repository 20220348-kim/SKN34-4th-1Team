# 로컬 시작 가이드

GovBiz의 통합 Compose 실행과 웹·모바일 개발 환경을 준비하는 방법입니다.
서비스 역할과 연결 구조는 [메인 README의 시스템 아키텍처](../README.md#서비스-구성)를 참고하세요.
아래 파일 경로와 명령의 기준은 저장소 루트입니다.

## 통합 Compose

루트 `compose.yaml`이 Core·Catalog·AI·Ops와 웹·저장소를 연결합니다.
`infrastructure/compose.yaml`만 단독 실행하는 방식은 기존 embedded 수집 호환 경로입니다.
처음 구성할 때는 [통합 개발 안내](ops-monorepo-migration.md#로컬-개발-시작)를 따릅니다.

| 환경 파일 | 용도 |
|---|---|
| `.env` | 웹·Core·Catalog·AI 설정. `OPENAI_API_KEY`, 서버 간 공유할 32자 이상 `CATALOG_INTERNAL_TOKEN`과 필요한 제공처·문서·메일 설정 |
| `backend/ops-service/.env` | Ops DB·Django 전용 설정 |
| `.env.compose` | 위 두 환경 파일의 위치와 Compose 프로젝트명 |

각 예시 파일(`.env.example`, `backend/ops-service/.env.example`, `.env.compose.example`)을
**해당 파일이 없을 때만** 복사하고 로컬 값을 입력합니다. 설정을 준비한 뒤 저장소 루트에서 실행합니다.

```bash
python3 infrastructure/scripts/check-compose.py
docker compose --env-file .env.compose config --quiet
docker compose --env-file .env.compose up -d --build
```

기본 웹 주소는 [localhost:5173](http://localhost:5173), Core API는 `http://localhost:8080`입니다.
공고 자동 수집·색인·AI 기능은 활성화한 설정에 따라 외부 API를 호출합니다.
기존 데이터가 있으면 먼저 [Catalog 전환](catalog-service-extraction.md)과
[기존 볼륨 연결](ops-monorepo-migration.md#기존-컨테이너데이터-이전)을 확인합니다.

## 웹·모바일 개발

Node **24.x**·pnpm **11.22.x**를 사용하며 의존성은 루트에서 한 번 설치합니다.
백엔드를 실행한 뒤 필요한 앱을 선택합니다. Compose의 웹을 실행 중이라면 호스트 웹과 포트가 겹치지 않게 구성합니다.

```bash
pnpm install --frozen-lockfile
pnpm dev:web
# 모바일을 개발할 때 별도 터미널에서 실행
pnpm dev:mobile
```

모바일은 `frontend/mobile/.env.example`에 따라 `EXPO_PUBLIC_API_BASE_URL`을 설정합니다.
iOS 시뮬레이터의 `localhost:8080`, Android 에뮬레이터의 `10.0.2.2:8080`, 실기기의 PC LAN 주소를 구분합니다.
푸시·소셜 로그인은 플랫폼 인증과 네이티브 빌드가 추가로 필요합니다.
[모바일 실행 안내](../frontend/mobile/README.md) · [공통 코드 관리](mobile-monorepo.md)

Core·Catalog를 직접 개발할 때는 JDK 21, AI·Ops는 Python 3.12를 사용합니다.
Kubernetes 도구의 Python 3.13 환경은 애플리케이션 Python 환경과 별도입니다.
