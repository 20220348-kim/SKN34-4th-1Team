# GovBiz AWS EKS 전체 구성도

[문서 안내](../../README.md) · [아키텍처 이미지 목록](README.md) · [로컬 Kubernetes 구성](README-local.md)

로컬 `govbiz-local-architecture`의 업무·평가·관측 연결에 **Vercel과 AWS EKS 인프라·자동 배포**를 반영한 별도 그림입니다.
**자동 배포가 활성화된 목표 구조**를 표현하며, 개인 main의 필수 CI 통과부터 EKS·Vercel 갱신까지 연결합니다.
로컬 그림과 과거 EC2·RDS 배포 그림은 그대로 보존합니다.

![GovBiz Vercel·AWS EKS 전체 구성도](govbiz-aws-eks-architecture.png?v=be244c2d5ed5)

[PNG 크게 보기](govbiz-aws-eks-architecture.png?v=be244c2d5ed5) · [SVG 원본](govbiz-aws-eks-architecture.svg?v=1ffd1dac1d04) · [생성 스크립트](build-aws-eks.mjs)

## 그림의 기준

**2026-10-12 저장소의 인프라 구성과 자동 배포 워크플로**를 기준으로 작성했습니다.
그림에는 자동 배포를 활성화했을 때의 흐름을 표시하고, 실제 활성화·실행 여부는 아래 검증 기록에 남깁니다.
그림 수정은 배포 설정·운영 데이터·실행 중인 서비스를 변경하지 않습니다.

| 구분 | 반영 내용 | 근거 |
|---|---|---|
| 웹·API 진입 | Vercel React 웹 → 서버 미들웨어 → CloudFront VPC origin → 내부 ALB → EKS Nginx | [실배포 기록](../../../infrastructure/eks/sydney-demo.md), [API 진입점](../../../infrastructure/eks/api-entrypoint.md), [Vercel 미들웨어](../../../frontend/web/middleware.ts) |
| 컴퓨팅·네트워크 | 시드니 EKS, private EC2 워커 2대, NAT 1개, EKS API의 사설 접근·관리 IP 제한 | [클러스터 설정](../../../infrastructure/eks/cluster.sydney-demo.yaml) |
| 데이터 | 기존 DB·색인·큐·평가·관측 데이터를 EBS gp3 PVC에 복원, S3에는 암호화한 이전 백업 보관 | [이전 기록](../../../infrastructure/eks/sydney-demo.md), [StorageClass](../../../infrastructure/eks/storage-class.yaml) |
| 변경 배포 | 같은 최신 main의 필수 CI → CodeBuild·ECR → Helm·Git 태그 → Argo CD·EKS → Vercel | [자동 배포 구성·검증 상태](../../../infrastructure/eks/continuous-deployment.md), [워크플로](../../../.github/workflows/eks-release.yml) |
| Helm·Argo CD | Helm으로 만든 배포 YAML을 Git에 보관하고 Argo CD가 EKS 앱에 반영합니다. Helm은 AWS Load Balancer Controller 설치에도 사용합니다. | [Argo 최초 인계](../../../infrastructure/eks/argo-cd.md), [Controller 설치 절차](../../../infrastructure/eks/api-entrypoint.md#실제-적용-전-준비) |
| 모바일 | React Native·Expo, 웹과 공통 계약, API origin 설정·Bearer 인증 | [모바일 안내](../../../frontend/mobile/README.md) |

## 요청·데이터 흐름

상단은 요청 순서이고, 가운데는 AWS·VPC·EKS와 namespace의 배치 경계입니다.
번호 ①·②는 API 목적지, ③·④는 EBS 저장소와 ECR 이미지 공급을 연결합니다.

| 경로 | 역할 |
|---|---|
| 웹 → API | Vercel이 서버에서 프록시 비밀값을 추가하고, Nginx가 검증합니다. CloudFront는 API만 중계하며 캐시를 사용하지 않습니다. |
| Nginx → Core·Ops | `/api/v1/ops`와 그 하위 경로는 Ops, 나머지 `/api/*`는 Core로 보냅니다. Ops는 Core의 관리자 세션을 확인합니다. |
| 모바일 → Core | 같은 Core API·계정 데이터를 사용합니다. 운영 HTTPS origin을 지정하며, 앱 기기와 운영 프록시를 함께 거치는 검증은 별도입니다. 프록시 비밀값은 앱에 넣지 않습니다. |
| Core·Catalog → 저장소 | 두 서비스는 MyBatis로 각자의 MySQL을 사용합니다. Core는 Redis와 Elasticsearch를 조회하며, Catalog는 공고·색인을 준비합니다. Core의 Outbox 발행기·소비자가 RabbitMQ를 사용합니다. |
| AI → 검색·관측 | Qdrant에서 벡터·원문 근거를 조회하고 OpenAI를 호출합니다. Langfuse SDK를 활성화한 경로의 trace를 내부 Langfuse에 보냅니다. |
| Ops → 평가 | Prefect·실행기가 평가하고 pandas·Pandera·지표 계산·Evidently 보고서·Langfuse 점수 등록을 이어갑니다. Evidently는 실행기가 생성하는 보고서이며 별도 상시 서버가 아닙니다. |
| 결과 → 관리자 | `ops-artifacts`는 결과 PVC를 읽기 전용으로 제공하고, `ops-sync`가 상태·결과를 반영합니다. 관리자는 같은 React 웹에서 검토·판정·비교 기준을 관리합니다. |
| 도구 UI | Prefect·Langfuse는 공개하지 않습니다. EKS 권한을 가진 사용자가 각 PC에서 loopback port-forward를 연결합니다. |

## AWS 저장·실행 경계

| 구성 | 범위 |
|---|---|
| EKS 워커 | `application`과 `observability`에 `m7i-flex.large`가 각각 1대입니다. AI는 observability 노드에 배치됩니다. namespace와 노드 풀은 서로 다른 구분입니다. |
| 가용 영역 | 제어면 서브넷은 2개 AZ를 사용하지만 두 워커는 `ap-southeast-2a`에 있습니다. 다중 AZ 고가용성 구성으로 표시하지 않습니다. |
| EBS | 데이터 PVC 13개는 업무 7개·평가 2개·관측 4개입니다. 암호화 gp3와 `Retain`을 사용합니다. MySQL 3개는 EKS StatefulSet으로 유지하며 RDS로 전환한 구성이 아닙니다. |
| ECR | 수동 이전 당시 실행 이미지 17개를 private ECR에 보존했습니다. 자동 배포 경로는 애플리케이션용 이미지 5개를 빌드하고 digest로 배포합니다. 두 범위를 구분합니다. |
| S3 | 암호화한 이전 백업·메타데이터 84개를 비공개·버전 관리 버킷에 보관한 기록입니다. 상시 DB 백업이나 로컬↔AWS 자동 데이터 동기화 기능을 뜻하지 않습니다. |
| 외부 호출 | private workload가 public subnet의 NAT Gateway와 Internet Gateway를 거쳐 OpenAI·공고 제공처 등 VPC 외부 API에 연결합니다. |

## 자동 배포 흐름

실선은 서비스 요청·데이터 관계, 회색 점선은 설정에 따른 연결·추가 검증 경로,
주황색 실선은 **CI 통과 후 자동 배포 경로**입니다.

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
SVG는 3,000 × 3,670, PNG는 6,000 × 7,340입니다.

로고는 [AWS·공통 로고 출처](aws-logo-sources.json)와
[Kubernetes·서비스 로고 출처](kubernetes-logo-sources.json)의 로컬 파일을 SHA-256으로 확인해 사용합니다.
MySQL은 노랑, Qdrant는 분홍, Elasticsearch는 청록, Redis는 주황을 유지했습니다.
로고 권리·라이선스는 [이미지 목록의 출처 안내](README.md#로고-출처)를 따릅니다.
