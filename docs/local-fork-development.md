# 개인 포크의 Kubernetes에서 개발하기

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
GHCR 기반 `up`·`gitops` 명령은 비공개 초기 준비와 검증된 발행이 완료된 뒤에만 사용합니다.

## 두 실행 모드

| 모드 | 반영하는 코드 | 이미지 경로 | 서비스 변경 주체 |
|---|---|---|---|
| `dev` | 자기 PC에 저장한 코드, 아직 커밋하지 않은 새 소스도 포함 | 로컬 Docker 빌드 → 자기 kind에 적재 | `dev.py` |
| `gitops` | 교육기관 원본에 병합된 뒤 자기 포크의 기본 브랜치에 동기화하고 CI 검증·발행을 통과한 코드 | 개인 GHCR(기본 비공개, 공개 선택 가능) → 자기 Kubernetes가 pull | Argo CD |

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
기본 브랜치를 읽습니다. 현재 작업 중인 `skn34-1` 같은 개발 브랜치를 배포 브랜치로 삼지 않습니다.
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

이 선행 조건을 충족하고 발행·승격을 명시적으로 허용한 뒤에는, 개발 코드를 교육기관 원본에 PR로
병합하고 그 결과를 자기 포크의 기본 브랜치에 동기화합니다. 동일 소스의 네 CI·발행·승격이 모두
통과해야 자기 GHCR 이미지와 `environments/fork`의 검증된 digest가 준비됩니다.
미병합 개인 커밋의 push나 포크 생성만으로 이미지가 발행·복사되는 것은 아닙니다.

준비된 비공개 이미지를 PC에서 받을 때는 자기 계정의 classic PAT에 `read:packages`만 선택합니다.
이 읽기 토큰은 패키지 생성·업로드 인증이 아닙니다. 토큰을 채팅·`.env`·Git 파일에 적지 않습니다.
**검증된 이미지가 준비된 후** 아래 명령은 대화형 숨김 입력을 사용하며,
클러스터의 이미지 pull Secret에만 전달합니다.
공개 전환을 완료하고 `release.json`에 `visibility: public`이 기록된 경우에는 같은 명령으로
익명 다운로드를 검사하며 PAT를 묻지 않습니다. 이때 `--token-file`은 전달하지 않습니다.
기존 읽기 Secret이나 GitHub PAT는 자동 삭제·폐기하지 않습니다.

```bash
python -B infrastructure/gitops/scripts/fork_cluster.py up
python -B infrastructure/gitops/scripts/fork_cluster.py status
```

최초 `up`은 자기 이미지의 pull 권한을 확인하고, 독립된 kind 클러스터·데이터 저장소·서비스를
준비합니다. 기존 `govbiz-portfolio`나 임의 클러스터를 재사용하거나 데이터를 옮기지 않습니다.
DB·서비스 비밀값은 새 로컬 환경에 생성하며 유료 AI·메일·외부 공고 수집은 기본적으로 꺼 둡니다.

첫 실행에서 큰 AI 이미지의 다운로드·압축 해제가 길어지면 `progress deadline` 오류가 먼저 날 수 있습니다.
이는 성공으로 처리하지 않습니다. `status`와 해당 Pod의 Events에서 `Pulling`, `Pulled`, Ready 상태를
확인하세요. 인증 오류·이미지 없음·기동 오류는 먼저 해결해야 하며, 단순 첫 다운로드 대기인 경우에는
다운로드가 계속 진행됩니다. Pod가 Ready가 된 뒤 같은 `up`을 다시 실행하면 기존 Secret·DB·이미지
캐시를 보존하며 초기화 결과를 기록합니다. 클러스터나 볼륨을 삭제해서 다시 시작할 필요는 없습니다.

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

처음에는 선택한 서비스의 **현재 작업 파일**로 이미지를 빌드합니다. 그다음부터 기본 2초 간격으로
파일 내용의 변화를 확인하고, 변경된 서비스만 순서대로 다시 빌드합니다. 빌드 중 여러 번 저장한 내용은
다음 검사에서 최신 상태로 모아 반영합니다. Java 컴파일·의존성 설치에는 수 분이 걸릴 수 있으므로
즉시 hot reload가 아니라 **자동 이미지 재빌드·배포**입니다.

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

웹의 Vite 개발 서버는 `localhost:5173`에서 실행되고 API는 `127.0.0.1:18080`을 거쳐 Kubernetes Core로
전달됩니다. 프런트 파일 저장 반영은 Vite가 담당하며, 위 백엔드 이미지 감시 명령과 별개입니다.
port-forward 터미널을 종료하면 웹의 API 연결도 끊깁니다.

## 5. GitOps 모드로 돌아가기

감시 터미널을 `Ctrl+C`로 종료한 후 로컬 개발 이미지부터 명시적으로 복원합니다.

```bash
python -B infrastructure/gitops/scripts/dev.py --restore --service all
```

이 명령은 개발 도구가 처음 발견했던 기존 이미지로 복원할 뿐, 수정한 소스 파일을 되돌리거나 Git을
커밋하지 않습니다. 제출할 코드를 직접 커밋·푸시하고 교육기관 원본에 PR을 올립니다. 원본에 병합되면
자기 포크의 기본 브랜치를 원본과 동기화합니다. 비공개 패키지 준비와 발행 활성화 조건을 충족하여
포크 CI 발행·digest 갱신이 성공한 경우에만 그 결과를 로컬에 pull한 뒤 실행합니다.

```bash
python -B infrastructure/gitops/scripts/fork_cluster.py gitops
python -B infrastructure/gitops/scripts/fork_cluster.py status
```

GitOps 활성화는 자기 포크의 배포 브랜치에 푸시된 깨끗한 작업 트리와 유효한 개인 GHCR 인증을 요구합니다.
Argo CD는 자기 포크의 Helm·digest만 읽고 자기 PC에 적용합니다. GitOps 모드가 활성화된 후의 자동
감지는 로컬 `git pull` 없이도 동작하지만, 수동 도구·개발 코드의 최신화에는 pull이 필요합니다.
Mac/Windows와 Docker가 실행 중이어야 하며 토큰이 만료되면 `credentials` 명령으로 갱신합니다.
교육기관 원본에 병합되었다는 이유로
모든 팀원의 개인 클러스터가 동시에 바뀌는 구조는 아닙니다. 각자 원본 변경을 **GitHub의 자기 포크 기본
브랜치에** 동기화해야 합니다. 로컬에서 `git pull`만 하는 것은 GitHub 원격을 바꾸지 않으므로 새로운
발행 워크플로를 시작하지 않습니다. 로컬 코드 저장 반영은 이 승인·발행 절차 없이 개발 모드에서 계속 가능합니다.

## 검증 범위

계정 두 개의 격리, tracked/untracked 변경, 비밀 파일 제외, 동일 입력의 무재빌드, 빌드 실패,
rollout 실패·복원, Argo 관리 충돌 거부는 자동 테스트로 검사합니다. 명령이 WSL2와 호환되도록 작성된 것과
실제 Windows에서 실행이 검증된 것은 다릅니다. 팀원 Windows에서 `doctor`·최초 실행·저장 반영을 별도로
확인해야 합니다. 로컬 이미지로 실행한 Kubernetes 검증이나 통합 전 `GovBiz-Team`의 비공개 배포
기록을 개인 포크의 비공개 발행·pull 성공 증거로 대신하지 않습니다.
[Windows 한 대의 소스 빌드·기동·웹 연결 확인 범위](windows-kubernetes-setup.md#실제-확인한-범위)를
기록했습니다. 다른 팀원 PC와 개발 감시·GitOps까지 검증한 것은 아닙니다.
[Intel Mac 개인 포크의 실제 검증 기록](fork-gitops-validation-20260921.md)은 따로 확인할 수 있습니다.
