# 평가 실행 환경의 Kubernetes 통합

2026-10-08부터 배포 대상의 실행 환경은 Kubernetes로 통일하고 서비스·데이터 경계는 유지한다.
Compose는 로컬 개발과 전환 전 원본 보존에 사용한다. 기존 개인 환경은 아직
Kubernetes Ops + Compose Prefect·실행기·결과 서버·Langfuse로 동작한다.

## 이번 구현: 독립 배포와 저장소 계약

[`govbiz-evaluation` Chart](../charts/govbiz-evaluation/Chart.yaml)는 한 릴리스에 한 프로세스만
배포한다. 릴리스 이름은 아래 component와 같아야 하며 별도 `govbiz-evaluation` namespace를 사용한다.
검증용 namespace는 `govbiz-evaluation-<이름>`으로 구분한다. 기존 업무 namespace에 설치하지 않는다.

| 릴리스 | 배포 리소스 | 저장소 | 역할 |
| --- | --- | --- | --- |
| `prefect` | Deployment·ClusterIP Service | 별도 복원한 Prefect PVC | 기존 SQLite 이력과 수동 평가 API |
| `evaluation-runner` | Deployment | 복원한 결과 PVC, 읽기/쓰기 | 기존 `ops_flow.py`의 단일 실행기 |
| `ops-artifacts` | Deployment·ClusterIP Service | 같은 결과 PVC, 읽기 전용 | 기존 인증된 결과·평가 자료 HTTP 조회 |

Chart는 PVC·PV·Secret·namespace·migration Job을 생성하거나 삭제하지 않는다. 기존 Compose named
volume을 Pod에 직접 연결하지 않으며 hostPath도 사용하지 않는다. 별도 PVC를 준비하고 복원·검증한
뒤 claim 이름을 지정한다. Helm 삭제가 원본 데이터 삭제로 이어지지 않도록 소유권을 분리한 것이다.
실제 PV의 reclaim policy와 StorageClass도 별도로 확인해야 한다.

초기 전환은 SQLite와 결과 파일 형식을 유지한다. DB 엔진 변경과 서비스 버전 업그레이드는 이번
이전과 함께 수행하지 않는다. `prefect`는 현재 Compose와 같은 3.8.6 이미지 digest를 사용하며,
시작 전 SQLite 무결성·참조·migration 이력과 필수 테이블을 확인한다. 미완료 실행·활성 스케줄의
정리는 이전 직전 별도로 검사한다. 정상 운영 중 실행 중인 평가가 있다는 이유로 서버 재시작을
막지 않는다.
자동 migration·block 등록·백그라운드 서비스·스케줄러·UI는 비활성화한다. 이 초기 프로파일은
기존 이력 조회와 명시적인 무료 수동 평가를 위한 구성이며 Prefect 전체 운영 기능이 아니다.

`evaluation-runner`와 `ops-artifacts`는 같은 `ReadWriteOnce` 결과 PVC와 같은 노드를 지정한다.
`ReadWriteOnce`는 노드 단위이므로 같은 노드의 두 Pod가 접근할 수 있지만, `ReadWriteOncePod`는
이 구성에 사용할 수 없다. 초기 목표는 단일 노드이며 HA·분산 실행을 제공하지 않는다.
[Kubernetes 접근 모드](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes)를 참고한다.

모든 릴리스는 `replicas: 0`으로 준비하고 활성화 시에도 최대 1개·`Recreate`만 허용한다.
이는 각 Deployment의 중복 기동을 줄일 뿐 Compose 실행기와의 동시 실행을 막아주지는 않는다.
실제 전환 전에 기존 실행기를 중지하고 미완료 평가·예산 예약·스케줄을 비워야 한다.
강제 삭제 뒤 예전 프로세스가 남지 않았는지도 확인한다.

컨테이너는 UID/GID 10001, 읽기 전용 rootfs, API token 미마운트, 최소 권한으로 실행한다.
`fsGroup`은 복원한 PVC에만 적용한다. 원본 볼륨의 소유권을 직접 바꾸지 않는다.
Prefect용과 실행기용 writable 임시 경로는 용량을 제한한 emptyDir로 분리한다.

## 이미지·연결·비밀

실제 후보의 이미지는 `image@sha256:...`로 고정한다. Ops 이미지에는 평가 fixture가 포함되어
있지 않으므로 결과 서버의 init container가 **동일한 runner 이미지**에서 자료를 emptyDir로 복사한다.
결과 서버는 복사된 자료를 읽기 전용으로 사용하며 호스트 checkout을 mount하지 않는다.
Ops·runner의 실행 명세 일치와 각 이미지의 CI·발행 증거는 실제 전환 전에 별도로 검증해야 한다.
digest 문법 검사만으로 이미지를 신뢰하지 않는다. 현재 공개 발행 파이프라인에는 runner가 없다.

| 위치 | 주입 항목 |
| --- | --- |
| `govbiz-evaluation/llmops-runner` Secret | `LLMOPS_BUDGET_TOKEN`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` |
| `govbiz-evaluation/llmops-artifacts` Secret | `LLMOPS_ARTIFACT_TOKEN` |
| Kubernetes Ops의 기존 Secret | 결과 서버와 같은 artifact token, 기존 예산 token 유지 |

유료 실행·RAG live·스케줄은 꺼져 있고 OpenAI 키를 주입하는 옵션은 없다. Langfuse 연결·점수
기록은 유지하므로 접근 가능한 Langfuse URL과 기존 키가 필요하다. Langfuse 자체의 Kubernetes
이전은 별도 단계다. namespace나 ClusterIP만으로 네트워크 접근이 격리됐다고 간주하지 않는다.
실제 배포 전 CNI의 NetworkPolicy 집행·Prefect API 접근 제한을 검증한다.

전환 후 경로는 `Ops API → Prefect Service → 실행기 → 결과 PVC → 결과 서버 → Ops API/sync`다.
실행기에서 Ops로의 예산·사용량 요청과 Langfuse 점수 기록도 유지한다.
Ops에서 사용할 주소는 `http://prefect.govbiz-evaluation.svc.cluster.local:4200/api`,
`http://ops-artifacts.govbiz-evaluation.svc.cluster.local:8010`이다. 아직 기존 Ops 주소를 변경하지 않았다.

## 오프라인 준비와 검증

[`environments/evaluation`](../environments/evaluation/prefect.yaml)의 세 values를 Git 제외 개인
디렉터리로 복사한 뒤 검증한 이미지·복원 대상 claim·노드·Langfuse 주소를 채운다.
공유 템플릿은 이미지·노드가 비어 있어 그대로 렌더링되지 않는다. Secret 값은 넣지 않는다.

```bash
# Helm 4.3.0, 기존 GitOps Python 환경. 클러스터 조회·파일 복원·배포 없음.
python3 -B infrastructure/gitops/scripts/check_evaluation.py \
  --values-dir infrastructure/gitops/.local/evaluation

# 실제 Helm 렌더링과 임시 SQLite 대역 검증. 유료 API·Docker 사용 없음.
cd infrastructure/gitops/scripts
python3 -B -m unittest test_evaluation_chart
```

검사기는 세 릴리스의 결과 PVC·노드·자료 이미지 일치, Prefect 저장소 분리, 실행기만 단독 활성화하는
오류를 검사한 뒤 고정 Helm/Kubernetes 버전으로 렌더링한다. 성공은 `RENDERED_NOT_APPLIED`이며
PVC 존재·복원 성공·실행기 생존·DNS·이미지 실행 명세·클러스터 자원 여유를 증명하지 않는다.
`allowLocalImages: true`는 별도 격리 CI 클러스터에 미리 적재한 `govbiz/name:tag`만 사용하고
pull policy는 `Never`다. 실제 공개 이미지 검증의 대체 경로가 아니다.

Infra CI의 기존 `test_*.py` 검색에 새 테스트가 포함된다. 로컬과 이 CI 검사는 오프라인 검증이며,
이번에 추가한 세 릴리스의 실제 Pod 기동·평가 통합 검증은 아직 완료하지 않았다.

## 후속 완료 기준

1. 기존 [암호화 백업·복원](../../../docs/ops-upgrade-runbook.md)을 이용해 **새 Kubernetes PVC**로
   Prefect·결과를 복원하고 실행 ID·보고서 해시·SQLite WAL·파일 권한을 대조한다. 현재 복원 도구의
   격리 Docker 검증과 새 PVC 검증을 구분한다. 원본 볼륨은 유지한다.
2. runner 이미지의 같은 SHA CI·공개 발행·실행 명세 검증을 추가한다. 기존 네 서비스의 필수 CI·발행
   가드를 우회하지 않는다. 배포 방식은 서비스별 Argo Application과 수동 동기화를 유지한다.
   기존 AppProject·진단은 네 업무 Application을 전제로 하므로 새 평가 namespace의 권한과
   Application 조회 범위를 함께 검증한다. 이번 Chart를 기존 프로젝트에 바로 추가하지 않는다.
3. 격리된 Kubernetes에서 Prefect·결과 서버를 먼저 확인하고 실행기 1개를 시작한다. 기존 완료 이력,
   새 무료 평가, 인증된 보고서, 중복 방지, 재시작 후 데이터 보존을 검증한다.
4. 실제 전환 시 Ops 접수·스케줄과 Compose writer를 중지하고 최신 백업을 만든다. 복원 검증 후
   Ops의 URL을 전환한다. 새 대상에 쓰기가 생긴 뒤에는 과거 Compose DB로 단순 URL 롤백하지 않는다.
5. Langfuse와 관련 DB·저장소는 별도 이전 단위로 검증한다. 마지막에 임시 브리지를 제거하며,
   기존 Compose 데이터 삭제는 별도의 보존·복구 확인 이후 수행한다.
