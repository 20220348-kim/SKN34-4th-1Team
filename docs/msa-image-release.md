# 개인 포크의 이미지 발행 — 기본 비공개

코드와 GitOps 배포 설정은 하나의 저장소에서 관리하지만 교육기관의 GHCR은 사용하지 않습니다.
이제 발행 코드는 특정 개인이나 `GovBiz-Team`에 고정되지 않습니다. GitHub가 제공하는 현재
저장소와 기본 브랜치를 읽고, 각 개인 포크에서 명시적으로 활성화한 경우에만 작동합니다.
단, 발행 대상은 **이미 존재하며 본인 소유·정확한 포크 연결이 확인된 패키지**로 제한합니다.
`MSA_PACKAGE_VISIBILITY`의 기본값은 `private`입니다. 공개를 명시적으로 선택하는 경우의 준비·전환 순서는
[공개 GHCR 전환 안내](public-ghcr-transition.md)를 따릅니다. 변수는 기대 공개 범위를 검사할 뿐,
패키지를 생성하거나 GitHub의 공개 범위를 바꾸지 않습니다.

[비공개 패키지 최초 준비](private-ghcr-setup.md)는 일회용 최소 권한 PAT로 **앱 코드 없는 빈 패키지**를
만들고, Private·소유자·포크 연결과 Actions Write 권한을 확인하는 절차입니다.
준비 전에는 `MSA_RELEASE_ENABLED=false`, `MSA_PROMOTION_ENABLED=false`를 유지하고,
준비·검증한 자기 포크에서만 두 변수를 `true`로 바꿉니다. 다른 팀원의 설정은 자동으로 복사되지 않습니다.

### 새 패키지를 자동 생성하지 않는 이유

GitHub는 워크플로가 `GITHUB_TOKEN`으로 만든 패키지가 기본적으로 실행 저장소의 공개 범위와
권한 모델을 상속한다고 설명합니다. 공개 포크에서 처음 push한 이미지가 반드시 비공개라는 보장은
없으며, 업로드 후 검사만으로 최초 공개 노출을 방지할 수 없습니다.
[GitHub의 워크플로 패키지 기본 공개 범위 설명](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions#default-permissions-and-access-settings-for-packages-modified-through-workflows)

따라서 발행기는 패키지가 없거나 접근 여부를 확인할 수 없으면 업로드 전에 중단합니다.
비공개 초기 생성은 CI가 아닌 로컬의 별도 도구가 담당합니다. 빈 이미지로 최초 생성한 뒤 권한을
확인하며, 일단 앱 코드를 공개로 올린 뒤 전환하는 절차는 사용하지 않습니다.

## 팀원 최초 설정

1. 교육기관 원본을 **본인 계정으로 포크**하고 Actions를 활성화합니다.
2. 포크의 Settings → Secrets and variables → Actions → Variables에서 두 변수를 **`false`로 유지**합니다.
   - `MSA_RELEASE_ENABLED=false`: 비공개 초기 준비 전 이미지 발행 중지
   - `MSA_PROMOTION_ENABLED=false`: 검증된 발행 전 digest 승격 중지
3. [네 서비스 패키지 최초 준비](private-ghcr-setup.md)를 수행합니다.
   각 패키지의 Private 상태, 본인 소유, 정확한 자기 포크 연결, 해당 포크 Actions의 쓰기 권한을
   확인해야 합니다. `read:packages` 토큰은 기존 이미지를 받기 위한 것이며 패키지를 만들 수 없습니다.
4. 위 준비를 별도로 완료·검증하고 발행을 명시적으로 허용할 때에만 두 변수를 `true`로 변경합니다.
   단순히 CI가 성공했다는 이유로 활성화하지 않습니다.
5. 기능은 개인 작업 브랜치에서 개발하고 교육기관 원본에 PR을 제출합니다. **원본 PR이 병합된 뒤**
   본인 포크의 기본 브랜치를 최신 upstream과 동기화합니다. 로컬 `git pull`만으로는 원격 Actions가 실행되지 않습니다.
   GitHub의 Sync fork 또는 동기화한 로컬 기본 브랜치를 origin에 push해야 합니다.
   포크 생성만으로 기존 커밋의 CI가 재실행되지는 않습니다.
6. `GovBiz CI`, `Catalog separation CI`, `GovBiz Ops CI`, `Infra CI`가 **동일 SHA**에서 모두 성공하면
   `MSA image candidates`가 실행됩니다. 단, 개인 포크의 내용이 최신 upstream 병합본과 일치해야 합니다.
   원본에 아직 병합되지 않은 코드·CI·발행 정책 변경은 본인 포크에서 테스트가 성공해도 발행하지 않습니다.
   필요하면 같은 검증된 SHA의 기본 브랜치에서 해당 workflow를 수동 실행합니다.
7. `Fork image promotion`이 완료되면 `infrastructure/gitops/environments/fork/`에 실제 digest와
   `release.json`이 생깁니다. 첫 발행 전에는 예시 digest로 이 폴더를 만들지 않습니다.

### 새 포크가 이미 최신인데 CI 실행 기록이 없는 경우

포크 생성과 `Sync fork: up to date`는 새로운 push 이벤트를 만들지 않을 수 있습니다. 이 경우
기본 브랜치를 최신 upstream과 동기화하고 Actions를 허용한 뒤 **최초 한 번만 빈 커밋**을
push해 네 push CI를 시작할 수 있습니다. 비공개 패키지 초기 준비가 끝나지 않았다면 두 발행 변수는
계속 `false`로 둡니다. 빈 커밋은 CI 기록을 만들 뿐 패키지를 준비하거나 발행 잠금을 해제하지 않습니다.
파일 변경이 없는 빈 커밋은 upstream 내용과 같으므로 소스 검증에서 허용하지만,
미병합 코드가 섞인 커밋은 계속 차단합니다.

아래는 기본 브랜치가 `main`인 경우의 Mac·Windows/WSL2 명령입니다. `origin`이 **본인 포크**인지
먼저 `git remote -v`로 확인하세요. 다른 브랜치에서 실행하거나 추적·미추적 변경이 있으면
첫 두 검사가 중단하므로 커밋하지 않습니다. 다른 기본 브랜치를 쓰면 두 `main`을 해당 이름으로 맞춥니다.

```bash
test "$(git branch --show-current)" = "main" &&
test -z "$(git status --porcelain)" &&
git commit --allow-empty -m "설정: 개인 포크 CI 최초 실행" &&
git push origin main
```

이는 파일이나 권한을 바꾸는 커밋이 아닙니다. 이미 같은 소스 SHA의 네 CI 실행 기록이 있다면
반복할 필요가 없습니다. 이미지 workflow만 수동 실행하는 것으로 누락된 push CI 검증을 대체할 수 없습니다.

기존 비공개 패키지에 새 버전을 발행할 때는 Actions의 단기 `GITHUB_TOKEN`을 사용합니다.
이 반복 발행 경로에는 별도 `write:packages` PAT나 다른 저장소에 쓰기 가능한 토큰을 등록하지 않습니다.
최초 빈 패키지 등록용 `write:packages` PAT는 초기 준비 후 폐기하며 CI에 저장하지 않습니다.
조직 정책·브랜치 보호가 쓰기를 막으면 정책을 존중하여
실패하며, 자동으로 권한을 넓히거나 강제 push하지 않습니다. 교육기관 소유 저장소는 변수를 켜도 차단합니다.

## 각자 달라지는 값

`alice/Project`와 `bob/Project`가 같은 코드를 쓰더라도 다음처럼 서로 다른 이미지를 사용합니다.

| 개인 포크 | AI 서비스 이미지 경로 |
| --- | --- |
| `alice/Project` | `ghcr.io/alice/project-ai-service` |
| `bob/Project` | `ghcr.io/bob/project-ai-service` |

나머지도 `core-service`, `catalog-service`, `ops-service` 접미사를 사용합니다. 대문자는 소문자로 바꿉니다.
플랫폼은 현재 `linux/amd64`입니다. Intel Mac과 Windows x64/WSL2 대상이며 ARM 지원으로 표현하지 않습니다.
패키지는 **선택한 공개 범위와 일치**해야 합니다. `private`가 기본이며 `public`은 명시적으로 선택해야 합니다.
기존 패키지의 소유자·연결 저장소·선택한 공개 범위를 빌드 전에
확인하고, 새 태그를 업로드할 때는 push 직전과 직후에도 재검사합니다. 패키지가 없거나 접근할 수 없으면
새로 만들지 않고 중단합니다. 검사 실패 시 배포 후보 receipt를 발급하지 않습니다.

## 발행과 로컬 개발의 차이

비공개 패키지 준비·검증과 발행 활성화가 완료된 뒤에는
원본 PR 병합 → 개인 포크 기본 브랜치 Sync → 네 CI 성공 → 서비스별 추적 소스 빌드/기존 이미지 재사용 → 기존 개인 GHCR 패키지 →
receipt 검증 → 같은 포크의 digest 커밋 → 각 PC의 Argo CD가 Git 변경 감지 순서입니다.

**PC에서 코드를 저장할 때마다 GHCR에 올리는 방식이 아닙니다.** 저장 즉시 반영하는 개발 모드와
검증된 이미지를 실행하는 GitOps 모드는 별개입니다. 로컬 개발 방법은 [공통 개발 안내](local-fork-development.md)를 확인합니다.
비공개 이미지의 상시 pull 인증은 개인의 `read:packages` 토큰을 로컬 Kubernetes Secret `ghcr-pull`로 전달합니다.
공개 이미지의 검증된 v2 receipt는 `visibility: public`을 기록하고, 승격 시 `imagePullSecrets: []`를 생성합니다.
로컬 도구는 이 배포 기록에 따라 PAT 없이 네 digest의 익명 pull을 검사합니다. 서비스의 DB·내부 인증 Secret은 유지합니다.
단기 `GITHUB_TOKEN`을 클러스터에 복사하거나 실제 토큰·`.env`를 Git에 커밋하지 않습니다.

## 검증·재실행 경계

- PR, 다른 저장소/브랜치, 최신 실패·대기 중 CI는 발행 자격이 없습니다. privileged workflow는 기본 브랜치 정책을 실행합니다.
- 최신 upstream 기본 브랜치가 후보의 조상이어야 하고 다섯 개인 이미지 선택 파일 외에는 모든 추적 파일이 같아야 합니다.
  이 기준은 bot digest와 upstream 동기화로 생긴 개인 merge SHA는 허용하지만 미병합 변경·동기화되지 않은 upstream은 차단합니다.
  upstream API 오류나 불완전한 비교 결과를 성공으로 취급하지 않습니다.
- 서비스 tree·발행 도구 tree·플랫폼으로 입력 키를 계산합니다. 같은 키라도 이미지 source label과 플랫폼을 재검사합니다.
- `git archive`로 추적 소스만 빌드합니다. 미추적 비밀값·캐시는 제외하지만 이미 커밋한 비밀값을 정화하는 기능은 아닙니다.
- 인증·네트워크 오류를 이미지 없음으로 취급하지 않습니다. 부분 실패 시 일부 이미지는 남을 수 있지만 자동 배포하지 않습니다.
- 패키지 404도 자동 생성 허용이 아닙니다. 비공개 패키지가 미리 준비됐음을 확인하지 못하면 해당 서비스의 업로드 전에 중단합니다.
- receipt ZIP checksum·정확한 네 artifact·같은 저장소/실행/SHA·실제 Git tree를 모두 검사합니다. receipt 자체가 서명된 provenance는 아닙니다.
- 새 receipt는 schemaVersion 2와 `visibility`를 필수로 포함하며, 네 서비스의 공개 범위가 다르면 승격하지 않습니다.
  기존 v1 receipt 및 공개 범위가 없는 과거 배포 기록은 비공개로만 해석합니다.
- 배포 파일은 `environments/fork`의 네 YAML과 `release.json`만 갱신합니다. 과거 `environments/portfolio`는 수정하지 않습니다.
- bot의 digest-only 후속 커밋은 검증된 소스 SHA를 무효화하지 않습니다. 다른 소스 변경이 섞이면 차단합니다.
- `GITHUB_TOKEN`의 digest push는 새 push workflow를 만들지 않아 발행 반복을 막습니다. Argo CD의 Git 감지는 별개입니다.
- 다른 사람의 `environments/fork`가 포크에 포함되어도 그 이미지를 실행하지 않습니다. 본인의 첫 CI·발행이 성공하면
  검증된 본인 이미지 네 개로 다섯 파일을 한 커밋에 교체합니다. 계정명 수동 변경이나 파일 삭제는 필요 없습니다.

오프라인 검사(Python 3.13, GitOps requirements 필요):

```bash
python3 -B -m unittest discover -s infrastructure/release -p 'test_*.py'
python3 -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_*.py'
```

단위 테스트 통과와 실제 GHCR push/pull·클러스터 배포 성공은 다릅니다. 최초 준비 도구는
Private·소유자·포크 연결까지만 검사하므로 Actions Write·실제 발행·실제 pull·Argo 상태를 각각 확인합니다.
기존 `GovBiz-Team` 이미지와 이전 Mac 배포 기록은 새 포크의 배포 성공 증거가 아닙니다.
[이번 개인 포크의 실제 발행·pull·Argo 검증 기록](fork-gitops-validation-20260921.md)을 별도로 남깁니다.

공식 근거: [GHCR 인증](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
[GITHUB_TOKEN으로 생성한 패키지의 기본 공개 범위](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions#default-permissions-and-access-settings-for-packages-modified-through-workflows),
[GITHUB_TOKEN push의 재실행 방지](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
