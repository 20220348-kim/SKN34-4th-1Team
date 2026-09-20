# 애플리케이션 모노레포·배포 설정 저장소 전환

> 이 문서는 2026-09-19의 **이전 저장소 분리·이동 기록**입니다. 실행 당시 이름과 절차를 보존합니다.
> 현재는 앱과 배포 설정을 같은 교육기관 저장소로 통합했습니다. 새 체크아웃은 아래의 두 저장소 이동 절차가
> 아니라 [통합 저장소 안내](../../../docs/repository-integration.md)와 [GitOps README](../README.md)를 따릅니다.

작성일: 2026-09-19

현재 저장소명은 `GovBiz`, 기본 브랜치는 양쪽 모두 `develop`이다. 아래 전환 절차의 도착 경로는
현재 폴더명을 사용하며, `services/GovBiz-web` 같은 이전 체크아웃 경로는 실제 이전 대상이므로 보존한다.
로컬 체크아웃 폴더가 아직 `GovBiz-web`이어도 저장소 연결이 올바르면 사용할 수 있다.

## 결정과 적용 범위

- 현재 웹·모바일·공통 패키지와 `core-service`·`catalog-service`·`ai-service`·`ops-service` 소스는 **GovBiz**에서 함께 개발한다.
- 기존 `ops-service` 코드는 `backend/ops-service/`로 가져온다. Django 실행 프로세스·전용 DB는 별도로 유지한다.
- 로컬 통합 Compose와 검증 스크립트도 GovBiz로 이동한다.
- GovBiz-infra에서는 애플리케이션 submodule을 제거하고 향후 환경별 배포 설정·Argo CD 정의를 관리한다.
- 이 문서의 최초 저장소 이전 작업에는 Kubernetes 리소스·Argo CD·새 운영 환경을 포함하지 않았다. 이후 추가한 로컬 Kubernetes 설정·검증은 [별도 실행 안내](kubernetes-local.md)를 따른다.
- 현재 EC2 Compose·CodeBuild·SSM과 Vercel 배포 연결은 변경하지 않는다.

기존 GovBiz-ops 원격 저장소는 삭제하거나 archive하지 않는다. `ops-service`는 다음 기준 커밋의 **코드 스냅샷**을
가져오며 원격 저장소의 Git 이력 전체를 GovBiz에 병합하지 않는다.

| 출처 | 기준 커밋 |
| --- | --- |
| GovBiz | [34897562fcf16e30f7c811ad29eaa4b305f4f3ef](https://github.com/GovBiz-Team/GovBiz/tree/34897562fcf16e30f7c811ad29eaa4b305f4f3ef) |
| GovBiz-ops | [611232de21f69689c4024f3935b8d693b03b7777](https://github.com/GovBiz-Team/GovBiz-ops/tree/611232de21f69689c4024f3935b8d693b03b7777) |

로컬 작업 후 커밋·푸시·PR 병합은 별도 작업이다. 로컬 경로 전환만으로 팀원의 체크아웃과 배포 source가 바뀌지 않는다.

## 개발 위치

```text
skn34_project/
├─ GovBiz/                      새 개발 기준 체크아웃
│  ├─ frontend/
│  │  ├─ web/
│  │  ├─ mobile/
│  │  └─ packages/shared/
│  ├─ backend/{core-service,catalog-service,ai-service,ops-service}/
│  ├─ compose.yaml
│  ├─ compose.ops.yaml
│  ├─ compose.existing-data.yaml
│  ├─ .env.compose.example       통합 실행 설정 예시
│  └─ infrastructure/scripts/check-compose.py
└─ GovBiz-infra/                 배포 설정·전환 문서
   └─ services/                 기존 로컬 체크아웃 보존용; 추적·개발 기준 아님
```

기존 `GovBiz-infra/services/` 디렉터리는 미커밋 변경·실제 환경 파일을 잃지 않도록 로컬에 보존하고 Git 추적에서 제외한다.
더 이상 `git submodule update`로 갱신하거나 그 안에서 새 기능 개발을 시작하지 않는다.
기존 소스와 환경 파일을 확인하기 전 이 디렉터리를 삭제하지 않는다.
`GovBiz-infra`의 로컬 실제 `.env`도 자동 삭제·이동·복사하지 않는다.

## 1. 변경사항과 환경 파일 확인

기존 체크아웃 각각에서 `git status --short`를 확인한다. 기준 커밋 이후의 미커밋 업무 변경은 자동으로 가져오지 않으므로
새 GovBiz에 필요한 변경만 검토·반영한다. 미커밋 변경을 버리거나 실제 `.env`를 예시 값으로 덮어쓰지 않는다.

| 이전 파일 | 새 위치 | 처리 |
| --- | --- | --- |
| infra의 통합 설정 `.env` | GovBiz의 `.env.compose` | `.env.compose.example`을 기준으로 사용자 지정 프로젝트명·볼륨 값을 검토해서 반영 |
| `services/GovBiz-web/.env` | GovBiz의 `.env` | 기존 실제 값 보존; 자동 복사하지 않음 |
| `services/GovBiz-ops/.env` | GovBiz의 `backend/ops-service/.env` | 기존 실제 값 보존; 자동 복사하지 않음 |

새 통합 설정의 서비스 환경 경로는 다음과 같다. 이 파일에는 서비스의 실제 비밀번호·API 키를 공통으로 넣지 않는다.

```dotenv
COMPOSE_PROJECT_NAME=govbiz-infra
GOVBIZ_APP_ENV_FILE=./.env
GOVBIZ_DJANGO_ENV_FILE=./backend/ops-service/.env
```

기존 프로젝트명이 다르면 기존 값을 유지한다. Compose 상위 환경변수는 포함된 서비스 설정을 덮어쓸 수 있으므로
`MYSQL_ROOT_PASSWORD`, `DB_PASSWORD` 같은 서비스 비밀값을 `.env.compose`나 공통 셸 환경에 중복 정의하지 않는다.
새 PC에서는 해당 저장소의 예시 환경 파일을 사용하되, 외부 API 키와 자동 수집·시드 실행 여부를 먼저 확인한다.

## 2. 데이터 볼륨 선택 — 두 경우를 구분

이번 코드 이동은 볼륨 생성·삭제·복사를 실행하지 않는다. 먼저 `docker compose ls`, `docker volume ls`와
기존 컨테이너의 mount 정보를 확인해 실제 사용하던 프로젝트와 볼륨을 식별한다.

### 이미 GovBiz-infra 통합 Compose로 실행한 경우

새 통합 Compose의 기본 프로젝트명은 기존 `govbiz-infra`를 유지한다.
기존에 사용자 지정 이름을 사용했다면 `.env.compose`에 같은 프로젝트명을 지정한다.
서비스·컨테이너는 `core-service`·`ops-service`·`ops-mysql`로 통일했고 Ops 논리 볼륨은 `ops-mysql-data`로 변경했다.
기존 Ops 데이터를 쓸 때는 `compose.existing-data.yaml`을 추가하고 `GOVBIZ_EXISTING_DJANGO_MYSQL_VOLUME=govbiz-infra_django-mysql-data`로 실제 볼륨을 지정한다.
다른 `GOVBIZ_EXISTING_*_VOLUME`도 각각 실제 기존 이름으로 맞춘다. 기본 override 값은 과거 독립 실행용이므로 그대로 사용하지 않는다.

이미 외부 볼륨 override로 실행했다면 기존 `GOVBIZ_EXISTING_*` 값을 그대로 유지한다.
프로젝트명만 같다고 외부 볼륨 매핑을 버리면 안 된다.

### 이전에 govbiz와 govbiz4-django를 각각 실행한 경우

새 Ops 단독 프로젝트명은 `govbiz-ops`다. 이전 볼륨을 지우거나 자동 이전하지 않는다.

GovBiz의 `compose.existing-data.yaml`을 선택하면 기존 독립 프로젝트 볼륨을 재사용한다.
실제 볼륨명이 기본값과 다르면 `.env.compose`의 `GOVBIZ_EXISTING_*` 값을 먼저 맞춘다.

```dotenv
COMPOSE_PATH_SEPARATOR=|
COMPOSE_FILE=compose.yaml|compose.existing-data.yaml
```

기본 볼륨 이름은 `govbiz_mysql-data`, `govbiz_elasticsearch-data`, `govbiz_qdrant-data`,
`govbiz_redis-data`, `govbiz_rabbitmq-data`, `govbiz4-django_mysql-data`다.
override는 `external: true`이므로 지정된 기존 볼륨이 없으면 실패한다. 빈 볼륨을 만들어 이전 데이터로 간주하지 않는다.

## 3. 기존 컨테이너를 멈춘 뒤 새 개발 위치로 전환

**이 절차는 사용자가 실제 전환할 때 실행한다. 문서·코드 변경만으로 컨테이너를 시작하거나 중지하지 않는다.**

1. 기존 실행의 프로젝트명·Compose 파일·환경 파일과 볼륨 매핑을 확인하고 DB 데이터를 별도로 백업한다.
2. 기존 구성 파일이 아직 있을 때 같은 설정으로 기존 컨테이너를 정리한다. 파일이 이미 이동했다면 기존 보존 체크아웃/이전 revision의 구성으로 대상을 확인한다. 다른 프로젝트를 추측해서 종료하지 않는다.
3. `docker compose down`에 **`-v` 또는 `--volumes`를 붙이지 않는다.** 기존 볼륨을 삭제하는 옵션이다.
4. 같은 데이터 볼륨을 사용하는 이전 DB 컨테이너가 남아 있지 않은지 확인한다. 포트만 바꾸어 두 DB를 동시에 실행하지 않는다.
5. 새 GovBiz에서 아래와 같이 검증한 뒤 실행한다.

```bash
# GovBiz 디렉터리에서 실행
docker compose --env-file .env.compose config --quiet
docker compose --env-file .env.compose up -d --build
docker compose --env-file .env.compose ps
```

새 개발 소스 bind mount는 GovBiz 체크아웃을 가리킨다. 이전 `GovBiz-infra/services/`의 파일을 수정해도
새 컨테이너에 반영되지 않는다. 환경 파일·소스·기존 데이터 확인이 끝나기 전 이전 체크아웃을 삭제하지 않는다.

## 검증과 이후 PR

- 서비스 코드·Dockerfile·로컬 Compose 변경: GovBiz PR과 해당 테스트.
- 미래 환경별 digest·Kubernetes·Argo CD 설정 변경: GovBiz-infra PR과 배포 설정 검증.
- 실제 비밀값, 데이터 볼륨, 운영 클러스터 자격 증명은 어느 PR에도 포함하지 않는다.
- 이미지 빌드 성공이나 infra 문서 검증 통과를 실제 GitOps 동기화 완료로 표시하지 않는다.

관련 문서: [저장소 개요](../README.md), [전환 설계](msa-kubernetes-argocd-plan.md)
