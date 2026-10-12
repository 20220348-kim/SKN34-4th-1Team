# GovBiz AWS EKS 전체 구성도

[문서 안내](../../README.md) · [아키텍처 이미지 목록](README.md) · [로컬 Kubernetes 구성](README-local.md)

로컬 `govbiz-local-architecture`의 업무·평가·관측 연결에 **Vercel과 AWS EKS 인프라·자동 배포**를 반영한 별도 그림입니다.
**업무·Argo 웹 진입 경로·로드밸런싱·Pod/EC2 자동확장·노드 배치·자동 배포**를 표현하며, 개인 main의 필수 CI 통과부터 EKS·Vercel 갱신까지 연결합니다.
현재 저장소의 운영 설정을 표시하고 실제 배포·자동 축소 관찰 결과는 아래 기록과 구분합니다.
로컬 그림과 과거 EC2·RDS 배포 그림은 그대로 보존합니다.

![GovBiz Vercel·AWS EKS 전체 구성도](govbiz-aws-eks-architecture.png?v=27631e4266f5)

[PNG 크게 보기](govbiz-aws-eks-architecture.png?v=27631e4266f5) · [SVG 원본](govbiz-aws-eks-architecture.svg?v=bc65fcd202fd) · [생성 스크립트](build-aws-eks.mjs)

## 그림의 기준

**2026-10-13 확인한 저장소의 인프라 구성과 자동 배포 워크플로**를 기준으로 작성했습니다.
그림에는 기본 EC2 2대·최대 3대의 운영 설정을 표시하고, 실제 전환·실행 여부는 아래 검증 기록에 남깁니다.
그림 수정은 배포 설정·운영 데이터·실행 중인 서비스를 변경하지 않습니다.

| 구분 | 반영 내용 | 근거 |
|---|---|---|
| 웹·API 진입 | Vercel React 웹 → 서버 미들웨어 → CloudFront VPC origin → 내부 ALB → EKS Nginx | [실배포 기록](../../../infrastructure/eks/sydney-demo.md), [API 진입점](../../../infrastructure/eks/api-entrypoint.md), [Vercel 미들웨어](../../../frontend/web/middleware.ts) |
| Argo 관리 웹 | 관리자 브라우저 → CloudFront `/argocd/` → 기존 내부 ALB·Gateway → Argo ClusterIP Service → EKS `argocd-server` Pod | [대시보드 배치·접속](../../../infrastructure/eks/argocd-dashboard.md), [Gateway Argo 분기](../../../infrastructure/eks/api-gateway/argocd.conf.template) |
| 컴퓨팅·네트워크 | 시드니 EKS, private EC2 기본 2대·최대 3대, NAT 1개, EKS API의 사설 접근·관리 IP 제한 | [클러스터 설정](../../../infrastructure/eks/cluster.sydney-demo.yaml), [자동 확장 설정](../../../infrastructure/eks/autoscaling/README.md) |
| 노드 배치 | 업무 DB·Catalog·Ops는 application, Prefect·평가 실행기·결과 저장소·Langfuse·Argo CD는 observability. 기본 두 노드에서는 Core·AI를 각각 1개씩 배치 | [EKS 서비스 설정](../../../infrastructure/eks/gitops-values.yaml), [배포 YAML 생성](../../../infrastructure/eks/gitops.py), [Argo 설치·배치 기록](../../../infrastructure/eks/argo-cd.md#현재-argo-자원-배치) |
| 로드밸런싱 | 내부 ALB → 정상 Gateway Pod IP → 업무 API는 Core·Ops Service, 관리 웹은 Argo Service로 분기. Core → AI Service로 연결하며 Core·AI Service는 준비된 Pod로 분산 | [API 진입점](../../../infrastructure/eks/api-entrypoint.md) |
| Pod·EC2 자동확장 | HPA: CPU requests 대비 평균 사용률 60%, Core·AI 각각 2\~3개·Gateway 1\~3개. 배치 대기 Pod가 생기면 Cluster Autoscaler가 application EC2를 최대 1대 추가 | [자동 확장 설정](../../../infrastructure/eks/autoscaling/README.md) |
| 데이터 | 기존 DB·색인·큐·평가·관측 데이터를 EBS gp3 PVC에 복원, S3에는 암호화한 이전 백업 보관 | [이전 기록](../../../infrastructure/eks/sydney-demo.md), [StorageClass](../../../infrastructure/eks/storage-class.yaml) |
| 변경 배포 | 같은 최신 main의 필수 CI → CodeBuild·ECR → Helm·Git 태그 → Argo CD·EKS → Vercel | [자동 배포 구성·검증 상태](../../../infrastructure/eks/continuous-deployment.md), [워크플로](../../../.github/workflows/eks-release.yml) |
| Helm·Argo CD | Helm으로 만든 배포 YAML을 Git에 보관하고 Argo CD가 EKS 앱에 반영합니다. Helm은 AWS Load Balancer Controller 설치에도 사용합니다. | [Argo 최초 인계](../../../infrastructure/eks/argo-cd.md), [Controller 설치 절차](../../../infrastructure/eks/api-entrypoint.md#실제-적용-전-준비) |
| 모바일 | React Native·Expo 화면은 기기에서 실행합니다. API origin이 Vercel이면 `/api` 서버 미들웨어를 거쳐 웹과 같은 API 진입 경로를 사용합니다. | [모바일 API 클라이언트](../../../frontend/mobile/src/api/client.ts), [모바일 안내](../../../frontend/mobile/README.md) |

## 요청·데이터 흐름

상단은 요청 순서이고, 가운데는 AWS·VPC·EKS 경계입니다.
EKS 상단의 **EC2 표는 기본 두 노드의 역할**, 그 아래는 **로드밸런싱·자동확장 흐름**입니다.
로드밸런싱 영역은 상단 API 경로의 확대도이며 별도의 ALB·Gateway를 추가한다는 뜻이 아닙니다.
Namespace 상자는 서비스의 **논리 구분**입니다.
Namespace 상자가 오른쪽이나 왼쪽에 있다는 이유로 해당 노드에서 실행된다는 뜻은 아닙니다.
평가 서비스는 observability 노드에서 실행하며 Namespace는 `govbiz-evaluation`을 유지합니다.
번호 ①·②는 업무 API 목적지, ③·④는 EBS 저장소와 ECR 이미지 공급, ⑤는 Argo가 조회하는 Git 배포 태그, ⑥은 Argo 관리 웹의 Service·Pod를 연결합니다.

GovBiz 사용자·Ops 화면은 Vercel에서, Argo 배포 관리 화면은 EKS의 `argocd-server` Pod에서 제공합니다.
그림 상단의 관리자 브라우저는 CloudFront `/argocd/`로 직접 접속합니다. 기존 내부 ALB·Gateway를 공유하며,
Gateway에서 업무 API와 관리 웹이 분기하는 지점과 `argocd-server Service → Pod`를 확대 영역에 표시했습니다.

상단 모바일의 Vercel 방향 점선은 **앱의 `EXPO_PUBLIC_API_BASE_URL`을 Vercel 운영 origin으로
설정했을 때**의 연결입니다. 앱 화면은 기기에서 실행하고, API 요청만
`Vercel /api 미들웨어 → CloudFront → 내부 ALB → Nginx → Core`를 거칩니다.
Vercel은 서버에서 프록시 비밀값을 추가하며 앱에는 이 값을 넣지 않습니다.
현재 EKS의 Core는 클러스터 내부 Service이므로 외부 앱에서 직접 호출하는 구조가 아닙니다.
로컬 개발에서는 공개한 Core 포트를 API 주소로 설정할 수 있지만, 그 경로를 운영 구성에 섞지 않습니다.
실제 배포 앱의 API 주소와 운영 실기기 연결 완료 여부는 별도 확인 대상입니다.

| 경로 | 역할 |
|---|---|
| 웹 → API | Vercel이 서버에서 프록시 비밀값을 추가하고, Nginx가 검증합니다. CloudFront는 API와 제한된 Argo 경로를 중계하며 캐시를 사용하지 않습니다. |
| ALB → Gateway Pod | `target-type: ip`로 정상 상태의 Gateway Pod IP에 분산합니다. ALB가 Gateway의 ClusterIP를 경유하는 구조가 아닙니다. |
| Nginx → Core·Ops | `/api/v1/ops`와 그 하위 경로는 Ops, 나머지 `/api/*`는 Core로 보냅니다. Ops는 Core의 관리자 세션을 확인합니다. |
| Core·AI Service → Pod | Service는 준비된 Pod로 연결을 분산합니다. Core에서 AI를 호출할 때도 AI Service를 사용합니다. Ops는 단일 Pod입니다. |
| 모바일 → API 중계 → Core | Vercel origin 사용 시 위 점선 경로로 Nginx까지 거쳐 같은 Core API·계정 데이터를 사용합니다. 사용자 Bearer 인증은 중계되며, 앱 기기와 운영 프록시를 함께 거치는 검증은 별도입니다. |
| Core·Catalog → 저장소 | 두 서비스는 MyBatis로 각자의 MySQL을 사용합니다. Core는 Redis와 Elasticsearch를 조회하며, Catalog는 공고·색인을 준비합니다. Core의 Outbox 발행기·소비자가 RabbitMQ를 사용합니다. |
| AI → 검색·관측 | Qdrant에서 벡터·원문 근거를 조회하고 OpenAI를 호출합니다. Langfuse SDK를 활성화한 경로의 trace를 내부 Langfuse에 보냅니다. |
| Ops → 평가 | Prefect·실행기가 평가하고 pandas·Pandera·지표 계산·Evidently 보고서·Langfuse 점수 등록을 이어갑니다. Evidently는 실행기가 생성하는 보고서이며 별도 상시 서버가 아닙니다. |
| 결과 → 관리자 | `ops-artifacts`는 결과 PVC를 읽기 전용으로 제공하고, `ops-sync`가 상태·결과를 반영합니다. 관리자는 같은 React 웹에서 검토·판정·비교 기준을 관리합니다. |
| 도구 UI | Prefect·Langfuse는 EKS 권한을 가진 관리자가 loopback port-forward로 접속합니다. Argo는 기존 CloudFront `/argocd/` → 내부 ALB·Gateway → ClusterIP `8080` 경로이며 관리자 IPv4·전용 origin 비밀값·`admin` 인증으로 제한합니다. |

### Argo CD의 실행 위치와 배포 제어

Argo CD는 **관측 도구가 아닌 배포 관리 도구**입니다. 현재 `observability` 노드 풀은
관측·평가·배포 관리 도구가 함께 사용하는 EC2입니다. Argo를 이 노드에 배치한 것은
별도 EC2를 추가하지 않고 기존 관리용 노드를 사용하기 위한 프로젝트의 선택이며,
Kubernetes나 Argo CD의 필수 배치 조건이 아닙니다.

[EKS Argo 설치·배치 구성](../../../infrastructure/eks/argo-cd.md#현재-argo-자원-배치)은
Argo CD Core 3.5.3의 4개 구성 요소에 상시 `argocd-server` 대시보드 1개를 더해
**`argocd` Namespace, `observability` 노드에 총 Pod 5개**를 배치합니다.
`argocd`와 `govbiz-observability`는 별도 Namespace이며 물리적으로 같은 EC2를 사용할 수 있습니다.

| Argo 구성 요소 | 역할 |
|---|---|
| `application-controller` | Git의 배포 설정과 클러스터 상태를 비교하고 Kubernetes API로 앱을 동기화합니다. |
| `repo-server` | ⑤ Git 배포 태그의 YAML을 읽어 controller에 제공합니다. |
| ApplicationSet controller | Application 생성·관리를 위한 설치 구성 요소입니다. |
| Redis | Argo 내부 캐시입니다. 업무·Langfuse Redis와 별도입니다. |
| `argocd-server` | 상시 대시보드·API입니다. Deployment 1개·Pod 1개·ClusterIP Service로 구성하며 HTTPS·`admin` 인증을 사용합니다. |

관리자는 [운영 HTTPS 주소](https://d1kn7p1kr532sh.cloudfront.net/argocd/)로 접속합니다.
CloudFront가 관리자 IPv4를 확인하고, 기존 내부 ALB·Gateway가 전용 origin 비밀값을 검사한 뒤
Argo 서버 인증서를 검증해 ClusterIP `8080`으로 연결합니다. 별도 ALB·EC2·프록시 Pod·PVC는 만들지 않습니다.
로컬 터널은 진단용이며 앱 내 브라우저는 자체 서명 인증서를 차단할 수 있습니다.
[설치 리소스와 관리자 접속 절차](../../../infrastructure/eks/argocd-dashboard.md)를 따릅니다.
로컬 kind의 Argo CD Core는 상시 웹 서버 없이 Pod 4개를 유지합니다.
대시보드에서 조회·관리하는 `govbiz-eks`는 Core·Catalog·AI·Ops·평가 실행기·결과 서버의
앱 Deployment 6개와 관련 배포 리소스를 소유하며, DB·PVC·Secret·Argo 자체를 관리 범위에 추가하지 않습니다.
그림의 하단 자동 배포 흐름과 EKS 내부 `argocd` 영역은 **동일한 Argo를 서로 다른 관점에서 표시**합니다.
Git을 조회한 Argo controller가 EKS 관리형 Kubernetes API를 통해 위 업무·평가 워크로드를 갱신합니다.
Kubernetes API는 AWS 관리형 제어면이며 observability EC2의 Pod가 아닙니다.
이 주황색 선은 배포 제어 경로이며, 업무 API 요청은 Argo를 거치지 않습니다. 보라색 ⑥ 연결은 관리자가 Argo 웹을 사용하는 HTTP 경로입니다.
그림은 이 설치 구성을 설명하며 실제 대시보드 설치·접속 검증 결과는 [운영 기록](../../../infrastructure/eks/argo-cd.md)을 따릅니다.

### 외부 API 연결

외부 API 제공자는 AWS·VPC·EKS 경계 밖에 표시합니다. 요청은 아래와 같이 Pod에서 시작합니다.
이 경로는 Vercel을 API origin으로 사용하는 웹·모바일의 CloudFront·ALB 진입 경로와 별개입니다.

보라색 화살표는 외부 API 요청입니다. 영역 왼쪽의 Catalog·AI와 가운데의 NAT·Internet Gateway는
위 VPC에 있는 구성의 요청 경로를 다시 표시한 것입니다. 두 호출은 같은 NAT Gateway를 사용합니다.

| 호출 주체 → 외부 대상 | 하는 일과 실행 조건 |
|---|---|
| **Catalog → 공고 제공처 API** | 기업마당·K-Startup·과학기술정보통신부(MSIT)·충남 수출지원(CNTRADE_NOTICE)의 공고를 수집합니다. 기본 주소는 `https://apis.data.go.kr`입니다. 제공처별 키와 수집 실행 설정이 필요하며, 그림의 선이 정기 수집 활성화를 뜻하지는 않습니다. |
| **AI Service → OpenAI** | 답변 생성·추천·RAG·임베딩을 요청합니다. `OPENAI_API_KEY`와 모델 설정이 필요합니다. Catalog는 AI 내부 API로 색인을 요청하고, 실제 OpenAI 임베딩 호출은 AI Service가 담당합니다. |

NAT Gateway는 public subnet에 있고, private 노드의 외부 요청을 Internet Gateway로 내보냅니다.
현재 클러스터 설정은 NAT Gateway 1개를 사용합니다. 외부 호출 대상과 키·정기 수집 활성화 상태는 배포 환경의 설정으로 정해집니다.

평가 코드에는 live OpenAI 호출도 있지만 **현재 평가 Chart는 이를 비활성화**합니다.
실행기의 live·RAG live는 `false`, OpenAI 키는 빈 값이며, NetworkPolicy에는 외부 HTTPS 송신 허용이 없습니다.
따라서 실행기를 OpenAI 호출 주체로 연결하지 않았습니다. 향후 유료 평가에는 승인·예산·키와 외부 통신 정책 준비가 필요합니다.

Core의 Google·Kakao OAuth, Bizno 사업자 조회, SMTP 메일, 기업마당 원문·첨부 조회 등 보조 연동은 개별 선을 생략했습니다.
이번 보완은 연결 관계를 설명하는 문서 변경이며 외부 API 실호출이나 새 배포·운영 검증을 수행했다는 뜻은 아닙니다.

근거: [Catalog 제공처·수집 설정](../../../backend/catalog-service/src/main/resources/application.properties) ·
[AI OpenAI 클라이언트](../../../backend/ai-service/app/bootstrap.py) ·
[EKS private 노드·NAT 설정](../../../infrastructure/eks/cluster.sydney-demo.yaml) ·
[평가 실행기 설정](../../../infrastructure/gitops/charts/govbiz-evaluation/templates/workload.yaml) ·
[평가 통신 정책](../../../infrastructure/gitops/charts/govbiz-evaluation/templates/network-policy.yaml) ·
[Core 보조 연동 설정](../../../backend/core-service/src/main/resources/application.properties).

## AWS 저장·실행 경계

| 구성 | 범위 |
|---|---|
| EKS 워커 | 기본은 `application`과 `observability`의 `m7i-flex.large` 각 1대입니다. `application`은 최대 2대, `observability`는 1대를 유지해 전체 EC2는 2\~3대입니다. Namespace와 노드 풀은 서로 다른 구분입니다. |
| 기본 두 노드의 배치 | application은 업무 DB·검색·큐·Catalog·Ops, observability는 Langfuse·관측 저장소·Argo CD·Prefect·평가 실행기·결과 저장소를 실행합니다. 기본 두 노드에서는 Core·AI를 각각 1개씩 배치합니다. 기존 PVC를 보존하며 평가 실행기와 결과 API는 같은 노드에서 결과 PVC를 공유합니다. |
| Pod·노드 자동 확장 | Core·AI HPA는 각각 2\~3개이며 같은 서비스의 Pod는 필수 anti-affinity로 노드당 1개만 배치합니다. 세 번째 Pod가 대기하면 Cluster Autoscaler가 application EC2 1대를 추가합니다. Gateway는 HPA 1\~3개입니다. 부하 감소 후 Pod가 줄고 남은 Pod를 안전하게 옮길 수 있어야 추가 노드를 제거합니다. |
| Core·AI 교체 | `RollingUpdate`에서 `maxSurge: 0`, `maxUnavailable: 1`로 최대 1개씩 교체합니다. 최대 3대 상태에서 네 번째 노드를 요구하지 않도록 설정합니다. |
| 가용 영역 | 제어면 서브넷은 2개 AZ를 사용하지만 두 워커는 `ap-southeast-2a`에 있습니다. 다중 AZ 고가용성 구성으로 표시하지 않습니다. |
| EBS | 데이터 PVC 13개는 업무 7개·평가 2개·관측 4개입니다. 암호화 gp3와 `Retain`을 사용합니다. MySQL 3개는 EKS StatefulSet으로 유지하며 RDS로 전환한 구성이 아닙니다. |
| ECR | 수동 이전 당시 실행 이미지 17개를 private ECR에 보존했습니다. 자동 배포 경로는 애플리케이션용 이미지 5개를 빌드하고 digest로 배포합니다. 두 범위를 구분합니다. |
| S3 | 암호화한 이전 백업·메타데이터 84개를 비공개·버전 관리 버킷에 보관한 기록입니다. 상시 DB 백업이나 로컬↔AWS 자동 데이터 동기화 기능을 뜻하지 않습니다. |
| 외부 호출 | private workload가 public subnet의 NAT Gateway와 Internet Gateway를 거쳐 OpenAI·공고 제공처 등 VPC 외부 API에 연결합니다. |

### 로드밸런싱과 자동확장의 역할

회색 요청선은 **이미 실행 중인 정상 Pod로의 분산**, 녹색 제어선은 **Pod·EC2 개수 조절**입니다.
ALB가 Pod나 EC2를 늘리는 것은 아닙니다. HPA는 컨테이너 CPU requests 대비 평균 사용률 60%를 기준으로
Pod 수를 조절하며, EC2 전체 CPU 사용률이나 요청 수를 직접 기준으로 삼지 않습니다.
늘어난 Pod를 기존 노드에 배치할 수 없을 때 Cluster Autoscaler가 application 노드를 추가합니다.
Core·AI는 같은 서비스당 노드에 하나만 실행하도록 설정했으므로 세 번째 Pod에는 세 번째 EC2가 필요합니다.
Catalog·Ops·DB·평가 서비스는 이 HPA의 확장 대상이 아닙니다.

축소 시 HPA는 5분의 안정화 구간을 적용하고, Cluster Autoscaler는 추가 노드가 10분간 불필요하며
남은 Pod를 안전하게 옮길 수 있을 때 노드를 제거합니다. 각 대기 시간이 지나도 무조건 두 노드로 복귀하지는 않습니다.
그림의 Core·AI 두 기본 Pod는 정상 운영 시 HPA 최소 개수이며, 순차 교체 중에는 준비된 Pod가 하나일 수 있습니다.
EC2가 세 대일 때 필수 분산은 서로 다른 노드를 보장하지만 원래 두 노드에 영구 고정하지는 않습니다.

## 자동 배포 흐름

회색 실선은 내부 요청·데이터 관계, 회색 점선은 설정에 따른 연결·추가 검증 경로,
보라색 실선은 **외부 API 요청**, 주황색 실선은 **CI 통과 후 자동 배포 경로**입니다.

개인 저장소 main의 **같은 최신 SHA**에 대한 필수 CI가 모두 통과하면 GitHub Actions가
CodeConnections로 연결한 CodeBuild 임시 실행기에 빌드·ECR 발행을 맡깁니다.
CodeBuild는 Helm으로 배포 YAML을 만들고 CI 근거·이미지 digest와 함께 불변 Git 태그에 저장합니다.
[Argo CD 연결 스크립트](../../../infrastructure/eks/gitops.py)는 기존 환경을 보존하는 Application을 생성하고,
배포 시에는 Argo 동기화 결과를 읽기 전용으로 확인합니다.

서비스 이미지 5개를 immutable `git-SHA` 태그로 발행하고 digest를 고정해 배포합니다.
Argo PreSync가 평가 접수를 중지하고 실행 종료·Ops migration을 확인한 뒤 앱을 동기화합니다.
PostSync가 평가 연결을 검증하고 해당 배포가 중지한 접수 상태만 복구합니다.
CodeBuild에서 정확한 Git revision·두 hook·앱 6개의 실제 이미지를 확인해야
같은 SHA의 웹·shared를 빌드하고 CI를 다시 확인한 뒤 Vercel 운영 주소를 전환합니다.

자동 갱신 범위는 애플리케이션·평가 실행기·결과 서버입니다.
DB·PVC·네트워크·Langfuse는 별도로 관리합니다.

| 도구 | 운영 구성에서의 역할 |
|---|---|
| **CodeBuild** | 검증된 소스로 이미지 5개를 빌드·ECR 발행하고 배포 Git 태그를 만듭니다. EKS 권한은 지정한 앱과 Argo Application의 조회로 제한합니다. |
| **Helm** | Chart·EKS 설정·이미지 digest를 결합해 배포 YAML을 만듭니다. AWS Load Balancer Controller 설치에도 사용합니다. |
| **Argo CD** | `govbiz-eks/v1.RUN.ATTEMPT` 태그를 자동 추적해 EKS에 반영합니다. 평가 접수 보호·migration·연결 검증을 hook으로 수행하며 데이터 리소스는 소유하지 않습니다. |

기존 환경의 최초 관리권 이전과 자동 배포 활성화는 [전환 절차](../../../infrastructure/eks/argo-cd.md)를 따릅니다.

## 실제 적용·검증 기록

**2026-10-13 Argo 대시보드 접속:** 기존 CloudFront·내부 ALB·Gateway의 `/argocd/` 경로를 적용했고,
앱 내 브라우저에서 공인 HTTPS 인증서를 사용하는 로그인과 로그인 후 Applications 화면을 확인했습니다.
화면의 `govbiz-eks` 타일과 admin API 조회 모두 `Synced / Healthy`였으며 기존 Vercel Core health 200·직접 CloudFront API 403도 유지됐습니다.
최종 관측 EC2는 기존 자동 확장에 따라 3대였으며, 기본 2대 복귀를 새로 확인한 것은 아닙니다.
[접속 경로·제한·검증 기록](../../../infrastructure/eks/argo-cd.md#2026-10-13-운영-대시보드-추가)을 참고합니다.

**2026-10-12 노드 배치 전환 기록:** 평가 서비스의 observability 이전과 Core·AI 분산 설정을 실제 반영했습니다. 기본 EC2 2대 복귀는 아직 확인하지 못했습니다.

- 소스 `10a5b625123aa15a7f318cabbe1e382ac22d3a6b`의 필수 CI 5개·작업 28개가 모두 통과했습니다.
- GitOps 태그 `govbiz-eks/v1.38219188700.1`, revision `5ab4008f7ab773e4b9daaabffe3e8cbb744c3165`에서 Argo CD `Synced / Healthy / Succeeded`와 배포 hook·이미지·소스 SHA 일치를 확인했습니다.
- 평가 실행기·결과 서버·Prefect가 observability 노드로 이동했고 평가 접수를 재개했습니다. 기존 13개 PVC의 PVC·PV·EBS 식별자는 보존했습니다.
- Core·AI의 HPA 최소 2개·최대 3개와 hostname 기준 필수 Pod anti-affinity를 적용했습니다. 확인 당시 EC2는 3대, Core 3개·AI 2개이며 **기본 2대로 자동 축소되는 과정은 관찰 미완료**입니다.
- [배포 워크플로 38219188700](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/38219188700)의 첫 시도는 관찰 단계에서 실패했고 원인은 미확정입니다. 이후 위 Argo 상태는 성공했으나, 두 번째 시도는 main이 `cdc067d9`로 변경되어 `Source superseded`로 차단됐고 웹 작업은 건너뛰었습니다. 따라서 이 실행의 전체 배포·Vercel 전환 성공으로 기록하지 않습니다.
- 임시 Argo 동기화 제한을 제거하고 자동 동기화와 `EKS_RELEASE_ENABLED=true`를 복원했습니다.

아래는 전환 전 초기 점검 기록이며 현재 상태와 구분합니다.

- 수동 배포 기록에는 웹·Core/AI health·공고 목록·Ops session 응답과 익명 평가 이력 거절 확인이 있습니다.
- CodeConnections·CodeBuild·ECR·IAM·EKS 접근은 연결 및 읽기 전용 preflight 확인 기록이 있습니다.
- 2026-10-12 GitHub 조회에서 자동 배포 코드의 개인 main 반영과 `EKS_RELEASE_ENABLED=false`를 확인했습니다.
  최근 배포 워크플로 8건은 모두 `skipped`였습니다([당시 최신 실행](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/38159617616)).
  그림은 활성화 후 구조를 표현하며, 첫 실제 자동 rollout·Vercel 전환 성공 기록은 후속 검증 후 갱신합니다.
- 같은 날 EKS 읽기 전용 점검에서 앱 6개는 Ready였고 Argo Application CRD는 없었습니다.
  새 GitOps 코드·설정과 실제 Helm·Kustomize 렌더링을 준비했으며, main 반영·CI와 최초 인계·실배포 검증은 별도입니다.
- 현재 기록의 유료 평가·정기 실행은 비활성입니다. 관리자 로그인 후 전체 Ops 동작, 모바일 실기기,
  실제 모델 품질과 실시간 AWS 상태를 이 그림의 검증 결과로 간주하지 않습니다.

## 재생성

저장소 루트에서 로컬 로고만 읽어 SVG를 생성합니다.

```sh
node docs/assets/architecture/build-aws-eks.mjs
```

Playwright와 Chromium을 사용할 수 있으면 PNG를 함께 생성합니다.

```sh
node docs/assets/architecture/build-aws-eks.mjs --render
```

Playwright 설치 디렉터리를 별도로 지정할 때는 `GOVBIZ_DIAGRAM_NODE_MODULES`,
Chrome 실행 파일을 지정할 때는 `GOVBIZ_DIAGRAM_CHROME`을 사용합니다.
렌더링은 외부 네트워크 요청을 차단하고 로고 로드·텍스트 폭·이미지 경계를 확인합니다.
SVG는 3,000 × 5,170, PNG는 6,000 × 10,340입니다.

로고는 [AWS·공통 로고 출처](aws-logo-sources.json)와
[Kubernetes·서비스 로고 출처](kubernetes-logo-sources.json)의 로컬 파일을 SHA-256으로 확인해 사용합니다.
MySQL은 노랑, Qdrant는 분홍, Elasticsearch는 청록, Redis는 주황을 유지했습니다.
로고 권리·라이선스는 [이미지 목록의 출처 안내](README.md#로고-출처)를 따릅니다.
