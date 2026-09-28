# 개인 포크의 배포 후보 PR

이미지 빌드는 CI, 보관은 개인 GHCR, 배포 입력 선택은 리뷰된 Git PR, 실제 반영은 Argo CD가 담당합니다.
소스 기본 브랜치와 승인된 `deploy/fork` 브랜치를 분리합니다. 상세 설정과 승인 절차는
[전체 배포 후보 안내](deployment-candidates.md)를 따릅니다.

`Fork image promotion`은 성공한 `MSA image candidates` 이벤트 또는 소스 기본 브랜치의 수동 실행을 받습니다.
개인 포크의 `MSA_PROMOTION_ENABLED=true`와 활성 보호 규칙이 필요합니다. 교육기관 원본의 GHCR 발행은 차단합니다.
upstream에 병합된 최신 소스, 같은 SHA의 다섯 CI·16개 job, 정확한 발행 run과 네 receipt의 출처·checksum·Git tree를 검사합니다.

후보에는 네 digest뿐 아니라 Chart 전체, 서비스 values, receipt, 렌더링 결과, Argo 선언과 검증 manifest가 포함됩니다.
본인 fork values가 있으면 실행 설정을 보존해 검증하고, 없거나 타인 설정을 물려받았으면 안전한 portfolio 값에서
본인의 receipt로 재구성합니다. 검증된 후보 branch에만 한국어 커밋을 push하고 `deploy/fork` 대상 PR을 만듭니다.
소스·배포 브랜치 직접 push와 자동 merge는 하지 않습니다.

## 결과와 수동 승인

[발행·승격 결과 안내](../../release/README.md#발행승격-결과-확인)의 `msa-promotion-result`는 후보 PR과
그 SHA를 기록합니다. `candidateCreated=true`여도 배포 완료가 아닙니다.
별도로 dispatch한 검사기가 정확한 후보 SHA에 `govbiz/deployment-candidate` 상태를 게시합니다.
리뷰 승인 후 사람이 수동 병합해야 Argo의 배포 입력이 바뀝니다.
소스·배포 base·CI 증거가 달라지거나 파일이 변조되면 새 후보를 만들어야 합니다.

`msa-publication-*` 정보 보고서는 receipt가 아니며 네 이미지 receipt 검증을 대신하지 않습니다.
후보 PR 생성, 검사 통과, 병합, Argo 동기화와 실제 서비스 준비를 구분합니다.

## 기존 수동 도구

`scripts/promote_image.py`는 기존 `environments/fork/<service>.yaml`의 digest diff를 미리 보거나 적용하는
로컬 편집 도구입니다. push·승인·클러스터 접근은 하지 않으며 단독 실행으로 배포 후보가 승인되지 않습니다.
`sync_images.py`의 receipt 검증·values 구성 함수는 새 후보 생성기에서도 사용합니다.
이전 다섯 파일 직접 승격 CLI는 배포 PR 절차를 대신하지 않습니다.

`release.json`의 형식 검증만으로 GitHub CI·실제 pull·컨테이너 실행이 증명되지는 않습니다.
계정명 수정이나 예시 digest 삽입으로 초기 release를 만들지 않습니다. 이미지 rollback과 DB 복구도 별도입니다.

```bash
python -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_promote_image.py'
python -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_sync_images.py'
python -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_deployment.py'
```

Python 3.13, Helm 4.3.0과 GitOps requirements가 필요합니다.

[발행 최초 설정](../../../docs/msa-image-release.md) · [과거 환경 기록](portfolio-validation-20260920.md)
