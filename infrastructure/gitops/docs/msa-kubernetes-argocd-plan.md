# GovBiz MSA·Kubernetes·Argo CD 전환 설계

> 이 문서는 원본 두 저장소를 기준으로 한 **기존 설계와 단계별 목표**를 보존합니다.
> 현재 앱과 GitOps는 한 저장소에 있으며, 개인 fork의 GHCR·상시 배포 연결은 별도 미완료입니다.
> 현재 경로와 실제 구현 범위는 [GitOps README](../README.md)를 따릅니다.

이 문서는 현재 코드를 확인한 **단계별 전환 계획**이다. 저장소 경계는 웹·모바일·공통 패키지와 `core-service`·`catalog-service`·`ai-service`·`ops-service`를 GovBiz에 통합하고 GovBiz-infra를 배포 설정 저장소로 유지한다. 두 저장소의 기본 브랜치는 `develop`이다.
후속으로 `ops-service`의 Gunicorn 실행 이미지와 로컬 Kubernetes 리소스·검증 도구를 추가했다.
[최신 실행 범위](msa-local.md)와 [서비스 경계 계약](service-boundaries.md)을 우선 참고한다.
후속 변경으로 네 서비스 Helm values와 로컬 Argo CD AppProject·Application·검증 도구를 구현했다.
아래는 초기 전환 계획이며, 실제 실행 완료 범위는 메인 README의 검증 기록을 기준으로 한다.
후속으로 GHCR 서비스별 이미지 발행 CI와 digest 선택 도구를 구현했다. 사용자 선택은 공개 GHCR 패키지이며,
AWS 운영 전환·이미지 digest 자동 승격·상시 클러스터 연결은 아직 구현하지 않았다.
현재 소스 경로는 `backend/{core-service,catalog-service,ai-service,ops-service}`이며,
아래 초기 분석의 커밋 고정 링크는 당시 경로를 유지한다.
사용자 결정: **Kubernetes는 포트폴리오 필수 목표이며, 우선 로컬에서 검증하고 운영 환경은 나중에 결정한다.** EKS 또는 EC2 운영을 현재 전제로 확정하지 않는다.

## 1. 확인한 현재 상태

초기 소스 분석 기준: GovBiz-infra `58c65aa`, GovBiz `3489756`, GovBiz-ops `611232d`.
이후 승인된 저장소 경계 변경은 [전환 기록](repository-transition.md)에 정리했다. 아래 소스 링크는 분석 당시 커밋을 고정하며 현재 운영 상태의 증거가 아니다.

| 영역 | 현재 구현 | 전환 시 의미 |
| --- | --- | --- |
| 통합 실행 | GovBiz의 로컬 Compose가 `core-service`·`ai-service`·`ops-service` 등을 연결; infra submodule 사용 종료 | 애플리케이션 PR은 같은 저장소에서, 향후 환경별 배포 설정 PR은 infra에서 관리 |
| `core-service` (Spring Boot) | 계정, 공고, 신청 준비, 중복 검토, 파트너, 리포트, 관리자 기능 | 업무별 직접 호출과 데이터 의존 관계를 풀어야 서비스가 독립된다 |
| `catalog-service` (Spring Boot, 후속 분리) | 독립 공고 DB·수집·게시·색인, 인증된 HTTP snapshot 제공 | 선택형 로컬 분리 검증 완료; `core-service`의 조회용 복제본과 운영 전환 조건은 별도 관리 |
| `ai-service` (FastAPI) | 조건 해석, 검색·색인·근거 답변, 문서 분석, 도우미 | 별도 실행 프로세스를 유지하고 `core-service`와의 릴리스 결합을 해소한 뒤 추가 분리를 판단한다 |
| `ops-service` (Django) | 상태 확인 API, 전용 MySQL; 후속 변경에서 이미지 기본 실행을 Gunicorn으로 변경 | 개발 Compose만 runserver 유지; 인증 연동과 운영 관리 업무는 미구현 |
| AWS 배포 코드 | CodeBuild 검증·이미지 빌드 → ECR → SSM → EC2 Compose | 이미지 빌드는 CI에, Kubernetes 배포는 Argo CD에 맡긴다 |
| 운영 DB 설정 | 운영 Compose의 `core-service`는 RDS에 연결 | Kubernetes 도입만을 이유로 DB를 클러스터 안으로 옮기지 않는다 |

확인한 파일과 현재 위치:

- 로컬 통합 Compose와 `ops-service` 연결은 GovBiz의 `compose.yaml`, `compose.ops.yaml`에서 관리한다. [전환 안내](repository-transition.md)
- [운영 Compose](https://github.com/GovBiz-Team/GovBiz/blob/34897562fcf16e30f7c811ad29eaa4b305f4f3ef/infrastructure/compose.prod.yaml)
- [CodeBuild 설정](https://github.com/GovBiz-Team/GovBiz/blob/34897562fcf16e30f7c811ad29eaa4b305f4f3ef/infrastructure/codebuild/backend.yml), [릴리스 실행](https://github.com/GovBiz-Team/GovBiz/blob/34897562fcf16e30f7c811ad29eaa4b305f4f3ef/infrastructure/codebuild/release.py)
- [Django Dockerfile](https://github.com/GovBiz-Team/GovBiz-ops/blob/611232de21f69689c4024f3935b8d693b03b7777/Dockerfile), [Django 설정](https://github.com/GovBiz-Team/GovBiz-ops/blob/611232de21f69689c4024f3935b8d693b03b7777/config/settings.py)

Kubernetes는 컨테이너의 실행·복구·확장을 관리하고, Argo CD는 Git에 기록된 배포 설정을 클러스터에 반영한다.
MSA 전환은 별도로 업무 책임, 데이터 소유권, 공개 API·이벤트 계약, 독립 배포를 만드는 작업이다.
현재 `core-service`를 그대로 여러 Pod로 실행하는 단계는 배포 환경 이전이며 업무 서비스 분리가 완료된 상태는 아니다.

## 2. 서비스 경계와 분리 순서

아래 표는 배포 경계와 단계별 전환 방향이다. `core-service`·`ai-service`·`ops-service` 및 선택형 `catalog-service` 소스는 GovBiz에 존재하며,
실행 서비스·컨테이너·내부 DNS도 소스 폴더명에 맞춰 통일한다.
[서비스명·배포 식별자 대응 표](../README.md#서비스명과-배포-식별자)를 따른다.

| 서비스 | 담당할 책임 | 진행 방식 |
| --- | --- | --- |
| `core-service` | 계정·기업·세션과 아직 분리하지 않은 사용자 업무 | 초기에는 기존 기능 유지; 추출된 기능은 API·이벤트로 연동 |
| `ops-service` | Django 기반 LLMOps·관리자 업무와 자체 운영 기록 | GovBiz의 `backend/ops-service/`에서 구현; 실행 프로세스·전용 DB는 분리하고 기존 `core-service` 관리자 API는 필요한 범위에서 재사용 |
| `ai-service` | LLM·임베딩·RAG·문서 분석 실행 | 기존 FastAPI 유지; 외부 사용자에게 내부 API를 직접 공개하지 않음 |
| `catalog-service` | 공고 수집·정규화·게시·색인과 원본 데이터 | 독립 DB와 `core-service` 읽기 projection을 로컬 검증. Kubernetes·운영 전환은 별도 |
| `application-service` (분리 후보·미구현) | 신청 준비·문서 작업·중복 지원 검토와 작업 상태 | 공고·계정 계약 정리 후 분리 후보 |
| 도메인별 worker | 해당 서비스의 큐 소비·수집·장기 작업 | 처리량과 실행 조건에 맞춰 API와 별도 프로세스로 운영 |

워커 프로세스 분리는 같은 업무 서비스의 실행 역할을 나누는 작업이다. 워커 수를 MSA 서비스 수로 계산하지 않는다.
리포트·파트너·계정을 처음부터 모두 별도 서버로 만들지는 않는다. 실제 변경 주기와 장애·확장 요구로 후속 분리를 결정한다.
분리한 Spring 애플리케이션들을 GovBiz 저장소 안에서 각각 빌드해도 된다. MSA 서비스마다 Git 저장소가 반드시 하나씩 필요한 것은 아니다.

현재 코드에는 `account ↔ partner`, `supportprogram ↔ applicationpreparation`의 기능 간 import가 있다.
신청 준비·중복 검토·리포트도 계정과 공고 코드를 사용한다.
따라서 폴더 복사만으로 분리하지 않고, 공개 조회·명령 계약과 필요한 데이터 스냅샷부터 정한다.
공고 소유 데이터와 개인 관심 공고·신청 상태는 서로 다른 책임이므로 `supportprogram` 폴더 전체를 하나의 서비스로 간주하지 않는다.

## 3. 데이터와 인증 경계

- 서비스마다 소유 테이블·스키마와 DB 계정을 정하고 다른 서비스의 테이블을 직접 수정하지 않는다.
- 초기에는 하나의 RDS 인스턴스 안에서 스키마·계정을 분리할 수 있다. 물리 DB 인스턴스 분리와 데이터 소유권 분리를 구분한다.
- 다른 서비스의 정보는 내부 API 또는 필요한 필드만 유지하는 이벤트 기반 조회 모델로 전달한다.
- 데이터 이전은 소유권 목록, 백필, 검증, 쓰기 주체 전환, 복구 절차를 포함한다. 애플리케이션 배포와 동시에 무계획하게 DB를 분할하지 않는다.
- 계정·권한의 기준은 현재 `core-service`에 유지한다. Django에 별도의 일반 사용자 인증 체계를 중복 구현하지 않는다.
- 현재 `govbiz_session`은 HttpOnly·SameSite=Lax·호스트 한정 쿠키다. 외부 주소를 나눌 때 로그인·로그아웃·CSRF와 Django 권한 검사를 함께 설계한다.
- 내부 API 호출자의 인증과 사용자 권한 전달을 명시한다. Kubernetes 내부 네트워크에 있다는 사실만으로 관리 API 접근을 허용하지 않는다.
- RabbitMQ 이벤트에는 식별자·버전과 재처리 규칙을 두고, DB 기록과 발행의 일관성 및 중복 소비 방지를 검증한다.

## 4. GovBiz-infra의 목표 구조

애플리케이션 코드·로컬 Compose·테스트는 GovBiz에 모은다.
GovBiz-infra에는 향후 환경별 배포 상태와 Argo CD 정의만 추가한다.
아래 구조는 최초 Ops 단독 검증 단계의 기록이다. 현재는 `charts/`, `environments/local-msa/`,
`argocd/local/`가 추가되었으며 [전체 로컬 검증 안내](msa-local.md)를 따른다.

```text
GovBiz-infra/
├─ environments/
│  ├─ services/ops-service/base/  현재: ops-service Deployment·Service
│  ├─ local/ops-service/         현재: ops-service 로컬 overlay
│  ├─ local/ops-mysql/              현재: 격리 검증용 DB
│  └─ README.md                     환경별 관리 기준
├─ argocd/README.md                 현재: 도입 조건만 존재
└─ docs/
```

네 서비스의 Helm Chart·로컬 AppProject·Application은 후속 구현에 포함되었다.
운영 환경, 공통 외부 라우팅·네트워크 정책, digest 자동 승격은 향후 추가할 대상이다.

처음에는 Kustomize의 base/overlay로 환경 차이를 관리한다. 서비스별 Argo CD Application으로 독립 배포와 상태 확인이 가능하게 한다.
운영 Pod에는 개발 체크아웃 소스를 마운트하지 않는다. 애플리케이션 CI가 만든 불변 이미지 digest를 배포 설정에 기록한다.
infra에서는 submodule SHA가 아닌 환경별 이미지 digest를 배포 버전으로 관리한다. 릴리스 PR에 이미지와 GovBiz 소스 커밋의 대응 관계를 남긴다.
앱 이미지는 서로 독립적으로 갱신하되, 공개 계약 변경 시 소비자 호환성을 검증한다.

현재 운영 환경은 없다. EC2 Compose·CodeBuild·SSM 재배포용 코드는 GovBiz의 `infrastructure/`에 유지한다.
이번 저장소 정리에서는 실제 운영 연결·서버 파일·이미지를 바꾸지 않는다. Kubernetes 전환 검증과 승인 뒤 해당 환경의 배포 기준·권한을 단일 경로로 옮긴다.

현재 프론트엔드 배포를 Kubernetes로 반드시 옮길 필요는 없다. 외부 웹 호스팅을 유지하면서 백엔드만 전환할 수도 있다.
React Native 앱은 GovBiz의 `frontend/mobile/`, 웹·앱 공통 계약은 `frontend/packages/shared/`에서 관리한다.
앱 바이너리는 모바일 배포 대상으로 관리하며 Kubernetes에서 실행하지 않는다.

## 5. CI와 Argo CD의 역할

```mermaid
flowchart LR
    A["GovBiz PR·병합"] --> B["CI: 서비스별 테스트·이미지 빌드"]
    B --> C["GHCR: 서비스별 이미지 digest"]
    C --> D["GovBiz-infra PR: 이미지 digest 갱신"]
    D --> E["환경별 배포 설정에 병합"]
    E --> F["Argo CD: Git 상태 동기화"]
    F --> G["Kubernetes: 서비스 실행·복구"]
```

- 기존 GitHub Actions 검증과 CodeBuild 빌드 경로를 확인해 역할을 분담한다. 같은 릴리스를 두 CI가 동시에 배포하지 않는다.
- Argo CD는 소스 코드 테스트나 Docker 이미지 빌드를 대신하지 않는다.
- 개발 환경은 검증 후 자동 동기화, 운영은 초기에는 PR 검토와 수동 동기화를 기본 제안으로 둔다.
- 클러스터와 Argo CD 자체의 최초 설치·접근 설정은 별도 부트스트랩 단계다.
- Git 읽기 자격 증명과 GHCR 공개 범위·이미지 읽기 권한은 별도로 구성한다.
- 비밀값은 평문 또는 단순 base64 Secret으로 Git에 커밋하지 않는다. 운영 환경 확정 후 비밀 저장소와 주입 방식을 선택한다.
- 이전 이미지로 되돌릴 때도 Git의 배포 설정을 변경한다. DB migration 호환성과 데이터 복구는 이미지 되돌리기와 별도로 확인한다.
- SSM 기반 기존 Compose 배포는 전환 검증과 트래픽 전환 후 해당 대상으로 가는 자동 실행을 정리한다.

## 6. Pod 확장 전에 해결할 항목

1. **수집·색인 실행 역할:** 기존 모드에서는 `core-service`, 공고 분리 모드에서는 `catalog-service`가 수집·색인을 소유한다. 활성화된 `@Scheduled`는 각 프로세스에서 실행되므로 실행 주체를 먼저 확인한다. 세대별 스냅샷 공개 보호가 있어도 외부 수집·색인 호출 자체의 중복 방지를 뜻하지 않는다. 전용 실행 역할과 작업 단위 중복 방지를 확인하기 전에는 replicas만 늘리지 않는다.
2. **큐 소비·종료:** DB 작업 선점, 중복 배달, ACK, DLQ, 실행 중 Pod 종료와 재기동을 검증한다. 재시도 때문에 동일 유료 AI 작업을 반복하지 않도록 기존 기록·재실행 정책을 보존한다.
3. **요청·예산 제한:** 프로세스 메모리의 동시 실행 제한·캐시가 여러 Pod에서 어떤 의미를 가지는지 확인한다. 기존 Redis·DB 기반 정책과 함께 검토한다.
4. **운영 이미지:** Django 기본 이미지는 Gunicorn으로 변경하고 `ops-service` CI에 기본 이미지 검증을 추가했다. 개발 Compose의 runserver·소스 bind mount를 Kubernetes에 가져오지 않는다. TLS·인증·실제 업무 운영 준비는 별도다.
5. **상태 확인과 자원:** startup/readiness/liveness를 구분하고, 외부 AI 장애로 무한 재시작하지 않도록 설계한다. 요청 시간·종료 유예·메모리·CPU를 실제 부하에 맞춰 정한다.
6. **상태 저장소:** RDS 사용 여부와 새 연결을 먼저 확정한다. Elasticsearch·Qdrant·RabbitMQ·Redis는 백업·복구·PVC와 운영 주체를 먼저 정한다. 모든 DB를 단순히 Pod 하나씩으로 변환하지 않는다.
7. **추적:** 서비스 간 request/job ID, 오류율, 지연, 큐 적체를 관측한다. Kubernetes 로그 수집과 Argo CD의 배포 상태만으로 업무 처리 성공을 판단하지 않는다.

## 7. 실행 단계와 완료 기준

| 단계 | 작업 | 완료 기준 |
| --- | --- | --- |
| 1 | 서비스 책임·테이블 소유권·인증 계약 정의 | 분리 대상마다 읽기·쓰기 경계와 호환 API가 문서화됨 |
| 2 | `core-service`·`catalog-service`·`ai-service`·`ops-service`의 운영 실행 준비 | 이미지 빌드·필수 테스트, 상태 확인·종료 동작 검증 |
| 3 | 개발 Kubernetes에 기존 배포 단위 이식 | 격리 데이터로 서비스 통신·장애·재시작 검증; 아직 MSA 완료로 표시하지 않음 |
| 4 | Argo CD 연결 | infra PR의 이미지 변경이 지정 서비스에만 반영되고 이전 버전 복귀 검증 |
| 5 | `ops-service` 운영 업무 구현, `catalog-service`의 운영 전환과 후속 업무 추출 | 다른 서비스 DB 직접 접근 없이 해당 서비스만 배포·테스트 가능 |
| 6 | 운영 전환 | 데이터 복구 연습·권한·동시성 검증 후 트래픽 전환, 기존 자동 배포 경로 정리 |

유료 AI 평가는 승인된 전송 데이터와 호출 예산 안에서만 수행한다. 무료 스텁 통합 검증과 실제 RAG 품질 검증은 결과를 구분한다.
초기 설계 작성 시점에는 서버 접속, 클러스터 생성, 운영 데이터 이동, 외부 AI 호출을 수행하지 않았다.
후속 로컬 Kubernetes 구현·검증 범위는 [실행 안내](kubernetes-local.md)에 별도로 기록한다.

## 8. 로컬 우선 검증 계획

로컬 Kubernetes는 Docker 위에 별도 클러스터를 만드는 kind를 우선 제안한다.
기존 Compose 개발 환경의 코드·볼륨을 유지하며, Kubernetes 검증에는 별도 namespace와 검증 데이터를 사용한다.

1. 현재 smoke는 `govbiz-k8s-smoke-<무작위값>` 이름의 새 kind 클러스터와 전용 kubeconfig를 사용한다. `govbiz-local`은 namespace 이름이며 기존 Kubernetes 컨텍스트는 사용하지 않는다.
2. 첫 검증은 `ops-service`와 전용 검증 MySQL로 배포·DNS·상태 확인·Pod 재생성을 확인한다.
3. 같은 이미지로 수행한 로컬 배포 검증 이후 Argo CD의 AppProject와 서비스 Application을 연결한다.
4. Argo CD에서 읽을 manifests가 원격 infra 브랜치에 있어야 한다. 로컬 파일 적용만으로 GitOps 자동 동기화 검증 완료라고 표시하지 않는다.
5. Git의 이미지 버전 변경 → Argo CD 동기화 → 배포 상태 확인 → 이전 버전 복귀를 검증한다.
6. 이어서 `core-service`·`catalog-service`·`ai-service`와 검색 저장소를 격리 데이터·외부 API 스텁으로 검증한다. 전체 서비스 동시 실행 전에 자원을 다시 확인한다.

초기 설계 조사 당시 PC에서 Docker와 kubectl 명령을 확인했다. kind·helm·argocd 명령은 당시 PATH에서 발견되지 않았다. 실행 전 현재 상태를 다시 확인한다.
Docker 엔진에 할당된 메모리는 약 7.6 GiB이며, 이는 여유 메모리 측정값이 아니다.
기존 전체 Compose와 Kubernetes 전체 스택을 동시에 충분히 실행할 수 있다고 가정하지 않는다.
초기 설계 시점에는 도구 설치나 로컬 클러스터 생성을 수행하지 않았다. 후속 구현에서는
검증용 kind 도구와 임시 kubeconfig를 사용하므로 기존 환경의 도구/클러스터 상태와 구분한다.

## 9. 운영 이전에 확정할 환경

- 실제 운영 대상: EKS 또는 EC2 직접 운영 등
- 도메인·TLS·라우팅 방식, 외부 웹 호스팅 유지 여부
- GHCR 이미지 pull, 외부 DB와 클러스터의 네트워크·권한 연결
- 상태 저장소의 운영 위치·스토리지·백업, 비밀값 주입 방식
- 후속 업무 분리 범위와 `ops-service` 운영 관리 기능의 구체적인 요구

## 참고

- [Argo CD: 소스와 배포 설정 저장소 분리](https://argo-cd.readthedocs.io/en/stable/user-guide/best_practices/)
- [Argo CD: CI와 연동](https://argo-cd.readthedocs.io/en/stable/user-guide/ci_automation/)
- [kind: 로컬 클러스터와 이미지 적재](https://kind.sigs.k8s.io/docs/user/quick-start/)
- [Kubernetes: Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- [서비스별 데이터 소유권](https://learn.microsoft.com/en-us/azure/architecture/microservices/design/data-considerations)
