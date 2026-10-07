# 평가 실행 환경의 Kubernetes 통합

2026-10-08부터 배포 대상의 실행 환경은 Kubernetes로 통일하고 서비스·데이터 경계는 유지한다.
Compose는 로컬 개발에 유지하고, 이전 중에는 기존 인스턴스와 원본 데이터를 보존한다.
기존 개인 환경의 Kubernetes Ops + Compose Prefect·실행기·결과 서버·Langfuse 구성은 이전 중
상태다. 평가 세 구성요소만 옮겨도 전체 이전 완료는 아니며, Langfuse와 관련 저장소까지 포함한
[전체 Kubernetes 배포 기준](../README.md#최종-배포-목표와-완료-기준)을 적용한다.

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

Infra CI의 기존 `test_*.py` 검색에 Chart·PVC 복원 단위 테스트가 포함된다. 이 검사는 오프라인 검증이다.
LLMOps CI에는 아래의 실제 PVC 복원 smoke가 추가됐다. 세 Helm 릴리스의 실제 기동·평가 통합 검증은
PVC smoke와 별도이며 아직 완료하지 않았다.

## 새 PVC에서 복원·Pod 교체 검증

[`evaluation_pvc_restore.py`](../scripts/evaluation_pvc_restore.py)는 기존 암호화 통합 백업을
메모리에서 인증·복호화하고, 격리 MySQL에서 완료된 Ops 실행과 보고서의 연결을 확인한다.
그 MySQL을 제거한 뒤 **새 임시 namespace와 두 PVC**에 Prefect·결과 파일만 전달한다.
SQL dump·복구 키를 Kubernetes Secret, ConfigMap, Pod 명세 또는 명령행 인자로 전달하지 않는다.
복원 파일과 검사 입력은 `kubectl exec`의 표준 입력을 사용한다.

실행은 WSL/Linux와 초기화된 개인 kind 상태를 요구한다. 기존 `dev`·`gitops` 상태 모두 소유권을
검사하며 업무 Deployment·Argo Application·접수 상태·원본 볼륨은 변경하지 않는다.
대상은 현재 저장소의 단일 노드 kind 환경으로 한정한다. 기준 `standard` StorageClass의 provisioner가
`rancher.io/local-path`, binding이 `WaitForFirstConsumer`, 회수 정책이 `Delete`여야 한다.
같은 provisioner·binding·회수 정책의 **전용 임시 StorageClass**를 새로 만들어 사용한다. 공유 class에
남아 있는 기존 Available PV가 새 PVC에 연결되어 삭제되는 일을 피하기 위한 제한이다.
이 `Delete` 정책은 **검사 후 버릴 복사본 전용**이며 운영 이전 PVC의 보존 정책이 아니다.
[StorageClass 동작](https://kubernetes.io/docs/concepts/storage/storage-classes/)에 맞춰
`nodeName` 대신 `nodeSelector`로 배치한다.

```bash
# 실제 임시 PVC를 생성·복원·삭제한다. 기존 서비스를 중지하거나 재개하지 않는다.
# 입력은 기존 ops_state_snapshot.py backup으로 만든 private 통합 백업과 키다.
python3 -B infrastructure/gitops/scripts/evaluation_pvc_restore.py \
  --state-dir infrastructure/gitops/.local/fork \
  --archive /private-backups/ops-state.enc \
  --key-file /private-backups/ops-state.key
```

`--state-dir`은 실제 초기화된 상태 디렉터리로 지정한다. 키·백업 파일은 기존 private 권한 검사와
크기 제한을 그대로 따른다. 기존 백업을 읽을 뿐 새 백업을 만들거나 최신성·전체 복구를 증명하지 않는다.
Docker의 격리 MySQL과 Kubernetes의 복원 helper가 순차 실행되므로 실행 전 자원 여유도 확인한다.

검증 순서는 다음과 같다.

1. 새 namespace·전용 StorageClass를 `create`하고 UID·소유 라벨을 기록한다. 기존 자원은 채택하지 않는다.
2. 새 PVC 두 개의 Bound 상태와 각 PV의 claim UID·provisioner·회수 정책을 확인한다.
3. 빈 PVC에만 복원하고 원본 파일 바이트·권한·소유자·시각을 대조한다. Prefect WAL·무결성·완료 이력과
   보고서 해시도 확인하며 활성 스케줄·미완료 실행이 남으면 실패한다.
4. **복사본만** UID/GID `10001`, 디렉터리 `0750`, 파일 `0640`으로 바꾼다. 원본 권한 보존 검증과
   새 런타임에 맞춘 권한 변경을 구분한다. 이 작업의 root helper에만 CHOWN·DAC_OVERRIDE·FOWNER를 주며
   일반 런타임 Chart의 권한은 확대하지 않는다. SQLite 검사 연결은 권한 변경 전에 명시적으로 닫는다.
5. 복원 Pod가 종료·삭제된 뒤 새 비루트 Pod에서 전체 파일·메타데이터, SQLite 논리 내용, 완료 실행,
   보고서 해시와 쓰기 권한을 확인한다. API·실행기·스케줄러는 시작하지 않는다.
6. 소유 namespace와 새 PVC를 정리하고 연결됐던 PV의 삭제와 임시 StorageClass 삭제까지 확인한다.
   정리 실패도 성공으로 처리하지 않는다. 중단·응답 유실 시
   `kubectl get ns,storageclass -l ai.govbiz.evaluation-restore`로 남은 검사 자원을 확인한다.
   UID나 소유 라벨이 달라지면 자동 삭제하지 않는다.

성공 보고서는 `scope=disposable_kubernetes_evaluation_pvc`, `production_storage_restored=false`,
`application_started=false`를 명시한다. 이 명령은 **복원 연습**이며 운영에 연결할 PVC를 남기지 않는다.
NetworkPolicy는 추가하지만 기본 kind CNI에서 실제 집행됐다고 보고하지 않는다.

LLMOps CI는 별도 kind 클러스터에서 [`smoke_evaluation_pvc.py`](../scripts/smoke_evaluation_pvc.py)를
필수 실행한다. 합성 완료 이력·보고서·checkpoint 전 WAL을 사용하며 실제 UID/GID `10001`의 Pod 교체를
확인하고 클러스터를 정리한다. 결과는 `evaluation-pvc.json` artifact로 남긴다. 이것은 실제 개인 백업의
복원 성공이나 무료 평가 실행 완료를 대신하지 않으며, 최신 커밋 CI가 통과하기 전에는 미검증 상태다.

## 후속 완료 기준

1. 기존 [암호화 백업·복원](../../../docs/ops-upgrade-runbook.md)을 이용해 **새 Kubernetes PVC**로
   Prefect·결과를 복원하고 실행 ID·보고서 해시·SQLite WAL·파일 권한을 대조한다. 현재 복원 도구의
   격리 Docker 검증과 새 PVC 검증을 구분한다. 임시 PVC 복원 도구·필수 CI 경로는 추가했으며,
   실제 개인 백업 검증과 운영 이전용 PVC 보존·인계는 남아 있다. 원본 볼륨은 유지한다.
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
