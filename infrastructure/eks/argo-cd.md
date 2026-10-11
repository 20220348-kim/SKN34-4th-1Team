# 시드니 EKS의 Argo CD 자동 배포 전환

[자동 배포 전체 흐름](continuous-deployment.md) · [EKS 안내](README.md)

CodeBuild는 이미지 빌드·ECR 발행·검증된 Git 배포 태그 발행을 담당합니다.
클러스터 앱 변경은 Argo CD가 수행하며 CodeBuild는 결과만 조회합니다.
웹은 Vercel을 유지하고, Argo의 정확한 배포 revision·두 hook·앱 이미지가 확인돼야 전환합니다.

## 구현과 실제 적용 상태

- `gitops.py`: 검증된 소스의 Helm 렌더링, 불변 `govbiz-eks/v1.RUN.ATTEMPT` 태그 발행,
  기존 환경을 보존하는 Application 생성, 읽기 전용 동기화 검증을 제공합니다.
- `release-rbac.yaml`: CodeBuild의 patch·scale·exec·Job 생성 권한을 제거하고 지정 리소스의 get만 허용합니다.
- 2026-10-12 읽기 전용 점검에서 대상 앱 6개는 Ready 1/1이었고 Application CRD는 없었습니다.
  기존 설정을 비공개 로컬 파일로 수집하고 인계 YAML을 생성했습니다. 이 기록은 Argo 설치·권한 변경·실배포 완료를 뜻하지 않습니다.
- 전환 코드의 main 반영·필수 CI 통과, 아래 최초 인계, 실제 자동 실행 검증이 필요합니다.
- 기존 방식의 첫 자동 배포와 충돌하지 않도록 이번 작업에서는 운영 RBAC·Argo 관리권·main을 변경하지 않았습니다.
  해당 실행이 끝난 뒤 최신 Deployment 설정을 다시 수집해 인계합니다. 앞서 수집한 파일을 그대로 적용하지 않습니다.

## 최초 인계 순서

1. `EKS_RELEASE_ENABLED=false`를 유지하고 기존 CodeBuild 배포가 종료됐는지 확인합니다.
   진행 평가와 수동 배포 실패 표시 `govbiz.io/release-in-progress`가 있으면 먼저 복구합니다.
   운영 DB·결과 PVC의 백업 및 복구 경로를 확인합니다. 원본 로컬 클러스터나 데이터를 정리하지 않습니다.
2. 전용 kubeconfig의 대상이 시드니 `govbiz-eks`인지 확인합니다. 워커의 여유 자원과 Argo 구성요소의
   요청량을 확인하고, 기존 EKS 안내에 고정한 **Argo CD Core 3.5.3**을 설치합니다.
   공식 core-install manifest와 저장소에 기록된 SHA-256을 검증합니다.
   [고정 설치 절차](README.md#다른-pc-빈-ebs에-복원한-뒤-시작)는 기존 원본 이전 절차 중 Argo 설치 부분만 참고합니다.
   해당 절의 이전 Application 9개나 데이터 복원 명령을 다시 실행하지 않습니다.
   `argocd-config.yaml`의 annotation 추적과 별도 instance label key를 유지합니다.
3. `argocd` namespace가 준비되면 관리자 권한으로 `release-rbac.yaml`을 적용합니다.
   기존 `govbiz-eks-release` Role을 덮어써 쓰기 권한을 제거하고, 다른 RoleBinding·EKS access policy가
   추가 쓰기 권한을 주지 않는지 확인합니다. 실제 CodeBuild 역할의 preflight가 이 조건을 검사합니다.
4. 6개 Deployment만 읽어 비공개 JSON으로 보관하고 `gitops.py application`을 실행합니다.
   결과에는 운영 환경 설정값이 들어갈 수 있으므로 Git·이슈·CI artifact에 올리지 않습니다.

   ```sh
   umask 077
   # runtime.json 형식: {"cluster":"govbiz-eks.ap-southeast-2.eksctl.io","items":[...6개 Deployment...]}
   python -B infrastructure/eks/gitops.py application \
     --runtime .data/eks-argo/runtime.json --output .data/eks-argo/application.yaml
   ```

   업무 namespace의 Core·Catalog·AI·Ops, 평가 namespace의 실행기·결과 서버가 대상입니다.
   다른 클러스터, 기존 Argo 소유권, 바뀐 selector, 정지된 앱, 미복구 배포 표시,
   활성 유료·정기 평가 설정은 자동 인계를 거절합니다. 기존 환경·Secret 참조·결과 PVC·노드 배치를 보존합니다.
   Helm 결과와 보존 patch를 오프라인 렌더링해 기존 Service selector·포트·자원·볼륨과 대조합니다.
   이미지·실행 명령은 Git에서 갱신되도록 보존 patch에서 제외합니다.
   업무 서비스의 환경변수 배열은 최초 인계 patch가 보존하므로 이후 환경 설정 변경은 해당 patch도
   함께 검토·갱신해야 합니다. 운영 Secret 값은 Git 배포 태그에 포함하지 않습니다.
5. 생성한 AppProject·Application을 검토해 적용합니다. DB·PVC·Secret·StatefulSet과
   Prefect·Langfuse·API Gateway는 이 Application이 소유하지 않습니다.
   `automated.enabled=true`, `prune=false`, `selfHeal=false`, `FailOnSharedResource=true`를 유지합니다.
   최초 `govbiz-eks/*` 태그가 아직 없으면 비교 오류로 대기하며 앱을 교체하지 않습니다.
   태그가 이미 있으면 적용 전에 해당 소스·CI·이미지를 확인해야 합니다.
6. 새 코드가 개인 main에 반영되고 같은 SHA의 필수 CI 5개가 통과한 뒤 활성화합니다.
   CodeBuild는 먼저 Argo source·자동 sync 설정과 자신의 앱 교체 권한 부재를 검사합니다.
   ECR 발행 후 Helm 4.3.0으로 YAML을 만들고 CI run/attempt와 ECR digest를 재확인해 Git 태그를 발행합니다.
   Git contents write 토큰은 이 단계에 필요하며, 코드가 배포 브랜치·기존 태그를 갱신하지 않도록 제한합니다.
   원격 태그 보호 정책은 저장소에서 별도로 적용해야 합니다.
7. Argo PreSync가 접수를 중지하고 진행 중인 평가 종료를 확인한 뒤 migration을 수행합니다.
   앱 6개 동기화와 Healthy 이후 PostSync가 평가 연결을 검증하고 자기 접수 중지만 복구합니다.
   CodeBuild는 Git revision·hook 성공·앱 generation·Ready·컨테이너 digest를 읽어 대조합니다.
   이후 Vercel 운영 전환과 관리자 로그인·기존 평가 이력·보고서 보존을 확인합니다.

## 실패 시

Argo 실패·시간 초과는 배포 성공이 아닙니다. workflow가 끝나도 이미 발행된 태그의 Argo 실행은 계속될 수 있습니다.
다음 태그 발행 전에 Argo operation, migration, 실제 이미지와 Ops 접수 감사 이력을 확인합니다.
실패한 태그의 접수 중지는 다른 태그가 해제하지 않습니다. 같은 태그 재시도 또는 운영자 복구가 필요합니다.
성공해 접수를 복구한 태그를 다시 실행하려면 새 workflow 실행으로 새 태그를 발행합니다.
직접 `release.py rollout`이나 기존 `deploy.py`로 우회하지 않습니다.

## 검증

Infra CI는 ECR·CI 검증, 실제 Helm·Kustomize 렌더링, 태그 불변성, 관리권·patch 제한,
동기화 revision·hook·이미지·시간 초과와 읽기 전용 RBAC를 검사합니다.
Ops CI는 MySQL 8.4에서 local·EKS 태그의 접수 보호·migration 실패·재시도·관리자 중지 보존을 검사합니다.
오프라인 테스트와 실제 Argo 설치·자동 배포 검증은 별도로 보고합니다.

### 2026-10-12 로컬 확인

| 검증 | 결과 |
|---|---|
| `test_eks_gitops`·`test_eks_release` | 최신 main 리베이스 후 29개 통과. 실제 Helm·Kustomize 렌더링, CI·ECR 재검사, 태그 불변성, 동기화·이미지 및 Vercel 승격·상태 조회 검증 포함 |
| 기존 `test_local_release` | 6개 통과. 공유 함수 변경 후 로컬 자동 배포 회귀 확인 |
| Ops local·EKS 단위 테스트 | DB 없는 8개 통과. MySQL 통합 검증을 대신하지 않음 |
| 수집한 EKS 설정과 오프라인 대조 | 앱 6개의 selector·노드 배치/affinity·자원·환경/Secret 참조·PVC 이름 보존 확인. 실제 적용 전에는 최신 상태를 다시 수집해야 함 |
| Ruff·actionlint·문서·구성도 | 정적 검사, 변경 링크, 이미지 로고 26개·텍스트 경계, `git diff --check` 확인 |

Ops 검사는 기존 Python 3.12 가상환경에서 수행했습니다. `uv run --locked`의 의존성 동기화는
PyPI 연결 실패로 완료하지 못했으며, 잠금 환경·MySQL 8.4·컨테이너 전체 검증은 새 커밋의 CI에서 확인해야 합니다.
추가로 실행된 기존 EKS 백업 테스트 1건은 macOS `tar`가 `--sparse`를 지원하지 않아 실패했습니다.
해당 코드와 테스트는 변경하지 않았고 Linux Infra CI의 검증을 유지합니다.

[Argo 태그 추적](https://argo-cd.readthedocs.io/en/stable/user-guide/tracking_strategies/) ·
[동기화 단계](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/)
