# 개인 포크의 이미지 digest 승격

이미지 빌드는 CI, 보관은 비공개 GHCR, 버전 선택은 Git, 실제 리소스 반영은 Argo CD의 책임입니다.
학교 조직의 GHCR 대신 본인 포크의 패키지를 사용하며 계정명은 공통 코드에서 수정하지 않습니다.

## 자동 승격

루트 `.github/workflows/msa-promotion.yml`의 `Fork image promotion`은 성공한
`MSA image candidates` 완료 이벤트 또는 기본 브랜치의 수동 실행만 받습니다.
개인 포크에서 `MSA_PROMOTION_ENABLED=true`를 명시해야 합니다. 학교 소유 저장소는 계속 차단합니다.

검증 대상은 네 CI의 같은 SHA 성공, 최신 소스 또는 digest-only 후속 커밋, 정확한 발행 workflow,
네 서비스 receipt의 artifact 출처·checksum·플랫폼·실제 Git tree·개인 이미지 경로입니다.
다른 사람의 패키지나 예전 `GovBiz-Team` receipt를 받아주는 fallback은 없습니다.

발행의 기준은 **교육기관 원본 PR 병합 → 개인 포크 기본 브랜치 동기화**입니다. 최신 upstream
기본 브랜치가 후보 커밋의 조상이며, 다섯 개인 배포 선택 파일을 제외한 내용이 동일해야 합니다.
개인 코드만 push하거나 원본에 병합되지 않은 변경은 CI가 통과해도 발행·승격하지 않습니다.
동기화 뒤 생긴 개인 merge SHA 자체가 upstream에 없어도 위 조건을 만족하면 허용합니다.
로컬 pull만으로 원격 CI가 시작되지는 않습니다. 원격 포크의 Sync 또는 동기화 결과 push가 필요합니다.

처음에는 `environments/fork`가 없습니다. 검증된 네 receipt를 받은 뒤에만 안전한 portfolio 런타임
기본값에서 **이전 이미지·digest를 제거**하고 본인 이미지의 실제 digest를 넣어 생성합니다.
기존 본인 설정이 있으면 registry·서비스 일치를 확인하고 digest만 바꿉니다. 다른 사람의 release를
포크로 물려받았다면 본인의 검증된 네 receipt를 받은 뒤 안전한 기본값으로 다섯 파일을 재생성하여
동일한 Git 커밋으로 교체합니다. 물려받은 이미지나 receipt를 배포 근거로 재사용하지 않습니다. 모든 사전 검사를 마치기
전에는 파일을 쓰지 않습니다. 예전 `environments/portfolio`는 보존합니다.

갱신 범위는 다음 다섯 파일로 제한합니다.

```text
infrastructure/gitops/environments/fork/
  core-service.yaml
  catalog-service.yaml
  ai-service.yaml
  ops-service.yaml
  release.json
```

`release.json`은 `repository`, `branch`, `verifiedRevision`, `runId`, `runUrl`,
네 서비스별 `images`(repository@sha256)를 기록합니다. 실행 토큰이나 비밀값은 기록하지 않습니다.
실제 Helm render 검증과 push 직전 원격/receipt 재검사 후 한국어 bot 커밋을 일반 push합니다.
동시에 사용자가 push하여 충돌하면 강제 덮어쓰기하지 않고 실패합니다.

digest 커밋은 단기 `GITHUB_TOKEN`으로 push하므로 새 push CI를 재귀적으로 만들지 않습니다.
GitOps 클러스터는 그 Git 변경을 직접 감지합니다. 새 애플리케이션 소스가 push되면 새 CI를 거칩니다.

## 수동 검토와 안전장치

`scripts/promote_image.py`는 검토한 receipt로 **기존 `environments/fork/<service>.yaml`**의
diff를 미리 보거나 적용합니다. 자동 Git push·클러스터 접근은 하지 않습니다. 수동 작업자는
먼저 발행 run의 성공과 receipt 출처를 확인해야 하며, 자동 승격에는 더 엄격한 `sync_images.py`를 사용합니다.

`validate_record(record, fork)`는 로컬에서 레코드의 정확한 계정·브랜치·서비스/digest 형식을 검사합니다.
`verify_record(root, fork)`는 GitHub의 CI·발행 run·artifact·Git tree와 현재 values를 추가 검증합니다.
형식 검사만으로 실제 pull 권한이나 컨테이너 정상 실행이 증명되지는 않습니다.

다른 사람의 release가 포함된 checkout에서는 본인의 첫 발행·승격 완료 전까지 클러스터를 시작하지 않습니다.
자동 승격이 본인 이미지 선택을 다시 생성하므로 계정명 편집이나 파일 수동 삭제는 필요 없습니다.
이미지 rollback과 DB migration/data 복구는 별도입니다.

```bash
cd infrastructure/gitops
python -B -m unittest discover -s scripts -p 'test_promote_image.py'
python -B -m unittest discover -s scripts -p 'test_sync_images.py'
```

Python 3.13과 `scripts/requirements.txt`가 필요합니다. 다른 계정·mutable tag·stale digest·symlink·
경로 이탈·중복 YAML·잘못된 artifact·중간 검증 실패 시 무변경을 검사합니다.

[발행 최초 설정](../../../docs/msa-image-release.md) · [이전 환경 기록](portfolio-validation-20260920.md)
