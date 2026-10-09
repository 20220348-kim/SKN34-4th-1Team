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
| `prefect` | Deployment·ClusterIP Service·NetworkPolicy | 별도 복원한 Prefect PVC | 기존 SQLite 이력과 수동 평가 API |
| `evaluation-runner` | Deployment·NetworkPolicy | 복원한 결과 PVC, 읽기/쓰기 | 기존 `ops_flow.py`의 단일 실행기 |
| `ops-artifacts` | Deployment·ClusterIP Service·NetworkPolicy | 같은 결과 PVC, 읽기 전용 | 기존 인증된 결과·평가 자료 HTTP 조회 |

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
복사 init container는 마운트 루트의 소유권·권한을 보존하고 그 안의 파일·디렉터리만 복사한다.
`copytree`로 마운트 자체의 메타데이터를 바꾸면 UID 10001에서 `Operation not permitted`로
실패하므로 이 경로와 재시도를 비루트 프로세스로 검증한다.
Ops·runner의 실행 명세 일치와 각 이미지의 CI·발행 증거는 실제 전환 전에 별도로 검증해야 한다.
digest 문법 검사만으로 이미지를 신뢰하지 않는다. 실행기는 별도 `evaluation-images.yml`에서 발행하고,
아래의 계획 도구가 기존 네 서비스 발행과 같은 SHA인지 확인한다. 실제 원격 발행 성공은 별도 확인한다.
실행기 패키지가 아직 없으면 [PAT 없는 수동 초기화](../../../docs/public-ghcr-transition.md#pat-없이-평가-실행기-패키지-최초-준비)로
빈 패키지만 준비한다. 초기화 결과는 실제 실행기 발행·receipt·배포 증거가 아니다.

| 위치 | 주입 항목 |
| --- | --- |
| `govbiz-evaluation/llmops-runner` Secret | `LLMOPS_BUDGET_TOKEN`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` |
| `govbiz-evaluation/llmops-artifacts` Secret | `LLMOPS_ARTIFACT_TOKEN` |
| Kubernetes Ops의 기존 Secret | 결과 서버와 같은 artifact token, 기존 예산 token 유지 |

유료 실행·RAG live·스케줄은 꺼져 있고 OpenAI 키를 주입하는 옵션은 없다. Langfuse 연결·점수
기록은 유지하므로 접근 가능한 Langfuse URL과 기존 키가 필요하다. Langfuse 자체의 Kubernetes
이전은 별도 단계다. namespace나 ClusterIP만으로 네트워크 접근이 격리됐다고 간주하지 않는다.
실제 배포 전 CNI의 NetworkPolicy 집행·Prefect API 접근 제한을 검증한다.

세 릴리스는 component별 ingress NetworkPolicy를 함께 렌더링한다. Prefect의 TCP 4200은 같은
평가 namespace의 `evaluation-runner`와 `govbiz-msa`의 `ops-service` Pod만 허용한다. 결과 서버의
TCP 8010은 `govbiz-msa/ops-service`만 허용하고, 실행기로 들어오는 Pod 트래픽은 모두 차단한다.
Ops API와 sync는 같은 Pod이므로 같은 허용 규칙을 사용한다. namespaceSelector와 podSelector는
하나의 peer에서 동시에 만족해야 하며, 다른 namespace에서 같은 Pod label을 붙여도 허용하지 않는다.
정책은 Argo sync wave -1로 Deployment보다 먼저 생성한다. 이미지·소스 계획 검증에서도 정책 누락,
포트·peer 확대, 잘못된 selector와 적용 순서를 거부한다.

이번 정책은 ingress만 제한한다. 실행기의 Ops·Langfuse·DNS 등 egress는 기존 연결을 유지하며,
외부 통신 통제·다른 NetworkPolicy가 합산하는 허용·hostNetwork 및 노드 접근까지 차단했다고
보고하지 않는다. 기존 데이터나 클러스터에 직접 적용하지 않고 검증된 SHA의 수동 Argo 동기화에 포함한다.

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
`allowLocalImages: true`에서는 실행기·결과 서버와 자료 복사 이미지에 별도 격리 CI 클러스터에
미리 적재한 `govbiz/name:tag`를 사용한다. Prefect는 복원 helper가 사용한 원본 `image@sha256`
참조를 유지하며 로컬 별칭을 허용하지 않는다. 모든 컨테이너의 pull policy는 `Never`다.
실제 공개 이미지 검증의 대체 경로가 아니다.

Infra CI의 기존 `test_*.py` 검색에 Chart·PVC 복원 단위 테스트가 포함된다. 이 검사는 오프라인 검증이다.
LLMOps CI에는 아래의 실제 PVC 복원 smoke와 별도 평가 런타임 통합 검증이 연결됐다.
세 Helm 릴리스의 기동·평가 성공은 최신 SHA의 해당 CI 결과로 확인한다.

## 공개 발행 검증과 수동 Argo 계획

[`evaluation_release.py`](../scripts/evaluation_release.py)는 개인 포크 기본 브랜치의 검증된 발행을
읽어 **평가 namespace 전용** AppProject와 세 Application을 JSON 보고서에 만든다.
기존 네 업무 Application·프로젝트는 변경하지 않는다. 수동 노드·PVC 입력의 계획 모드는 원격 Git
읽기와 익명 GHCR manifest 조회만 수행하며 Docker·kubectl은 호출하지 않는다. 복원 보고서 모드는
클러스터 상태도 조회한다. 소스 커밋이 로컬에 없으면 `git fetch`로 객체만 가져온다.

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
- `govbiz-evaluation` AppProject는 해당 포크와 namespace, Deployment·Service·NetworkPolicy만 허용한다.
  PV·PVC·Secret·namespace·Job을 소유하지 않는다. 세 Application은 전체 SHA·digest로 고정하며,
  자동 sync·prune·selfHeal은 false, retry는 0이다. 자동 namespace 생성과 삭제 finalizer도 넣지 않는다.
- 모든 replica는 0이고 유료 호출·스케줄은 비활성화한다. 별도의 배포 브랜치·PR·자동 적용은 없다.

성공은 `schema=evaluation-gitops-plan-v1`, `status=PLANNED`다. `resources`에 Argo 리소스,
`renderedSha256`에 각 렌더 결과의 해시, 발행 run·attempt와 artifact 해시·실행 명세 해시를 남긴다.
이는 서명된 승인이나 운영 인계 증거가 아니다. 조회 중 발행·CI·소스가 바뀌면 계획을 반환하지 않는다.
실패 시 `status=BLOCKED`, 고정 `reason`과 오류 종류만 출력하며 URL·registry 오류 원문은 노출하지 않는다.

`publicGHCRManifestsVerified=true`는 GHCR의 immutable manifest 조회 성공만 뜻한다. 레이어 다운로드,
외부 Prefect registry 검증, PVC 복원·존재, Secret 설치, 네트워크 접근, 실제 실행은 기본 계획에서 검사하지 않는다.
`layersDownloaded`, `prefectRegistryVerified`, `storageRestored`, `runtimeVerified`,
`deploymentAuthorized`는 모두 false다. 실행기가 아직 발행되지 않았거나 현재 소스 CI가 미완료이면
이 계획도 차단된다. 실제 전환 전에 보존할 PVC·비밀·네트워크와 기존 writer 중지·인계 절차를 완료한다.

로컬 무료 검증은 `infrastructure/gitops/scripts`에서
`python3 -B -m unittest test_evaluation_release test_evaluation_chart`로 실행한다.
실제 임시 Git 저장소와 고정 Helm을 사용하며 GitHub·registry 응답만 대역 처리한다.
Infra CI의 기존 `test_*.py` 검색이 새 검증을 포함한다. 실제 클러스터 이전 성공의 대체 증거는 아니다.

## 평가 Argo Application 상태 조회

기존 `fork_cluster.py status --json --state-dir <개인-state>`의 `argocd.evaluation`에서
평가용 세 Application을 별도로 확인한다. 기존 업무 서비스의 `argocd.applications` 범위와
상태 명령의 종료 코드 기준은 유지한다. 클러스터 소유권 확인 후 기존 Application 목록 조회를
재사용하며 추가 배포·Secret 조회·워크로드 변경을 수행하지 않는다.

- `NOT_INSTALLED`: 예상한 세 Application이 모두 없다. 각 항목에 `APPLICATION_MISSING`을 표시한다.
- `ATTENTION`: 일부 누락, 저장소·프로젝트·목적지·Chart·릴리스 불일치, 자동 동기화 설정,
  고정되지 않은 SHA, 소스와 동기화 SHA의 차이, 구성요소 간 SHA 불일치, 비정상 상태·진행 중 작업 등이 있다.
- `OBSERVED`: 세 Application의 선언과 Argo의 보고 상태에서 위 문제가 관찰되지 않았다.
  replica 0인 준비 단계도 이 상태가 될 수 있으므로 실행 성공이나 이전 완료를 뜻하지 않는다.

예상한 Application 이름이 다른 namespace나 클러스터를 가리켜도 누락시키지 않고 불일치로 표시한다.
Helm values·환경변수·상태 오류 메시지 원문은 출력하지 않는다. `runtime_verified`,
`storage_verified`, `publication_verified`, `deployment_authorized`는 모두 false다.
실제 Pod·PVC·통신·평가 성공, 현재 CI·이미지 발행 및 AppProject 권한은 별도 검증 대상이다.
기존 배포·개발 모드 전환의 Application 소유권 제한을 이 조회 결과로 해제하지 않는다.

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

## 이전용 복원 데이터 보존

같은 명령에 `--retain-for-migration`을 명시하면 새 `govbiz-evaluation` namespace에
`prefect`·`results` PVC를 복원하고 검증 후 보존한다. 기존 namespace가 있으면 재사용·덮어쓰기 없이
실패하므로, 실행 전 이전 대상과 백업을 확정한다. 기존 서비스를 중지하거나 Ops 주소를 바꾸지 않는다.

```bash
python3 -B infrastructure/gitops/scripts/evaluation_pvc_restore.py \
  --state-dir infrastructure/gitops/.local/fork \
  --archive /private-backups/ops-state.enc \
  --key-file /private-backups/ops-state.key \
  --retain-for-migration > /private-backups/evaluation-retained.json
```

- 전용 임의 이름의 StorageClass를 만들고 처음부터 `Retain`을 사용한다. 다른 Available PV를
  채택하지 않으며 각 PVC UID·PV UID·claimRef·provisioner·보존 정책을 복원 전후에 확인한다.
- 보존 복원 전후에 암호화 백업과 **현재 중지된 원본**을 대조한다. 기존 DB 백업과 같은 유지보수
  상태·Ops/Argo 소유권·Compose writer 식별자가 유지되어야 한다. MySQL 전체 dump와 테이블 건수,
  미완료 평가·열린 예산 예약·활성 스케줄 부재, 두 원본 볼륨의 파일 내용·메타데이터를 확인한다.
  백업에 runtime key가 포함됐으면 현재 키·Secret 식별도 다시 대조한다. 이전에 서비스를 재개한
  백업이나 데이터가 바뀐 백업은 보존 복원에 사용하지 않는다. 옵션 없는 격리 복원 연습은 과거 백업도 허용한다.
- 기본 복원 연습과 같은 DB 연결 증거·WAL·보고서·파일 권한·비루트 Pod 교체 검증을 수행한다.
  검증 후 helper Pod만 제거하고 namespace·PVC·PV·StorageClass·격리 정책을 남긴다.
- 실패해도 데이터 자원을 자동 삭제하지 않는다. 소유권을 확인할 수 있는 helper만 정리하며,
  정리 실패도 오류다. CLI 오류 원문에 백업 내용·SQL·개인 파일 경로를 출력하지 않는다.
- 성공은 `RESTORED_NOT_ACTIVATED`다. 백업 해시와 namespace·StorageClass·PVC·PV의 식별 정보를
  반환하며 CLI 보존 모드의 `archive_freshness_verified=true`, `source_quiescence_verified=true`는
  `source_verification_scope=before_and_after_retained_restore` 관찰 범위에만 해당한다. 마지막 원본
  대조 후에도 대상 클러스터·보존 PVC·helper 제거 상태를 확인한다. 검사 실패 시 성공 보고서를
  출력하지 않으며, 이미 만들어진 PVC는 조사·복구를 위해 보존한다. 원본을 자동 중지·재개하지 않는다.
  반환 후 다른 프로세스가 데이터를 바꾸지 못하도록 잠그는 기능이나 실제 서비스 전환 검증은 아니다.
  이 결과만으로 Argo를 활성화하거나 접수를 재개하지 않는다.

실제 전환에는 접수·스케줄·writer 중지 후 최신 백업 확보, 검증된 같은 소스 이미지와 Secret 준비,
네트워크 접근 정책 구성, Ops 연결 변경·업무 검증이 별도로 필요하다. 실패하거나 오래된 복원본이
남아 있으면 UID·백업 해시와 보존할 데이터를 확인해 수동 정리한 뒤 새로 실행한다. 자동 삭제나
`Delete` 정책 전환을 복구 절차로 사용하지 않는다.
[`Retain` 정책](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#retain)은 PVC 삭제 시
볼륨을 수동 회수 대상으로 남기는 정책이며 백업이나 kind 노드 삭제에 대한 보호가 아니다.

LLMOps CI는 별도 kind 클러스터에서 [`smoke_evaluation_pvc.py`](../scripts/smoke_evaluation_pvc.py)를
필수 실행한다. 합성 완료 이력·보고서·checkpoint 전 WAL을 사용하며 실제 UID/GID `10001`의 Pod 교체를
확인한다. 보존 모드 반환 후 PVC·PV 식별과 `Retain` 유지, helper 제거, 재실행 거절도 검사한 뒤
합성 데이터 전용 클러스터 전체를 정리한다. 결과는 `evaluation-pvc.json` artifact로 남긴다. 이것은 실제 개인 백업의
복원 성공이나 무료 평가 실행 완료를 대신하지 않으며, 최신 커밋 CI가 통과하기 전에는 미검증 상태다.
이 합성 검사는 원본 운영 백업이 없는 `retain_for_migration` 내부 경로를 사용하므로 최신성·writer 중지
플래그를 true로 바꾸지 않는다. CLI의 원본 대조·실패 순서 테스트는 Infra CI에서 실행하며, 개인 환경의
실제 최신성 검증은 중지·백업·보존 복원 과정에서 따로 확인한다.

## 보존된 PVC와 배포 계획 연결

복원 CLI의 성공 JSON을 private 경로에 저장한 뒤 `evaluation_release.py`에
`--restore-report`와 `--state-dir`을 함께 전달한다. 이 모드는 수동 `--node`·`--prefect-claim`·
`--results-claim`과 함께 사용할 수 없다. 노드는 소유권을 확인한 개인 클러스터에서 가져오고,
PVC 이름은 복원 도구의 `prefect`·`results`로 고정한다. 실행 전 `LANGFUSE_URL` 환경변수에
실제로 접근 가능한 기존 Langfuse 주소를 설정한다.

```bash
python3 -B infrastructure/gitops/scripts/evaluation_release.py \
  --state-dir infrastructure/gitops/.local/fork \
  --restore-report /private-backups/evaluation-retained.json \
  --langfuse-url "$LANGFUSE_URL"
```

Langfuse 주소는 실제 사용 중인 접근 가능한 주소로 지정한다. 기존 수동 입력 방식의 계획 생성도
유지하지만 그 모드에서는 `retainedStorageIdentityVerified=false`다.

연결 모드는 **읽기 전용**이며 다음 순서로 동작한다.

1. 보고서 크기·복원 종류와 개인 클러스터의 저장소·브랜치·소유권을 확인한다.
2. 현재 namespace·StorageClass·PVC·PV의 UID와 소유 라벨, 바인딩 관계, `Retain` 정책,
   볼륨의 노드 고정 및 노드 Ready 상태를 대조한다. 삭제 중인 리소스는 거절한다.
3. helper를 포함한 Pod나 Deployment·Job·CronJob 등 워크로드가 하나라도 남아 있으면 차단한다.
   최초 인계를 위한 검사이므로 이미 설치한 replica 0 Deployment도 재사용하지 않는다.
4. 기존과 같은 SHA의 필수 CI·이미지 발행·공개 receipt·Helm 정책을 검증해 replica 0 계획을 만든다.
5. 클러스터 소유권과 저장소 상태를 다시 조회한다. 조회 실패나 식별 정보 변경 시 계획을 반환하지 않는다.

결과의 `retainedStorageIdentityVerified=true`와 `retainedStorage`는 조회 당시 리소스 식별을
확인했다는 뜻이다. 보고서 파일 해시는 `restoreReportSha256`, 보고서에 적힌 백업 해시는
`reportedArchiveSha256`로 구분한다. JSON 보고서는 서명된 증거가 아니며
`restoreReportAuthenticated=false`다. 파일 내용·백업 최신성·원본 writer 중지를 다시 확인한
것이 아니므로 `storageRestored`, `data_reverified`, `runtimeVerified`, `deploymentAuthorized`는
계속 false다. Secret 내용 조회, Pod 실행, Argo 적용·동기화, Ops 주소 변경은 수행하지 않는다.
두 번의 조회도 클러스터 변경을 잠그지 않으므로 실제 적용 직전에 다시 검증해야 한다.

로컬에서는 `test_evaluation_release`, `test_evaluation_pvc_restore`의 관련 테스트를 실행한다.
Infra CI의 기존 테스트 검색과 LLMOps CI의 합성 PVC 복원 단계에도 포함되며, 실제 PVC의 노드
고정·보존 상태 검사 성공 여부는 최신 커밋의 해당 CI 결과로 확인한다.

## 평가 Secret 준비

[`evaluation_secrets.py`](../scripts/evaluation_secrets.py)는 보존 PVC를 만든 **같은 암호화 백업**과
현재 인증값을 대조해 `govbiz-evaluation`의 Secret 두 개를 준비한다. WSL/Linux에서 실행하며
기본 동작은 조회·검증이다. `--create`를 명시해야 누락된 Secret을 생성한다.

```bash
# 먼저 검증: 클러스터 쓰기 없음. 백업은 --runtime-keys를 포함해 생성한 것이어야 한다.
python3 -B infrastructure/gitops/scripts/evaluation_secrets.py \
  --state-dir infrastructure/gitops/.local/fork \
  --archive /private-backups/ops-state.enc \
  --key-file /private-backups/ops-state.key \
  --restore-report /private-backups/evaluation-retained.json

# 위 명령에 --create를 추가하면 없는 Secret만 생성한다.
```

검증 흐름은 `백업 인증·복원 보고서의 백업 해시 대조 → 원본 저장소·state·Compose 프로젝트 대조 →
현재 보존 PVC와 workload 부재 확인 → Ops 토큰·참조와 기존 runner 대조 → 원본 Langfuse 프로젝트
인증 → Secret 생성·재조회`다.
백업에 기록된 실행기 컨테이너가 교체됐거나 인증값이 달라지면 새 백업·복원 기준을 확정해야 한다.
기존 컨테이너를 중지하거나 새로 시작하는 기능은 없다.

- `llmops-artifacts`: 암호화 백업의 `LLMOPS_ARTIFACT_TOKEN` 한 개. 현재 Ops Secret 및 API/sync의
  `secretKeyRef`도 같은 값을 사용하는지 확인한다.
- `llmops-runner`: 백업의 `LLMOPS_BUDGET_TOKEN`과 원본 실행기의 `LANGFUSE_PUBLIC_KEY`,
  `LANGFUSE_SECRET_KEY`. Langfuse 키는 기존 백업에 포함되지 않으므로 기록된 원본 실행기의
  ID·이미지·Compose 소유권을 확인한 뒤 읽는다. 원본 실행기의 budget 토큰도 백업과 대조한다.
- Ops에서 budget 토큰을 사용하지 않던 환경은 그 상태를 확인하고 유지한다. 이 명령이 Ops의
  budget 인증을 새로 활성화하거나 다른 토큰을 발급하지 않는다.
- 같은 Compose 프로젝트의 실행 중인 `langfuse-web` 한 개를 찾아 컨테이너 ID·이미지·프로젝트
  label·초기화 프로젝트 ID·기본 네트워크의 사설 IPv4를 확인한다. 기존 Node 런타임에서 해당 IP가
  자신의 네트워크 인터페이스 주소인지 다시 확인한 뒤 `/api/public/projects`에 GET만 보낸다.
  무인증 요청이 401/403이고 기존 runner 키의 응답이 200·정확한 프로젝트 한 개여야 통과한다.
  [Langfuse 프로젝트 API 인증](https://langfuse.com/docs/api-and-data-platform/features/public-api)을 따른다.
  `LANGFUSE_INIT_PROJECT_ID`가 없는 수동 초기화·외부 Langfuse 구성은 이 이전 도구의 지원 범위가 아니다.
- 인증키는 `docker exec -i`의 stdin으로만 전달한다. 리다이렉트·프록시·임의 URL을 사용하지 않고
  응답은 16KiB, 요청당 총 5초로 제한한다. 원문 응답과 오류를 기록하지 않으며 인증 전후 컨테이너
  교체·재시작·IP·프로젝트 변경도 거부한다. 인증 실패 시 두 Secret 모두 생성하지 않는다.
- DB 비밀번호·Django 키·OpenAI 키는 복사하지 않는다. 비밀값은 메모리와 kubectl stdin으로만
  전달하며 평문 manifest·명령 인자·도구 로그·보고서로 내보내지 않는다.
- 새 Secret은 `Opaque`, `immutable: true`이며 복원 namespace UID·백업 해시·개인 state에 연결한다.
  기존 두 이름을 모두 검사한 뒤 생성하고 정확히 같은 값·소유 정보만 재사용한다. 값 회전·삭제·
  덮어쓰기는 제공하지 않는다. 변경이 필요하면 별도 중지·교체 절차가 필요하다
  ([Kubernetes immutable Secret](https://kubernetes.io/docs/concepts/configuration/secret/#immutable-secrets)).
- 각 생성 전후에 현재 인증값과 저장소를 다시 확인한다. 부분 실패와 응답 유실은 생성 시도·확인
  내역을 남기며 자동 삭제하지 않는다. 같은 조건의 재실행으로 누락된 Secret만 준비할 수 있다.
  로컬 상태 잠금을 사용하지만 다른 운영자의 클러스터 변경을 잠그지는 않는다.

조회 성공은 `VERIFIED_NOT_CREATED`와 `missingSecrets`, 생성 성공은 `PREPARED_NOT_ACTIVATED`다.
인증 성공은 `langfuseAuthenticationVerified=true`와 `langfuseAuthentication`에 기록한다.
범위는 `compose_langfuse_container_authentication`이며 `kubernetesRouteVerified=false`다.
이 결과는 백업 최신성·원본 writer 중지·브라우저 로그인·Kubernetes에서 Langfuse로의 연결·점수 쓰기·
네트워크 통제·평가 성공을 증명하지 않는다.
현재 실제 개인 백업을 대상으로 한 생성은 별도로 수행해야 하며, Argo 동기화나 서비스 기동은 하지 않는다.

2026-10-08 개인 Compose의 기존 runner 키로 무인증 거부와 `govbiz-evidence-development` 프로젝트
인증을 확인했다. 이 환경의 Langfuse는 loopback에서 수신하지 않아 컨테이너의 자체 사설 IP를 사용했다.
서비스·키·데이터를 변경하지 않았다. Infra CI는 Node 24에서 인증 HTTP 응답·리다이렉트·실패 경계를
오프라인 검사하고, LLMOps CI는 격리된 기존 Langfuse에 실제 인증한 뒤 평가 런타임 검증을 진행한다.

## 전환 전 NetworkPolicy 실제 통신 검증

평가 API를 활성화하기 전에 개인 클러스터에서 다음 명령으로 네트워크 정책의 집행 여부를
확인한다. 이 명령은 **임시 namespace 두 개·Pod 네 개·NetworkPolicy 두 개를 생성하고 제거**한다.
기존 평가·업무 namespace, CNI, Secret, PVC와 Compose 서비스는 수정하지 않는다.

```bash
python3 -B infrastructure/gitops/scripts/evaluation_network_probe.py \
  --state-dir infrastructure/gitops/.local/fork > /private-backups/evaluation-network.json
```

CLI는 기존 개인 state와 클러스터 소유권을 검증하고 같은 state의 작업 잠금을 사용한다.
검증 Pod는 이미 평가 구성에 고정한 Prefect Python 이미지를 사용하지만 합성 HTTP 서버만 실행한다.
Pod마다 메모리 요청 32Mi·한도 64Mi, CPU 요청 10m·한도 100m을 지정한다. 비루트 사용자와
읽기 전용 파일시스템을 사용하며 ServiceAccount 토큰·Secret·볼륨은 마운트하지 않는다.
현재 개발 환경을 멈추지 않고 실행할 메모리 여유를 먼저 확인한다.

| 경로 | 정책 적용 전 | 정책 적용 중 | 정책 제거 후 |
| --- | --- | --- | --- |
| 같은 namespace의 허용 client → server | 허용 | 허용 | 허용 |
| 같은 namespace의 다른 client → server | 허용 | 차단 | 허용 |
| 다른 namespace의 동일 label client → server | 허용 | 차단 | 허용 |
| 허용 client → 다른 namespace의 server | 허용 | 차단 | 허용 |

- 모든 경로의 기준 연결을 확인한 뒤 ingress·egress 정책을 생성한다. 새 TCP 연결을 매번 사용하고,
  정책 전파를 기다리며 세 번 연속 기대 결과와 일치해야 집행 검증에 성공한다.
- 예기치 않은 HTTP 본문과 kubectl 오류는 차단 성공이 아니다. 두 서버의 loopback 응답과 정책 제거
  후 모든 경로의 연결 복구도 확인한다. 서버 장애·전체 통신 장애를 정상적인 접근 통제로 표시하지 않는다.
- 정리 시 생성한 namespace의 label·UID를 다시 확인하고 Kubernetes API 삭제 요청에 UID 조건을
  전달한다. 생성 응답이 유실돼도 이번 실행의 임의 식별자가 일치하는 리소스만 정리한다.
  하나의 정리가 실패해도 다른 namespace 정리를 시도하며 `cleanupErrors`에 이름과 오류 종류를 남긴다.
  정리가 실패한 실행은 성공으로 반환하지 않는다. 보고서의 namespace를 확인하되 기존 데이터는 삭제하지 않는다.

성공은 `ENFORCED`이며 종료 코드 0이다. `NOT_ENFORCED`는 허용 경로가 연결되는 동안 필요한 차단을
확인하지 못했다는 뜻이다. `INCONCLUSIVE`는 허용 경로도 차단되어 판정할 수 없는 경우이며,
실행·복구·정리 실패는 `ERROR`다. 이 세 상태는 종료 코드 1과
`networkPolicyEnforcementVerified=false`를 반환한다.

검증 범위는 **동일 노드 IPv4 Pod IP의 TCP 8090**이다. 다중 노드·IPv6·Service/DNS·외부 통신·
실제 Prefect/Ops 정책·인증·Argo 동기화 성공까지 입증하지 않는다. Infra CI의 `test_*.py` 탐색은
이 도구의 판정·소유권·정리 단위 테스트를 수행하며 실제 CNI 통신은 대상 클러스터에서 별도 실행한다.

NetworkPolicy 객체 생성만으로 차단이 보장되지 않는다. 정책을 집행하는 네트워크 플러그인이 필요하다
([Kubernetes NetworkPolicy 전제 조건](https://kubernetes.io/docs/concepts/services-networking/network-policies/#prerequisites)).
실제 차단이 확인되지 않으면 Prefect 전환 완료로 처리하지 않는다. CNI 변경은 별도의 인프라 작업으로
계획하고, 현재 실행 중인 클러스터에 다른 CNI를 바로 겹쳐 설치하지 않는다.

2026-10-08 개인 클러스터 `govbiz-f218b0ac1c`에서 합성 통신 검증을 실행해 `ENFORCED`를 확인했다.
정책 적용 전·제거 후 네 경로는 모두 연결됐고, 정책 적용 중 허용 경로 한 개와 차단 경로 세 개가
세 번 연속 기대 결과와 일치했다. 임시 namespace 두 개와 하위 리소스도 정리됐다.
관측된 네트워크 DaemonSet은 `kindnet`·`kube-proxy`, kindnet 이미지는
`docker.io/kindest/kindnetd:v20260820-69b56db7`였다. 이 결과를 다른 kind 버전이나 노드에 일반화하지 않는다.
새 Chart의 실제 Prefect·Ops·결과 서버 통신 검증은 최신 SHA CI와 실제 배포에서 별도로 확인한다.

### 실제 Chart 정책의 합성 통신 검증

기본 검사는 CNI의 일반적인 ingress·egress 집행을 확인한다. `--evaluation-chart`를 지정하면
같은 Helm Chart에서 렌더링한 평가용 NetworkPolicy 세 개를 새 임시 환경에서 검사한다.

```bash
python3 -B infrastructure/gitops/scripts/evaluation_network_probe.py \
  --state-dir infrastructure/gitops/.local/fork \
  --evaluation-chart --helm helm > /private-backups/evaluation-chart-network.json
```

이 모드는 임시 namespace 두 개, 합성 HTTP Pod 여섯 개와 Chart의 ClusterIP Service 두 개를 사용한다.
실제 Prefect·실행기·결과 서버 프로세스, Secret, PVC는 생성하지 않는다. 평가 namespace와 `govbiz-msa`의 관계만 임시
namespace로 바꾸며 Pod selector·허용 포트·ingress 규칙은 렌더링 결과를 사용한다. 렌더링 결과가
임시 namespace 밖을 지정하면 생성 전에 차단한다. 원본 정책 spec 해시와 namespace 치환 내역을
보고서의 `chartPolicySpecSha256`·`namespaceRebinding`에 기록한다.

| 출발 Pod | 대상 | 정책 적용 중 기대 결과 |
| --- | --- | --- |
| Ops namespace의 `ops-service` | Prefect / TCP 4200 | 허용 |
| Ops namespace의 `ops-service` | 결과 서버 / TCP 8010 | 허용 |
| 평가 namespace의 `evaluation-runner` | Prefect / TCP 4200 | 허용 |
| 평가 namespace의 `evaluation-runner` | 결과 서버 / TCP 8010 | 차단 |
| 평가 namespace의 가짜 `ops-service` | Prefect / TCP 4200 | 차단 |
| 평가 namespace의 가짜 `ops-service` | 결과 서버 / TCP 8010 | 차단 |
| 다른 namespace의 `evaluation-runner` | Prefect / TCP 4200 | 차단 |
| Ops namespace의 `ops-service` | 실행기 대역 / TCP 8090 | 차단 |

실행기 대역은 TCP 8090에서 의도적으로 응답하므로 차단 결과를 실제 실행기의 열린 포트 부재로
혼동하지 않는다. 모든 경로는 정책 적용 전·제거 후에 연결되어야 하며, 세 대상 서버의 loopback
응답도 확인한다.

Prefect·결과 서버를 향하는 일곱 경로는 **Pod IP·Service ClusterIP·Service DNS**를 각각 확인한다.
실행기는 Chart에 Service가 없으므로 기존 Pod IP 경로만 검사한다. 총 22개 검사에서 허용 9개·차단
13개가 기대 결과이며, 기존 Pod IP 키에 `__cluster_ip`·`__service_dns` 접미사로 결과를 구분한다.
Service는 같은 Chart의 selector·포트·이름 있는 `targetPort: http`를 그대로 사용한다. 잘못된 selector,
외부 IP, 추가 Service, 예상하지 않은 포트·namespace는 리소스 생성 전에 거부한다.

DNS 검사는 각 출발 Pod에서 매번 `서비스.임시-namespace.svc.cluster.local.`의 IPv4 주소를 조회하고,
그 결과가 생성 시 확인한 ClusterIP 하나와 정확히 같을 때만 해당 주소에 새 HTTP 연결을 시도한다.
DNS 조회 실패·다른 IP 응답은 접근 차단 성공이 아니라 오류다. `cluster.local`은 현재 kind의 도메인
계약이며 사용자 정의 클러스터 도메인·IPv6 검증으로 일반화하지 않는다.
[Kubernetes Service DNS 형식](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/#services)을 따른다.

정책 전파는 최대 240초의 관찰 구간에서 전체 22개 결과가 세 번 연속 일치해야 통과한다.
진행 중인 요청에는 별도의 제한 시간이 있다. 기존 기본 검사의 45초 관찰 구간은 유지한다.

LLMOps CI의 기존 `--evaluation-runtime` 단계에서도 이 모드를 필수 실행한다. Chart 프로파일의
집행 검증, Service ClusterIP·DNS 확인과 임시 자원 정리가 모두 성공해야 평가 PVC 복원·런타임 기동 단계로 진행한다. 실패·
불명확·다른 프로파일 결과는 통과시키지 않는다. 보고서는
`evaluation_kubernetes_runtime.network_policy_probe`에 남긴다. 추가 클러스터를 만들거나 기존
실행 환경을 중지하지 않고, CI가 소유한 kind 클러스터를 사용한다.

성공 시 `serviceClusterIPVerified=true`, `serviceDnsVerified=true`와
`addressModes=[pod_ip, cluster_ip, service_dns]`를 기록한다. Pod IP 검사만 통과한 이전 보고서는 새 CI
단계의 통과 근거가 아니다. 이 결과는 단일 노드 IPv4 합성 Pod·Service·DNS에 대한 검사다.
다중 노드·IPv6·애플리케이션 인증·외부 egress 검증과 구분하며 `evaluationRuntimeVerified=false`를 유지한다.

2026-10-08 기존 Pod IP 전용 Chart 모드 실행은 `ENFORCED`였다. 허용 3개·차단 5개 경로가 세 번
연속 기대 결과와 일치했고, 정책 제거 후 8개 경로의 연결 복구와 임시 namespace 정리를 확인했다.
기존 업무·평가 서비스와 CNI는 변경하지 않았다. 필수 CI에 연결한 코드의 전체 검증은 이 변경을
포함한 커밋이 푸시된 뒤 확인해야 한다.

같은 날 Service·DNS 확장 모드도 개인 클러스터에서 `ENFORCED`를 확인했다. 22개 검사에서 허용
9개·차단 13개가 세 번 연속 일치했고, 정책 적용 전·제거 후에는 22개 모두 연결됐다.
`serviceClusterIPVerified`, `serviceDnsVerified`, `cleanupComplete`는 모두 true였으며 임시
namespace 두 개와 하위 Pod·Service·NetworkPolicy 정리를 확인했다. 이는 실제 평가 서비스의
인증·실행이나 원격 필수 CI 통과를 대신하지 않는다.

## 평가 Argo 선언 등록

복원 보고서 모드에 `--register-argo`를 추가하면 검증된 AppProject 한 개와 Application 세 개를
기존 개인 GitOps 클러스터의 `argocd` namespace에 등록한다. 저장한 계획 JSON을 그대로 적용하지
않고 같은 SHA의 필수 CI·공개 이미지 발행·Helm 정책·보존 PVC를 새로 검증한다.

```bash
python3 -B infrastructure/gitops/scripts/evaluation_release.py \
  --state-dir infrastructure/gitops/.local/fork \
  --restore-report /private-backups/evaluation-retained.json \
  --langfuse-url "$LANGFUSE_URL" \
  --register-argo > /private-backups/evaluation-registration.json
```

- 개인 클러스터의 소유권과 `gitops` 모드를 확인하고, 모든 이름 충돌과 다른 Application의 평가
  namespace 사용을 생성 전에 검사한다. 등록 요청은 서버 측 dry-run을 먼저 통과해야 한다.
- `kubectl create`만 사용한다. 같은 복원 namespace UID·보고서 해시·계획 해시와 정확히 같은
  선언은 재사용하지만, 기존 리소스를 덮어쓰거나 자동 채택하지 않는다. 다른 소스나 설정으로
  갱신하는 명령이 아니며, 이미 동기화한 Application은 재사용하지 않는다.
- Application은 정확한 소스 SHA·`replicas: 0`·`automated.enabled: false`·prune/selfHeal 비활성·
  재시도 0을 유지한다. sync 요청, cascade 삭제 finalizer, ownerReference는 추가하지 않는다.
  [자동 동기화 설정](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)과
  [Application 삭제 정책](https://argo-cd.readthedocs.io/en/stable/user-guide/app_deletion/)을 따른다.
- 생성 전후에 계획과 저장소를 다시 검증하며 UID 교체·수동 sync·CI 변경을 성공으로 처리하지
  않는다. 이 검사는 클러스터 잠금이 아니므로 동시에 수동 sync나 전환을 실행하지 않는다.
- 중간 실패 시 이미 만든 선언을 자동 삭제하지 않는다. `registration.creationAttempts`와
  `created`를 남기며 응답 유실로 생성 여부를 모르면 `clusterChanged: null`을 반환한다.
  상태를 확인한 뒤 같은 명령으로 나머지만 등록할 수 있다. 보고서를 덮어쓰기 전에 이전 실행
  결과를 보존한다. 원시 오류나 비밀값은 보고서에 기록하지 않는다.

성공 상태는 `REGISTERED_NOT_SYNCED`다. Argo 화면에 등록됐다는 뜻이며 Deployment·Service·NetworkPolicy는
아직 생성하지 않는다. PVC·PV·StorageClass·namespace·Secret과 기존 업무 Application의 소유권은
변경하지 않는다. Secret 준비, 네트워크 접근 통제, 최신 백업과 원본 writer 중지, 수동 동기화·
활성화·Ops URL 전환·실제 평가 검증은 다음 단계다. 보고서는 `syncRequested=false`,
`runtimeStarted=false`, `runtimeVerified=false`, `deploymentAuthorized=false`로 이 범위를 구분한다.

## 최초 수동 동기화 요청

등록을 마친 뒤 WSL/Linux에서 `--request-dormant-sync`를 명시하면 세 평가 Application에
**replica 0의 최초 수동 동기화**를 요청한다. 기본 계획 조회와 `--register-argo`는 계속 동기화를
요청하지 않으며, 두 변경 옵션은 동시에 사용할 수 없다.

```bash
python3 -B infrastructure/gitops/scripts/evaluation_release.py \
  --state-dir infrastructure/gitops/.local/fork \
  --restore-report /private-backups/evaluation-retained.json \
  --langfuse-url "$LANGFUSE_URL" \
  --request-dormant-sync > /private-backups/evaluation-sync-request.json
```

호출 흐름은 `현재 CI·공개 이미지·보존 PVC 재검증 → 기존 Argo 선언 대조 → 서버 dry-run →
계획 재검증 → 각 Application의 operation 요청 → 발행 증거 재확인`이다.

- AppProject와 세 Application이 모두 먼저 등록되어 있어야 한다. 같은 복원 namespace UID·보고서
  해시·계획 해시와 전체 선언이 일치해야 하며, 다른 Application 소유권·이전 동기화 이력·진행 중
  작업·자동 동기화·replica 변경은 차단한다. 기존 대상 Deployment·Service·NetworkPolicy도 자동 채택하지 않는다.
- 서버 측 dry-run 세 개를 먼저 통과한 뒤에만 실제 요청을 보낸다. JSON Patch는 UID·resourceVersion·
  전체 spec을 원자적으로 검사하고 `operation`만 추가한다. 패치는 파일로 저장하거나 인자에 넣지 않고
  `/dev/stdin`으로 전달한다. 중간에 대상이나 설정이 바뀌면 덮어쓰기·재시도하지 않는다.
- [Argo CD 3.5.3 Operation 계약](https://github.com/argoproj/argo-cd/blob/v3.5.3/pkg/apis/application/v1alpha1/types.go)에
  따라 정확한 소스 SHA, apply 방식, force/prune 비활성, retry 0, `FailOnSharedResource=true`를 사용한다.
  source·로컬 manifest를 덮어쓰는 sync 옵션은 받지 않는다. replica·자동 동기화 설정과 Ops 주소도 바꾸지 않는다.
- 성공은 `DORMANT_SYNC_REQUESTED`다. 요청 확인 목록은 `synchronization.acknowledged`에 남기며
  `syncCompleted=null`, `runtimeStarted=null`, `runtimeVerified=false`, `activationRequested=false`를
  유지한다. Argo가 실제로 적용을 끝냈는지와 Pod가 없는지는 별도 조회로 확인해야 한다. 종료 코드 0이
  `Synced/Healthy`나 평가 실행 성공을 뜻하지 않는다.
- 요청 전 `attempted`를 기록하므로 응답 유실 시 `syncRequested`·`clusterChanged`가 null일 수 있다.
  중간 실패 시 나머지 요청을 멈추고 이미 요청한 작업을 취소·롤백·삭제하지 않는다. 세 Application에
  대한 요청은 하나의 트랜잭션이 아니다. 결과를 저장하고 Argo 상태를 확인한다.
- 이 명령은 최초 요청 전용이다. 일부 요청이 접수됐거나 workload가 생성됐으면 같은 명령을 반복해
  나머지를 자동 처리하지 않는다. 동기화 오류·완료 상태와 현재 선언을 확인한 뒤 복구 범위를 정한다.
  동시에 수동 sync·소스 변경·활성화를 진행하지 않는다.

오프라인 테스트는 CI·저장소 변경, 충돌, admission 변경, 응답 유실과 부분 요청을 검사하며 Infra CI의
`test_*.py` 검색에 포함된다. 실제 개인 환경의 최초 동기화·완료 확인은 검증된 공개 실행기 발행과
보존 PVC·Argo 등록이 끝난 뒤 수행한다. 이 단계에서 PVC·Secret 생성이나 실행기 기동을 대신하지 않는다.

## replica 0 동기화 완료 확인

요청 접수 이후에는 아래 읽기 전용 명령으로 Argo 적용 완료와 현재 리소스를 확인한다.
클러스터 상태를 바꾸거나 refresh·sync·scale을 요청하지 않으며 Secret 값을 읽지 않는다.

```bash
python3 -B infrastructure/gitops/scripts/evaluation_dormant_status.py \
  --state-dir infrastructure/gitops/.local/fork \
  --restore-report /private-backups/evaluation-retained.json \
  --langfuse-url "$LANGFUSE_URL" \
  > /private-backups/evaluation-dormant-status.json
```

검사 흐름은 `현재 발행·필수 CI 재검증 → 발행 SHA의 Chart 재렌더링 → 보존 PVC·Argo·실제 리소스 조회
→ 발행 증거 재확인 → 입력·클러스터·리소스 재조회`다.

- AppProject와 세 Application의 전체 선언·복원 결합 annotation·소유권을 대조한다.
  `Synced/Healthy`, 최신 작업 `Succeeded`, 비교 대상과 마지막 sync 결과의 같은 소스 SHA를 모두 요구한다.
  진행 중 operation, 오류·경고 condition, 누락·중복·정리 대상 리소스와 다른 Argo 소유권은 거부한다.
- 발행 SHA의 Chart·values로 Deployment·Service·NetworkPolicy를 재현한다. Deployment 전체 spec을
  비교하되 [Kubernetes 1.36.4 기본값](https://github.com/kubernetes/kubernetes/blob/v1.36.4/pkg/apis/core/v1/defaults.go)과
  수량의 동등한 표현만 정규화한다. 알 수 없는 필드는 제거하지 않으므로 추가 컨테이너·환경변수·볼륨도 차단한다.
  Argo 상태 계약은 [3.5.3 타입 정의](https://github.com/argoproj/argo-cd/blob/v3.5.3/pkg/apis/application/v1alpha1/types.go)를 따른다.
- 실제 Deployment의 관측 generation과 모든 replica 수 0, Pod 부재를 확인한다.
  Deployment가 만든 ReplicaSet은 정확한 owner UID·관측 generation·replica 0일 때만 허용한다.
  추가 Job·CronJob·DaemonSet·StatefulSet·HPA 등은 거부한다.
- Service 설정과 할당 주소, 평가 NetworkPolicy, 복원 때 만든 `deny-all` 정책을 확인한다.
  이 검사는 정책 선언 비교이며 CNI 집행·DNS·실제 통신 검증을 대신하지 않는다.
- namespace·StorageClass·PVC·PV의 소유권과 UID·Retain 정책을 다시 확인한다.
  초기 복원·등록·동기화 요청 경로의 **빈 namespace 조건은 그대로 유지**한다.
- 두 관측 사이에 발행·설정·복원 보고서·리소스 UID 또는 spec이 바뀌면 실패한다.
  이는 두 시점의 확인이며 이후 변경을 막는 잠금이 아니다. 보고서에는 고정 상태, 식별 정보와 해시만 기록하고
  live spec·환경변수·오류 원문은 출력하지 않는다.

성공은 `DORMANT_SYNC_VERIFIED`, `syncCompleted=true`, `podsAbsent=true`다.
`runtimeVerified`, `activationAuthorized`, `storageDataReverified`, `sourceQuiescenceVerified`,
`networkPolicyEnforcementVerified`는 계속 false다. 서비스 기동 전에는 원본 writer 중지·백업 최신성,
Secret 인증, egress를 포함한 접근 통제와 Ops 전환을 별도로 검증해야 한다.
오류는 종료 코드 1과 `BLOCKED`로 반환하며 동기화를 재요청하거나 기존 자원을 정리하지 않는다.

## 격리 Kubernetes에서 실제 평가 실행 검증

LLMOps CI의 기존 격리 통합 검증에 `--evaluation-runtime` 단계를 연결했다.
`smoke_ops_bridge.py --evaluate --evaluation-runtime --report <새 보고서 경로>`로 실행하며,
도구가 직접 만든 클러스터·Compose 프로젝트만 사용한다. 개인 클러스터를 지정하는 옵션은 없다.

실행 흐름은 `관리자 HTTP 로그인 → Kubernetes Ops API → Kubernetes Prefect → Kubernetes 실행기
→ 결과 PVC → Kubernetes 결과 서버 → Ops sync·인증 보고서 조회`다. Langfuse는 이 검증의
격리 Compose에 유지하며, 관측 서비스까지 Kubernetes로 이전했다고 보고하지 않는다.

1. 기존 격리 MySQL·볼륨 복원 검증을 먼저 완료한다. Ops API·sync와 Compose 평가 writer가 정지한
   상태에서 실제 Prefect SQLite와 완료 보고서를 읽는다. 개인 백업·운영 데이터는 사용하지 않는다.
2. 격리 Compose의 Langfuse 프로젝트 인증과 위 Chart 정책의 합성 통신 검사·임시 자원 정리를
   먼저 통과해야 한다. 인증 결과는 `evaluation_kubernetes_runtime.langfuse_authentication`에 남긴다.
   그 뒤 기존 PVC 복원
   도구로 새 namespace·StorageClass·PVC 2개에 복원하고 실행 ID·보고서 해시·권한을
   검증한다. 앞의 최소 합성 SQLite 대신 실제 평가에 사용했던 Prefect 스키마를 그대로 사용한다.
3. `environments/evaluation`의 배포용 values를 읽고 검증 전용 이미지·PVC·노드·연결 주소와 replica만
   바꾸어 렌더링한다. 실행기의 2Gi, 결과 서버의 256Mi 등 구성요소별 CPU·메모리 요청/한도를 유지한다.
   결과 서버의 자료 복사 init container도 같은 제한을 사용한다. 공통 Chart 기본값만으로 검증하지 않는다.
   실행기·결과 서버만 로컬 태그로 kind에 적재한다. Prefect는 원본 Compose 이미지 ID와 고정 digest의
   이미지 ID가 같은지 검사하고, 복원 helper가 확보한 원본 참조를 그대로 사용한다.
   같은 이미지로 렌더링한 Prefect·결과 서버를 먼저 기동하고 실행기 1개를 시작한다. 자동 migration은
   계속 비활성화한다. Ops API와 sync의 두 URL을 함께 바꾼다. 앞선 Core DB 복원 검증이 원본 보존을
   위해 중지했던 격리 Core는 복원 검증 성공·원본 보존·복원 컨테이너 정리를 확인한 뒤 재개한다.
   replica 0과 resourceVersion 조건으로 1개만 기동하고 rollout 완료 후 격리 접수와 웹 검증을 재개한다.
4. 기존 완료 이력을 확인하고 무료 평가를 접수한다. 동일 요청 재전송의 flow 일치, 백그라운드 상태
   반영, 인증 보고서 조회와 모델 호출 0회를 확인한다.
5. 실행기를 정지한 뒤 Prefect·결과 서버 Pod를 교체하고 실행기를 다시 시작한다. 실제 Pod UID 변경,
   이미지 동일성, DB 실행 ID·명세·보고서 해시 보존을 대조하고 새 무료 평가를 한 번 더 실행한다.
6. 원본 Compose 볼륨이 변경되지 않았는지 다시 읽어 비교한다. 임시 namespace·PVC·PV·StorageClass와
   이미지 태그를 정리하고, 바깥 실행기가 격리 클러스터·Compose 프로젝트를 제거한다. 검증 실패도
   정리 경로를 거치며 새 Kubernetes 쓰기를 과거 Compose DB로 되돌리지 않는다.

`ops-bridge.json`의 `evaluation_kubernetes_runtime`에 단계별 증거를 남긴다.
`scope=disposable_kubernetes_evaluation_runtime`, `observability_runtime=isolated_compose`,
`production_cutover=false`, `personal_environment_verified=false`를 명시한다. NetworkPolicy 성공은
별도 합성 검사를 통과한 경우에만 `network_policy_enforcement_verified=true`로 기록하며 범위는
`network_policy_scope=single_node_synthetic_chart_ingress_pod_service_dns`다. 이 결과는 Argo CD 배포·공개 이미지
발행·운영 PVC 인계의 증거가 아니다. 로컬 단위·렌더링 검사만 통과한 상태에서는
**실제 런타임 검증은 최신 SHA CI 대기**다.

평가 Deployment의 rollout이 실패하면 임시 namespace를 정리하기 전에 같은 보고서의
`evaluation_kubernetes_runtime.rollout_failure`에 실패 component·오류 종류, Pod 배치 여부,
init/main 컨테이너의 준비 상태·재시작 횟수·현재/직전 종료 사유와 코드를 남긴다.
Pod 로그와 이벤트는 크기·시간 제한 안에서 읽고, 권한·읽기 전용 파일시스템·DB 스키마·볼륨 마운트·
메모리/디스크 압박·프로브 연결 거부 등의 **고정 진단 코드**만 `signals`에 기록한다.
로그 원문, Pod spec, 환경변수·Secret 값, 이벤트 원문은 artifact에 저장하지 않는다.
진단 조회 자체가 실패하면 `diagnostic_errors`로 구분하고 원래 rollout 오류를 그대로 반환한다.
최초 기동·Prefect/결과 서버 재시작의 240초와 실행기 재기동의 180초 제한, CI 실패 판정,
임시 PVC·태그 정리 경로는 유지한다. 진단 정보가 없거나 일부만 수집됐다고 정상으로 처리하지 않는다.

임시 PVC 정리가 실패하면 `evaluation_kubernetes_runtime.restored_pvc.cleanup_failure`에
실패 단계·오류 종류를 남긴다. 같은 namespace UID·소유권을 확인한 뒤 삭제 진행 여부,
알려진 namespace 정리 조건, 남은 Pod·PVC 개수와 삭제 중·finalizer 보유 개수만 조회한다.
진단은 조회당 최대 10초인 두 번의 읽기로 제한하고, 이름·조건 메시지·finalizer 이름·spec·로그는
저장하지 않는다. 조회 실패는 고정 `diagnosticErrors`로 구분하며 원래 정리 오류를 유지한다.
삭제 재시도·강제 삭제·finalizer 제거와 제한 시간 증가는 수행하지 않는다.

이 경로를 수정한 뒤에는 `test_smoke_evaluation_runtime`의 실패·민감값 비노출·정리 순서 검증과
최신 SHA의 실제 LLMOps CI를 함께 확인한다. 별도 합성 데이터로 수행한 로컬 Prefect 기동 성공은
CI의 전체 Ops 복구·평가 실행·Pod 교체 성공을 대체하지 않는다.

`4103390`의 LLMOps CI에서는 세 평가 Pod의 최초 기동까지 통과했지만, 후속 웹 포트포워드 시작에
실패했다. Core DB 복원 도구가 `core-service`를 replica 0으로 남긴 뒤 평가 런타임 경로가 이를
재개하지 않은 결함을 수정했다. `evaluation_kubernetes_runtime.core_resume`에 재개 결과를 기록하며
실제 전체 통과 여부는 이 수정이 포함된 최신 SHA의 CI로 확인한다. 개인 Core를 자동 재시작하는 기능은 아니다.

2026-10-08 `faf8c9a`의 [LLMOps CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/37723156467)가
통과했다. 보고서에서 평가 런타임 `PASS`, 기존 완료 이력 3개 복원, 무료 평가와 Pod 교체 후 재평가,
인증 보고서 조회, 원본 저장소 보존, 모델 호출 0회와 정리 완료를 확인했다. 이는 격리된 런타임의
검증 기록이며 개인 환경 전환·이미지 발행이나 이후 Service/DNS·인증 변경의 최신 SHA CI를 대신하지 않는다.

같은 날 `4a99bf2`의 [LLMOps CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/37729887987)는
Service·DNS를 포함한 접근 통제, PVC 복원, 무료 평가와 Pod 교체 후 재평가까지 통과했지만
마지막 임시 namespace 삭제 단계에서 실패했다. 기존 보고서에는 삭제 실패 원인이 없어
위의 정리 진단을 추가했다. 삭제 지연·finalizer 등을 원인으로 확정하거나 해결됐다고 판단하지 않으며,
새 진단이 포함된 최신 SHA의 전체 실행 결과를 확인해야 한다.

`81c34d5`의 [LLMOps CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/37739740166)는 통과했다.
artifact에서 평가 런타임 `PASS`, 네트워크 정책 집행 확인, 모델 호출 0회와 `cleanup_complete=true`를
확인했다. 해당 실행에서는 정리 실패가 재현되지 않았으며, 과거 간헐 실패의 원인이 해결됐다는 뜻은 아니다.

Kubernetes 1.36의 이미지 자격 증명 검증은 이미지 ID 외에 저장소 이름별 pull 기록도 확인한다.
복원 helper가 받은 Prefect 이미지를 `govbiz/prefect:...`로 바꾸면 CRI에 이미지가 있어도 새 저장소의
기록이 없어 `Never` 정책에서 `ErrImageNeverPull`이 발생할 수 있다
([Kubelet pull 기록 처리](https://github.com/kubernetes/kubernetes/blob/v1.36.4/pkg/kubelet/images/pullmanager/image_pull_manager.go),
[Never 정책 처리](https://github.com/kubernetes/kubernetes/blob/v1.36.4/pkg/kubelet/images/image_manager.go)).
원본 digest 참조를 보존해 이 불일치를 방지한다. Kubelet의 검증 설정·기록과 rollout 제한은 변경하지 않는다.

## 후속 완료 기준

1. 기존 [암호화 백업·복원](../../../docs/ops-upgrade-runbook.md)을 이용해 **새 Kubernetes PVC**로
   Prefect·결과를 복원하고 실행 ID·보고서 해시·SQLite WAL·파일 권한을 대조한다. 현재 복원 도구의
   격리 Docker 검증과 새 PVC 검증을 구분한다. 임시 PVC 복원 도구·필수 CI 경로는 추가했으며,
   이전용 PVC 보존 옵션과 복원 전후 원본 최신성·중지 상태 대조도 구현했다. 실제 개인 백업 적용·최신성 확인과 서비스 인계는
   남아 있다. 원본 볼륨은 유지한다.
2. runner 이미지의 같은 SHA CI·공개 발행·실행 명세 검증 경로는
   [별도 실행기 발행 workflow](../../release/README.md#kubernetes-평가-실행기-이미지)에 추가했다.
   v3 receipt 소비·같은 SHA의 Ops 이미지 대조·독립 수동 Argo 계획도 구현했다.
   실제 패키지 준비·최신 SHA CI·발행 성공과 운영 환경에서의 계획 검증은 별도로 확인해야 한다.
   기존 네 서비스의 필수 CI·발행 가드를 우회하지 않는다. 배포 방식은 서비스별 Argo Application과 수동 동기화를 유지한다.
   평가용 계획은 별도 프로젝트로 범위를 제한한다. 복원 보고서와 현재 보존 PVC를 대조해 수동 계획에
   연결하는 읽기 전용 경로, Argo 선언 등록과 replica 0 최초 수동 동기화 요청·적용 완료 확인 명령은 구현했다. 실제 등록·동기화 실행과
   namespace·PVC 확인 및 서비스 인계는 남아 있다. 암호화 백업과 기존 runner에서 평가 Secret만
   준비하는 명령도 구현했으며 실제 개인 백업을 이용한 생성·인증 검증은 별도다.
   운영 진단은 위의 평가 Application 조회를 포함하지만 런타임·저장소 검증은 별도다.
3. 위 격리 Kubernetes 런타임 검증의 최신 SHA 필수 CI 성공을 확인한다. 검증 경로는 구현했으며,
   실행 실패·취소·건너뛰기를 완료로 처리하지 않는다. 이후 개인 환경의 같은 이미지·백업으로 별도 검증한다.
4. 실제 전환 시 Ops 접수·스케줄과 Compose writer를 중지하고 최신 백업을 만든다. 복원 검증 후
   Ops의 URL을 전환한다. 그 전에 위 합성 통신 검사로 CNI 집행을 확인하고 실제 평가용 정책의
   허용·차단 경로도 검증해야 한다. 새 대상에 쓰기가 생긴 뒤에는 과거 Compose DB로 단순 URL 롤백하지 않는다.
5. Langfuse와 관련 DB·저장소는 별도 이전 단위로 검증한다. 마지막에 임시 브리지를 제거하며,
   기존 Compose 데이터 삭제는 별도의 보존·복구 확인 이후 수행한다.
