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
이전 deployment를 포함한 미완료 실행·현재 deployment의 활성 스케줄을 검사한다.
중지된 deployment에 활성 스케줄이 남아 있어도 차단한다. 자동 취소·정산·환급은 하지 않는다.

- `PASS`: 접수 제어 지원·중지 상태·양의 정수 버전을 확인했고 검사한 범위에서 남은 작업 없음.
- `BLOCKED`: 접수 제어 미지원, 접수 중지 전 또는 남은 작업 존재. 사유에 맞게 조치한 뒤 재검사한다.
- `UNKNOWN`: DB/Prefect 조회 실패, 불완전 응답, 점검 중 변경 등으로 확인 불가. 장애를 해결한 뒤 재검사.
  기존 이력을 보존하며 한 flow의 이력이 2,000개 이상이면 전체 검사 범위를 확장·검증하기 전까지 중단한다.
- 보고서는 `schemaVersion=3`이다. `PASS`에는 `admission_supported=true`, `admission_blocked=true`,
  `admission_version>=1`과 `checks.open_admission=0`이 필요하며 활성화 도구도 이를 검증한다.
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
- 복원 DB에만 `SELECT` 권한을 가진 계정을 생성한다. 실제 권한과 UPDATE 거절을 확인한 뒤,
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
  같은 Ops 이미지·UID/GID 10001·SELECT 계정을 사용하고, 복원 결과 볼륨만 읽기 전용으로 연결한다.
  외부 통신·호스트 포트·원본 볼륨 연결은 없으며 기존 모델/API 자격 증명을 전달하지 않는다.
- 실제 Gunicorn Ops API와 결과 서버를 내부 loopback에서 실행한다. `Ops HTTP → 복원 MySQL 조회 →
  결과 서버 HTTP → 복원 보고서` 경로로 완료 평가 3건의 SHA-256·캐시 금지·CSP를 확인한다.
  Ops의 로컬 결과 경로는 빈 디렉터리로 두므로 HTTP 저장소를 실제로 거쳐야 성공한다.
- Core의 세션 응답만 로컬 테스트 서버로 재현하며 실제 `CoreSessionAuthentication`은 그대로 사용한다.
  복원 DB에 있는 요청자의 계정 ID·이메일과 새 검사 쿠키를 사용하고, 무인증·잘못된 쿠키의 401 및
  일반 사용자 응답의 403을 확인한다. `auth_contract=synthetic_core_session`으로 기록하며
  실제 Core 로그인·비밀번호·세션 저장소 복원을 검증한 것으로 표시하지 않는다.
- 결과 서버 종료 후 보고서 요청이 404, 테스트 인증 서버 종료 후 503으로 실패하는지 확인한다.
  종료 실패·결과 파일 변경·DB 덤프 변경은 전체 실패다. 검사 토큰·DB 비밀번호는 보고서에 넣지 않는다.
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
`results.ops_http`에 Ops 보고서·테스트 세션 계약·장애 거절·파일/DB 무변경 결과를,
`prefect.api`에 API 대조·DB 무변경·정상 종료 결과를 남긴다.
성공 시 `results_server_started=true`, `prefect_server_started=true`이며,
증거가 완성되지 않은 실패에서는 `null`로 미확인을 표시한다.
검사 토큰을 새로 생성하므로 기존 Secret/서명 키 복구는 검증하지 않는다.
실행기 재개·새 평가 실행·실제 Core 관리자 로그인·관리자 화면·Langfuse 저장소 복원은 별도다.
`backup_verified`, `personal_environment_verified`는 계속 `false`다.
개인 환경 갱신 승인이나 전체 저장소의 동일 시점 백업 증거로 사용하지 않는다.
CI에 연결된 코드가 있어도 최신 SHA의 실제 통합 작업이 이 단계까지 통과해야 실행 완료로 기록한다.

선행 `skn-140 / f718ea0`의 필수 CI 5개와
[LLMOps 실제 서버 검사](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/37031288852)는 통과했다.
그 실행의 증거는 DB 27개 테이블·166개 행, 결과 보고서 3건과 Prefect API 복원을 포함하며,
이번에 추가한 복원 결과 서버 HTTP 검사는 포함하지 않는다. 새 변경 SHA에서 별도로 검증한다.

## 3. 같은 소스에서 빌드하고 갱신

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
이번 클라우드에는 개인 PC 연결 정보가 없으므로 실제 갱신·migration·백업·복원·새 평가를 실행하지 않았다.
