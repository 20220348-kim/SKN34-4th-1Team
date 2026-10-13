# 시드니 EKS의 Argo CD 자동 배포 전환

[자동 배포 전체 흐름](continuous-deployment.md) · [운영 대시보드 접속](argocd-dashboard.md) · [EKS 안내](README.md)

CodeBuild는 이미지 빌드·ECR 발행·검증된 Git 배포 태그 발행을 담당합니다.
클러스터 앱 변경은 Argo CD가 수행하며 CodeBuild는 결과만 조회합니다.
웹은 Vercel을 유지하고, Argo의 정확한 배포 revision·두 hook·앱 이미지가 확인돼야 전환합니다.

## 구현과 실제 적용 상태

- `gitops.py`: 검증된 소스의 Helm 렌더링, 불변 `govbiz-eks/v1.RUN.ATTEMPT` 태그 발행,
  기존 환경을 보존하는 Application 생성, 읽기 전용 동기화 검증을 제공합니다.
- `release-rbac.yaml`: CodeBuild의 patch·scale·exec·Job 생성 권한을 제거하고 지정 리소스의 get만 허용합니다.
- 2026-10-12 최초 점검에서는 앱 6개가 Ready 1/1이었지만 Application CRD가 없었습니다.
  자동 배포 workflow가 이미 활성화돼 있어 Argo 소유권 사전 검사에서 실패했습니다.
- 같은 날 시드니 `govbiz-eks`에 체크섬을 확인한 Argo CD Core 3.5.3을 설치하고
  컨트롤러·ApplicationSet 컨트롤러·repo-server·Redis 4개 Pod의 Ready를 확인했습니다.
  기존 환경을 다시 수집해 `govbiz-eks` AppProject·Application을 등록했습니다.
- CodeBuild의 기존 두 Role을 읽기 전용으로 축소하고 Application 조회 Role을 추가했습니다.
  배포 그룹의 Deployment 조회 허용·수정 거절, 추가 EKS access policy 부재를 확인했습니다.
  첫 자동 실행에서 실제 CodeBuild 역할의 Argo 소유권·읽기 전용 사전 검사도 통과했습니다.
- 인계 중 `EKS_RELEASE_ENABLED=false`로 실행을 보류한 뒤 `true`로 복구했습니다.
  등록 직후에는 `govbiz-eks/*` 태그가 없어 비교 오류로 대기했지만, 첫 검증 태그가 발행되자
  Argo가 주기적 조회로 감지해 자동 동기화했습니다. 수동 sync는 실행하지 않았습니다.
- 개인 main `0a523e5e555e5daec8425312977a9abd0342a18c`의 필수 CI 5개가 모두 성공했고,
  CI 완료 이벤트(`workflow_run`)로 시작된
  [첫 자동 배포 38193929451](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/38193929451)의
  `gate`·`backend`·`web` 작업이 모두 성공했습니다.
  ECR 이미지 5개, Git 태그 `govbiz-eks/v1.38193929451.1`, GitOps revision
  `74a37973deec0f4e45fd34450aefd02d57179dfc`가 배포 근거입니다.
- Argo `Synced / Healthy`, operation `Succeeded`, PreSync·PostSync 성공을 확인했습니다.
  앱 6개 모두 위 source SHA와 Ready 1/1이며 관측 generation이 실제 generation과 일치했습니다.
  성공한 hook Job은 정리 정책에 따라 삭제되므로 결과는 Application의 operation 기록으로 확인합니다.
- 같은 SHA의 Vercel 운영 전환도 완료했습니다. 운영 웹(`/`)과 Core health·AI health·Ops session은
  배포 후 모두 HTTP 200이었습니다. 모델 호출이나 사용자 데이터 변경을 추가로 실행하지 않았습니다.
  복구 작업용으로 추가한 이 PC의 임시 EKS `/32` 허용은 제거했고, 기존 허용 목록과
  public/private endpoint 설정을 유지했습니다. main 병합 보류도 해제할 수 있습니다.

### 현재 Argo 자원 배치

Argo Core 4개 구성 요소와 아래 대시보드 서버 1개는 기존
`govbiz.io/workload-pool=observability` 노드에 배치했습니다. 현재 `argocd`의 Pod는 총 5개입니다.
새 노드나 외부 LoadBalancer는 만들지 않았습니다. 설치 manifest의 기본값에는 자원 제한이 없어
아래 값을 적용했습니다. 재설치할 때도 같은 배치·자원 설정을 유지합니다.

| 구성 요소 | CPU 요청 / 제한 | 메모리 요청 / 제한 |
|---|---|---|
| application-controller | 50m / 1 | 256Mi / 768Mi |
| repo-server | 25m / 1 | 256Mi / 768Mi |
| ApplicationSet controller | 25m / 200m | 64Mi / 128Mi |
| Redis | 25m / 200m | 64Mi / 128Mi |
| argocd-server 대시보드 | 50m / 500m | 128Mi / 384Mi |

초기화 컨테이너는 25m/64Mi 요청, 200m/128Mi 제한을 사용합니다.
평가 서비스의 observability 이전 설정에서는 controller·repo-server CPU 요청을 기존 각각
100m에서 위 값으로 조정합니다. 소규모 Application 1개인 현재 클러스터에서 관측한 CPU는
각각 2~3m·1m이며, CPU 사용 상한과 메모리는 유지합니다. 초기 관측값이 배포 중 최대 사용량을
보장하지 않으므로 이후 관리 Application 수가 늘어나면 요청량을 다시 산정합니다.
업무 노드의 CPU 미예약분은 인계 시점에 65m로, 배포 전후 Job의 요청량 100m보다 작았습니다.
PVC를 사용하지 않는 `ops-service-release-prepare`·`ops-service-release-resume` Job만
Application의 기존 Kustomize patch에 `/spec/template/spec/nodeSelector`를 추가해
자동 확장 적용 전에는 `govbiz.io/workload-pool=observability`로 배치했습니다.
현재는 두 Job을 확장 가능한 `govbiz.io/workload-pool=application`에 배치하여
고정 관측 노드의 CPU 예약 공간이 부족해도 배포를 진행할 수 있습니다. 두 Job은 순서대로 실행하며,
업무 Deployment의 배치와 Git에서 정한 이미지·명령·자원 요청은 유지합니다.
Application을 다시 생성할 때 이 Job 배치도 반영해야 합니다. `gitops.py application`의
기본 출력에는 이 클러스터의 자원 여유를 반영한 Job 배치가 포함되지 않습니다.
기존 앱 6개의 환경변수·자원·명령·PVC·노드 배치와 Service 5개의 selector·포트를 대조했습니다.
배포되는 NetworkPolicy 2개도 기존 허용 통신과 같음을 확인했습니다.
`ops-artifacts`의 근거 자료 초기화 이미지도 이번 인계에서 같은 배포의 평가 실행기 이미지로 갱신했습니다.
운영 환경이 포함된 Application·수집 JSON은 비공개로 보관하고 Git에 추가하지 않습니다.

### 2026-10-13 운영 대시보드 추가

- 기존 Core와 같은 3.5.3의 `argocd-server` Deployment·ClusterIP Service·RBAC와
  직접 인입 차단 NetworkPolicy만 [별도 매니페스트](argocd-dashboard.yaml)로 추가했습니다.
  전체 Argo 설치 정의를 다시 적용하지 않았습니다.
- observability 노드에서 서버 `Ready 1/1`을 확인했습니다. 기존 Core 4개 Pod의 UID·재시작
  횟수와 `govbiz-eks` Application spec 해시는 설치 전후 같고 `Synced / Healthy`를 유지했습니다.
- 초기 설치 시 EC2는 2대였습니다. 설치 직후 서버 관측값은 CPU 2m·메모리 40Mi이며,
  이 값은 최대 부하나 장기 사용량을 뜻하지 않습니다.
- 관리자 PC의 `127.0.0.1:18443 → Service 443 → Pod 8080` 터널에서 서버 인증서 검증,
  HTML 200, 비인증 Application 조회 401, admin 로그인 200과 `govbiz-eks` 리소스 트리를
  확인했습니다. 기존 EKS 접속 허용 CIDR·외부 로드밸런서는 변경하지 않았습니다.
- 위 터널의 서버 검증은 성공했지만 앱 내 브라우저는 자체 서명 인증서를
  `ERR_CERT_AUTHORITY_INVALID`로 차단했습니다. 이를 브라우저 접속 완료로 기록하지 않습니다.
- 기존 CloudFront의 `/argocd/` → 내부 ALB → API Gateway → Argo HTTPS 경로를 실제 적용했습니다.
  관리자 IPv4와 Argo 전용 origin 비밀값을 검사하고, Gateway는 서버 인증서를 고정해 검증합니다.
  Service의 여러 포트를 하나의 targetPort에 연결하면 CNI PolicyEndpoint에 첫 포트만 반영되어
  차단되는 문제를 확인해 `8080 → 8080` 단일 TLS 포트로 정리했습니다.
- CloudFormation `UPDATE_COMPLETE`와 CloudFront `Deployed`, 공인 TLS 인증서 검증을 확인했습니다.
  앱 내 브라우저에서 [운영 주소](https://d1kn7p1kr532sh.cloudfront.net/argocd/)의 Argo 로그인 화면을
  직접 확인했고, 사용자 로그인 후 Applications 화면의 `govbiz-eks` 타일에 `Healthy / Synced`가
  표시되는 것까지 확인했습니다. 인증서 예외나 localhost 터널은 필요하지 않습니다.
- HTTPS HTML 200, 로그인 전 Application 조회 401, admin API 로그인 200과 로그인 후
  `govbiz-eks`의 `Synced / Healthy`, 리소스 트리 15개를 확인했습니다. 암호·토큰은 출력하거나 저장하지 않았습니다.
- 기존 Vercel Core health는 200, CloudFront 직접 `/api` health는 403으로 기존 API 접근 제한을 유지했습니다.
  배포된 LIVE Function 시험에서 비허용 IP가 보낸 위조 허용·Host 헤더가 제거되는 것을 확인했습니다.
  다른 공인 IP에서 전체 HTTPS 경로를 재접속한 결과로 확대해 해석하지 않습니다.
- 별도 ALB·프록시 Pod나 EC2를 수동으로 추가하지 않았습니다. 최종 확인 시에는 기존 Cluster Autoscaler가
  확장한 EC2 3대가 관측됐으므로 기본 2대로 복귀했다고 기록하지 않습니다.
  로그인·접근 제한·진단 절차는 [접속 안내](argocd-dashboard.md)를 따릅니다.

## 최초 인계 순서

기존 두 노드에 자동 확장을 적용할 때는 [자동 확장 안내](autoscaling/README.md)를 먼저 따른다.
Core·AI는 HPA가 replica 수를 관리하므로 Application의 해당 두 Deployment에만
`/spec/replicas` 무시와 `RespectIgnoreDifferences=true`를 적용한다. 기존 비공개 patch의
노드 선택과 Core graceful shutdown 환경값도 함께 갱신한다. 자동 배포는 평가·DB의
단일 실행 조건과 정확한 이미지·소스·최종 준비 상태 검증을 계속 유지한다.

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
   문서 생성은 EKS values와 Core 보존 patch에서 `APPLICATION_DOCUMENT_JOBS_ENABLED=true`로
   명시합니다. 최초 인계 도구는 이 값만 활성화하고 다른 환경변수와 Secret 참조를 보존합니다.
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

## 문서 생성 비활성화 복구

`503 APPLICATION_DOCUMENT_GENERATION_UNAVAILABLE`는 Core가 작업 접수 전에 문서 생성 비활성화를
확인해 반환하는 오류입니다. 이 상태에서는 새 작업·파일이 생성되지 않습니다. 웹·모바일은 같은
Core 생성 서비스를 사용하므로 APK 재설치나 모바일 API 주소 변경으로 해결되지 않습니다.
기존 Core 환경변수 배열이 Application의 비공개 Kustomize patch에 보존되어 있으면 새 이미지나
Helm values만 변경해도 `false`가 계속 적용될 수 있습니다.

운영 담당자는 먼저 현재 Application의 배포 대상 커밋·필수 CI·이미지와 진행 중인 동기화가 없는지
확인합니다. 다음 명령은 현재 Application을 읽어 **문서 생성 플래그만 바꾸는 merge patch 파일**을
준비합니다. 다른 환경변수·Secret 참조·이미지·명령·PVC·노드 배치·배포 revision은 변경하지 않으며,
도구 자체는 클러스터에 접근하거나 적용하지 않습니다. 출력에는 기존 비공개 설정이 포함되므로
Git·이슈·CI artifact에 올리지 않습니다.

```sh
umask 077
# 실제 운영 전용 kubeconfig 경로를 지정한다. 다른 클러스터에 적용하지 않는다.
GOVBIZ_EKS_KUBECONFIG=/path/to/eks-kubeconfig
kubectl --kubeconfig "$GOVBIZ_EKS_KUBECONFIG" config current-context
mkdir -p .data/document-jobs
kubectl --kubeconfig "$GOVBIZ_EKS_KUBECONFIG" -n argocd get application govbiz-eks -o json \
  > .data/document-jobs/application.json
python -B infrastructure/eks/gitops.py enable-document-jobs \
  --application .data/document-jobs/application.json --output .data/document-jobs/enable.patch.json
```

검토한 patch를 관리자 권한으로 적용하면 기존 Argo 자동 동기화가 Core 설정을 반영합니다.
읽은 뒤 Application이 바뀌면 `resourceVersion` 충돌로 적용을 거절하므로 새로 조회해 준비합니다.
이 절차를 위해 CodeBuild에 쓰기 권한을 추가하지 않습니다.

```sh
kubectl --kubeconfig "$GOVBIZ_EKS_KUBECONFIG" -n argocd patch application govbiz-eks \
  --type merge --patch-file .data/document-jobs/enable.patch.json
kubectl --kubeconfig "$GOVBIZ_EKS_KUBECONFIG" -n govbiz-msa rollout status deployment/core-service --timeout=300s
kubectl --kubeconfig "$GOVBIZ_EKS_KUBECONFIG" -n govbiz-msa get deployment core-service \
  -o 'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="APPLICATION_DOCUMENT_JOBS_ENABLED")].value}'
```

최종 값이 `true`이고 Argo의 해당 revision 동기화·Core 교체가 끝났는지 확인합니다. 기존 작업은
worker의 만료 규칙으로 정리되는지 확인하고 DB에서 임의 삭제하지 않습니다. 승인된 QA 작성본으로
접수 202 → 실행 → 완료/명시적인 실패 → 파일 다운로드·실제 열기까지 별도 확인합니다. 설정·Pod
Ready만으로 실제 파일 생성 성공을 선언하지 않습니다. 배포 preflight와 완료 확인도 비공개 Core
patch와 실제 Deployment의 생성 활성화 값을 대조하며 비활성화 상태를 성공으로 처리하지 않습니다.

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
PyPI 연결 실패로 당시 로컬에서 완료하지 못했습니다. 이후 위 배포 SHA의 필수 CI 5개가 모두 성공해
잠금 환경·MySQL 8.4·컨테이너 전체 검증을 확인했습니다.
추가로 실행된 기존 EKS 백업 테스트 1건은 macOS `tar`가 `--sparse`를 지원하지 않아 실패했습니다.
해당 코드와 테스트는 변경하지 않았고 Linux Infra CI의 검증을 유지합니다.

[Argo 태그 추적](https://argo-cd.readthedocs.io/en/stable/user-guide/tracking_strategies/) ·
[동기화 단계](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/)
