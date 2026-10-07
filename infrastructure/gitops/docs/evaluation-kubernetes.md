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
digest 문법 검사만으로 이미지를 신뢰하지 않는다. 실행기는 별도 `evaluation-images.yml`에서 발행하고,
아래의 계획 도구가 기존 네 서비스 발행과 같은 SHA인지 확인한다. 실제 원격 발행 성공은 별도 확인한다.

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
LLMOps CI에는 아래의 실제 PVC 복원 smoke와 별도 평가 런타임 통합 검증이 연결됐다.
세 Helm 릴리스의 기동·평가 성공은 최신 SHA의 해당 CI 결과로 확인한다.

## 공개 발행 검증과 수동 Argo 계획

[`evaluation_release.py`](../scripts/evaluation_release.py)는 개인 포크 기본 브랜치의 검증된 발행을
읽어 **평가 namespace 전용** AppProject와 세 Application을 JSON 보고서에 만든다.
기존 네 업무 Application·프로젝트는 변경하지 않는다. 원격 Git 읽기와 익명 GHCR manifest 조회만
수행하며 Docker·kubectl은 호출하지 않는다. 소스 커밋이 로컬에 없으면 `git fetch`로 객체만 가져온다.

```bash
# 저장소 루트, 기존 GitOps Python 환경 + 인증된 gh + Helm 4.3.0.
# 실제 계획에 사용할 노드·복원 PVC 이름과 접근 가능한 Langfuse origin으로 바꾼다.
# namespace/PVC/Secret은 별도 인계 대상이며 이 명령이 만들거나 검사하지 않는다.
python3 -B infrastructure/gitops/scripts/evaluation_release.py \
  --node <대상-노드> \
  --prefect-claim <복원된-Prefect-PVC> \
  --results-claim <복원된-결과-PVC> \
  --langfuse-url http://<접근-가능한-Langfuse-호스트>:3000
```

`--ops-api-url`의 기본값은 `http://ops-service.govbiz-msa.svc.cluster.local:8000`이다.
두 URL은 비밀번호·토큰·경로 없는 HTTP(S) origin이어야 한다. Secret 값은 인자로 받지 않는다.
업무 API 주소나 기존 Ops의 Prefect·결과 서버 연결을 변경하지 않는다.

검증 흐름은 `현재 소스·필수 CI → 네 업무 이미지 receipt → 실행기 v3 receipt → Git 입력·실행 명세
대조 → 공개 GHCR manifest 확인 → 같은 소스 Chart 렌더링 → 두 발행 기록·CI 재확인`이다.

- 실행기 artifact의 workflow·저장소·브랜치·run·만료·ZIP 크기·SHA-256을 확인한다. 미지 artifact,
  중복 receipt, 잘린 목록, 경로가 다른 ZIP 멤버를 거절한다. 최신 발행이 실패·진행 중이면 과거 성공으로
  대체하지 않으며, 성공한 gate-only 실행의 진단 보고서를 이미지 receipt로 사용하지 않는다.
- v3의 13개 입력 Git 객체, publisher tree, input key, 실행 명세의 원본 바이트 SHA-256을 실제 커밋과
  대조한다. Ops와 runner는 같은 소스 SHA여야 하며 public receipt만 허용한다.
- Chart·기본 values는 검증한 커밋에서 임시 디렉터리로 읽는다. 로컬 작업 파일이나 임의 이미지 입력을
  사용하지 않는다. Prefect는 해당 소스의 고정 digest를 유지하고 결과 서버의 자료 이미지는 runner와 같다.
- `govbiz-evaluation` AppProject는 해당 포크와 namespace, Deployment·Service만 허용한다.
  PV·PVC·Secret·namespace·Job을 소유하지 않는다. 세 Application은 전체 SHA·digest로 고정하며,
  자동 sync·prune·selfHeal은 false, retry는 0이다. 자동 namespace 생성과 삭제 finalizer도 넣지 않는다.
- 모든 replica는 0이고 유료 호출·스케줄은 비활성화한다. 별도의 배포 브랜치·PR·자동 적용은 없다.

성공은 `schema=evaluation-gitops-plan-v1`, `status=PLANNED`다. `resources`에 Argo 리소스,
`renderedSha256`에 각 렌더 결과의 해시, 발행 run·attempt와 artifact 해시·실행 명세 해시를 남긴다.
이는 서명된 승인이나 운영 인계 증거가 아니다. 조회 중 발행·CI·소스가 바뀌면 계획을 반환하지 않는다.
실패 시 `status=BLOCKED`, 고정 `reason`과 오류 종류만 출력하며 URL·registry 오류 원문은 노출하지 않는다.

`publicGHCRManifestsVerified=true`는 GHCR의 immutable manifest 조회 성공만 뜻한다. 레이어 다운로드,
외부 Prefect registry 검증, PVC 복원·존재, Secret 설치, 네트워크 접근, 실제 실행은 검사하지 않는다.
`layersDownloaded`, `prefectRegistryVerified`, `storageRestored`, `runtimeVerified`,
`deploymentAuthorized`는 모두 false다. 실행기가 아직 발행되지 않았거나 현재 소스 CI가 미완료이면
이 계획도 차단된다. 실제 전환 전에 보존할 PVC·비밀·네트워크와 기존 writer 중지·인계 절차를 완료한다.

로컬 무료 검증은 `infrastructure/gitops/scripts`에서
`python3 -B -m unittest test_evaluation_release test_evaluation_chart`로 실행한다.
실제 임시 Git 저장소와 고정 Helm을 사용하며 GitHub·registry 응답만 대역 처리한다.
Infra CI의 기존 `test_*.py` 검색이 새 검증을 포함한다. 실제 클러스터 이전 성공의 대체 증거는 아니다.

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

## 격리 Kubernetes에서 실제 평가 실행 검증

LLMOps CI의 기존 격리 통합 검증에 `--evaluation-runtime` 단계를 연결했다.
`smoke_ops_bridge.py --evaluate --evaluation-runtime --report <새 보고서 경로>`로 실행하며,
도구가 직접 만든 클러스터·Compose 프로젝트만 사용한다. 개인 클러스터를 지정하는 옵션은 없다.

실행 흐름은 `관리자 HTTP 로그인 → Kubernetes Ops API → Kubernetes Prefect → Kubernetes 실행기
→ 결과 PVC → Kubernetes 결과 서버 → Ops sync·인증 보고서 조회`다. Langfuse는 이 검증의
격리 Compose에 유지하며, 관측 서비스까지 Kubernetes로 이전했다고 보고하지 않는다.

1. 기존 격리 MySQL·볼륨 복원 검증을 먼저 완료한다. Ops API·sync와 Compose 평가 writer가 정지한
   상태에서 실제 Prefect SQLite와 완료 보고서를 읽는다. 개인 백업·운영 데이터는 사용하지 않는다.
2. 기존 PVC 복원 도구로 새 namespace·StorageClass·PVC 2개에 복원하고 실행 ID·보고서 해시·권한을
   검증한다. 앞의 최소 합성 SQLite 대신 실제 평가에 사용했던 Prefect 스키마를 그대로 사용한다.
3. 같은 이미지로 렌더링한 Prefect·결과 서버를 먼저 기동하고 실행기 1개를 시작한다. 자동 migration은
   계속 비활성화한다. Ops API와 sync의 두 URL을 함께 바꾼 뒤 격리 접수를 재개한다.
4. 기존 완료 이력을 확인하고 무료 평가를 접수한다. 동일 요청 재전송의 flow 일치, 백그라운드 상태
   반영, 인증 보고서 조회와 모델 호출 0회를 확인한다.
5. 실행기를 정지한 뒤 Prefect·결과 서버 Pod를 교체하고 실행기를 다시 시작한다. 실제 Pod UID 변경,
   이미지 동일성, DB 실행 ID·명세·보고서 해시 보존을 대조하고 새 무료 평가를 한 번 더 실행한다.
6. 원본 Compose 볼륨이 변경되지 않았는지 다시 읽어 비교한다. 임시 namespace·PVC·PV·StorageClass와
   이미지 태그를 정리하고, 바깥 실행기가 격리 클러스터·Compose 프로젝트를 제거한다. 검증 실패도
   정리 경로를 거치며 새 Kubernetes 쓰기를 과거 Compose DB로 되돌리지 않는다.

`ops-bridge.json`의 `evaluation_kubernetes_runtime`에 단계별 증거를 남긴다.
`scope=disposable_kubernetes_evaluation_runtime`, `observability_runtime=isolated_compose`,
`production_cutover=false`, `personal_environment_verified=false`를 명시한다. 기본 kind CNI에서
NetworkPolicy 집행을 입증하지 않으며, 이 결과는 Argo CD 배포·공개 이미지 발행·운영 PVC 인계의
증거가 아니다. 로컬 단위·렌더링 검사만 통과한 상태에서는 **실제 런타임 검증은 최신 SHA CI 대기**다.

평가 Deployment의 rollout이 실패하면 임시 namespace를 정리하기 전에 같은 보고서의
`evaluation_kubernetes_runtime.rollout_failure`에 실패 component·오류 종류, Pod 배치 여부,
init/main 컨테이너의 준비 상태·재시작 횟수·현재/직전 종료 사유와 코드를 남긴다.
Pod 로그와 이벤트는 크기·시간 제한 안에서 읽고, 권한·읽기 전용 파일시스템·DB 스키마·볼륨 마운트·
메모리/디스크 압박·프로브 연결 거부 등의 **고정 진단 코드**만 `signals`에 기록한다.
로그 원문, Pod spec, 환경변수·Secret 값, 이벤트 원문은 artifact에 저장하지 않는다.
진단 조회 자체가 실패하면 `diagnostic_errors`로 구분하고 원래 rollout 오류를 그대로 반환한다.
최초 기동·Prefect/결과 서버 재시작의 240초와 실행기 재기동의 180초 제한, CI 실패 판정,
임시 PVC·태그 정리 경로는 유지한다. 진단 정보가 없거나 일부만 수집됐다고 정상으로 처리하지 않는다.

이 경로를 수정한 뒤에는 `test_smoke_evaluation_runtime`의 실패·민감값 비노출·정리 순서 검증과
최신 SHA의 실제 LLMOps CI를 함께 확인한다. 별도 합성 데이터로 수행한 로컬 Prefect 기동 성공은
CI의 전체 Ops 복구·평가 실행·Pod 교체 성공을 대체하지 않는다.

## 후속 완료 기준

1. 기존 [암호화 백업·복원](../../../docs/ops-upgrade-runbook.md)을 이용해 **새 Kubernetes PVC**로
   Prefect·결과를 복원하고 실행 ID·보고서 해시·SQLite WAL·파일 권한을 대조한다. 현재 복원 도구의
   격리 Docker 검증과 새 PVC 검증을 구분한다. 임시 PVC 복원 도구·필수 CI 경로는 추가했으며,
   실제 개인 백업 검증과 운영 이전용 PVC 보존·인계는 남아 있다. 원본 볼륨은 유지한다.
2. runner 이미지의 같은 SHA CI·공개 발행·실행 명세 검증 경로는
   [별도 실행기 발행 workflow](../../release/README.md#kubernetes-평가-실행기-이미지)에 추가했다.
   v3 receipt 소비·같은 SHA의 Ops 이미지 대조·독립 수동 Argo 계획도 구현했다.
   실제 패키지 준비·최신 SHA CI·발행 성공과 운영 환경에서의 계획 검증은 별도로 확인해야 한다.
   기존 네 서비스의 필수 CI·발행 가드를 우회하지 않는다. 배포 방식은 서비스별 Argo Application과 수동 동기화를 유지한다.
   평가용 계획은 별도 프로젝트로 범위를 제한한다. 실제 적용 전 namespace·PVC·Secret 소유권 인계와
   운영 진단의 Application 조회 범위 확장은 남아 있다.
3. 위 격리 Kubernetes 런타임 검증의 최신 SHA 필수 CI 성공을 확인한다. 검증 경로는 구현했으며,
   실행 실패·취소·건너뛰기를 완료로 처리하지 않는다. 이후 개인 환경의 같은 이미지·백업으로 별도 검증한다.
4. 실제 전환 시 Ops 접수·스케줄과 Compose writer를 중지하고 최신 백업을 만든다. 복원 검증 후
   Ops의 URL을 전환한다. 새 대상에 쓰기가 생긴 뒤에는 과거 Compose DB로 단순 URL 롤백하지 않는다.
5. Langfuse와 관련 DB·저장소는 별도 이전 단위로 검증한다. 마지막에 임시 브리지를 제거하며,
   기존 Compose 데이터 삭제는 별도의 보존·복구 확인 이후 수행한다.
