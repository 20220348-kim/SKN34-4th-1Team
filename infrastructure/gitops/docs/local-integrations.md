# 개인 Kubernetes의 실제 외부 연동

기본 `up`은 무료·격리 시연 설정입니다. 실제 기능은 이 문서의 **명시적 연동 프로필**로 연결합니다.
팀원마다 자기 키와 클러스터를 사용하며, 공용 GitHub 저장소·GHCR 이미지에 키를 넣지 않습니다.

## 연결 경로

- 웹 `127.0.0.1:5173` → Vite `/api` → loopback port-forward → Core.
- Core → RabbitMQ(`rabbitmq:5672`, `govbiz` vhost) → 기존 작업별 소비자.
- Core → AI → OpenAI. 문서·도구 내부 토큰은 기존 Core/AI Secret의 같은 값을 유지합니다.
- Catalog → 외부 공고 API → Elasticsearch + AI 임베딩/Qdrant → Catalog MySQL → Core snapshot projection.
- Core → STARTTLS SMTP → 사용자가 요청한 가입·비밀번호 재설정 메일.
- OAuth 활성화 시 브라우저 → Google/카카오 → 같은 웹 origin의 `/api/v1/auth/oauth/{provider}/callback`.

RabbitMQ는 단일 StatefulSet과 1Gi PVC, 생성한 임의 암호, 클러스터 내부 AMQP/관리 포트로 실행합니다.
PVC와 암호를 재사용하며 기존 DB/JWT/내부 토큰은 회전하지 않습니다. 고가용성 구성은 아닙니다.
반복 CLI 실행의 자원 소모와 잘못된 재시작을 피하려고 AMQP TCP startup/readiness 검사를 사용하고
liveness 검사는 두지 않습니다. 프로세스 종료 시 재시작 정책은 유지합니다.
이는 [RabbitMQ의 Kubernetes 상태 검사 권장 방식](https://www.rabbitmq.com/docs/monitoring#health-checks-as-readiness-probes)을 따릅니다.
TCP 준비 상태는 애플리케이션 메시지 처리 성공을 대신하지 않습니다.

## 키 전달과 적용

도구는 `.env`를 shell로 실행하지 않고 정해진 키만 읽습니다. 기존 Compose `.env` 전체를 복사하지 않습니다.
입력 파일은 소유자만 읽을 수 있는 `0600`을 권장하며 Git 제외 경로에 보관합니다. 채팅에 키를 붙이지 않습니다.

```bash
cd infrastructure/gitops
python -B scripts/connected_runtime.py \
  --env-file /절대경로/개인키.env \
  --features rabbitmq,ai,mail
```

기본은 계획/Helm 검증만 합니다. `--apply`를 붙이면 현재 소유권이 확인된 포크 클러스터에 적용합니다.
`--features`는 추가 항목이 아니라 **전체 원하는 목록**입니다. 빠진 기능은 새 override에서 제거됩니다.
기존 Secret의 사용하지 않는 키와 RabbitMQ PVC는 삭제하지 않습니다.

| 기능 | 키/조건 |
|---|---|
| `rabbitmq` | 키 직접 입력 불필요. 기존 암호 재사용 또는 최초 임의 생성 |
| `ai` | `OPENAI_API_KEY`; 선택한 `OPENAI_*MODEL` 설정은 AI Secret에만 전달 |
| `mail` | `SMTP_HOST`, `SMTP_USERNAME`, `SMTP_PASSWORD`; STARTTLS 587. 발신 주소는 `ACCOUNT_PASSWORD_RESET_FROM` 또는 SMTP 사용자 |
| `google` | `ACCOUNT_OAUTH_GOOGLE_CLIENT_ID`, `ACCOUNT_OAUTH_GOOGLE_CLIENT_SECRET` |
| `kakao` | `ACCOUNT_OAUTH_KAKAO_CLIENT_ID`, `ACCOUNT_OAUTH_KAKAO_CLIENT_SECRET`, `ACCOUNT_OAUTH_KAKAO_ADMIN_KEY` |
| `bizno` | `BIZNO_API_KEY` |
| `collection` | `DATA_GO_KR_SERVICE_KEY`, `KSTARTUP_API_KEY`, `MSIT_API_KEY`, `CNTRADE_NOTICE_API_KEY`. 미지정 개별 키는 공공데이터 키를 사용하되 실제 제공처 이용 승인은 별도 확인 |
| `index` | Catalog 누락 색인 복구. `ai` 필요. `rabbitmq`도 선택하면 관심 공고 원문 미리 수집·임베딩을 활성화 |
| `documents` | 문서 자동 분석. `ai,rabbitmq` 필요 |
| `reports` | 정기 리포트 생성·발송. `ai,rabbitmq,mail` 필요. 기존 앱의 수신 동의 검사는 유지 |

`collection`은 수집 후 색인까지 하므로 유료 임베딩을 포함합니다. `collection,index,documents,reports`의
실제 적용은 `--allow-background-paid-work`도 요구합니다. **이 플래그는 동의 표시이지 금액 차단기가 아닙니다.**
기간·비용 상한이 정해진 경우 강제 차단 수단을 마련하기 전에 반복 유료 작업을 켜지 않습니다.
현재 코드에는 모든 LLM·임베딩 작업을 합산하는 일일 금액 차단기가 없습니다.
RabbitMQ만 연결하면 자동 갱신 임베딩을 수행하는 관심 공고 미리 수집은 켜지 않습니다.

비밀값은 기존 서비스별 Secret에 필드 단위로 전달합니다. `.local/fork/integrations.json`에는 기능 목록,
로컬 origin과 변수 **이름**만 저장합니다. Argo Application의 `helm.valuesObject`에는 env 설정과 Secret 참조만
넣고 이미지/digest는 건드리지 않습니다. 이후 Git의 이미지 promotion과 self-heal을 계속 사용할 수 있습니다.
`up`, `gitops` 재진입에서도 이 프로필을 반영합니다. 실행 중 다른 Argo override가 있으면 자동 덮어쓰지 않습니다.
적용 중 오류가 나면 부분 적용 여부를 확인해야 하며, 데이터·비밀값을 자동 rollback하지 않습니다.

공식 기준: [Argo CD Helm 값 우선순위](https://argo-cd.readthedocs.io/en/stable/user-guide/helm/#helm-value-precedence).

## 웹 실행

```bash
# 터미널 A: 저장소 루트에서 실행
python -B infrastructure/gitops/scripts/fork_cluster.py web

# 터미널 B
pnpm --dir frontend/web dev:k8s:connected
```

접속 주소는 `http://127.0.0.1:5173`로 통일합니다. 다른 origin을 쓸 경우 `--origin http://localhost:5173`과
OAuth 공급자의 callback 등록도 함께 맞춥니다. `dev:k8s`는 계속 무료 시연 모드이며 AI UI가 꺼져 있습니다.
`connected`도 `.env`와 상속 `VITE_*`를 읽지 않고 API 경로와 AI UI 허용값만 명시적으로 노출합니다.
개발 관리자 자동 로그인 버튼은 두 Kubernetes 모드 모두 숨깁니다.

## 예산 검사 후 일회성 수집·색인

```bash
python -B scripts/catalog_once.py --run-id initial-001 --max-usd 0.99 \
  --env-file /절대경로/개인키.env
```

기본은 외부 공고만 수집해 예상 임베딩 비용 상한을 계산하고 종료하는 Kubernetes Job입니다.
이 사전 검사는 OpenAI 키·AI 서버 연결 없이 실행할 수 있습니다. `--sources KSTARTUP`처럼 제공처를
선택하면 해당 제공처의 키만 필요하며, 선택하지 않은 제공처의 Secret 값은 변경하지 않습니다.
실제 DB 공개·임베딩은 같은 명령에 `--apply`를 명시해야 합니다. 기존 Catalog의 `catalog-sync-once` 구현을
재사용하며 예약 수집/색인이 켜진 상태에서는 거부합니다. Job 재시도는 0회, 재시작은 `Never`입니다.
실행 전 로컬 예약 기록을 만들고 적용 기록은 전용 `catalog-sync-receipts` PVC에 남깁니다.
실패/타임아웃의 비용이 불명확하면 새 run ID로 우회 재실행하지 말고 기록부터 확인합니다.

이 상한은 `text-embedding-3-small`, API retry 0, 해당 스냅샷의 UTF-8 바이트/토큰 상한에 대한 계산입니다.
다른 기능의 모델 호출이나 다른 실행을 합산하는 예산은 아닙니다.
2026-09-21 확인한 [공식 임베딩 단가](https://developers.openai.com/api/docs/models/text-embedding-3-small)는
100만 입력 토큰당 $0.02입니다. 반복 자동 작업에는 별도 한도 설정이 필요하며,
[OpenAI 프로젝트 hard spend limit](https://developers.openai.com/api/reference/python/resources/admin/subresources/organization/subresources/projects/subresources/spend_limit/methods/update)은
월 단위입니다. 해당 OpenAI 프로젝트의 소유권·다른 서비스 사용 여부를 확인하지 않고 임의로 변경하지 않습니다.

## 확인 기준

`Ready`, `Synced/Healthy`는 프로세스·배포 상태이지 메일 수신, OAuth 로그인, 전체 수집, AI 품질 성공이 아닙니다.
각 기능을 따로 검증하고, 실제 호출 횟수·예산·수신 주소를 사전 승인 범위에 맞춰 기록합니다.
키 만료·제공처 미승인·OAuth callback 누락은 실제 연결 단계에서 별도로 해결해야 합니다.
