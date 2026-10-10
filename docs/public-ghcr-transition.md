# 공개 GHCR 이미지로 전환하기

> 별도 배포 PR 자동화는 제거했습니다. 아래 이미지 공개 범위 검증은 유지하지만,
> GHCR 발행 후 Argo 자동 배포의 새 연결은 아직 없습니다.

기본은 비공개입니다. 이 코드를 추가하거나 PR을 병합하는 것만으로 패키지가 공개되지는 않습니다.
교육기관 GHCR 사용, 원본 PR 자동 병합, 일반 발행 중 패키지 자동 생성은 하지 않습니다.
아래 별도 수동 초기화 작업은 평가 실행기 한 개의 빈 패키지만 생성할 수 있습니다.

## 공개 시 달라지는 부분

- `MSA_PACKAGE_VISIBILITY`는 `private`(기본) 또는 `public`만 허용합니다. 실제 패키지의 공개 범위·소유자·연결 저장소가 모두 일치해야 발행합니다.
- 발행 인증은 공개 여부와 관계없이 Actions의 단기 `GITHUB_TOKEN`을 사용합니다.
- 공개 이미지의 v2 receipt에 `visibility: public`을 기록합니다. 네 receipt의 공개 범위가 모두 같아야 승격합니다.
- 승격 도구가 네 Helm values의 `imagePullSecrets`를 빈 배열로 만들고 배포 기록에도 공개 범위를 저장합니다.
- 현재 검증된 발행으로 초기화하는 `fork_cluster.py up`은 공개 기록에 한해 PAT 없이 네 digest의 익명 pull을 확인합니다. 인증·네트워크 오류나 digest 불일치를 성공으로 숨기지 않습니다. 새 Argo 전환 경로는 아직 제공하지 않습니다.
- 기존 환경을 유지한 채 발행 증거만 확인하려면 [공개 이미지 검증 명령](../infrastructure/gitops/docs/image-promotion.md#클러스터-적용-없이-공개-이미지-검증)을 사용합니다. CI·receipt·Helm 정책과 익명 manifest 접근을 확인하며 이미지 레이어 다운로드나 클러스터 적용은 수행하지 않습니다.
- DB 비밀번호, JWT 키, 내부 서비스 토큰은 계속 Kubernetes Secret으로 주입합니다. 공개 이미지에 넣지 않습니다.
- 기존 v1 receipt와 `visibility`가 없는 배포 기록은 비공개로 해석합니다. 기존 클러스터의 읽기 Secret이나 GitHub 토큰은 자동 삭제하지 않습니다.

공개/비공개 상태는 이미지 바이트의 속성이 아니라 **패키지 접근 권한**입니다. 따라서 레이어 digest만 검사하는 것으로 공개 범위를 확인했다고 할 수 없습니다.

## PAT 없이 평가 실행기 패키지 최초 준비

공개 GHCR 이미지의 **다운로드는 PAT 없이 가능**합니다. 새 패키지 생성·이미지 업로드는 소유자의
쓰기 인증이 필요하지만 최초 생성과 이후 CI 발행 모두 Actions가 자동 발급하는 `GITHUB_TOKEN`을
사용할 수 있습니다. 별도 PAT 발급·로컬 입력·Actions Secret 등록은 필요하지 않습니다.
[GitHub Container registry 문서](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

`MSA_PACKAGE_VISIBILITY=public`은 발행 정책일 뿐 새 패키지를 만들거나 공개로 전환하지 않습니다.
평가 실행기의 `package-preflight`가 `404/missing_or_inaccessible`이면 패키지 누락과 Actions 접근
불가를 먼저 구분합니다. 기존 네 서비스의 공개 상태만으로 새 `evaluation-runner`도 준비됐다고
판단하지 않습니다. 공개 pull과 GitHub 패키지 관리 API 조회에 필요한 권한도 구분합니다.

1. `evaluation-package-setup.yml`과 관련 코드를 기본 브랜치에 반영하고 같은 SHA의 필수 CI를
   통과시킵니다. 작업 브랜치에서 실행하거나 실패·진행 중 CI를 초기화 예외로 우회하지 않습니다.
2. 개인 포크 Actions에서 **Kubernetes package setup → Run workflow**를 선택합니다.
   `component=evaluation-runner`가 기본입니다. 웹 최초 준비는 `component=web`을 선택하고
   아래 확인 대상도 `ghcr.io/<계정>/<저장소 소문자>-web`으로 지정합니다.
   기본 브랜치와 정확한 `confirm_package=ghcr.io/<계정>/<저장소 소문자>-evaluation-runner`를 지정합니다.
   `MSA_RELEASE_ENABLED=true`, `MSA_PACKAGE_VISIBILITY=public` 및 기존 `msa-release` 정책을 적용합니다.
3. 작업은 같은 소스의 CI를 확인하고 선택한 빈 패키지 하나만 만듭니다. 기존 네 서비스 패키지와
   실제 앱 이미지·배포는 변경하지 않습니다. 이미 존재하면 올바른 소유·연결 정보를 검증하고 생성하지 않습니다.
4. 작업 요약과 `evaluation-package-setup` artifact의 `actualVisibility`를 확인합니다.
   `AWAITING_PUBLIC_CONFIGURATION`이면 표시된 Package settings에서 Public으로 전환하고
   정확한 포크 연결·Actions 접근을 확인합니다. 공개 저장소 연결만으로 Public이라고 추정하지 않습니다.
   기존 패키지는 과거 버전도 공개 대상이므로 공개 범위를 확인하며 자동 삭제하지 않습니다.
5. `Evaluation runner image candidate`를 기본 브랜치에서 실행합니다. 이 작업의 패키지 사전 검사와
   같은 SHA의 필수 CI가 모두 통과해야 실제 실행기 이미지와 v3 receipt가 발행됩니다.
   웹을 준비했다면 `MSA image candidates`의 `component=web`을 실행해 웹 v4 receipt를 받습니다.

초기화 보고서의 `PUBLIC_METADATA_VERIFIED`는 조회한 공개 메타데이터만 확인합니다.
`applicationImagePublished=false`, `receiptWritten=false`, `clusterChanged=false`이며 실제 발행
성공을 대신하지 않습니다. 업로드 응답 유실은 `upload=attempted`로 기록하므로 새 실행 전에 패키지
상태를 확인합니다. 기존 패키지를 삭제하거나 공개 범위를 자동 변경하지 않습니다.

## 선택 사항: 로컬 도구 사용

로컬 도구를 선택한 경우 최초 한 번 다음 순서로 진행합니다.

1. [비공개 최초 준비](private-ghcr-setup.md)에 따라 일회용 classic PAT의 `write:packages`와
   포함되는 `read:packages`만 사용합니다. 토큰은 숨김 입력하며 채팅·명령 인자·Git에 넣지 않습니다.
2. `python3 -B infrastructure/release/bootstrap_packages.py create --service evaluation-runner`로
   앱 코드 없는 빈 비공개 패키지 한 개만 준비합니다. 기존 네 서비스 패키지는 변경하지 않습니다.
3. 패키지 화면에서 정확한 개인 포크 연결·해당 Actions의 Write 접근을 확인하고 Public으로 전환합니다.
   기존 패키지가 있었다면 이전 버전의 공개 범위를 먼저 확인하며, 자동 삭제·덮어쓰기를 하지 않습니다.
4. `python3 -B infrastructure/release/bootstrap_packages.py verify --service evaluation-runner --visibility public`으로
   소유자·연결 저장소·Public 메타데이터를 다시 확인합니다. 숨김 입력 토큰은 읽기 권한만으로도 가능합니다.
   이 명령은 Docker 로그인·빌드·업로드나 공개 범위 변경을 수행하지 않습니다.
5. `Evaluation runner image candidate`에서 실제 Actions 패키지 접근을 확인합니다. 동일 SHA의
   필수 CI가 통과해야 실제 실행기 이미지·v3 receipt가 발행됩니다. 메타데이터 조회 성공을
   Actions 쓰기 권한·이미지 발행·Kubernetes 이전 성공으로 보고하지 않습니다.
6. 초기 준비가 끝나면 이번 일회용 PAT만 폐기합니다. 기존 서비스의 인증 정보는 변경하지 않습니다.

Windows에서도 Python과 Docker CLI가 있는 일반 터미널에서 숨김 입력 경로를 사용할 수 있습니다.
`--token-file`의 소유자·0600 검사는 POSIX 전용이므로 Windows에서는 사용하지 말고 WSL/Linux에서
실행합니다. 터미널의 stdin이 대화형이 아니면 숨김 입력을 거절합니다.

## 이미 공개된 패키지가 기본 비공개 정책에 막힌 경우

`package-preflight` 보고서에서 네 서비스 모두 `repository: matched`, `owner: matched`,
`actualVisibility: public`, `expectedVisibility: private`이면 공개 범위 정책 불일치입니다.
이 결과를 Actions 접근 권한 부족으로 해석해 PAT를 추가하거나 권한을 확대하지 않습니다.

공개 발행을 계속하기로 선택한 경우, 해당 개인 포크의 Actions 저장소 변수
`MSA_PACKAGE_VISIBILITY=public`을 설정합니다. 패키지 자체를 다시 공개로 전환하거나 기존 버전을
삭제하는 작업은 필요하지 않습니다. 이 설정은 새 이미지도 공개 패키지에 발행하도록 허용하는 정책입니다.
비공개 배포가 필요하다면 현재 공개 패키지와 구분되는 비공개 목적지를 먼저 설계하며, 검사를 우회하지 않습니다.

설정 후 `package-preflight`의 네 서비스가 모두 검증됐는지 확인하고, 같은 최신 SHA의 다섯 CI가
실제 성공한 뒤 네 이미지와 receipt 발행 결과를 별도로 확인합니다. 워크플로를 수동 실행해도 CI·
원본 병합 검증은 유지됩니다. 사전 점검 성공은 실제 push 권한·이미지 발행·클러스터 배포 성공이 아닙니다.
`MSA_PROMOTION_ENABLED=false`를 유지하며 배포 PR 자동화를 다시 켜지 않습니다.

## 기존 비공개 패키지를 전환하는 순서

1. 이미지 정리와 공개 발행 대응 코드를 교육기관 원본에 PR로 병합하고, 개인 포크 기본 브랜치에 Sync합니다. 미병합 소스 발행 예외를 만들지 않습니다.
2. 패키지와 `MSA_PACKAGE_VISIBILITY`는 아직 비공개로 유지합니다. 다섯 CI 통과 후 정리된 이미지를 비공개로 발행·배포하고 서비스 상태를 확인합니다.
3. 실제 새 이미지 digest의 설정·빌드 기록·모든 레이어를 검사합니다. AI 이미지의 `/opt/kordoc/.git`, `.github`, `tests`가 어떤 최종 런타임 레이어에도 없어야 합니다. `.env`, 키, 토큰, 비밀번호 포함 여부도 별도 점검합니다.
4. 공개 범위 변경 전에 두 발행 변수 `MSA_RELEASE_ENABLED`, `MSA_PROMOTION_ENABLED`를 잠시 `false`로 두고 진행 중인 발행·승격 작업이 끝났는지 확인합니다.
5. 패키지를 공개하면 **이전 버전도 공개 대상**입니다. 새 이미지 발행만으로 예전 이미지의 Git 이력이 제거되지 않습니다. 특히 정리 전 AI 버전은 현재 배포·다른 소비자가 사용하지 않는지 확인하고, 삭제 또는 공개 포함 여부를 명시적으로 결정합니다. 버전을 자동 삭제하지 않습니다.
6. 검증한 본인 포크의 네 서비스 패키지만 GitHub Package settings에서 Public으로 변경합니다. 소스 저장소나 다른 계정·조직 패키지를 변경하지 않습니다.
7. 네 패키지가 모두 Public임을 확인하고 `MSA_PACKAGE_VISIBILITY=public`으로 설정한 뒤 `MSA_RELEASE_ENABLED=true`로 합니다. 배포 PR 자동화는 제거했으므로 `MSA_PROMOTION_ENABLED=false`를 유지합니다. 변수만 바꾸는 것으로 새 workflow가 자동 실행되지는 않습니다.
8. 최신 기본 브랜치 SHA의 다섯 CI가 실제 성공했는지 확인합니다. 해당 SHA의 CI 기록이 없다면 [최초 CI 실행 절차](msa-image-release.md)를 따릅니다. 이미 같은 SHA의 검증이 완료됐다면 `MSA image candidates`를 수동 실행할 수 있습니다. 원본 병합·동일 소스·필수 job 검증은 유지됩니다.
9. 네 서비스 receipt의 `visibility: public`과 소스 SHA·digest, 전체 발행 결과를 확인합니다. 새 개인 환경의 초기화는 [검증된 GHCR 초기화](../infrastructure/gitops/docs/image-promotion.md)를 따릅니다. 도구가 생성한 Helm values의 `imagePullSecrets: []`와 실제 digest pull·서비스 준비 상태를 확인합니다. 기존 환경의 이미지 교체·Ops migration·Argo 연결은 별도 작업이며 발행 성공으로 완료 처리하지 않습니다.
10. 읽기 인증을 더 이상 쓰지 않는 것을 확인한 후 필요하면 `ghcr-pull` Secret과 해당 전용 PAT만 별도로 폐기합니다. 다른 패키지를 받는 데 쓰이는 토큰이나 서비스 비밀값은 삭제하지 않습니다.

GitHub는 공개 패키지를 다시 비공개로 직접 변경할 수 없다고 안내합니다. 공개 전에 이 범위를 확인해야 합니다.
[GitHub 패키지 공개 범위 문서](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)

## AI 이미지 정리 방식

`backend/ai-service/Dockerfile`의 `kordoc-builder` 단계에서 외부 도구의 `.git`, `.github`, `tests`를 제거한 뒤 최종 런타임으로 복사합니다. 실행 파일 `dist/mcp.js`, 생산용 Node 의존성, PDF 의존성과 기타 런타임 자료는 유지합니다.

중요한 차이는 **최종 이미지에 복사하기 전에 제거한다**는 점입니다. 최종 이미지에 일단 복사한 뒤 다음 레이어에서 삭제하면 이전 레이어에서 되찾을 수 있습니다. 로컬 builder 캐시에는 빌드용 Git 이력이 남을 수 있으므로 builder 이미지를 공개 발행하는 대상으로 삼지 않습니다.

단위 테스트와 로컬 빌드 검증은 실제 GHCR 발행·익명 pull·Argo 배포 검증과 다릅니다. 최종 공개 전환 때 위 절차를 실제 새 digest로 확인해야 합니다.
