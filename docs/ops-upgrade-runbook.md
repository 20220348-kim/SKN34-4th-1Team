# 개인 Kubernetes Ops + Compose 갱신·복구 절차

대상은 기존 개인 PC의 Kubernetes Ops API·sync·MySQL과 Compose Prefect·실행기·결과 서버다.
기존 [연결·활성화 도구](../infrastructure/gitops/docs/ops-runtime.md)를 사용한다.
클라우드의 빈 Docker 환경이나 임시 테스트 통과를 개인 PC 갱신 완료로 기록하지 않는다.
백업·접수 중지·업무 검증은 운영자가 수행하는 필수 단계이며 자동화됐다는 뜻이 아니다.

## 1. 대상과 사전 상태 고정

- [병합 조건](merge-protection.md)과 최신 배포 대상 SHA의 실제 필수 CI 성공을 확인한다.
  실패·진행 중·누락·건너뛰기 결과로 갱신하지 않는다. Git 작업 트리 변경도 먼저 정리한다.
- 개인 state 경로, repository/state ID, kube context·namespace, Compose project, Ops DB 이름과
  볼륨 식별자, 기존 이미지 ID와 release 해시를 기록한다. Secret 값은 보고서에 넣지 않는다.
- 기존 완료 평가 UUID와 인증된 보고서 SHA-256, 평가·검토·예산 감사 행의 비교 기준을 보존한다.
  과거 문서의 건수나 migration 번호를 현재 DB 상태로 대체하지 않는다.
- Ops의 진행 중/취소 처리 중 평가와 Prefect의 미완료 flow·예약·활성 스케줄을 함께 확인한다.
  남은 작업은 기다리거나 기존 취소 절차로 종료 증거를 확인한다. SQL로 강제 완료하거나 예산 정리
  CLI를 일괄 실행하지 않는다. 무료 평가도 완료를 확인한다.
- `0020` 이후 Ops에서는 아래 운영자 CLI로 신규 평가·후처리 복구 접수를 중지한다.
  이미 접수한 요청의 동일 UUID 재시도·동기화·취소·정산은 계속 허용해 기존 작업을 종료한다.
  Prefect 직접 접수·다른 flow·자동 스케줄은 별도 통제로 중지한다.

```bash
ops_manage() {
  kubectl --kubeconfig "$OPS_STATE_DIR/kubeconfig" --namespace govbiz-msa \
    exec deployment/ops-service -c ops-service -- python manage.py "$@"
}
ops_manage evaluation_admission status
# 아래 변수에는 방금 확인한 version, 변경자, 이번 중지 요청의 UUID를 지정한다.
# 응답 유실 시 같은 UUID와 같은 인자로 재시도한다.
ops_manage evaluation_admission pause \
  --expected-version "$OPS_ADMISSION_VERSION" --request-id "$OPS_PAUSE_REQUEST_ID" \
  --actor "$OPS_OPERATOR" --reason "배포 전 신규 평가 접수 중지"
```

`accepting=false`는 Ops의 새 요청 생성만 중지한다. `version`을 새로 읽고 변경자·사유·UUID를
명시해야 재개할 수 있다. 과거 resume 명령을 재전송해도 나중의 pause를 해제하지 않는다.
변경 기록의 actor는 운영자가 입력한 값이며 Core 인증 주체를 증명하지 않는다.
이 CLI는 DB 접근 권한이 있는 운영자용이며 공개 관리 API를 추가하지 않는다.

```bash
# 변수는 개인 PC의 실제 state 경로와 기존 완료 평가 UUID로 지정한다.
python3 -B infrastructure/gitops/scripts/ops_runtime.py --check \
  --state-dir "$OPS_STATE_DIR" --run-id "$OPS_EXISTING_RUN_ID"
python3 -B backend/ops-service/apps/evaluations/execution_spec.py --root .
# 버전 불일치와 별개로, 기존 실행 환경의 미완료 작업을 읽기 전용 점검한다.
python3 -B infrastructure/gitops/scripts/ops_runtime.py --preflight \
  --state-dir "$OPS_STATE_DIR"
```

첫 점검의 소스/이미지 불일치는 갱신 필요 근거로 보존한다. 소유권·DB·인증·브리지 장애는 먼저 해결한다.
`--check` 성공은 새 평가 성공이나 관리자의 실제 인증을 증명하지 않는다.

`--preflight`는 기존 Pod의 Django 모델과 Prefect 조회 API를 사용한다. 새 명령 설치나 migration 없이
미완료 평가(`RESULT_ERROR`와 알 수 없는 상태 포함), 종료되지 않은 예산 예약, 같은 Prefect flow의
이전 deployment를 포함한 미완료 실행·현재 deployment의 활성 스케줄, Ops DB의 미중지 일별 계획과
처리 미완료 일별 접수 이력을 검사한다. 일별 계획은 관리 화면의 중지 기능으로 먼저 중지한다.
종료일이 지났거나 시작일이 미래인 계획, 실행 기능 플래그가 꺼진 계획도 명시적으로 중지해야 한다.
일별 접수 이력의 `PENDING` 및 알 수 없는 상태는 차단한다. 최신 앱의 계획 중지 API는 아직 실행에
연결되지 않은 `PENDING` 이력을 같은 transaction에서 `BLOCKED / SCHEDULE_CLOSED`로 종료한다.
중지와 접수가 경합하면 계획 행 잠금으로 순서를 정하며, 이미 접수된 평가·예산은 보존한다.
구버전에서 중지한 계획의 대기 이력은 원래 관리자·중지 요청 UUID·사유로 재시도할 수 있다.
기존 중지 감사 정보는 바꾸지 않는다. 남은 미완료 평가·예약과 알 수 없는 이력은 계속 조사하며,
검사 통과를 위해 SQL로 강제 정리하지 않는다.
중지된 deployment에 활성 스케줄이 남아 있어도 차단한다. 자동 취소·정산·환급은 하지 않는다.

- `PASS`: 접수 제어 지원·중지 상태·양의 정수 버전을 확인했고 검사한 범위에서 남은 작업 없음.
- `BLOCKED`: 접수 제어 미지원, 접수 중지 전 또는 남은 작업 존재. 사유에 맞게 조치한 뒤 재검사한다.
- `UNKNOWN`: DB/Prefect 조회 실패, 불완전 응답, 점검 중 변경 등으로 확인 불가. 장애를 해결한 뒤 재검사.
  기존 이력을 보존하며 한 flow의 이력이 2,000개 이상이면 전체 검사 범위를 확장·검증하기 전까지 중단한다.
- 보고서는 `schemaVersion=4`이다. `PASS`에는 `admission_supported=true`, `admission_blocked=true`,
  `admission_version>=1`과 `checks.open_admission=0`이 필요하며 활성화 도구도 이를 검증한다.
  `checks.active_schedules`는 Prefect 일정, `checks.unpaused_ops_schedules`는 Ops의 미중지 계획,
  `checks.unsettled_schedule_occurrences`는 `SUBMITTED`·`BLOCKED` 이외의 일별 접수 이력이다.
  세 항목 모두 0이어야 하며 누락·잘못된 형식·이전 버전 보고서는 성공 증거로 인정하지 않는다.
  구버전 이미지에 일정 모델이 없다면 실제 DB에도 두 일정 테이블이 없는지 확인한다.
  모델·테이블 일부만 존재하거나 조회 실패·점검 전후 건수 변경이 있으면 `UNKNOWN`으로 중단한다.
  접수가 열려 있으면 `reason=admission_open`으로 차단한다. 점검 중 접수 상태 버전이 바뀌거나
  중지 상태의 버전이 누락·잘못된 값이면 `UNKNOWN`으로 중단한다.
- `0020` 이전 이미지에는 접수 제어가 없어 `admission_supported=false`, `admission_blocked=false`다.
  미완료 작업이 0건이어도 `BLOCKED`, `reason=admission_control_unsupported`로 갱신을 차단하며
  `checks.open_admission=null`로 확인 불가를 표시한다. 외부 접수 통제를 했다는 운영자 확인만으로
  이 CLI를 통과시킬 수 없다. 구버전의 최초 전환에는 접수 경로 차단·쓰기 중지·백업 복원 검증을
  포함한 별도의 유지보수 절차가 필요하며, 현재 자동 갱신 도구는 이를 지원하지 않는다.
  상태 기록 삭제·검사 우회·접수 제어 DB 행 수동 생성으로 통과시키지 않는다.
  새 이미지에서 테이블 조회에 실패한 경우는 구버전으로 대체하지 않고 `UNKNOWN`으로 중단한다.
- Prefect 직접 접수 등 다른 경로와 백업은 별도다. `backup_verified=false`이며
  `PASS`를 재사용 가능한 승인서로 쓰지 않는다. 갱신 실패 시 도구가 접수를 자동 재개하지 않는다.

기존 연결을 갱신할 때 활성화 도구가 이 검사를 다시 실행하며, `PASS`가 아니면 Secret·migration·workload
변경 전에 중단한다. 연결 기록이 없어도 현재 Ops에 Prefect URL이 설정돼 있으면 검사한다.
Prefect가 비활성인 최초 bootstrap은 이 검사 대상이 아니며 journal의 `upgradePreflight`가 `null`이다.

### 실제 중지 전에 대상과 복구 순서 확인하기

[`ops_maintenance_plan.py`](../infrastructure/gitops/scripts/ops_maintenance_plan.py)는 개인 dev 환경의
현재 상태를 읽어 백업용 중지 범위와 원래 실행 상태로 돌아갈 순서를 JSON으로 출력한다.
WSL에서 개인 state 경로를 지정하며 서비스·DB·Secret을 변경하지 않는다.

```bash
python3 -B infrastructure/gitops/scripts/ops_maintenance_plan.py --state-dir "$OPS_STATE_DIR"
```

- 접수 제어가 없는 구버전은 `admission_control_unsupported`이고 나머지 미완료 작업·예약·일정
  수가 모두 0일 때만 계획할 수 있다. 접수 제어를 지원하는 버전은 접수를 중지한 `PASS`가 필요하다.
  이 예외는 대상 조회에만 적용한다. 기존 갱신 도구의 차단 조건은 그대로 유지한다.
- Deployment UID·resourceVersion·spec 해시·원래 replicas, MySQL Pod·StatefulSet·PVC·Service
  식별자와 이미지 digest, Compose 쓰기 컨테이너의 ID·이미지·실행 상태를 기록한다.
  개인 dev의 안정된 Ops API/sync 1개 replica만 지원하며 Argo 관리·HPA·재시작 중 상태는 거절한다.
  점검 전후 대상이 바뀌어도 중단한다. 환경변수 값과 자격 증명은 출력하지 않는다.
- `stop_order`는 Kubernetes Ops API/sync와 현재 실행 중인 Compose 쓰기 컨테이너만 포함한다.
  Prefect는 쓰기 실행기 다음에 중지하고 먼저 재개한다. `resume_order`는 원래 실행 중이던 대상만
  되살리는 순서다. `leave_stopped`에 있는 기존 중지 컨테이너는 시작하지 않는다.
  MySQL·결과 조회 서버와 관련 없는 Langfuse 구성 요소는 중지 대상에서 제외한다.
- 복원용으로 원본과 정확히 같은 MySQL digest가 Docker에 있어야 `status=PLANNED`를 반환한다.
  이미지가 없거나 확인할 수 없으면 `BLOCKED`와 종료 코드 1을 반환하며 자동 pull하지 않는다.
  `PLANNED`도 관찰 결과일 뿐 백업·갱신 승인이나 중지 완료가 아니다.
  `services_changed=false`, `backup_verified=false`, `upgrade_allowed=false`를 유지한다.

실제 중지에는 관리 화면·평가 접수 중단 시간이 생긴다. 중지 범위를 확인한 뒤 다음 순서로 진행한다.

1. 중지 직전에 계획과 미완료 작업을 다시 확인한다. 직접 Prefect 접수·외부 DB/파일 쓰기도 통제한다.
   Deployment 변경은 UID·resourceVersion·replicas 전제조건을 확인하고, Compose는 기록한 정확한
   컨테이너 ID를 사용한다. 이름이 같아도 재생성된 컨테이너에 이전 계획을 적용하지 않는다.
2. `stop_order`대로 중지하고 Kubernetes Ops Pod가 사라지고 쓰기 컨테이너가 완전히 종료됐는지
   확인한다. 아래 DB·상태 백업 도구가 중지 상태와 남은 작업을 다시 검사해야 한다.
3. 같은 중지 상태에서 DB 암호화 백업과 `--runtime-keys` 상태 묶음을 만든다. 서비스 재개 전까지
   캡처를 완료하고, 격리 복원·완료 평가 연결·키·DB 로그인·구버전 migration 검증은 별도로 기록한다.
4. 성공·실패 모두 실제로 중지한 대상만 `resume_order`에 따라 원래 상태로 복구한다. 중간 실패 시
   아직 중지하지 않은 서비스에는 재시작을 걸지 않는다. 재개 뒤 rollout·브리지·기존 HTTP 연결을
   확인한다. Compose 주소가 바뀌었으면 기존 브리지 도구로 연결을 갱신하고 다시 검사한다.

이 계획 도구는 중지·재개를 자동 실행하지 않는다. 원본에 migration을 적용하는 절차와도 별개다.
관련 무료 테스트는 Infra CI의 `test_*.py` 검색에 포함되고 Ops CI에서 정적 검사를 수행한다.

### 최초 migration과 접수 중지를 함께 확인하기

최신 `migrate_deployment`의 최초 중지 옵션은 schema가 준비된 것만으로 성공하지 않고,
새 평가 접수가 중지된 것까지 확인한다. **실제 원본에서 실행하기 전에는** 외부 접수·API·sync·
실행기 쓰기를 중지하고 같은 중지 상태의 백업·복원 검증, 대상 이미지·필수 CI와 전환 승인을 확보한다.
이 명령 자체는 쓰기 중지나 백업을 증명하지 않으며 기존 활성화의 구버전 차단을 우회하지 않는다.

```bash
# 승인된 최초 전환의 migration 실행 환경 또는 새 격리 DB에서 사용한다.
# 요청 UUID·변경자·사유는 실행 전에 기록하고 응답 유실 시 같은 값으로 재시도한다.
python manage.py migrate_deployment --verbosity 0 \
  --pause-request-id "$OPS_PAUSE_REQUEST_ID" \
  --pause-actor "$OPS_OPERATOR" \
  --pause-reason "최초 전환 후 검증 전 신규 접수 중지"
```

- 옵션은 모두 지정하거나 모두 생략한다. UUID·변경자·사유는 배포 잠금과 migration 전에 검증한다.
- MySQL 배포 잠금 아래에서 접수 테이블이 아직 없거나 접수 version이 0인 상태를 허용한다.
  부분 테이블·이미 변경된 상태는 거절한다. 같은 요청의 재시도는 UUID·변경자·사유가 일치하고
  최초 중지 version 1이 그대로 유지될 때만 허용한다.
- 전진 migration과 schema 확인 후 기존 감사·접수 제어 함수를 사용해 version 0에서 중지한다.
  중지 확인·배포 잠금 해제까지 성공해야 현재 접수 상태 JSON을 반환한다. 옵션이 없는 명령의
  기본 동작은 유지하며 일반 migration이 기존 접수 상태를 자동 중지·재개하지 않는다.
- 나중에 운영자가 접수를 재개하거나 다른 중지 이력을 만들었다면 이전 배포 요청을 재사용할 수 없다.
  실패 후에도 API·sync·실행기의 중지 상태를 유지한다. DDL이 일부 적용됐을 수 있으므로
  오류가 났다는 이유로 구버전 앱을 자동 재개하거나 DB를 역방향 migration하지 않는다.

일반 Helm Job과 `ops_runtime.py`는 기존 동작을 유지한다. 개인 WSL/kind의 최초 전환은
아래 전용 명령으로 검증된 Helm Job에 접수 중지 옵션을 연결한다.

### 쓰기가 중지된 개인 환경의 최초 migration 실행 경로

[`ops_initial_migration.py`](../infrastructure/gitops/scripts/ops_initial_migration.py)는 원본 DB의
최초 migration 단계만 담당한다. 서비스를 중지하거나 재개하지 않고, 앱 이미지·Secret·브리지·
baseline을 바꾸지 않는다. 원본 DB 적용은 별도 승인된 전환 작업에서만 `--execute`로 요청한다.
현재 실행 중인 환경에서는 먼저 차단되며, 과거에 서비스 재개까지 마친 백업은 사용할 수 없다.

1. 대상의 state ID와 원격 저장소, 깨끗한 체크아웃의 전체 SHA, 원격 브랜치 HEAD가 일치해야 한다.
   해당 SHA의 push CI 5개와 각 필수 작업이 모두 성공했는지 GitHub에서 읽는다. 발행 정책의
   CI 검증을 공유하지만 GHCR 발행·업스트림 병합 권한을 부여하는 명령은 아니다.
2. 승인된 점검 시간에 쓰기를 중지하고, **동일한 중지 상태에서** DB·결과·Prefect·runtime keys를
   포함한 새 암호화 state 백업을 만든다. Pod/PVC·컨테이너·볼륨·DB 덤프·결과 파일·키가 현재와
   모두 같아야 한다. 다른 점검 시간의 백업, 재시작·키 교체·파일 변경은 거부한다.
3. 새 격리 MySQL과 임시 저장소에 백업을 복원해 기존 완료 평가 연결·Prefect의 미완료 실행 및
   활성 스케줄 부재·DB 로그인·runtime keys를 검증한다. 대상 이미지로 별도 격리 DB의
   `0017 → 현재 migration`과 접수 중지·기존 행 보존도 다시 검증한다.
4. 정책 검증을 통과한 Helm migration Job에서 DB 경로와 Secret 참조가 기존 API/sync와 같은지
   확인한다. 수동 점검용 Job에서는 Argo hook 삭제 annotation을 제거하고 최초 중지 옵션만 추가한다.
5. `--execute`가 있으면 기록을 먼저 저장하고 대상 이미지를 kind에 적재한다. CI·이미지 ID·백업·
   중지 상태를 다시 검사한 다음 Job을 실행한다. Job 완료와 원본 DB의 `accepting=false`,
   version 1, 단일 감사 행의 UUID·작업자·사유까지 확인해야 `MIGRATED_PAUSED`를 반환한다.

```bash
# 승인된 점검 시간에 새로 만든 state.enc와 key를 사용한다.
# 기본 실행은 원본 DB를 변경하지 않지만 격리 복원 컨테이너를 생성하고 정리한다.
python3 -B infrastructure/gitops/scripts/ops_initial_migration.py \
  --state-dir "$OPS_STATE_DIR" --expected-state-id "$OPS_STATE_ID" \
  --archive "$OPS_STATE_ARCHIVE" --key-file "$OPS_BACKUP_KEY" \
  --source-sha "$OPS_SOURCE_SHA" --source-branch "$OPS_SOURCE_BRANCH" \
  --ops-image "$OPS_TARGET_IMAGE" \
  --pause-request-id "$OPS_PAUSE_REQUEST_ID" --pause-actor "$OPS_OPERATOR" \
  --pause-reason "최초 전환 후 검증 전 신규 접수 중지"
# 원본 migration 승인을 받은 경우에만 같은 인자에 --execute를 추가한다.
```

기본 성공은 `VERIFIED_FOR_MIGRATION`이며 이후 실행의 허가증으로 재사용하지 않는다. 실행 시에도
검증을 다시 수행한다. 성공·실패 Job 모두 보존하고 `ops-initial-migrations/<요청 UUID>.json`에
단계·대상 SHA/이미지·백업 digest·CI 실행 ID를 기록한다. 기존 Job 또는 동일 UUID 기록이 있으면
자동 삭제하거나 재시도하지 않는다. SQL·키·외부 오류 본문은 출력과 기록에 포함하지 않는다.

`migration` 단계에서 중단되면 DB 적용 여부는 불확실하다. Job·Pod·DB 이력과 실제 schema를
확인하고 수정된 전진 작업 또는 검증된 복구를 선택한다. 이전 앱을 자동으로 켜거나 원본 DB를
덮어쓰지 않는다. `MIGRATED_PAUSED` 뒤에도 쓰기는 중지 상태로 유지해야 한다. 일치하는 API/sync·
실행기·결과 서버로 교체하고 연결·기존 이력·관리자 화면·무료 평가를 확인한 뒤 접수를 재개하는
런타임 전환은 아래 별도 단계로 수행한다. 기존 `ops_runtime.py`의 접수 제어 미지원 차단은 그대로 유지한다.

Infra CI는 전용 명령의 오프라인 Helm·중지/백업/CI 차단·실패 기록 테스트를 자동 탐색한다.
LLMOps CI의 실제 MySQL 업그레이드 테스트는 원본 DB 접수 중지를 확인하는 SQL도 격리 DB에서
검증한다. 이 검증은 개인 클러스터에서 Job을 실행했다는 증거가 아니다.

### 최초 migration 뒤 접수 중지를 유지한 런타임 전환

[`ops_initial_runtime.py`](../infrastructure/gitops/scripts/ops_initial_runtime.py)는 개인 WSL/kind의
`MIGRATED_PAUSED` 기록과 실제 중지 상태를 함께 확인한 뒤 동일 소스의 앱으로 전환한다.
호출 흐름은 `최초 migration 증거 확인 → 기존 Prefect 시작 → 결과 서버·실행기 교체 → 브리지 갱신
→ Kubernetes API/sync 전환 → 접수 중지·런타임 진단 → baseline 기록`이다.
이 단계는 원본 migration을 다시 실행하거나 접수를 재개하지 않는다.

선행 migration과 동일한 깨끗한 checkout·원격 브랜치 SHA·필수 CI 성공이 필요하다. 성공한 Job,
kind에 적재한 Ops 이미지 ID, 원래 Deployment spec, MySQL Pod·PVC·Service, 중지한 writer의
식별자가 기록과 같아야 한다. 접수 중지는 같은 요청 UUID·변경자·사유의 version 1이어야 한다.
불완전하거나 이전 형식이라 원본 식별자가 없는 migration 기록을 수작업으로 보충해 통과시키지 않는다.

runner는 같은 소스에서 미리 빌드한 로컬 이미지의 immutable ID로 지정한다. Ops 이미지의 소스
지문과 두 이미지의 execution release를 네트워크 없는 임시 컨테이너로 검사한다. 기본 실행도
이 검사용 컨테이너를 만들지만 기존 서비스·DB·baseline은 변경하지 않는다.

```bash
OPS_RUNNER_IMAGE_ID=$(docker image inspect "$OPS_RUNNER_IMAGE" --format '{{.Id}}')
python3 -B infrastructure/gitops/scripts/ops_initial_runtime.py \
  --state-dir "$OPS_STATE_DIR" \
  --migration-request-id "$OPS_PAUSE_REQUEST_ID" \
  --runner-image "$OPS_RUNNER_IMAGE_ID"
# 서비스 재개·이미지 전환 승인을 받은 경우에만 같은 인자에 --execute를 추가한다.
```

기본 성공은 `VERIFIED_FOR_ROLLOUT`이며 실제 적용 시 모든 조건을 다시 확인한다.

- 기존 Prefect 컨테이너를 그대로 시작한 뒤 컨테이너 내부의 `127.0.0.1:4200/api/health`가 200인지
  확인한다. Docker healthcheck가 없는 구버전도 이 API 검사를 반드시 통과해야 한다. healthcheck가
  설정돼 있다면 그 상태도 healthy여야 한다. 검사 중 컨테이너 중지·일시 정지·재시작이나 시작 시각 변경은
  거절한다. 최대 120초 동안 대기하며 개별 Docker 명령은 최대 5초, HTTP 연결은 2초로 제한한다.
  환경변수의 프록시와 HTTP 리디렉션을 사용하지 않고 응답 본문·인증값을 출력하지 않는다.
  Prefect 이미지·컨테이너 설정·저장소는 교체하지 않는다.
- 결과 서버와 실행기 두 서비스만 현재 설정에서 재구성한다. 기존 결과 볼륨과 네트워크는 external로
  참조하고 `--no-deps --no-build --pull never`로 교체한다. 기존 중지 Compose Ops API/sync는 켜지 않는다.
- 결과는 실행기만 쓰며 결과 서버는 읽기 전용이다. 데이터 bind mount는 현재 checkout의 평가 디렉터리로
  제한한다. Docker Desktop의 변환 경로는 저장소 경로만 연결한 임시 컨테이너와 기존 컨테이너의
  장치·inode가 같아야 허용한다. 변환 경로라는 이유만으로 임의의 호스트 경로를 허용하지 않는다.
- 환경변수는 메모리·표준입력으로 전달한다. Compose의 `$` 보간으로 인증 값이 달라지지 않는지 검사하고
  비밀 값이나 병합 설정을 파일·로그에 저장하지 않는다. 유료/RAG/스케줄 실행은 비활성으로 유지한다.
- 컨테이너 교체 후 새 주소로 브리지를 갱신하고 결과 서버 인증 및 runner release를 확인한다.
- Kubernetes Deployment의 UID·resourceVersion·replicas 0을 JSON patch로 비교한 뒤 두 앱 이미지와
  replicas만 바꾼다. DB·Secret·환경변수 참조를 바꾸지 않는다. 동시 변경은 거절한다.
- rollout·런타임·갱신 사전 검사·같은 접수 중지가 모두 확인된 뒤에만 baseline의 Ops 이미지를 갱신한다.

첫 변경 전에 `ops-initial-rollouts/<migration 요청 UUID>.json`을 생성한다. 각 단계의 시작·완료와
이미지 ID를 기록하며 성공 상태는 `ROLLED_OUT_PAUSED`다. 중간 실패·중단 시 실행 환경이 일부 바뀌었을
수 있으므로 실제 Prefect·컨테이너·Deployment와 마지막 단계를 대조한다. 같은 기록으로 자동 재시도하지
않으며 이미지 rollback·DB 복원·접수 재개를 자동 수행하지 않는다. 기록을 지워 성공으로 만들지 않는다.

`ROLLED_OUT_PAUSED`도 관리자 인증·기존 결과의 전체 대조·새 무료 평가 완료를 뜻하지 않는다.
`evaluation_executed=false`, `admin_auth_verified=false`, `admission_resumed=false`를 유지하며
[업무 검증 후 접수 재개](#5-업무-검증-후-접수-재개)를 별도로 수행한다.

Infra CI가 증거 불일치·기본 실행 무변경·실패 기록·Deployment 비교 조건을 검증한다. LLMOps CI는
실제 빌드 이미지와 Compose 컨테이너의 합성 `$` 환경변수 전달을 검사한다. Docker healthcheck가 없는
격리 HTTP 서버에서도 200 응답·리디렉션 거절·시간 제한·원래 컨테이너 유지 조건을 검증한다. 이 검사는
실제 Prefect 업무나 평가 완료를 대신하지 않는다. 이 검사만으로
개인 클러스터의 실제 전환이 완료됐다고 판단하지 않는다.

### 구버전 전환을 위한 격리 MySQL 회귀 검증

[`ops-ci.yml`](../.github/workflows/ops-ci.yml)은 기존 빈 DB 배포 검사와 별도로
`govbiz_ops_legacy_upgrade_ci`를 새로 만들고
`scripts/check-schema.py --legacy-evaluations`를 실행한다. 기존 DB를 초기화하거나 과거로 되돌리지
않고, 빈 MySQL 8.4에 `0017_input_token_budget`까지 전진 적용해 합성 이력을 만든다.
CI 전용 플래그 두 개가 모두 설정돼야 하며 기존 테이블이 있거나 역방향 migration 계획이면 거부한다.
개인 DB에 연결하거나 이 검사를 실행하려고 운영 DB를 비우지 않는다.

- 현재 앱의 readiness가 구버전 스키마를 거부하고, `migrate_deployment`로 최신 migration까지
  적용한 뒤 정상으로 바뀌는지 확인한다. 현재 대상은 `0028_daily_evaluation_schedules`다.
- 사용자·평가·검토·기준·예산·예약·사용량·감사 등 10개 모델의 기존 컬럼과 11개 합성 행을 대조한다.
  한글·이모지·따옴표·JSON·NULL·관계 식별자·시각을 보존하고, 과거 호출의 알 수 없는 토큰 상한은
  NULL로 유지해야 한다. 합성 검토 이력은 실제 사람의 승인이나 품질 평가 결과가 아니다.
- `migrate_deployment`의 최초 중지 옵션으로 schema와 접수 중지를 함께 확인한다.
  새 평가 요청은 `503 / EVALUATION_ADMISSION_PAUSED`이고 Prefect 호출이 없어야 한다.
  같은 UUID의 배포 명령을 재실행해도 차단·버전이 유지되고 감사 행이 중복되지 않아야 한다.

이 검사는 실제 MySQL을 사용하는 전환 회귀이며 원본 덤프의 복원 검증은 아니다. 인증은 테스트
클라이언트로 주입하고 Prefect 접수는 대역으로 검사하므로 Core 로그인·실행기·새 평가 완료를
증명하지 않는다. 외부 모델 API는 호출하지 않는다.
검증 성공으로 기존 `admission_control_unsupported` 차단을 해제하지 않는다. 실제 최초 전환에서는
접수 경로와 구버전 API·sync·실행기의 쓰기를 중지하고 일관된 백업·복원 검증을 먼저 확보해야 한다.
새 스키마만 적용하면 접수는 자동 중지되지 않으며, 구버전 앱은 새 접수 제어를 읽지 못한다.

### 암호화한 구버전 DB로 갱신을 미리 검증하기

[`ops_db_upgrade.py`](../infrastructure/gitops/scripts/ops_db_upgrade.py)는 아래 DB 백업 절차로 만든
암호화 파일을 **새 격리 MySQL에 복원한 뒤** 최신 Ops 코드의 migration을 적용한다.
개인 DB·Kubernetes·Compose 접속 옵션은 없으며 기존 환경을 갱신하거나 서비스를 중지하지 않는다.
현재 지원하는 출발점은 `0017_input_token_budget`이며 다른 migration 이력은 거절한다.

```bash
# 현재 checkout으로 검증용 이미지를 만든다. 실행 중인 서비스에는 적용하지 않는다.
docker build --tag govbiz-ops-upgrade:local backend/ops-service
OPS_UPGRADE_IMAGE=$(docker image inspect --format '{{.Id}}' govbiz-ops-upgrade:local)
python3 -B infrastructure/gitops/scripts/ops_db_upgrade.py \
  --archive "$OPS_DB_BACKUP_FILE" --key-file "$OPS_DB_BACKUP_KEY" \
  --ops-image "$OPS_UPGRADE_IMAGE"
```

- 먼저 백업의 SQL·테이블 행 수가 복원본과 같은지 확인한다. Ops 이미지 ID를 고정하고 이미지의
  `manage.py`·`apps`·`config` Python/JSON 파일 해시가 현재 checkout과 일치해야 진행한다.
- 실제 Django `migrate_deployment`로 전진 migration만 적용한다. 구버전 스키마가 readiness 검사에서
  거절되고 갱신 후 준비 상태로 바뀌는지 확인한다. 미완료 평가나 열린 예약이 있으면 중단한다.
- 기존 모든 테이블의 기본 키·원래 컬럼을 기준으로 기존 행의 값을 대조한다. migration 이력·
  content type·permission 테이블에는 신규 행 추가만 허용하고, 기존 업무 테이블의 추가·삭제·변경은
  거절한다. 새 컬럼은 이 비교 대상에서 제외하며 알 수 없던 기존 토큰 상한은 별도로 NULL 보존을 확인한다.
- 최초 접수 중지 옵션을 지정한 `migrate_deployment`를 실행하고 실제 접수 차단 함수를 확인한다.
  같은 UUID의 명령을 반복해도 접수가 열리거나 감사 기록이 중복되면 실패한다.
  HTTP 요청·Core 인증·Prefect 실행을 검사한 것으로 기록하지 않는다.
- 검사 컨테이너는 복원 MySQL의 격리된 네트워크만 공유한다. 원본 볼륨·외부 포트·모델 API는
  사용하지 않으며 읽기 전용 파일시스템과 임시 디렉터리로 실행한다. 새 DB의 임시 비밀번호는
  stdin으로 전달하며 데이터·키·SQL·상세 오류는 보고서에 넣지 않는다.
- 기존 행 대조·접수 중지·반복 실행·컨테이너 정리가 모두 성공해야 `status=REHEARSED`를 반환한다.
  `scope=disposable_ops_database_upgrade`이고 `personal_environment_verified=false`,
  `full_backup_verified=false`, `application_started=false`를 유지한다.

이 명령은 DB 백업 파일을 입력받는다. DB·결과·Prefect·실행 키 묶음과 로그인 복원은 아래의
`ops_state_snapshot.py verify --completed-links --runtime-keys --database-login`으로 따로 검증한다.
검증 성공은 기존 `admission_control_unsupported` 차단을 해제하거나 개인 환경의 전환을 승인하지 않는다.

무료 단위 검사는 `test_ops_db_upgrade.py`에서 수행한다. LLMOps CI는 현재 Ops 이미지와 실제
MySQL 8.4로 합성 구버전 DB를 암호화한 뒤 새 DB에서 갱신하고, 원본이 변하지 않았는지 확인한다.
로컬에서 같은 통합 검사를 실행할 때는 `OPS_DB_UPGRADE_TEST_IMAGE`에 Ops 이미지 ID와
`OPS_DB_SNAPSHOT_MYSQL_IMAGE`에 로컬 MySQL digest를 명시한다. 개인 DB는 사용하지 않는다.

## 2. 일관된 백업과 복원 가능성 확인

진행 중 작업이 없고 신규 접수가 차단된 상태에서 쓰기 프로세스를 중지한다.
중지 대상과 기존 replicas/Compose 실행 상태를 기록하고 다른 프로젝트를 중지하지 않는다.
DB와 파일을 서로 다른 시점에 복사한 뒤 일관된 백업이라고 판단하지 않는다.

| 대상 | 보존·대조할 내용 |
|---|---|
| Kubernetes Ops MySQL | 전체 schema·행·migration 이력, 평가/요청/flow 식별자, 검토·기준·예산 장부, 접수 상태·변경 감사 연결 |
| Compose 결과 볼륨 | 원본 입력·캡처·보고서·해시·서명 증거·경로 권한; 쓰기 중 복사 금지 |
| Prefect 저장소 | 정지 상태의 실제 저장 backend, deployment·run 이력·스케줄; 결과 볼륨과 별개 |
| Langfuse 관련 저장소 | trace·점수를 복구 범위에 포함하면 PostgreSQL·ClickHouse·객체 저장소도 함께 포함 |
| 실행 설정 | state/baseline, Compose 파일·프로필, 이미지 ID, Secret·서명 키의 안전한 복구 수단 |

백업은 저장소 밖의 접근 제한·암호화된 보관소에 둔다. 원문·키·덤프를 Git이나 일반 보고서에 넣지 않는다.
백업 파일 존재만으로 다음 단계로 넘어가지 않는다. **새 MySQL 8.4·새 결과 볼륨·격리된 Prefect**에
복원해 테이블·행·참조·파일 SHA-256을 대조한다. 복원 환경의 outbound와 스케줄을 제한해 기존 작업을
재전송하지 않는다. 키 누락·원본 파일 누락·장부 불일치는 중단 조건이다.
원본 DB 위에 복원하거나 기존 볼륨을 삭제하는 명령은 이 절차에 포함하지 않는다.

### 개인 Kubernetes Ops DB 암호화 백업과 격리 복원 확인

[`ops_db_snapshot.py`](../infrastructure/gitops/scripts/ops_db_snapshot.py)는 WSL/Linux에서
기존 개인 kind의 `govbiz_ops` DB를 암호화 파일로 보관하고, 새 임시 MySQL에 복원해 확인한다.
기존 Compose 백업 도구의 인증·암호화 형식을 재사용하지만 payload의 범위는
`kubernetes_ops_database`로 구분한다. Compose DB+파일 백업과 서로 대체할 수 없다.
SQL과 비밀번호를 출력하거나 평문 임시 파일로 저장하지 않는다.

먼저 위 절차에 따라 진행 중 작업과 접수를 정리하고, 운영자가 Kubernetes `ops-service`
Deployment의 API·sync와 해당 Compose 프로젝트의 실행기·Prefect를 중지해야 한다.
실행기가 Prefect에 종료 상태를 전달할 수 있도록 실행기를 먼저 종료한다.
이 명령은 서비스를 중지하거나 재개하지 않는다. 다른 수동 DB 쓰기·외부 접수 경로도 운영자가
차단해야 하며 검사 대상 밖의 작성자까지 잠근다는 뜻은 아니다.

- 전용 state·cluster 소유권, 연결 기록, Ops의 DB 설정, MySQL StatefulSet·Pod·PVC·서비스
  연결을 확인한다. Ops Pod가 남아 있거나 HPA가 있으면 백업하지 않는다.
- 알려진 Compose 작성자와 Prefect가 정지했는지 확인한다. 미완료 평가·열린 예산 예약,
  미중지 Ops 일정·미완료 일정 이력·활성 MySQL 이벤트도 차단한다. 일정 테이블이 없는
  구버전 DB는 지원하지만 일부만 존재하는 스키마는 거절한다.
- 쓰기 중지 상태와 저장소 식별자, 테이블별 행 수, 전체 SQL 덤프를 반복 대조한 뒤 파일을
  생성한다. 검사 중 변경되거나 출력 파일이 이미 있으면 덮어쓰지 않고 실패한다.
- 원본 Pod의 공식 MySQL digest와 정확한 `8.4.x` 버전을 보존한다. 해당 digest의 이미지가
  로컬 Docker에 미리 있어야 한다. 태그로 대체하거나 도구가 자동 다운로드하지 않는다.

원본 digest는 다음 읽기 전용 명령으로 확인한다. 로컬에 없으면 조회한 공식 MySQL digest를
확인하고 `docker pull mysql@sha256:<조회한 digest>`로 준비한다. 현재 `mysql:8.4` 태그가
과거 원본 Pod와 같은 이미지라고 가정하지 않는다.

```bash
kubectl --kubeconfig "$OPS_STATE_DIR/kubeconfig" --namespace govbiz-msa \
  get pod ops-mysql-0 -o 'jsonpath={.status.containerStatuses[0].imageID}'
```

다음은 저장소 루트에서 실행하는 Bash/WSL 명령이다. 디렉터리는 WSL 파일시스템 안에 두고,
기존 키를 사용한다면 `init-key`를 다시 실행하지 않는다. 키는 백업과 별도로 안전하게 보관한다.

```bash
umask 077
OPS_DB_BACKUP_DIR="$HOME/.local/share/govbiz-backups/ops-db"
install -d -m 700 "$OPS_DB_BACKUP_DIR"
OPS_DB_BACKUP_KEY="$OPS_DB_BACKUP_DIR/snapshot.key"
python3 -B infrastructure/llmops/ops_snapshot.py init-key --key-file "$OPS_DB_BACKUP_KEY"
OPS_DB_BACKUP_FILE="$OPS_DB_BACKUP_DIR/ops-$(date -u +%Y%m%dT%H%M%SZ).enc"
python3 -B infrastructure/gitops/scripts/ops_db_snapshot.py backup \
  --state-dir "$OPS_STATE_DIR" --key-file "$OPS_DB_BACKUP_KEY" --output "$OPS_DB_BACKUP_FILE"
python3 -B infrastructure/gitops/scripts/ops_db_snapshot.py verify \
  --key-file "$OPS_DB_BACKUP_KEY" --archive "$OPS_DB_BACKUP_FILE"
```

출력은 상태·암호화 파일 SHA-256·테이블/행 수만 포함한다. `BACKED_UP`은 파일 생성만 뜻한다.
`VERIFIED`는 파일 인증·정확한 버전의 빈 MySQL 복원·행 수/전체 덤프 일치·임시 컨테이너 정리가
모두 성공한 경우에만 반환한다. 복원 DB는 외부 네트워크·공유 볼륨·공개 포트 없이 생성하며
이벤트 스케줄러를 끈다. 앱·실행기·migration은 시작하지 않고 원본 DB에 SQL을 쓰지 않는다.
SQL은 최대 128 MiB, 임시 DB는 tmpfs 384 MiB와 메모리 512 MiB로 제한한다.
자원 부족이나 정리 실패도 실패로 남기며 자동으로 제한을 완화하지 않는다.

`restore_verified=true`여도 `full_backup_verified=false`다. 결과 파일·Prefect·Core 인증 DB·
Langfuse·Secret/서명 키·이미지 보관·앱 동작 복원은 이 파일에 포함하지 않는다.
키 복구와 위 표의 나머지 저장소 검증을 별도로 완료해야 한다. 구버전 자동 갱신의
`admission_control_unsupported` 차단을 해제하거나 migration을 승인하는 증거로 사용하지 않는다.

무료 단위 검증은 Infra CI, 실제 MySQL 암호화·복원 검증은 LLMOps CI에서 수행한다.
실제 검증은 별도의 합성 원본 DB를 만들고 한글·JSON·NULL·외래 키를 포함한 덤프와 복원 덤프를
대조하며 원본이 유지되는지 확인한다. 개인 Kubernetes의 실제 백업 실행을 대신하지 않는다.

```bash
python3 -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_ops_db_snapshot.py'
# 이미 로컬에 있는 공식 MySQL 8.4 digest를 명시할 때만 격리 DB 통합 테스트를 실행한다.
OPS_DB_SNAPSHOT_MYSQL_IMAGE='mysql@sha256:<로컬 이미지 digest>' \
  python3 -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_ops_db_snapshot.py'
```

### DB·결과 파일·Prefect를 같은 중지 상태에서 묶기

[`ops_state_snapshot.py`](../infrastructure/gitops/scripts/ops_state_snapshot.py)는 위 DB 백업에
동일 프로젝트의 `ops-results`와 `prefect-data`를 추가한 암호화 파일을 만든다.
**DB 백업 이후 API·sync·실행기·Prefect를 재개하지 않은 상태**에서 실행한다.
DB 백업에 기록한 쓰기 중지 상태·클러스터 식별자와 현재 상태가 다르거나 현재 SQL 덤프가
달라졌다면 묶지 않는다. 같은 중지 상태에서 DB 백업부터 새로 수행해야 한다.

```bash
OPS_STATE_BACKUP_FILE="$OPS_DB_BACKUP_DIR/ops-state-$(date -u +%Y%m%dT%H%M%SZ).enc"
python3 -B infrastructure/gitops/scripts/ops_state_snapshot.py backup \
  --state-dir "$OPS_STATE_DIR" --db-archive "$OPS_DB_BACKUP_FILE" \
  --key-file "$OPS_DB_BACKUP_KEY" --output "$OPS_STATE_BACKUP_FILE"
python3 -B infrastructure/gitops/scripts/ops_state_snapshot.py verify \
  --key-file "$OPS_DB_BACKUP_KEY" --archive "$OPS_STATE_BACKUP_FILE" --completed-links
```

- 원본 DB 백업과 같은 키를 사용하며 원본 파일을 수정하지 않는다. 출력은 새 파일만 허용한다.
- 프로젝트 소유의 기본 local Docker volume만 지원한다. bind/NFS 등 driver 옵션이 있는
  볼륨, 알 수 없는 소비 컨테이너, 실행 중인 쓰기 컨테이너는 거절한다.
  `ops-artifacts`만 읽기 전용 마운트 상태로 계속 실행할 수 있다.
- 각 볼륨을 읽기 전용으로 수집하고 두 번 대조한다. 마지막에 DB 덤프·볼륨 식별자·쓰기 중지
  상태를 다시 확인한 뒤에만 암호화 파일을 생성한다. 다른 수동 작성자까지 잠그는 기능은 아니다.
- 파일뿐 아니라 빈 디렉터리, 소유 UID/GID, 권한, 수정 시각을 보존한다. 링크·특수 파일·
  특수 권한·잘못된 경로는 거절하며 볼륨마다 최대 64 MiB·10,000개 항목을 지원한다.
  각 볼륨에는 최소 한 파일이 있어야 한다.
- Prefect는 기본 `/var/lib/prefect/prefect.db` SQLite 구성을 지원한다. 외부 DB 연결 설정,
  별도 프로필 경로 또는 `profiles.toml`이 있는 구성은 임의로 해석하지 않고 거절한다.
- 복원은 DB 검사에 쓰는 새 MySQL과, 외부 네트워크·공개 포트가 없는 임시 컨테이너의
  tmpfs에서 수행한다. 기존 볼륨은 복원 대상으로 받지 않는다. 파일 헬퍼는 로그 저장을 끄고
  파일 원문을 인자나 일반 보고서에 출력하지 않는다. 원본 이미지는 immutable ID로 고정하며
  로컬에 없으면 다운로드하거나 대체하지 않는다.
- 파일·디렉터리 내용과 메타데이터를 먼저 대조한다. Prefect는 복원 사본의 WAL을 포함해
  SQLite 무결성·외래 키·migration 이력을 확인하고 활성 일정·미완료 실행이 있으면 실패한다.
  Prefect 서버·실행기·migration은 시작하지 않는다. 정리 실패도 성공으로 처리하지 않는다.

이 파일의 `scope`는 `kubernetes_ops_db_results_prefect`다. `--completed-links`를 지정하면
복원한 MySQL에서 **모든 COMPLETED 평가**를 읽고 DB의 요청/flow ID·실행 명세와 해시·평가 ID·요약을
`request.json`, manifest, comparison, HTML 보고서와 대조한다. 복원한 Prefect SQLite에서도
같은 flow의 완료 상태·요청 ID·deployment·완료 이력을 확인한다. 검사에 쓰는 ID나 파일 본문을
보고서에 출력하지 않고 `matched_completed_evaluations` 건수만 남긴다.

완료 평가가 없거나 10,000건을 초과하는 경우, 실행 명세가 없는 구형 완료 기록, 누락·불일치가
있으면 이 옵션은 실패한다. 특정 평가만 골라 성공시키지 않는다. 성공 시
`cross_store_business_links_verified=true`, `cross_store_scope=completed_evaluations`다.
옵션을 생략하면 기존 저장소 복원 검사만 수행하고 해당 플래그는 `false`다.
실패·취소 평가의 업무 관계, 평가 품질·서명 검증, 실제 앱·API 재기동, Core 인증 DB,
Langfuse는 별도이며 `full_backup_verified=false`를 유지한다. Ops 실행 키는 아래 선택 검사를
추가할 수 있으며 Core 로그인 키·기존 사용자 세션의 복구와는 구분한다.
구버전 갱신 차단을 해제하거나 전체 복구 완료로 기록하지 않는다.

Infra CI에서 파일·SQLite·중지 상태·오류 처리 단위 검증을 실행한다. LLMOps CI에서는 빌드한
Ops 이미지로 새 결과/Prefect Docker 볼륨을 만들어 암호화·격리 복원·원본 보존을 검사한다.
DB의 실제 MySQL 검증은 같은 워크플로의 DB 백업 검사 단계에서 수행한다. 별도 연결 검사 단계는
합성 MySQL 평가 기록·결과 파일·Prefect SQLite를 하나의 암호화 파일로 만든 뒤 세 저장소를
실제 임시 컨테이너로 복원하고 연결·원본 보존·정리를 함께 검사한다.
개인 저장소를 중지하거나 실제 백업을 생성하는 검증은 아니다.

```bash
python3 -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_ops_state_snapshot.py'
python3 -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_ops_state_links.py'
# 이미 로컬에 있는 Ops 이미지 ID를 지정하면 합성 Docker 볼륨 검증도 실행한다.
OPS_VOLUME_SNAPSHOT_TEST_IMAGE='sha256:<로컬 Ops 이미지 ID>' \
  python3 -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_ops_state_snapshot.py'
# 두 이미지가 모두 있으면 MySQL·결과·Prefect 연결 통합 검사도 실행한다.
OPS_DB_SNAPSHOT_MYSQL_IMAGE='mysql@sha256:<로컬 MySQL 8.4 digest>' \
OPS_VOLUME_SNAPSHOT_TEST_IMAGE='sha256:<로컬 Ops 이미지 ID>' \
  python3 -B -m unittest discover -s infrastructure/gitops/scripts -p 'test_ops_state_links.py'
```

### Ops 실행 키를 암호화 백업에 포함하고 검증하기

`backup --runtime-keys`는 같은 쓰기 중지 상태의 저장소 묶음에 다음 값만 암호화해 포함한다.

- Kubernetes `ops-runtime`의 Django 키·DB 비밀번호·결과 서버 토큰
- Kubernetes `ops-mysql-runtime`의 앱·root DB 비밀번호(앱 비밀번호는 Ops 값과 일치해야 함)
- 원본 MySQL의 `root@localhost`, `govbiz_ops@%` 인증 해시와 지원 여부를 확인할 계정 속성
- 해당 Compose 실행기의 예산 토큰. Ops에도 설정돼 있다면 같은 값인지 확인한다.

```bash
# 앞선 백업과 다른 새 파일 이름을 사용한다. 중지 상태를 계속 유지한다.
OPS_KEY_STATE_BACKUP_FILE="$OPS_DB_BACKUP_DIR/ops-state-keys-$(date -u +%Y%m%dT%H%M%SZ).enc"
python3 -B infrastructure/gitops/scripts/ops_state_snapshot.py backup \
  --state-dir "$OPS_STATE_DIR" --db-archive "$OPS_DB_BACKUP_FILE" \
  --key-file "$OPS_DB_BACKUP_KEY" --output "$OPS_KEY_STATE_BACKUP_FILE" --runtime-keys
python3 -B infrastructure/gitops/scripts/ops_state_snapshot.py verify \
  --key-file "$OPS_DB_BACKUP_KEY" --archive "$OPS_KEY_STATE_BACKUP_FILE" \
  --completed-links --runtime-keys --database-login
```

키 원문은 파일·CLI 인자·일반 보고서에 기록하지 않는다. `kubectl`과 Docker 조회 응답은 도구의
메모리 안에서만 처리하고 암호화 파일에 보관한다. 검사 컨테이너에는 stdin으로만 전달하며
로그 저장·외부 네트워크·포트 공개를 사용하지 않는다. 개인 관리자 비밀번호, Core JWT 키,
Langfuse 키와 OpenAI 키는 수집하지 않는다. 복원한 키를 기존 Secret이나 서비스에 적용하지 않는다.

Ops API·sync와 MySQL의 Secret 참조, Secret UID·버전, DB 비밀번호, Compose 소비자와 토큰을
확인한다. Ops와 결과 서버의 로컬 immutable 이미지가 같아야 한다. 알 수 없는 Secret 키·간접
환경 주입·불일치·수집 중 변경은 거절한다. 백업 전에 새 `ops-bootstrap`도 종료돼 있어야 한다.
초기 데이터를 적재하는 이 서비스 역시 DB와 결과 볼륨의 작성자다.

원본 키로 만든 일회용 서명 증거를 암호화 파일에 함께 저장한다. 검증은 별도 Ops 컨테이너에서
복원한 키로 Django 서명을 읽고, 다른 키는 거절하는지 확인한다. 실제 결과 서버 WSGI 코드도
정상 토큰은 허용하고 잘못된 토큰은 거절해야 한다. 이는 HTTP 배포·Core 관리자 로그인 검증이 아니다.
`--database-login`을 생략하면 DB 비밀번호는 같은 값의 복구 여부만 대조한다.

`verify --runtime-keys --database-login`은 SQL·행 수·완료 평가 연결 검사가 끝난 격리 MySQL에
**원본 인증 해시**를 복원한다. 검사할 비밀번호로 새 인증 해시를 만들지 않으므로, Secret 값과
실제 DB 비밀번호가 다르면 로그인이 실패한다. root는 `root@localhost`를 선택하도록 컨테이너
내부 소켓으로, 앱 계정은 TCP로 접속한다. 두 계정의 실제 사용자·DB·평가 행 수를 대조하고
잘못된 비밀번호가 인증 오류로 거절되는지 확인한다. 연결 장애를 비밀번호 거절로 취급하지 않는다.

대상은 이 도구가 만든 이름·라벨과 네트워크 격리·tmpfs를 갖춘 새 MySQL로 제한하며 기존 DB와
볼륨에 인증 정보를 적용하지 않는다. 지원 범위는 `caching_sha2_password`를 사용하는 잠기지 않고
만료되지 않은 두 계정이며, 별도 SSL 요구나 추가 인증 속성이 있으면 거절한다. Ops의 `DB_USER`와
MySQL의 `MYSQL_USER`도 `govbiz_ops`여야 한다. 원본 권한은 복원하지 않으며 앱에는 검증용
`SELECT ON govbiz_ops.*`만 부여한다. 따라서 쓰기 권한·원본 인증 정책 전체·앱 재기동은 검증 범위가 아니다.

보관된 `capture/usage-<sequence>.json` 전체의 v1/v2 HMAC 서명·요청 ID·순번을 복원한 예산
토큰으로 검사한다. `usage-summary.json`은 서명 영수증이 아니므로 제외한다. 누락된 증거의 존재,
예산 DB와의 관계·정산·사용량 계약 전체를 증명하지 않는다. 증거가 0건이면
`usage_receipt_signatures_verified=false`를 유지하며 통과했다고 기록하지 않는다.

성공 시 `runtime_keys_verified=true`와 검사 결과·건수만 남긴다. 구버전 Ops에 예산 토큰이
없고 실행기에만 있으면 `ops_budget_configured=false`로 표시하며 API 연결 성공으로 해석하지 않는다.
DB 로그인 옵션까지 성공하면 `database_login_verified=true`와 계정별 검증 결과를 보고한다.
옵션을 생략하면 `database_login_verified=false`다. `core_authentication_verified`,
`full_backup_verified`는 계속 `false`이며 `source_grants_restored=false`로 권한 복원 범위를 명시한다.
키 없는 이전 묶음은 저장소 복원 검사를 계속 지원하지만 `verify --runtime-keys`는 거절한다.
원본 인증 해시가 없는 이전 키 묶음은 키 복원 검사만 지원한다. DB 로그인 검사를 위해서는 쓰기 중지
상태에서 새 묶음을 생성해야 하며, 누락된 원본 해시를 저장된 비밀번호로 만들어 대체하지 않는다.
이 검사도 구버전 갱신 차단을 해제하지 않는다.

무료 회귀는 `test_ops_runtime_keys.py`에서 수행한다. LLMOps CI는 빌드된 Ops 이미지로 실제
Django·WSGI 코드의 암호화 키 복원을 검사한다. 로컬에서는 `OPS_RUNTIME_KEY_TEST_IMAGE`에
기존 Ops 이미지 ID를 명시하면 같은 격리 검사를 실행하며, 개인 Secret을 읽는 검사는 아니다.
`test_ops_database_login.py`는 계정 범위·비밀 stdin 전송·기존 DB 변경 방지·인증 오류 판별을 검사한다.
`test_ops_state_links.py`의 실제 MySQL 8.4 검사는 암호화 묶음의 DB·결과·Prefect 연결에 더해
복원된 root·앱 비밀번호 로그인과 각각의 잘못된 복구 비밀번호 실패를 확인한다. 한글·따옴표·역슬래시가
포함된 합성 비밀번호를 사용하며 원본 DB·계정과 결과 파일이 변하지 않았는지도 대조한다.

### Compose Ops 검토 기록을 새 환경에 재사용

팀원이 사람 검토 자료를 재사용하려면 [Git 초기 데이터 실행 절차](ops-local-review-copy.md)를
사용한다. 새 로컬 DB에는 자동 적재하며 별도 백업·키 전달이나 서버 배포가 필요 없다.
모든 로컬 이력까지 복제해야 할 때는 같은 문서의 선택 사항인 전체 암호화 복원을 사용한다.
아래 기본 복원은 원본 DB를 그대로 검증하는 재해 복구 경로다.

동일한 평가 원본에 대한 사람 검토를 새 DB에서 반복할 필요는 없다.
[ops_snapshot.py](../infrastructure/llmops/ops_snapshot.py)는 **Ops 전체 DB와 /results,
/evaluation-data 파일을 암호화 백업하고 별도의 새 Compose DB·볼륨에 복원**한다.
검토 사유·승인자 FK·버전·시각·품질 판정·비교 기준·예산을 그대로 보존한다.
승인 API를 다시 호출하거나 새로운 답변을 자동 승인하지 않는다.

지원 범위는 **로컬 파일 저장소를 사용하는 Compose Ops + MySQL 8.4**다.
SQL 접속은 컨테이너 내부 `127.0.0.1:3306` TCP를 사용한다. 공식 MySQL 이미지가 초기화할 때
잠시 여는 socket 전용 서버를 준비 완료로 오인하지 않도록 한 것이며 외부 포트를 열지 않는다.
최종 서버가 준비되기 전에는 대상 DB 검사나 복원을 진행하지 않는다.
Python 3.12 이상과 기존 Docker Compose·OpenSSL CLI를 사용하며 새 Python 의존성은 없다.
DB 덤프와 파일은 메모리에서 처리한다. AES-256-CBC/PBKDF2 암호화 뒤 별도 HMAC으로 인증하고
복호화 전에 인증을 검사한다. DB와 파일 각각 128 MiB, 파일 10,000개까지 지원한다.
링크·특수 파일·경로 이탈·파일 해시 불일치는 거절한다.

**백업 준비와 실행**

1. 모든 source writer의 live/RAG live/정기 실행 플래그를 끈다. 진행 중 평가·열린 예약이 없어야 하며
   미중지 정기 계획도 없어야 한다. 다른 직접 DB/파일 쓰기 작업도 유지보수 중에는 중지한다.
2. 저장소 밖에 권한 0700의 백업 폴더를 만든다. 키는 init-key로 한 번 생성한 뒤 별도로 보관한다.
   키를 잃으면 복원할 수 없다. 기존 키·백업 파일은 덮어쓰지 않는다.
3. 아래 명령을 저장소 루트에서 실행한다. 실제 컨테이너 이름과 경로는 대상에 맞춘다.
   --stop-writers는 해당 Compose의 실행 중인 Ops API·sync·runner만 잠시 중지한다.
   성공·실패 모두 원래 실행 중이던 컨테이너를 다시 시작하며 MySQL은 중지하지 않는다.
   백업 중에는 Ops 화면이 일시적으로 연결되지 않을 수 있다.

~~~bash
python3 infrastructure/llmops/ops_snapshot.py init-key \
  --key-file /absolute/private/ops-backups/recovery.key

python3 infrastructure/llmops/ops_snapshot.py backup \
  --ops-container govbiz-llmops-ops-service-1 \
  --mysql-container govbiz-llmops-ops-mysql-1 \
  --key-file /absolute/private/ops-backups/recovery.key \
  --output /absolute/private/ops-backups/reviewed-e01.enc \
  --stop-writers
~~~

기본값은 서비스를 중지하지 않으며 writer가 실행 중이면 실패한다.
이미 중지한 환경에서는 --stop-writers를 생략한다. 백업 전후 DB 덤프와 파일을 비교해
변경이 발견되면 백업을 발행하지 않는다. 프로세스 강제 종료나 Docker 장애는 재시작을
보장할 수 없으므로 source 상태를 확인하고 원래 실행 중이던 서비스만 재시작한다.
BACKED_UP은 암호화 왕복 확인까지이며 **새 환경 복원 검증 완료를 뜻하지 않는다**.

**새 환경 복원과 재실행**

같은 Ops·MySQL 이미지 ID가 대상 Docker에도 있어야 한다. 다른 PC에서는 source 이미지를
docker image save로 보관하고 대상에서 docker image load로 먼저 가져온다. 도구는 변경 가능한
tag로 대체 이미지를 받거나 다른 아키텍처 이미지로 자동 교체하지 않는다.
키·암호화 백업·이 도구를 준비한 뒤 아직 존재하지 않는 대상 폴더를 지정한다.

    python3 infrastructure/llmops/ops_snapshot.py restore \
      --archive /absolute/private/ops-backups/reviewed-e01.enc \
      --key-file /absolute/private/ops-backups/recovery.key \
      --directory /absolute/private/ops-restored-e01

- 별도 Compose 프로젝트·내부 전용 네트워크·MySQL·결과/평가 자료 볼륨을 만든다.
  기존 DB를 지정하는 옵션은 없다. 빈 대상에만 복원하고 DB 덤프 및 파일 내용·해시·권한·소유자를 비교한다.
- 동일 백업·동일 폴더로 재실행하면 데이터를 쓰지 않고 검증 후 ALREADY_RESTORED를 반환한다.
  대상 데이터 변경, 다른 백업, 중간 실패의 폴더는 덮어쓰지 않는다. 별도 새 폴더로 재시도하고
  실패 프로젝트는 확인 후 정리한다. 중간 실패를 자동 삭제하거나 부분 덮어쓰기로 이어가지 않는다.
  검증 후 복원 MySQL을 중지했다면 해당 복원 폴더의 compose.json으로
  `docker compose -f /absolute/private/ops-restored-e01/compose.json up -d ops-mysql`을 실행하고
  DB가 준비된 뒤 같은 restore 명령을 다시 실행한다. 이때 API는 시작하지 않는다.
- 복원한 compose.json에는 새 DB 자격증명과 기존 사용량 영수증 검증 키가 들어 있어
  폴더 0700·파일 0600으로 보관한다. 키·백업·복원 폴더는 Git에 넣지 않는다.
- **Ops API·sync·runner는 자동 시작하지 않는다.** 유료/정기 실행은 false이며 Core·Prefect·
  Langfuse 주소는 연결할 수 없는 기본값이다. MySQL event scheduler도 OFF이며 모델을 호출하지 않는다.
- Core 계정 DB/인증 영역도 보존하거나 같은 계정임을 확인해야 한다. core:42 같은 숫자 ID가
  새 Core DB에서 다른 사람에게 배정될 수 있으므로 이메일만 보고 기존 감사 주체를 바꾸지 않는다.
  검증한 Core 연결과 네트워크 설정을 적용한 뒤 수동으로 API를 연다. 생성된 API는 manual-api
  profile, 기본 포트 127.0.0.1:18002이며 실제 로그인 연결은 별도 단계다.
- Prefect·Langfuse 자체 DB/실행·trace 기록, Core DB, HTTP artifact store, Kubernetes PVC는
  이 도구의 백업 범위가 아니다. 해당 이력까지 옮기려면 위 전체 백업 절차를 함께 수행한다.
- 원본과 복원본 양쪽에서 유료 실행을 켜면 예산 장부가 갈라진다. 운영 전환 때는 하나의 장부만
  활성화한다. 과거 승인은 보존되지만 정책·자료·모델 변경 후 새 결과의 승인을 대신하지 않는다.

무료 검증은 아래 두 명령이다. 첫 명령은 암호화·경로·재실행 경계 검사다. 둘째는 **도구가 만든
가상 데이터**의 실제 MySQL 8.4 복원과 Django ORM 읽기이며 기존 환경을 선택하지 않는다.
둘째 명령은 --ops-image 옵션으로 로컬 이미지를 지정할 수 있고 생략하면 checkout에서 빌드한다.
두 검증은 ops-ci.yml에 연결되어 있다. 실제 E01 백업/복원·관리자 브라우저 연결 검증과 구분한다.
2026-10-04에 실제 검토된 E01의 암호화 백업·격리 복원·SELECT 전용 조회·반복 복원 검증을
완료했다. 범위와 남은 인증 연결은 [후속 개발 기록](llmops-next-development-plan.md)에 정리했다.

    python3 -B -m unittest discover -s infrastructure/llmops -p test_ops_snapshot.py
    python3 -B infrastructure/llmops/check_ops_snapshot.py

### CI에서 수행하는 Ops 전체 DB 복원 검증

`smoke_ops_bridge.py --evaluate`의 복원 검증은 먼저 일회용 Kubernetes Ops DB 전체를 덤프하고,
외부 네트워크·공개 포트·공유 볼륨이 없는 별도 MySQL 8.4 컨테이너에 복원한다.
개인 state나 일반 클러스터를 대상으로 호출하면 거부한다. CI가 생성한 환경에서만 접수를 중지하고
미완료 작업 검사를 통과한 뒤 API·sync Pod 종료를 확인한다. 이 클러스터는 훈련 후 정리한다.

- 실제 무료 평가 이력에 한글·이모지·따옴표·JSON·NULL·검토/예산 감사 fixture를 추가한다.
- 전체 테이블별 행 수, migration 건수, 스키마·행을 포함한 정렬된 덤프를 원본과 대조한다.
- 배포한 Ops 이미지의 로컬 ID를 고정하고 별도 UID/GID 10001 조회 컨테이너를 실행한다.
  이 컨테이너는 외부 연결이 없는 복원 MySQL의 네트워크 공간만 공유하며 원본 DB·볼륨에 연결하지 않는다.
  파일시스템은 읽기 전용이며 capability를 제거하고 새 DB 조회 계정과 임시 Django 키만 사용한다.
- 복원 DB에만 `SELECT, LOCK TABLES` 권한을 가진 계정을 생성한다. 실제 권한과 UPDATE 거절을 확인한 뒤,
  Django test client로 실제 readiness URL의 migration·컬럼 검사를 실행한다. migration은 적용하지 않는다.
- 원본 실행 release 해시와 완료 평가 3건의 요청/flow ID·실행 명세 해시를 비교하고,
  실제 `run_data`와 DRF JSON renderer로 응답 생성·날짜 직렬화를 확인한다.
  한글·JSON·NULL fixture와 사용자·검토·예산 관계도 ORM으로 확인한다.
  검사 후 전체 덤프를 다시 대조해 애플리케이션이 schema·행을 바꾸지 않았음을 확인한다.
- 검증된 복원 DB는 결과 볼륨의 Ops HTTP 검사까지 유지한다. 이 시점에는
  `restored_database_ready=true`이며 DB 전체 검증의 `status`는 정리가 끝날 때까지 `FAIL`이다.
  HTTP 검사가 끝난 뒤 덤프를 다시 대조하며, 중간 실패에도 복원 DB를 정리한다.
- 복원 DB의 잘못된 외래 키 참조가 거절되는지와 데이터 변조가 감지되는지 확인한다.
- 마지막에 원본 덤프가 그대로인지 확인하고 생성한 복원 컨테이너만 삭제한다.
  가져오기·비교·컨테이너 정리 중 하나라도 실패하면 성공으로 기록하지 않는다.

덤프 옵션은 [MySQL 8.4 mysqldump 문서](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html)를
기준으로 `--single-transaction`, `--hex-blob`, `--order-by-primary`와 routine/event/trigger 포함을 사용한다.
원본·복원 서버의 MySQL 버전이 다르면 중단하며 복원 서버의 event scheduler는 비활성화한다.
SQL 원문은 메모리에서만 전달하고 CI artifact에는 건수·SHA-256·검증 결과만 보존한다.

보고서의 `database_restore.scope=disposable_ops_mysql_application_read`와 `status=PASS`는
이 CI DB 복원·애플리케이션 조회 훈련만 뜻한다. `application`에 이미지 ID·readiness·응답 생성·
권한 거절·DB 무변경·컨테이너 정리 결과를 남긴다. readiness는 프로세스 내부의 test client로 호출하며
HTTP 서버·Core 관리자 인증·관리자 화면을 검증한 것으로 기록하지 않는다.
`backup_verified`, `personal_environment_verified`, `artifacts_restored`, `prefect_restored`는 모두 `false`다.
개인 환경 전체 백업·파일/Prefect 복원·키 복구·구버전 전환 검증은 별도로 수행해야 한다.

### CI에서 수행하는 Kubernetes 브라우저 로그인 검증

`smoke_ops_bridge.py --evaluate`는 최초 무료 고정 답변 평가와 RAG 재평가가 완료된 뒤,
자신이 시작한 Vite portfolio 서버와 Core/Ops port-forward를 유지한 상태에서
`ops_browser_login.mjs`를 실행한다. 로그인은 응답 재생이나 쿠키 주입 없이 실제 폼으로 수행한다.

- 새 브라우저에서 Ops 진입 → 로그인 화면 이동 → 이메일/비밀번호 입력 → Core 로그인 POST를 수행한다.
- 서버가 발급한 HttpOnly·SameSite=Lax 쿠키, Core 관리자 ID와 Ops 사용자 ID의 일치,
  페이지 새로고침 후 세션 유지 및 기존 완료 평가 2건의 상세·실행 예산 표시를 확인한다.
- 평가 목록은 25건 단위로 최대 1,000건까지 전체 페이지를 확인한다. API 건수·다음 페이지 경로·중복·누락과
  화면의 행·다음 버튼을 대조하고, 예상 평가가 있는 페이지까지 화면으로 이동한 뒤 상세 링크를 연다.
  중간에 전체 건수가 바뀌거나 목록이 불완전하면 실패한다. API가 제공한 외부 URL을 따라가지 않는다.
- 브라우저가 실제 Ops 보고서를 GET한 본문 해시를 사전에 검증한 보고서 해시와 대조한다.
  이 검사 자체는 보고서 차트 렌더링 검증이 아니다.
- RAG 상세에서는 `검토 자료 보기`를 눌러 `/rag-reviews`를 실제 조회한다. 고정 입력 해시와 전체
  사례 목록을 실행 명세와 대조하고, 모든 사례의 후보·비교 답변, 펼친 원문·청크와 자료 해시를 확인한다.
  검토 자료 API의 오류·빈 자료·웹 계약 위반은 실패이며, 검토 저장·품질 합격·기준 지정은 수행하지 않는다.
- 화면의 로그아웃 버튼으로 Core 204·쿠키 제거를 확인하고, 같은 브라우저의 Core 관리자 세션·Ops 전체
  목록 페이지·대상 상세·실행 예산·보고서·RAG 검토 자료 재요청이 401인지 확인한다. 이어서 이 검사에서 서버가 발급한
  쿠키만 메모리에서 다시 적용하고 같은 요청이 모두 401인지 확인해 서버의 세션 폐기도 검증한다.
  재사용 검사 후에는 쿠키를 지우며, 값은 파일·로그·증거에 남기지 않는다.
- 로그인·로그아웃 외 쓰기와 외부 origin 요청은 차단한다. 평가 재접수·검토 저장·유료 호출은 하지 않는다.
  기존 두 평가의 DB 식별자·상태·실행 명세·모델 호출 수가 검사 전후 같아야 한다.
- 중간 실패에도 발급된 검사 세션을 로그아웃하고 브라우저를 종료한다. 실패/정리 오류를 성공으로 바꾸지 않는다.

CI가 생성한 일회용 비밀번호는 Python에서 Node의 표준입력으로 직접 전달하며 명령행 인자·파일·로그·
증거에 남기지 않는다. CLI 오류도 입력값이 포함될 수 있는 브라우저 진단 대신 고정 오류 코드만 출력한다.
개인 Kubernetes Secret을 추출하는 절차가 아니며 개인 계정의 세션이나 기존 브라우저를 재사용하지 않는다.

`ops-bridge.json`의 최상위 `browser_login`에 `response_source=core_ops_http`, 브라우저 버전,
로그인·ID 연결·새로고침·전체 목록/페이지 수·상세/보고서 건수·로그아웃 이후 접근 거절·종료 결과를 기록한다.
`pagination_complete=true`와 `revoked_session_rejected=true`가 모두 있어야 성공으로 인정하며,
Python 호출부에서도 목록 건수와 페이지 수의 정합성 및 결과 타입을 검사한다.
이는 복원 전 일회용 Kubernetes의 실제 연결 증거다. 아래의 복원 서버 로그인 및 응답 재생 검사와
구분하며 개인 환경의 백업·복구를 증명하지 않는다.

로컬 무료 회귀는 실제 React/Vite/Chrome과 임시 HTTP 인증 대역을 사용한다.
쿠키 누락·다른 Core 사용자 연결·로그아웃 이후 보고서 노출·폐기된 쿠키의 재사용 허용을 실패로 처리한다.
26건/2페이지 자료로 페이지 이동과 상세 조회를 검증하고, 중복·누락·건수 변경·외부 페이지 링크를 거절한다.
Python에서 누락되거나 재생 방식으로 잘못 기록된 증거를 거절한다.
이 회귀 통과만으로 실제 Kubernetes 연결 성공을 보고하지 않는다.

```bash
RESTORE_BROWSER_CHANNEL=chrome node --test infrastructure/gitops/scripts/test_ops_browser_login.mjs
```

### CI에서 수행하는 복원 서버 브라우저 로그인 검증

복원된 Core·Ops·결과 HTTP 서버가 실행 중일 때 `ops_restore_live_browser.mjs`가 새 브라우저를 연다.
로그인 폼 → 실제 Core 세션 발급 → Ops 목록 전체 페이지 → 복원 평가 3건의 상세·보고서 해시 →
로그아웃 → 익명 및 폐기된 쿠키의 401을 같은 브라우저 검사로 확인한다. 응답을 재생하지 않는다.

복원 DB는 `--network none`을 유지하고 공개 포트도 추가하지 않는다. CI가 소유한 Vite의
`http://127.0.0.1:5173` 요청을 Docker attach 표준입출력 통로로 전달하며, 컨테이너 안에서
실제 loopback Core/Ops HTTP를 호출한다. 5173 포트가 이미 사용 중이면 다른 서버를 재사용하지 않고 실패한다.
Core는 이 Vite Origin만 허용하며, Ops Host는 같은 Origin의 호스트로 전달해 페이지 링크를 보존한다.

- 통로는 Core 관리자 세션 조회·로그인·로그아웃과 앞서 검증한 Ops 조회 경로만 허용한다.
- 외부 주소·임의 포트·Ops 쓰기·다른 Origin·헤더 개행·과도한 요청/응답은 거절한다.
- HTTP 상태, Set-Cookie, 보고서 보안 헤더와 본문 바이트를 전달한다. 비밀번호·쿠키·HTML은
  프로세스 메모리/파이프로만 다루며 CI 증거에 포함하지 않는다.
- 브라우저 종료 후 기존 세션 폐기·결과 서버 장애 검사와 파일 무변경 검사를 계속 수행한다.
  이후 Ops 전체 덤프 대조도 유지한다. Core 사본의 테스트 세션 쓰기만 허용된다.
- 임시 Vite·통로 서버·캐시·보조 프로세스의 정리 및 정상 종료가 확인돼야 성공한다.
  전송 중단·잘못된 메시지·실패 종료를 정상 응답으로 처리하지 않는다.

`volume_restore.results.ops_http.browser_login`의 `response_source=restored_core_ops_http`,
`transport=docker_attached_stdio`로 범위를 표시한다. 이는 일회용 복원 서버의 인증·조회 경로이며
개인 Kubernetes, 운영 Ingress/TLS, 기존 서명 키·세션 연속성 또는 전체 백업 복구 성공의 증거는 아니다.
보고서 차트/샌드박스 렌더링은 기존 응답 재생 검사에서 별도로 수행한다.

로컬은 실제 React/Vite/Chrome·임시 HTTP 인증 서버·별도 통신 프로세스로 연결과 실패 정리를 확인한다.
Docker·MySQL·복원 Core/Ops 이미지의 통합 검증은 CI에서 수행한다.
잠긴 Evidently 버전으로 생성한 무료 합성 보고서의 브라우저 렌더링 검사도 CI에 포함한다.
복원 화면 실패는 `BRIDGE_RESTORE_WEB_*`, 실제 연결 실패는 `BRIDGE_RESTORE_LIVE_<단계>`로
기록한다. 원문·쿠키를 공개하지 않고 `ops-bridge.json`의 `probe_errors`에서 실패 단계를 확인한다.
실제 연결 단계는 `HELPER_CORE_LOGIN`, `HELPER_MANAGEMENT`, `BROWSER_PASSWORD_LOGIN`, `BROWSER_DETAIL`,
`BROWSER_RAG_MATERIAL`, `BROWSER_LOGOUT`, `EXIT`, `CLEANUP` 등 고정된 값만 허용한다. helper의 알 수 없는 단계나
잘못된 JSON 뒤에 정상 프레임이 도착해도 전송 실패를 취소하지 않는다.

긴 Kubernetes 검사 전에 기존 CI에서 빌드한 Ops 이미지로 Docker attach 회귀를 실행한다.
별도 `--network none`·읽기 전용 컨테이너의 Python HTTP 테스트 서버에 새 브라우저로 연결해
실제 요청 검증기, 쿠키 발급·폐기, 응답 전달과 컨테이너 정리를 확인한다.
`RESTORE_DOCKER_IMAGE`를 지정한 `test_ops_browser_login.mjs`가 이 검사를 수행하며 CI는 이미지가
없으면 실패한다. 이 빠른 검사는 MySQL·실제 Core/Ops 복원 통합 검증을 대체하지 않는다.

복원 서버는 결과 볼륨 외에 카탈로그가 지정한 fixture·저장 캡처 JSON도 필요하다.
`verify()`는 현재 checkout에서 허용 목록의 파일만 임시 디렉터리에 복사하고 `/evidence`에
읽기 전용으로 연결한다. 복원 이미지의 `execution_release.json`에 고정된 해시와 모두 일치해야
HTTP 검증을 시작한다. 자료 누락·변경은 중단 사유이며, Ops가 원본 checkout을 직접 읽거나
HTTP 실패 시 로컬 파일로 대체하지 않는다. 검사 후 결과 파일과 입력 자료의 무변경 및 정리를 확인한다.
이는 버전 관리되는 평가 입력을 다시 제공하는 절차이며, 해당 디렉터리를 결과 볼륨에서 복원했다고
해석하면 안 된다. 다른 릴리스의 이미지에는 그 이미지와 일치하는 입력 자료가 필요하다.

`skn-164`·`4456327`의 복원 경로는 Artifact 서버의 `LLMOPS_EVIDENCE_DIR`도 빈 디렉터리로
지정했다. 따라서 보고서 HTTP 200·SHA 검증과 로그인은 성공해도 `/review`는 HTTP 200 안에
`material=null`, `material_error`, `quality.blocked_reason`을 반환했고 상세 화면에 오류가 표시됐다.
격리 MySQL 8.4·실제 Core/Ops·저장 캡처로 생성한 Evidently 보고서로 이 실패를 재현했다.
같은 입력을 Artifact 서버에 연결하면 상세·보고서 렌더링·로그아웃·세션 폐기 검증이 통과했다.
HTTP 검사도 검토 자료·fixture 해시·전체 사례 목록과 품질 판정 준비 상태를 확인하여 이 결함을
브라우저 실행 전 차단한다. 사람 검토나 품질 합격을 요구하거나 자동 승인하는 검사는 아니다.
이 로컬 재현은 고정 근거 답변 자료와 기존 로컬 Core 이미지로 수행했으며, 최신 이미지의 전체
Kubernetes·RAG·Prefect 복원 검증 완료는 수정 커밋의 CI 결과로 판단한다.

### CI에서 수행하는 결과·Prefect 볼륨 복원 검증

복원 DB의 조회 검증을 통과하고 Ops API·sync Pod가 종료된 상태에서 같은 시험 프로젝트의 실행기·결과 서버·
Prefect를 중지한다. 컨테이너 ID·이미지·Compose 소유권·볼륨 사용자와 정상 종료를 확인하며,
다른 컨테이너가 볼륨을 사용하면 중단한다. 개인 환경의 컨테이너는 중지 대상으로 허용하지 않는다.
실행기는 종료 중 Prefect API로 deployment를 정리하므로 실행기 → 결과 서버 → Prefect 순서로 종료한다.
각 서비스의 정상 종료를 확인한 뒤 다음 서비스를 중지하고, 종료 코드·OOM 여부를
`volume_restore.source_shutdown`에 남긴다. 비정상 종료는 계속 복원 중단 조건이다.

- `ops-results`와 `prefect-data`를 각각 읽기 전용 원본으로 연결하고 새 임시 볼륨에 복원한다.
  파일 복사는 Python 표준 라이브러리를 사용하며 도우미에는 네트워크·공개 포트가 없다.
  결과 볼륨은 기존 결과 서버 이미지, Prefect 볼륨은 기존 Prefect의 정확한 이미지 ID를 사용한다.
- 정지된 원본 전체를 임시 tar로 묶어 복원하고 파일 SHA-256·경로·크기·권한·UID/GID·수정 시각을
  대조한다. 기존 대상 덮어쓰기, 심볼릭/하드 링크, 특수 파일·권한을 거절한다.
  볼륨당 64 MiB·10,000개 항목을 넘으면 실패하며 개인 데이터용 범용 백업 도구로 사용하지 않는다.
- 최초 고정 근거 평가 1건과 교체 전후 RAG 평가 2건의 인증 보고서 SHA-256을 복원 파일과 대조한다.
- 파일 복원 후 같은 결과 서버 이미지의 별도 컨테이너를 UID/GID 10001로 시작한다. 복원 사본만
  읽기 전용으로 연결하고 원본 볼륨·기존 환경변수·DB/모델 자격 증명은 전달하지 않는다.
  모든 capability를 제거하고 네트워크·호스트 포트를 차단한다.
- 이 컨테이너의 Gunicorn 결과 서버는 내부 `127.0.0.1:8010`에서만 실행하며 매번 새 검사 토큰을 쓴다.
  인증된 상태 조회와 3건의 보고서 GET·SHA-256, 무인증/잘못된 토큰의 401, POST/PUT/DELETE의
  405를 검증한다. 응답 크기·캐시 금지 헤더를 검사하며 프록시·redirect는 허용하지 않는다.
  파일 읽기 권한 오류·기동 시간 초과·비정상 종료·검사 중 파일 변경·도우미 정리 실패는 전체 실패다.
- 이어서 복원 DB의 격리된 네트워크 공간에 별도 Ops HTTP 검사 컨테이너를 연결한다.
  같은 Ops 이미지·UID/GID 10001·조회/잠금 계정을 사용하고, 복원 결과 볼륨만 읽기 전용으로 연결한다.
  외부 통신·호스트 포트·원본 볼륨 연결은 없으며 기존 모델/API 자격 증명을 전달하지 않는다.
- 실제 Gunicorn Ops API와 결과 서버를 내부 loopback에서 실행한다. `Ops HTTP → 복원 MySQL 조회 →
  결과 서버 HTTP → 복원 보고서` 경로로 완료 평가 3건의 SHA-256·캐시 금지·CSP를 확인한다.
  Ops의 로컬 결과 경로는 빈 디렉터리로 두므로 HTTP 저장소를 실제로 거쳐야 성공한다.
- 같은 시험 클러스터의 Core Pod도 종료하고 Core DB 전체를 격리 MySQL의 별도 `govbiz_core` DB로
  복사한다. 가져오기 직후 덤프를 대조한 다음 배포에 사용한 실제 Core 이미지로 실행한다.
  Core에는 이 DB에만 쓰기 가능한 별도 계정을 주며, Ops는 계속 `govbiz_ops`의 조회/잠금 계정만 쓴다.
  Core의 자동 migration·외부 동기화·문서 생성 작업은 끄고 새 JWT 서명 키를 사용한다.
- `Core 비밀번호 로그인 → 실제 세션 쿠키 → Ops CoreSessionAuthentication → Core 관리자 확인 →
  복원 보고서 조회`를 수행한다. Core가 확인한 관리자 ID·이메일·역할이 복원 Ops 요청자와 같아야 한다.
  무인증·잘못된 쿠키는 401, 개발 로그인으로 만든 일반 회원의 실제 세션은 403이어야 한다.
  `auth_contract=restored_core_password_login`, `core_admin_auth_verified=true`로 기록한다.
- 관리자 화면이 사용하는 세션·전체 실행 목록·완료 3건의 상세·예산 조회를 실제 HTTP로 호출한다.
  목록의 전체 건수를 복원 DB와 대조하고, 페이지 누락·중복·외부 페이지 링크를 거절한다.
  완료 실행의 ID·flow·실행 명세·상태·보고서 경로와 목록/상세 응답의 일치를 검사한다.
  모든 조회 경로에서 잘못된 쿠키·일반 회원을 차단하고 공개 세션 응답에는 계정·자료가 없어야 한다.
- 예산 GET은 장부의 일관된 조회를 위해 `SELECT ... FOR UPDATE`를 사용한다.
  [MySQL 잠금 조회 권한](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)에 따라
  복원 DB에만 `LOCK TABLES`를 허용하고 INSERT·UPDATE·DELETE 권한은 부여하지 않는다.
  실제 예산 행 잠금 성공과 접수/예산 테이블의 UPDATE 거절을 확인하며,
  `database_restore.application.read_only_grants`와 `budget_lock_verified`로 기록한다.
- DB 관계 검증용 추가 실행은 등록된 자료·캡처 ID를 가진 취소 이력으로 만든다. 검증용 사용자 이름으로
  이 행을 식별하며 한글·JSON·NULL·리뷰·예산 관계 검사는 유지한다. 등록되지 않은 자료 ID를 넣어
  실제 목록 조회를 실패시키거나, 검사를 위해 복원 DB에서 해당 행을 삭제하지 않는다.
  연결된 예산 예약도 양수 호출 한도를 가진 미사용·종료 예약으로 구성해 웹의 예산 계약을 지키며,
  실제 호출 수와 사용량은 0으로 유지한다.
- 수집한 응답에서 CSRF 토큰을 제거한 사본을 임시 파일로 전달하고, 저장소의 Node 24로
  `check_ops_restore_ui.mjs`를 실행한다. 웹의 실제 `getOpsSession`, `listEvaluations`, `getEvaluation`,
  예산 조회 함수와 Zod 파서가 응답을 처리해야 통과한다. 의존성은 기존 루트 잠금 파일로 관리한다.
  `ops_restore_proxy.mjs`가 기존 `vite.config.ts`의 portfolio 모드로 실제 Vite를 시작하고,
  두 loopback HTTP 서버로 Core 경로와 수집한 Ops 응답을 재생한다. 개인 5173 포트나 기존 전달을
  재사용하지 않고 OS가 할당한 임시 포트만 사용한다. Core 응답은 경로 분리 확인용 검증 데이터다.
  `/api`·`/api/v1/ops`의 분리, Ops Host·Origin·검사용 쿠키 전달, 401/403·no-store 보존을 확인한다.
  모든 수집 JSON 응답이 실제 프록시를 거쳐 기존 웹 API 함수에서 파싱되어야 한다.
  고정 답변 평가의 상세 화면이 자동 조회하는 검토 자료도 수집해 권한·no-store·웹 파서를 확인한다.
  RAG 평가의 `/rag-reviews`도 같은 권한 검사로 수집하고 `getRagReviews`의 실제 파서로 처리한다.
  복원 HTTP 검사는 fixture·후보·비교 캡처 해시와 사례 목록이 실행 명세와 일치하는지 확인하고,
  검토 자료 본문에서 SHA-256을 다시 계산한다. HTTP 200만으로 누락·변조된 자료를 통과시키지 않는다.
  Ops 재생 서버를 종료하면 웹 API 함수가 502 오류를 반환하고 Core 경로는 유지되어야 한다.
  이어서 테스트 전용 `playwright-core`로 별도 headless 브라우저·새 컨텍스트를 만든다.
  실제 `/ops/evaluations`의 JS·React·CSS를 로드하고 관리자 표시, 전체 이력의 페이지 이동·행 수·요청 ID,
  예산 영역의 조회 완료를 확인한다. 복원 대상 3건은 목록 링크를 클릭해 상세 화면의 요청 ID·명세 ID와
  실행 예산 장부도 확인한다. 고정 답변 평가의 검토 자료가 로드되고 화면 오류가 없어야 한다.
  RAG 상세의 지연 조회 버튼도 눌러 모든 사례를 선택하고 원문·청크를 펼친다. 자료가 조회되기 전의
  빈 패널이나 보고서 표시만으로 RAG 복원 화면 검증을 통과시키지 않는다.
  상세 화면의 Evidently 보고서 링크는 `noopener noreferrer`가 있는 새 탭으로 열려야 한다.
  복원 HTTP에서 수집한 HTML 원문·Content-Type·Cache-Control·CSP를 그대로 재생하고,
  브라우저가 받은 본문의 SHA-256을 복원 기대값과 대조한다. 본문 표시와 새 탭의 opener 차단,
  sandbox에 의한 쿠키·localStorage 접근 거절을 확인한다. 개별 차트·지표의 의미나 시각 품질 판정은 아니다.
  일반 회원 검사용 쿠키로 다시 열면 403 안내가 나오고 이력·보고서 링크가 없어야 한다.
  같은 브라우저에서 보고서 경로를 GET해 3건 모두 403·no-store이며 HTML이 노출되지 않는지도 확인한다.
  브라우저는 이 Vite origin의 GET만 허용하며 다른 주소·쓰기 요청·예상하지 않은 JS 오류는 실패다.
  브라우저의 동일 출처 GET은 Origin이 없을 수 있으므로 Sec-Fetch-Site도 확인한다. 기존 HTTP 검사의
  명시적 Origin이 유실된 경우를 브라우저 GET으로 잘못 통과시키지는 않는다.
  검사용 HttpOnly 쿠키를 주입하므로 실제 Core 로그인·세션 발급·브라우저 로그인 흐름 검증은 아니다.
  이 프록시의 백엔드는 복원 서버 자체가 아닌 수집 응답 재생 서버이며 기존 클러스터에는 연결하지 않는다.
  접수·검토 저장·기준 지정 버튼은 조작하지 않는다. 실제 API 인증·보고서 검사는 앞 단계와 구분한다.
  JSON·보고서 HTML 원문·쿠키·브라우저 프로필은 최종 증거에 저장하지 않는다. 임시 브라우저·응답 파일·Vite 캐시·
  서버를 정리하고 fetch와 K8S 환경변수를 복원한다. 렌더링·파서·라우팅·장애 검사·정리 실패는 전체 실패다.
- 실제 Core 로그아웃 후 같은 세션으로 보고서를 요청하면 401이어야 한다. 다시 비밀번호로 로그인한 뒤
  결과 서버를 종료하면 보고서 요청은 404여야 한다. 종료 실패·결과 파일 변경·Ops DB 덤프 변경은
  전체 실패다. Core 사본에는 로그인·로그아웃에 따른 세션 쓰기를 허용하고 원본 Core 덤프는 보존한다.
  검사 토큰·로그인 비밀번호·DB 비밀번호·서명 키는 보고서에 넣지 않는다.
- 결과 파일 보존 확인과 별도로 Prefect 저장소를 검사한다.
  Prefect SQLite의 무결성·외래 키·migration과 해당 3건의 deployment·완료 상태 이력·request/flow ID를 확인한다.
  진행 중 실행이나 활성 스케줄이 있으면 성공 처리하지 않는다.
- SQLite의 `prefect.db`뿐 아니라 남아 있는 WAL·SHM도 함께 복사한다.
  [SQLite WAL 문서](https://www.sqlite.org/wal.html)에 따라 WAL의 커밋 데이터를 놓치지 않도록
  `immutable=1` 없이 복원 사본을 읽기 전용으로 조회한다. 실제 WAL을 가진 SQLite 회귀 테스트를 유지한다.
- 복원된 Prefect DB를 같은 이미지의 API 서버로 열어 3건의 실행·deployment·완료 상태 이력을 GET으로
  다시 조회한다. `--no-services`로 기동하고 스케줄러·자동 migration·블록 자동 등록·분석 전송을 끈다.
  실행기를 시작하지 않으며, 기존 profile·자격 증명·외부 DB/API 주소를 상속하지 않는다.
- API는 네트워크 없는 컨테이너 내부의 `127.0.0.1:4200`에서만 사용한다. 기동 실패·시간 초과·
  이력 불일치·비정상 종료는 실패다. 종료 후 논리 덤프 해시를 대조해 schema·행이 바뀌지 않았는지 확인한다.
- 검사 전후 원본 보존을 확인하고 이번에 만든 도우미와 복원 볼륨만 삭제한다.
  실패·정리 오류는 전체 실패로 남기며 정지한 시험 프로젝트는 최상위 정리 단계에서 제거한다.

`ops-bridge.json`의 `volume_restore.scope=disposable_ops_report_http_and_prefect_api`와 `status=PASS`는
이 파일·Ops/결과 HTTP·SQLite·Prefect API 검증의 성공만 뜻한다. `results`와 `prefect`에 대조 건수·해시·정리 결과를,
`results.api`에 인증·쓰기 거절·파일 무변경·일반 사용자 실행·정상 종료 결과를,
`results.ops_http`에 실제 Core 인증·세션 폐기·Ops 보고서·결과 서버 장애 거절·파일/Ops DB 무변경 결과를,
`prefect.api`에 API 대조·DB 무변경·정상 종료 결과를 남긴다.
별도 `core_auth_restore`에는 Core 이미지 ID·복사 직후 덤프 일치·원본 보존·정리 결과를 남긴다.
`results.ops_http.management_http`에는 관리 API의 세션·목록·상세·예산·권한 검사 결과를,
`management_web_contract`에는 웹 소비자 파서 통과 결과를 기록한다.
그 아래 `proxy_http`는 `mode=portfolio`, `response_source=captured_restore_http`와 실제 프록시·HTML
전달·장애·정리 결과를 기록하며 자체 `browser_rendered=false`를 유지한다.
별도 `browser_ui`는 실제 브라우저 버전·목록 건수·페이지 수·예산·권한 화면·정리 결과,
`details_verified`, `report_documents_verified`, `report_sandbox_verified`, `report_denials_verified`와
`browser_rendered=true`를 기록한다. 이 증거가 있어야 `management_web_contract.browser_rendered=true`가 된다.
로컬 브라우저 회귀 테스트는 합성 목록 26건과 상세·보고서 3건을 사용한다. 보고서는 스크립트로 본문을
표시하는 검증용 HTML이며 실제 Evidently 차트의 검증으로 보고하지 않는다. 변조된 HTML·누락 보고서·
약화된 CSP·캐시 허용·추가 쿠키 헤더는 성공 처리하지 않는다.
무료 프록시·브라우저 회귀 테스트는 LLMOps CI에서 잠금 의존성 및 대응 Chromium headless shell 설치 후
필수 실행한다. Kubernetes 복원 단계에서는 실제 복원 HTTP에서 수집한 응답으로 다시 수행한다.
로컬은 설치된 Chrome/Edge를 명시해 다운로드 없이 확인할 수 있다. 다음은 Bash/WSL 명령이며,
Windows PowerShell에서는 `$env:RESTORE_BROWSER_CHANNEL = 'chrome'`을 설정한 뒤 Node 명령을 실행하고 해제한다.

```bash
node --experimental-transform-types --test infrastructure/gitops/scripts/test_ops_restore_proxy.mjs
RESTORE_BROWSER_CHANNEL=chrome node --experimental-transform-types --test infrastructure/gitops/scripts/test_ops_restore_browser.mjs
```

브라우저가 없는 CI/Linux 환경은 먼저 다음 명령으로 잠금 버전에 대응하는 Chromium만 설치한다.
`RESTORE_BROWSER_CHANNEL`을 생략하면 이 브라우저를 사용하며, 명시한 채널이 없을 때 자동 대체하지 않는다.

```bash
pnpm --dir frontend/web exec playwright-core install --with-deps --only-shell chromium
```

성공 시 `results_server_started=true`, `prefect_server_started=true`이며,
증거가 완성되지 않은 실패에서는 `null`로 미확인을 표시한다.
검사 토큰을 새로 생성하므로 기존 Secret/서명 키 복구는 검증하지 않는다.
실행기 재개·새 평가 실행·실제 Core 로그인부터 복원 서버까지의 브라우저 연결·Langfuse 저장소 복원은 별도다.
Core 인증 검증은 새 키로 발급한 세션만 대상으로 하며 기존 세션의 연속성이나 기존 서명 키 복구를 뜻하지 않는다.
`backup_verified`, `personal_environment_verified`는 계속 `false`다.
개인 환경 갱신 승인이나 전체 저장소의 동일 시점 백업 증거로 사용하지 않는다.
CI에 연결된 코드가 있어도 최신 SHA의 실제 통합 작업이 이 단계까지 통과해야 실행 완료로 기록한다.

선행 `skn-140 / f718ea0`의 필수 CI 5개와
[LLMOps 실제 서버 검사](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/37031288852)는 통과했다.
그 실행의 증거는 DB 27개 테이블·166개 행, 결과 보고서 3건과 Prefect API 복원을 포함하며,
이번에 추가한 복원 결과 서버 HTTP 검사는 포함하지 않는다. 새 변경 SHA에서 별도로 검증한다.

## 3. 같은 소스에서 빌드하고 갱신

기존 연결을 조사할 때는 `fork_cluster.py status --json --ops-details --state-dir "$OPS_STATE_DIR"`로
Pod 상태와 Compose 컨테이너·브리지 상태를 함께 확인한다. Prefect·실행기가 중지돼 있으면 Pod Ready만으로
갱신 준비가 됐다고 판단하지 않는다. 이 조회는 접수 중지·백업·업무 검증을 대신하지 않는다.

기존 [dc_bridge 함수](../infrastructure/gitops/docs/ops-runtime.md#로컬-kind와-compose의-전용-통신-경로)를
실제 프로젝트·state 경로로 정의한다. 병합된 Compose 설정은 검사기에 전달하며 화면이나 보고서에 덤프하지 않는다.
새 이미지는 이전 이미지와 다른 태그를 사용하고 이전 이미지 ID와 설정을 보존한다.

```bash
OPS_SOURCE_SHA=$(git rev-parse HEAD)
OPS_TARGET_IMAGE="govbiz-ops-service:sha-$OPS_SOURCE_SHA"
docker build --tag "$OPS_TARGET_IMAGE" backend/ops-service
dc_bridge config --format json | python3 infrastructure/llmops/check_artifact_compose.py
dc_bridge build evaluation-runner ops-artifacts
```

접수·스케줄 중지와 백업 검증이 끝난 뒤 진행한다. API·sync는 Kubernetes 소속이므로 Compose의
같은 이름 서비스를 새로 올리지 않는다. Prefect 자체 저장소 migration이 필요한 업그레이드는
별도로 검토한다. 보류·실패 평가가 자동 재실행되지 않는지도 확인한다.

```bash
LLMOPS_LIVE_ENABLED=false OPENAI_API_KEY= dc_bridge up -d --no-deps prefect ops-artifacts evaluation-runner
python3 -B infrastructure/gitops/scripts/ops_bridge.py connect \
  --state-dir "$OPS_STATE_DIR" --compose-project "$OPS_COMPOSE_PROJECT"
python3 -B infrastructure/gitops/scripts/ops_runtime.py \
  --state-dir "$OPS_STATE_DIR" --artifact-env "$OPS_ARTIFACT_ENV" \
  --ops-image "$OPS_TARGET_IMAGE"
```

활성화는 기존 DB/Secret 참조를 보존하고 `migrate_deployment`로 최신 전진 migration을 적용한 뒤
API·sync를 함께 교체한다. `0015` 등 과거 번호에서 임의로 멈추지 않는다. MySQL DDL은 일부 적용 후
실패할 수 있으므로 migration 오류를 DB 무변경으로 해석하지 않는다.

## 4. 성공과 실패의 기록

활성화는 첫 Secret/DB/workload 변경 전에 state의 `ops-updates/<UUID>.json`을 생성한다.
이전/대상 이미지, immutable ID, release 해시와 각 단계의 시작·완료를 원자적으로 기록한다.
재시도는 새 파일을 만들고 이전 실패 기록을 보존한다. 키나 subprocess 오류 원문은 기록하지 않는다.
갱신 사전 점검을 통과한 경우 그 시각·건수·검사 한계를 `upgradePreflight`에 함께 보존한다.

| 마지막 기록 | 의미와 다음 조치 |
|---|---|
| `RUNNING`/`FAILED`, migration 시작 | 적용 결과 불확실. Job·migration 이력·실제 schema 확인. 자동 역방향 migration 금지 |
| migration 완료, workload 적용 시작 | DB는 전진했음. apply 응답 유실이면 실제 Deployment/Pod부터 확인 |
| workload 완료, rollout/진단 실패 | 새 workload가 적용됐을 수 있음. API/sync 이미지·로그·브리지·결과 연결 확인 |
| baseline/activation 기록 실패 | 실행 환경과 로컬 기록이 다를 수 있음. 실제 객체와 기록을 대조하고 동일 대상 재시도 |
| `ACTIVATED` | migration·rollout·기본 진단·기록 완료. 아래 업무 검증은 별도 |

`RUNNING`은 성공이 아니다. 강제 종료로 실패 상태를 쓰지 못해도 시작 기록이 남는다.
기록을 쓸 수 없으면 다음 변경을 진행하지 않는다. 실패 Job은 조사 후 명시적으로 처리하며
성공 기록을 만들기 위해 Job·장부를 무작정 지우지 않는다.

**이미지 rollback**은 전진 schema와 호환되는 이전 API/sync·실행기·결과 서버를 함께 선택하는 것이다.
이전 앱 실행만으로 DB가 과거로 돌아가지는 않는다. 호환성 근거가 없으면 forward fix를 검토한다.
**DB 복원**은 보존 시점 이후 쓰기를 잃을 수 있는 별도 작업이다. 쓰기 중지·복원 범위·결과/Prefect의
동일 시점·새 저장소 복원 검증·전환 승인을 따로 확보한다. 도구는 둘 다 자동 실행하지 않는다.

`0020` 접수 제어를 모르는 이전 이미지로 rollback하면 DB에 남은 pause를 읽지 못한다.
이때는 외부 접수 통제를 계속 유지해야 한다. 이전 앱이 실행된다는 이유로 접수 차단이나
새 schema 호환성을 확인했다고 판단하지 않는다.

## 5. 업무 검증 후 접수 재개

1. `ops_runtime.py --check --run-id "$OPS_EXISTING_RUN_ID"`에 기존 `--state-dir`를 지정해
   API·sync·runner·artifact 소스 일치, 실제 schema, 기존 결과를 확인한다.
   다른 결과 해시·평가·검토·장부도 백업 기준과 대조한다.
2. 외부 접수 통제를 유지한 채 `evaluation_admission status`로 현재 버전을 확인한다.
   새 재개 UUID와 현재 버전·변경자·사유로 `evaluation_admission resume`을 실행해 검증 담당자만
   새 무료 평가를 접수한다. 기존 Core 관리자로 로그인해 새 저장 응답 재평가를 하나 접수하고, 목록만 관찰해 sync의
   완료 반영을 확인하고 보고서·비교·모델 호출 0회와 request/flow ID를 기록한다.
3. 일반 사용자 거절·관리자 세션·CSRF·로그아웃을 확인한다. 개발 로그인이나 새 관리자 생성으로
   기존 인증 검증을 대신하지 않는다. 재시작 후 같은 보고서·이력·장부가 유지돼야 한다.
4. 모든 증거를 기록한 뒤 외부 접수 통제를 해제한다. 검증 실패 시 새 UUID와 현재 버전으로
   다시 pause하고 실패 원인을 조사한다. 실패·미실행 단계가 있으면 갱신 완료로 보고하지 않는다.

전체 무료 통합 회귀는 별도 `smoke_ops_bridge.py --evaluate` 명령으로 수행할 수 있다.
[전체 명령과 전제](../infrastructure/gitops/docs/ops-runtime.md)를 따르며, 새 임시 환경의 성공을
기존 개인 환경의 보존·복원 훈련으로 대체하지 않는다.

이후 순서는 Compose→Kubernetes 예산 HTTP 대역 왕복, 실제 전체 백업·복원 훈련, GHCR 동일 SHA/digest,
별도 배포 브랜치 없는 Argo A→B→A 검증, 관리 화면 상태 표시, 외부 공개 전 접근·통신 보호다.

### 개인 환경 백업·격리 복원 실행 기록 — 2026-10-05

`skn-203 / 51fe273` 도구로 사용자 승인 후 개인 Kubernetes와 연결된 Compose의 실제 백업을 수행했다.
이 기록은 해당 시점의 Ops 저장소 복원 증거이며, 전체 시스템 복구나 개인 환경 갱신 완료를 뜻하지 않는다.

| 확인 범위 | 실제 결과 |
|---|---|
| 중지·재개 | Kubernetes Ops API/sync와 실행 중인 Compose 실행기·Prefect만 중지 후 재개. 기존 중지 컨테이너는 그대로 유지 |
| DB 암호화 백업 | 실제 MySQL의 23개 테이블·126개 행 캡처 |
| 상태 묶음 | 같은 중지 상태의 DB·결과 파일·Prefect SQLite·실행 키 5개를 암호화 |
| 격리 DB 복원 | 원본과 동일한 MySQL digest의 새 임시 DB에서 덤프·행 수 대조 통과 |
| 완료 평가 연결 | 기존 완료 평가 2건과 결과 파일·Prefect 실행 이력 일치 |
| 파일 복원 | 결과 파일 18개·Prefect 파일 4개의 내용·권한, SQLite 무결성 확인 |
| 키·DB 로그인 | Django 서명·결과 서버 WSGI 인증, 원본 인증 해시를 사용한 root/앱 로그인 및 잘못된 비밀번호 거절 확인 |
| 격리 갱신 | `0017_input_token_budget → 0028_daily_evaluation_schedules`, migration 11개 적용 및 기존 23개 테이블·126개 행의 원래 값 보존 |
| 갱신 반복 | 반복 migration·같은 UUID의 접수 중지 요청 유지, 신규 접수 차단 및 과거 토큰 상한 NULL 보존 확인 |
| 원본 상태 | `0017`·평가 2건 유지. Deployment spec·DB 식별자·Compose 이미지와 원래 실행 상태 보존, 브리지 검사 통과 |
| HTTP 연결 | 웹 `localhost:5173`, Core/Ops health, Ops readiness 200. Vite 경유 비인증 Ops 관리 API 401 |
| 정리·비용 | 격리 검증 컨테이너 정리 완료. 모델 API 호출 0회 |

백업은 개인 WSL의 저장소 밖 `0700` 디렉터리에서 보관한다. 암호화 파일·키·보고서는 `0600`이다.
실행 묶음 ID는 `20261005T095835Z`이며 `maintenance.json`, `restore-verification.json`,
`upgrade-verification.json`, `source-after.json`에 캡처·복원·갱신·원본 재확인 결과를 남겼다.
키와 원본 데이터는 Git에 넣지 않는다.

- DB 암호화 파일 SHA-256: `211b4ea00d5e710783281e57048e942901d0b9e3a4dd0a2f2d452e7d0ad16fbe`
- 상태 묶음 SHA-256: `34bba453e471d662ceef7ef4a0c4e2d73252fb20b5ecf65851025a89e43e7044`

서명된 사용량 증거는 0건이므로 그 서명의 실제 표본 검증은 미실시다. 앱 계정의 원본 권한은
복원하지 않고 격리 DB 조회 권한으로만 확인했다. Core 인증 DB·기존 로그인 세션·전체 Langfuse
저장소 복원, 복원된 앱의 관리자 브라우저 로그인과 새 평가 실행은 이번 검증 범위 밖이다.
`full_backup_verified=false`, `application_started=false`는 유지한다. 원본 서비스 재개와
격리 복원 앱 기동 검증을 혼동하지 않는다.

**최초 migration과 접수 중지를 유지한 런타임 전환 도구를 구현했다. 실제 개인 환경 적용은 남아 있다.**
실제 전환 시에는 당시의 쓰기 중지 상태와
새 백업을 다시 확보하고, 최신 대상 소스·이미지·필수 CI 및 실패 복구 절차를 확인해야 한다.
그 뒤 원본 migration과 API/sync·실행기·결과 서버 전환 범위를 별도로 승인받는다.
이번에는 원본 migration이나 이미지 교체를 하지 않았으므로 `admission_control_unsupported`
차단은 그대로다. 백업 성공을 이유로 기존 활성화 검사를 우회하지 않는다.

### 동일 소스 이미지 준비와 최신 코드의 격리 전환 검증 — 2026-10-06

`4b238ac1f1a9886fa99830b1eda04a3185c83d51`의 Git 추적 파일만 아카이브해 Ops와 평가 실행기
이미지를 빌드했다. 로컬 환경 파일·작업 파일을 빌드 입력에 포함하지 않았다.
검증 도구도 같은 커밋의 소스 아카이브에서 실행해 Windows checkout의 줄바꿈과 분리했다.
이 소스 아카이브는 리허설용이며, 실제 최초 전환에는 선택한 원격 SHA와 일치하는 깨끗한
Git checkout과 해당 SHA의 필수 CI 성공을 다시 요구한다.

| 대상 | 준비한 이미지 |
|---|---|
| Ops API·sync·결과 서버 | `govbiz-ops-service:msa-4b238ac-20261006` |
| 평가 실행기 | `govbiz-evaluation-runner:msa-4b238ac-20261006` |

- Ops immutable ID: `sha256:df3662b9248abf78a776329630b318f92c5c0f33d573ded1043a1bc49aa3c40a`
- 실행기 immutable ID: `sha256:28a9d142bf79d20491ccace4b0cb42051f422253583ea2020c3018e9c39da2bd`
- 두 이미지의 실행 명세 SHA-256: `a032c956b0266b5bdf5dc48f4868bf67c8023924f57fe7a655c684b424e20a6c`

`ops_initial_runtime.image_release`로 네트워크가 없는 일회용 컨테이너에서 Ops 소스 지문과
실행기의 execution release 파일 검증을 수행했다. 두 이미지의 non-root 실행 계정과
동일한 실행 명세를 확인했으며 기존 컨테이너는 교체하지 않았다.

같은 Ops 이미지로 `ops_db_upgrade.rehearse`를 실행했다. 2026-10-05의 `database.enc`를
새 격리 MySQL에 복원했으며, 이 과거 백업을 현재 원본 DB 변경의 입력으로 사용하지 않았다.

| 검사 | 결과 |
|---|---|
| 스키마 전환 | `0017_input_token_budget → 0028_daily_evaluation_schedules`, migration 11개 적용 |
| 기존 데이터 | 23개 테이블·126개 행의 원래 값 보존 |
| 접수 제어 | 접수 중지와 신규 접수 거절 확인 |
| 반복 실행 | 같은 migration·중지 요청의 반복 실행 및 기존 토큰 상한 NULL 보존 확인 |
| 정리 | 검증 컨테이너 정리 완료, `status: REHEARSED` |
| 원본 재확인 | 개인 Kubernetes Ops DB는 `0017` 유지 |
| 전환 계획 | 현재 실행 대상의 중지·재개 순서 조회 `PLANNED`, 실제 중지·재개 없음 |
| 비용·적용 | 모델 호출 0회, 원본 migration·서비스 교체·GHCR 업로드 없음 |

Git 제외 경로 `work/ops-transition-4b238ac/`에 `prepared-images.json`,
`runtime-image-verification.json`, `upgrade-rehearsal.json`, `maintenance-plan.json`,
`source-archive.json`, `source-comparison.json`을 남겼다. 암호화 백업과 키는 기존 개인 경로에
유지하며 이 기록이나 Git에 포함하지 않았다.

검증 중 기본 브랜치가 모바일 변경을 포함한 `62a61a09af32b8cd6c58e9afd445b5d81b43fb35`로
진행했다. Ops·AI·평가 코드·LLMOps·GitOps·발행 도구의 여섯 Git tree가 빌드 시점과 같은 것을
확인했다. 이는 같은 실행 입력의 재사용 근거이며 **새 기본 브랜치의 CI 성공이나 배포 승인으로
대체하지 않는다.** `latest_ci_verified=false`, `deployment_authorized=false`를 기록했다.

이번 결과는 로컬 전환 이미지와 격리 migration의 검증이다. 최신 공개 GHCR receipt 발급,
원본 DB 최초 전환, 관리자 인증·새 평가 실행, Argo 동기화는 완료하지 않았다.
실제 전환 전에는 대상 SHA의 필수 CI·이미지를 재확인하고, 승인된 쓰기 중지 시점의 새 상태
백업과 복원 검증을 확보한 뒤 원본 migration·런타임 교체를 수행한다.
