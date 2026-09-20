# 🏛️ GovBiz

**LLM 기반 정부지원사업 탐색·신청 관리 플랫폼**

이 저장소는 교육기관 제출·공동 개발을 위해 **애플리케이션과 Kubernetes·GitOps 설정을 함께 관리하는 모노레포**입니다.
기준 저장소는 [`SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team`](https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team), 기본 브랜치는 `main`입니다.
기존 `GovBiz`와 `GovBiz-infra`의 추적 파일을 통합했으며, submodule이나 두 번째 clone이 필요하지 않습니다.
[통합 기준·이전 방법·팀원 실행 범위](docs/repository-integration.md)

React·Core API·Catalog Service·AI Service와 Django 기반 Ops를 포함합니다.
Ops 소스는 [`backend/ops-service`](backend/ops-service)에 있으며, 상태 확인 API·전용 MySQL·Gunicorn 실행 이미지를 갖추고 있습니다.
소스를 통합해도 서비스 프로세스·의존성·DB 책임은 분리합니다.

사용자 클라이언트는 [`frontend/`](frontend/README.md) 아래의 웹(`frontend/web/`)과 React Native 앱(`frontend/mobile/`)으로 나눠 관리합니다.
[모바일 실행·기능 안내](frontend/mobile/README.md) · [공통 코드·workspace 관리](docs/mobile-monorepo.md)

전체 로컬 실행은 루트 `compose.yaml`을 사용합니다. Core·Catalog·AI·Ops를 포함하며,
Core는 Catalog의 내부 HTTP snapshot을 읽습니다. `.env`에 32자 이상의 `CATALOG_INTERNAL_TOKEN`을
설정해야 합니다. 기존 embedded 수집 경로는 전환 호환용 `infrastructure/compose.yaml`에 남겨 둡니다.
[통합 개발·이전 안내](docs/ops-monorepo-migration.md)를 먼저 확인하세요.
Kubernetes·Helm·Argo CD 설정은 같은 저장소의 [`infrastructure/gitops/`](infrastructure/gitops/README.md)에서 관리합니다.

```text
SKN34-4th-1Team/
├─ frontend/                 웹·모바일·공통 패키지
├─ backend/                  core-service·catalog-service·ai-service·ops-service
├─ infrastructure/
│  ├─ gitops/                Helm·Argo CD·kind·환경별 values·인프라 검증
│  └─ …                      Compose·이미지 빌드·기존 AWS 배포 템플릿
├─ .github/workflows/        앱 CI와 인프라 CI
├─ docs/                     개발 문서·기존 검증 기록
└─ compose.yaml              로컬 통합 개발 진입점
```

Compose 서비스·내부 DNS는 `core-service`, `catalog-service`, `ai-service`, `ops-service`이며 Ops DB 컨테이너는 `ops-mysql`입니다.
Kubernetes Deployment·Service도 네 서비스명으로 통일합니다. 기존 로컬 컨테이너·데이터는 자동으로 변경하지 않습니다.
Compose가 생성하는 이름은 `<프로젝트명>-core-service-1`, `<프로젝트명>-ops-service-1` 형식입니다.
고정 `container_name`이나 이전 이름의 DNS 별칭은 두지 않습니다.

### 현재 구현·배포 상태

| 구분 | 상태 |
|---|---|
| 운영 환경 | 현재 운영 환경 없음. EC2 Compose·CodeBuild 설정은 재배포용 템플릿이며 자동 실행하지 않음 |
| Ops 로컬 개발 | 별도 Django 프로세스·MySQL, 상태 확인 API, 독립 테스트·컨테이너 검증 구현 |
| Core 공고 기능 분리 | 별도 Catalog 프로세스·MySQL과 인증된 HTTP 복제 경로 구현. 루트 Compose의 기본 경로이며 기존 데이터 이전·운영 배포는 별도 |
| Kubernetes | kind에서 Core·Catalog·AI·Ops와 독립 DB 실행, HTTP 복제·교차 DB 접근 거절·AI 단독 설정 롤아웃·Catalog 장애·테스트 데이터 복구 검증 완료 |
| 로컬 GitOps | 개인 포크의 비공개 GHCR → Intel Mac kind → 네 Argo 앱 Synced/Healthy·self-heal 실검증 완료. 개발 모드와 GitOps 모드를 명시적으로 전환 |
| 이미지 릴리스 | 일회용 PAT로 빈 비공개 패키지를 초기화하고 권한 검증 후 자동 발행 활성화. 반복 발행은 Actions `GITHUB_TOKEN`으로 소유자·Private·연결 포크·CI를 검사 |
| 로컬 코드 반영 | 감시 도구가 변경한 서비스만 로컬 이미지로 재빌드·kind 반영. 저장할 때 Git push·GHCR 업로드하지 않음 |
| 미완료 범위 | 다른 팀원 계정별 최초 준비·인증과 실제 Windows/WSL2 실행 검증, Ops 관리자 인증·LLMOps 업무 구현, 클라우드 고가용성 운영 |

**도구 제공과 모든 팀원의 환경 검증 완료는 다릅니다.** 도구는 기존 클러스터의 데이터를 옮기거나
삭제하지 않습니다. 이번 Mac 전환은 기존 클러스터를 승인하에 중지하고 새 개인 포크 클러스터를 유지합니다.
원본 GovBiz-Team 저장소의 자동 배포 설정은 변경하지 않았습니다. clone만으로 발행·배포가 시작되지는 않습니다.
[개인 포크 비공개 발행·실제 pull·GitOps 검증 기록](docs/fork-gitops-validation-20260921.md)과
[기존 MSA 기능 검증 기록](infrastructure/gitops/docs/msa-validation-20260920.md)에서
완료 범위와 미검증 항목을 확인할 수 있습니다.

검증 이미지는 `infrastructure/scripts/build-msa-images.py`로 순차 빌드합니다.
[이미지 릴리스 CI와 활성화 조건](docs/msa-image-release.md)은 로컬 검증 빌드와 별개이며,
업로드 성공만으로 실제 배포가 완료됐다고 판단하지 않습니다.
[로컬 MSA·Helm·GitOps 실행 방법](infrastructure/gitops/docs/msa-local.md)을 따르며,
실제 `.env`·기존 DB·유료 AI를 사용하지 않는 임시 환경에서 검증합니다.

### 팀원이 자기 포크에서 개발하는 방법

[개인 포크 로컬 개발 안내](docs/local-fork-development.md)를 따릅니다. 계정명·저장소명을 코드에
직접 바꾸지 않습니다. Windows는 **x64 WSL2 Ubuntu + Docker Desktop Linux 통합**, Mac은 현재
검증 대상인 **Intel + Linux amd64 이미지**를 사용합니다. ARM·Windows 네이티브 실행은 미지원입니다.

- **준비 완료 후 공동 배포 기준:** 개발 브랜치 → 교육기관 원본 PR·병합 → 내 포크 `main` 동기화 → CI → 기존 비공개 GHCR 패키지에 발행 → 내 PC GitOps.
- **내 PC 개발:** 이미지를 받아 초기화 → 개발 모드에서 코드 저장 → 바뀐 서비스만 로컬 재빌드·반영.
- `git pull`만으로 GitHub CI가 시작되지는 않습니다. 내 포크의 **원격** 기본 브랜치도 동기화해야 합니다.
- Actions 변수와 `read:packages` 인증만으로 최초 준비가 완료되는 것은 아닙니다. 네 비공개 패키지가
  본인 소유이며 정확히 자기 포크에 연결됐는지 먼저 검증해야 합니다. 없거나 확인할 수 없으면 업로드 전에 중단합니다.
- [비공개 최초 준비](docs/private-ghcr-setup.md)를 완료하기 전에는 두 발행 변수를 `false`로 유지하고,
  완료·검증한 자기 포크에서만 `true`로 바꿉니다. 읽기 토큰은 패키지를 생성할 수 없으며 Git에 넣지 않습니다.
- [이미지 발행 최초 설정](infrastructure/release/README.md) · [개발·GitOps 모드 실행 명령](docs/local-fork-development.md)

공고 분리 모드에서는 `Catalog → Catalog MySQL`이 원본 수집·색인을 소유하고,
`Core → 내부 HTTP API → 검증 → Core MySQL 조회용 복제본`으로 기존 관심 공고·파트너 모집 참조를 보존합니다.
전환 호환성을 위해 기존 Core 수집 구현도 남아 있으나, 분리 모드에서는 실행되지 않습니다.
[분리 범위·검증·운영 전환 조건](docs/catalog-service-extraction.md)을 참고하세요.

## 로컬 시스템 아키텍처

![개인 포크 기반 로컬 Kubernetes 시스템 아키텍처](docs/assets/architecture/govbiz-local-architecture.png)

[PNG·SVG와 구성도 해설](docs/assets/architecture/README-local.md) ·
[개인 포크 개발·GitOps 안내](docs/local-fork-development.md) ·
[실제 비공개 GHCR·GitOps 검증 기록](docs/fork-gitops-validation-20260921.md)

그림은 **2026-09-21 개인 포크 `ilil1/SKN34-4th-1Team`의 Intel Mac 구성**입니다.
소스와 Helm 배포 설정은 같은 저장소에 있으며, 네 서비스와 전용 DB·데이터 저장소를 로컬 kind에서 실행합니다.
주황 점선은 비공개 GHCR·Argo CD 배포, 초록색은 개발 모드에서 코드 저장 후 자기 PC에만 재빌드·반영하는 경로입니다.
웹은 클러스터 밖의 Vite 개발 서버입니다. [개인 연동 프로필](infrastructure/gitops/docs/local-integrations.md)에서
RabbitMQ·OpenAI·SMTP를 연결했으며, 자동 유료 작업은 비용 한도 확인 전까지 대기합니다. 공용 기본 프로필은 무료 시연 설정을 유지합니다.
Windows 실기기·전체 업무 기능·클라우드 운영까지 검증됐다는 의미는 아닙니다.
기존 [통합 전 Kubernetes 그림](docs/assets/architecture/README-kubernetes.md)과
[Compose·AWS 그림](docs/assets/architecture/README.md)은 과거 기록으로 보존합니다.

## 문서 안내

3차 프로젝트의 팀 소개부터 기능·아키텍처·평가 결과·회고까지는
[3차 프로젝트 README](docs/third-project/README.md)에서 별도로 관리합니다.
이 메인 README는 현재 모노레포 구성과 구현·배포 상태를 안내합니다.

- [3차 프로젝트 README](docs/third-project/README.md): 기존 프로젝트 소개와 결과·회고
- [전체 문서 목록](docs/README.md) · [기술 README](docs/technical-readme.md): 설계·API·실행·검증 안내
- [웹](frontend/web/README.md) · [모바일](frontend/mobile/README.md): 클라이언트 개발·실행 안내
- [Core](backend/core-service/README.md) · [Catalog](backend/catalog-service/README.md) · [AI](backend/ai-service/README.md) · [Ops](backend/ops-service/README.md): 서비스별 책임·실행·검증 안내
