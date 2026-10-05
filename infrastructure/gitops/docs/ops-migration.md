# Ops 스키마 준비와 배포 migration

새 배포 후보 v2는 Ops 앱과 같은 이미지 digest·환경변수·Secret 참조를 사용하는
`ops-service-migrate` Job을 포함한다. 별도 배포 PR 절차는 제거했으며 이 문서는 migration 실행 계약을 설명한다.
이 문서는 구현된 계약이며 실제 클러스터 배포 성공 기록이 아니다.

## 실행 순서

`검증된 배포 입력 → Ops migration Job → migrate_deployment → MySQL → Ops Deployment → readiness`

Argo 자동 배포의 새 연결은 아직 없다. 로컬 소스와 현재 발행을 검증한 GHCR 초기화 모두
Ops migration 성공 뒤에만 앱을 적용한다.

- 앱 컨테이너는 Gunicorn만 실행한다. 시작할 때 migration을 숨겨서 실행하지 않는다.
- Job은 `python manage.py migrate_deployment`로 전진 migration을 수행한다. DB 이름으로 구분한
  MySQL advisory lock을 즉시 획득하지 못하면 실패한다. 동일 명령끼리의 동시 실행을 막으며
  일반 `manage.py migrate`나 직접 DDL을 사용하는 외부 작업까지 통제하지 않는다.
- Job은 non-root·읽기 전용 파일시스템·API 토큰 미마운트·임시 /tmp를 사용한다.
  AppProject에 namespace 범위의 `batch/Job`만 추가하며 DB·Secret·PVC 생성 권한을 추가하지 않는다.
- `backoffLimit: 0`, `restartPolicy: Never`, `activeDeadlineSeconds: 300`이다.
  새 후보의 Ops Application은 sync 재시도 횟수를 0으로 둔다. Kubernetes Job의 실행 자체가
  정확히 한 번을 보장하지는 않으므로 DB 잠금과 Django migration 이력으로 중복 실행을 통제한다.
- 실패한 Job은 남기고 성공한 Job은 삭제한다. 다음 sync에서는 `BeforeHookCreation`으로 기존
  Job을 교체하므로, 재시도 전에 실패 로그·진행 중인 세션·DB 스키마를 확인한다.
  다른 승인 revision이나 운영자의 수동 sync도 새 실행을 일으킬 수 있다.
- PreSync 실패는 해당 Ops Application의 Sync를 막는다. 다른 세 Application의 rollout까지
  원자적으로 막거나 이미 실행 중인 구버전 Ops를 중지시키는 장치는 아니다.

구버전 최초 전환용 `migrate_deployment`에는 `--pause-request-id`, `--pause-actor`,
`--pause-reason`을 함께 지정할 수 있다. 배포 잠금을 유지한 채 schema와 최초 접수 중지를 모두
확인해야 성공하며, 같은 요청은 version 1 중지 상태가 유지될 때만 재시도할 수 있다.
입력 오류·부분 접수 schema·다른 변경 이력은 migration 전에 거절한다. migration 또는 접수 중지가
실패하면 성공으로 출력하지 않는다. MySQL DDL의 rollback이나 서비스 자동 복구는 수행하지 않는다.
일반 Helm Job은 기존 옵션 없는 명령을 유지하며 이 옵션을 자동 사용하지 않는다.
개인 WSL/kind의 [`ops_initial_migration.py`](../scripts/ops_initial_migration.py)는 검증된 Helm
Job에 이 옵션을 연결한다. 깨끗한 대상 SHA의 필수 CI, 같은 중지 시점의 암호화 state 백업,
실제 격리 복원·전환 검증을 요구하고 기본 실행은 검증만 수행한다. 원본 DB 변경은 별도 승인 후
`--execute`로 요청하며 성공·실패 Job과 실행 기록을 남긴다. API/sync·Compose 재개와 이미지 교체는
수행하지 않는다. [최초 전환 실행 절차](../../../docs/ops-upgrade-runbook.md#쓰기가-중지된-개인-환경의-최초-migration-실행-경로)를 따른다.

Argo의 [hook 실행 순서와 삭제 정책](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/),
[Kubernetes Job 실행 특성](https://kubernetes.io/docs/concepts/workloads/controllers/job/),
[MySQL 세션 잠금](https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html)을 기준으로 구성했다.
Ops의 선택적 리소스 sync는 사용하지 않는다. Argo는 selective sync에서 hook을 실행하지 않으며,
현재 코드가 운영자의 직접 kubectl·Argo 권한까지 차단하는 것은 아니다.

## 준비 상태와 복구 경계

`GET /api/v1/health`는 DB를 호출하지 않는 liveness다.
`GET /api/v1/health/ready`는 DB 질의, migration 이력의 일관성·충돌·미적용 여부,
관리 모델의 실제 테이블·컬럼 접근을 읽기 전용으로 검사한다.

| 상태 | HTTP 및 응답 checks |
| --- | --- |
| DB 연결/질의 실패 | 503, `database: DOWN` |
| 빈 DB·미적용 migration·이력 불일치·테이블/컬럼 누락 | 503, `database: UP, schema: DOWN` |
| 연결·migration·모델 컬럼 확인 성공 | 200, `database: UP, schema: UP` |

행 데이터·인덱스·constraint의 완전한 무결성 검사나 Core·Prefect·결과 저장소의 업무 준비 검증은 아니다.
readiness는 migration을 실행하지 않고 외부 API·유료 API도 호출하지 않는다.

MySQL DDL은 전체 migration을 원자적으로 되돌리지 못할 수 있다. 실패한 Job을 삭제하거나
이전 앱 이미지로 되돌린다고 DB가 복원되지 않는다. 변경 전 구버전 앱과의 호환성 및 백업을 검토하고,
실패 시 실제 적용 상태를 확인한 뒤 수정된 전진 migration 또는 검증된 복구 절차를 사용한다.
새 migration 파일이나 destructive SQL은 이번 기능에 포함하지 않았다.
[Django migrate 동작](https://docs.djangoproject.com/en/5.2/ref/django-admin/#migrate)

## 로컬 실행과 검증

- `fork_cluster.py up`은 DB 준비 후 Ops Job 완료를 기다리고 앱을 적용한다.
  Job 실패 시 앱 적용을 중단하며, 기존 Job이 있으면 자동 삭제하지 않고 확인 후 명시적인 정리를 요구한다.
  성공한 Job만 지운다. 과거 v1 snapshot은 원래 이미지와 실행 계약으로 읽는다.
- `smoke_msa.py`는 동일 Helm Job을 실행한다. 구형 Ops 단독 Kustomize smoke는 격리된 테스트 DB에만
  테스트 앱과 같은 Pod 설정의 일회성 Job을 만든다.
- Compose CI는 자신의 임시 프로젝트에서 DB 시작 → migration → 앱 시작 순서로 실행한다.
  수동 Compose 실행은 [Ops 빠른 시작](../../../backend/ops-service/README.md#빠른-시작--docker)을 따른다.
- `dev.py --watch`는 이미지 개발 도구이며 DB migration을 자동 실행하지 않는다.
  스키마를 추가한 개발 이미지는 watcher 복원 후 명시적인 `up --local-images` 초기화 경로로 검증한다.
- 과거 v1 snapshot은 검증·조회할 수 있지만 새 승인에는 v2가 필요하다.
  v2는 실제 렌더링에 Job이 없거나 이미지·명령·Secret·보안 설정이 다르면 거절한다.
- Ops CI의 `scripts/check-schema.py`는 GitHub Actions의 명시적 테스트 플래그와 빈 MySQL을 요구한다.
  빈 스키마 차단, migration 후 준비, 반복 실행 데이터 보존, 실제 세션 잠금 경합, 컬럼 누락 차단을 확인한다.
  기존 테이블이 있는 DB에서는 작업을 시작하지 않는다. CI fixture 컬럼 변경은 복원하고 DB를 삭제하지 않는다.

Core 관리자 인증 → 저장된 캡처 평가 → 결과 조회·재시작 후 유지의 실제 E2E,
Prefect·데이터셋·결과 저장소 연결, 최신 후보의 Argo 실행 증거는 G2/G3의 남은 작업이다.
