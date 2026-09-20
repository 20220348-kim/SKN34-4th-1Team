# GovBiz Ops Service

LLMOps·관리자 시스템 개발을 위한 Django 서비스이며, `GovBiz` 모노레포의
`backend/ops-service`에서 관리합니다. 같은 저장소의 Core API·AI Service와 코드를 함께
관리하지만, Django 프로세스와 Ops 데이터베이스는 독립적으로 실행합니다.

소스 디렉터리·Compose 서비스·Kubernetes Deployment/Service/컨테이너 이름은 `ops-service`로 통일했습니다.
DB 컨테이너·내부 DNS는 `ops-mysql`, Python 패키지·health 응답은 `govbiz-ops-service`,
Kubernetes 검증 이미지 접두사는 `govbiz-ops-service`입니다.
이전 `.env.compose`에 `GOVBIZ_DJANGO_ENV_FILE=./backend/ops/.env`를 지정했다면
값을 `./backend/ops-service/.env`로 갱신하세요. 실제 비밀값과 데이터 볼륨은 바꾸지 않습니다.

[GovBiz-Team/GovBiz-ops](https://github.com/GovBiz-Team/GovBiz-ops)의 커밋
[`611232de21f69689c4024f3935b8d693b03b7777`](https://github.com/GovBiz-Team/GovBiz-ops/commit/611232de21f69689c4024f3935b8d693b03b7777)
추적 파일을 가져온 스냅샷입니다. 원본 Git 이력은 원래 저장소에 보존되며,
이 디렉터리는 서브모듈이 아닙니다. 실제 `.env`, 로컬 가상환경·Git 메타데이터는
가져오지 않았습니다.

현재 범위는 Django 기본 골격, 로컬 개발 환경과 Kubernetes에서 실행할 수 있는
Gunicorn 이미지입니다. 공고·회원·신청 관리 업무와 기존 Spring Boot/FastAPI의
운영 데이터는 이전하지 않았습니다. 이미지 준비가 AWS 운영 배포 완료를 뜻하지는 않습니다.

## 기술 구성

- Python 3.13
- Django 5.2 LTS, Django REST Framework
- Gunicorn 26.2 WSGI 실행 서버(배포 이미지 기본값)
- MySQL 8.4, `utf8mb4`
- uv 0.12.5와 `uv.lock`을 통한 의존성 고정
- Ruff, Django 테스트 러너
- Docker Compose, GitHub Actions CI

Django 기본 사용자 테이블과 관리자 화면은 아직 추가하지 않았습니다. 인증 방식과 기존 GovBiz 계정의 연동 범위를 정한 뒤 도입합니다. 업무 API의 기본 권한은 `IsAuthenticated`이며, 현재 상태 확인 API만 공개합니다.

## 빠른 시작 — Docker

아래 명령은 모노레포 루트에서 `cd backend/ops-service`로 이동한 뒤 실행합니다.
전체 로컬 스택의 실행 방법은 [루트 README](../../README.md)를 참고합니다.
단독 Ops Compose와 통합 Compose를 동시에 실행하면 포트가 충돌할 수 있습니다.

Docker Desktop의 Linux 컨테이너 엔진이 실행되어 있어야 합니다.

PowerShell:

```powershell
Copy-Item .env.example .env
docker compose up --build --detach --wait --wait-timeout 180
```

Linux/macOS에서는 첫 명령을 `cp .env.example .env`로 실행합니다. 이미 `.env`를 설정했다면 복사 단계는 건너뜁니다.

- 실행 확인: [http://127.0.0.1:8001/api/v1/health](http://127.0.0.1:8001/api/v1/health)
- DB 연결 확인: [http://127.0.0.1:8001/api/v1/health/ready](http://127.0.0.1:8001/api/v1/health/ready)
- MySQL: `127.0.0.1:3308`, DB/사용자 `govbiz4`
- Compose 프로젝트: `govbiz-ops` (컨테이너 `govbiz-ops-ops-service-1`, `govbiz-ops-ops-mysql-1`)
- 데이터 볼륨: 이 프로젝트의 `mysql-data`

Core·AI의 컨테이너·네트워크·DB 볼륨과 분리됩니다. DB 스키마·사용자 `govbiz4`는 컨테이너 이름과 별개이며 이번에 변경하지 않습니다. 이전 데이터는 자동 이전되지 않으므로 [전환 안내](../../docs/ops-monorepo-migration.md)를 따르세요. `config/`, `apps/`, `manage.py`를 컨테이너에 연결하므로 Python 코드 변경은 개발 서버에 반영됩니다. 의존성을 변경하면 이미지를 다시 빌드합니다.

```powershell
docker compose logs --follow ops-service
docker compose down
```

`down`은 데이터 볼륨을 유지합니다. 로컬 Compose만 이미지의 기본 명령을
`manage.py runserver`로 재정의하여 소스 변경을 자동 반영합니다. Kubernetes 등에서
이미지를 직접 실행하면 자동 재시작 개발 서버가 아닌 Gunicorn이 실행됩니다.

## Python을 호스트에서 실행

이 절의 명령도 `backend/ops-service`에서 실행합니다.

[uv 공식 설치 안내](https://docs.astral.sh/uv/getting-started/installation/)에 따라 uv 0.12.5와 Python 3.13을 준비합니다. 기존 uv는 요구 버전에 맞춥니다.

```powershell
Copy-Item .env.example .env
uv sync --locked
docker compose up --detach ops-mysql --wait
uv run --locked python manage.py check
uv run --locked python manage.py migrate
uv run --locked python manage.py runserver 127.0.0.1:8001
```

호스트에서 실행할 때는 Compose의 `ops-service`를 동시에 실행하지 않습니다. 이미 켜져 있다면 `docker compose stop ops-service`를 먼저 실행합니다. Linux에서 mysqlclient 빌드 도구가 없다면 `default-libmysqlclient-dev`, `build-essential`, `pkg-config`를 설치하거나 Docker 실행 경로를 사용합니다.

## API

| 경로 | 성공 응답 | 실패 동작 |
| --- | --- | --- |
| `GET /api/v1/health` | `200`, `status: UP` | DB를 호출하지 않음 |
| `GET /api/v1/health/ready` | `200`, `database: UP` | MySQL 연결/질의 실패 시 `503`, 내부 연결 정보는 응답에 노출하지 않음 |

URL 끝에 슬래시를 붙이지 않습니다. 상태 확인 경로는 쓰기 요청을 받지 않습니다.

호출 흐름은 `HTTP → Django URL → DRF View → JSON`이며, readiness만 MySQL에서 `SELECT 1`을 실행합니다. 현재 외부 AI API 호출은 없습니다.

## 검증

로컬 MySQL을 실행한 뒤 다음 명령을 사용합니다.

```powershell
uv sync --locked
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked python manage.py check
uv run --locked python manage.py makemigrations --check --dry-run
uv run --locked python manage.py test --noinput
```

Docker 안에서도 테스트할 수 있습니다.

```powershell
docker compose exec -T ops-service python manage.py test --noinput
```

테스트 러너는 별도 `test_govbiz4` DB를 생성·삭제합니다. Compose의 최초 DB 초기화 SQL은 개발 사용자에게 그 DB의 권한만 추가로 부여합니다. 테스트는 실제 MySQL 연결, DB 장애 시 503 응답, liveness의 DB 비의존성, HTTP 메서드 제한, 허용 호스트를 확인합니다.

GitHub Actions는 모노레포 루트의
[`ops-ci.yml`](../../.github/workflows/ops-ci.yml)에서 Ruff·Django 검사·실제 MySQL 테스트를
수행합니다. Docker job은 `infrastructure/scripts/check-compose.py --smoke`로 통합 Compose의
경로·환경 분리를 검사하고, 격리된 Django·MySQL만 빌드·실행하여 상태 확인과 테스트를
수행합니다. Core API·AI Service나 외부 AI API는 기동·호출하지 않습니다.
`python3 -B backend/ops-service/scripts/check-image.py`는 모노레포 루트에서 기본 Gunicorn
이미지를 별도로 검증합니다. 네트워크·DB·실제 환경 파일을 연결하지 않고 non-root,
읽기 전용 파일시스템, 정상 liveness, DB 장애 readiness, Host 거절, SIGTERM 종료를
확인한 뒤 이번 실행의 임시 컨테이너와 이미지 태그만 정리합니다.
실제 GitHub CI 실행은 파일을 원격 저장소에 올린 뒤 확인할 수 있습니다.

## 디렉터리

```text
config/                  Django 설정·URL·WSGI·ASGI
apps/health/             실행/DB 연결 상태 API 및 테스트
infrastructure/mysql/    개발용 테스트 DB 초기화
manage.py                관리 명령 진입점
pyproject.toml           Python 의존성과 개발 도구 설정
uv.lock                  확정된 의존성
Dockerfile               Gunicorn 기본 실행 이미지
compose.yaml             Django·MySQL 로컬 환경
scripts/check-image.py   배포 이미지 기본 명령·격리·상태 확인 검증
.env.example             로컬 환경변수 예시
```

## 환경변수와 다른 서비스 연결

`.env`는 Git/Docker 빌드 컨텍스트에서 제외됩니다. `.env.example`의 비밀번호와 비밀 키는 로컬 개발용입니다. 실제 환경변수가 `.env`보다 우선합니다.

- `DJANGO_SECRET_KEY`, `DB_PASSWORD`: 필수
- `DJANGO_DEBUG`: 기본 `false`; 예시 파일은 로컬 개발용 `true`
- `DJANGO_ALLOWED_HOSTS`: 쉼표로 구분하는 허용 호스트
- `DB_HOST`, `DB_PORT`: 호스트 실행 기본값 `127.0.0.1:3308`
- `API_PORT`, `MYSQL_PORT`: Compose가 호스트에 공개하는 포트
- `MYSQL_ROOT_PASSWORD`: 개발용 MySQL 초기화 비밀번호

Compose의 DB 이름/사용자는 `govbiz4`로 고정하여 테스트 초기화 SQL과 일치시킵니다. 포트를 변경하면 호스트 실행의 `DB_PORT`도 맞춰야 합니다.

향후 Django가 담당할 업무를 확정한 뒤 같은 모노레포의 React·Spring Boot·FastAPI와 HTTP 또는 메시지 계약으로 연결합니다. 같은 테이블을 Spring의 Flyway와 Django migration이 동시에 관리하지 않도록 데이터 소유권을 먼저 정합니다.

## 운영 배포 경계

기존 Core API의 관리자 로그인과 회원 테이블, 운영 데이터는 이전하지 않았습니다.
Kubernetes 매니페스트와 배포 이미지 버전은 같은 저장소의 `infrastructure/gitops/`에서 관리합니다.
이 이미지에는 클러스터 생성·Argo CD 설치·운영 데이터 변경 기능이 없습니다.

Mac 유지형 포트폴리오 배포는 [GitOps 안내](../../infrastructure/gitops/docs/portfolio-gitops.md)를 따릅니다.
기존 두 저장소 환경에서는 CI가 비공개 GHCR에 이미지를 발행하고, infra가 검증한 digest를 선택하면
Argo CD가 이 서비스의 Deployment를 동기화했습니다. 교육기관 통합본에서는 해당 자동 발행·promotion을
잠갔으며 개인 포크 연결은 별도입니다. 이미지 발행만으로 관리자 인증·업무 기능이 추가되는 것은 아닙니다.

- 이미지 기본 명령은 `gunicorn config.wsgi:application`, 내부 포트는 `8000`입니다.
  worker 2개, worker 응답 정지 제한 30초, 종료 유예 25초이며 stdout/stderr로 로그를 냅니다.
- UID/GID는 `10001:10001`입니다. Kubernetes에서 `runAsNonRoot: true`,
  `readOnlyRootFilesystem: true`를 사용하고 `/tmp`에 쓰기 가능한 작은 `emptyDir`를
  마운트합니다. Gunicorn heartbeat 임시 파일이 필요하므로 `/tmp`까지 읽기 전용이면
  기동하지 못합니다. Pod 종료 유예는 Gunicorn의 25초보다 길게 설정합니다.
- `DJANGO_DEBUG=false`, 별도 무작위 `DJANGO_SECRET_KEY` 및 DB 비밀번호를 Secret으로
  주입합니다. DB 주소는 Ops 전용 DB이며 Core API의 DB 자격증명을 재사용하지 않습니다.
- `DJANGO_ALLOWED_HOSTS`에는 접근할 Service DNS/호스트만 지정합니다. HTTP probe는
  `/api/v1/health`와 `/api/v1/health/ready`를 사용하며 허용된 `Host` 헤더가 필요합니다.
  liveness/startup은 DB를 보지 않고 readiness만 DB를 확인합니다.
- `python manage.py migrate --noinput`은 별도 배포 작업으로 한 번 실행합니다.
  Pod마다 동시에 migration을 실행하는 시작 명령은 넣지 않습니다. 아직 업무 모델과
  자체 migration은 없으며 사용자·인증 테이블도 만들지 않았습니다.
- 공개 운영 전에는 TLS/신뢰 프록시, 인증·권한, DB TLS/백업을 별도 구성하고 실제 배포
  환경에서 `python manage.py check --deploy`를 점검해야 합니다. 이 작업은 개발용
  `runserver`를 대체했을 뿐, 해당 보안·업무 구성을 모두 완료한 것은 아닙니다.

설정 근거: [Django Gunicorn 배포](https://docs.djangoproject.com/en/5.2/howto/deployment/wsgi/gunicorn/),
[Gunicorn 설정](https://gunicorn.org/reference/settings/),
[Django 배포 체크리스트](https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/).
