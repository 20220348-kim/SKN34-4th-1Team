# EKS Argo CD 대시보드

[자동 배포와 Argo 배치](argo-cd.md) · [설치 리소스](argocd-dashboard.yaml)

기존 Argo CD Core 3.5.3에 같은 버전의 `argocd-server`를 추가한다.
동기화 엔진 4개와 대시보드 서버 1개를 합쳐 `argocd` Namespace의 Pod는 5개다.
대시보드는 EKS에서 계속 실행하고, 관리자는 허용된 IPv4에서 CloudFront의 HTTPS 주소로 접속한다.
로컬 kind의 Core 설치는 변경하지 않는다.

운영 접속 주소: **[Argo CD 열기](https://d1kn7p1kr532sh.cloudfront.net/argocd/)**.
2026-10-13 운영 적용 후 앱 내 브라우저의 로그인 화면·로그인 후 Applications 화면과 관리자 API 로그인을 확인했다.
상세 결과는 [운영 기록](argo-cd.md#2026-10-13-운영-대시보드-추가)을 따른다.

## 구성과 관리 범위

- `argocd-server`는 observability 노드에 1개 실행한다. CPU 요청 50m·제한 500m,
  메모리 요청 128Mi·제한 384Mi다. 좁은 예약 공간에서 대시보드 교체가 멈추지 않도록
  `maxSurge: 0`, `maxUnavailable: 1`을 사용한다. 교체 중에는 대시보드만 잠시 중단된다.
- 기존 controller·repo-server·Redis·ApplicationSet controller를 재설치하지 않는다.
  자동 동기화의 Application, 이미지, Git revision과 기존 자원 설정을 유지한다.
- Gateway는 ClusterIP Service의 단일 `https:8080`을 Pod의 `8080`에 연결하며 TLS와 로그인을 사용한다.
  EKS VPC CNI NetworkPolicy의 Service·컨테이너 포트 일치 조건을 지키기 위한 내부 포트다.
  실제 연결 시험에서는 Service의 `80`·`443`·`8080`이 모두 같은 Pod `8080`을 가리킬 때
  CNI PolicyEndpoint에 Service IP의 첫 포트 `80`만 생성되어 `8080` 연결까지 차단됐다.
  따라서 포트를 추가하는 방식 대신 Service를 `8080 → 8080` 단일 포트로 정리한다.
  기존 CloudFront·내부 ALB·API Gateway의 `/argocd/` 경로를 사용한다. 별도 EC2·ALB·프록시 Pod는 추가하지 않는다.
- CloudFront Function은 요청자가 보낸 접근 허용·Argo 전달 Host 헤더를 지우고, 등록한 관리자 IPv4와
  실제 접속 IP가 같을 때만 허용 표식과 원래 요청 Host를 추가한다. Gateway는 이 표식과 Argo 전용 origin
  비밀값을 모두 검사한다. 기존 Vercel API 프록시 비밀값과 혼용하지 않는다.
- 서버의 NetworkPolicy는 `govbiz-msa` Namespace의 `api-gateway` Pod에서 오는 `8080`만
  허용한다. Gateway는 Argo의 TLS 인증서를 고정해 검증하며 `--rootpath=/argocd` 경로를 유지한다.
- IP 제한을 통과한 뒤에도 Argo의 `admin` 로그인이 필요하다. 이 계정은 관리 권한을
  가지므로 조회 전용 계정으로 취급하지 않는다. 자동 배포 확인만 할 때는 Sync·Delete 등
  변경 작업을 누를 필요가 없다.
- `argocd-server`의 RBAC는 고정 버전 공식 설치 정의를 사용한다. 기존 공유 ConfigMap과
  Secret을 설치 YAML에 포함하지 않는다. 처음 기동할 때 없는 관리자 암호·서명 키·TLS
  설정은 Argo가 생성하고 기존 값은 보존한다.

## 설치

EKS `govbiz-eks`(`ap-southeast-2`)에 접근할 수 있는 AWS 세션과 전용 kubeconfig를 사용한다.
먼저 기존 Argo 버전과 observability 노드의 예약 여유를 확인한다. `argocd-cm`의
`users.anonymous.enabled`가 없거나 `false`여야 하고, `admin.enabled`는 없거나 `true`여야 한다.
기존에 다른 인증 구성을 사용하는 클러스터에는 이 절차를 그대로 적용하지 않는다.

```powershell
$targetKube = '<운영 EKS kubeconfig 경로>'
kubectl --kubeconfig $targetKube config current-context
kubectl --kubeconfig $targetKube -n argocd get applications,pods
kubectl --kubeconfig $targetKube apply --dry-run=server -f infrastructure/eks/argocd-dashboard.yaml
kubectl --kubeconfig $targetKube apply -f infrastructure/eks/argocd-dashboard.yaml
kubectl --kubeconfig $targetKube -n argocd rollout status deployment/argocd-server --timeout=180s
```

`argocd-secret`, `argocd-redis`와 기존 Core의 ConfigMap이 선행 조건이다.
전체 `install.yaml`을 덮어 적용하거나 기존 Secret을 초기화하지 않는다.
최초 웹 서버 기동은 기본 `AppProject/default`를 만들 수 있지만, 기존 `govbiz-eks` 프로젝트와
Application의 관리 범위를 바꾸지 않는다.

## 운영 화면 열기

[운영 HTTPS 주소](https://d1kn7p1kr532sh.cloudfront.net/argocd/)를 연다.
브라우저는 AWS가 제공하는 CloudFront 인증서를 확인하므로 자체 서명 인증서 예외나 PC 터널이 필요하지 않다.
등록된 관리자 IPv4 외에서는 `403`으로 차단된다. 접속 장소·공인 IP가 바뀌면 허용 주소를 먼저 갱신해야 한다.

```text
관리자 브라우저 → CloudFront HTTPS /argocd/ (관리자 IPv4 확인)
  → 기존 내부 ALB → api-gateway (Argo 전용 비밀값 + 허용 표식 검사)
  → HTTPS argocd-server:8080 (고정한 서버 인증서 검증) → admin 로그인
```

아이디는 `admin`이다. 최초 암호는 Kubernetes Secret에서 확인한다. 아래 명령은 암호를
터미널이나 파일에 출력하지 않고 Windows 클립보드로 복사한다.

```powershell
$encodedPassword = kubectl --kubeconfig $targetKube -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}'
if ($LASTEXITCODE -ne 0) { throw '초기 암호 조회 실패: 기존 관리자 암호를 확인하세요.' }
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPassword)) | Set-Clipboard
Remove-Variable encodedPassword
```

로그인 후 User Info에서 암호를 변경할 수 있다. 변경된 암호로 다시 로그인되는 것을 확인한
뒤 `argocd-initial-admin-secret`을 삭제한다. 기존 admin 암호가 이미 있으면 최초 Secret이
생성되지 않을 수 있으므로 임의로 암호를 초기화하지 않는다. 암호와 로그인 토큰은 Git·이슈에
기록하지 않는다.

Application 목록의 `govbiz-eks`를 열면 배포 revision, `Synced / Healthy` 상태와 관리 중인
업무·평가 앱의 리소스 관계를 볼 수 있다. 클러스터의 모든 저장소·관측 도구가 이 Application에
포함되는 것은 아니다.

## HTTPS 경로 적용과 유지 관리

1. `govbiz-msa/argocd-dashboard-proxy` Secret에 `origin-secret`과 `tls.crt`를 준비한다.
   전자는 별도 생성한 64자리 lowercase hex 비밀값이고, 후자는 현재 `argocd-secret`의 공개 서버 인증서다.
   비밀값을 명령 인자·Git·로그에 남기지 않는다. Secret이 없는 환경에서는 Argo 경로만 `403`이고 기존 API는 동작한다.
2. [Gateway 구성](api-gateway/kustomization.yaml)과 위 대시보드 매니페스트를 적용한다.
   기존 `/api` 프록시 인증과 Core·Ops 라우팅은 유지한다.
3. 기존 `govbiz-api-edge` 스택을 [CloudFront 템플릿](api-cloudfront.yaml)으로 갱신한다.
   `ArgoAllowedIpv4`에는 CIDR 없는 관리자 IPv4 하나를, `ArgoOriginSecret`에는 Secret과 같은 값을 전달한다.
   `ArgoOriginSecret`은 `NoEcho` 파라미터다. 기존 ALB 파라미터는 유지한다.
4. CloudFront 배포가 완료되면 허용 IP의 HTML·정적 파일·로그인·Application 조회,
   비로그인 API 거절과 비허용 IP 거절을 확인한다. 기존 Vercel API도 확인한다.

Argo 서버 인증서 교체 시 Gateway Secret의 `tls.crt`도 갱신해야 한다. 인증서 검증을 끄지 않는다.
비밀값 교체는 CloudFront origin과 Gateway 양쪽을 함께 갱신하며, 불일치 동안 Argo 요청은 거절된다.
Web UI의 배포 조회·로그인 경로를 대상으로 한다. CloudFront VPC origin은 gRPC를 지원하지 않으며,
WebSocket을 사용하는 기능은 이번 접속 검증 범위에 포함하지 않는다.

## 진단용 로컬 터널

Kubernetes 접근 권한이 있는 관리자는 네트워크 경로를 분리해 진단할 때만 아래 터널을 사용할 수 있다.

```powershell
kubectl --kubeconfig $targetKube -n argocd port-forward --address 127.0.0.1 service/argocd-server 18443:8080
```

진단 주소는 `https://localhost:18443/argocd/`이며 서버는 AWS EKS에 있다.
이 경로에는 Argo 자체 서명 인증서가 보이므로 앱 내 브라우저가 `ERR_CERT_AUTHORITY_INVALID`로 차단할 수 있다.
터널이 열렸다는 사실만으로 브라우저 접속 성공을 뜻하지 않는다. 평소에는 위 CloudFront 주소를 사용한다.

## 설치 확인과 되돌리기

확인은 서버 Ready·HTTPS 응답, 비로그인 Application 조회 거절, 로그인 후 `govbiz-eks` 조회,
기존 4개 Pod의 UID·재시작 횟수와 Application 설정 보존으로 구분한다.
매니페스트 검사 통과만으로 운영 설치 완료를 판단하지 않는다.

HTTPS 경로를 중지할 때는 CloudFront의 `ArgoAllowedIpv4`를 비워 Gateway 허용 표식 발행을 먼저 중지한다.
서버까지 제거하려면 다음 명령을 사용한다. 동기화 엔진·Application·공유 Secret은 남는다.

```powershell
kubectl --kubeconfig $targetKube delete -f infrastructure/eks/argocd-dashboard.yaml --ignore-not-found
```

공식 근거: [3.5.3 설치 정의](https://github.com/argoproj/argo-cd/blob/v3.5.3/manifests/install.yaml) ·
[TLS](https://argo-cd.readthedocs.io/en/stable/operator-manual/tls/) ·
[EKS VPC CNI NetworkPolicy의 포트 조건](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html) ·
[초기 로그인과 암호 변경](https://argo-cd.readthedocs.io/en/stable/getting_started/#4-log-in-using-the-cli).
