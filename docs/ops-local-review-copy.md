# 팀원 로컬 Compose에서 검토 기록 재사용

## 기본 사용: Git에서 받아 자동 초기화

배포 서버나 별도 백업·복호화 키 없이 **같은 저장소의 공유 검토 데이터를 사용**한다.
이 기능이 포함된 커밋을 받고 [기존 프로젝트 환경 설정](ops-monorepo-migration.md#로컬-개발-시작)을
준비한 뒤, 평소처럼 저장소 루트에서 Compose를 실행한다. 별도 Ops 시작·자료 적재 명령은 필요 없다.

```bash
git pull
docker compose --env-file .env.compose up -d --build
```

루트 Compose에 포함된 `ops-bootstrap`이 MySQL 준비를 기다려 빈 DB에 migration과 공유 검토
데이터를 적재한다. 이 작업이 성공해야 Ops API가 시작된다. 초기화 과정에서 모델을 호출하거나
유료 평가를 활성화하지 않는다. **자신의 Core 관리자 계정**으로
`http://localhost:5173/login`에 로그인하면 `/ops/evaluations`에서 저장된 기록을 확인할 수 있다.
Compose 안의 웹은 `http://ops-service:8000`으로 자동 연결된다.

```text
Git의 공유 검토 데이터 + 공개 원문·답변
    → 기존 docker compose up → MySQL 준비 → ops-bootstrap 최초 적재
    → Ops API 시작 (결과 볼륨 읽기 전용)
    → Core 관리자 로그인 → React /ops/evaluations
```

검토 DB와 보고서는 각각 `ops-mysql-data`, `ops-results` 볼륨에 보존한다.
루트 Compose의 기존 앱 실행 설정은 유지한다. Langfuse·Prefect·평가 실행기는 이 초기화의
필수 서비스가 아니며, 저장된 검토·보고서 조회에 별도 설치가 필요하지 않다.

### 기존 LLMOps 분리 환경을 사용하는 경우

이미 `infrastructure/llmops`의 별도 환경을 쓰고 있다면 `pnpm dev:ops`도 계속 사용할 수 있다.
이 명령은 없는 로컬 비밀 설정 파일만 생성하고, 기존처럼 Ops를 18001 포트에 시작한다.
루트 Compose 환경으로 기존 DB를 자동 이동하지 않는다. 두 환경은 서로 다른 DB·결과 볼륨이다.
호스트에서 `pnpm dev:web`을 실행하는 경우 웹의 `OPS_DEV_PROXY_TARGET`을 사용하는 Ops 포트에
맞춘다. 루트 Compose는 Ops `.env`의 `API_PORT`(예시 8001), 분리 환경은 18001이다.

### Git에 공유하는 범위

- [초기 데이터](../backend/ops-service/apps/evaluations/seed/official-v3/seed.json):
  `official-answer-20260907-v3`의 이전·신규 실행 2건, H01~H06 사례 판단·사유 총 12건,
  실행 검토 승인 2건, 자료 검토 이력 2건, 품질 판정 이력 3건, 현재 비교 기준과 변경 이력 2건.
- 현재 기준은 `gpt-6-luna`의 새 답변 실행 `628ae52a-f417-4b53-b400-d90405e6a7d8`이며 기준 버전은 2다.
  이전 기준 `ec068da7-8d59-46fb-a8e4-2ab42dc39efe`도 함께 보존한다. 원래 검토 시각과
  정책·입력 해시, 레코드 ID, 평가 결과·Evidently 보고서, 새 답변과 당시 비교 답변 파일을 유지한다.
- 검토자 개인정보는 `공유 검토 기록 · 원본 검토자 A`로 대체한다. 이 표시는 비활성·로그인 불가
  기록용 사용자다. 팀원의 Core 계정 번호가 같아도 원래 검토를 팀원이 한 것으로 바뀌지 않는다.
- 계정 비밀번호·이메일·세션·API 키·예산 및 결제 관련 비밀값은 공유하지 않는다.
  팀원의 환경별 비밀값은 로컬에서 새로 생성한다.
- 이전 GPT-5.6-luna 답변과 **2026-10-05에 생성한 GPT-6-luna 답변에 대해 사람이 직접 저장한
  검토의 사본**이다. 신규 실행의 H01~H06 적합·전체 승인·품질 합격·기준 지정 기록을 포함한다.
  고정 근거 6건의 승인 범위이며 검색·첨부파일·전체 RAG 품질 승인을 뜻하지 않는다.
- 새 실행은 원래의 `live` 방식과 생성 6회 기록을 유지한다. **복원 시에는 생성 호출 0회**이며
  완료 실행·검토·파일만 적재한다. 예산·예약·정산 장부는 공유하지 않으므로 사본의 장부를
  원본 지출 기록으로 사용하지 않는다. Prefect·Langfuse 자체 이력도 이 초기 데이터에 포함하지 않는다.
- 두 실행의 파일은 실행 ID별로 구분하고 해시를 검증한다. 원래의 정책·자료와 맞지 않으면
  초기화가 실패하며 새로운 승인이나 합격 판정을 만들지 않는다.

### 기존 데이터와 재시작

이미 실행·검토·예산 등 Ops 데이터가 있는 DB는 `EXISTING_DATA_PRESERVED`로 건너뛴다.
팀원이 추가한 기록이나 철회한 기준을 덮어쓰지 않는다. 같은 환경을 재시작할 때도
같은 Compose 명령을 사용한다. 기존 DB의 스키마가 오래된 경우에는
[업그레이드 절차](ops-upgrade-runbook.md)에 따라 migration을 먼저 적용해야 한다.

각 PC의 **새 검토는 로컬에만 저장**된다. Git은 실시간 DB 동기화가 아니다.
추가로 공유할 검토는 개인정보·비밀값을 제외한 새 초기 데이터로 명시적으로 검토·커밋해야 한다.
변경된 seed를 pull해도 이미 사용 중인 DB에 자동 합치거나 승인을 되살리지 않는다.
`down -v`나 Docker 데이터 삭제로 초기 데이터 이후의 로컬 기록까지 보존되는 것은 아니므로,
그 기록은 아래 전체 백업 기능으로 별도 보관할 수 있다.

### 검증

`apps.evaluations.test_local_review_seed`는 실제 MySQL에서 원본 검토·해시·시각 보존,
이전 기준과 신규 기준의 연결, 실제 생성 횟수 보존, 재실행 중복 방지, 철회 유지, 계정 구분,
누락·변조 파일 거절과 실패 rollback을 확인한다. Ops CI는 추가로
`python3 infrastructure/llmops/check_local_review_seed.py`를 실행해 새 Compose의 첫 실행을
검증한다. 테스트는 임시 프로젝트만 만들고 정리하며 모델 API를 호출하지 않는다.
루트 Compose 경로는 `infrastructure/scripts/check-compose.py --smoke`가 별도 초기화 명령 없이
시작·준비 확인·공유 검토 조회·기준 철회 후 재시작 보존을 검증한다. 로컬의 해당 동작만 확인할 때는
`--bootstrap-only`를 함께 사용하며, CI는 이 옵션 없이 전체 MySQL 테스트도 수행한다.

## 선택 사항: 전체 환경의 암호화 백업·복원

아래 기능은 전체 기록을 정확히 복제하는 복구 수단이다. **위 Git 초기 데이터를 사용하는
팀원에게는 필요하지 않다.** 전체 DB에는 계정 식별자·비밀값이 있으므로 이 백업과 키는
Git에 올리지 않는다. 최초 공유 자료 이후의 로컬 기록도 보존해야 할 때 사용한다.
복원은 전달 시점의 독립 사본이며 기존 DB와 합치거나 덮어쓰지 않는다.

### 전체 백업을 보내는 사람

1. [백업 절차](ops-upgrade-runbook.md#compose-ops-검토-기록을-새-환경에-재사용)에 따라
   최신 `snapshot.enc`와 별도 `recovery.key`를 만든다. 진행 중 평가와 활성 일정이 없어야 한다.
2. 이 기능이 포함된 checkout에서 이미지를 빌드하고 전달 폴더를 만든다.
   경로는 예시이며 저장소 밖의 접근 제한된 경로를 사용한다.

```bash
docker build -t govbiz-ops-local-copy:reviewed backend/ops-service

python3 infrastructure/llmops/ops_snapshot_share.py pack \
  --archive /absolute/private/snapshot.enc \
  --key-file /absolute/private/recovery.key \
  --ops-image govbiz-ops-local-copy:reviewed \
  --directory /absolute/private/team-review-package
```

폴더에는 `snapshot.enc`, `images.tar`, `package.enc` 세 파일만 들어간다.
검토 데이터는 암호화되며 `package.enc`는 이미지·백업 해시를 인증한다. 이미지에는 애플리케이션
코드가 들어 있고 암호화하지 않는다. **키는 묶음에 포함하지 않는다.** 팀원에게 묶음과 키를
별도 경로로 전달한다. 이 도구는 외부 업로드나 메시지 전송을 수행하지 않는다.

백업에는 계정 식별자·이메일·감사 이력·사용량 영수증 검증 키도 포함된다.
허용된 팀원에게만 전달하고 백업/키를 Git에 커밋하지 않는다. 원본 PC 장애에도 보존하려면
묶음과 키를 각각 다른 안전한 저장장치 또는 허용된 저장소에 복사해야 한다.

### 전체 백업을 받는 사람

준비물: 같은 기능을 포함한 checkout, Python 3.12+, Docker Compose, OpenSSL,
본인의 로컬 Core와 관리자 계정, React 개발 환경. Windows는 WSL에서 실행한다.
묶음에 고정된 이미지 플랫폼이 PC와 다르면 Docker의 해당 플랫폼 실행 지원이 필요하다.
도구가 다른 아키텍처의 이미지를 임의로 대체하지 않는다.

```bash
chmod 600 /absolute/private/recovery.key

python3 infrastructure/llmops/ops_snapshot_share.py restore-local \
  --package /absolute/private/team-review-package \
  --key-file /absolute/private/recovery.key \
  --directory /absolute/private/team-ops-copy \
  --core-port 8080 \
  --ops-port 18002
```

`RESTORED`는 새 DB·파일의 원본 일치와 migration 정합성 검사 통과를 뜻한다.
기존 로컬 DB는 바꾸지 않는다. 다른 Core DB의 같은 숫자 계정 ID가 기존 검토자로 연결되지
않도록 복원본마다 새 `CORE_ACCOUNT_NAMESPACE`를 만든다. 과거 검토자의 사용자 행·이메일·FK는
변경하지 않으며 팀원의 첫 로그인은 별도의 사용자 행을 만든다. 생성된 namespace는 바꾸지 않는다.
기존 Core 관리자 확인과 CSRF 검증은 그대로 적용된다.

복원 후 API를 시작한다. API 포트는 자신의 PC `127.0.0.1`에만 열린다.
MySQL은 포트를 공개하지 않는다. Linux에서도 API의 `host.docker.internal`은 host gateway로 연결된다.

```bash
docker compose -f /absolute/private/team-ops-copy/compose.json \
  --profile manual-api up -d ops-service
```

`frontend/web/.env.local`에 아래 값을 설정하고 개발 서버를 재시작한다.
Core가 다른 포트라면 복원 명령의 `--core-port`와 함께 맞춘다.

```dotenv
VITE_DEV_PROXY_TARGET=http://127.0.0.1:8080
OPS_DEV_PROXY_TARGET=http://127.0.0.1:18002
```

`http://localhost:5173/login`에서 **자신의 로컬 관리자 계정**으로 로그인하고
`/ops/evaluations`에서 이전 실행·검토 사유·비교 기준·보고서를 확인한다.
일반 회원은 계속 접근할 수 없다. 새로 검토를 저장하면 해당 사본에만 기록된다.

### 전체 백업의 보존과 범위

- 재시작은 같은 `compose.json`으로 `up -d`한다. DB와 파일은 Docker 볼륨에 남는다.
  `down`만으로 데이터는 지워지지 않지만 **`down -v`, volume prune, Docker 데이터 초기화**는
  데이터를 지울 수 있다. 전달받은 암호화 묶음과 키는 볼륨과 별도로 보관한다.
- 복원 명령을 반복하면 원본 일치를 확인한다. 이미 로그인하거나 추가 검토한 DB는 달라졌으므로
  반복 복원이 거절된다. 사본의 새 기록을 지우지 않기 위한 동작이다. 재시작 때 복원하지 않는다.
- 이번 구성은 **기존 평가와 검토 기록의 조회·검토 재사용**을 위한 로컬 복사본이다.
  Prefect·Langfuse 자체 DB는 포함하지 않으며 해당 외부 화면 링크가 그대로 연결되지는 않는다.
  Ops에 저장된 보고서와 점수·검토 기록은 보존한다.
- API·sync·runner를 자동 시작하거나 유료 평가·정기 실행을 활성화하지 않는다.
  신규 평가 파이프라인 전체를 실행하려면 별도 로컬 Prefect·runner 및 결과 볼륨 연결이 필요하다.
  복제된 예산 장부를 공동 지출 한도로 사용하지 않는다.
- 복원한 승인 기록은 **그 원문과 답변**의 검토 이력이다. 새 모델 답변을 검토한 것으로
  바꾸지 않는다. 복원 과정에서 검토·승인 API를 다시 호출하지 않는다.

무료 검증:

```bash
python3 -B -m unittest discover -s infrastructure/llmops -p 'test_ops_snapshot*.py'
python3 -B infrastructure/llmops/check_ops_snapshot.py --ops-image govbiz-ops-local-copy:reviewed
```

첫 명령은 암호화·변조·경로·복원 경계를, 두 번째는 별도 가상 데이터와 MySQL 8.4로
원본/복원본 일치 및 같은 Core 계정 번호를 가진 팀원의 로그인 후 검토자 보존을 검증한다.
두 경로는 Ops CI에서도 실행한다.
