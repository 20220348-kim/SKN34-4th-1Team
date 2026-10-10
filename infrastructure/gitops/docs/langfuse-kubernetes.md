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

이번 작업은 실제 서비스를 옮길 Chart와 **새 Retain PVC 네 개의 데이터 복원**까지 수행했다.
새 배포 설정은 아직 커밋·필수 CI 통과 전이므로 Kubernetes Langfuse의 최종 기동과
평가 실행기의 주소 전환은 다음 배포 단계다. 준비를 전체 Kubernetes 이전 완료로 계산하지 않는다.

| 저장소 | 일반 파일 수 | 파일 내용의 합계 |
| --- | ---: | ---: |
| PostgreSQL | 1,749 | 71,602,180 bytes |
| ClickHouse | 32,647 | 946,936,467 bytes |
| Redis | 1 | 319,234 bytes |
| MinIO | 264 | 368,859 bytes |
| 합계 | 34,661 | 1,019,226,740 bytes |

네 저장소의 종료 코드 `0`을 확인한 같은 쓰기 중지 구간에 백업했다. 인증·복호화한
백업으로 복원한 뒤 전체 파일 해시·소유권·권한·링크를 원본과 대조했다.
복사 Pod를 제거한 뒤 새 Pod에서 PostgreSQL/Redis `999`, ClickHouse `101`, MinIO `65532`
사용자로 복원 기록과 필수 데이터 파일을 읽는 것도 확인했다. 이 Pod도 제거했다.
최종 복사본의 PVC 이름은 `postgres-stage2`, `clickhouse-stage2`, `redis-stage2`, `minio-stage2`다.
이름이 Chart 기본값과 다르므로 개인 values의 `claims`를 함께 사용해야 한다.

첫 시도에서 ClickHouse의 기동 필수 경로를 잘못 지정한 문제를 발견했다.
현재 이미지에 있는 `metadata/default.sql`로 수정하고 원본 서비스를 복구한 뒤,
기존 복사본을 덮어쓰지 않고 네 저장소를 새 PVC에 같은 시점으로 다시 복사했다.
재복원이 성공한 뒤 첫 시도의 임시 PVC/PV 네 개는 UID·소유권·미사용 상태를 확인해 정리했다.
최종 PVC 네 개의 PV는 모두 `Retain`으로 유지하며 원본 Compose 볼륨은 삭제하지 않았다.

원본 Compose의 Langfuse 여섯 서비스를 재개하고 기존 프로젝트 API 키의 인증·익명 요청 거절을
확인했다. Kubernetes 평가 실행기는 원래 replica `1`로 복구했고 평가 접수는 버전 `18`에서
다시 허용했다. 웹 `5173`, Ops `18001`, Langfuse `13000`의 건강 확인 URL은 모두 HTTP `200`이다.
원본 Compose 평가 서비스 세 개는 기존과 같이 중지 상태다.

개인 WSL의 `/home/playdata2/govbiz-backups/20261010-langfuse-stage2`에 비공개 기록을 보존한다.
원본 컨테이너 설정과 기존 키는 `source-config.enc`, 각 저장소는 암호화된 manifest와
16 MiB 단위의 암호화 archive 조각으로 저장한다. manifest에는 조각 순서·암호문 해시·
전체 archive 해시와 원본 파일 목록이 있다. 각 조각의 인증·복호화 후 순서대로 연결해야 한다.
이 파일 형식은 이번 운영 기록이며 기존 평가 snapshot CLI 입력 형식과 다르다.
복원·대조를 마친 임시 평문 tar는 삭제하고 0600 키·암호화 백업은 저장소 밖에 유지한다.
같은 디렉터리의 `kubernetes-secrets.enc`에는 기존 키로 만든 두 Kubernetes Secret 입력을
암호화해 보존했다. 클러스터에는 아직 적용하지 않았다. `values.yaml`에는 실제 노드·PVC 이름과
replica `0` 설정을 기록했다.

복사 중과 서비스 재개 뒤 WSL 새 프로세스 실행에 `0x8007274c` 시간 초과가 발생했다.
마지막 정리는 Windows Docker와 WSL 파일 서버를 통해 완료했으며 WSL/Docker를 재시작하지
않았다. 이 경로의 정리 성공을 WSL 실행 지연 자체가 해결됐다는 뜻으로 해석하지 않는다.

로컬에서는 Chart 렌더링 테스트 **4개**, Helm **4.3.0** lint, Ruff, 문서 링크와 YAML 구문을
확인했다. 전체 CI는 이번 변경을 커밋·푸시한 최신 SHA에서 별도로 확인해야 한다.
저장소의 실제 DB 기동·네트워크 차단·Argo 동기화는 이번 데이터 복원 결과에 포함하지 않는다.

원본 Compose를 재개한 뒤에는 Kubernetes 복사본과 데이터가 달라질 수 있다.
최종 전환은 **최신 데이터 재복사 → 저장소 기동 → web/worker 기동 → 내부 주소 변경** 순서로
진행해야 한다. 단순히 현재 복사본의 replica만 올려서는 안 된다.
