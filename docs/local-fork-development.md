# 개인 포크의 Kubernetes에서 개발하기

> 별도 배포 브랜치·PR 절차는 제거했습니다. 소스 이미지의 `up --local-images`와 검증된 GHCR의 `up`을 지원합니다.
> GHCR `up`은 현재 기본 브랜치의 CI·발행·receipt를 직접 확인하며 추가 PR이 없습니다.
> 새 Argo 자동 배포 연결은 아직 없습니다.

Windows에서 도구 설치부터 시작하거나 GHCR 이미지 없이 실행하려면
[WSL2·kind 수동 설치 안내](windows-kubernetes-setup.md)를 먼저 따릅니다.
로컬 소스 빌드 경로에는 아래 GHCR 패키지 준비와 PAT가 필요하지 않습니다.

무료 시연이 아닌 RabbitMQ·AI·메일·수집 연결은
[개인 Kubernetes 외부 연동](../infrastructure/gitops/docs/local-integrations.md)을 따릅니다.

교육기관 원본은 제출·병합 대상입니다. 각자의 `origin` 포크가 이미지 발행과 GitOps의 기준이며,
코드에 `ilil1`이나 다른 팀원 계정을 직접 넣지 않습니다. 최초 설정은 각 포크·PC별로 필요합니다.
토큰·런타임 비밀값·로컬 상태는 Git에 커밋하지 않습니다.

GHCR 이미지를 사용하는 경우 [비공개 GHCR 최초 준비](private-ghcr-setup.md)를 먼저 진행합니다. 완료 전에는
`MSA_RELEASE_ENABLED=false`, `MSA_PROMOTION_ENABLED=false`를 유지합니다.
최초 등록용 일회성 쓰기 인증과 PC에서 상시 사용할 읽기 인증은 별개입니다.
네 패키지가 비공개·본인 소유·정확한 자기 포크 연결 상태로 먼저 준비되고 검증돼야 합니다.
다른 사람 계정의 토큰을 받거나 여러 YAML의 계정명을 수동 치환하는 방식은 사용하지 않습니다.
이 설명의 기본값은 비공개입니다. 의도적으로 공개하는 경우에는 [공개 전환 절차](public-ghcr-transition.md)를
먼저 완료해야 합니다. 공개 receipt로 승격된 뒤에는 PC의 pull PAT가 필요하지 않습니다.

아래의 `init`·`doctor`와 명시적 로컬 이미지 경로는 GHCR 준비와 별개입니다.
GHCR 기반 `up`은 현재 발행 결과를 직접 검증합니다. `gitops` 전환은 과거 환경 호환 경로이며 새 활성화 안내가 아닙니다.

## 두 실행 모드

| 모드 | 반영하는 코드 | 이미지 경로 | 서비스 변경 주체 |
|---|---|---|---|
| `dev` | 자기 PC에 저장한 코드, 아직 커밋하지 않은 새 소스도 포함 | 로컬 Docker 빌드 → 자기 kind에 적재 | `dev.py` |
| 기존 `gitops` | 과거 환경 호환용. 새 활성화 절차는 제거 | 기존 배포 이미지 | 기존 Argo CD |

개발 모드는 Argo CD의 Application을 제거하되 서비스·DB·볼륨을 삭제하지 않습니다.
동일 Deployment를 Argo CD와 개발 도구가 동시에 수정하지 않게 하는 구분입니다.
개발 중 저장한 코드는 다른 팀원의 PC, GHCR, GitHub에 자동 업로드되지 않습니다.

## 1. 공통 준비

- Intel Mac 또는 x64 Windows의 **WSL2 Ubuntu**에서 실행합니다. Windows는 Docker Desktop의
  해당 WSL 배포판 연동과 Linux 컨테이너를 켜야 합니다. 명령은 PowerShell이 아닌 WSL 터미널에서 실행합니다.
- WSL에서는 저장소를 `/mnt/c/...` 대신 `~/projects/...` 같은 Linux 파일 시스템에 클론하는 편이
  파일 검사·Docker 빌드에 적합합니다.
- Git, Python **3.13**, Docker, kind **0.33.0**, Helm **4.3.0**, kubectl **1.36 계열**을 준비합니다.
  웹 개발에는 프로젝트가 지정한 Node **24.x**와 pnpm 버전도 필요합니다.
- 현재 서비스 이미지·도구 경로는 **`linux/amd64`**만 지원합니다. ARM Mac/Windows를 자동으로
  에뮬레이션하지 않으며 별도 플랫폼 검증 전에는 명확한 오류로 중단합니다.
- 전체 MSA는 여러 DB·검색 저장소를 함께 실행합니다. 기존 Compose와 동시 실행하면 메모리 부족이
  발생할 수 있으므로, 개발 환경을 선택해서 실행합니다. 이 도구가 다른 컨테이너를 임의로 중지하지 않습니다.

아래 명령은 모두 **클론한 저장소 루트**에서 실행합니다.

```bash
python3.13 -m venv infrastructure/gitops/.tools/venv
source infrastructure/gitops/.tools/venv/bin/activate
python -m pip install -r infrastructure/gitops/scripts/requirements.txt

git remote -v
python -B infrastructure/gitops/scripts/fork_cluster.py init
python -B infrastructure/gitops/scripts/fork_cluster.py doctor
```

`origin`은 자기 포크, `upstream`은 교육기관 원본이어야 합니다. `init`은 `origin`의 계정·저장소와
소스 기본 브랜치를 읽습니다. 별도 배포 브랜치는 만들지 않습니다.
GitHub의 기본 브랜치 자체를 변경한 경우에만 처음에 `init --branch 브랜치명`으로 명시합니다.
생성된 설정은 `infrastructure/gitops/.local/fork/settings.json`에만 저장됩니다.
클러스터 이름은 저장소 식별값으로 정해지므로 사용자마다 파일의 이름을 바꿀 필요가 없습니다.

## 2. 최초 실행 이미지 준비

GHCR 경로의 선행 조건은 [이미지 발행 안내](msa-image-release.md)의 **기존 비공개 패키지 네 개**입니다.
발행기는 각 패키지가 비공개이며 본인 소유이고 정확히 자기 포크에 연결됐는지 업로드 전에 확인합니다.
패키지가 없거나 접근할 수 없으면 새 패키지를 자동 생성하지 않고 중단합니다.
공개 포크의 `GITHUB_TOKEN`으로 새 패키지를 만들면 저장소의 공개 범위를 상속할 수 있으므로,
처음부터 비공개라고 가정하지 않습니다. [별도 초기 생성·검증 절차](private-ghcr-setup.md)는
앱 코드 없는 빈 이미지를 로컬 PAT로 등록한 후 권한을 확인합니다.

패키지 준비와 이미지 발행을 명시적으로 허용하면, upstream에 병합한 소스를 개인 포크의 기본 브랜치에
동기화하고 같은 SHA의 다섯 CI가 통과한 뒤 이미지를 발행합니다. 별도 배포 PR은 만들지 않습니다.
GHCR 초기화는 [현재 발행 검증](../infrastructure/gitops/docs/image-promotion.md) 경로를 사용합니다.
같은 커밋의 Git 설정과 네 receipt를 임시 디렉터리에서 렌더링하며 로컬 수정은 보존합니다.
`gh auth status`로 CI·Actions artifact 조회 로그인을 확인한 뒤 실행합니다.
비공개 pull 인증은 기존 숨김 입력 또는 `--token-file`을 사용하며 `read:packages`만 허용합니다.

```bash
python -B infrastructure/gitops/scripts/fork_cluster.py up
python -B infrastructure/gitops/scripts/fork_cluster.py status
```

CI·receipt 검증, Helm 검사, 실제 pull 권한 확인, Ops migration이 실패하면 후속 실행을 중단합니다.
성공한 소스 SHA·발행 run·이미지는 로컬 `baseline.json`에 기록합니다. 이 초기화가 Argo 자동 배포를 켜지는 않습니다.

### 실제 배포 이미지와 준비 상태 확인

`status --json`은 전용 kubeconfig의 소유권을 확인한 뒤 Deployment·Pod·Node·PVC·Argo 상태와
진단을 실행한 파일시스템의 여유 공간을 읽습니다.
Docker·GHCR·모델 API는 호출하지 않으므로 Docker daemon 진단과 별도로 사용할 수 있습니다.

```bash
python -B infrastructure/gitops/scripts/fork_cluster.py status --json \
  --state-dir /실제/개인/state/경로
```

- `services`에 등록 이미지, Deployment 이미지, Pod의 실제 `image_id`·재시작 횟수를 표시합니다.
  관측 generation·updated/available replica·Pod Ready·컨테이너 Ready를 함께 검사합니다.
- `workloads_ready`와 `baseline_matches`를 구분합니다. Pod 누락·갱신 중·API/sync 이미지 차이 또는
  baseline 누락은 성공으로 처리하지 않으며 JSON 출력 후 종료 코드 1을 반환합니다.
- `schema_version=2`부터 `nodes_healthy`, `storage_ready`, `local_storage_ok`도 종료 코드에 반영합니다.
  노드 Ready, Memory/Disk/PID Pressure, 명시된 NetworkUnavailable, 스케줄링 중지 여부를 확인합니다.
  필수 노드 condition이 누락되거나 Unknown이면 정상으로 처리하지 않습니다.
- `storage_ready`는 PVC가 하나 이상 존재하고 모두 Bound·볼륨 할당·삭제 중 아님을 확인합니다.
  실행 중이거나 대기 중인 Pod가 참조하는 PVC 누락도 실패입니다. DB 연결·볼륨 여유·백업 복구를
  검증한 결과는 아니므로 해당 확인은 별도로 필요합니다.
- `local_filesystems`는 checkout과 state 경로별 `free_bytes`를 표시합니다. 각 경로에 최소 1GiB가
  남아 있어야 `local_storage_ok=true`입니다. 이는 진단용 최소 기준이며 이미지 빌드에 충분하다는
  보장은 아닙니다. 조회 실패는 `DISK_USAGE_UNAVAILABLE`로 표시합니다.
  WSL 내부에서 실행하면 Windows 드라이브와 Docker 데이터 위치가 자동으로 모두 검사되지는 않습니다.
  `nodes_healthy=true`도 Windows 호스트의 디스크 여유를 보장하지 않습니다.
- `checkout_sha`는 **진단 도구를 실행한 checkout**의 커밋입니다. WSL state가 다른 폴더에 있어도
  그 폴더의 커밋이나 이미지 빌드 소스로 바꿔 표시하지 않습니다. `checkout_dirty=null`은 Git 조회
  실패·시간 초과로 미확인이라는 뜻이며 깨끗한 작업 폴더가 아닙니다.
- 이미지 문자열 일치는 소스 증명이 아닙니다. `image_source_verified`, `application_paths_verified`,
  `backup_verified`는 false입니다. 최신 기능 반영·로그인·업무 처리·백업 복원은 별도 확인합니다.
- Secret 값·컨테이너 환경변수·kubeconfig 인증값은 출력하지 않습니다. 자료나 리소스를 수정하지 않으며,
  `argocd.application_crd_present=false`는 Argo Application을 조회할 수 없는 환경임을 표시합니다.

이 보고서는 수집 시점의 상태입니다. 배포 중 여러 조회 사이에 상태가 바뀔 수 있으므로 배포 승인서로
사용하지 않습니다. Kubernetes 조회는 명령당 15초, Git 조회는 10초로 제한하며 실패를 정상으로 숨기지 않습니다.
`doctor`도 Docker·kind 조회를 각각 15초로 제한합니다. Docker timeout이 Kubernetes 중단을 뜻하지는 않습니다.
노드 condition 의미는 [Kubernetes 공식 문서](https://kubernetes.io/docs/concepts/architecture/nodes/#condition)를 따릅니다.

### Kubernetes와 Compose의 Ops 연결 상태 확인

Ops를 Compose 평가 실행기와 연결한 환경에서는 Pod Ready 외에 Prefect·결과 서버·실행기와
브리지도 확인합니다. Docker가 실행 중일 때 다음 읽기 전용 옵션을 사용합니다.

```bash
python -B infrastructure/gitops/scripts/fork_cluster.py status --json --ops-details \
  --state-dir /실제/개인/state/경로
```

- `ops_details.containers`는 연결 기록의 Compose 프로젝트에서 `prefect`, `ops-artifacts`,
  `evaluation-runner`를 각각 조회합니다. 중지·누락·중복·일시 정지·재시작 중·불량 health 상태와
  Docker 조회 실패를 구분합니다. 과거 `restart_count`가 양수라는 이유만으로 실패시키지는 않습니다.
- `ops_details.bridge_verified`는 세 컨테이너가 준비된 뒤 기존 브리지 검사로 소유권·내부망·노드
  연결·Kubernetes Service/EndpointSlice와 실제 컨테이너 주소 일치를 확인한 경우에만 true입니다.
  검사 전후 컨테이너가 교체되거나 재시작 횟수가 바뀌면 실패합니다.
- `status=FAIL`은 컨테이너 또는 브리지 검사 실패, `UNKNOWN`은 연결 기록 누락·불일치 또는
  개발 모드가 아님을 뜻합니다. 둘 다 기본 Kubernetes 결과와 함께 JSON을 출력하고 종료 코드 1을
  반환합니다. 개인 Ops 연결을 아직 구성하지 않았다면 이 옵션을 사용하지 않습니다.
- healthcheck가 없는 컨테이너는 `health=null`로 표시합니다. `PASS`도 프로세스와 브리지 관측 결과이며
  HTTP 인증·DB 연결·실제 평가 성공을 보장하지 않습니다. `application_paths_verified=false`와
  `evaluation_executed=false`를 유지하며 업무 경로는 `ops_runtime.py --check`와 무료 평가로 별도 확인합니다.
- Secret·환경변수·명령 인자·health 로그는 수집하지 않고 subprocess 오류 원문도 출력하지 않습니다.
  컨테이너 시작·중지·재생성, 브리지 갱신, 평가 접수 또는 state 변경을 수행하지 않습니다.

`COMPOSE_NOT_READY`이면 표시된 서비스와 해당 의존성부터 확인합니다. 컨테이너가 모두 정상인데
`BRIDGE_CHECK_FAILED`이면 `ops_bridge.py check`로 원인을 확인한 뒤 필요한 경우에만 기존
[브리지 연결 절차](../infrastructure/gitops/docs/ops-runtime.md)를 따릅니다.
기본 `status --json`은 계속 Docker 없이 동작하고 `--image-details`와 함께 사용할 수도 있습니다.

### 실행 이미지와 현재 서비스 코드 비교

Docker가 정상일 때 `--image-details`를 추가하면 전용 kind 노드의 이미지 메타데이터도 읽습니다.
기본 `status --json`은 계속 Docker 없이 동작합니다.

```bash
python -B infrastructure/gitops/scripts/fork_cluster.py status --json --image-details \
  --state-dir /실제/개인/state/경로
```

- `image_details.runtime_images_match`는 Deployment 이미지 참조를 CRI로 조회한 config ID·digest
  목록과 Pod의 실제 `imageID`를 비교하고, 목록에 없는 실행 ID는 별도로 조회합니다.
  archive import의 digest가 별도 조회 이름으로 등록되지 않았어도 정확한 digest 일치를 확인할 수 있습니다.
  같은 태그를 다른 이미지에 다시 붙였더라도 실행 중인
  이미지가 다르면 실패합니다. Docker manifest ID와 CRI config ID를 직접 비교하지 않습니다.
  Ops API와 `ops-sync`도 각각 확인합니다.
- `containers[].declared_revision`은 **실제 실행 이미지**의 `org.opencontainers.image.revision`
  또는 기존 `dev.govbiz.source` 라벨입니다. 40자리 커밋 SHA가 아니거나 두 라벨이 서로 다르면
  출처를 미확인으로 표시하며 임의 라벨 내용이나 컨테이너 환경변수는 출력하지 않습니다.
- `service_tree_comparison`은 그 커밋과 **도구를 실행한 checkout의 `backend/<서비스>` 전체**를
  비교합니다. `CHANGED`는 수정·삭제·stage된 파일이나 Git ignore 대상이 아닌 새 파일이 있다는
  뜻입니다. `UNCHANGED`는 이 디렉터리의 차이가 없다는 뜻이며, 서비스 문서 변경도 비교에 포함됩니다.
  다른 서비스나 인프라 파일만 바뀌었다면 해당 서비스는 변경으로 표시하지 않습니다.
- 라벨 누락·충돌, checkout에 없는 커밋, Git 조회 실패는 `UNKNOWN`입니다. 자동 fetch나 빌드는
  하지 않습니다. 이미지 조회 실패도 성공으로 처리하지 않으며 각 Docker·Git 조회는 15초로 제한합니다.
- 이미지 불일치·조회 실패 또는 소스 비교가 `CHANGED`/`UNKNOWN`이면 기존 상태 JSON에 상세 결과를
  함께 출력하고 종료 코드 1을 반환합니다. `source_review_required=true`는 배포할 소스와 이미지의
  대응 관계를 검토하라는 뜻이며, 서비스 장애를 의미하지는 않습니다.

이 진단은 이미지 라벨을 바탕으로 한 비교입니다. 라벨에는 빌드 당시 수정 파일·의존성·실제 빌드 입력의
증명이 없으므로, 일치하더라도 `image_source_verified=false`를 유지합니다. 기존 상태 조회와 마찬가지로
여러 조회를 묶은 원자적 배포 승인서가 아니며, 이미지 교체·클러스터 재시작·데이터 변경은 수행하지 않습니다.

GHCR 없이 로컬 이미지로만 검증하려면 [로컬 이미지 빌드 도구](../infrastructure/scripts/build-msa-images.py)의
새 이미지 manifest를 `up --local-images /절대경로/images.json`으로 전달할 수 있습니다.
이 경로의 성공을 비공개 GHCR 인증·pull 성공이라고 보지는 않습니다.

## 3. 저장한 백엔드 코드 반영

이미 GitOps 모드였다면 먼저 개발 모드로 전환합니다. 최초 `up` 직후는 이미 개발 모드입니다.

```bash
python -B infrastructure/gitops/scripts/fork_cluster.py dev
python -B infrastructure/gitops/scripts/dev.py --watch --service ai-service
```

`core-service`, `catalog-service`, `ai-service`, `ops-service` 중 개발할 서비스를 선택합니다.
여러 서비스를 모두 감시하려면 `--service all`을 사용합니다. 감시 없이 한 번만 현재 코드를 반영하려면:

```bash
python -B infrastructure/gitops/scripts/dev.py --once --service core-service
```

**Compose 실행기에 연결한 Ops는 전용 갱신 경로를 사용합니다.** `ops-activation.json`이 있거나
실제 Ops 컨테이너의 `PREFECT_API_URL`이 명시적인 초기화용 비활성 주소가 아니면 `dev.py`의
Ops 빌드·교체·복원을 차단합니다. URL 누락·Secret 참조·중복 설정도 연결 상태 미확인으로 차단합니다.
`--once --service all`과 `--watch --service all`은 다른 서비스를 갱신하기 전에 이 조건을 확인합니다.
이 환경에서 Core·Catalog·AI를 개발할 때는 해당 `--service`를 명시합니다.

초기화용 `fork_cluster.py up`도 활성화 기록 또는 기존 Deployment의 연결 상태를 확인해 같은 우회를
막습니다. 기록 파일을 삭제해도 실제 연결 설정이 남아 있으면 허용하지 않습니다. 연결된 Ops의 갱신은
[Ops 갱신 절차](../infrastructure/gitops/docs/ops-runtime.md)에 따라 `ops_runtime.py --preflight`와
명시적인 `--ops-image` 경로로 진행합니다. 이 경로에서 실행기 release 일치·진행 중 작업·migration·
실행 후 런타임 상태를 확인합니다. 기존 `dev-images.json`에 Ops 복원 기록이 남은 상태에서 연결이
활성화됐다면 자동 복원하지 말고 현재 이미지·연결·스키마를 먼저 확인해야 합니다.

처음에는 선택한 서비스의 **현재 작업 파일**로 이미지를 빌드합니다. 그다음부터 기본 2초 간격으로
파일 내용의 변화를 확인하고, 변경된 서비스만 순서대로 다시 빌드합니다. 빌드 중 여러 번 저장한 내용은
다음 검사에서 최신 상태로 모아 반영합니다. Java 컴파일·의존성 설치에는 수 분이 걸릴 수 있으므로
즉시 hot reload가 아니라 **자동 이미지 재빌드·배포**입니다.
Docker 플랫폼·이미지 조회, Git 입력 목록, Deployment 조회는 명령당 15초로 제한합니다.
조회 오류나 시간 초과는 빌드를 허용하는 조건이 아니며, 이미지 조회 실패 시 빌드·이미지 교체·
복원 기록 갱신을 시작하지 않습니다. 초기 연결 확인 실패는 종료 코드 1로 반환합니다.

`Dockerfile`, `.dockerignore`, 잠금 파일과 해당 Dockerfile의 소스 입력을 감시합니다.
Git에 아직 추가하지 않은 새 소스도 반영하지만 Git ignore 대상, `.env*`, 캐시, 로그, 개인 키 파일은
제외합니다. 이미지는 허용된 입력만 복사한 임시 빌드 컨텍스트로 만듭니다. 소스 코드 자체에 비밀값을
하드코딩하면 보호할 수 없으므로 계속 환경변수/Secret을 사용해야 합니다.

빌드 실패 시 현재 컨테이너 이미지는 바꾸지 않습니다. rollout 실패 시 도구가 넣은 이미지가 그대로인지
확인한 뒤 직전 이미지로 복원하며 실패를 보고합니다. 같은 실패 입력을 무한히 재빌드하지 않습니다.
코드를 수정해 저장하거나 명령을 다시 실행하면 재시도합니다. **이미지 복원은 DB migration이나 사용자가
변경한 데이터를 되돌리지 않습니다.** 스키마 변경은 별도 검토·검증이 필요합니다.

`Ctrl+C`는 감시만 종료합니다. 서비스·데이터는 계속 남습니다. 실행 중인 감시 명령이 있으면 같은 환경의
두 번째 감시나 모드 전환을 막습니다. 비정상 종료 후 `dev.lock`이 남았다면 실제 프로세스 종료 여부를
확인한 뒤 해당 파일만 정리해야 하며, 도구가 잠금을 임의로 빼앗지 않습니다.
복원용 로컬 이미지도 자동 삭제하지 않으므로 장기간 개발하면 Docker 디스크 사용량이 늘 수 있습니다.
정리할 때는 사용 중인 이미지·볼륨을 확인하고 자기 개발 이미지 태그만 대상으로 삼아야 합니다.

## 4. 웹 개발

별도 터미널에서 자기 Core Service를 loopback으로만 연결합니다.

```bash
python -B infrastructure/gitops/scripts/fork_cluster.py web
```

다른 터미널에서 웹 개발 서버를 실행합니다.

```bash
pnpm install --frozen-lockfile
pnpm --dir frontend/web dev:k8s
```

웹의 Vite 개발 서버는 `localhost:5173`에서 실행됩니다. `web` 명령은 Core `127.0.0.1:18080`과
Ops `127.0.0.1:18001`을 같은 클러스터로 함께 연결합니다. 이미 사용 중인 포트가 있으면 중단하므로
기존 Compose Ops에 잘못 접속하지 않습니다. Pod 교체로 한쪽 전달이 끊기면 두 전달을 정리하며 명령을 다시 실행해야 합니다.

Compose Ops가 `18001`을 사용 중이면 기존 컨테이너를 중지하지 않고 전달 포트를 선택합니다.
두 명령의 포트 번호를 반드시 일치시킵니다. 포트를 자동 탐색하거나 다른 리스너를 재사용하지 않습니다.

```bash
# WSL/Linux: 첫 번째 터미널, 기존 state 경로를 사용
python -B infrastructure/gitops/scripts/fork_cluster.py web --core-port 28080 --ops-port 28001

# WSL/Linux: 두 번째 터미널, 저장소 루트
K8S_CORE_PORT=28080 K8S_OPS_PORT=28001 pnpm --dir frontend/web dev:k8s
```

Windows에서 웹을 실행한다면 두 번째 명령 대신 PowerShell에서 설정합니다.

```powershell
$env:K8S_CORE_PORT = '28080'
$env:K8S_OPS_PORT = '28001'
pnpm --dir frontend/web dev:k8s
# 종료 후 해당 터미널의 설정 해제
Remove-Item Env:K8S_CORE_PORT, Env:K8S_OPS_PORT
```

기존 상태가 다른 체크아웃에 있으면 `web --state-dir /기존/절대/state/경로`를 지정합니다.
소유권 확인이 실패하면 상태 파일을 복사·수정해서 강제로 연결하지 않습니다.
`--core-port`·`--ops-port`는 `web` 전용이며 서로 다른 `1024..65535` 정수만 받습니다.
Vite의 `K8S_CORE_PORT`·`K8S_OPS_PORT`는 `portfolio`·`connected` 모드의 서버 프로세스에서만 읽습니다.
`.env`에 저장해도 해당 모드는 읽지 않으며, 임의 URL·호스트 또는 브라우저 환경변수 노출은 허용하지 않습니다.
웹 주소는 계속 `http://localhost:5173`입니다. `5173`도 사용 중이라면 웹 서버를 함께 실행할 수 없으며,
임의 포트로 옮기기 전에 Core의 허용 Origin과 Ops의 웹/CSRF 설정을 함께 검토해야 합니다.
포트 연결 성공은 Ops 활성화나 무료 평가 완료의 증거가 아닙니다.

프런트 파일 저장 반영은 Vite가 담당하며 백엔드 이미지 감시 명령과 별개입니다.
평가 실행은 [Ops 활성화 절차](../infrastructure/gitops/docs/ops-runtime.md)를 먼저 완료하고
기존 Core 관리자 계정으로 `/ops/evaluations`에 접속합니다.

## 5. 개발 작업 제출

개발 코드는 기존 `skn-*` 브랜치에 커밋·푸시하고 `main`으로 PR을 제출합니다.
필수 CI 통과 후 리뷰 승인 없이 수동 병합합니다. 별도 배포 PR은 만들지 않습니다.

개발 이미지를 이전 상태로 복원해야 할 때는 감시를 종료한 뒤 다음 명령을 사용합니다.

```bash
python -B infrastructure/gitops/scripts/dev.py --restore --service all
```

이 명령은 개발 도구가 보관한 기존 이미지로 복원하며 소스 파일·Git 커밋·DB 데이터를 되돌리지 않습니다.
배포 PR 제거 이후의 Argo 자동 배포 연결은 아직 없으며, 기존 `gitops` 전환 절차를 새 포크에 적용하지 않습니다.
[배포 PR 제거 기록](../infrastructure/gitops/docs/deployment-candidates.md)에 실제 적용 범위를 기록했습니다.

## 검증 범위

계정 두 개의 격리, tracked/untracked 변경, 비밀 파일 제외, 동일 입력의 무재빌드, 빌드 실패,
rollout 실패·복원, Argo 관리 충돌 거부는 자동 테스트로 검사합니다. 명령이 WSL2와 호환되도록 작성된 것과
실제 Windows에서 실행이 검증된 것은 다릅니다. 팀원 Windows에서 `doctor`·최초 실행·저장 반영을 별도로
확인해야 합니다. 로컬 이미지로 실행한 Kubernetes 검증이나 통합 전 `GovBiz-Team`의 비공개 배포
기록을 개인 포크의 비공개 발행·pull 성공 증거로 대신하지 않습니다.
[Windows 한 대의 소스 빌드·기동·웹 연결 확인 범위](windows-kubernetes-setup.md#실제-확인한-범위)를
기록했습니다. 다른 팀원 PC와 개발 감시·GitOps까지 검증한 것은 아닙니다.
[Intel Mac 개인 포크의 실제 검증 기록](fork-gitops-validation-20260921.md)은 따로 확인할 수 있습니다.
