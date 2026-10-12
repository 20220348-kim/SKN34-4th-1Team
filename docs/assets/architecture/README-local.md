# GovBiz 로컬 시스템 아키텍처 — LLMOps Kubernetes 통합

[Docker Compose 로컬 구성](README-compose.md) · [아키텍처 이미지 목록](README.md)

**2026-10-13 기준, LLMOps Kubernetes 통합과 GitOps 전환 후의 자동 배포 구성**입니다.
업무 서비스·평가 실행·관측 저장소와 Argo CD를 같은 kind 클러스터 안에 배치하고 Namespace로 구분했습니다.
Argo 영역은 설치·최초 인계·활성화 후의 구조이며, 기본 개발 모드에서 자동으로 앱을 관리한다는 뜻은 아닙니다.
기존 그림의 Compose 평가 영역과 외부 HTTP 브리지를 Kubernetes Service·PVC로 교체했습니다.

![GovBiz 업무·평가·관측과 Argo CD를 포함한 로컬 Kubernetes 구성](govbiz-local-architecture.png?v=c4108a043e43)

## 파일

- [PNG](govbiz-local-architecture.png?v=c4108a043e43): 5,600 × 7,720, GitHub·발표 첨부용.
- [SVG](govbiz-local-architecture.svg?v=06115cccb76a): 2,800 × 3,860, 로고가 내장된 편집 가능한 원본.
- [생성 스크립트](build-local.mjs): 기존 로컬 로고를 사용하며 클러스터·GHCR에 접근하지 않습니다.
- 로고 출처·해시는 [Kubernetes 로고 목록](kubernetes-logo-sources.json), [RabbitMQ·MyBatis·OpenAI 로고 목록](logo-sources.json), [로고별 라이선스 안내](README.md#로고-출처)를 따릅니다.

## 1. Namespace와 실행·데이터 소유권

| namespace | 실행 서비스 | 보존 데이터 |
|---|---|---|
| `govbiz-msa` | Core·Catalog·AI·Ops API와 같은 Pod의 `ops-sync` | Core·Catalog·Ops MySQL, 업무용 Redis·Elasticsearch·Qdrant·RabbitMQ의 PVC |
| `govbiz-evaluation` | Prefect·`evaluation-runner`·`ops-artifacts` | Prefect SQLite 전용 PVC, 보고서·캡처·요약을 담는 결과 PVC |
| `govbiz-observability` | Langfuse web·worker | PostgreSQL·ClickHouse·Redis·MinIO의 전용 StatefulSet·PVC 4개 |
| `argocd` (GitOps 전환 시) | Argo CD Core의 application-controller·repo-server·ApplicationSet controller·Redis, 각각 Pod 1개 | 현재 Core 설치는 Argo용 PVC를 사용하지 않습니다. Git의 배포 설정과 Kubernetes의 Application·AppProject 리소스로 관리합니다. |

- Core는 Catalog의 인증된 snapshot을 조회해 자기 DB의 공고 복제본을 갱신합니다.
- Core·Catalog는 MyBatis Mapper·XML을 통해 각자의 MySQL에 접근합니다.
- Redis는 캐시·임시 상태 저장소, Elasticsearch는 검색 색인 저장소, RabbitMQ는 비동기 메시지 브로커로 구분합니다.
- Core는 Redis에 검색 결과·조건을 저장·복원하고 Elasticsearch에서 키워드 후보를 조회합니다. Catalog는 Elasticsearch 색인을 생성·갱신합니다.
- Ops는 Core 관리자 세션으로 권한을 확인하며, 평가·검토·예산은 별도 Ops MySQL에 보존합니다.
- 실행기와 결과 서버는 같은 노드의 결과 RWO PVC를 공유합니다. 실행기는 쓰고 결과 서버는 읽기 전용으로 접근합니다.
- Langfuse 저장소는 업무 DB·Redis 및 Prefect SQLite와 분리합니다. 평가·관측 PVC는 복원·보존 절차와 `Retain` 정책을 유지합니다.

근거: [서비스 Chart](../../../infrastructure/gitops/charts/),
[평가 Chart](../../../infrastructure/gitops/charts/govbiz-evaluation/),
[관측 Chart·PVC 계약](../../../infrastructure/gitops/charts/govbiz-observability/README.md).

### Argo CD도 kind 안에서 실행

로컬은 [단일 control-plane 노드의 kind 설정](../../../infrastructure/gitops/kind/local.yaml)을 사용합니다.
Argo CD의 4개 Pod도 같은 노드에서 실행하며 EKS의 application·observability EC2 구분은 적용하지 않습니다.
`argocd`는 `govbiz-observability`와 별도 Namespace입니다. 상단 배포 5단계의 Argo와
클러스터 내부 `argocd` 상자는 같은 구성 요소를 표현합니다.

고정 설치 버전은 **Argo CD Core 3.5.3**입니다. `application-controller`는 StatefulSet,
`repo-server`·`applicationset-controller`·Redis는 각각 Deployment입니다.
현재 Core 설치에는 Argo용 PVC와 상시 `argocd-server` 웹 서버 Pod가 없습니다.

`Git 배포 태그 → Argo → 로컬 Kubernetes API → 앱 Deployment 7개`가 배포 제어 경로입니다.
자동 Application은 `govbiz-local` 하나이며 웹·Core·Catalog·AI·Ops·평가 실행기·결과 서버를 관리합니다.
기반 저장소·Prefect·Langfuse와 Argo 자체 설치는 이 자동 Application의 관리 범위 밖입니다.
기본 개발 모드에서는 Argo가 업무 서비스를 소유하지 않으며, GitOps 전환 시 watcher 종료와
최초 인계가 필요합니다. 과거 서비스별 Application 4개를 만드는 경로와 새 자동 경로를 혼용하지 않습니다.

근거: [Argo 고정 설치 버전](../../../infrastructure/gitops/scripts/gitops_msa.py) ·
[Core 3.5.3 설치 리소스](https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.3/manifests/core-install.yaml) ·
[개발·GitOps 경계](../../../infrastructure/gitops/argocd/README.md) ·
[자동 동기화 대상과 최초 인계](../../../infrastructure/gitops/docs/local-auto-sync.md).

## 2. 내부 실행 경로

```text
React Ops → Ops API → Core 관리자 세션 확인 / Ops MySQL
                   → Prefect → evaluation-runner
                                 ├─ pandas·Pandera·프로젝트 지표·Evidently → 결과 PVC
                                 ├─ Langfuse 내부 Service → 관측 전용 저장소
                                 └─ Ops 내부 API → 승인·예산 계약

Ops API / ops-sync → Prefect 상태 조회
                  → ops-artifacts 인증 조회 → 결과 PVC·평가 자료
                  → Ops MySQL 갱신 → React 보고서·사람 검토·비교 기준

AI Service → Langfuse 내부 Service (SDK 활성화·키 설정 시)
```

namespace 사이의 요청은 **ClusterIP와 Service DNS**를 사용합니다.
Ops는 `prefect.govbiz-evaluation.svc.cluster.local:4200`과
`ops-artifacts.govbiz-evaluation.svc.cluster.local:8010`에 연결합니다.
실행기는 `ops-service.govbiz-msa.svc.cluster.local:8000` 및
`langfuse-web.govbiz-observability.svc.cluster.local:3000`을 사용합니다.
NetworkPolicy로 통신 범위를 제한하고 인증값은 Secret으로 주입합니다.

현재 평가 Chart는 **저장 응답 재평가**를 실행하며 새 답변·새 RAG·정기 실행은 비활성입니다.
Kubernetes로 옮겼다는 이유로 유료 모델 호출을 켜지 않습니다. 해당 실행은 승인·예산·실행 설정을 갖춘 뒤 활성화하는 별도 범위입니다.
실행 완료는 품질 합격과 구분하며, 사람이 검토한 결과를 관리자가 비교 기준으로 지정합니다.

### 외부 API 연결

그림의 외부 API 영역은 **kind 클러스터 밖의 서비스**입니다. 내부 Pod에서 시작한 요청이
개발 PC의 인터넷 연결을 통해 나가며, 웹에 접속할 때 사용하는 port-forward를 거치는 경로는 아닙니다.
보라색 화살표는 외부 API 요청입니다. 영역 왼쪽의 Catalog·AI는 위에 나온 서비스의 호출 경로를 다시 표시한 것입니다.

| 호출 주체 → 외부 대상 | 하는 일과 실행 조건 |
|---|---|
| **Catalog → 공고 제공처 API** | 기업마당·K-Startup·과학기술정보통신부(MSIT)·충남 수출지원(CNTRADE_NOTICE)의 공고를 수집합니다. 기본 API 주소는 `https://apis.data.go.kr`이며 제공처별 키가 필요합니다. 로컬 기본 설정의 정기 수집은 꺼져 있고, 수집 실행 또는 스케줄 활성화 시 요청합니다. |
| **AI Service → OpenAI** | 답변 생성·추천·RAG와 임베딩에 사용합니다. `OPENAI_API_KEY`와 모델 설정을 갖추고 해당 기능을 호출할 때 외부 요청이 발생합니다. Catalog가 AI에 색인을 요청하면 임베딩의 실제 OpenAI 호출도 AI Service가 담당합니다. |

평가 코드에도 새 응답을 생성하는 OpenAI 호출이 있지만, **현재 Kubernetes 평가 실행기에는 연결을 열어 두지 않았습니다.**
Chart는 live·RAG live를 `false`, OpenAI 키를 빈 값으로 고정하고 NetworkPolicy는 DNS·Prefect·Ops·Langfuse만 허용합니다.
따라서 실행기에서 OpenAI로 향하는 선을 현재 사용 가능한 연결로 그리지 않았습니다.
추후 유료 평가를 활성화하려면 승인·예산뿐 아니라 키 주입과 외부 통신 정책 변경도 필요합니다.

주요 공고·AI 경로를 보여 주는 그림이므로 Core의 Google·Kakao OAuth, Bizno 사업자 조회,
SMTP 메일, 기업마당 원문·첨부 조회 등 기능별 보조 연동은 개별 선으로 표시하지 않았습니다.
이번 변경은 코드와 설정을 바탕으로 그림을 보완한 것이며 외부 API 호출·키 유효성·배포 상태를 새로 검증한 기록은 아닙니다.

근거: [Catalog 제공처·수집 설정](../../../backend/catalog-service/src/main/resources/application.properties) ·
[로컬 Catalog 설정](../../../infrastructure/gitops/environments/local-msa/catalog-service.yaml) ·
[AI OpenAI 클라이언트](../../../backend/ai-service/app/bootstrap.py) ·
[AI Secret 참조](../../../infrastructure/gitops/environments/in-cluster/ai-service.yaml) ·
[평가 실행기 설정](../../../infrastructure/gitops/charts/govbiz-evaluation/templates/workload.yaml) ·
[평가 통신 정책](../../../infrastructure/gitops/charts/govbiz-evaluation/templates/network-policy.yaml) ·
[Core 보조 연동 설정](../../../backend/core-service/src/main/resources/application.properties).

## 3. 로컬 화면 접근

개발 웹은 PC의 React/Vite에서 실행하며 API를 loopback port-forward로 연결합니다.
배포 웹은 Kubernetes의 `web` Nginx가 Core·Ops의 내부 Service로 프록시하고 `localhost:18173` 포워딩으로 접근합니다.
모바일은 iOS·Android의 React Native·Expo 앱이며, `EXPO_PUBLIC_API_BASE_URL`에 지정한 API origin으로
같은 Core API를 호출합니다. 웹·앱은 `@govbiz/shared`의 업무 모델·API 계약·응답 검증을 공유합니다.

| 로컬 진입 | Kubernetes 대상 |
|---|---|
| 배포 웹 `localhost:18173` | `web :8080` → 내부 Core·Ops Service |
| `localhost:5173`의 `/api/*` | Vite → `127.0.0.1:18080` → Core `:8080` |
| 같은 웹의 `/api/v1/ops/*` | Vite → `127.0.0.1:18001` → Ops `:8000` |
| 모바일 앱의 `/api/*` | 기기에서 접근 가능한 Core API origin → Core `:8080` (Bearer 인증) |
| Prefect `localhost:14200` | `govbiz-evaluation`의 Prefect `:4200` |
| Langfuse `localhost:13000` | `govbiz-observability`의 Langfuse web `:3000` |

관리 화면은 `/ops/evaluations`이며, 기존 Core 관리자 계정을 사용합니다.
Ops 프록시는 Host·Origin을 보존해 CSRF를 검증합니다. 모바일은 Core에서 발급한 Bearer 세션을 사용합니다.

Kubernetes의 Core 포워딩 포트는 `18080`입니다. iOS 시뮬레이터는 `http://localhost:18080`,
Android 에뮬레이터는 `http://10.0.2.2:18080`을 앱의 API origin으로 지정합니다.
실기기는 PC의 loopback 주소에 직접 접근할 수 없으므로 USB `adb reverse`나 기기에서 접근 가능한
별도 개발 API 주소가 필요합니다. USB Android에서는 `adb reverse tcp:18080 tcp:18080` 후
`http://localhost:18080`을 사용합니다. 외부 ingress·TLS 및 실제 기기 연결 검증은 별도입니다.

근거: [모바일 실행·인증](../../../frontend/mobile/README.md#로컬-실행) ·
[모바일 API 주소·인증 구현](../../../frontend/mobile/src/api/client.ts) · [웹·앱 공통 계약](../../mobile-monorepo.md).

## 4. 소스·검증·로컬 배포 5단계

| 단계 | 역할과 결과 |
|---|---|
| **1. 소스 · 개인 포크** | 원본 main에 PR을 병합하고 개인 포크 main을 동기화합니다. 애플리케이션 소스와 Helm Chart를 같은 저장소에서 관리합니다. |
| **2. 필수 CI 5개** | 최신 main의 같은 소스 SHA에 대해 GovBiz·Catalog·Ops·LLMOps·Infra 필수 작업이 모두 통과해야 이미지 발행으로 진행합니다. |
| **3. GHCR 이미지 발행** | 웹·백엔드·평가 실행기 이미지를 빌드·검증·발행하고, 내용이 고정된 이미지 식별자인 digest를 배포에 사용합니다. |
| **4. Helm 배포 YAML 생성** | 검증된 소스의 Chart 템플릿에 로컬 환경의 `values`와 이미지 digest를 넣고 `helm template`으로 Deployment·Service·Job 등의 Kubernetes YAML을 생성합니다. CI 워크플로가 이 결과를 불변 Git 태그 `govbiz-local/v1.RUN.ATTEMPT`로 발행합니다. |
| **5. Argo CD 자동 동기화** | 검증된 배포 태그의 YAML에 Kustomize로 기존 환경·Secret 참조·PVC 연결을 반영한 뒤 kind에 자동 동기화합니다. 접수 중지·migration·앱 갱신을 거쳐 정상 상태와 평가 연결을 확인하면 접수를 재개합니다. |

**Helm은 Kubernetes 배포 설정을 재사용할 수 있는 Chart로 관리하는 도구**입니다.
Chart가 리소스의 틀을 정의하고 `values`가 환경별 설정을 채웁니다.
이 경로에서 Helm은 CI에서 배포 YAML을 생성하며, 실제 클러스터 반영은 Argo CD가 담당합니다.

한 Application이 웹·업무·평가 앱 7개를 관리합니다. 접수 중지·진행 평가 확인·migration 후 교체하고,
정상 상태와 평가 연결을 확인한 뒤 접수를 복구합니다. 자동 prune·selfHeal은 끕니다.
기존 수동 Application의 최초 인계와 원격 활성화는 [자동 배포 안내](../../../infrastructure/gitops/docs/local-auto-sync.md)를 따릅니다.
Prefect 서버·Langfuse·데이터 저장소의 설치 및 업그레이드는 별도이며 기존 실행 상태를 유지합니다.
Secret·PVC는 별도 절차로 준비·보존하며, 앱 갱신과 데이터 삭제를 연결하지 않습니다.
웹 개발은 Vite HMR, 모바일 개발은 Expo Fast Refresh를 사용합니다.
Argo에 인계하지 않은 개발 환경의 선택 업무 서비스는 기존 `dev.py`의 Docker 빌드·kind 적재·rollout 경로를 사용합니다.

- [이미지 발행](../../msa-image-release.md) · [개인 Kubernetes 개발](../../local-fork-development.md)
- [평가 환경 이전·PVC 복원 기록](../../../infrastructure/gitops/docs/evaluation-kubernetes.md)
- [Langfuse·전용 저장소 이전 기록](../../../infrastructure/gitops/docs/langfuse-kubernetes.md)

## 그림의 기준

요청한 **LLMOps 전체 Kubernetes 전환 후 구조**를 표현했습니다. 저장소에는 2026-10-10 개인 환경의
Prefect·실행기·결과 서버 및 Langfuse 6개 구성요소 이전 기록이 있습니다. 실제 검증 대상과 결과는 위 이전 문서를 따릅니다.
자동 배포 코드·문서를 추가했으며 원격 변수·기존 Application은 아직 변경하지 않았습니다.
이 그림을 만들면서 클러스터·데이터를 변경하거나 새 평가를 실행하지 않았으며, 실시간 Ready 상태를 재확인한 그림은 아닙니다.
단일 kind 환경의 전환을 고가용성·외부 운영 배포·유료 모델 품질 검증 완료로 해석하지 않습니다.

## 재생성

저장소 기준 Node 24.x와 기존 도구 환경의 Playwright·Chrome을 사용합니다. 앱 의존성을 추가하지 않습니다.

```bash
node docs/assets/architecture/build-local.mjs

GOVBIZ_DIAGRAM_NODE_MODULES=/path/to/tooling/node_modules \
GOVBIZ_DIAGRAM_CHROME=/path/to/chrome \
node docs/assets/architecture/build-local.mjs --render
```

렌더러는 외부 요청을 차단하고 로고 해시·로딩·텍스트 폭·캔버스 경계를 검사합니다.
PNG를 눈으로 확인해 연결선·영역 경계·글자 겹침도 점검합니다.
