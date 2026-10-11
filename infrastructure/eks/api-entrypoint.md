# Vercel → CloudFront → EKS API 연결

이 구성은 시드니 시연의 **Vercel 웹에서 EKS Core·Ops API를 호출하는 경로**다.
2026-10-12 시드니 EKS에 실제 적용하고 `https://govbiz.vercel.app`과 연결했다.
운영 주소에서 Core·AI health, 저장 공고 조회, Ops session은 200이며 익명 평가 이력 조회는 401이다.
CloudFront 직접 API 요청은 프록시 비밀값 없이 403으로 차단된다. 관리자 로그인 후 검증은 별도다.
다른 환경에서 `kubectl apply -k api-gateway`를 실행하면 ALB를 생성하므로 비용 승인·복원 후 적용한다.

```text
govbiz.vercel.app /api/*
  → Vercel Production 미들웨어 (운영 origin·사용자 IP 확인, 공유 비밀값 추가)
  → HTTPS CloudFront (API·오류 캐시 없음, 인증·CSRF·쿠키·쿼리 전달)
  → CloudFront VPC origin → 내부 ALB:80
  → EKS api-gateway:8080 (비밀값 검증·전달 헤더 제한)
      ├─ /api/v1/ops, /api/v1/ops/* → ops-service:8000 → Core 관리자 세션 확인
      └─ 나머지 /api/* → core-service:8080
```

## 구성과 경계

- [`api-gateway/`](api-gateway/kustomization.yaml): 단일 Nginx Deployment, ClusterIP Service,
  내부 ALB Ingress, 프록시 전용 NetworkPolicy. 기존 DB·평가 실행기·PVC를 변경하지 않는다.
- [`api-cloudfront.yaml`](api-cloudfront.yaml): 이미 생성한 내부 ALB를 VPC origin으로 연결하는
  CloudFormation 템플릿. 웹 정적 파일이나 별도 도메인 인증서는 배포하지 않는다.
- AWS Load Balancer Controller가 추가로 필요하다. EKS 구성 자체에 포함되어 있지 않으며,
  별도의 전용 IAM 역할과 `kube-system` ServiceAccount로 설치해야 한다.
- 프록시 요청량은 25m CPU·32Mi 메모리, 한도는 200m·128Mi다. 기존 애플리케이션 노드에 배치한다.
  컨트롤러 자원·ALB·CloudFront 사용료는 기존 2노드 추정에 별도로 합산한다.
- Nginx는 non-root·읽기 전용 파일시스템으로 실행한다. 토큰을 마운트하지 않고 비밀값은
  `api-gateway-secret`의 `GOVBIZ_PROXY_SECRET`으로만 주입한다. 값은 Vercel Production과 같아야 한다.
- 사용자 요청의 프록시 헤더는 버린다. Vercel이 확인한 IP와 HTTPS 정보만 전달하며,
  Core의 현재 `server.forward-headers-strategy=none`을 임의로 사설망 전체 신뢰로 바꾸지 않는다.
  따라서 이 단계만으로 Core의 실제 클라이언트 IP 기반 제한까지 검증했다고 해석하지 않는다.
- 게이트웨이만 egress를 Core·Ops·DNS로 제한한다. 기존 Core·Ops 통신을 차단하는 새 ingress
  격리 정책은 추가하지 않는다. 기존 NetworkPolicy를 유지하며 목적지의 추가 제한은 따로 확인한다.
- Nginx 비동기 DNS resolver는 `resolv.conf`의 검색 도메인을 적용하지 않는다. Core·Ops를
  각각 `core-service.govbiz-msa.svc.cluster.local`, `ops-service.govbiz-msa.svc.cluster.local`로
  해석한다. Ops 요청의 Host도 전체 서비스 이름이므로 `DJANGO_ALLOWED_HOSTS`에
  `ops-service.govbiz-msa.svc.cluster.local`, `DJANGO_CSRF_TRUSTED_ORIGINS`에
  `https://govbiz.vercel.app`이 필요하다.
  Core·Ops 쿠키는 Secure 설정을 유지한다. Origin·CSRF 검증과 관리자 판정은 Django·Core가 수행한다.

## 실제 적용 전 준비

1. [시드니 이전](sydney-demo.md)의 클러스터·데이터 복원·내부 Core/Ops 검증을 완료한다.
   EKS에 VPC CNI NetworkPolicy가 켜져 있어야 하며, 원본 Pod의 서비스 이름·라벨을 유지한다.
2. [AWS 공식 설치 절차](https://docs.aws.amazon.com/eks/latest/userguide/lbc-helm.html)로
   AWS Load Balancer Controller를 설치한다. 설치 시 검증한 chart·이미지 버전을 고정하고,
   `clusterName=govbiz-eks`, `region=ap-southeast-2`, 실제 `vpcId`를 명시한다.
   노드 IMDS에 의존하지 않고 전용 IAM 역할을 사용한다. 컨트롤러와 webhook Ready를 확인한다.
3. 두 AZ의 private subnet에 ALB 탐색용 `kubernetes.io/role/internal-elb=1` 태그와 여유 IP를 확인한다.
   VPC origin은 IGW가 있는 VPC와 활성 상태의 내부 ALB가 필요하다. ALB의 외부 공개는 필요 없다.
4. 다음 읽기 전용 조회로 Sydney CloudFront prefix list를 확인한다.
   현재 Ingress의 `pl-b8a742d1`과 다르면 실제 조회값으로 교체한다. `inbound-cidrs`를 추가하지 않는다.
   CloudFront prefix list는 SG 규칙 quota를 많이 차지하므로 적용 전 사용 가능한 한도도 확인한다.

   ```sh
   aws ec2 describe-managed-prefix-lists --profile govbiz-eks --region ap-southeast-2 \
     --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
     --query 'PrefixLists[].{Id:PrefixListId,Name:PrefixListName}'
   ```

5. 로컬 비공개 파일에 64자리 lowercase hex 프록시 비밀값을 준비하고 같은 값을 Vercel에 등록한다.
   이미 사용하는 값이 있으면 재생성하지 않는다. 명령 인자·Git·로그에 값을 노출하지 않는다.
   전용 EKS kubeconfig를 명시해 `api-gateway-secret`을 생성한다. 이 값은 Vercel 배포용
   `VERCEL_TOKEN`과 서로 다른 용도다. 검증 완료 전 `GOVBIZ_OPS_PROXY_ENABLED=false`를 유지한다.

## 적용 순서

다음은 비용 승인 후 새 EKS에 적용하는 단계다. 현재 Mac 클러스터에 적용하지 않는다.

1. Secret이 준비된 EKS에서 게이트웨이를 적용하고 Pod Ready와 ALB target health를 확인한다.

   ```sh
   kubectl --kubeconfig .data/eks-kubeconfig apply -k infrastructure/eks/api-gateway
   kubectl --kubeconfig .data/eks-kubeconfig -n govbiz-msa rollout status deploy/api-gateway
   kubectl --kubeconfig .data/eks-kubeconfig -n govbiz-msa get ingress api-gateway
   ```

2. ALB가 `internal`, `active`이고 대상이 이 EKS의 게이트웨이인지 확인한다.
   [`api-cloudfront.yaml`](api-cloudfront.yaml)의 `AlbArn`·`AlbDnsName`에 **동일 ALB**의 값을 전달해
   CloudFormation 변경 세트를 검토하고 적용한다. 템플릿은 시드니 내부 ALB 형식만 받는다.
   CloudFront의 Origin 상태·Distribution 배포 완료와 ALB SG의 CloudFront 전용 허용을 확인한다.
3. 스택 출력 `ApiOrigin`을 Vercel **Production**의 `GOVBIZ_API_ORIGIN`에 등록한다.
   `GOVBIZ_FRONTEND_ORIGIN=https://govbiz.vercel.app`, 공유 `GOVBIZ_PROXY_SECRET`을 함께 확인한다.
4. 기본 Core 연결과 CloudFront 직접 API 접근의 403을 확인한다. 관리자 세션·CSRF 경로를
   확인할 준비가 되면 `GOVBIZ_OPS_PROXY_ENABLED=true`를 Production에만 설정해 재배포한다.
   토큰 값 없이 요청이 전달되거나 Preview에서 운영 API를 호출할 수 있으면 중단한다.
5. 관리자 로그인 → Ops session/이력/보고서 조회 → 일반 회원 접근 거절 → 로그아웃 후 차단을
   확인한다. 승인된 무료 쓰기 1건으로 CSRF 누락 거절·정상 요청 성공·기존 이력 보존을 검증한다.
   이 단계에서 모델 호출·스케줄을 활성화하지 않는다.
6. 전체 API 검증·최신 main CI 통과·CodeConnections/CodeBuild 연결 확인 후에만 [CD 활성화](continuous-deployment.md)를 진행한다.
   네트워크·CloudFront·게이트웨이 설정은 앱 이미지 교체용 CD가 자동 적용하지 않으며 별도 검토한다.

GitHub OIDC provider 조회가 제한되어 자동 배포 경로를 CodeConnections·CodeBuild 서비스 역할로
전환한다. 연결 승인과 첫 실행 검증 전에는 자동 배포를 비활성으로 유지한다.
이미 수동 배포한 ALB·CloudFront·서비스는 계속 실행된다.

## 제한 및 복구

- CloudFront 원본 대기는 120초, ALB idle timeout은 120초다. Nginx의 문서 생성 대기 600초만으로
  외부 경로의 600초 응답을 보장할 수 없다. 긴 동기 문서 생성은 실제 제한 내 완료되는지 확인하고,
  초과하면 작업 접수·상태 조회 형태로 변경하는 별도 개발이 필요하다. 실패 후 자동 유료 재호출은 하지 않는다.
- 응답·오류 캐시 TTL은 0이고 CloudFront 원본 연결 시도는 1회다. 이 설정이 처리 중인 작업의
  취소나 전체 경로의 exactly-once 실행을 보장하는 것은 아니다.
- 애플리케이션 4xx/5xx를 성공이나 HTML로 바꾸지 않는다. Ops 장애를 Core 응답으로 대체하지 않는다.
- 장애 시 Vercel Ops 활성화 값을 false로 되돌리고 재배포해 Ops 입구를 닫을 수 있다.
  EKS DB·PVC를 삭제하거나 기존 사용자 세션 비밀값을 바꾸어 복구하지 않는다.
- 제거할 때 CloudFront distribution/VPC origin 연결을 먼저 정리한 뒤 Ingress를 삭제한다.
  ALB·SG·ENI가 제거됐는지 확인하고, AWS Load Balancer Controller는 그 이후 정리한다.

## 검증

- `test_eks_api_gateway.py`: Kustomize 렌더링, 비밀값 참조, 내부 ALB, 네트워크 범위,
  CloudFront 캐시·재시도 정책을 검사한다.
- `frontend/web/middleware.test.ts`: Ops의 명시적 활성화, 운영 주소, 세션·CSRF 전달,
  비밀값 누락·Preview 차단을 검사한다.
- `python3 infrastructure/scripts/verify-production-proxy.py --eks-gateway`: 실제 Nginx와
  가상 Core/Ops를 격리 Docker 네트워크에서 실행해 경로·헤더·본문·쿠키·차단·장애를 검증한다.
  기존 서비스·볼륨과 실제 모델 API는 사용하지 않는다.
- Infra CI는 CloudFormation 구문, 렌더링·정책 테스트와 격리 프록시 검증을 수행한다.
  이 검증은 실제 EKS NetworkPolicy, IAM·ALB·CloudFront·Vercel 연결의 실증을 대신하지 않는다.

공식 근거: [CloudFront VPC origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html),
[ALB prefix list](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/#security-group-prefix-lists),
[요청 헤더·쿠키 정책](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html).
