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
- 갱신 중 신규 접수를 막는 운영 통제를 정한다. 현재 전용 maintenance API는 없다.
  다른 접수자나 자동 접수가 남아 있으면 갱신을 시작하지 않는다.

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

- `PASS`: 검사한 범위에서 남은 작업 없음. `BLOCKED`: 남은 작업을 기존 처리 절차로 종료 후 재검사.
- `UNKNOWN`: DB/Prefect 조회 실패, 불완전 응답, 점검 중 변경 등으로 확인 불가. 장애를 해결한 뒤 재검사.
  기존 이력을 보존하며 한 flow의 이력이 2,000개 이상이면 전체 검사 범위를 확장·검증하기 전까지 중단한다.
- 점검은 분산 잠금이나 접수 중지 기능이 아니다. `admission_blocked=false`, `backup_verified=false`이며
  다른 flow·다른 접수 경로·자동화는 운영자가 별도로 중지해야 한다. `PASS`를 재사용 가능한 승인서로 쓰지 않는다.

기존 연결을 갱신할 때 활성화 도구가 이 검사를 다시 실행하며, `PASS`가 아니면 Secret·migration·workload
변경 전에 중단한다. 연결 기록이 없어도 현재 Ops에 Prefect URL이 설정돼 있으면 검사한다.
Prefect가 비활성인 최초 bootstrap은 이 검사 대상이 아니며 journal의 `upgradePreflight`가 `null`이다.

## 2. 일관된 백업과 복원 가능성 확인

진행 중 작업이 없고 신규 접수가 차단된 상태에서 쓰기 프로세스를 중지한다.
중지 대상과 기존 replicas/Compose 실행 상태를 기록하고 다른 프로젝트를 중지하지 않는다.
DB와 파일을 서로 다른 시점에 복사한 뒤 일관된 백업이라고 판단하지 않는다.

| 대상 | 보존·대조할 내용 |
|---|---|
| Kubernetes Ops MySQL | 전체 schema·행·migration 이력, 평가/요청/flow 식별자, 검토·기준·예산 장부·감사 연결 |
| Compose 결과 볼륨 | 원본 입력·캡처·보고서·해시·서명 증거·경로 권한; 쓰기 중 복사 금지 |
| Prefect 저장소 | 정지 상태의 실제 저장 backend, deployment·run 이력·스케줄; 결과 볼륨과 별개 |
| Langfuse 관련 저장소 | trace·점수를 복구 범위에 포함하면 PostgreSQL·ClickHouse·객체 저장소도 함께 포함 |
| 실행 설정 | state/baseline, Compose 파일·프로필, 이미지 ID, Secret·서명 키의 안전한 복구 수단 |

백업은 저장소 밖의 접근 제한·암호화된 보관소에 둔다. 원문·키·덤프를 Git이나 일반 보고서에 넣지 않는다.
백업 파일 존재만으로 다음 단계로 넘어가지 않는다. **새 MySQL 8.4·새 결과 볼륨·격리된 Prefect**에
복원해 테이블·행·참조·파일 SHA-256을 대조한다. 복원 환경의 outbound와 스케줄을 제한해 기존 작업을
재전송하지 않는다. 키 누락·원본 파일 누락·장부 불일치는 중단 조건이다.
원본 DB 위에 복원하거나 기존 볼륨을 삭제하는 명령은 이 절차에 포함하지 않는다.

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

## 5. 업무 검증 후 접수 재개

1. `ops_runtime.py --check --run-id "$OPS_EXISTING_RUN_ID"`에 기존 `--state-dir`를 지정해
   API·sync·runner·artifact 소스 일치, 실제 schema, 기존 결과를 확인한다.
   다른 결과 해시·평가·검토·장부도 백업 기준과 대조한다.
2. 기존 Core 관리자로 로그인해 새 저장 응답 재평가를 하나 접수한다. 목록만 관찰해 sync의
   완료 반영을 확인하고 보고서·비교·모델 호출 0회와 request/flow ID를 기록한다.
3. 일반 사용자 거절·관리자 세션·CSRF·로그아웃을 확인한다. 개발 로그인이나 새 관리자 생성으로
   기존 인증 검증을 대신하지 않는다. 재시작 후 같은 보고서·이력·장부가 유지돼야 한다.
4. 모든 증거를 기록한 뒤 접수를 재개한다. 실패·미실행 단계가 있으면 갱신 완료로 보고하지 않는다.

전체 무료 통합 회귀는 별도 `smoke_ops_bridge.py --evaluate` 명령으로 수행할 수 있다.
[전체 명령과 전제](../infrastructure/gitops/docs/ops-runtime.md)를 따르며, 새 임시 환경의 성공을
기존 개인 환경의 보존·복원 훈련으로 대체하지 않는다.

이후 순서는 Compose→Kubernetes 예산 HTTP 대역 왕복, 실제 전체 백업·복원 훈련, GHCR 동일 SHA/digest,
별도 배포 브랜치 없는 Argo A→B→A 검증, 관리 화면 상태 표시, 외부 공개 전 접근·통신 보호다.
이번 클라우드에는 개인 PC 연결 정보가 없으므로 실제 갱신·migration·백업·복원·새 평가를 실행하지 않았다.
