# GovBiz Kubernetes · GitOps

기존 `GovBiz-infra`의 배포 설정·검증 도구를 **통합 저장소의 `infrastructure/gitops/`**로 옮겼습니다.
별도 Git 저장소나 submodule이 아닙니다. 애플리케이션과 배포 설정을 같은
`SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team` 저장소의 `main`에서 관리합니다.

앱 코드·Dockerfile·로컬 Compose는 [통합 저장소 루트](../../README.md)에 있으며,
이 디렉터리는 Kubernetes의 원하는 상태와 격리된 로컬 검증을 담당합니다.
원본 저장소 두 개와 이미 실행 중인 Mac 클러스터는 이번 파일 통합으로 변경하지 않습니다.

## 현재 상태

| 항목 | 통합 저장소에 포함한 범위 |
| --- | --- |
| 서비스 | `core-service`·`catalog-service`·`ai-service`·`ops-service`별 Helm Deployment·Service |
| 데이터 | Core·Catalog·Ops 전용 MySQL, 로컬 검증용 Redis·Elasticsearch·Qdrant |
| Argo CD | 통합 저장소 `main`의 `infrastructure/gitops/charts/govbiz-service`를 읽는 Application 4개와 제한된 AppProject |
| 로컬 이미지 검증 | 로컬 빌드·kind 적재 smoke 유지. GHCR 계정 불필요 |
| 개인 GHCR 상시 배포 | **미연결**. 기존 GovBiz-Team digest/receipt는 과거 검증 자료이며 팀원 pull 권한을 의미하지 않음 |
| 자동 발행·승격 | 제출본에서는 잠금. 교육기관 GHCR 권한을 가정하지 않으며 변수만 켜서 재개할 수 없음 |
| 상시 Mac bootstrap | 기존 개인 계정용 CLI 잠금. 토큰을 읽거나 기존 클러스터를 변경하지 않음 |
| Windows 개발 | 개인 GHCR·상시 GitOps·백엔드 코드 자동 반영의 팀원별 일괄 설치는 아직 미구현 |

`argocd/local` 최초 sync는 수동입니다. 제출본 `argocd/portfolio`도 자동 sync·self-heal·prune를
끈 검토용 템플릿입니다. **원본 저장소나 실행 중인 클러스터의 자동 배포를 껐다는 뜻은 아닙니다.**

## 구조

```text
infrastructure/gitops/
├─ argocd/                  local·portfolio Application / AppProject
├─ charts/                  서비스 Helm Chart·로컬 데이터 Chart
├─ environments/
│  ├─ local-msa/            로컬 적재 이미지용 네 서비스 values
│  ├─ portfolio/            이전 비공개 GHCR digest·receipt 보존
│  ├─ services/ops-service/base/
│  └─ local/               Ops 단독 Kustomize 검증
├─ kind/local.yaml          loopback 전용 단일 노드 검증 구성
├─ scripts/                 오프라인 검사·격리 smoke·이전 bootstrap/승격 로직
└─ docs/                    실행 안내·경계 설계·과거 검증 기록
```

GitHub Actions는 저장소 루트의 [infra-ci.yml](../../.github/workflows/infra-ci.yml)에 둡니다.
중첩 `.github/workflows`와 앱 submodule은 경계 검사에서 거절합니다.

## 정적 검증

저장소 루트에서 아래 디렉터리로 이동합니다. Python 3.13, Helm 4.3.0,
kubectl 1.36 계열이 필요합니다. 클러스터 생성이나 기존 컨텍스트 접근은 하지 않습니다.

```bash
cd infrastructure/gitops
python3 -m venv .tools/venv
.tools/venv/bin/python -m pip install -r scripts/requirements.txt
.tools/venv/bin/python -B scripts/check_repository.py
.tools/venv/bin/python -B scripts/check_kubernetes.py
.tools/venv/bin/python -B scripts/check_msa.py
.tools/venv/bin/python -B scripts/check_portfolio.py
.tools/venv/bin/python -B -m unittest discover -s scripts -p 'test_*.py'
git diff --check
```

Windows에서는 Docker Desktop Linux 컨테이너와 WSL2를 사용할 수 있지만,
**팀원 Windows에서 전체 절차가 검증되었다는 뜻은 아닙니다.** 위 POSIX 명령은 WSL용이며
네이티브 PowerShell 자동 설치 도구는 없습니다.

## 실제 격리 클러스터 검증

[네 서비스 실행 안내](docs/msa-local.md)에 따라 저장소 루트에서 서비스 이미지를 빌드한 뒤
이 디렉터리의 `scripts/smoke_msa.py`를 실행합니다. 임의 이름의 새 kind 클러스터만 만들며,
성공·실패 후 자신이 만든 클러스터와 테스트 데이터를 삭제합니다. 기존 Compose 볼륨·RDS·실제
환경 파일·유료 AI는 사용하지 않습니다. 기존 개발 컨테이너를 임의 중지하지 않습니다.

이 도구는 단순 코드 저장을 감지하는 백엔드 hot reload나 팀원별 상시 Argo CD 설치와 다릅니다.

## 서비스명과 배포 식별자

| 서비스 | 통합 저장소의 소스 | Kubernetes 이름 |
| --- | --- | --- |
| Core | [backend/core-service](../../backend/core-service) | `core-service` |
| Catalog | [backend/catalog-service](../../backend/catalog-service) | `catalog-service` |
| AI | [backend/ai-service](../../backend/ai-service) | `ai-service` |
| Ops | [backend/ops-service](../../backend/ops-service) | `ops-service` |

저장소를 통합해도 프로세스·DB 소유권은 합치지 않습니다. Catalog는 공고 원본을 소유하고 Core는
인증된 HTTP snapshot으로 자체 조회용 복제본을 갱신합니다. Ops 관리자 인증·LLMOps 업무,
전체 내부 인증·NetworkPolicy 집행·운영 HA·백업은 별도 과제입니다.

## 과거 검증과 다음 작업

2026-09-19~20 실행 결과는 **원본 GovBiz/GovBiz-infra 및 기존 Mac 환경의 기록**입니다.
통합 저장소·새 팀원 계정·Windows·교육기관 GHCR의 배포 성공 증거가 아닙니다.

- [네 서비스 실행·GitOps 기록](docs/msa-validation-20260920.md)
- [기존 Mac portfolio 기록](docs/portfolio-validation-20260920.md)
- [개인 fork 상시 GitOps 전환 조건](docs/portfolio-gitops.md)
- [이미지 승격 잠금과 남은 작업](docs/image-promotion.md)
- [서비스·데이터 경계](docs/service-boundaries.md)
- [기존 저장소 전환 기록](docs/repository-transition.md)

다음 단계는 개인 fork의 소스/브랜치·개인 GHCR 발행·읽기 전용 pull 인증·자기 PC 배포 경로를
매개변수화하고 Windows에서 검증하는 것입니다. 토큰·비밀번호·kubeconfig는 Git에 넣지 않습니다.
