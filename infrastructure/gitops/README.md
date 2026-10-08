# GovBiz Kubernetes · GitOps

애플리케이션과 배포 설정은 통합 저장소의 `infrastructure/gitops/`에서 함께 관리합니다.
**별도 배포 브랜치와 배포 PR은 제거했습니다.** 개발은 `skn-* → main` PR 흐름을 사용하며,
필수 CI와 이미지 발행 검증은 유지합니다. [제거 범위와 현재 상태](docs/deployment-candidates.md)를 참고하세요.
LLMOps 개발 순서는 [후속 개발 전략](../../docs/llmops-next-development-plan.md)을 따릅니다.

## 최종 배포 목표와 완료 기준

**최종 목표는 우리가 운영하는 전체 실행 구성을 Kubernetes로 통일하는 것입니다.**
Kubernetes와 Compose를 함께 쓰는 구조는 로컬 개발용이며, 현재 개인 환경의 혼합 실행은
이전 중 상태입니다. 하이브리드 연결 성공을 최종 배포 목표의 완료로 계산하지 않습니다.

| 배포 범위 | 최종 기준 |
| --- | --- |
| 웹·업무 서비스 | 배포용 웹과 Core·Catalog·AI·Ops API/sync를 Kubernetes에서 실행하고 외부 접근·인증 경로 검증 |
| 평가 실행 | Prefect·evaluation-runner·ops-artifacts를 독립 배포하고 클러스터 내부 Service로 연결 |
| 관측 | Langfuse 웹·worker와 PostgreSQL·ClickHouse·Redis·객체 저장소까지 이전 |
| 업무 데이터·기반 서비스 | 서비스별 MySQL, 검색·벡터 저장소, 캐시와 사용하는 큐의 영속성·복원·접근 제어 검증 |
| 배포·복구 | 검증된 이미지·설정을 Argo CD로 관리하고 migration·중지·재개·백업 복원·재시작 후 보존을 검증 |

단계별 완료는 `구성 코드 → 격리 Kubernetes 검증 → 실제 이전 → Compose 의존 제거`로 구분합니다.
배포 대상이 로컬 Compose, 호스트 데이터 마운트 또는 Windows/WSL 중계에 의존하지 않고,
기존 Compose 배포 인스턴스가 꺼진 상태에서 업무·평가·보고서·관측·복구가 검증돼야 전체 이전 완료입니다.
로컬 개발용 Compose는 유지하며 원본 볼륨 삭제는 별도의 데이터 보존 판단입니다.
OpenAI·공공 데이터 등 외부 API는 기존 서비스 계약을 유지합니다.

현재 `govbiz-local-data`는 로컬 검증용이므로 운영 데이터 구성의 완료 증거로 사용하지 않습니다.
다음 구현 순서는 평가 저장소 복원과 이미지 발행·Argo 연결, 평가 환경 실제 전환,
Langfuse와 관련 저장소 이전, 남은 웹·데이터·외부 접근 및 운영 복구 검증입니다.
[평가 환경 이전의 상세 기준](docs/evaluation-kubernetes.md)을 함께 따릅니다.

## 현재 상태

| 항목 | 지원 범위 |
| --- | --- |
| 서비스 | 서비스별 Helm Deployment·Service, Ops PreSync migration Job |
| 로컬 Kubernetes | 로컬 소스의 `up --local-images` 또는 현재 CI·발행·receipt를 검증하는 GHCR `up` |
| 이미지 발행 | 개인 포크의 같은 소스 SHA에 대한 필수 CI와 이미지 검증 후 GHCR 발행 |
| 별도 배포 PR | 제거. 자동 브랜치 생성·PR 생성·검사 dispatch 없음 |
| Argo 입력 준비 | `deployment.py plan-gitops`: 검증된 공개 이미지·소스 SHA로 고정한 수동 동기화 계획 출력 |
| 평가 Argo 최초 동기화 요청 | `evaluation_release.py --request-dormant-sync`: 검증한 기존 세 Application에 replica 0 수동 sync 요청. 완료·실행 검증은 별도 |
| 발행본 기준 연결 설정 비교 | `deployment.py review-published-runtime --state-dir ...`: 공개 발행 Chart·values로 기존 연결 설정을 재현하고 전후 발행 검증 |
| 기존 환경 전환 파일 준비 | `gitops_transition.py`: dev 환경 또는 안정된 수동 Argo 환경의 기존 설정과 공개 발행본으로 개인 state의 비공개 파일 생성. 적용·동기화 없음 |
| 저장된 전환 파일 재검증 | `gitops_transition.py --verify`: 현재 발행본·환경으로 계획을 다시 생성해 파일 전체와 비교. 파일 갱신·적용 없음 |
| Ops 백업 전 중지·복구 계획 | `ops_maintenance_plan.py`: dev 또는 안정된 수동 Argo 환경에서 대상·원래 실행 상태를 조회. 접수 중지·백업·서비스 변경 없음 |
| 개인 환경 Argo 인계 | 2026-10-07 공개 이미지 4개를 수동 동기화해 `Synced/Healthy` 확인. 아래 실행 기록 참고 |
| Argo 자동 배포 | 자동 인계·새 발행본 자동 적용 미구현. 자동 동기화·prune·selfHeal 비활성 |
| 과거 snapshot | 읽기·검증 및 오프라인 정책 테스트 보존 |

`MSA_PROMOTION_ENABLED=false`를 유지합니다. GHCR `up`은 별도 배포 브랜치 없이
[현재 발행 검증 경로](docs/image-promotion.md)로 초기화합니다.
개인 환경 1곳은 검증된 `e7898ec` 공개 발행본으로 수동 인계를 마쳤습니다.
[실제 백업·migration·Argo 인계 기록](../../docs/ops-upgrade-runbook.md#개인-환경-공개-이미지의-argo-인계--2026-10-07)을 참고하세요.
이는 운영자가 수행한 전환이며, 아래 준비 도구에 적용·자동 배포 기능이 추가된 것은 아닙니다.
`plan-gitops`는 자동 동기화를 끈 검토용 구성을 출력하며, 개인 환경 호환성 확인이나 실제 배포를 수행하지 않습니다.
기존 연결 설정을 보존한 전환 파일은 [전환 파일 준비](docs/image-promotion.md#기존-환경의-비공개-전환-파일-준비)로 생성합니다.
이 파일은 백업·migration·실제 전환 검증이 남은 검토 자료이며, 생성 성공을 배포 준비 완료로 취급하지 않습니다.
저장 후의 변경 여부는 [전환 파일 재검증](docs/image-promotion.md#저장된-전환-파일-재검증)으로 확인합니다.
생성·재검증 실패 시 `failureStage`와 값 없는 `changedSections`로 중단 지점을 구분합니다.
외부 명령 실패·시간 초과는 `failureKind`와 허용된 도구 이름만 표시합니다.
공개 발행본이 없거나 소스·CI 검증에 막히면 `publicationBlocker`에 현재 기본 브랜치의 원본 병합·필수 CI·
발행 단계 진단을 표시합니다. 진단 결과는 배포 승인이 아니며 기존 차단과 종료 코드 1을 유지합니다.
`--state-dir ... --review-preservation`은 기존 환경변수·Ops sync의 Helm 재현 가능성을 임시 렌더링으로
비교합니다. 설정값은 출력하지 않으며 전환 차단을 해제하지 않습니다. [검사 범위와 사용법](docs/image-promotion.md#현재-연결-설정을-helm으로-재현해-보기)을 확인하세요.
`--state-dir`을 지정하면 먼저 개인 연동 설정·네 서비스의 Deployment·Service·연결된 Ops·sync 구성을 읽어 충돌을 차단합니다.
보고서에는 개인 연동 기능과 현재 checkout의 서비스별 기본 환경 대비 변경·추가·누락된 설정 이름을 값 없이 표시합니다.
같은 checkout의 Chart를 임시 경로에서 렌더링해 저장소·실행 명령·초기화 컨테이너·복제 수·배포 전략 차이도 차단합니다.
probe·자원 요청/한도·Pod 및 컨테이너 보안·서비스 계정·DNS 설정 차이도 값 없이 보고하며, 실제 건강 상태나 RBAC 권한 검증은 별도입니다.
노드 선택·affinity·toleration·배치 분산·scheduler·우선순위·RuntimeClass·scheduling gate·resource claim의
선언 차이도 정책 차단에 포함합니다. 실제 노드 조회나 스케줄링 가능 여부 검증은 수행하지 않습니다.
Service의 selector·포트·노출 설정과 Deployment 라벨·selector를 비교하고, Pod 선택 및 이름 기반 targetPort의 선언상 연결도 검사합니다.
자동 할당 IP·기본값은 차이에서 제외하며, EndpointSlice·실제 통신·NetworkPolicy 검증은 포함하지 않습니다.
이 제한된 사전 검사는 전체 실행 환경의 호환성 검증을 대신하지 않습니다.
현재 Service의 실제 연결 대상은 `fork_cluster.py status --json --network-details`로 별도 확인할 수 있습니다.
EndpointSlice와 준비된 Pod의 UID·IP·포트를 대조하며 HTTP 통신 성공은 검증하지 않습니다.
[연결 대상 진단 안내](../../docs/local-fork-development.md#kubernetes-service의-실제-연결-대상-확인)를 참고하세요.
`status --json`의 `argocd.evaluation`은 평가용 세 Application의 누락·선언·동기화 상태를 별도로
표시합니다. replica 0의 준비 상태도 관찰 대상이며 실제 실행·이전 완료를 증명하지 않습니다.
[평가 Application 진단 범위](docs/evaluation-kubernetes.md#평가-argo-application-상태-조회)를 참고하세요.

## 팀원 시작 경로

[Windows 수동 설치 안내](../../docs/windows-kubernetes-setup.md)의 소스 이미지 빌드와
`up --local-images` 경로를 사용합니다. [공통 개발 안내](../../docs/local-fork-development.md)의
개발 감시·웹 연결은 유지합니다. 소스 이미지 경로에는 GHCR 계정이나 PAT가 필요하지 않습니다.
검증된 GHCR 이미지를 사용할 때는 `gh` 로그인과 해당 이미지의 pull 권한을 준비하고 일반 `up`을 실행합니다.

현재 Prefect·평가 실행기·결과 저장소는 Compose에서 실행됩니다. 배포 대상의 최종 방향은
서비스 경계를 유지한 Kubernetes 통합입니다. [단계적 이전 구성과 완료 기준](docs/evaluation-kubernetes.md)을
따르며, 독립 Helm 구성의 추가만으로 기존 환경이 이전된 것은 아닙니다.
[Ops 연결 계약](docs/ops-runtime.md)과 [스키마·migration 계약](docs/ops-migration.md)을 따릅니다.
기존 개발 클러스터·서비스·DB·볼륨을 이번 제거 작업에서 삭제하거나 변경하지 않았습니다.

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

Infra CI의 `kubernetes-manifests` 작업은 `test_*.py` 전체를 검색하므로 배포 후보의 실제
Helm 렌더링 테스트도 실행합니다. `helm-gitops` 작업과 **각각** Helm 4.3.0을 설치하고,
배포 아카이브 체크섬 검증과 실행 버전 확인을 테스트 전에 수행합니다. 다른 작업의 설치 결과나
GitHub 호스트에 기본 설치된 Helm 버전에 의존하지 않습니다.

`test_ci_toolchain.py`는 두 작업의 설치·검증·테스트 순서와 필수 실행을 확인하고, 다른 Helm
버전 및 CLI 실패가 버전 검사에서 거절되는지 검증합니다. 기존 Helm 렌더링 테스트와 유료 실행
설정 거절 검증은 그대로 유지합니다. 이 검증은 오프라인 렌더링이며 실제 배포나 동기화가 아닙니다.

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
