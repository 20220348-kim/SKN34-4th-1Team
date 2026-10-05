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
준비·검증한 자기 포크에서 `MSA_RELEASE_ENABLED`만 `true`로 바꿉니다. `MSA_PROMOTION_ENABLED`는 `false`로 유지합니다. 다른 팀원의 설정은 자동으로 복사되지 않습니다.

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
   - `MSA_PROMOTION_ENABLED=false`: 제거한 배포 PR 자동화 비활성 유지
3. [네 서비스 패키지 최초 준비](private-ghcr-setup.md)를 수행합니다.
   각 패키지의 Private 상태, 본인 소유, 정확한 자기 포크 연결, 해당 포크 Actions의 쓰기 권한을
   확인해야 합니다. `read:packages` 토큰은 기존 이미지를 받기 위한 것이며 패키지를 만들 수 없습니다.
4. 패키지 준비를 검증한 뒤 이미지 발행만 `MSA_RELEASE_ENABLED=true`로 허용합니다.
   `MSA_PROMOTION_ENABLED=false`를 유지합니다. [별도 배포 PR은 제거했습니다](../infrastructure/gitops/docs/deployment-candidates.md).
5. 기능은 개인 작업 브랜치에서 개발하고 교육기관 원본에 PR을 제출합니다. **원본 PR이 병합된 뒤**
   본인 포크의 기본 브랜치를 최신 upstream과 동기화합니다. 로컬 `git pull`만으로는 원격 Actions가 실행되지 않습니다.
   GitHub의 Sync fork 또는 동기화한 로컬 기본 브랜치를 origin에 push해야 합니다.
   포크 생성만으로 기존 커밋의 CI가 재실행되지는 않습니다.
6. `GovBiz CI`, `Catalog separation CI`, `GovBiz Ops CI`, `Infra CI`, `LLMOps CI`와 각 필수 job이 **동일 SHA**에서 모두 성공하면
   `MSA image candidates`가 실행됩니다. 단, 개인 포크의 내용이 최신 upstream 병합본과 일치해야 합니다.
   원본에 아직 병합되지 않은 코드·CI·발행 정책 변경은 본인 포크에서 테스트가 성공해도 발행하지 않습니다.
   필요하면 같은 검증된 SHA의 기본 브랜치에서 해당 workflow를 수동 실행합니다.
7. 이미지 발행 결과와 네 receipt를 확인합니다. 별도 배포 PR 생성이나 Argo 자동 배포는 수행하지 않습니다.

### 새 포크가 이미 최신인데 CI 실행 기록이 없는 경우

포크 생성과 `Sync fork: up to date`는 새로운 push 이벤트를 만들지 않을 수 있습니다. 이 경우
기본 브랜치를 최신 upstream과 동기화하고 Actions를 허용한 뒤 **최초 한 번만 빈 커밋**을
push해 다섯 push CI를 시작할 수 있습니다. 비공개 패키지 초기 준비가 끝나지 않았다면 두 발행 변수는
계속 `false`로 둡니다. 빈 커밋은 CI 기록을 만들 뿐 패키지를 준비하거나 발행 잠금을 해제하지 않습니다.
파일 변경이 없는 빈 커밋은 upstream 내용과 같으므로 소스 검증에서 허용하지만,
미병합 코드가 섞인 커밋은 계속 차단합니다.

아래는 기본 브랜치가 `main`인 경우의 Mac·Windows/WSL2 명령입니다. `origin`이 **본인 포크**인지
먼저 `git remote -v`로 확인하세요. 다른 브랜치에서 실행하거나 추적·미추적 변경이 있으면
첫 두 검사가 중단하므로 커밋하지 않습니다. PR 필수 보호를 이미 적용한 저장소는 직접 push 대신 같은 내용을 PR로 제출합니다. 다른 기본 브랜치를 쓰면 두 `main`을 해당 이름으로 맞춥니다.

```bash
test "$(git branch --show-current)" = "main" &&
test -z "$(git status --porcelain)" &&
git commit --allow-empty -m "설정: 개인 포크 CI 최초 실행" &&
git push origin main
```

이는 파일이나 권한을 바꾸는 커밋이 아닙니다. 이미 같은 소스 SHA의 다섯 CI 실행 기록이 있다면
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

### 패키지 검사에서 발행이 중단된 경우

`MSA image candidates`의 `package-preflight` job은 전체 CI 성공을 기다리지 않고 `gate`와 병렬로
네 서비스 패키지를 읽기 전용으로 조회합니다. 기존의 개인 포크·발행 활성화 조건을 지키고, 항상
기본 브랜치의 코드를 사용합니다. job 권한은 `contents: read`, `packages: read`이며 Docker 로그인·
빌드·push·클러스터 변경은 수행하지 않습니다. 한 패키지의 정책/API 검사가 실패해도 나머지 패키지를
조회하고, 하나라도 검증되지 않으면 job을 실패 처리합니다.

해당 job의 Summary와 `msa-package-preflight` artifact에서 `packages.<서비스>`를 확인합니다.
`packagePolicyVerified: true`는 네 패키지의 메타데이터가 맞는다는 뜻이며, Actions 쓰기 권한·소스 CI·
이미지 발행·배포 성공을 입증하지 않습니다. 사전 점검 보고서는 이미지 receipt로 사용하지 않습니다.
보고서 CLI는 `publish.py --check-packages --report <경로>`이며 Actions가 필요한 인증 환경을 주입합니다.
이 모드는 `--service`, `--sha`, `--output` 발행 인자를 함께 받을 수 없습니다.

실제 `publish` job은 `package-preflight` 성공과 `gate`의 동일 SHA 필수 CI 검증을 모두 요구합니다.
발행기 내부의 패키지 재검사도 유지합니다. 전체 결과의 `packagePreflightResult`와
`reason: package_preflight_failure` 등으로 사전 점검 실패를 구분합니다. 이 job이 없던 과거 실행은
`packagePreflightResult: not_recorded`로 표시합니다.
워크플로 수동 실행에서도 사전 점검을 수행하며, **기존 발행 조건까지 모두 충족하면 실제 발행도 진행**합니다.

서비스별 `msa-publication-<서비스>` artifact와 해당 job의 Summary에서 `packageCheck`를 확인합니다.
API 응답 원문이나 토큰을 출력하지 않고, 마지막으로 시도한 패키지 검사의 원인과 항목별 상태를 기록합니다.
`expectedVisibility`는 발행 정책이며, `actualVisibility`는 API가 `private`·`public`·`internal` 중 하나를
반환했을 때만 기록합니다. 패키지 공개 범위나 권한을 자동으로 바꾸지 않습니다.

| 기록 | 의미와 다음 확인 |
| --- | --- |
| `checks.repository: missing` | 연결 저장소를 확인하지 못함. 패키지의 Connect repository와 정확한 개인 포크 연결 확인 |
| `checks.repository: mismatch` | 다른 저장소 연결. 현재 포크와의 연결을 확인한 뒤 재검증 |
| `checks.owner: missing/mismatch` | 패키지 소유자를 확인하지 못했거나 개인 포크 소유자와 다름 |
| `checks.visibility: missing/mismatch` | 공개 범위를 확인하지 못했거나 설정한 기대 범위와 다름. 의도한 정책을 먼저 확인 |
| 항목의 `invalid` 또는 `reason: invalid_response` | 응답 형식 오류. 정상 패키지로 간주하지 않고 중단 |
| `reason: authentication_failed` / HTTP 401 | 사용 중인 인증 확인 |
| `reason: access_denied` / HTTP 403 | 사용 중인 토큰의 패키지 접근 권한 확인. 403만으로 누락된 특정 권한을 단정하지 않음 |
| `reason: missing_or_inaccessible` / HTTP 404 | 패키지 없음과 접근 불가를 구분할 수 없음. 자동 생성하지 않고 최초 준비·접근 설정 확인 |
| `reason: rate_limited`, `http_error`, `network_error` | API 제한·HTTP 오류·연결 오류. 패키지 정책 불일치와 구분해 확인 |

한 번에 여러 항목이 실패하면 모두 기록하며, 통과한 항목은 `matched`입니다. 발행 시작·업로드 직전·직후와
기존 이미지 재사용 시 같은 검사를 수행합니다. 업로드 후 검사 실패는 `upload: confirmed`와
`receiptWritten: false`를 함께 기록하므로 업로드 사실을 없던 것으로 표시하지 않습니다.
`packageCheck.state: verified`는 패키지 메타데이터 검증만 뜻합니다. 이미지 발행은 receipt와 서비스별
결과를, 배포는 실제 클러스터 상태를 별도로 확인합니다.

Actions의 `GITHUB_TOKEN`과 로컬 `gh` 인증은 별개입니다. 로컬에서 `read:packages` 부족 오류가 나도
Actions 토큰의 같은 권한 부족을 입증하지는 않습니다. 비공개 패키지는
[최초 준비 안내](private-ghcr-setup.md)의 저장소 연결과 Actions Write 설정을 확인합니다.
검사 실패를 없애기 위해 `MSA_PACKAGE_VISIBILITY=public`으로 바꾸지 않습니다. 공개 발행이 필요한 경우에만
[명시적인 공개 전환 절차](public-ghcr-transition.md)를 따릅니다.

## 발행과 로컬 개발의 차이

비공개 패키지 준비·검증과 발행 활성화가 완료된 뒤에는
원본 PR 병합 → 개인 포크 기본 브랜치 Sync → 다섯 CI 성공 → 서비스별 추적 소스 빌드/기존 이미지 재사용 → 기존 개인 GHCR 패키지 →
이미지 digest·출처 receipt 확인 순서입니다. 이후 Argo 자동 배포 연결은 별도 구현 대상입니다.

**PC에서 코드를 저장할 때마다 GHCR에 올리는 방식이 아닙니다.** 저장 즉시 반영하는 개발 모드와
검증된 이미지를 실행하는 GitOps 모드는 별개입니다. 로컬 개발 방법은 [공통 개발 안내](local-fork-development.md)를 확인합니다.
비공개 이미지의 상시 pull 인증은 개인의 `read:packages` 토큰을 로컬 Kubernetes Secret `ghcr-pull`로 전달합니다.
공개 이미지의 검증된 v2 receipt는 `visibility: public`을 기록하고, 승격 시 `imagePullSecrets: []`를 생성합니다.
로컬 도구는 이 배포 기록에 따라 PAT 없이 네 digest의 익명 pull을 검사합니다. 서비스의 DB·내부 인증 Secret은 유지합니다.
단기 `GITHUB_TOKEN`을 클러스터에 복사하거나 실제 토큰·`.env`를 Git에 커밋하지 않습니다.

## 검증·재실행 경계

- PR, 다른 저장소/브랜치, 최신 실패·대기 중 CI는 발행 자격이 없습니다. privileged workflow는 기본 브랜치 정책을 실행합니다.
- 다섯 CI의 최신 실행·재실행에서 필수 job 전부가 실제 성공해야 합니다. workflow 성공만으로 job 누락·건너뜀·실패를 허용하지 않습니다.
  job 목록이 불완전하거나 다른 SHA·실행의 결과이면 차단하며, job 조회 중 재실행이 시작되어도 이전 성공을 사용하지 않습니다.
  필수 job의 이름·matrix 구성을 바꾸면 `infrastructure/release/gate.py`의 정책도 함께 갱신해야 합니다.
- 발행 시작·업로드 전과 승격 파일 쓰기·커밋 직전에 같은 CI 조건을 다시 확인합니다. 원격 브랜치 보호/Ruleset 설정과는 별개입니다.
- 다섯 필수 CI는 모든 push와 PR에서 실행합니다. 필수 상태 검사가 경로 필터 때문에 누락되지 않도록 Catalog·LLMOps의 PR 필터도 제거했습니다.
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
- 과거 전체 배포 snapshot의 오프라인 검증은 보존합니다. 현재는 배포 후보 PR을 생성하지 않습니다.
- 다른 사람의 `environments/fork`가 포크에 포함되어도 그 이미지를 실행하지 않습니다. 본인의 첫 CI·발행이 성공하면
  검증된 본인 이미지 네 개의 receipt를 발급합니다. 타인의 digest를 실행하거나 계정명만 바꾸어 배포하지 않습니다.

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
