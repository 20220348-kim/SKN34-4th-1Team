# 개인 포크의 비공개 GHCR 최초 준비

각 팀원은 자기 포크·자기 패키지를 최초 한 번 준비합니다. 교육기관 조직 권한이나 다른 팀원의
토큰은 필요하지 않습니다. 이후 반복 발행은 Actions의 단기 `GITHUB_TOKEN`, PC의 이미지 다운로드는
별도의 `read:packages` 토큰을 사용합니다.

## 1. 발행은 잠근 상태로 빈 패키지 생성

포크의 Actions Variables에서 `MSA_RELEASE_ENABLED=false`, `MSA_PROMOTION_ENABLED=false`를 유지합니다.
`origin`이 자기 개인 포크인지 `git remote -v`로 확인합니다. Python 3.13과 실행 중인 Docker가 필요하며,
명령은 저장소 루트의 Mac 또는 Windows **WSL2** 터미널에서 실행합니다.

[classic PAT 생성 화면](https://github.com/settings/tokens/new?scopes=write:packages)에서 짧은 만료 기간과
구분 가능한 이름을 지정합니다. `write:packages` 및 이에 포함되는 `read:packages`만 사용하고,
자동 선택되는 `repo`가 있다면 해제합니다. `workflow`, `delete:packages`는 필요하지 않습니다.
이 일회용 쓰기 토큰을 Actions Secret이나 Kubernetes에 등록하지 않습니다.

```bash
python3.13 -B infrastructure/release/bootstrap_packages.py create
```

표시된 목적지가 자기 계정인지 확인하고 `yes`를 입력한 뒤, 토큰을 **숨김 입력**합니다.
이미 안전하게 준비한 본인 소유 0600 파일은 `--token-file /절대경로/token`으로 전달할 수도 있습니다.
토큰 원문을 명령 인자·채팅·Git·`.env`에 넣지 않습니다.

이 도구는 다음 경계만 담당합니다.

- Git `origin`과 토큰 소유자가 같고 교육기관 저장소의 개인 포크인지 확인합니다.
- 네 패키지가 없을 때만 `FROM scratch`의 **빈 초기화 이미지**를 올립니다. 앱 코드·파일 컨텍스트·
  source/revision 라벨·비밀값을 넣지 않으며, 생성 직후 Private와 소유자를 검사합니다.
- 기존 공개 패키지나 다른 저장소에 연결된 패키지가 있으면 중단합니다. 삭제·공개 범위 전환을 하지 않습니다.
- Docker 인증은 임시 디렉터리로 격리하고 종료 시 제거합니다. 기존 Docker 로그인은 바꾸지 않습니다.
- 패키지 권한·Actions 변수·배포는 자동으로 변경하지 않습니다.

CLI로 최초 게시하는 패키지는 기본적으로 Private입니다. 공개 저장소의 `GITHUB_TOKEN`으로 최초
생성하는 경로와 구분합니다. 그래도 앱 코드를 바로 올리지 않고 빈 이미지와 생성 직후 검사를 사용합니다.
[GitHub Container registry 공식 문서](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

## 2. 네 패키지에 포크 연결 및 Actions 쓰기 허용

도구가 출력한 네 Package settings 링크에서 각각 설정합니다. 패키지 목록은 GitHub 프로필 → Packages에 있습니다.

1. 패키지 본문의 **Connect repository**에서 정확한 `본인계정/본인포크`를 연결합니다.
2. Package settings에서 **Private**가 유지되는지 확인합니다.
3. **Inherit access from source repository**는 체크하지 않습니다. 공개 소스 저장소의 접근 권한을
   비공개 패키지에 상속하지 않고 별도로 관리합니다.
4. **Manage Actions access → Add Repository**에서 같은 포크만 추가하고 Role을 **Write**로 설정합니다.
   다른 저장소·Codespaces에는 이 작업을 위해 권한을 추가하지 않습니다.

기존 패키지를 저장소에 연결하는 것과 Actions 접근을 허용하는 것은 별도 설정입니다.
[GitHub 패키지 접근 권한 설명](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)

```bash
python3.13 -B infrastructure/release/bootstrap_packages.py verify
```

이 명령은 Private·소유자·정확한 포크 연결을 확인합니다. **Actions의 실제 쓰기 권한이나 배포 성공을
검증한 것은 아닙니다.** UI의 Actions Write 설정과 아래 첫 발행 결과까지 확인해야 합니다.
검사가 끝나면 GitHub Settings → Developer settings → Personal access tokens에서 **이번 일회용 토큰만
폐기**하고, 사용한 임시 토큰 파일도 삭제합니다. 삭제해도 이후 CI는 별도의 `GITHUB_TOKEN`으로 작동합니다.

## 3. 자동 발행·승격 활성화

준비가 끝난 자기 포크에서 두 repository variable을 `true`로 바꿉니다.

- `MSA_RELEASE_ENABLED=true`
- `MSA_PROMOTION_ENABLED=true`

원본 PR 병합 → 자기 포크의 원격 기본 브랜치 동기화 → 같은 SHA의 네 CI 성공 → 비공개 이미지 발행 →
검증된 digest 커밋 순서입니다. 초기 준비 중 이미 CI가 완료됐다면 기본 브랜치에서 **MSA image candidates**를
한 번 수동 실행할 수 있습니다. 수동 실행도 원본 병합·동일 소스·네 CI 검증을 우회하지 않습니다.

다음 결과를 각각 확인합니다.

1. `MSA image candidates`: 네 서비스 모두 성공. 패키지들은 계속 Private.
2. `Fork image promotion`: 성공. 자기 포크의 `infrastructure/gitops/environments/fork/`에 digest 기록.
3. [개인 포크 로컬 개발 안내](local-fork-development.md)의 `up`과 `gitops` 실행: 자기 읽기 전용 토큰으로
   실제 이미지 pull, 네 Argo Application의 Synced/Healthy 확인.

PC의 `read:packages` 토큰은 일회용 쓰기 토큰과 **별개**이며 만료·폐기 시 교체해야 합니다.
다른 팀원은 자기 계정으로 이 최초 준비를 수행해야 합니다. 한 사람의 Mac 성공이 Windows 검증을 대신하지 않습니다.
