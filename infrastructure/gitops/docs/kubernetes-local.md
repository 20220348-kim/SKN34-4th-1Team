# Kubernetes 1단계: 로컬 `ops-service` 실행과 장애·복구

통합 후 소스와 배포 설정은 같은 저장소에 있습니다. 아래 경로를 통합 구조로 갱신했으며,
기존 2026-09-19 실행 결과가 통합본·Windows에서 재검증되었다는 뜻은 아닙니다.

Kubernetes는 포트폴리오 필수 목표다. 이번 구현은 **실제 `ops-service` 이미지와 MySQL을 격리된 kind에
올리는 첫 실행 단계**이며, 기존 AWS 운영 이전이나 전체 MSA 완성은 아니다.
서비스 책임·인증·데이터 경계는 [서비스 경계 계약](service-boundaries.md)에 정리했다.
실제 수행 결과와 이미지 ID는 [2026-09-19 검증 기록](kubernetes-validation-20260919.md)에 남겼다.

## 범위

- GovBiz: `ops-service` 이미지 기본 실행을 Gunicorn으로 변경, UID/GID 10001, 기본 이미지 검증.
  개발 Compose는 기존 runserver를 유지한다.
- `infrastructure/gitops`: Kustomize `ops-service` Deployment·Service·ConfigMap, 로컬 전용 MySQL StatefulSet·PVC,
  namespace, pinned kind 노드, 구성 검사와 격리 클러스터 smoke.
- frontend·`core-service`·`ai-service` 코드, 실제 계정·DB, AWS/Vercel 설정, 기존 개발 컨테이너는 변경하지 않는다.
- EKS·유료 자원·공개 LoadBalancer·Ingress·유료 AI 호출을 만들지 않는다.
- `ops-service`는 health/readiness만 있다. 관리자 인증·LLMOps 업무 모델·`core-service` 연동은 아직 없다.

호출 흐름은 검증용 로컬 요청 → loopback port-forward → `ops-service` Gunicorn → Django readiness →
`ops-mysql` Service DNS → 검증용 MySQL이다. DB를 검사하지 않는 liveness는 별도 경로다.

## 구성과 안전 경계

| 항목 | 로컬 검증 설정 |
| --- | --- |
| 클러스터 | 매번 `govbiz-k8s-smoke-<무작위값>` 생성; 기존 컨텍스트 사용 안 함 |
| Kubernetes | kind 0.33.0, Kubernetes 1.36.4 노드 digest 고정 |
| namespace | 새 클러스터의 `govbiz-local` |
| `ops-service` | replica 1, ClusterIP, UID 10001, 읽기 전용 root, `/tmp`만 emptyDir |
| probes | startup/liveness `/api/v1/health`, readiness `/api/v1/health/ready` |
| 자원 | manifests의 CPU·메모리 requests/limits; 실제 운영 부하 기준은 아님 |
| 이미지 | `ops-service`는 이미 빌드된 고유 로컬 tag를 kind에 적재; MySQL 이미지 digest 고정 |
| 비밀값 | 매 실행 생성한 무작위 값만 stdin으로 Kubernetes Secret 생성; Git·명령행에 넣지 않음 |
| 데이터 | `core-service`/RDS와 다른 검증 DB·계정·PVC; 클러스터 정리 시 검증 데이터 삭제 |
| 외부 노출 | 없음; API 서버와 port-forward는 127.0.0.1에만 바인딩 |

운영 Secret을 Kubernetes Secret에 복사하거나 실제 `.env`를 읽지 않는다. base64는 암호화가 아니다.
기존 kubeconfig를 수정하지 않고 임시 파일과 명시적 context를 모든 kubectl 명령에 전달한다.
`ops-service` rolling surge는 아직 업무가 없는 상태에서만 검증한다. `core-service`·`catalog-service`·`ai-service`에 같은 갱신 정책을 복사하면
수집·색인 중복 실행이 생길 수 있으므로 [복제 수 제한](service-boundaries.md#6-kubernetes-replica실행-역할-제한)을 먼저 따른다.

kind 기본 네트워크의 **NetworkPolicy 집행을 이번에 검증하지 않는다.** ClusterIP는 다른 Pod의
접근을 막는 인증/방화벽이 아니다. NetworkPolicy 집행 CNI와 허용/거절 검증 전 `core-service`·`catalog-service`·`ai-service` 또는
`ops-service` 관리 API를 연결하거나 공개하지 않는다. 단일 노드·local PVC는 HA·백업이 아니다.

## 실행

통합 저장소의 `main`에서 소스와 배포 설정을 함께 사용한다.
기존 runserver 이미지로 이 smoke를 실행하면 기본 명령 검사에서 거절된다.

`ops-service` 소스 경로는 `backend/ops-service`이며, 아래 검증이 사용하는 Kubernetes 리소스
`ops-service`와 이미지 접두사 `govbiz-ops-service`도 같은 서비스명으로 통일한다.

Docker Engine(API 1.48 이상)과 kubectl(1.36 계열), Python 3.13,
공식 체크섬을 확인한 kind 0.33.0이 필요하다.
도구 설치는 [kind 공식 설치 안내](https://kind.sigs.k8s.io/docs/user/quick-start/#installing-from-release-binaries)를 따른다.
전역 Python 대신 infra의 무시되는 `.tools/` 가상환경을 사용한다.
Docker에 기존 전체 앱이 실행 중이면 메모리 사용량부터 확인하고, 임의로 기존 컨테이너를 중지하지 않는다.

```bash
# 통합 저장소 루트에서
OPS_IMAGE="govbiz-ops-service:k8s-$(git rev-parse --short=12 HEAD)-$(date +%s)"
docker build -t "$OPS_IMAGE" backend/ops-service

# 같은 저장소의 GitOps 디렉터리로 이동
cd infrastructure/gitops
python3 -m venv .tools/venv
.tools/venv/bin/python -m pip install -r scripts/requirements.txt
.tools/venv/bin/python -B scripts/check_repository.py
.tools/venv/bin/python -B scripts/check_kubernetes.py
.tools/venv/bin/python -B -m unittest discover -s scripts -p 'test_*.py'
.tools/venv/bin/python -B scripts/smoke_kubernetes.py --image "$OPS_IMAGE"
```

kind가 PATH에 없다면 `--kind /검증한/바이너리/경로`를 추가한다.
`latest`, 무태그, digest 입력은 이 **로컬 도구**가 거절한다. 각 테스트 빌드에는 고유 tag를 쓰며,
출력의 로컬 이미지 ID를 기록한다. 이 ID는 registry manifest digest나 ECR 발행 증거가 아니다.
운영 배포 설정은 승인된 registry digest를 별도로 사용해야 한다.
Docker Desktop의 OCI 다중 플랫폼 index에 실제로 내려받지 않은 플랫폼/attestation이 있으면
kind의 전체 플랫폼 import가 실패할 수 있다. smoke는 `docker image save --platform`으로
Docker 호스트와 같은 플랫폼만 내보내어 적재하고, 아키텍처가 다른 앱 이미지는 거절한다.
MySQL은 manifest의 고정 digest로 클러스터가 공식 registry에서 내려받으므로 인터넷 연결이 필요하다.

정적 CI는 Kustomize 렌더링·정책·도구 단위 테스트를 검사한다. `kubectl apply --dry-run=server
--validate=strict`를 사용하는 실제 스키마 검증은 smoke 안의 새 Kubernetes API 서버에서 수행한다.
운영 kubeconfig를 넘겨 직접 `apply`하는 용도로 사용하지 않는다.

## smoke의 통과 조건

1. 새 클러스터에 Namespace·검증 Secret·DB·`ops-service`만 생성한다.
2. 실제 서버 스키마 검증, MySQL 8.4 연결과 Service DNS, Django check·migration 변경 없음 검사.
3. DB를 중지하면 readiness는 503/Pod NotReady, liveness는 200이며 관찰 구간에 `ops-service` 재시작 없음.
4. DB Pod 재생성 후 PVC의 검증용 행이 유지되고 readiness가 복구됨.
5. `ops-service` Pod를 지우면 Deployment가 다른 UID로 재생성하고 readiness 복구.
6. 존재하지 않는 로컬 이미지로 rollout하면 실패하며 기존 healthy replica 유지.
7. 직전 이미지로 되돌린 뒤 readiness 복구. DB migration을 되돌렸다는 의미는 아님.

성공 시 `GOVBIZ_KUBERNETES_LOCAL_OK`와 수행한 검사·이미지 ID를 출력한다.
성공/실패 모두 생성한 클러스터만 삭제하고 port-forward·임시 kubeconfig·검증 Secret/PVC를 정리한다.
따라서 테스트가 끝나면 Kubernetes가 계속 켜져 있는 상태는 아니다. Docker 이미지·다운로드한 도구
캐시는 남을 수 있으며 전역 prune은 하지 않는다. 강제종료로 정리가 끊겼다면 출력된 정확한
`govbiz-k8s-smoke-...` 이름을 확인한 뒤 해당 테스트 클러스터만 정리한다.

`ops-service`에는 현재 업무 migration이 없다. 이 검증은 Pod 시작마다 migrate를 실행하지 않는다.
업무 테이블이 생기면 호환 migration을 별도 Job으로 먼저 검증·승인하고, application rollout과
데이터 복구 절차를 분리해야 한다. 이번 PVC 재생성 검증은 백업/복원 검증이 아니다.

## 다음 단계와 통과 조건

1. 앱·infra의 변경을 검토·병합해 참조할 이미지/manifest revision을 고정한다.
2. 격리된 클러스터에서 Argo CD AppProject 최소권한·`ops-service` Application·명시적 sync를 연결하고
   Git 변경→해당 서비스 교체→Git revert 복귀 증거를 남긴다. 현재 `rollout undo`는 GitOps가 아니다.
3. NetworkPolicy 집행, `core-service`·`catalog-service`·`ai-service`의 probe/종료·단일 scheduler·상태 저장소 계획을 확인하고
   외부 API 스텁·격리 데이터로 세 서비스를 단계적으로 이식한다.
4. `ops-service` 관리자 인증은 `core-service`의 세션·ADMIN 판정 계약을 확정한 뒤 별도 구현한다.
5. EKS 또는 다른 Kubernetes 운영 방식·비용·도메인·TLS·IAM·비밀값·백업을 승인받은 뒤
   운영 환경을 새로 구성한다. 현재 가동 중인 운영 환경은 없다.

참고: [Kubernetes probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/),
[kind 이미지 적재](https://kind.sigs.k8s.io/docs/user/quick-start/#loading-an-image-into-your-cluster),
[Argo CD 저장소 분리](https://argo-cd.readthedocs.io/en/stable/user-guide/best_practices/).
