# MSA 이미지 발행

교육기관 원본에 병합된 소스를 **이미 준비된 개인 포크의 비공개 GHCR 패키지**에 발행합니다. 교육기관 GHCR은 사용하지
않으며, `ilil1` 등 개인 계정명을 코드에서 수정할 필요가 없습니다. CI는 실행 저장소 정보,
로컬 도구는 Git `origin`을 사용합니다. 기존 EC2/SSM 배포나 GovBiz-Team 저장소는 변경하지 않습니다.

현재 새 비공개 패키지 초기 생성은 제공·검증되지 않았습니다. 준비 완료 전에는
`MSA_RELEASE_ENABLED=false`, `MSA_PROMOTION_ENABLED=false`를 유지합니다.
Actions 변수와 읽기 토큰만으로 새 포크의 비공개 발행이 완성되는 상태가 아닙니다.

## 각 포크의 선행 조건

1. 자기 포크의 **Actions** 탭에서 워크플로 실행을 허용합니다.
2. 자기 포크의 **Settings → Secrets and variables → Actions → Variables**에서 다음 두
   repository variable을 각각 `false`로 유지합니다. Secret이나 PAT를 넣는 칸이 아닙니다.
   - `MSA_RELEASE_ENABLED=false`: 비공개 패키지 준비 전 이미지 발행 중지
   - `MSA_PROMOTION_ENABLED=false`: 검증된 발행 전 digest 승격 중지
3. 네 서비스 패키지가 **Private·본인 소유·정확한 자기 포크 연결** 상태로 먼저 존재해야 합니다.
   초기 생성에는 별도 준비·검증이 필요하며, 현재 저장소는 그 생성 절차를 제공하지 않습니다.
   준비가 확인되지 않으면 다음 발행 활성화 단계로 넘어가지 않습니다.
4. 준비된 패키지에 해당 포크 Actions가 새 버전을 쓸 권한까지 확인한 후, 사용자가 명시적으로
   발행을 허용할 때에만 두 변수를 `true`로 변경합니다.
   `Settings → Environments → msa-release`에 별도 승인자를 지정했다면 릴리스마다 그 승인이
   필요합니다. 워크플로가 요청하는 `packages: write`를 조직·저장소 정책이 거부하면 관리자에게 문의합니다.
5. PC에서 준비된 이미지를 받을 때는 본인 계정의 **classic PAT, `read:packages`만** 준비합니다.
   [숨김 입력·클러스터 초기화](../../docs/local-fork-development.md)를 따르며 토큰을 Git·채팅에 넣지 않습니다.

발행기는 기존 패키지의 소유자·연결 저장소·비공개 상태를 빌드 전, 새 태그 업로드 직전·직후에 확인합니다.
패키지가 없거나 접근할 수 없는 경우에도 자동 생성하지 않고 업로드 전에 중단합니다.
공개 패키지나 다른 저장소에 연결된 패키지를 자동 변경하지 않습니다.

공개 포크에서 `GITHUB_TOKEN`으로 새 패키지를 생성하면 저장소의 공개 범위를 상속할 수 있으므로
"새 패키지는 항상 비공개"라고 가정하지 않습니다.
[GitHub 공식 설명](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions#default-permissions-and-access-settings-for-packages-modified-through-workflows)

PC의 읽기 인증과 CI의 임시 `GITHUB_TOKEN`은 별개입니다. **기존 비공개 패키지의 반복 발행**에는
별도 발행용 PAT나 다른 저장소 쓰기 토큰을 등록하지 않습니다. 아직 제공하지 않는 초기 생성 절차의
권한이 이것으로 충족됐다는 뜻은 아니며, `read:packages` 토큰으로 패키지를 생성할 수도 없습니다.

## 발행되는 시점

**작업 브랜치에 push하는 것만으로는 발행하지 않습니다.**
아래 경로는 비공개 패키지 준비·검증과 두 변수의 명시적 활성화가 끝난 뒤에만 실행됩니다.

1. 교육기관 원본 `SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team`에 PR을 올리고 병합합니다.
2. 자기 포크의 원격 기본 브랜치에 원본의 최신 병합본을 동기화합니다.
3. 같은 소스의 앱·Catalog·Ops·Infra CI가 모두 통과하면 이미지 발행이 진행됩니다.
4. 네 이미지의 검증된 digest가 `infrastructure/gitops/environments/fork/`에 자동 기록됩니다.
5. PC에서 그 변경을 pull하고, GitOps 모드라면 Argo CD가 자기 포크의 변경을 배포합니다.

`git pull`은 내 PC만 바꿉니다. GitHub의 **Sync fork**로 원격 포크를 먼저 동기화하거나,
로컬에서 원본 변경을 반영한 뒤 자기 포크에도 push해야 CI가 시작됩니다. 충돌이 있으면 기존 작업을
보존하고 해결하며, 자동 reset·force-push하지 않습니다. 본인이 작성한 미병합 코드나 원본보다
오래된 소스는 배포 후보로 삼지 않습니다. 자동 생성한 개인 digest 파일만 원본과 달라도 됩니다.

포크를 만든 것만으로 기존 커밋의 push CI가 생기지는 않습니다. 이 기능을 포함한 코드가 먼저
원본에 병합되고 포크에 동기화돼야 하며, 필요한 네 CI 실행이 없는 경우 발행을 건너뜁니다.
수동 `MSA image candidates` 실행도 이 검증을 우회하지 않습니다.
새 포크가 이미 원본 최신 상태라 동기화할 변경도 없다면, [최초 CI 실행 안내](../../docs/msa-image-release.md)에
따라 깨끗한 기본 브랜치에서 내용 변경 없는 초기 실행 커밋을 한 번 만들 수 있습니다.
이 경우에도 원본과 소스가 같아야 하며, 미병합 코드를 발행하는 예외는 아닙니다.

로컬 개발 감시 도구는 이 발행 경로와 별개로 **저장한 서비스만 PC에서 재빌드**합니다.
세부 검증·권한·실패 시 동작은 [이미지 릴리스 안내](../../docs/msa-image-release.md)를 참고하세요.
