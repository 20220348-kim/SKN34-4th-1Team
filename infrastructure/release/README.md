# MSA 이미지 발행

교육기관 원본에 병합된 소스를 **이미 준비된 개인 포크의 GHCR 패키지**에 발행합니다. 기본값은 비공개이며 교육기관 GHCR은 사용하지
않으며, `ilil1` 등 개인 계정명을 코드에서 수정할 필요가 없습니다. CI는 실행 저장소 정보,
로컬 도구는 Git `origin`을 사용합니다. 기존 EC2/SSM 배포나 GovBiz-Team 저장소는 변경하지 않습니다.

[최초 준비 도구와 설정 안내](../../docs/private-ghcr-setup.md)를 제공합니다. 일회용 쓰기 PAT로 빈
비공개 패키지만 만들고, 권한 검증 후에 자동 발행을 켭니다. 준비 전에는 두 발행 변수를 `false`로
유지합니다. Actions 변수와 읽기 토큰만으로 최초 준비가 완성되지는 않습니다.
공개를 선택할 때는 [공개 GHCR 전환 안내](../../docs/public-ghcr-transition.md)를 따릅니다.
`MSA_PACKAGE_VISIBILITY=public`은 공개 패키지 발행을 허용하는 명시적 설정이며,
GitHub의 공개 범위를 자동으로 변경하거나 원본 병합·CI 검증을 우회하지 않습니다.

## 각 포크의 선행 조건

1. 자기 포크의 **Actions** 탭에서 워크플로 실행을 허용합니다.
2. 자기 포크의 **Settings → Secrets and variables → Actions → Variables**에서 다음 두
   repository variable을 각각 `false`로 유지합니다. Secret이나 PAT를 넣는 칸이 아닙니다.
   - `MSA_RELEASE_ENABLED=false`: 비공개 패키지 준비 전 이미지 발행 중지
   - `MSA_PROMOTION_ENABLED=false`: 제거한 배포 PR 자동화 비활성 유지
3. 네 서비스 패키지가 **Private·본인 소유·정확한 자기 포크 연결** 상태로 먼저 존재해야 합니다.
   `bootstrap_packages.py create`로 앱 코드 없는 초기화 패키지를 만들고, GitHub UI에서 포크를
   연결하되 권한 상속은 끈 채 정확한 포크의 Actions에만 Write를 부여합니다. `verify`로 다시 검사합니다.
   준비가 확인되지 않으면 다음 발행 활성화 단계로 넘어가지 않습니다.
4. 준비된 패키지에 해당 포크 Actions가 새 버전을 쓸 권한까지 확인한 후, 사용자가 명시적으로
   발행을 허용할 때에만 `MSA_RELEASE_ENABLED=true`로 변경합니다. `MSA_PROMOTION_ENABLED=false`는 유지합니다.
   `Settings → Environments → msa-release`에 별도 승인자를 지정했다면 릴리스마다 그 승인이
   필요합니다. 워크플로가 요청하는 `packages: write`를 조직·저장소 정책이 거부하면 관리자에게 문의합니다.
5. PC에서 준비된 이미지를 받을 때는 본인 계정의 **classic PAT, `read:packages`만** 준비합니다.
   [숨김 입력·클러스터 초기화](../../docs/local-fork-development.md)를 따르며 토큰을 Git·채팅에 넣지 않습니다.

발행기는 기존 패키지의 소유자·연결 저장소·기대 공개 범위를 빌드 전, 새 태그 업로드 직전·직후에 확인합니다.
패키지가 없거나 접근할 수 없는 경우에도 자동 생성하지 않고 업로드 전에 중단합니다.
기대 공개 범위와 다르거나 다른 저장소에 연결된 패키지는 거부하며, 공개 범위를 자동 변경하지 않습니다.

## Kubernetes 웹 이미지

별도 발행기를 복제하지 않고 `MSA image candidates` (`msa-images.yml`)의 수동 실행에서
`component=web`을 선택합니다. 자동 CI 완료 trigger와 기본 `component=services`는 기존 네
백엔드를 유지합니다. 웹 패키지 준비가 기존 백엔드 발행의 새 선행 조건이 되지는 않습니다.

- 최초 준비: 아래 공용 `Kubernetes package setup`에서 `component=web`과 정확한
  `ghcr.io/<개인 계정>/<저장소 소문자>-web`을 확인합니다. PAT 없이 Actions 임시 토큰을 사용합니다.
- 공개 설정: 패키지 Public·본인 포크 연결·Actions Write를 확인한 뒤 발행합니다.
  준비 도구나 발행기가 공개 범위·권한을 자동 변경하지 않습니다.
- 발행: 기본 브랜치에서 `component=web`으로 실행합니다. 기존 동일 SHA 필수 CI·원본 병합
  검증·`msa-release` environment·업로드 직전/직후 확인을 그대로 사용합니다.
- 입력: 루트 package/lock/workspace 파일, 웹·shared 소스, mobile의 package.json,
  타입 검사에 필요한 합성 온라인 입력 가이드 JSON만 선택한 SHA에서 archive합니다.
  로컬 수정 파일·비밀값·node_modules는 발행 입력이 아닙니다.
- 모드: 현재 필수 이미지 CI가 검사하는 `portfolio`만 발행합니다. `connected` 이미지 발행은
  해당 모드의 이미지 CI를 연결한 뒤 지원합니다.
- 결과: `msa-image-web` artifact의 `web.json`에 공개 범위, digest, 소스 입력·발행기 Git 식별자,
  `webMode=portfolio`를 v4 receipt로 기록합니다. 실행기의 v3·백엔드 v2와 구분합니다.

`sync_images.py`는 웹 발행을 백엔드 네 개 배포 기록으로 사용하지 않습니다. 웹 digest를
수동 Argo 배포에 연결하는 단계는 [웹 전환 안내](../gitops/docs/web-kubernetes.md)를 따릅니다.
코드 구현만으로 원격 패키지·이미지 발행이나 클러스터 전환이 끝난 것은 아닙니다.

## Kubernetes 평가 실행기 이미지

`Evaluation runner image candidate` (`evaluation-images.yml`)는 `evaluation-runner`만 별도로 발행합니다.
기존 `MSA image candidates`의 네 서비스 matrix·v2 receipt는 유지합니다. 실행기 패키지가 아직 준비되지
않았거나 발행이 실패해도 기존 네 서비스 발행 워크플로의 의존성은 바뀌지 않습니다.

발행 대상은 `ghcr.io/<개인 계정>/<저장소 이름 소문자>-evaluation-runner`입니다. 기존과 같이
개인 포크·`MSA_RELEASE_ENABLED=true`·원본 병합·기본 브랜치의 동일 SHA 필수 CI 성공이 필요합니다.
LLMOps CI의 격리 Kubernetes 평가 실행 검증도 포함하며, 실행 중·실패·취소·건너뛰기는 통과로
취급하지 않습니다. 작업 브랜치 push, 수동 workflow 실행, 패키지 점검 성공으로 이 조건을 우회할 수 없습니다.

패키지는 먼저 준비해야 합니다. 공개 실행기는 **PAT 없이** `Kubernetes package setup`
(`evaluation-package-setup.yml`)을 기본 브랜치에서 수동 실행해 빈 패키지 한 개를 준비할 수 있습니다.
자동 trigger는 없으며 `confirm_package`에 정확한 `ghcr.io/<계정>/<저장소 소문자>-evaluation-runner`를
입력해야 합니다. 개인 포크·공개 정책·발행 활성화·동일 소스의 필수 CI 검증 후에만 단기
`GITHUB_TOKEN`으로 동작하고, 기존 `msa-release` environment 정책을 그대로 적용합니다.

`component`의 기본값은 `evaluation-runner`입니다. 같은 도구에서 `web`을 선택하면 빈 웹
패키지 한 개만 준비합니다. 기존 workflow 파일명·artifact 이름은 호환성을 위해 유지하며,
결과의 `service`·`package`로 실제 대상을 구분합니다. 웹 선택 시 MSA 발행기와, 실행기 선택 시
평가 발행기와 concurrency 그룹을 공유합니다.

앱 코드 없는 `FROM scratch` Dockerfile만 stdin으로 빌드하며 소스 저장소 연결 label을 포함합니다.
checkout·앱 코드·비밀 파일은 build context로 전달하지 않습니다. 기존 패키지는 소유자·연결 저장소를
조회할 뿐 덮어쓰지 않습니다. 기본 브랜치와 CI를 업로드 직전·후에 다시 확인하며, 기존 자동
발행기와 concurrency 그룹을 공유합니다. GitHub 공개 범위는 자동 변경하지 않고 실제 조회값으로
`AWAITING_PUBLIC_CONFIGURATION` 또는 `PUBLIC_METADATA_VERIFIED`를 보고합니다.

`evaluation-package-setup` artifact는 초기화 사실만 기록합니다. 실제 앱 이미지·v3 receipt·배포는
생성하지 않습니다. 패키지 화면의 Public·연결 포크·Actions 접근을 확인한 후 기존
`Evaluation runner image candidate`를 실행합니다. 상세 순서는
[PAT 없는 최초 준비](../../docs/public-ghcr-transition.md#pat-없이-평가-실행기-패키지-최초-준비)를 따릅니다.

로컬 도구를 명시적으로 선택할 수도 있습니다. `bootstrap_packages.py create --service evaluation-runner`는
숨김 입력한 일회용 PAT로 빈 비공개 패키지만 만듭니다. 옵션을 생략하면 기존 네 서비스가 대상입니다.
공개 전환 뒤 로컬 메타데이터 검사는 `bootstrap_packages.py verify --service evaluation-runner
--visibility public`으로 실행합니다. 이 옵션은 조회 전용이며 패키지를 공개로 바꾸지 않습니다.
`create --visibility public`은 거절하고 기존 비공개 생성·검증의 기본 동작을 유지합니다.
발행기는 새 패키지를 자동 생성하거나 GitHub 공개 범위·권한·변수를 변경하지 않습니다.

빌드는 다음 추적 입력만 선택한 SHA의 `git archive`로 추출해 저장소 루트 형식의 context를 만듭니다.

- `infrastructure/llmops/Dockerfile.runner`
- AI 서비스의 `pyproject.toml`, `uv.lock`, `app/`
- `evaluation/support-program-evidence/`
- Ops의 catalog·recovery·실행 명세·품질 정책·RAG replay 파일

실제 목록은 `publish.py`의 `RUNNER_PATHS`이며 Dockerfile의 모든 `COPY` 입력과 일치하는지 테스트합니다.
전체 checkout, 로컬 변경·미추적 파일·`.env`·`work/`는 전달하지 않습니다. 입력별 Git object ID와
발행 정책 tree·플랫폼이 이미지 재사용 키를 결정합니다. Dockerfile 빌드 단계에서 기존
`execution_spec.py` 검증과 네트워크 없는 임베딩 준비 검사를 수행하고, stale 실행 명세는 빌드 실패로 처리합니다.

실행기 receipt는 `schemaVersion=3`이며 `sourceInputs`, `publisherTree`, `executionReleaseSha256`을
기록합니다. 실행 명세의 Git blob SHA-256은 이미지 label에도 넣고 재사용 시 digest로 조회해 대조합니다.
빌드 전·업로드 직전·후에 패키지 정책을 검사하고, CI나 소스가 바뀌면 업로드 또는 receipt 생성을 차단합니다.

| 별도 workflow artifact | 의미 |
| --- | --- |
| `evaluation-package-preflight` | 실행기 한 패키지의 소유권·연결 저장소·공개 범위 진단 |
| `evaluation-image-evaluation-runner` | 동일 SHA 검증을 거친 실행기 v3 receipt |
| `evaluation-publication-evaluation-runner` | 실행기 업로드·재사용·receipt 생성 여부 |
| `evaluation-publication-result` | gate·패키지 점검·실행기 발행의 종합 결과 |

이 workflow의 `imagesVerified`는 실행기 한 이미지에 대한 결과입니다. 기존 네 서비스의 결과와 합쳐서
해석하지 않습니다. 새 artifact는 기존 네 receipt를 읽는 배포 도구에 섞지 않습니다.
발행 이후에는 [평가 GitOps 계획 도구](../gitops/docs/evaluation-kubernetes.md#공개-발행-검증과-수동-argo-계획)가
v3 receipt와 같은 SHA의 기존 네 이미지 발행 기록을 함께 검증하고, 평가 전용 AppProject와 세 개의
수동 Application을 생성합니다. 모든 replica는 0이며 운영 PVC 인계·실제 평가 환경 이전은 후속
작업입니다. 코드·오프라인 테스트 완료는 원격 발행 성공을 뜻하지 않습니다.

공개 포크에서 `GITHUB_TOKEN`으로 새 패키지를 생성하면 저장소의 공개 범위를 상속할 수 있으므로
"새 패키지는 항상 비공개"라고 가정하지 않습니다.
[GitHub 공식 설명](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions#default-permissions-and-access-settings-for-packages-modified-through-workflows)

PC의 읽기 인증과 CI의 임시 `GITHUB_TOKEN`은 별개입니다. **기존 비공개 패키지의 반복 발행**에는
별도 발행용 PAT나 다른 저장소 쓰기 토큰을 등록하지 않습니다. 최초 빈 패키지를 만드는 일회용
`write:packages` PAT는 초기 준비 후 폐기합니다. `read:packages` 토큰으로는 패키지를 생성할 수 없습니다.

## 발행되는 시점

병합 보호는 [리뷰 0명·필수 CI 규칙](../../docs/merge-protection.md)을 따른다.
발행 가드와 병합 규칙은 `ci_policy.py`의 기존 16개 작업·종합 판정 5개를 공유한다.
원격 ruleset 적용과 우회 권한 확인은 코드 변경이나 발행 성공으로 대신하지 않는다.

**작업 브랜치에 push하는 것만으로는 발행하지 않습니다.**
아래 경로는 비공개 패키지 준비·검증과 `MSA_RELEASE_ENABLED=true` 설정 뒤에만 실행됩니다.

1. 교육기관 원본 `SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team`에 PR을 올리고 병합합니다.
2. 자기 포크의 원격 기본 브랜치에 배포할 원본 병합 커밋을 동기화하고, 해당 후보의 검증·발행·배포가 끝날 때까지 유지합니다.
3. 같은 소스의 앱·Catalog·Ops·Infra·LLMOps CI와 각 필수 job이 모두 통과하면 이미지 발행이 진행됩니다.
4. 발행 결과와 네 이미지 receipt를 확인합니다. 별도 배포 PR이나 배포 브랜치는 만들지 않습니다.
   Argo 자동 배포로 이어지는 대체 경로는 이번 제거 작업에 포함하지 않았습니다.
   [배포 PR 제거 기록](../gitops/docs/deployment-candidates.md)을 확인하세요.

`git pull`은 내 PC만 바꿉니다. GitHub의 **Sync fork**로 원격 포크를 먼저 동기화하거나,
로컬에서 원본 변경을 반영한 뒤 자기 포크에도 push해야 CI가 시작됩니다. 충돌이 있으면 기존 작업을
보존하고 해결하며, 자동 reset·force-push하지 않습니다. 후보 SHA가 원본 기본 브랜치의 현재
커밋이거나 그 이력에 실제 포함된 조상 커밋이면 팀의 후속 병합 때문에 자격을 잃지 않습니다.
개인 포크 기본 브랜치가 새 소스로 바뀌면 이전 후보는 계속 차단하고 새 SHA의 CI를 요구합니다.
본인이 작성한 미병합 코드는 후보가 될 수 없습니다. 포크 전용 빈 커밋·개인 digest 변경은 기존처럼
최신 원본의 후손이면서 다섯 이미지 선택 파일 외에 내용 차이가 없어야 합니다. 이 예외의
후보가 원본과 갈라진 경우에는 원본 병합 커밋을 다시 선택해야 합니다.

예를 들어 개인 `main`을 원본 병합 커밋 A에 유지한 동안 팀 `main`에 B가 추가되더라도,
A의 원본 포함 관계와 동일 SHA의 필수 CI·receipt 검증을 계속 수행합니다. 팀의 병합을 멈출
필요는 없지만, 개인 `main`을 B로 동기화하면 B의 검증이 새로 필요합니다. 오래된 임의 SHA를
별도 입력하거나 실패한 CI를 과거 성공으로 대체하는 기능은 추가하지 않습니다.

포크를 만든 것만으로 기존 커밋의 push CI가 생기지는 않습니다. 이 기능을 포함한 코드가 먼저
원본에 병합되고 포크에 동기화돼야 하며, 필요한 다섯 CI 실행이 없는 경우 발행을 건너뜁니다.
수동 `MSA image candidates` 실행도 이 검증을 우회하지 않습니다.
최신 실행·재실행의 필수 job이 누락되거나 건너뛰어진 경우 workflow가 성공이어도 차단합니다.
발행·승격 직전에도 같은 조건을 다시 검사하며, LLMOps CI는 문서 변경·빈 커밋을 포함한 모든 push에서 실행됩니다.
새 포크가 이미 원본 최신 상태라 동기화할 변경도 없다면, [최초 CI 실행 안내](../../docs/msa-image-release.md)에
따라 깨끗한 기본 브랜치에서 내용 변경 없는 초기 실행 커밋을 한 번 만들 수 있습니다.
이 경우에도 원본과 소스가 같아야 하며, 미병합 코드를 발행하는 예외는 아닙니다.

로컬 개발 감시 도구는 이 발행 경로와 별개로 **저장한 서비스만 PC에서 재빌드**합니다.
세부 검증·권한·실패 시 동작은 [이미지 릴리스 안내](../../docs/msa-image-release.md)를 참고하세요.

## 발행·승격 결과 확인

`MSA image candidates`는 선행 job의 성공·실패·건너뛰기에도
읽기 전용 `outcome` job을 실행한다. Actions Summary와 JSON artifact의
`schema=msa-release-outcome-v1` 기록을 확인한다. workflow의 초록색 표시만으로 발행·배포를 판단하지 않는다.

| artifact | 확인할 사실 |
|---|---|
| `msa-publication-result` | gate·발행 matrix 결과, `sourceSha`, `triggerSha`, 차단 사유, `imagesVerified` |
| `msa-publication-<service>` | 서비스별 새 업로드·재사용·receipt 생성 여부. 발행 도구가 실행된 경우 생성 |
| 과거 `msa-promotion-result` | 제거한 배포 PR 자동화의 이전 기록. 새로 생성하지 않음 |

- `imagesVerified=true`는 gate와 네 서비스 발행 job이 모두 성공했다는 뜻이다. 새 업로드 횟수는
  이 집계에서 추정하지 않고 서비스별 기록을 본다.
- 서비스별 `state=published`는 새 업로드와 검증 receipt 생성 완료, `state=reused`는 이미 검증된
  이미지 재사용이다. `upload=confirmed`여도 후속 검증이 실패하면 `receiptWritten=false`이며 승격 근거가 없다.
  `upload=attempted`는 push 응답을 확정하지 못한 상태다. 보고서 누락도 업로드 0회 증거가 아니다.
- `sourceSha`는 gate/후보 선택에서 확인한 소스다. 그 단계에 도달하지 못하면 null이며,
  이벤트의 `triggerSha`로 대신 승인하지 않는다. run ID와 attempt를 함께 기록한다.
- `reason`은 `disabled`, `event_not_eligible`, `source_not_current`, `upstream_not_merged`,
  `ci_run_missing:<workflow>`, `ci_jobs_not_successful_or_incomplete:<workflow>` 등으로 차단 위치를 구분한다.
- 과거 `candidateCreated`·`pushed` 보고서는 당시 계약으로만 해석한다. 해당 자동화는 제거했다.
  과거 후보 PR이나 push 기록은 현재 클러스터의 상태를 증명하지 않는다.
- 보고서는 배포 승인 자료가 아니다. 네 `msa-image-<service>` receipt의 출처·checksum·소스 검증은
  그대로 필수다. 승격기는 정해진 보고서 이름만 receipt 목록에서 제외하며, 미지의 artifact는 거절한다.
- `clusterVerified=false`는 이 도구가 실제 클러스터를 검증하지 않았다는 뜻이다. Argo CD 동기화와
  서비스 준비 완료는 별도 증거로 확인한다. 원격 보호 규칙과 실제 클러스터 전환은 별도 활성화 절차다.

결과 job의 `always()` 동작은 [GitHub job 의존성 규칙](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs)을 따른다.
runner 시작 전 실패나 강제 종료 등으로 보고서가 없으면 검증 대기로 남기며 성공으로 추정하지 않는다.
