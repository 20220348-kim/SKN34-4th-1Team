# EKS 배포와 데이터 이전

현재 **Vercel 웹 + Mac의 직접 배포 백엔드 → 시드니 EKS 2노드** 경로는
[시드니 시연 배포](sydney-demo.md)를 따른다. 이 경로는 Argo CD 설치를 전제로 하지 않으며,
`cluster.sydney-demo.yaml`과 `capture --source-mode manifests`를 사용한다.
`prepare --vercel-origin https://govbiz.vercel.app`으로 웹 Pod·Service를 목적지에서 제외하고
Core·Ops의 웹 주소를 설정한다. 2026-10-12 활성 PVC 13개를 복원하고 백엔드·저장소·평가 도구
20개와 API 게이트웨이를 기동했다. Vercel 운영 웹에서 Core·Ops API 응답과 익명 접근 차단을 확인했다.
개인 저장소 `ilil1/SKN34-4th-1Team` main의 필수 CI 통과 후 ECR·EKS·Vercel을 갱신하는 코드와
[Vercel 최초 설정·자동 배포 연결 절차](continuous-deployment.md)를 준비했다.
[CloudFront·내부 ALB·Core/Ops 프록시](api-entrypoint.md)는 실제 AWS에 적용했다.
GitHub OIDC 제한에 대응해 자동 배포 코드를 **CodeConnections·CodeBuild 임시 Actions 실행기**로
전환했다. 연결 승인·main 반영·최초 자동 실행 검증이 끝나기 전까지 운영은 수동 배포 상태다.

아래는 **다른 원본 클러스터의 기존 Argo CD 이전 절차와 기록**이다. 아래의 PVC 14개·Argo 앱
9개·`work/eks-handoff-20261011-final` 기록을 현재 Mac의 백업 완료 증거로 사용하지 않는다.

## 기존 Argo CD 환경에서 다른 PC로 전달

2026-10-11 결정: **현재 PC에서는 이전 준비까지 마치고 AWS 생성·배포는 다른 PC에서 한다.**
현재 계정·지원사업·평가 이력/보고서·Langfuse 데이터를 보존한다. 빈 데이터로 초기화하지 않는다.
로컬 Kubernetes에는 웹을 포함한 21개 workload가 있고 앱은 9개 Argo Application으로 관리한다.
[웹 실배포 기록](../gitops/docs/web-kubernetes.md#2026-10-11-배포-확인)을 참고한다.

## 전달물과 완료 경계

| 전달물 | 내용 |
| --- | --- |
| 이 저장소와 `handoff-tools.zip` | Chart와 배포 이력은 저장소에서 받으며, ZIP에는 백업 준비 시점의 도구·설정·문서도 포함 |
| 비공개 bundle 디렉터리 | `configuration.enc`, `summary.json`, 백업 완료 후 `backup.enc`, `backup-completed.json`, `volumes/` |
| 별도 경로의 `key` | 무작위 암호화 키. bundle과 분리해 전달하고 Git·채팅에 넣지 않음 |
| `elasticsearch.oci.tar`와 SHA-256 | 현재 Nori 검색 이미지. 새 PC에서 레지스트리로 발행할 원본 |
| 기존 웹 이미지 receipt | `web.json`, 배포 이미지 digest와 소스 SHA |
| `SHA256SUMS` | 키를 제외한 전달 파일의 전송 무결성 확인용 목록 |

`configuration.enc`에는 앱이 참조하는 Secret이 들어 있다. kubeconfig·서비스 계정 토큰·
AWS 인증·Argo 자격 증명은 포함하지 않는다. 복호화 결과 전체를 비공개로 다룬다.
키 분실 시 복원할 수 없다. Windows 출력 디렉터리는 현재 사용자만 접근하도록 ACL을 설정한다.
`summary.json`은 구성 수집 기록이다. `backup.enc`가 없으면 데이터 백업이 끝난 것이 아니다.

백업은 한 시점의 사본이다. 로컬 재개 이후의 변경도 AWS로 옮기려면 최종 전환 직전에 같은
절차로 새 백업을 만들고 새 빈 PVC에 복원한다. 원본 Compose 볼륨과 로컬 PVC는 유지한다.

## 2026-10-11 기존 Argo CD 원본의 준비 완료 기록

- 완료본: `work/eks-handoff-20261011-final/`. 키는 별도
  `work/eks-handoff-keys-20261011-final/key`에 있고 완료본에 포함하지 않았다.
- 03:30 KST에 활성 PVC 14개의 냉간 백업을 완료했다. 압축 archive 합계는 757,377,074 bytes,
  암호화된 구성·데이터는 약 1.01GB다. 별도 보관한 Elasticsearch OCI 이미지는 927,691,264 bytes다.
- 14개 모두 새 임시 Docker 볼륨에 복원하고 `tar --diff`로 파일 내용·권한·소유권을 대조했다.
  임시 볼륨은 제거했고 원본 볼륨을 변경하거나 DB 서버를 복원본으로 기동하지 않았다.
- 21개 workload의 원래 replica와 평가 접수를 복구했다. 9개 Argo 앱은 모두 Synced/Healthy다.
- 실제 웹에서 관리자 비밀번호 로그인·로그아웃/세션 폐기, 평가 이력 12건·보고서 4개 해시,
  공고 1,223건을 확인했다. 웹 `18173`, Langfuse `13000`, 개발 화면 `5173` 접속을 복구했다.
- 실제 배포 중인 9개 Git SHA의 EKS 변환 값을 Helm으로 오프라인 렌더링했다.
  EBS 복원·AWS 네트워크·실제 EKS 기동은 아직 실행하지 않았다.

완료본의 `handoff.json`, `isolated-restore.json`, `resumed-*.json`, `offline-render.json`을 참고한다.
이번 도구 변경의 전체 CI 결과는 `skn-437` 최신 커밋의 Actions에서 확인한다. 로컬에서는 관련 테스트,
기존 암호화 테스트, 설정 구문과 문서 경로를 확인했다. 이전 실패 시도의 디렉터리는 완료본이 아니다.

## 현재 PC: 구성 수집과 냉간 백업

Python 3.12+, kubectl, OpenSSL을 사용한다. Windows에서는 Git for Windows의 OpenSSL을 쓴다.
기존 `ops_snapshot.py`의 AES-256-CBC/PBKDF2 + HMAC 형식을 재사용하며 별도 백업 서버는 없다.

```powershell
$tool = 'infrastructure/gitops/scripts/eks_handoff.py'
$sourceKube = '<현재 클러스터의 기존 kubeconfig 경로>'
$bundle = 'work/eks-handoff-YYYYMMDD'
$key = 'work/eks-handoff-keys-YYYYMMDD/key'
python $tool capture --kubeconfig $sourceKube --output $bundle --key-file $key
```

`capture`는 읽기 전용이다. 현재 Pod가 참조하는 PVC와 수집 영수증을 선택하고 과거 `*-stage2`
저장소는 제외한다. 현재 14개다. 매번 새로운 bundle·key 디렉터리를 사용한다.
도구가 서비스를 임의로 중지하거나 재개하지 않으므로 운영자는 다음 순서로 실행한다.

1. 일시 중단 승인을 확인한다. 원래 replica와 Argo spec을 보존하고 자동 sync가 꺼졌는지 확인한다.
   Ops 평가 접수를 일시 중지하고 실행 중인 평가·예약이 없는지 기존 Ops 도구로 확인한다.
2. 업무 namespace 3개의 Deployment를 중지한다. writer 종료 후 StatefulSet을 정상 종료한다.
   강제 종료하지 않는다. 실행 중인 Job·CronJob이 있으면 먼저 해결한다.
3. 아래 명령을 실행한다. 임시 Pod가 원본을 읽기 전용으로 마운트해 sparse tar+gzip 스트림을 16MiB 조각으로
   암호화한다. UID/GID·권한·심볼릭 링크·하드 링크와 archive 해시를 보존한다.
4. 성공·실패 모두 임시 Pod 종료를 확인하고 StatefulSet → Deployment 순서로 원래 replica를
   복구한다. 저장소 Ready 이후 writer를 켜고 평가 접수를 원래 상태로 되돌린다.
   기존 관리자 로그인·공고/평가 이력·보고서를 확인한다. 실패한 백업은 완료본으로 넘기지 않는다.

```powershell
python $tool backup --kubeconfig $sourceKube --node '<현재 노드 hostname>' --bundle $bundle --key-file $key
```

Elasticsearch는 로컬 이미지이므로 실행 중인 이미지 자체도 보관한다. 현재 kind 환경 예시:

```powershell
docker exec govbiz-f218b0ac1c-control-plane ctr -n k8s.io images export --platform linux/amd64 /tmp/govbiz-eks-elasticsearch-20261011.tar docker.io/library/govbiz-elasticsearch:msa-20260921-wsl-source-01
docker cp govbiz-f218b0ac1c-control-plane:/tmp/govbiz-eks-elasticsearch-20261011.tar "$bundle/elasticsearch.oci.tar"
Get-FileHash "$bundle/elasticsearch.oci.tar" -Algorithm SHA256
```

## 다른 PC: AWS 입력 확정

저장소를 받은 뒤 bundle을 비공개 경로에 복사하고 키는 별도 경로에 전달한다. 아직 이번 변경을
커밋하지 않았다면 `handoff-tools.zip`을 새 PC의 저장소 루트에 풀어 도구와 이 문서를 반영한다.
새 PC에 Python 3.12+, kubectl, OpenSSL(Windows는 Git for Windows), AWS CLI v2, eksctl,
Docker 또는 OCI archive를 읽을 수 있는 도구를 준비한다. 새 터미널의 경로를 먼저 지정한다.

```powershell
$tool = 'infrastructure/gitops/scripts/eks_handoff.py'
$bundle = '<비공개 경로>/eks-handoff-20261011-final'
$key = '<별도 비공개 경로>/key'
# Linux/macOS에서는 키와 출력 디렉터리 권한을 각각 600, 700으로 제한한다.
```

`cluster.example.yaml`은 미적용 제안이다. 계정·리전·지원 버전·관리자 IP·quota·비용은 새 PC에서
확정한다. 예시 CIDR `203.0.113.1/32`와 버전 placeholder를 바꾼 작업 사본으로만 실행한다.
로컬 kind 버전을 EKS 지원 버전으로 가정하지 않는다.

- 서울 두 AZ의 새 VPC, private 관리형 노드 `m6i.xlarge` 1대, NAT Gateway 1개를 제안한다.
  단일 노드·단일 AZ 데이터 배치이며 HA가 아니다. 노드 자원은 실제 사용량에 맞춰 확정한다.
- 기존 물리 DB 파일과 이미지를 그대로 복원하므로 첫 이전에서 ARM 전환·DB 업그레이드를 함께 하지 않는다.
- 노드 시작 명령은 Elasticsearch에 필요한 `vm.max_map_count=1048576`을 영구 설정한다.
  노드 교체 시에도 같은 설정을 사용하고, 첫 복원 전에 적용 결과를 확인한다.
- Pod Identity·EBS CSI 권한과 VPC CNI NetworkPolicy 활성화를 확인한다.
- `storage-class.yaml`은 일반 관리형 노드용 `ebs.csi.aws.com`, 암호화 gp3, Retain,
  WaitForFirstConsumer다. EKS Auto Mode의 다른 provisioner와 혼용하지 않는다.
- 복원 기본 요청은 PVC 14개 총 **180GiB**다. 각 10GiB, ClickHouse·MinIO 각 30GiB이며
  원본 요청이 더 크면 큰 값을 유지한다. 실제 백업 크기와 증가량에 맞춰 상향한다.
- EKS·EC2·NAT·IPv4·EBS·로그·전송 비용을 생성 전에 확인한다. Retain EBS는 클러스터 삭제 후에도 남는다.

```powershell
aws sts get-caller-identity --profile govbiz-eks
aws eks describe-cluster-versions --region ap-northeast-2 --profile govbiz-eks
# 지원 버전·계정·비용을 확정한 private 작업 파일 사용:
$env:AWS_PROFILE = 'govbiz-eks'
eksctl create cluster --config-file infrastructure/gitops/.local/eks/cluster.yaml --dry-run
eksctl create cluster --config-file infrastructure/gitops/.local/eks/cluster.yaml --profile govbiz-eks --kubeconfig infrastructure/gitops/.local/eks/kubeconfig
```

## 다른 PC: 이미지와 복원 입력

기존 공개 GHCR 앱 이미지는 재빌드하지 않고 수집한 digest를 사용한다. Elasticsearch만 전달받은
OCI archive를 `docker load --input ...`으로 읽고 새 계정의 레지스트리에 tag/push한다.
push 결과 digest를 기록한다. OCI load를 지원하지 않는 Docker에서는 containerd/nerdctl을 사용한다.
한글 분석 플러그인이 들어간 이미지를 일반 Elasticsearch로 바꾸지 않는다.
개인 registry 로그인은 새 PC에서 수행한다. 이 PC의 Docker·AWS·GitHub 자격 증명은 전달하지 않는다.

```powershell
$targetKube = 'infrastructure/gitops/.local/eks/kubeconfig'
kubectl --kubeconfig $targetKube config current-context
kubectl --kubeconfig $targetKube get nodes -o wide
$node = '<EKS 노드의 kubernetes.io/hostname 값>'
$rendered = 'infrastructure/gitops/.local/eks/restored'
python $tool prepare --bundle $bundle --key-file $key --node $node --elasticsearch-image '<registry/name@sha256:발행_digest>' --output $rendered
```

`prepare`는 오프라인 변환이며 적용하지 않는다. PVC 이름을 유지하되 원본 PV 바인딩을 제거한다.
업무 저장소 7개는 replica 0·기존 PVC 참조·Retain 정책·digest 고정으로 내보낸다.
`govbiz-local-data`의 폐기 가능 데이터 guard를 우회하거나 해당 Chart로 EKS DB를 초기화하지 않는다.
앱은 이미 배포된 9개 Application의 동일 SHA와 기존 Chart를 재사용한다. 로컬 hostname과
kubeVersion override를 제거·교체하고 자동 sync·prune를 끈다. 개발 로그인은 비활성화하고
Core CORS·Ops 웹 주소는 `http://localhost:18173`으로 맞춘다.

## 다른 PC: 빈 EBS에 복원한 뒤 시작

전용 kubeconfig가 새 EKS ARN인지 먼저 확인한다. PVC만 생성하고 Argo 앱은 아직 등록하지 않는다.
WaitForFirstConsumer PVC는 복원 Pod가 생길 때 바인딩된다. 도구는 nodeName 대신 nodeSelector를 쓴다.

```powershell
kubectl --kubeconfig $targetKube apply -f "$rendered/00-namespaces.json"
kubectl --kubeconfig $targetKube apply -f infrastructure/eks/storage-class.yaml
kubectl --kubeconfig $targetKube create -f "$rendered/10-claims.json"
python $tool restore --kubeconfig $targetKube --node $node --bundle $bundle --key-file $key
```

복원은 원본 namespace UID·살아 있는 writer·기존 데이터가 있는 PVC를 거절한다. 각 archive 전체를
인증한 다음 쓴다. 중간 실패 시 앱을 켜지 않고 새 빈 대상 PVC에서 다시 시작한다. 원본·백업은 유지한다.

```powershell
# Secret 포함: 내용 출력·Git 등록 금지.
kubectl --kubeconfig $targetKube create -f "$rendered/20-private-dependencies.json"
kubectl --kubeconfig $targetKube apply -f "$rendered/30-data-stopped.json"
kubectl --kubeconfig $targetKube -n govbiz-msa scale statefulset --all --replicas=1
kubectl --kubeconfig $targetKube -n govbiz-msa get statefulsets,pods,pvc
```

업무 저장소 7개 Ready 이후 Argo CD를 준비한다. 현재 배포와 같은 Core 3.5.3은 웹 서버 없는
구성이므로 Kubernetes API로 수동 sync한다. 로컬 `fork_cluster.py`를 EKS에 실행하지 않는다.
기존 `gitops_msa.py`에 고정한 배포물과 checksum을 재사용한다.

```powershell
$argoManifest = 'infrastructure/gitops/.local/eks/argocd-core-install.yaml'
Invoke-WebRequest 'https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.3/manifests/core-install.yaml' -OutFile $argoManifest
if ((Get-FileHash $argoManifest -Algorithm SHA256).Hash.ToLower() -ne '1a87025d8eb2eae621653fd312fb9ca51df1b4b3b6992a030e3a9ef38e45c448') { throw 'Argo install checksum mismatch' }
kubectl --kubeconfig $targetKube create namespace argocd
kubectl --kubeconfig $targetKube -n argocd apply --server-side -f $argoManifest
kubectl --kubeconfig $targetKube apply -f infrastructure/eks/argocd-config.yaml
```

`argocd-cm`의 `application.resourceTrackingMethod=annotation`,
`application.instanceLabelKey=argocd.argoproj.io/instance`를 설정하고 컨트롤러·repo-server·Redis가
준비된 뒤 다음 자원을 등록한다. 이 설정은 기존 Helm selector 라벨과 Argo 추적을 분리한다.

```powershell
kubectl --kubeconfig $targetKube apply -f "$rendered/40-projects.json"
kubectl --kubeconfig $targetKube apply -f "$rendered/50-applications.json"
```

다음 순서로 하나씩 sync하고 각 Application이 Synced/Healthy인지 확인한다.

1. `govbiz-observability`: DB·큐·객체 저장소와 웹/worker. 기존 복원 init 검사·probe를 유지한다.
2. `govbiz-evaluation-prefect`, `govbiz-evaluation-ops-artifacts`.
3. `govbiz-fork-ai-service`, `govbiz-fork-catalog-service`, `govbiz-fork-core-service`, `govbiz-fork-ops-service`.
   Ops PreSync migration은 동일 기존 이미지·복원 DB에 적용하며 버전 업그레이드를 함께 하지 않는다.
4. `govbiz-evaluation-evaluation-runner`, `govbiz-fork-web`.

예시의 Application 이름을 위 순서에 맞춰 바꾼다. [공식 Kubernetes API 동기화 방식](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-kubectl/)을 사용한다.

```powershell
$application = 'govbiz-observability'
$app = kubectl --kubeconfig $targetKube -n argocd get application $application -o json | ConvertFrom-Json
if ($app.operation) { throw '진행 중인 동기화가 있습니다.' }
$operation = @{operation=@{sync=@{revision=$app.spec.source.targetRevision; prune=$false; syncStrategy=@{apply=@{force=$false}}}; retry=@{limit=0}}}
$operation | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 infrastructure/gitops/.local/eks/sync.json
kubectl --kubeconfig $targetKube -n argocd patch application $application --type merge --patch-file infrastructure/gitops/.local/eks/sync.json
kubectl --kubeconfig $targetKube -n argocd get applications
```

냉간 백업의 Ops DB에는 유지보수용 접수 중지 상태가 포함된다. 모든 저장소·실행기가 준비된 뒤
`kubectl --kubeconfig $targetKube -n govbiz-msa exec deployment/ops-service -c ops-service -- python manage.py evaluation_admission status`
로 현재 version을 읽는다. 기존 `evaluation_admission resume --expected-version <version>
--request-id <새 UUID> --actor <운영자> --reason <복원 완료 사유>` 명령으로 새 환경의 접수를 재개한다.
원본에서 원래 중지 상태였던 접수를 임의로 켜지 않는다. 원래 상태는 비공개 유지보수 기록을 확인한다.

```powershell
kubectl --kubeconfig $targetKube -n govbiz-msa port-forward --address 127.0.0.1 service/web 18173:8080
kubectl --kubeconfig $targetKube -n govbiz-observability port-forward --address 127.0.0.1 service/langfuse-web 13000:3000
```

기존 관리자 계정의 일반 비밀번호 로그인, Core/Ops 동일 사용자, 공고 조회, 평가 이력·보고서 보존,
무료 평가 완료·Langfuse 기록, 로그아웃 후 401을 확인한다. OpenAI는 현재 로컬과 동일하게 비활성
입력을 유지한다. 유료 API 키 활성화·실제 품질 평가는 별도다.

업무 저장소/PVC/Secret은 명시적 bootstrap 자원이고 앱 9개만 Argo 소유다. 저장소 manifest를
향후 GitOps로 인계할 때 Secret을 제외하고 새 환경 경로에 저장하며 PV/PVC/Secret의 자동 prune 없이
소유권을 넘긴다. 노드 교체 시 hostname 변경과 EBS 재부착을 확인해야 한다.
실제 EBS 복원·네트워크 집행·로그인·장애 복구는 다른 PC의 EKS에서 확인한다.
외부 ALB/Ingress·도메인·TLS·HA·정기 원격 백업은 첫 loopback 접속 이후 운영 작업이다.

## 검증 위치

`python -B -m unittest discover -s infrastructure/gitops/scripts -p test_eks_handoff.py`는 암호화
조각 왕복·손상 시 쓰기 차단·원본 복원 거절·영속 설정 변환을 확인한다.
기존 Infra CI의 `scripts/test_*.py` 탐색에 포함된다. 전체 CI 완료는 이 변경을 푸시한 SHA에서 확인한다.

## 근거

- [EKS EBS CSI](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html)
- [eksctl AL2023 시작 명령 구현](https://github.com/eksctl-io/eksctl/blob/main/pkg/nodebootstrap/al2023.go)
- [StorageClass와 WaitForFirstConsumer](https://kubernetes.io/docs/concepts/storage/storage-classes/)
- [EKS VPC·서브넷 요구사항](https://docs.aws.amazon.com/eks/latest/userguide/network-reqs.html)
