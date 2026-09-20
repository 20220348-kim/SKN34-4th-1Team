# 이미지 digest 승격: 통합 후 잠금 상태

이미지 빌드는 CI, 보관은 GHCR, 버전 선택은 Git 배포 설정, 실제 리소스 반영은 Argo CD의 책임입니다.
같은 저장소에서 모두 관리해도 이 책임은 구분합니다.

## 통합 저장소의 현재 상태

- 루트 `.github/workflows/msa-images.yml`·`msa-promotion.yml`은 명시적으로 잠겼습니다.
- `scripts/promote_image.py`·`scripts/sync_images.py` CLI도 실행 전에 거절합니다.
  GitHub 조회·receipt 파일 읽기·values 쓰기를 하지 않습니다.
- 원본 GovBiz-Team 발행자의 receipt 검증·최신 CI 확인·digest-only 갱신 함수와 단위 테스트는 유지합니다.
- `environments/portfolio/release.json`과 네 values의 digest는 원본 환경에서 검증한 이력입니다.
  통합본의 새 발행이나 팀원 pull 권한을 의미하지 않습니다.
- 잠금은 **제출본 코드에만** 적용합니다. 원본 저장소 발행/승격·기존 Mac 자동 배포는 변경하지 않습니다.

## 재개 전에 필요한 변경

개인 fork 저장소·브랜치·GHCR namespace를 발행자와 승격 검증자가 동일하게 사용해야 합니다.
교육기관 push가 교육기관 GHCR 발행으로 연결되지 않도록 합니다. 개인 Actions의 단기
`GITHUB_TOKEN`으로 본인 패키지를 발행하고, Kubernetes에는 별도 읽기 전용 인증을 주입합니다.
토큰과 실제 `.env`는 Git·values에 저장하지 않습니다.

workflow 이름·경로와 `infrastructure/gitops/environments/<환경>/` 쓰기 범위를 검증하고,
이미지 발행→digest 커밋→자기 PC Argo 동기화를 실제 통과한 뒤 잠금을 해제합니다.
`MSA_RELEASE_ENABLED`/`MSA_PROMOTION_ENABLED` 변수 변경만으로 재개하지 않습니다.

## 유지한 오프라인 검사

```bash
cd infrastructure/gitops
python -B -m unittest discover -s scripts -p 'test_promote_image.py'
python -B -m unittest discover -s scripts -p 'test_sync_images.py'
```

다른 서비스/registry, mutable tag, stale digest, 로컬 fixture, 경로 이탈, symlink, 중복 YAML 키,
잘못된 artifact 출처를 거절하는 검사를 유지합니다. 테스트 통과는 실제 인증·pull·배포 증거가 아닙니다.
이전 digest로 되돌리는 것과 DB migration/data 복구도 별개입니다.

[개인 fork 전환 안내](portfolio-gitops.md) · [과거 검증 기록](portfolio-validation-20260920.md)
