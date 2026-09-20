# 신청양식 분석 결과 일회성 적재 (skn-172)

기업마당 분석 JSON을 기존 Core API 백필 기능으로 적재한다. 새 OpenAI 분석은 하지 않는다.
FORM_FOUND 공고는 공식 첨부를 다시 다운로드·파싱해 파일 해시와 문항 근거를 검증하므로
원본 사이트 접근은 필요하다. 파일이 변경되거나 사라진 공고는 AVAILABLE이 아닌 해당 오류 상태로 남는다.

## 입력과 실행 환경

- 입력: `application-form-openai-analysis-20260915-v2.json` (2026-09-15 재검사 결과)
- SHA-256: `02469da3f71d0ef0cab0f0cb757dc047705c769966b3d3011a4b029c22301829`
- 1,459개 공고: FORM_FOUND 676, NO_FORM 290, FAILED 374, NOT_ELIGIBLE 118, UNKNOWN_AFTER_START 1.
  AI 판정이며 사람이 검토한 정답이 아니다. 후보 FORM_FOUND 수는 실제 적재 후 AVAILABLE 수와 다를 수 있다.
- Linux 배포 호스트의 Python 3, Docker Compose, 이 변경을 포함한 Core API 이미지가 필요하다.
  호스트에 JDK·Gradle·추가 Python 패키지는 필요 없다.
- 기존 배포 환경 파일의 이미지·DB 접속·TLS 인증서 마운트·네트워크를 사용한다.
  JSON에는 서버 비밀번호를 넣지 않으며 환경 파일은 Git에 추가하지 않는다.
- 정상 배포를 통해 Flyway migration을 먼저 적용하고 해당 기업마당 공고 원본을 동기화한다.
  공고 원본이 없으면 양식 활성화에 실패한다. 적재 스크립트는 migration·공고 동기화를 실행하지 않는다.
- 운영 DB 백업 후 유지보수 시간에 모든 Core 인스턴스의 쓰기·자동 분석·동기화를 중지한다.
  스크립트는 선택한 Compose의 core-service 실행 여부를 검사하지만 다른 호스트는 검사하지 못한다.

## 1. 입력만 검증 (DB 및 외부 API 접근 없음)

저장소 루트에서 실행한다. 경로는 서버의 실제 배포 환경 파일로 바꾼다.

```sh
python3 infrastructure/scripts/seed-application-forms.py \
  --env-file /srv/govbiz/.env.production
```

검토된 파일 해시를 확인하고 선택된 Core 이미지에서 `ApplicationFormBackfillInput`을 실행한다.
Spring 서버나 DB 연결을 시작하지 않는다. 실패하면 종료 코드가 0이 아니며 적재를 실행하지 않는다.
Compose 환경 파일에 필요한 기존 배포 설정은 있어야 한다. 다른 서비스는 시작하거나 재생성하지 않는다.

## 2. 백업 및 대상 확인 후 적재

먼저 대상 DB를 백업하고 같은 Compose 설정으로 Core를 중지한다.
아래 JDBC URL 자리에는 환경 파일로 해석한 `SPRING_DATASOURCE_URL` 전체를 정확하게 넣는다.
쿼리 파라미터와 TLS truststore 옵션도 같아야 하며 URL에 계정 비밀번호를 넣지 않는다.

```sh
docker compose --env-file /srv/govbiz/.env.production \
  -f infrastructure/compose.prod.yaml stop core-service

python3 infrastructure/scripts/seed-application-forms.py \
  --env-file /srv/govbiz/.env.production \
  --apply --backup-confirmed \
  --expected-jdbc-url '여기에 배포 설정의 정확한 JDBC URL 입력'
```

`--backup-confirmed`는 백업을 생성하지 않는다. 운영자가 백업을 완료했다는 확인이다.
스크립트는 입력 검증 후 DB 주소를 비교하고, 일회성 Core 컨테이너에서 다음을 수행한다.

`ApplicationFormBackfillRunner → ApplicationFormBackfillService → 기존 Repository → MySQL`

일회성 컨테이너는 자동 분석·공고 동기화·큐 소비·색인·정기 메일을 끄고 migration도 실행하지 않는다.
기존 배포 파일은 수정하지 않으며 서비스 포트를 공개하지 않는다. 성공하면 요약 JSON을 출력하고 종료한다.
예외가 발생하면 성공으로 처리하지 않으며 Docker 종료 코드를 그대로 반환한다.

공고별로 커밋되므로 중간 실패 시 앞서 완료된 데이터는 남는다. 기존 importer 정책상 같은 파일로
이미 적재한 공고, 검증 시각이 있는 공고, 실행 중인 공고는 건너뛴다. 기존 값을 강제로 덮어쓰지 않는다.
동일 파일 재실행이 이전에 저장된 오류 공고를 모두 재처리한다는 뜻은 아니다.
복구가 필요하면 출력과 백업을 근거로 대상만 결정한다. 테이블 전체를 삭제하거나 백업을 무조건 덮어쓰지 않는다.

## 3. 결과 확인 및 서비스 복구

- 출력의 `statusCounts`, `availablePrograms`, `snapshotCount`, `skipped`를 확인한다.
  종료 코드 0은 모든 공고가 AVAILABLE이라는 뜻이 아니다.
- `application_form_availability`와 `application_form_snapshot`의 기업마당 결과를 확인한다.
- 분석 실패·원본 변경·미지원 공고를 분리해서 기록한다.
- 배포 환경의 `APPLICATION_FORM_ANALYSIS_ENABLED=false`를 유지하고 Core를 다시 시작한다.
  공고 동기화·다른 서비스 설정은 기존 운영 정책에 맞춘다.

```sh
docker compose --env-file /srv/govbiz/.env.production \
  -f infrastructure/compose.prod.yaml up -d --no-deps core-service
```

양식 발견 공고의 작성 진입, NO_FORM·오류 공고의 안내를 확인한다. 실제 배포·적재는 운영자가 실행한다.

## 로컬 검증

```sh
python3 -B -m unittest discover -s infrastructure/scripts -p 'test_seed_application_forms.py'
```

스크립트 테스트는 Docker 실행을 대체하여 입력 변조·대상 DB 불일치·실행 중 서비스·하위 실행 실패를 검증한다.
실제 MySQL 적재나 외부 사이트 품질 검증을 대신하지 않는다.
