# GovBiz 로컬 시스템 아키텍처 — Kubernetes와 LLMOps

**2026-10-07의 저장소 코드 기준**으로 Kubernetes 업무 서비스와 Compose 평가 실행 환경의 연결을 그렸습니다.
9월 21일 그림의 Ops 확장 예정 표기와 기존 Argo 자동 배포 경로를 현재 구현에 맞춰 교체했습니다.
이 그림은 연결 프로필의 배치 구조이며, 모든 구성요소가 지금 실행 중이라는 의미는 아닙니다.

![GovBiz Kubernetes 업무 서비스와 Compose LLMOps 연결 구조](govbiz-local-architecture.png?v=4f2deb366694)

## 파일

- [PNG](govbiz-local-architecture.png?v=4f2deb366694): 5,600 × 5,020, GitHub·발표 첨부용.
- [SVG](govbiz-local-architecture.svg): 2,800 × 2,510, 로고가 내장된 편집 가능한 원본.
- [생성 스크립트](build-local.mjs): 기존 로컬 로고만 사용하며 클러스터·GHCR에 접근하지 않습니다.
- 로고는 [기존 Kubernetes 출처·해시](kubernetes-logo-sources.json), [RabbitMQ 출처·해시](logo-sources.json), [Devicon 라이선스](DEVICON-LICENSE)를 재사용합니다.

## 1. 사용자 요청과 서비스 배치

브라우저는 PC의 React/Vite `localhost:5173`을 사용합니다. Kubernetes 모드의 Vite는
일반 `/api/*`를 Core port-forward `127.0.0.1:18080`으로, `/api/v1/ops/*`를
Ops port-forward `127.0.0.1:18001`로 보냅니다. Ops 요청은 Host와 Origin을 보존해 CSRF를 검증합니다.
화면은 같은 웹 앱이며, 관리자는 `/ops/evaluations`에서 평가를 운영합니다.

| Kubernetes 구성 | 기술·내부 포트 | 책임과 데이터 |
|---|---|---|
| Core API | Spring Boot / Kotlin · 8080 | 계정·기업·신청·협업, 검색 조합과 원문 검증. Core MySQL 사용 |
| Catalog | Spring Boot / Kotlin · 8081 | 공고 수집·정규화·색인 소유, 인증된 HTTP snapshot 제공. Catalog MySQL 사용 |
| AI Service | FastAPI / Python · 8000 | OpenAI·LangChain·LangGraph를 통한 임베딩·추천·근거 답변·문서·도우미 처리. Qdrant 사용 |
| Ops API + ops-sync | Django / Gunicorn · 8000 | 관리자 권한 확인, 평가·예산·취소·검토·품질 판정·기준·복구 관리. 같은 Pod에서 같은 Ops 이미지·DB 사용 |
| Ops MySQL | MySQL 8.4 · 3306 | 실행·검토·판정·비교 기준·예산·일정의 독립 저장소 |

- Core는 Catalog snapshot을 검증해 조회용 복제본을 자기 DB에 반영합니다. 다른 서비스 DB를 직접 읽지 않습니다.
- Ops는 Core `/api/v1/admin/session`으로 기존 관리자 세션을 확인합니다. Django 별도 계정으로 사용자를 다시 인증하지 않습니다.
- Redis는 Core 검색 결과·조건 복원, Elasticsearch는 Catalog 색인·Core 키워드 조회, RabbitMQ는 Core 비동기 작업을 담당합니다.
- MySQL 세 개와 Redis·Elasticsearch·Qdrant·RabbitMQ는 StatefulSet·PVC로 보존합니다. 서비스 통신에는 Kubernetes DNS를 사용합니다.
- 연결된 Ops 갱신은 migration·접수 상태·백업·실행 release를 확인하는 전용 절차를 사용합니다. API와 ops-sync의 시작 순서를 전제하지 않습니다.
- 모바일은 같은 Core API·공통 TypeScript 계약을 사용합니다. 이 그림의 클라이언트 진입은 로컬 웹 기준이며 실기기 네트워크 연결은 별도입니다.

근거: [Vite 프록시](../../../frontend/web/vite.config.ts),
[서비스 Helm Chart](../../../infrastructure/gitops/charts/),
[데이터 Chart](../../../infrastructure/gitops/charts/govbiz-local-data/),
[서비스 호출·소유권](../../architecture.md).

## 2. Kubernetes Ops와 Compose 평가 환경

Prefect·평가 실행기·결과 저장소·Langfuse는 Compose에 둡니다.
Kubernetes Ops와 연결할 때 Compose에 Ops API·동기화·DB를 중복으로 기동하지 않습니다.
독립 Compose 모드에서는 Ops API·ops-sync·Ops MySQL도 Compose에서 실행할 수 있습니다.

```text
React Ops → Kubernetes Ops API → Core 관리자 세션 확인 / Ops MySQL
                              → 내부 HTTP 브리지 → Compose Prefect
                                                    ↓
                                              평가 실행기
                                         pandas → Pandera → 지표
                                           ├─ Evidently 보고서 → 결과 볼륨
                                           └─ Langfuse 점수·호출 추적

Kubernetes Ops API / ops-sync → 내부 HTTP 브리지 → Prefect 상태 조회
                                               → ops-artifacts 인증 조회
                                                   └─ 결과 볼륨·평가 자료 읽기
                             → Ops MySQL 상태 갱신 → React에서 결과·검토 표시
```

브리지는 selector 없는 Kubernetes Service·EndpointSlice와 전용 Docker 내부 네트워크를 연결합니다.
이 네트워크에는 해당 kind 노드·Prefect·결과 서버가 참가합니다. Compose DNS 이름을 Pod에서
그대로 해석한다고 가정하거나 결과 볼륨을 Kubernetes에 자동 공유하지 않습니다.

| Compose 구성 | 역할과 보존 위치 |
|---|---|
| Prefect | flow 접수·실행 상태·로그. 이 구성에서는 자체 SQLite와 `prefect-data` 볼륨 사용. UI `localhost:14200` |
| 평가 실행기 | pandas 집계·Pandera 형식 검증·프로젝트 지표 계산·Evidently 보고서·Langfuse 점수 등록 |
| 결과 볼륨 | 실행기가 `/results`에 보고서·요약·요청 등 결과 파일 기록 |
| ops-artifacts | 내부 8010 포트의 전용 토큰 인증 HTTP. 결과 볼륨과 평가 자료를 읽기 전용으로 제공 |
| Langfuse Web / Worker | 호출 추적·토큰·지연·오류·평가 점수. UI `localhost:13000` |
| Langfuse 저장소 | PostgreSQL·ClickHouse·Redis·MinIO와 각 볼륨. 업무용 MySQL·Redis 및 Prefect SQLite와 분리 |

`ops-compose-prefect:4200`과 `ops-compose-artifacts:8010`이 Kubernetes 측 브리지 서비스입니다.
컨테이너 교체 시 EndpointSlice 주소를 다시 검사·갱신하는 도구가 있으며, 단순 Pod Ready만으로
브리지·실행기·보고서의 정상 동작을 판단하지 않습니다.

**현재 Kubernetes 연결의 평가 범위는 저장 응답의 무료 재평가입니다.**
새 답변·RAG의 유료 실행은 Compose Ops의 승인·예약·호출별 정산 경로와 구분합니다.
실행기에서 Kubernetes 예산 API로 돌아오는 live 연결은 별도 작업이며 이 그림에 완료 경로로 넣지 않았습니다.
AI Service의 Langfuse SDK도 활성화·접속 설정이 필요하며, 위 Prefect·결과 브리지가 Langfuse 연결까지 대신하지 않습니다.

근거: [Ops 연결 계약·무료 통합 검증](../../../infrastructure/gitops/docs/ops-runtime.md),
[브리지 Compose](../../../infrastructure/llmops/compose.kind.yaml),
[읽기 전용 결과 서버](../../../infrastructure/llmops/compose.artifacts.yaml),
[LLMOps Compose](../../../infrastructure/llmops/compose.yaml),
[평가 실행기 구성](../../../infrastructure/llmops/compose.ops.yaml).

## 3. 평가 결과와 사람 검토

관리자는 자료·실행 방식을 선택하고 결과 보고서·후보 답변·기존 기준을 비교합니다.
자료와 사례별 답변의 판단·사유, 실행 검토 승인, 정책 기반 품질 판정과 비교 기준 변경은 Ops DB에 남습니다.
합격한 결과를 관리자가 기준으로 지정하면 다음 평가에서 같은 자료의 후보와 비교합니다.

- `COMPLETED`는 작업 완료이며 품질 합격을 뜻하지 않습니다.
- 저장 기록 재평가는 새 모델 호출이 없습니다. 합성 대역·과거 모델·미검토 참조의 출처를 유지합니다.
- 고정 근거 새 답변과 새 RAG는 승인·예산 한도 안에서만 호출합니다. 등록된 자료의 평가를 전체 서비스 검색 품질로 확대 해석하지 않습니다.
- 호출 추적은 실행 중에도 수집합니다. 저장 응답에 없던 과거 trace를 재평가 시 만들어 붙이지 않습니다.
- 사람 검토와 비교 기준은 자동 승인하지 않습니다. 검토 기록 재사용·백업·복구는 기존 관리 도구를 사용합니다.

세부 기능은 [Ops API](../../../backend/ops-service/README.md),
[평가 자료·지표](../../../evaluation/support-program-evidence/README.md),
[기록 재사용](../../ops-local-review-copy.md), [갱신·백업·복구](../../ops-upgrade-runbook.md)를 참고하세요.

## 4. 이미지 공급과 로컬 개발

교육기관 원본에 PR을 병합하고 개인 포크 `main`을 동기화합니다.
이미지 발행은 같은 SHA의 **GovBiz·Catalog·Ops·LLMOps·Infra CI**와 필수 작업 성공,
이미지 검증 및 개인 포크의 명시적 활성화를 요구합니다.

로컬 환경은 소스 빌드 이미지의 `up --local-images` 또는 검증된 GHCR 이미지의 `up`으로 준비합니다.
개발 중에는 `dev.py`로 선택 서비스만 Docker 빌드 → kind 적재 → rollout하며 웹은 Vite HMR을 사용합니다.
이미 연결된 Ops는 실행 중 작업·migration·백업을 확인하는 전용 갱신 경로로 관리합니다.

새 Argo 자동 배포 연결은 제공하지 않습니다. `plan-gitops`는 검증된 이미지·소스 SHA로 고정한
수동 동기화 계획을 출력하지만 적용·자동 동기화를 수행하지 않습니다.
예전 digest 자동 커밋·Argo auto-sync를 현재 실행 경로로 표시하지 않았습니다.

근거: [개인 Kubernetes 개발](../../local-fork-development.md),
[현재 Kubernetes 도구](../../../infrastructure/gitops/README.md),
[이미지 발행](../../msa-image-release.md),
[배포 경로 변경](../../../infrastructure/gitops/docs/deployment-candidates.md).
과거 확인 결과는 [2026-09-21 GitOps 검증](../../fork-gitops-validation-20260921.md)에 보존합니다.

## 현재 확인 범위

2026-10-07 작성 시 읽기 전용으로 확인한 결과입니다.

- 현재 checkout은 `skn-260`입니다. 그림은 이 checkout의 프록시·Helm·Compose·연결 도구를 기준으로 작성했습니다.
- `docker ps`에서 Compose의 Ops API·ops-sync·Ops MySQL, Prefect·평가 실행기·Langfuse와 저장소 컨테이너 실행을 확인했습니다.
- 저장된 개인 kubeconfig의 Kubernetes API 주소는 연결을 거절했습니다. 현재 클러스터 Ready·Ops 브리지 연결 상태는 재확인하지 못했습니다.
- 현재 가동 관측은 **Compose Ops 모드**이고, 그림의 **Kubernetes Ops 연결 프로필**과 다릅니다. 그림을 만들기 위해 클러스터를 시작하거나 DB·볼륨·실행 설정을 변경하지 않았습니다.
- 새 모델 호출·평가·사람 승인·이미지 발행·배포를 수행하지 않았습니다. 이 문서 수정으로 CI 통과나 운영 배포 완료를 주장하지 않습니다.

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
