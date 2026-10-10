# Langfuse의 Kubernetes 이전

현재 Compose에서 사용하는 Langfuse web/worker, PostgreSQL, ClickHouse, Redis, MinIO를
동일한 이미지 digest와 데이터 형식으로 실행하는 개인 환경용 Chart다.
단일 노드·단일 인스턴스를 대상으로 하며 고가용성 구성은 아니다.
실제 이전 기록과 전환 순서는 [Langfuse 이전 문서](../../docs/langfuse-kubernetes.md)를 따른다.

## 실행 구성

`평가 실행기 → Langfuse web → PostgreSQL / Redis / MinIO`와
`Langfuse worker → PostgreSQL / ClickHouse / Redis / MinIO`를 클러스터 내부 Service로 연결한다.
Langfuse web도 ClickHouse를 조회한다. 별도 운영자나 새로운 저장소 제품은 추가하지 않는다.

- web/worker는 `Recreate` Deployment, 저장소 4개는 StatefulSet이다.
- 기본 replica는 모두 `0`이며 `0` 또는 `1`만 허용한다.
- `node`는 복원 PVC가 위치한 실제 노드 이름으로 명시해야 한다.
- Namespace·PVC·Secret을 생성하거나 소유하지 않는다. 원본 Compose 볼륨도 참조하지 않는다.
- PVC는 별도 생성·복원하고 PV의 `Retain` 정책을 확인한다. Chart 삭제와 데이터 삭제를 분리한다.
- 이미지 digest·기존 사용자 ID를 유지한다. `fsGroup`으로 데이터 전체 소유권을 변경하지 않는다.
- 자동 PostgreSQL/ClickHouse migration과 최초 사용자·프로젝트 생성을 실행하지 않는다.
  이 Chart는 기존 스키마의 같은 버전 이전용이다. 버전 업그레이드는 별도 migration 작업이다.
- Redis는 원본의 RDB 저장 방식과 `noeviction` 설정을 유지한다.
- 모든 Service는 `ClusterIP`다. 기본 deny 정책 위에 DNS, 앱→저장소,
  평가 실행기 및 Core/AI→Langfuse web 통신만 허용한다.
  실제 차단 여부는 해당 클러스터의 네트워크 플러그인에 달려 있다.

## 기존 Secret 계약

실행 중인 원본에서 값을 보존해 별도로 주입한다. 새 키를 생성하면 기존 인증·암호화 데이터와
호환되지 않는다. 값을 저장소, 명령행 인자, 로그에 기록하지 않는다.

| Secret | 필수 키 |
| --- | --- |
| `langfuse-runtime` (`existingAppSecret`) | `DATABASE_URL`, `SALT`, `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, `CLICKHOUSE_PASSWORD`, `REDIS_AUTH`, `LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY`, `LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY` |
| `langfuse-storage` (`existingStorageSecret`) | `POSTGRES_PASSWORD`, `CLICKHOUSE_PASSWORD`, `REDIS_PASSWORD`, `MINIO_PASSWORD` |

`DATABASE_URL`의 사용자·암호·DB 이름은 보존하고 주소를 같은 namespace의 `postgres:5432`로
설정한다. 사용자/DB는 `langfuse`, ClickHouse 사용자와 MinIO 접근 키도 `langfuse`인 현재 원본을
대상으로 한다. 비밀번호의 URL 인코딩을 유지한다. `LANGFUSE_INIT_*` 키는 복사하지 않는다.
Secret에는 위 계약의 키만 넣는다. 앱의 나머지 환경은 Chart에서 관리한다.

평가 실행기에서 사용하는 `LANGFUSE_PUBLIC_KEY`·`LANGFUSE_SECRET_KEY`는 기존 평가 Secret에
유지한다. 위 앱 Secret에 넣거나 교체하지 않는다.

## 복원 PVC 계약

`claims.postgres`, `claims.clickhouse`, `claims.redis`, `claims.minio`는 서로 다른 PVC다.
볼륨 루트에는 원본 디렉터리 전체와 다음 복원 기록이 있어야 한다.

```json
{"component":"postgres","image":"원본의 정확한 image@sha256:digest"}
```

파일명은 `.govbiz-langfuse-restore.json`이다. **복원이 완료되고 파일 해시·소유권이 일치한 뒤에만**
작성한다. 각 저장소 사용자에게 읽기 권한을 준다. 기동 시 init container가 기록의 component와
image를 대조하고 `PG_VERSION`, `metadata/default.sql`, `dump.rdb`, `.minio.sys/format.json`을 각각
확인한다. 이 확인만으로 데이터 최신성이나 DB 정상 복원을 보장하지는 않는다.

## 렌더링과 적용

```bash
helm lint infrastructure/gitops/charts/govbiz-observability \
  --namespace govbiz-observability --set node=fixture-control-plane --strict

helm template langfuse infrastructure/gitops/charts/govbiz-observability \
  --namespace govbiz-observability --set node="$STORAGE_NODE"
```

기본 렌더링은 서비스 기동 없이 배포 선언을 준비한다. 필수 CI가 통과한 정확한 커밋 SHA를
Argo CD의 `targetRevision`으로 고정한다. Application의 대상은 이 Chart와
`govbiz-observability` namespace로 한정하고 자동 sync·prune·selfHeal은 끈다.
AppProject에는 Deployment·StatefulSet·Service·ConfigMap·NetworkPolicy만 허용한다.
Secret·PVC·Namespace는 해당 Application에 포함하지 않는다.

최종 이전 시 원본 쓰기를 중지하고 **최신 데이터로 다시 복원**한 뒤, 저장소 4개→worker/web 순서로
각 `replicas` 값을 `1`로 수동 동기화한다. 앱을 시작하기 전에 저장소가 Ready인지 확인한다.
접속·인증·데이터 보존이 확인되면 평가 실행기의 Langfuse 주소를
`http://langfuse-web.govbiz-observability.svc.cluster.local:3000`으로 전환한다.
`publicUrl`은 사용자가 실제 접근할 URL이며 기본값은 개인 환경의 `http://localhost:13000`이다.
개인 환경에서는 해당 Service의 loopback port-forward를 사용한다. 외부 ingress/TLS는 별도 구성이다.

CI의 기존 Infra 렌더링 테스트와 Helm lint에서 검사한다. 별도 검증 파이프라인을 추가하지 않는다.
