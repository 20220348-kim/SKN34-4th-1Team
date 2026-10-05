# 공개 GHCR 이미지로 전환하기

> 별도 배포 PR 자동화는 제거했습니다. 아래 이미지 공개 범위 검증은 유지하지만,
> GHCR 발행 후 Argo 자동 배포의 새 연결은 아직 없습니다.

기본은 비공개입니다. 이 코드를 추가하거나 PR을 병합하는 것만으로 패키지가 공개되지는 않습니다.
교육기관 GHCR 사용, 원본 PR 자동 병합, 패키지 자동 생성도 하지 않습니다.

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
