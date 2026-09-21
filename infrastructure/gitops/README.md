# GovBiz Kubernetes · GitOps

기존 `GovBiz-infra`의 배포 설정·검증 도구를 **통합 저장소의 `infrastructure/gitops/`**로 옮겼습니다.
별도 Git 저장소나 submodule이 아닙니다. 애플리케이션과 배포 설정을 같은
`SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team` 저장소의 `main`에서 관리합니다.

앱 코드·Dockerfile·로컬 Compose는 [통합 저장소 루트](../../README.md)에 있으며,
이 디렉터리는 Kubernetes의 원하는 상태와 격리된 로컬 검증을 담당합니다.
기존 개인 Mac 클러스터와 새 포크의 개발 클러스터는 분리합니다. 공통 실행 도구는 로컬 `origin`에서
계정·저장소를 읽고, CI는 GitHub가 제공한 저장소 정보를 사용하므로 팀원이 계정명을 소스에서 바꾸지 않습니다.

## 현재 상태

| 항목 | 통합 저장소에 포함한 범위 |
| --- | --- |
| 서비스 | `core-service`·`catalog-service`·`ai-service`·`ops-service`별 Helm Deployment·Service |
| 데이터 | Core·Catalog·Ops 전용 MySQL, 로컬 검증용 Redis·Elasticsearch·Qdrant |
| Argo CD | 포크·기본 브랜치·중첩 Chart 경로를 반영한 Application 4개를 공통 도구가 생성. 전용 클러스터만 허용 |
| 로컬 이미지 검증 | 로컬 빌드·kind 적재 smoke 유지. GHCR 계정 불필요 |
| 개인 GHCR | 개인 포크가 자기 `ghcr.io/<계정>/<저장소>-<서비스>`에만 비공개 발행. 최초 계정별 인증/활성화 필요 |
| 자동 발행·승격 | upstream 병합 소스를 본인 포크 기본 브랜치로 동기화하고 네 CI 통과 후 발행. digest는 같은 포크 `environments/fork`에 기록 |
| 공통 bootstrap | `fork_cluster.py init/doctor/up/status/credentials/dev/gitops/web`. 무작위 로컬 비밀값·전용 kind·소유권 검사 |
| 로컬 코드 반영 | 개발 모드에서 `dev.py --watch`가 변경 서비스만 로컬 빌드·kind 적재·재시작. GHCR 업로드 없음 |
| Windows 개발 | WSL2·kind의 로컬 소스 이미지 기동과 Windows 웹 연결 확인. 네이티브 Windows Python·ARM은 미지원이며 GHCR·GitOps·개발 감시는 별도 검증 |

`argocd/local`은 격리 검증용, `argocd/portfolio`와 `environments/portfolio`는 과거 기록과 안전한 로컬 환경값
템플릿입니다. 이전 GovBiz-Team digest를 팀원의 이미지로 재사용하지 않습니다. 실제 포크의 release가 없으면
일반 `up`은 멈춥니다. 개발 모드에서는 Argo Application을 두지 않고, 명시적 `gitops` 전환 때만 자동 sync와
self-heal을 켭니다(prune는 끔). 기존 `govbiz-portfolio`를 변경하거나 인수하지 않습니다.

## 팀원 시작 경로

**이미지가 없거나 GHCR 없이 시작하려면 [Windows 수동 설치 안내](../../docs/windows-kubernetes-setup.md)를 따릅니다.**
소스 빌드 → `up --local-images` → 웹 연결 순서이며, 이 경로는 개인 Actions나 PAT가 필요하지 않습니다.
아래는 GHCR 이미지 발행·다운로드와 GitOps를 사용할 때의 준비 순서입니다.

[공통 로컬 개발 안내](../../docs/local-fork-development.md)에 따라 **개인 포크 → 클론 → 도구 설치 → 개인 Actions 활성화 →
upstream 병합 코드의 원격 포크 동기화 → 첫 이미지 발행/승격 → `git pull` → 초기화**를 진행합니다.
개인 작업 브랜치 push나 로컬 pull만으로 이미지가 발행되지는 않습니다. 누구의 개인 계정으로 포크하든 같은 명령을 씁니다.
개인 비공개 패키지를 읽는 `read:packages` 전용 PAT만 각자 준비하고 Git·채팅·공용 `.env`로 공유하지 않습니다.

```bash
# 아래는 infrastructure/gitops 디렉터리, 준비한 Python 3.13 가상환경에서 실행
python -B scripts/fork_cluster.py init
python -B scripts/fork_cluster.py doctor
python -B scripts/fork_cluster.py up
python -B scripts/dev.py --watch
```

`up`은 필요할 때 토큰을 숨김 입력받고, 선택된 네 이미지 manifest에 실제 pull 권한이 있는지 확인합니다.
기존 일곱 런타임 Secret 중 일부만 있으면 DB 비밀번호를 덮어쓰지 않고 멈춥니다. 데이터는 본인 kind의
로컬 볼륨에 저장하며 클러스터 삭제 시 잃을 수 있습니다. `up`·모드 전환은 클러스터를 자동 삭제하지 않습니다.

## 구조

```text
infrastructure/gitops/
├─ argocd/                  과거/격리 검증 Application / AppProject
├─ charts/                  서비스 Helm Chart·로컬 데이터 Chart
├─ environments/
│  ├─ local-msa/            로컬 적재 이미지용 네 서비스 values
│  ├─ portfolio/            이전 비공개 GHCR digest·receipt 보존
│  ├─ fork/                 본인 CI가 검증/생성한 values·release.json (첫 발행 전 없음)
│  ├─ services/ops-service/base/
│  └─ local/               Ops 단독 Kustomize 검증
├─ kind/local.yaml          loopback 전용 단일 노드 검증 구성
├─ scripts/                 포크 bootstrap·watch·검사·격리 smoke·이미지 승격
├─ .local/fork/             Git 제외: 개인 state·kubeconfig·개발 이미지 기록
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

Windows에서는 Docker Desktop Linux 컨테이너와 WSL2를 사용합니다.
**팀원 Windows에서 전체 절차가 검증되었다는 뜻은 아닙니다.** 위 POSIX 명령은 WSL용이며
네이티브 PowerShell 자동 설치 도구는 없습니다. Intel Mac과 Linux amd64 이미지가 기준입니다.

## 실제 격리 클러스터 검증

[네 서비스 실행 안내](docs/msa-local.md)에 따라 저장소 루트에서 서비스 이미지를 빌드한 뒤
이 디렉터리의 `scripts/smoke_msa.py`를 실행합니다. 임의 이름의 새 kind 클러스터만 만들며,
성공·실패 후 자신이 만든 클러스터와 테스트 데이터를 삭제합니다. 기존 Compose 볼륨·RDS·실제
환경 파일·유료 AI는 사용하지 않습니다. 기존 개발 컨테이너를 임의 중지하지 않습니다.

이 smoke 도구는 임시 클러스터용입니다. 상시 로컬 실행은 `fork_cluster.py`, 저장 감지·로컬 재빌드는
`dev.py`를 사용합니다. `up --local-images <JSON>`은 명시적인 로컬 이미지 검증 모드로, private GHCR pull 성공을
의미하지 않습니다. 유료 AI·외부 데이터 수집·메일 발송은 기본으로 꺼져 있습니다.

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
- [개인 fork 초기 설정·GitOps 모드 전환](docs/portfolio-gitops.md)
- [개인 이미지 발행·승격 정책](docs/image-promotion.md)
- [서비스·데이터 경계](docs/service-boundaries.md)
- [기존 저장소 전환 기록](docs/repository-transition.md)

공통화된 코드가 있어도 각 팀원의 Actions 권한, PAT 만료, Docker 자원, Windows 실제 실행은 별도로 확인해야
합니다. 토큰·비밀번호·kubeconfig는 Git에 넣지 않습니다. 원본 교육기관의 GHCR 권한은 필요하지 않습니다.
