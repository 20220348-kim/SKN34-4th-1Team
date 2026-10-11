# GovBiz Docker Compose 로컬 전체 구성도

[문서 안내](../../README.md) · [이미지 목록](README.md) · [Kubernetes 로컬 구성](README-local.md)

호스트 React/Vite·Expo와 **Catalog 분리형 업무 Compose + 별도 LLMOps Compose**를 연결한 구성입니다.
2026-10-12 저장소의 Compose·프록시 설정을 기준으로 작성했습니다. 실제 컨테이너를 시작하거나
현재 데이터·포트·환경변수를 변경해 검증한 기록은 아닙니다.

![GovBiz Docker Compose 로컬 전체 구성도](govbiz-compose-architecture.png?v=127a77d72a67)

[PNG 크게 보기](govbiz-compose-architecture.png?v=127a77d72a67) · [SVG 원본](govbiz-compose-architecture.svg?v=8b508bff3504) · [생성 스크립트](build-compose.mjs)

## 그림에서 선택한 실행 경로

| 영역 | 구성·근거 |
|---|---|
| 호스트 웹 | `pnpm dev:web`으로 React/Vite를 실행합니다. [Vite](../../../frontend/web/vite.config.ts)는 기본적으로 Core `localhost:8080`, LLMOps Ops `127.0.0.1:18001`에 프록시합니다. |
| 업무 Compose | [업무 서비스](../../../infrastructure/compose.yaml)에 [Catalog overlay](../../../infrastructure/compose.catalog.yaml)를 합친 Core·Catalog·AI와 저장소입니다. 호스트 Vite를 사용할 때 같은 포트의 Compose `web`은 함께 시작하지 않습니다. |
| LLMOps Compose | [관측·Prefect](../../../infrastructure/llmops/compose.yaml)와 [Ops·실행기](../../../infrastructure/llmops/compose.ops.yaml)를 `evaluation` profile로 실행합니다. `ops-mysql`·`ops-bootstrap`으로 초기화를 확인하고 Django Ops·ops-sync·평가 실행기를 각각 독립 컨테이너로 시작합니다. |
| 선택 결과 서버 | [artifact overlay](../../../infrastructure/llmops/compose.artifacts.yaml)를 추가하면 Ops API·sync의 결과·평가 자료 mount를 제거하고 인증 HTTP로 조회합니다. 무료 평가용이며 모델 호출은 비활성화합니다. |
| 모바일 | 호스트 Expo·iOS/Android 앱에서 같은 Core API를 사용합니다. API origin·Bearer 인증·USB reverse 등은 [모바일 실행 안내](../../../frontend/mobile/README.md#로컬-실행)를 따릅니다. |

업무 Compose에서는 Core·Catalog·AI·Qdrant 등 필요한 서비스만 선택합니다. LLMOps는 별도 프로젝트로
실행하며 프로젝트·네트워크·볼륨을 자동으로 합치지 않습니다. 실제 시작 명령·환경 파일 준비는
[업무 인프라](../../../infrastructure/README.md), [Catalog 분리](../../catalog-service-extraction.md),
[LLMOps 실행](../../../infrastructure/llmops/README.md#compose-시작)을 따릅니다.

## 루트 기본 Compose와 다른 점

[루트 `compose.yaml`](../../../compose.yaml)은 웹·Core·Catalog·AI·Django Ops와 저장소를 함께 실행합니다.
기본 Ops 공개 포트는 `8001`이며, 같은 네트워크의 웹은 `ops-service:8000`으로 요청합니다.
`ops-bootstrap`이 빈 DB의 스키마·공유 검토 자료를 준비하고 기존 이력은 보존합니다.
이 루트 설정만으로 Prefect·평가 실행기·Langfuse까지 시작되지는 않습니다.

그림은 전체 평가 기능을 함께 볼 수 있도록 **LLMOps 전용 Ops(`18001`) 경로**를 선택했습니다.
이 Ops의 `govbiz_ops_llmops` DB와 `ops-results` 볼륨은 루트 통합 Ops와 별개입니다.
한 화면에서 두 Ops의 이력을 합쳐 보여주지 않으며, 웹의 프록시 대상에 따라 조회하는 이력이 달라집니다.
루트 기본 통합 실행은 [모노레포 개발 안내](../../ops-monorepo-migration.md#로컬-개발-시작)를 따릅니다.

## 연결과 저장소

| 경로 | 실제 연결 방식 |
|---|---|
| 브라우저 → 웹 → Core·Ops | 호스트 Vite `5173` → Core `8080` 또는 LLMOps Ops `18001`. 같은 웹에서 기존 Core 관리자 계정으로 로그인합니다. |
| Core·Catalog → AI | 업무 Compose DNS의 `ai-service:8000`. Catalog는 공고·색인을 준비하고 Core는 인증된 snapshot을 자기 DB의 조회용 복제본에 반영합니다. |
| Core·Catalog → MySQL | 각각 MyBatis Mapper·XML을 사용합니다. Core는 `mysql`, Catalog는 `catalog-mysql`과 별도 named volume을 사용합니다. |
| 검색·비동기 | Core는 Redis에 검색 결과·조건을 저장하고 Elasticsearch를 조회합니다. Catalog는 Elasticsearch 색인을 준비하며 AI는 Qdrant를 사용합니다. Core의 발행기·소비자는 RabbitMQ와 연결합니다. |
| Ops → Core 인증 | 기본 `host.docker.internal:8080`으로 관리자 세션을 확인합니다. Docker Desktop 호스트 연결 기준이며 Linux의 host-gateway·바인딩은 실행 환경에 맞게 확인합니다. |
| Core·AI → Langfuse | 추적 활성화·키와 호스트 접근 주소를 설정한 경우에 연결합니다. Docker Desktop 주소 예시는 `http://host.docker.internal:13000`입니다. 기본 업무 Compose에서 자동 활성화되지 않습니다. |
| 평가 실행·결과 | Ops → Prefect → 실행기. 실행기는 `ops-results`에 쓰고 Ops API·sync는 읽기 전용으로 조회합니다. 원본 평가 자료는 별도 bind mount이며 HTTP overlay에서는 결과 서버가 제공합니다. |
| 상태·예산 | `ops-sync`가 Prefect 상태와 결과를 Ops MySQL에 반영합니다. 실행기는 같은 LLMOps 네트워크의 Ops 내부 API로 승인·예산 계약을 확인합니다. |
| 관측 저장 | Langfuse Web·Worker는 전용 PostgreSQL·ClickHouse·Redis·MinIO와 네 개의 named volume을 사용합니다. 업무 DB·Redis와 공유하지 않습니다. |
| Prefect 저장 | `prefect-data`에 SQLite를 보존합니다. Langfuse PostgreSQL을 Prefect DB로 사용하지 않습니다. |

UI 공개 포트는 Prefect `14200`, Langfuse `13000`입니다. 기본 Compose의 호스트 포트는
loopback에 제한되므로 모바일 실기기에 PC의 `localhost` 주소를 그대로 넣지 않습니다.
새 답변·RAG·정기 평가는 승인·예산·명시적인 실행 설정이 필요한 별도 경로입니다.
Evidently는 실행기가 만드는 보고서이며 독립 상시 서버가 아닙니다.

## 개발 반영과 Kubernetes와의 차이

| 구분 | Compose | Kubernetes(kind) |
|---|---|---|
| 실행 경계 | 프로젝트·컨테이너·Compose 네트워크 | 클러스터·namespace·Pod·Service |
| 로컬 접근 | 공개 호스트 포트 | port-forward 또는 배포 웹의 내부 프록시 |
| 데이터 보존 | named volume·선택한 bind mount | PVC·Secret·별도 복원 절차 |
| 앱 반영 | 이미지 build 후 대상 컨테이너 갱신, 웹 HMR·앱 Fast Refresh | 검증된 이미지·Helm YAML·Git 태그를 Argo CD로 반영 |
| Ops 동기화 | 독립 `ops-sync` 컨테이너 | Ops API와 같은 Pod의 별도 컨테이너 |

DB·결과 볼륨과 프로젝트 이름을 보존하며 앱 컨테이너를 갱신합니다.
Compose 설정·이미지 변경을 저장하는 것만으로 실행 중인 컨테이너가 자동 갱신되지는 않습니다.

## 재생성과 검증

```sh
node docs/assets/architecture/build-compose.mjs

GOVBIZ_DIAGRAM_NODE_MODULES=/path/to/tooling/node_modules \
GOVBIZ_DIAGRAM_CHROME=/path/to/chrome \
node docs/assets/architecture/build-compose.mjs --render
```

SVG는 2,800 × 2,900, PNG는 5,600 × 5,800입니다.
기존 로컬 로고를 사용하며 출처·해시는 [Kubernetes 로고 목록](kubernetes-logo-sources.json)과
[공통 로고 목록](logo-sources.json), 라이선스는 [이미지 목록](README.md#로고-출처)을 따릅니다.
렌더링은 네트워크 요청을 차단하고 로고 로딩·해시·텍스트 폭·캔버스 경계를 검사합니다.
문서·이미지 변경에는 Compose 기동·유료 API 호출·데이터 이전을 포함하지 않습니다.
