# Vercel 웹 + 시드니 EKS 백엔드 시연 구성

`cluster.sydney-demo.yaml`은 `ap-southeast-2`, Kubernetes 1.36, `m7i-flex.large` 2대를
사용하는 7일 시연용 입력이다. 적용 전 지원 버전·quota·계정·비용을 다시 확인한다.
`cluster.example.yaml`은 별도 Argo CD 원본을 위한 기존 서울 1노드 예제로 유지한다.

## 웹 배포와 API 연결

운영 웹 주소는 **`https://govbiz.vercel.app`**, Vercel 프로젝트는 `geonwoo4/govbiz`다.
개인 저장소 `ilil1/SKN34-4th-1Team`의 main, Root Directory `frontend/web`에 연결했다.
2026-10-12 EKS 백엔드·저장소·평가 도구 20개와 API 게이트웨이를 기동했다.
CloudFront 경유 Core·AI health, 공개 공고 조회, Ops session 응답과 익명 이력 접근 거절을 확인했다.
Vercel 운영 연결과 관리자 화면의 확인 범위는 아래 실배포 기록에 구분한다.

**웹은 기존처럼 Vercel에 배포한다.** 현재 Mac의 웹 Pod는 로컬 검증용으로 유지하고,
EKS 목적지에서는 `govbiz-msa/web` Deployment와 Service를 제외한다. 백엔드·저장소·평가 도구는
EKS로 이전하며 MySQL을 RDS로 바꾸는 작업은 이번 선택에 포함하지 않는다.

실제 AWS에 적용한 요청 경로는 다음과 같다.
[CloudFront·내부 ALB·Ops 프록시 구성](api-entrypoint.md)은 API만 제공한다.

```text
사용자 → Vercel React 웹 (일반 화면·/ops/evaluations)
       → 같은 주소의 /api 요청 → Vercel 서버 미들웨어
       → CloudFront HTTPS → VPC origin → 내부 ALB → Nginx API 프록시
          ├─ /api/v1/ops/* → EKS ops-service → core-service에서 관리자 권한 확인
          └─ 나머지 /api/* → EKS core-service → AI·Catalog·DB
```

- 기존 [Vercel 설정](../../frontend/web/vercel.json)을 사용한다. Root Directory `frontend/web`,
  외부 workspace 소스 포함, Node 24.x/pnpm 11.22.x, 출력 `dist`를 유지한다.
- 브라우저 API 주소는 `VITE_CORE_API_BASE_URL=/`이다. Vercel Production의
  `GOVBIZ_FRONTEND_ORIGIN`과 아래 `--vercel-origin`에는 **`https://govbiz.vercel.app`**을 지정한다.
  Preview 주소를 운영 주소로 사용하지 않는다.
- 현재 [미들웨어](../../frontend/web/middleware.ts)는 `GOVBIZ_API_ORIGIN`으로 HTTPS
  `*.cloudfront.net`만 허용한다. 기존 CloudFront 경로를 EKS의 안정적인 진입점에 연결하거나,
  다른 HTTPS 진입점을 선택할 때 미들웨어 허용 규칙과 테스트를 함께 수정해야 한다.
  EKS의 ClusterIP·사설 DNS·로컬 port-forward 주소를 넣어서는 Vercel이 접속할 수 없다.
- `/api/v1/ops/*`는 기본 **503으로 차단**한다. 외부 진입점의 Core/Ops 분기,
  프록시 비밀값, 쿠키·Origin·CSRF 헤더 전달, NetworkPolicy·허용 Host를 검증한 뒤
  Vercel Production의 `GOVBIZ_OPS_PROXY_ENABLED=true`로 연다. 이 옵션만으로 AWS 경로가 만들어지지는 않는다.
- Core의 OAuth 공급자에도 같은 Vercel 주소의 callback을 등록한다. 외부 API
  로그인·Ops 검증은 실제 배포 단계에서 수행하며 이 문서의 변환 명령만으로 완료되지 않는다.

기존 EC2·RDS 구성 기록은 [Vercel 배포 안내](../../docs/deployment-aws-vercel.md)를 참고하되,
Compose의 고정 프록시 IP나 EC2 배포 명령을 EKS에 그대로 적용하지 않는다.
Vercel 프로젝트 생성과 개인 저장소 `ilil1/SKN34-4th-1Team` main의 필수 CI 통과 후 자동 배포 연결은
[EKS·Vercel 자동 배포](continuous-deployment.md)를 따른다. 이 흐름은 최초 클러스터 생성·데이터 복원과
외부 API 연결이 끝난 뒤 활성화한다.

## 2026-10-12 수동 배포 기록

- 시드니 `govbiz-eks`, Kubernetes 1.36, private `m7i-flex.large` 2대와 NAT 1개를 생성했다.
  EKS API 공개 접근은 관리용 IP로 제한하고 private 접근도 유지한다.
- 활성 PVC 13개의 냉간 백업을 암호화하고 EBS에 복원했다. gp3 15개는 모두 암호화됐으며,
  데이터 280GiB와 노드 루트 160GiB를 합해 **440GiB**다. 로컬 PVC와 서비스는 보존·재개했다.
- 암호화 백업·메타데이터 84개를 비공개 버전 관리 S3에 보관하고 크기·SHA-256을 확인했다.
  복호화 키는 S3나 Git에 올리지 않았다. 로컬 재개 이후 변경은 AWS와 자동 동기화되지 않는다.
- 기존 실행 이미지 17개를 `govbiz-migration/*` private ECR에 발행하고 linux/amd64의 실행 설정·
  레이어를 원본과 대조했다. 이번 이전은 기존 런타임의 보존이며 모든 백엔드를 최신 main으로
  다시 빌드한 배포가 아니다.
- MySQL 81개 테이블, Langfuse PostgreSQL 78개 테이블, ClickHouse 14개 테이블과 검색 인덱스를
  대조했다. 접수 중지·재개 감사 이력은 원본과 목적지에 각각 남겼으며 유료 평가·정기 실행은 꺼 두었다.

| 대조 항목 | EKS 복원 결과 |
| --- | --- |
| Catalog·Core 저장 공고 | 각각 10,129건 |
| 기존 계정 | 5개 |
| 평가 실행·비교 기준 | 실행 33건(완료 29·실패 4), 기준 7건 |
| Qdrant | 공고 벡터 10,131건, 근거 벡터 2건 |
| Elasticsearch·공개 공고 목록 | 각각 9,918건 |

수동 배포 중 ECR 저장소 이름 오탐, EBS 마운트 후 RabbitMQ 쿠키 권한, Nginx의 Kubernetes
서비스 DNS 해석을 수정했다. 쿠키 값·큐 데이터는 유지하며 기존 소유자가 파일 권한만 `600`으로
복구한다. 게이트웨이는 `*.govbiz-msa.svc.cluster.local` 전체 주소를 사용한다.

AWS Load Balancer Controller 3.6.0은 전용 Pod Identity 역할로 실행한다. 업무 노드의 CPU 예약
부족을 해결하기 위해 컨트롤러는 observability 노드에 두고 CoreDNS는 노드별 1개로 분산했다.
노드·디스크를 추가하지 않았다. 두 노드의 실제 메모리 사용량과 시스템 Pod 배치를 함께 확인해야 한다.

GitHub OIDC provider 조회는 계정의 관리형 조직 정책(SCP)에 거절됐다. 사용자 결정에 따라
**수동 배포를 우선하며 `EKS_RELEASE_ENABLED=false`를 유지**한다. 유료 플랜 전환이나
장기 AWS 키 발급으로 우회하지 않았다. 자동 배포용 CodeBuild·release 스택은 생성하지 않았다.

배포 기준 main `6bfe7a31963aa9f8cf8b2d541a6b14565dff7536`의 필수 CI 5개는 통과했다.
현장 수정은 관련 변환 테스트·게이트웨이 격리 검증과 실제 EKS 요청으로 확인했으며,
이 추가 수정의 전체 CI 완료 여부는 후속 커밋의 결과로 별도 판단한다.
Vercel에는 같은 main의 추적된 웹·shared 소스만 빌드했다. Ready와 필수 CI 재확인 후 운영 주소로
전환했으며 웹·Core/AI health·공고 목록·Ops session은 200, 익명 평가 이력은 401을 확인했다.
브라우저의 필터 검색에서도 접수 중 공고 1,158건이 표시됐다. 실제 관리자 로그인 후 Ops 조회와
유료 모델 품질 평가는 이 무료 검증만으로 완료된 것으로 보지 않는다.

Langfuse·Prefect는 공개하지 않는다. 현재 Mac의 localhost 터널만 EKS로 연결했으며 각각
`http://localhost:13000`, `http://localhost:14200`에서 health 200을 확인했다.
다른 PC에서는 EKS 권한이 있는 kubeconfig로 아래 터널을 직접 열어야 한다. 이미 같은 포트에서
로컬 환경을 보고 있다면 그 터널의 대상을 확인하고 전환한다. DB나 원본 Pod를 중지할 필요는 없다.

```sh
kubectl --kubeconfig '<EKS kubeconfig>' -n govbiz-observability \
  port-forward --address 127.0.0.1 service/langfuse-web 13000:3000
kubectl --kubeconfig '<EKS kubeconfig>' -n govbiz-evaluation \
  port-forward --address 127.0.0.1 service/prefect 14200:4200
```

AWS 자원은 실행 중인 동안 비용이 발생한다. 7일 종료 시 자동 삭제나 비용 차단은 설정하지 않았다.
백업 S3·ECR과 Retain EBS는 스택·클러스터 삭제만으로 함께 삭제된다고 가정하지 않는다.

## 노드와 디스크 배치

| 노드 풀 | 배치할 서비스 | 변경 후 노드별 CPU 요청 상한 / 할당 가능 |
| --- | --- | --- |
| `application` | 업무 저장소 7개, Catalog·Ops, Core·AI 각 1개 | 1690m / 1930m |
| `observability` | Langfuse·전용 저장소, Prefect·평가 실행기·결과 서버, Core·AI 각 1개 | 1890m / 1930m |

최초 EKS 이전 설정은 평가 3종을 application에 두었다. 위 표는 평가를 observability로 모으고
Core·AI를 두 기본 노드에 분산하는 변경 목표이며, 실제 적용 결과와 구분한다.
시스템 Pod와 각 노드 Gateway 최대 2개(롤링 교체 포함)를 고려한 CPU 예약값이다.
Argo controller 50m·repo-server 25m·Autoscaler 25m 조정과 노드당 Core·AI 각 1개 조건을
전제로 하며 자세한 적용 순서는 [자동 확장 안내](autoscaling/README.md)를 따른다.

요청량은 실제 최대 사용량이나 성능 보장이 아니다. EKS 시스템 Pod의
요청량·노드 allocatable·실행 중 최대 메모리를 추가 확인한다. 서비스의 메모리 limit 합계가
각 노드의 8GiB보다 클 수 있으므로 대량 동시 평가·색인을 활성화하지 않는다.

- 최초 클러스터 생성 시 두 노드 그룹은 각각 1대다. 자동 확장 적용 후 application은
  최소 1 / 최대 2대, observability는 1대로 유지한다. 노드 hostname 대신
  `govbiz.io/workload-pool` 라벨로 배치해 노드 교체에도 같은 풀을 선택한다.
- 제어 영역에는 두 AZ를 사용하되 데이터 노드는 모두 `ap-southeast-2a`에 둔다.
  단일 AZ이며 DB는 단일 replica다. Core·AI의 복제만으로 전체 시스템의 HA가 제공되지는 않는다.
- 평가 실행기와 보고서 서비스는 같은 RWO PVC를 사용한다. 같은 풀 지정에 더해 필수 Pod affinity로
  동일 노드에 배치하며, PVC를 쓰는 Deployment는 `Recreate`로 갱신한다.
- gp3는 암호화·Retain·WaitForFirstConsumer를 사용한다. 복원 Pod도 대상 노드 풀을 지정한다.
- 현재 사용 중인 PVC 13개는 20GiB씩 요청한다. 이전 시 ClickHouse·MinIO는 최소 30GiB를
  확보하므로 데이터 280GiB, 노드 루트 80GiB씩을 합해 총 440GiB를 계획한다.
  실제 데이터 크기와 할당·청구 용량은 다르다.
- private 노드와 NAT Gateway 1개를 사용한다. 초기 백엔드 확인은 loopback port-forward로 수행한다.
  Vercel 운영 연결에 필요한 AWS HTTPS 진입점은 별도 준비하며 이 클러스터 파일은 ALB를 만들지 않는다.

2026-10-11 조회 가격으로 EKS 표준 지원·EC2 2대·gp3 440GiB·NAT 1개·공인 IPv4 1개의
168시간 고정비는 약 **$77.5**다. gp3 월 요금을 730시간으로 환산한 추정이며 로그·전송·세금·
노드 교체 중 추가 인스턴스 등은 별도다. Vercel·외부 API 진입점 비용도 포함하지 않으므로 공개 배포 전
다시 합산한다. Free Plan 대상 인스턴스라는 뜻이 사용료 0원이라는 뜻은 아니다.

## 현재 Mac의 구성 수집

저장소 루트에서 Python 3.12+, kubectl, OpenSSL을 사용한다. 아래 경로는 예시이므로 매번
새 디렉터리를 선택한다. 키와 bundle을 분리하고 생성 파일을 Git에 추가하지 않는다.

```sh
tool=infrastructure/gitops/scripts/eks_handoff.py
source_kube=.data/kubernetes-migration/20261011/kubeconfig
bundle=.data/eks-handoff-final/bundle
key=.data/eks-handoff-final/keys/key
python3 "$tool" capture --source-mode manifests \
  --kubeconfig "$source_kube" --output "$bundle" --key-file "$key"
```

`capture`는 서비스·데이터를 변경하지 않는다. 참조 Secret은 `configuration.enc` 안에 암호화하고
키는 600, 디렉터리는 700 권한으로 저장한다. `image-inventory.json`에는 초기화 컨테이너를
포함한 전체 이미지와 사용처만 기록한다. kubeconfig와 서비스 계정 토큰은 전달하지 않는다.

원본에 없는 수집 영수증 PVC를 만들어 넣지 않는다. 존재하는 영수증은 보존하고, workload가
참조하는 PVC가 없으면 실패한다. Argo CD가 관리하는 앱이 있으면 이 모드를 거절하고 기존
Argo 경로를 사용한다. custom service account/RBAC, 복수 replica, hostPath, 별도 affinity 등
자동 변환하지 않는 구성은 명시적으로 거절한다.

원본 수집에는 로컬 웹도 남긴다. Vercel 선택은 목적지 변환에만 적용하므로 원본 복구 기록과
13개 데이터 PVC의 백업·복원 범위는 바뀌지 않는다.

**`configuration.enc`만 있으면 구성 수집만 완료한 것이다. 데이터 백업 완료는
`backup.enc`와 `backup-completed.json`이 모두 있어야 한다.** 최종 냉간 백업은 이전 실행 직전에
새 bundle로 만들고, [기존 중단·재개 절차](README.md#현재-pc-구성-수집과-냉간-백업)를 따른다.
실행 중 평가와 예약이 없는지 확인하고 접수를 일시 중지한 뒤 Deployment → StatefulSet 순서로
정상 종료한다. 원래 replica와 접수 상태를 기록하고 성공·실패 모두 원래 상태로 복구한다.

```sh
python3 "$tool" backup --kubeconfig "$source_kube" \
  --node '<원본 노드 hostname>' --bundle "$bundle" --key-file "$key"
```

tar는 Linux 백업 Pod 안에서 실행하므로 Mac의 BSD tar 옵션 차이에 의존하지 않는다.
실행 중인 DB 파일을 그대로 복사하거나 원본 PVC를 삭제하지 않는다.

## 이미지 발행과 오프라인 변환

현재 `docker.io/govbiz-migration/*@sha256:...` 참조는 로컬로 수입한 이미지다. 태그에
`docker.io`가 있다고 공개 레지스트리에 발행된 것은 아니다. 재빌드 대신 검증된 기존 이미지를
선택한 계정의 private ECR에 발행하고 **실제 발행 결과 digest**를 기록한다.

Docker의 이미지 index ID, platform manifest digest, config digest를 같은 값으로 취급하지 않는다.
로컬 수입 기록을 대조하고 파일 레이어·실행 설정·linux/amd64 일치를 확인한다. ECR에서 다시
조회한 digest로 다음 JSON 매핑을 작성한다. 초기화 컨테이너도 빠짐없이 포함한다.
`image-inventory.json`에서 사용처가 `govbiz-msa/web/*`뿐인 이미지는 Vercel 배포 시 발행·매핑을
생략할 수 있다. 다른 서비스나 초기화 컨테이너도 사용하는 이미지는 반드시 유지한다.

```json
{
  "docker.io/govbiz-migration/서비스@sha256:원본_digest":
    "계정.dkr.ecr.ap-southeast-2.amazonaws.com/govbiz-demo/서비스@sha256:발행_digest"
}
```

```sh
python3 "$tool" prepare --bundle "$bundle" --key-file "$key" \
  --pool-placement --image-map .data/eks-image-map.json \
  --vercel-origin 'https://govbiz.vercel.app' \
  --output .data/eks-rendered
```

이 명령은 AWS 호출·적용·앱 기동을 하지 않는다. 이미지 매핑이 부족하거나 digest가 없으면 거절한다.
`--vercel-origin`은 실제 HTTPS `*.vercel.app` origin만 받으며 경로·끝 `/`를 붙이지 않는다.
다른 Vercel 프로젝트를 사용할 때는 실제 발급된 주소로 바꾼다. 옵션 없이 만들었던 이전 출력은 웹 Pod를 포함하므로
새 출력 디렉터리로 다시 변환한다. 기존 Kubernetes 웹 배포를 사용하는 별도 환경은 옵션을 생략한다.
출력은 모두 비공개로 다룬다. 이전 replica는 `startup-plan.json`에 기록하고 workload는 0개로
멈춘 상태로 내보낸다. Service 이름·내부 연결·NetworkPolicy·DB 설정·복원 검사·probe를 보존하며,
개발 로그인 및 Ops 유료·정기 평가 실행은 비활성화한다. 기존 AI 키를 사용하는 실제 호출은
이전 확인 과정에서 실행하지 않는다.

Vercel 모드에서는 Core의 CORS·OAuth callback/완료 화면·일일 리포트 링크와 Ops 화면·CSRF
신뢰 origin을 해당 주소로 바꾸고 Core·Django의 Secure 쿠키를 켠다. `startup-plan.json`에
`frontend.hosting=vercel`과 origin을 기록하며 웹 Pod·Service는 출력하지 않는다.

| 출력 | 적용 시점 |
| --- | --- |
| `00-namespaces.json`, `10-claims.json` | 새 클러스터의 namespace·빈 EBS 준비 |
| `20-private-dependencies.json` | 복원 후 Secret·ConfigMap 주입. 내용 출력 금지 |
| `25-services-and-policies.json` | 기존 내부 서비스와 네트워크 정책 연결 |
| `30-data-stopped.json` | 모든 저장소를 정지 상태로 등록 |
| `50-workloads-stopped.json` | 앱을 정지 상태로 등록 |
| `startup-plan.json` | 원래 replica와 대상 풀 확인용 기록. Kubernetes manifest 아님 |

## AWS 생성과 복원 순서

1. 배포 대상 변경의 필수 CI를 확인한다. 별도 작업 사본에서 관리자 CIDR placeholder를 실제
   공인 IP `/32`로 바꾸고 `AWS_PROFILE=govbiz-eks eksctl create cluster --dry-run --config-file ...`로 검사한다.
   `--dry-run`에서는 `--profile` 인자를 함께 사용할 수 없으므로 환경변수로 프로필을 전달한다.
   지원 버전·한도·크레딧과 총비용을 확인한 뒤 실제 생성한다.
2. EKS 노드 두 대, EBS CSI·Pod Identity·VPC CNI와 NetworkPolicy, Elasticsearch의
   `vm.max_map_count=1048576`, ECR 이미지 pull 권한을 확인한다.
3. 전용 EKS kubeconfig로 namespace와 `storage-class.yaml`, 빈 PVC만 만든다.
4. 다음 명령으로 복원한다. 원본 namespace UID, 살아 있는 writer, 비어 있지 않은 목적 PVC는 거절한다.
   각 archive 전체의 인증이 끝나야 쓰기를 시작한다. 실패하면 원본·백업을 유지하고 새 빈 대상으로 재시도한다.

```sh
python3 "$tool" restore --kubeconfig .data/eks-kubeconfig \
  --pool-placement --bundle "$bundle" --key-file "$key"
```

5. Secret·ConfigMap·Service·NetworkPolicy와 정지 workload를 적용한다. 저장소부터 원래 replica로
   기동해 Ready를 확인한 뒤 Prefect·보고서 → AI·Catalog·Core·Ops → 실행기 순서로 재개한다.
   모든 replica를 일괄 1로 바꾸지 말고 `startup-plan.json`과 원래 접수 상태를 따른다.
6. Core·Ops의 health와 데이터·보고서 보존을 내부 연결 또는 port-forward로 확인한다.
   Langfuse 자체 UI는 `13000:3000` port-forward로 별도 확인한다. EKS에 웹 Service가 없으므로
   기존 `service/web 18173:8080` 명령을 실행하지 않는다.
7. 위의 외부 API 경로·Ops 프록시를 연결하고 Vercel Production에 배포한 뒤, 실제 HTTPS 웹 주소에서
   기존 관리자 로그인, OAuth, 공고·평가 이력·보고서, 무료 평가, 로그아웃 후 접근 차단을 확인한다.
   기존 모델의 유료 호출을 새로 하지 않는다. port-forward 검증만으로 이 단계를 완료로 표시하지 않는다.

이 경로는 현재 직접 배포 구성을 유지하는 첫 이전이다. Argo CD나 새 DB 스키마를 함께 도입하지 않는다.
시연 종료 후 원격 백업 확인 → 앱 중지 → 클러스터 정리 → Retain EBS·NAT·공인 IP·ECR·로그의
잔여 자원 확인을 진행한다. 데이터 삭제 대상과 보존할 백업은 종료 시 명시적으로 확정한다.

## 검증과 완료 경계

`infrastructure/gitops/scripts/test_eks_handoff.py`는 기존 암호화·손상 차단·원본 복원 거절과 함께
직접 배포 수집, 이미지 누락, PVC 보존, 두 풀 배치, RWO 공동 배치, 시드니 설정을 검사한다.
Vercel 선택 시 웹만 제외하고 Langfuse 웹·공유 이미지·데이터를 보존하는지, 잘못된 origin을
거절하고 Core·Ops 주소·Secure 쿠키 설정을 반영하는지도 검사한다.
Linux Python 환경의 PyYAML·OpenSSL·GNU tar가 필요하며 기존 Infra CI의 테스트 탐색에 포함된다.
Mac에서는 GNU tar가 있는 격리 Linux 환경으로 파일 복원 테스트를 실행한다.

오프라인 schema 검사와 단위 테스트는 EKS 기동·실제 EBS 복원·AWS 네트워크 검증을 대신하지 않는다.
실제 클러스터 확인 전에는 AWS 이전 완료로 표시하지 않는다.

- [EKS 노드 그룹](https://docs.aws.amazon.com/eks/latest/eksctl/nodegroups.html)
- [Kubernetes Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [EKS 요금](https://aws.amazon.com/eks/pricing/) · [EBS 요금](https://aws.amazon.com/ebs/pricing/)
