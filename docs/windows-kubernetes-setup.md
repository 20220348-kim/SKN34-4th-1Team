# Windows에서 소스 빌드로 Kubernetes 수동 구성하기

GHCR에 앱 이미지가 없어도 이 저장소의 Dockerfile로 빌드해 실행할 수 있습니다.
이 문서는 **Windows x64 + WSL2 Ubuntu + Docker Desktop + kind**의 로컬 개발 환경을 만듭니다.
Compose는 실행하지 않으며, Argo CD 자동 배포는 별도 설정입니다.

구성은 `소스 → Docker 빌드 → kind 이미지 적재 → Helm 렌더링·Kubernetes 적용`입니다.
Core·Catalog·AI·Ops와 MySQL 3개·Elasticsearch·Qdrant·Redis는 Kubernetes에서,
웹은 Windows의 Vite 개발 서버에서 실행합니다. 실제 AI 호출·공고 수집·메일과 RabbitMQ는 기본적으로 비활성입니다.
이 경로는 앱 이미지용 GHCR 인증/PAT가 필요 없지만, 기반 이미지·패키지 다운로드에는 인터넷이 필요합니다.

## 1. Windows와 Docker Desktop 준비

Ubuntu가 없다면 **관리자 PowerShell**에서 설치하고, 안내가 나오면 Windows를 재시작합니다.

```powershell
wsl --install -d Ubuntu
wsl --list --verbose
```

Ubuntu의 VERSION이 `2`인지 확인합니다. 기존 Ubuntu가 VERSION 1이면 `wsl --set-version Ubuntu 2`로 전환합니다.
처음 Ubuntu를 열면 Linux 사용자 계정과 비밀번호를 생성합니다.

[Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)를 설치·실행하고
Linux 컨테이너 모드를 사용합니다. Docker Desktop에서:

1. 오른쪽 위 **Settings**를 엽니다.
2. **General → Use the WSL 2 based engine**을 켭니다.
3. **Resources → WSL Integration → Ubuntu**를 켭니다.
4. **Apply & Restart**를 누르고 Docker 준비가 끝날 때까지 기다립니다.

Docker Desktop의 **Kubernetes 스위치는 켜지 않습니다.** 아래에서 kind 클러스터를 별도로 만듭니다.
기존 Compose를 함께 실행하면 메모리·포트가 겹칠 수 있습니다. 필요 없는 기존 컨테이너는
`docker ps`로 확인해 정확한 이름으로 중지하되, 이미지나 데이터 볼륨 삭제는 설치의 필수 단계가 아닙니다.

이하 **5절까지는 Ubuntu 터미널**에서 실행합니다.

```bash
uname -m
docker version --format '{{.Server.Os}}/{{.Server.Arch}}'
```

각각 `x86_64`, `linux/amd64`가 나와야 합니다. WSL 안에서 Docker 명령을 찾지 못하면
별도 Docker Engine을 설치하기 전에 위 Ubuntu 연동부터 확인합니다.
공식 설명: [Docker Desktop WSL2 연동](https://docs.docker.com/desktop/features/wsl/).

## 2. WSL에 소스 준비

자기 GitHub 포크를 사용합니다. Windows의 `/mnt/c/...`보다 Linux의 `~/projects/...`에서
Kubernetes 도구를 실행하는 편이 파일 접근 지연을 줄입니다.

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
mkdir -p ~/projects
cd ~/projects
read -r -p "본인 GitHub 계정: " GOVBIZ_GITHUB_USER
git clone "https://github.com/$GOVBIZ_GITHUB_USER/SKN34-4th-1Team.git"
cd SKN34-4th-1Team
git remote add upstream https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team.git
git remote -v
```

이미 같은 경로에 작업 사본이 있으면 clone을 반복하지 않고 그 폴더로 이동합니다.
`origin`은 자기 포크, `upstream`은 교육기관 원본인지 확인합니다.
이후 Ubuntu 명령의 작업 위치는 이 **저장소 루트**입니다.

## 3. Kubernetes·Python 도구 설치

아래는 Linux amd64용이며, 프로젝트에 맞춘 kind 0.33.0·Helm 4.3.0·kubectl 1.36.4·uv 0.12.5를
사용합니다. 공식 배포 파일과 checksum을 받아 검증한 후 사용자 전용 폴더에 설치합니다.

```bash
# 이 블록은 서브셸이다. 실패하면 설치를 중단하고 오류부터 해결한다.
(
set -euo pipefail
GOVBIZ_TOOLS="$HOME/.local/share/govbiz-k8s"
mkdir -p "$GOVBIZ_TOOLS/bin" "$GOVBIZ_TOOLS/downloads"
cd "$GOVBIZ_TOOLS/downloads"

curl -fL --retry 3 -o kind https://kind.sigs.k8s.io/dl/v0.33.0/kind-linux-amd64
curl -fL --retry 3 -o kind.sha256 https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64.sha256sum
printf '%s  kind\n' "$(cut -d ' ' -f1 kind.sha256)" | sha256sum --check
install -m 755 kind "$GOVBIZ_TOOLS/bin/kind"

curl -fLO --retry 3 https://get.helm.sh/helm-v4.3.0-linux-amd64.tar.gz
curl -fLO --retry 3 https://get.helm.sh/helm-v4.3.0-linux-amd64.tar.gz.sha256sum
sha256sum --check helm-v4.3.0-linux-amd64.tar.gz.sha256sum
tar -xzf helm-v4.3.0-linux-amd64.tar.gz
install -m 755 linux-amd64/helm "$GOVBIZ_TOOLS/bin/helm"

curl -fL --retry 3 -o kubectl https://dl.k8s.io/release/v1.36.4/bin/linux/amd64/kubectl
curl -fL --retry 3 -o kubectl.sha256 https://dl.k8s.io/release/v1.36.4/bin/linux/amd64/kubectl.sha256
printf '%s  kubectl\n' "$(cat kubectl.sha256)" | sha256sum --check
install -m 755 kubectl "$GOVBIZ_TOOLS/bin/kubectl"

curl -fLO --retry 3 https://github.com/astral-sh/uv/releases/download/0.12.5/uv-x86_64-unknown-linux-gnu.tar.gz
curl -fLO --retry 3 https://github.com/astral-sh/uv/releases/download/0.12.5/uv-x86_64-unknown-linux-gnu.tar.gz.sha256
sha256sum --check uv-x86_64-unknown-linux-gnu.tar.gz.sha256
tar -xzf uv-x86_64-unknown-linux-gnu.tar.gz
install -m 755 uv-x86_64-unknown-linux-gnu/uv "$GOVBIZ_TOOLS/bin/uv"
)
```

설치가 성공하면 저장소 루트에서 Python 3.13 가상환경을 준비합니다.
시스템 Python을 바꾸거나 `sudo pip`를 사용하지 않습니다.

```bash
export PATH="$HOME/.local/share/govbiz-k8s/bin:$PATH"
uv venv --python 3.13 infrastructure/gitops/.tools/venv
uv pip install --python infrastructure/gitops/.tools/venv/bin/python -r infrastructure/gitops/scripts/requirements.txt
source infrastructure/gitops/.tools/venv/bin/activate

python --version
kind version
helm version --short
kubectl version --client
```

새 Ubuntu 터미널에서는 저장소로 이동한 다음 아래 두 줄로 PATH와 Python 환경을 다시 선택합니다.

```bash
export PATH="$HOME/.local/share/govbiz-k8s/bin:$PATH"
source infrastructure/gitops/.tools/venv/bin/activate
```

## 4. 소스에서 이미지 빌드

먼저 초기화와 설정 검사를 실행합니다. `init`은 로컬 상태를 만들며 아직 클러스터를 만들지는 않습니다.

```bash
python -B infrastructure/gitops/scripts/fork_cluster.py init
python -B infrastructure/gitops/scripts/fork_cluster.py doctor
python -B infrastructure/gitops/scripts/check_msa.py
```

모두 성공하면 고유한 태그와 저장소 밖의 새 출력 경로로 빌드합니다.

```bash
GOVBIZ_BUILD_DIR="$(mktemp -d -t govbiz-images.XXXXXX)"
GOVBIZ_IMAGE_TAG="msa-$(date -u +%Y%m%d-%H%M%S)"
python infrastructure/scripts/build-msa-images.py \
  --tag "$GOVBIZ_IMAGE_TAG" \
  --output "$GOVBIZ_BUILD_DIR/images.json"
```

이 공통 도구는 **서비스 4개 + Elasticsearch + 검증용 스텁 4개**를 순차 빌드합니다.
다음 `up` 단계는 이 중 서비스 4개와 Elasticsearch만 사용하며 스텁을 실행하지 않습니다.
첫 빌드는 JDK·Python·문서 인식 라이브러리 설치 때문에 수십 분 걸릴 수 있습니다.
별도의 호스트 JDK 설치는 필요하지 않습니다.

빌드가 성공하여 JSON이 생성됐을 때만 보관합니다.

```bash
cp "$GOVBIZ_BUILD_DIR/images.json" infrastructure/gitops/.local/fork/local-images.json
```

이미지 태그가 이미 있거나 출력 파일이 존재하면 빌드 도구는 덮어쓰지 않고 중단합니다.
다시 빌드할 때는 새 태그·새 임시 폴더를 사용합니다.
실행 중인 이미지, 기존 데이터 볼륨이나 클러스터를 삭제해서 재시도하지 않습니다.

## 5. Kubernetes 생성·배포·확인

```bash
python -B infrastructure/gitops/scripts/fork_cluster.py up \
  --local-images infrastructure/gitops/.local/fork/local-images.json
python -B infrastructure/gitops/scripts/fork_cluster.py status
```

`up`은 다음 작업을 수행합니다.

- 포크별 이름의 전용 kind 클러스터 생성과 소유권 확인
- 무작위 DB 암호·서비스 내부 토큰을 Kubernetes Secret으로 생성
- 로컬 이미지 적재, Helm 렌더링 결과 적용
- MySQL 3개·Redis·Qdrant·Elasticsearch 준비 확인 후 백엔드 4개 배포

클러스터 이름을 다른 사람의 값으로 복사하거나 기본 kubeconfig를 바꿀 필요가 없습니다.
전용 kubeconfig는 `infrastructure/gitops/.local/fork/kubeconfig`입니다.

```bash
kubectl --kubeconfig infrastructure/gitops/.local/fork/kubeconfig get nodes
kubectl --kubeconfig infrastructure/gitops/.local/fork/kubeconfig -n govbiz-msa get pods,pvc
```

노드는 `Ready`, 앱/저장소 Pod 10개는 `1/1 Running`, PVC 6개는 `Bound`인지 확인합니다.
첫 MySQL 초기화나 큰 이미지 적재 중에는 기다려야 합니다. 명령 실패는 완료로 간주하지 않습니다.
상태를 확인하고 원인을 해결한 후 같은 `up --local-images ...` 명령으로 재시도합니다.
기존 런타임 Secret과 DB를 보존하며, 이미 존재하는 다른 클러스터를 임의로 인수하지 않습니다.

기존 Compose 볼륨의 데이터는 자동 이전하지 않습니다. 새 DB는 공고·회원 데이터가 없는 상태로 시작합니다.
kind 클러스터를 삭제하면 그 안의 데이터도 잃을 수 있으므로 일시 중지는 7절을 따릅니다.

## 6. Windows 웹 연결

**Ubuntu 터미널 A**에서 저장소 루트·Python 환경을 선택한 뒤 실행하고 켜 둡니다.

```bash
python -B infrastructure/gitops/scripts/fork_cluster.py web
```

`Forwarding from 127.0.0.1:18080 -> 8080`이 나와야 합니다.

**Windows PowerShell 터미널 B**에서는 [Node.js](https://nodejs.org/en/download)의
프로젝트 지정 버전인 **24.x**를 설치하고 새 터미널을 엽니다.
프로젝트의 `package.json`에 맞춰 pnpm을 설치합니다.

```powershell
node --version
npm.cmd install --global pnpm@11.22.0
pnpm.cmd --version
```

Windows에도 같은 포크의 작업 폴더가 필요합니다. 기존 폴더가 있으면 그 경로로 이동하고 clone은 생략합니다.
새 폴더를 만드는 경우:

```powershell
$forkOwner = Read-Host '본인 GitHub 계정'
$webWorkspace = Join-Path $env:USERPROFILE 'SKN34-4th-1Team'
git clone "https://github.com/$forkOwner/SKN34-4th-1Team.git" $webWorkspace
Set-Location $webWorkspace
```

저장소 루트에서 의존성을 설치하고 웹을 실행합니다.

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd --dir frontend/web dev:k8s
```

[http://localhost:5173](http://localhost:5173)에 접속합니다.
별도 PowerShell에서 연결을 확인할 수 있습니다.

```powershell
(Invoke-WebRequest -UseBasicParsing http://localhost:5173/).StatusCode
(Invoke-WebRequest -UseBasicParsing http://localhost:5173/api/v1/health).StatusCode
```

두 응답 모두 `200`이면 웹과 Kubernetes Core의 연결을 확인한 것입니다.
유료 AI·메일·실제 공고 수집 기능의 성공까지 뜻하지는 않습니다.
필요한 개인 키·기능 활성화는 [외부 연동 안내](../infrastructure/gitops/docs/local-integrations.md)를 따릅니다.

Windows 웹 사본과 WSL 백엔드 사본은 독립된 폴더이므로 같은 소스 버전을 사용합니다.
Windows에서 고친 백엔드 파일이 WSL에 자동 복사되지는 않습니다.
백엔드 개발 감시는 **실제로 소스를 수정하는 WSL 작업 사본**에서
[개발 모드 안내](local-fork-development.md#3-저장한-백엔드-코드-반영)에 따라 실행합니다.

## 7. 중지·재시작

웹과 port-forward 터미널에서 각각 `Ctrl+C`를 누르면 웹 접속만 종료되고 Kubernetes는 계속 실행됩니다.
클러스터까지 잠시 중지하려면 **Ubuntu 저장소 루트·Python 환경**에서 정확한 이름을 읽어 중지합니다.

```bash
GOVBIZ_CLUSTER="$(python -c 'import json; print(json.load(open("infrastructure/gitops/.local/fork/settings.json"))["cluster"])')"
docker stop "$GOVBIZ_CLUSTER-control-plane"
```

다시 사용할 때는 Docker Desktop을 실행한 다음 같은 저장소·Python 환경에서:

```bash
GOVBIZ_CLUSTER="$(python -c 'import json; print(json.load(open("infrastructure/gitops/.local/fork/settings.json"))["cluster"])')"
docker start "$GOVBIZ_CLUSTER-control-plane"
python -B infrastructure/gitops/scripts/fork_cluster.py status
```

Pod가 준비되면 6절의 port-forward와 웹 명령을 다시 실행합니다.
초기화된 환경에서는 매번 이미지를 재빌드하거나 `up`을 다시 실행할 필요가 없습니다.
`kind delete cluster`, `docker volume prune`, `docker compose down -v`는 재시작 명령이 아닙니다.

## 자주 막히는 지점

| 증상 | 확인할 내용 |
|---|---|
| WSL에서 Docker를 찾지 못함 | Docker Desktop의 Ubuntu WSL Integration, Linux 컨테이너 모드 |
| `kind/helm/kubectl`을 찾지 못함 | 3절의 PATH 설정을 새 터미널에도 적용 |
| Python 버전·PyYAML 오류 | 3절의 가상환경 활성화 확인 |
| `/mnt/c`에서 파일 검사·Helm 렌더링 지연 | WSL Linux 파일 시스템의 작업 사본에서 실행 |
| `up`이 GHCR PAT를 요구함 | 로컬 빌드 경로에서 `--local-images` 인자를 빠뜨리지 않았는지 확인 |
| 이미지 태그/ID 불일치 | 해당 JSON을 생성한 빌드 이미지가 남아 있는지 확인. JSON을 임의 편집하지 않음 |
| 웹은 열리는데 API 연결 실패 | Ubuntu port-forward 터미널, Core Pod Ready, `localhost:18080` 연결 확인 |
| PowerShell에서 `pnpm.ps1` 실행 정책 오류 | 위 명령처럼 `pnpm.cmd` 사용 |
| 5173/18080 포트가 이미 사용 중 | 기존 웹/port-forward 프로세스를 확인하고 중복 실행하지 않음 |
| Pod가 준비되지 않음 | 해당 Pod의 `describe` Events와 `logs` 확인. 데이터 삭제로 해결하지 않음 |
| CPU·메모리·디스크 부족 | 기존 스택 중복 실행, `docker stats`, WSL `free -h`, Windows 드라이브 여유 확인 |

Kubernetes 관리 프로세스와 독립 DB가 함께 실행되므로 단순 Compose보다 자원이 더 필요합니다.
이미지·빌드 캐시의 디스크 용량과 실행 중인 컨테이너의 RAM 사용량은 다릅니다.

## 실제 확인한 범위

2026-09-21 Windows x64·WSL2 Ubuntu 26.04·Docker Desktop 환경에서 다음을 확인했습니다.

- GHCR에서 받았던 앱 이미지를 삭제하고 Windows 작업 소스에서 서비스 4개·Elasticsearch를 로컬 빌드
- WSL Linux 사본에서 kind 0.33.0, Kubernetes 1.36.4, Helm 4.3.0, Python 3.13으로 초기화·배포
- 백엔드 4개와 저장소 6개의 Pod Ready, PVC 6개 Bound
- 네 백엔드의 내부 상태 확인 API HTTP 200과 Windows 웹 → Core HTTP 200
- 기존 Docker 데이터 볼륨 보존, 앱 소스·의존성·운영 설정 변경 없음

위 수동 안내는 공통 빌드 도구를 사용하도록 정리했습니다. 그 도구가 추가로 만드는 검증 스텁 4개,
새 PC에서 이 문서 전체를 처음부터 복사 실행하는 과정, 개발 감시·재부팅 복구·Windows GitOps,
실제 OpenAI·공고 수집·메일·전체 업무 기능·CI 전체 테스트까지 이번 확인에 포함한 것은 아닙니다.
