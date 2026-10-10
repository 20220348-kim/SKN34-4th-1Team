# Langfuse와 저장소의 Kubernetes 이전

평가 서비스의 실제 이전 다음 단계다. 배포 대상은 Langfuse web/worker와 전용 PostgreSQL,
ClickHouse, Redis, MinIO이며 개발용 Compose는 유지한다.
[배포 Chart와 Secret·PVC 계약](../charts/govbiz-observability/README.md)을 함께 사용한다.

## 이전 방식

현재 사용하는 여섯 이미지 digest와 데이터 형식을 보존한다. 이전과 제품 버전 업그레이드를
동시에 수행하지 않는다. 새 `govbiz-observability` namespace의 별도 PVC 네 개에 데이터를
복원하고, 저장소와 web/worker를 수동 동기화한 다음 기존 평가 실행기의 주소를 전환한다.

PostgreSQL은 사용자·프로젝트·API 키, ClickHouse는 관측 데이터, MinIO는 객체,
Redis는 작업 큐를 보유하므로 네 저장소를 같은 쓰기 중지 구간에 복사한다.
ClickHouse의 공식 Docker 볼륨 백업 안내와 PostgreSQL의 파일 단위 백업 조건에 따라
서버를 정상 종료한 뒤 전체 데이터 디렉터리를 복사한다.
([Langfuse 백업](https://langfuse.com/self-hosting/configuration/backups),
[PostgreSQL 17 파일 백업](https://www.postgresql.org/docs/17/backup-file.html))

기존 평가 결과 백업의 작은 일반 파일 전용 검사기는 ClickHouse의 큰 데이터와 내부 링크를
다루는 용도로 확장하지 않는다. 이번 물리 복사는 파일 소유권·권한·심볼릭 링크·하드 링크를
보존하는 tar를 사용하며, 암호화는 기존 `ops_snapshot.seal/open_payload`를 재사용한다.
새 암호화 방식이나 별도 배포 검증 파이프라인을 만들지 않는다.

## 실제 이전 순서

1. 배포 설정을 포함한 정확한 소스 SHA의 필수 CI 성공을 확인하고 Argo CD에 고정한다.
   `govbiz-observability`에만 배포 가능한 AppProject/Application을 수동으로 등록한다.
   처음에는 여섯 replica를 모두 `0`으로 유지하고 PVC·Secret을 Argo 관리에 포함하지 않는다.
2. 원본 프로젝트·컨테이너·볼륨·이미지와 평가 실행기의 기존 설정을 기록한다.
   원본 로그인·프로젝트 API 인증을 확인하고 기존 앱 키와 저장소 암호를 비공개로 보존한다.
3. Ops 평가 접수를 중지하고 처리 중 평가·예약 작업이 없는지 확인한다.
   평가 실행기를 `0`으로 낮춘 뒤 Langfuse web/worker와 저장소 네 개를 정상 종료한다.
   Core/AI 등 다른 관측 생산자의 쓰기도 전환 구간에 중지한다.
4. 원본 볼륨을 읽기 전용으로 마운트해 **전체 디렉터리**를 백업한다.
   암호화 백업을 검증하고 새롭고 빈 PVC에만 복원한다. 기존 복원본을 덮어쓰지 않는다.
   PostgreSQL WAL과 ClickHouse 메타데이터·링크를 제외하거나 부분 선택하지 않는다.
5. 파일 SHA-256·크기·소유권·권한·링크가 일치한 뒤 복원 기록을 기록한다.
   실제 저장소 사용자 ID로 읽을 수 있는지 확인하고 임시 복사 Pod를 제거한다.
   PVC와 PV의 `Retain` 정책은 유지한다.
6. 기존 키로 Secret을 생성하고 저장소 네 개를 먼저 기동한다. DB 로그인·프로젝트 수와
   관측 데이터·객체·큐 보존을 확인한 뒤 web/worker를 기동한다.
   자동 migration과 최초 프로젝트 생성은 비활성화한다.
7. 기존 평가 키로 프로젝트 API 인증과 익명 요청 거절을 확인한다.
   평가 실행기의 주소를 내부 Langfuse Service로 바꾸고 무료 관측 전송·조회와 실제 통신 정책을
   확인한다. 사용자가 보는 URL과 연결 포워딩도 함께 전환한다.
8. 접수를 재개하고 원본 Compose 여섯 서비스가 꺼진 상태에서 운영 경로가 동작하는지 확인한다.
   성공한 뒤에도 원본 볼륨과 암호화 백업은 유지한다.

기동 실패로 원본에 복귀할 때는 Kubernetes의 web/worker와 관측 생산자를 먼저 멈춘다.
Kubernetes에서 신규 쓰기가 발생했다면 원본과 이미 데이터가 갈라졌으므로 무조건 원본을
재기동하지 않는다. 새 데이터 보존과 역방향 복구 대상을 확인한다.
데이터 복사 준비만 수행한 경우에는 원본을 재개하되, 그 복사본은 시점 백업으로만 다룬다.
최종 전환 때 새 빈 PVC에 다시 복사하고 Chart의 `claims`를 그 PVC로 지정한다.

## 2026-10-10 진행 기록

개인 환경에서 **Langfuse web/worker와 저장소 네 개를 실제 Kubernetes로 전환했다.**
평가 실행기는 내부 Service를 사용하며 원본 Compose가 꺼진 상태에서 새 점수 저장·조회와
Ops 보고서까지 확인했다. 웹·데이터·외부 접근을 포함한 전체 운영 환경의 이전 완료와는 구분한다.

### 배포와 데이터

Chart 소스는 `cda98e5adf0a9e1aa86efeda9c6790a7bb2e7543`로 고정했다.
해당 SHA의 Infra·GovBiz·Catalog·Ops·LLMOps CI가 모두 성공한 뒤 Argo CD에 등록했다.
[Infra CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/38037966450)와
[최종 LLMOps CI](https://github.com/ilil1/SKN34-4th-1Team/actions/runs/38037966436)의 실행 결과를 남겼다.
`govbiz-observability` Application은 수동 동기화이며 자동 sync·prune·selfHeal은 비활성이다.
저장소 4개를 먼저 기동하고 기존 데이터를 확인한 뒤 web/worker를 기동했다.

앞선 `*-stage2` 복원본은 원본을 재개한 시점 백업이었다. 실제 전환에서는 평가 접수를 닫고
실행기와 Langfuse의 쓰기를 중지한 뒤 **새 빈 `*-cutover` PVC 네 개**에 최신 데이터를 다시 복사했다.
네 저장소의 정상 종료 코드 `0`, 암호화 백업 인증·복호화, 파일 해시·크기·권한·소유권·링크의
일치를 확인했다. 임시 복사 Pod를 제거하고 실제 저장소 사용자 권한의 읽기도 확인했다.

| 저장소 | 현재 사용 PVC | 일반 파일 수 | 복사 시 파일 내용의 합계 |
| --- | --- | ---: | ---: |
| PostgreSQL | `postgres-cutover` | 1,749 | 71,602,180 bytes |
| ClickHouse | `clickhouse-cutover` | 34,585 | 1,067,587,669 bytes |
| Redis | `redis-cutover` | 1 | 320,227 bytes |
| MinIO | `minio-cutover` | 252 | 359,376 bytes |
| 합계 | Retain PVC 4개 | 36,587 | 1,139,869,452 bytes |

기동 후 PostgreSQL의 프로젝트 1개·사용자 1명과 ClickHouse 10개 테이블의 행 수가 원본과
일치했다. Redis는 원본 184개 키 중 175개를 적재했고, 9개는 RDB 기동 로그에서 TTL 만료로
확인했다. 데이터 파일은 복원 직후 원본과 일치했다. 기존 API 키·앱 암호화 키·저장소 암호는
유지했고 자동 스키마 migration과 최초 프로젝트 생성은 실행하지 않았다.

### 기동 중 수정한 문제

- 로컬 이미지 archive를 containerd에 직접 가져오면서 일부 `import-*` 참조가 정규화된 이름과
  달라 `CreateContainerError`가 발생했다. 누락된 이름을 **같은 digest의 참조**로 연결해 복구했다.
  이미지 내용·원본 볼륨·Chart의 이미지 digest는 변경하지 않았다.
- web의 limit `1Gi`에서는 V8 힙이 약 `512Mi`로 제한되어 최초 기동 중 메모리가 부족했다.
  검증된 Chart가 지원하는 개인 values로 web request `512Mi`, limit `2Gi`를 적용해 해결했다.
  저장소의 기본 values도 같은 값으로 보정했다. worker의 limit은 `1Gi`를 유지한다.
- WSL 새 프로세스와 파일 서버의 간헐적 `0x8007274c`/파일 읽기 오류는 남아 있다.
  Windows kubectl·Docker 경로로 전환을 마쳤으며 WSL/Docker 전체를 재시작하지 않았다.

최종 관측에서 Langfuse 6개 Pod는 모두 Ready·재시작 0회, 전체 Argo Application 8개는
`Synced/Healthy`였다. 기존 프로젝트 키 인증과 익명 요청 거절을 확인했다.
허용되지 않은 namespace에서 실행기와 같은 Pod label로 접속해도 세 번 모두 차단됐으며,
평가 namespace의 실제 실행기에서는 내부 Service 인증에 성공했다. 임시 프로브 namespace는 제거했다.

### 실제 평가와 화면

평가 실행기의 주소는 `http://langfuse-web.govbiz-observability.svc.cluster.local:3000`이다.
기존 실행기 발행본 `2cab4881fa8b128687a35d0da409ac2c4ee08002`의 주소만 변경했으며,
Ops 평가 접수는 버전 `20`에서 재개했다. 현재 실행 경로는 다음과 같다.

`관리 화면 → Kubernetes Ops → Prefect → 평가 실행기 → Kubernetes Langfuse 및 결과 PVC → Ops 보고서`

- 요청 `c5e00ccb-0c9c-4467-b81b-c44f1f860fa0`, Prefect flow
  `cb7806c3-aa21-4225-a8f7-9a0cb6bd6a22`: 무료 평가 6사례 완료, 모델 호출 0회.
- 점수 22개의 저장·재조회를 확인했고, ClickHouse의 갱신 시각이 이번 요청 이후인 것도 확인했다.
- 관리자 로그인·CSRF·중복 요청의 동일 flow 유지·백그라운드 동기화·보고서 HTTP 200·공유 로그아웃을 확인했다.
- 첫 확인에서는 평가 목록 GET이 15초 제한을 넘었다. 서버의 `COMPLETED` 상태를 확인한 뒤
  **같은 요청 ID**로 확인을 재개해 완료했다. 시간 제한을 늘리거나 새 평가를 만들지 않았다.
  개인 환경의 응답 지연이 해결됐다는 뜻은 아니다.

Langfuse 화면은 `http://localhost:13000`, 기존 관리 화면은 `http://localhost:5173`이다.
Langfuse는 Kubernetes Service의 Windows loopback 포워딩으로 연결한다. 웹 Pod를 교체한 뒤에는
포워딩도 새 Pod에 다시 연결해야 한다. 개인 kubeconfig를 지정하는 수동 명령은 다음과 같다.

```powershell
kubectl --kubeconfig '<개인 fork kubeconfig 경로>' -n govbiz-observability port-forward --address 127.0.0.1 service/langfuse-web 13000:3000
```

원본 Compose의 Langfuse 6개와 기존 평가 서비스 3개는 모두 중지되어 있다. 원본 Langfuse 볼륨
4개와 이전 시점 백업은 보존했다. 전환 후 새 데이터는 `*-cutover` PVC에 있으므로 원본을
무조건 재개하는 방식으로 되돌리지 않는다. 개발용 Compose 구성 자체는 유지한다.

### 보존 기록과 남은 범위

비공개 기록은 `/home/playdata2/govbiz-backups/20261010-langfuse-cutover`에 있다.
`source-config.enc`는 원본 설정·키, 저장소별 manifest와 16 MiB 암호화 조각은 냉간 백업이다.
manifest의 순서·암호문 해시·전체 archive 해시를 대조하고 인증·복호화해야 한다.
기존 평가 snapshot CLI와 다른 이번 운영 기록 형식이다. 임시 평문 tar는 복원 후 제거했다.
`ci.json`, `storage-ready.json`, `network.json`, `fresh-scores.json`,
`kubernetes-free-evaluation.json`, `completed.json`에 실제 전환 결과를 보존했다.

메모리 기본값 보정 후 기존 Chart 렌더링 테스트 4개와 Helm 4.3.0 lint를 통과했다.
위 원격 CI 결과는 배포한 `cda98e5a`의 결과이며, 이후 기본값 보정의 전체 CI는 다음 푸시 SHA에서
별도로 확인해야 한다. 이번 무료 평가는 배포 경로 확인이며 실제 검색·RAG 품질 측정이 아니다.

이전 시점의 냉간 복원은 마쳤지만 전환 후 Langfuse 데이터의 정기 백업·전체 장애 복구,
단일 노드 밖의 운영 스토리지·웹 배포·외부 ingress/TLS는 남아 있다.
