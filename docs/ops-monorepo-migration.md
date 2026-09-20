# Ops 모노레포 통합

## 원본과 범위

- 원본 저장소: `https://github.com/GovBiz-Team/GovBiz-ops`
- 가져온 커밋: `611232de21f69689c4024f3935b8d693b03b7777`
- 새 코드 위치: `backend/ops-service/`
- 방식: 원본 커밋의 추적 파일을 가져오는 snapshot import. 과거 Ops 커밋 이력은 기존 저장소에 보존한다.

실제 `.env`, 가상환경, Git 관리 디렉터리, 데이터 볼륨은 복사하지 않는다.
기존 원격 저장소를 삭제하거나 archive하지 않는다. 이번 변경은 운영 배포가 아니다.

Ops는 같은 저장소에서 개발하지만 별도 Django 프로세스와 전용 MySQL을 유지한다.
Core의 계정·인증 테이블을 복제하거나 기존 Core·AI의 업무 계약을 변경하지 않는다.
후속 Kubernetes 준비에서 Ops Dockerfile의 기본 실행은 Gunicorn으로 변경했다.
개발 Compose는 runserver를 명시적으로 유지하며, 실제 운영 배포·관리자 인증을 완료한 것은 아니다.

## 저장소 책임

- 교육기관 통합 저장소: 프론트·Core·Catalog·AI·Ops 코드, 테스트, Dockerfile, 로컬 통합 Compose.
- 같은 저장소의 `infrastructure/gitops/`: 이전 `GovBiz-infra`의 Kubernetes·Helm·Argo CD 설정·검증.
- 단일 저장소로의 후속 이동과 브랜치·팀원 포크 범위는 [교육기관 통합 안내](repository-integration.md)를 따른다.
- 기존 `infrastructure/compose.prod.yaml`과 `infrastructure/codebuild/`는 향후 재배포용 템플릿으로 남긴다. 현재 운영 환경은 없다. Kubernetes 전환 시 한 대상에 두 배포 경로가 동시에 쓰지 않도록 별도 승인 후 이전한다.

코드 통합만으로 CodeConnections·CodeBuild·Vercel 연결, ECR 이미지, 운영 컨테이너는 바뀌지 않는다.
후속 작업에서 네 서비스의 독립 Helm 실행·DB 경계·장애·복구와 로컬 Argo CD Git 동기화를 검증했다.
[기존 검증 기록](../infrastructure/gitops/docs/msa-validation-20260920.md)을 참고한다.
상시 클러스터·이미지 발행 CI와 AWS Kubernetes 운영 전환은 별도 단계다.

## 로컬 개발 시작

저장소 루트에서 실행한다. 기존 `.env`가 있다면 덮어쓰지 않는다.
현재 루트 Compose는 Catalog 분리가 기본이다. 선택한 앱 환경 파일에 32자 이상의 무작위
`CATALOG_INTERNAL_TOKEN`을 준비해야 한다. Core·Catalog에 같은 값이 전달되며 프론트에는 전달하지 않는다.

```bash
# 세 파일이 없을 때만 각 예시를 복사하고 로컬 설정을 입력한다.
cp -n .env.example .env
cp -n backend/ops-service/.env.example backend/ops-service/.env
cp -n .env.compose.example .env.compose

# 먼저 실제 외부 API 키 없이 경로·환경 분리·볼륨 연결을 검증한다.
python3 infrastructure/scripts/check-compose.py

# 실제 개발 실행: 기존 동기화·AI 설정에 따라 외부 호출이 발생할 수 있다.
docker compose --env-file .env.compose config --quiet
docker compose --env-file .env.compose up -d --build
```

루트 `.env`는 기존 웹·Core·AI 설정, `backend/ops-service/.env`는 Ops 전용 설정이다.
`.env.compose`는 두 파일의 위치만 지정한다. `GOVBIZ_APP_ENV_FILE`은 React Native 설정이 아니다.
기존 `.env.compose`가 `./backend/ops/.env`를 가리키면 `GOVBIZ_DJANGO_ENV_FILE`의 경로만
`./backend/ops-service/.env`로 갱신한다. 파일 안의 비밀값과 기존 DB·볼륨은 그대로 보존한다.
Python 패키지·health 응답은 `govbiz-ops-service`, 통합·단독 Compose 서비스는 `ops-service`, `ops-mysql`이다. DB 스키마·사용자는 변경하지 않는다.
Ops만 단독 개발하려면 `backend/ops-service/README.md`를 따른다.

## 기존 컨테이너·데이터 이전

새 기본 실행은 이전 컨테이너 이름 별칭을 만들지 않는다. 단독 Ops 프로젝트는 `govbiz-ops`로 변경되었으며 새 기본 볼륨은 `govbiz-ops_mysql-data`다.

기존 개발 컨테이너를 자동으로 종료하거나 데이터를 옮기지 않는다. 전환 전에 본인이 사용하던 Compose
파일·환경 파일·프로젝트명과 `docker volume ls`로 실제 볼륨 이름을 확인한다.
같은 데이터 볼륨에 두 MySQL 프로세스를 동시에 연결하지 않는다.
기존 Core 데이터를 연결하려면 먼저 [Catalog 전환 조건](catalog-service-extraction.md)을 검토하고
`.env.compose`에 `GOVBIZ_CATALOG_TRANSITION_REVIEWED=1`을 명시해야 한다.
이 확인값은 백필이나 데이터 검증을 자동 수행했다는 뜻이 아니다. 기존 데이터에 새 Catalog를 즉시 연결하지 않는다.

- 기존 **GovBiz-infra 통합 실행** 사용자는 프로젝트명 `govbiz-infra`를 그대로 쓸 수 있지만, Ops 논리 볼륨이 `ops-mysql-data`로 변경되었다.
  Ops 데이터를 이어 쓰려면 `compose.existing-data.yaml`과 `GOVBIZ_EXISTING_DJANGO_MYSQL_VOLUME=govbiz-infra_django-mysql-data`를 사용하고 나머지 `GOVBIZ_EXISTING_*_VOLUME`도 실제 기존 볼륨명으로 맞춘다.
  웹·앱 workspace 도입 이후 Node 의존성 캐시는 새 `web-workspace-node-modules` 레이아웃을 사용하며 기존 캐시는 마운트하지 않는다.
  기존 환경에서 원래 설정으로 `down`한 뒤 새 폴더에서 같은 프로젝트명으로 실행한다. 기존에 external 볼륨을
  선택했다면 그 설정도 유지한다. `down --volumes`/`down -v`는 사용하지 않는다.
- 기존 **웹 단독 `govbiz` + Ops 단독 `govbiz4-django`** 사용자는
  `compose.existing-data.yaml`을 추가해 기존 볼륨을 명시적으로 연결할 수 있다.
  기본값과 다르면 `.env.compose`에 `GOVBIZ_EXISTING_*_VOLUME`을 설정한다.
  웹 Node 캐시는 재사용 대상에서 제외하며 새로 설치한다. 기존 캐시나 DB 데이터를 삭제하지 않는다.

```bash
# 기존 볼륨을 확인한 뒤 선택적으로 사용한다. 없는 볼륨이면 external 설정이 실행을 거절한다.
docker compose --env-file .env.compose -f compose.yaml -f compose.existing-data.yaml config --quiet
docker compose --env-file .env.compose -f compose.yaml -f compose.existing-data.yaml up -d --build
```

이후 `logs`, `down` 등에도 동일한 환경 파일·Compose 파일·프로젝트명을 사용한다.
이전 `GovBiz-infra/services/*` 체크아웃과 실제 `.env`는 보존하지만 더 이상 개발 기준 위치가 아니다.
필요한 로컬 설정은 내용을 노출하지 않고 새 경로에서 직접 준비한다.

## 검증·PR

Ops 변경도 `SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team`에 PR을 올린다. GitHub 루트의 `ops-ci.yml`이 Ops 전용
의존성 잠금·Ruff·Django·MySQL 테스트를 수행한다. Docker 작업은 통합 Compose의 Ops와
기본 Gunicorn 이미지의 non-root·read-only·상태 확인·종료 동작을 별도로 검증한다.
기존 프론트·Core·AI CI와 운영 배포 스크립트는 그대로 유지한다.

```bash
python3 infrastructure/scripts/check-compose.py
python3 infrastructure/scripts/check-compose.py --smoke
git diff --check
```

`--smoke`는 무작위 프로젝트·임시 환경 파일·전용 볼륨으로 Ops/MySQL만 빌드·실행한다.
실제 MySQL 테스트, HTTP readiness, 컨테이너 DNS를 검사하고 검증용 리소스만 정리한다.
기존 개발 DB·실제 비밀키·외부 AI 호출은 사용하지 않는다.
기존 웹·Core·AI의 전체 업무 검증 또는 Ops 운영 배포 검증을 의미하지 않는다.

## 이번 통합의 검증 기록 — 2026-09-19

아래는 최초 소스 통합 당시 기록이다. 후속 Gunicorn·로컬 Kubernetes 변경 전을 기준으로 하며,
현재 이미지 실행·검증 범위는 [Ops 안내](../backend/ops-service/README.md)와
[Kubernetes 검증 기록](https://github.com/GovBiz-Team/GovBiz-infra/blob/develop/docs/kubernetes-validation-20260919.md)을 따른다.

- 통합 Compose의 빌드·마운트 경로, 환경 파일 분리, 프로젝트·볼륨 격리, 기존 볼륨 매핑 검사 통과.
- Ops 단독 Compose 정적 구성 검사 통과.
- Python 3.13.15·uv 0.12.5 Docker 빌드 환경에서 `uv lock --check`, 잠금 동기화, 의존성 호환 검사,
  Ruff lint·format 검사 통과. 호스트에 같은 Python·uv를 설치하지 않았다.
- 격리된 Docker Ops·MySQL 8.4에서 Django 설정 검사, migration 변경 없음 검사, 테스트 5개 통과.
- 호스트 HTTP readiness와 컨테이너 간 DNS·DB readiness 확인. 검증용 컨테이너·네트워크·볼륨만 정리.
- 워크플로·Compose YAML 파싱과 기존·신규 파일 공백 검사 통과.
- Ops README를 제외한 가져온 23개 파일은 원본 blob과 동일하다.
- 기존 Frontend·Core·AI 코드, 해당 CI, 기존 개발/운영 Compose·CodeBuild 실행 파일은 변경하지 않았다.
  해당 애플리케이션 전체 테스트는 이번 소스 이동 검증에서 재실행하지 않았다.

위 로컬 검증 시점에는 실제 GitHub CI 실행, 커밋·푸시, 운영 배포,
Kubernetes·Argo CD 설치·동기화를 수행하지 않았다. 원격 CI 결과는 이후 푸시한 커밋에서 별도로 확인한다.
