# 개인 포크의 로컬 Kubernetes · GitOps

교육기관 저장소는 공통 코드를 관리합니다. 각 팀원은 개인 포크의 Actions로 자기 **비공개 GHCR**에 이미지를
발행하고, 자기 PC의 kind 클러스터에서 실행합니다. `ilil1` 같은 특정 계정을 코드에 쓰지 않습니다.
이 문서는 공통 실행 계약이며 Windows 팀원의 실제 배포 성공 기록은 아닙니다.

## 최초 한 번 필요한 개인 설정

1. 교육기관 저장소를 개인 계정으로 포크하고 그 포크를 클론합니다. `origin`이 본인의 GitHub 저장소인지 확인합니다.
2. 포크에서 GitHub Actions를 활성화하고 [이미지 발행 안내](image-promotion.md)의 `MSA_RELEASE_ENABLED=true`,
   `MSA_PROMOTION_ENABLED=true`를 설정합니다. 이 동의는 포크마다 필요하며 원본의 비밀값·설정은 복제되지 않습니다.
3. 교육기관 upstream에 PR이 병합된 코드를 **GitHub의 본인 포크 기본 브랜치로 동기화**합니다. 승인된 upstream 소스와
   네 CI 통과를 확인한 뒤 `MSA image candidates`가 발행하고 `Fork image promotion`이 승격합니다.
   이후 로컬에서 `git pull`합니다. 개인 작업 브랜치 push나 로컬 pull만으로 이미지를 발행하지 않습니다.
   `environments/fork/release.json`과 네 서비스 values는 실제 검증된 발행 후에만 생성됩니다.
4. 자신의 GitHub PAT(classic)를 `read:packages` **만** 선택해 발급합니다. 클러스터가 이미지를 읽는 전용 인증이며
   CI 발행은 별도의 `GITHUB_TOKEN`을 씁니다. `repo`, `write:packages`, `delete:packages`를 추가하지 않습니다.
5. Intel Mac 또는 Windows x64의 WSL2 Ubuntu에서 Docker Desktop Linux, Python 3.13,
   kind 0.33.0, Helm 4.3.0, kubectl 1.36 계열을 준비합니다. Docker 엔진은 `linux/amd64`여야 합니다.
   네이티브 Windows Python과 ARM 에뮬레이션은 자동 지원하지 않습니다.

Windows에서는 WSL 안의 파일 시스템(예: `~/projects`)에 클론하고 WSL 터미널에서 실행합니다.
Docker Desktop의 해당 WSL 배포판 통합을 켭니다. Python·Node·Git도 WSL 쪽 도구를 사용합니다.
여러 MSA DB와 JVM을 함께 띄우므로 기존 Compose와 동시에 띄우지 말고 Docker 메모리를 확인합니다.
스크립트가 다른 컨테이너를 임의로 중지하지는 않습니다.

```bash
cd infrastructure/gitops
python3.13 -m venv .tools/venv
.tools/venv/bin/python -m pip install -r scripts/requirements.txt
source .tools/venv/bin/activate
python -B scripts/fork_cluster.py init
python -B scripts/fork_cluster.py doctor
python -B scripts/fork_cluster.py up
```

`up`의 토큰 입력은 화면에 표시되지 않습니다. 파일 입력을 원하면 본인만 소유한 일반 파일을 `chmod 600`으로
준비하고 `--token-file /안전한/경로/token`을 사용합니다. 원문을 명령 인수·채팅·Git에 넣지 않습니다.
파일은 도구가 복사하지 않으므로 적용 뒤 원본 보관/삭제는 본인이 관리합니다. 도구는 사용자·scope와 네 image
digest의 실제 GHCR pull 권한을 확인한 뒤 Kubernetes Secret에 stdin으로 전달합니다. 토큰을 Vercel에 넣지 않습니다.

## 자기 PC에서 코드 수정

기본 `up`은 **개발 모드**입니다. 검증된 본인 GHCR digest에서 시작하되 Argo Application은 만들지 않습니다.

```bash
python -B scripts/dev.py --watch
```

저장된 서비스 소스 변경을 감지하면 해당 서비스만 로컬 이미지로 빌드하고 자기 kind에 적재해 재시작합니다.
이 작업은 Git 커밋·push·GHCR 발행을 하지 않으며 다른 팀원에게 영향을 주지 않습니다. 컨테이너 재빌드 시간이
필요하므로 모든 백엔드가 브라우저 HMR처럼 즉시 바뀌는 것은 아닙니다. 자세한 서비스 선택·복구·웹 연결은
[로컬 개발 안내](../../../docs/local-fork-development.md)를 따릅니다.

다른 터미널에서 `python -B scripts/fork_cluster.py web`을 실행하면 Core를 `127.0.0.1:18080`으로 연결합니다.
웹은 저장소의 Node 24·pnpm 버전을 맞춘 뒤 `frontend/web`에서 `pnpm dev:k8s`로 실행합니다. 외부 IP로 공개하지 않습니다.

## Argo CD 자동 배포 모드

개발 모드와 GitOps 모드는 같은 리소스를 동시에 쓰지 않습니다. 개발 watcher를 먼저 종료하고 로컬 이미지
변경을 원래 이미지로 복구합니다. 배포할 코드는 upstream PR 병합과 본인 포크 기본 브랜치 동기화, CI 발행·승격을
마친 뒤 pull합니다. 작업 중인 개인 코드를 커밋하는 것만으로 발행 정책을 통과하지 않습니다.

```bash
python -B scripts/dev.py --restore
git pull
python -B scripts/fork_cluster.py gitops
python -B scripts/fork_cluster.py status
```

`gitops`는 저장소가 clean이고 HEAD가 해당 포크의 설정 브랜치 원격과 일치하는지 확인합니다. 준비된
비공개 pull Secret과 포크 release가 있어야 하며, 남아 있는 개발 lock/이미지 변경 기록이 있으면 멈춥니다.
고정 checksum의 Argo CD Core를 설치한 뒤 다음 값으로 네 Application을 생성합니다.

- Git: 로컬 `origin`의 본인 포크, 초기화 시 선택한 브랜치(기본은 origin 기본 브랜치).
- Chart: `infrastructure/gitops/charts/govbiz-service`.
- Values: `../../environments/fork/<서비스>.yaml`.
- 대상: 전용 kind 클러스터의 `govbiz-msa` namespace.
- 권한: 네 서비스 Deployment·Service만 관리. Secret·DB·cluster 권한은 주지 않음.
- 동기화: 자동 sync·self-heal 켬, 자동 prune 끔.

`gitops` 명령 성공은 Application 등록 성공입니다. `status`에서 네 서비스 모두 `Synced / Healthy`인지 확인해야
배포 완료라고 할 수 있습니다. Mac/Windows 또는 Docker가 꺼져 있으면 로컬 Argo도 동작하지 않습니다.

다시 소스 저장 반영 개발을 하려면 다음과 같이 전환합니다.

```bash
python -B scripts/fork_cluster.py dev
python -B scripts/dev.py --watch
```

`dev`는 자동 동기화를 끄고 진행 중인 sync가 없는지 확인한 뒤 Application을 orphan 방식으로 제거합니다.
sync 진행 중이면 완료를 기다리고 명령을 다시 실행합니다. Deployment·Service·데이터는 남기고 Argo 소유권 표식만
제거합니다. 예상 밖 Application이나 삭제 finalizer가 있으면 임의 처리하지 않습니다.

## 상태·인증·데이터 경계

- `init`은 `.local/fork/settings.json`만 만들며 클러스터·GitHub·토큰에 접근하지 않습니다.
- `doctor`는 도구와 Docker 플랫폼을 확인합니다. 이 결과만으로 Windows 실제 실행·GHCR 인증 성공을 주장하지 않습니다.
- 클러스터 이름은 포크 식별자의 hash에서 생성합니다. 모든 명령은 전용 kubeconfig/context와 loopback API,
  정확한 node 이름, `kube-system/govbiz-owner`의 포크·로컬 state ID를 확인합니다.
- 기존 `govbiz-portfolio`나 다른 계정의 클러스터를 인수하지 않습니다. `origin` 변경, 일부만 남은 runtime Secret,
  stale kubeconfig는 자동 덮어쓰기 없이 멈춥니다.
- `up/gitops/dev/credentials`와 개발 watcher는 같은 `dev.lock`을 작업 전체 동안 독점합니다. 서로 작업을 동시에
  시작하지 못하며 정상 종료·오류·Ctrl+C 때 자기 잠금만 해제합니다. 남은 PID 잠금을 임의로 빼앗거나 자동 삭제하지 않습니다.
- `credentials`는 같은 절차로 새 읽기 토큰을 검증·교체합니다. 만료된 토큰이 있는 Secret을 재사용한 경우
  Pod `ImagePullBackOff`를 보고 이 명령으로 갱신할 수 있습니다.
- 비밀번호·JWT·내부 인증 토큰은 전용 cluster에서 임의 생성합니다. 기존 Compose `.env`를 읽거나 복사하지 않습니다.
- 기본은 유료 LLM·외부 수집·메일·큐 발송을 끕니다. 기능을 켜는 작업은 별도 API 키/비용 승인이 필요합니다.
- 로컬 데이터는 이 kind 안의 볼륨입니다. 컨테이너를 잠시 멈추는 것과 클러스터를 삭제하는 것은 다릅니다.
  이 도구는 삭제 명령을 제공하지 않으며 백업/고가용성까지 구성한 운영 환경은 아닙니다.

## 과거/검증 전용 경로

`portfolio_cluster.py`는 기존 개인 Mac용 이력 검토·테스트를 위해 잠긴 상태로 남깁니다. 신규 실행에는 사용하지 않습니다.
`environments/portfolio`의 이전 `GovBiz-Team` 이미지 digest는 개인 포크의 배포 증거가 아닙니다.
`fork_cluster.py up --local-images <빌드 manifest>`는 GHCR 없이 로컬 이미지를 넣는 **명시적 검증 모드**입니다.
그 성공을 비공개 GHCR pull·실제 Argo Git 동기화 성공으로 표현하지 않습니다.

공식 참고: [GHCR 인증](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
[Kubernetes private image pull](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/),
[Argo CD 자동 동기화](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/).
