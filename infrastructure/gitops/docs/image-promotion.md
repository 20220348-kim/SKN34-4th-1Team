# 이미지 발행과 배포의 현재 경계

별도 `deploy/fork` 브랜치와 배포 PR 절차는 사용자 요청으로 제거했다.
현재 흐름은 `skn-* → main 개발 PR → 필수 CI → 검증된 이미지 발행`이다.
배포용 PR이나 추가 리뷰 승인은 요구하지 않는다.

`MSA image candidates`의 CI gate·이미지 출처·digest·receipt 검증은 유지한다.
`Fork image promotion` 워크플로는 제거했으며 `MSA_PROMOTION_ENABLED=false`를 유지한다.
이미지 발행 후 Argo 자동 배포를 연결하는 대체 기능은 아직 없다.
자세한 적용 상태는 [배포 PR 제거 기록](deployment-candidates.md)을 참고한다.

## 배포 PR 없이 GHCR 이미지로 로컬 초기화

`fork_cluster.py up`은 개인 포크 기본 브랜치의 현재 SHA에 대해 다음을 직접 검증한다.

1. 최신 upstream 병합본과의 일치 및 다섯 CI의 필수 16개 job 성공.
2. 성공한 이미지 발행 run/attempt와 정확한 네 receipt의 저장소·SHA·checksum·Git tree.
3. 같은 Git 커밋의 Chart·values와 검증된 digest로 구성한 Helm 4.3.0 렌더링.
4. 무료 실행 정책, Secret 참조, Ops 앱과 동일 이미지의 필수 migration Job.
5. 렌더링 후 소스·CI 증거·최신 발행 run·artifact가 바뀌지 않았는지 재확인.

실행 흐름은 `up → 현재 발행 검증 → immutable Git 설정 + receipt → Helm 검사 → 이미지 pull 권한 확인
→ 전용 kind 초기화 → Ops migration → 서비스 준비 확인`이다.
검증 실패·만료 artifact·최신 발행 실패를 과거 이미지로 대신하지 않는다.
임시 디렉터리에서 렌더링하며 작업 브랜치·index·로컬 수정·원격 Git을 변경하지 않는다.
소스 객체가 없으면 `origin`에서 해당 SHA만 fetch한다.

Python 3.13·Git·Helm·kind 외에 GitHub CLI `gh`와 해당 포크의 CI·Actions artifact를 읽을 수 있는
로그인이 필요하다. `gh`의 GitHub 조회 인증과 이미지 pull용 `read:packages` 인증은 별개다.
기존 [비공개 패키지 준비](../../../docs/private-ghcr-setup.md)를 마친 뒤 저장소 루트에서 실행한다.

```bash
gh auth status
python -B infrastructure/gitops/scripts/fork_cluster.py init
python -B infrastructure/gitops/scripts/fork_cluster.py doctor
python -B infrastructure/gitops/scripts/fork_cluster.py up
python -B infrastructure/gitops/scripts/fork_cluster.py status
```

비공개 이미지는 기존 숨김 입력/`--token-file` 방식으로 pull Secret을 준비하고 공개 이미지는
익명 digest 조회를 확인한다. `up` 완료 후 로컬 `baseline.json`의 `release`에 소스 SHA·발행 run·digest를 기록한다.
로컬 소스의 `up --local-images`는 `gh`·GHCR 없이 계속 사용한다.
로컬 `integrations.json` override는 검증된 발행 설정에 섞지 않으며 해당 연동은 소스 이미지 경로를 사용한다.

이 경로는 명시적인 로컬 초기화이며 Argo 자동 배포가 아니다. 기존 GitOps 모드의 인증 갱신은
그 환경이 고정한 과거 snapshot의 이미지를 계속 확인한다. 새 Argo 전환 경로는 아직 제공하지 않는다.
GitHub 조회와 클러스터 적용 전체를 하나의 transaction으로 잠그지는 않으며,
선택한 이미지의 변경 불가능한 digest와 확인한 소스 SHA를 기준으로 초기화한다.

## 로컬 검증 도구

`scripts/promote_image.py`는 기존 `environments/fork/<service>.yaml`의 digest diff를 확인·편집하는
로컬 도구다. push·PR 생성·클러스터 변경은 하지 않는다.
`sync_images.py`의 receipt 출처·checksum·Git tree 검증과 values 구성 함수도 보존한다.
`release.json`의 형식 검증만으로 GitHub CI·실제 pull·서비스 기동이 증명되지는 않는다.

```bash
python -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_promote_image.py'
python -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_sync_images.py'
python -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_deployment.py'
python -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_published_release.py'
```

Python 3.13, Helm 4.3.0과 GitOps requirements가 필요하다.
[이미지 발행 최초 설정](../../../docs/msa-image-release.md)
