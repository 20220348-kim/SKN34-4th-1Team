# 공개 GHCR 이미지로 전환하기

기본은 비공개입니다. 이 코드를 추가하거나 PR을 병합하는 것만으로 패키지가 공개되지는 않습니다.
교육기관 GHCR 사용, 원본 PR 자동 병합, 패키지 자동 생성도 하지 않습니다.

## 공개 시 달라지는 부분

- `MSA_PACKAGE_VISIBILITY`는 `private`(기본) 또는 `public`만 허용합니다. 실제 패키지의 공개 범위·소유자·연결 저장소가 모두 일치해야 발행합니다.
- 발행 인증은 공개 여부와 관계없이 Actions의 단기 `GITHUB_TOKEN`을 사용합니다.
- 공개 이미지의 v2 receipt에 `visibility: public`을 기록합니다. 네 receipt의 공개 범위가 모두 같아야 승격합니다.
- 승격 도구가 네 Helm values의 `imagePullSecrets`를 빈 배열로 만들고 배포 기록에도 공개 범위를 저장합니다.
- `fork_cluster.py up`·`gitops`는 공개 기록에 한해 PAT 없이 네 digest의 익명 pull을 확인합니다. 인증·네트워크 오류나 digest 불일치를 성공으로 숨기지 않습니다.
- DB 비밀번호, JWT 키, 내부 서비스 토큰은 계속 Kubernetes Secret으로 주입합니다. 공개 이미지에 넣지 않습니다.
- 기존 v1 receipt와 `visibility`가 없는 배포 기록은 비공개로 해석합니다. 기존 클러스터의 읽기 Secret이나 GitHub 토큰은 자동 삭제하지 않습니다.

공개/비공개 상태는 이미지 바이트의 속성이 아니라 **패키지 접근 권한**입니다. 따라서 레이어 digest만 검사하는 것으로 공개 범위를 확인했다고 할 수 없습니다.

## 기존 비공개 패키지를 전환하는 순서

1. 이미지 정리와 공개 발행 대응 코드를 교육기관 원본에 PR로 병합하고, 개인 포크 기본 브랜치에 Sync합니다. 미병합 소스 발행 예외를 만들지 않습니다.
2. 패키지와 `MSA_PACKAGE_VISIBILITY`는 아직 비공개로 유지합니다. 네 CI 통과 후 정리된 이미지를 비공개로 발행·배포하고 서비스 상태를 확인합니다.
3. 실제 새 이미지 digest의 설정·빌드 기록·모든 레이어를 검사합니다. AI 이미지의 `/opt/kordoc/.git`, `.github`, `tests`가 어떤 최종 런타임 레이어에도 없어야 합니다. `.env`, 키, 토큰, 비밀번호 포함 여부도 별도 점검합니다.
4. 공개 범위 변경 전에 두 발행 변수 `MSA_RELEASE_ENABLED`, `MSA_PROMOTION_ENABLED`를 잠시 `false`로 두고 진행 중인 발행·승격 작업이 끝났는지 확인합니다.
5. 패키지를 공개하면 **이전 버전도 공개 대상**입니다. 새 이미지 발행만으로 예전 이미지의 Git 이력이 제거되지 않습니다. 특히 정리 전 AI 버전은 현재 배포·다른 소비자가 사용하지 않는지 확인하고, 삭제 또는 공개 포함 여부를 명시적으로 결정합니다. 버전을 자동 삭제하지 않습니다.
6. 검증한 본인 포크의 네 서비스 패키지만 GitHub Package settings에서 Public으로 변경합니다. 소스 저장소나 다른 계정·조직 패키지를 변경하지 않습니다.
7. 네 패키지가 모두 Public임을 확인하고 `MSA_PACKAGE_VISIBILITY=public`으로 설정한 뒤 두 발행 변수를 다시 `true`로 합니다. 변수만 바꾸는 것으로 새 workflow가 자동 실행되지는 않습니다.
8. 검증 가능한 기본 브랜치 push로 네 CI·발행·승격을 실행합니다. 소스 변경이 없다면 [최초 CI 실행과 동일한 깨끗한 기본 브랜치 빈 커밋 절차](msa-image-release.md)를 한 번 사용할 수 있습니다. bot의 digest-only 커밋에는 새 push CI가 없으므로 단순 workflow_dispatch만으로 발행 자격이 생기지 않습니다. 원본과 소스가 같아야 한다는 조건은 유지합니다.
9. 승격된 `release.json`의 `visibility: public`, 네 YAML의 `imagePullSecrets: []`, 새 digest와 Argo CD의 Synced/Healthy를 확인합니다. 다른 PC도 이 기록을 pull한 뒤 같은 `up` 명령을 사용하며 `--token-file`은 전달하지 않습니다.
10. 읽기 인증을 더 이상 쓰지 않는 것을 확인한 후 필요하면 `ghcr-pull` Secret과 해당 전용 PAT만 별도로 폐기합니다. 다른 패키지를 받는 데 쓰이는 토큰이나 서비스 비밀값은 삭제하지 않습니다.

GitHub는 공개 패키지를 다시 비공개로 직접 변경할 수 없다고 안내합니다. 공개 전에 이 범위를 확인해야 합니다.
[GitHub 패키지 공개 범위 문서](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)

## AI 이미지 정리 방식

`backend/ai-service/Dockerfile`의 `kordoc-builder` 단계에서 외부 도구의 `.git`, `.github`, `tests`를 제거한 뒤 최종 런타임으로 복사합니다. 실행 파일 `dist/mcp.js`, 생산용 Node 의존성, PDF 의존성과 기타 런타임 자료는 유지합니다.

중요한 차이는 **최종 이미지에 복사하기 전에 제거한다**는 점입니다. 최종 이미지에 일단 복사한 뒤 다음 레이어에서 삭제하면 이전 레이어에서 되찾을 수 있습니다. 로컬 builder 캐시에는 빌드용 Git 이력이 남을 수 있으므로 builder 이미지를 공개 발행하는 대상으로 삼지 않습니다.

단위 테스트와 로컬 빌드 검증은 실제 GHCR 발행·익명 pull·Argo 배포 검증과 다릅니다. 최종 공개 전환 때 위 절차를 실제 새 digest로 확인해야 합니다.
