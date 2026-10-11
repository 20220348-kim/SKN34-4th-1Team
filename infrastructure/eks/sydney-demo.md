# Mac에서 시드니 EKS로 이전하는 시연 구성

`cluster.sydney-demo.yaml`은 `ap-southeast-2`, Kubernetes 1.36, `m7i-flex.large` 2대를
사용하는 7일 시연용 입력이다. 적용 전 지원 버전·quota·계정·비용을 다시 확인한다.
`cluster.example.yaml`은 별도 Argo CD 원본을 위한 기존 서울 1노드 예제로 유지한다.

## 노드와 디스크 배치

| 노드 풀 | 배치할 서비스 | 현재 요청 CPU / 메모리 |
| --- | --- | --- |
| `application` | 업무 저장소 7개, Core·Catalog·Ops, 평가 실행기·보고서·Prefect | 1.4 vCPU / 2.75GiB, 13개 workload |
| `observability` | Langfuse와 저장소 4개, AI·웹 | 0.825 vCPU / 1.84GiB, 8개 workload |

요청량은 현재 Mac 구성의 값이며 실제 최대 사용량이나 성능 보장이 아니다. EKS 시스템 Pod의
요청량·노드 allocatable·실행 중 최대 메모리를 추가 확인한다. 서비스의 메모리 limit 합계가
각 노드의 8GiB보다 클 수 있으므로 대량 동시 평가·색인을 활성화하지 않는다.

- 두 노드 그룹의 min/desired/max는 각각 1이다. 노드 hostname 대신
  `govbiz.io/workload-pool` 라벨로 배치해 노드 교체에도 같은 풀을 선택한다.
- 제어 영역에는 두 AZ를 사용하되 데이터 노드는 모두 `ap-southeast-2a`에 둔다.
  단일 AZ, 서비스별 단일 replica이며 HA 구성이 아니다.
- 평가 실행기와 보고서 서비스는 같은 RWO PVC를 사용한다. 같은 풀 지정에 더해 필수 Pod affinity로
  동일 노드에 배치하며, PVC를 쓰는 Deployment는 `Recreate`로 갱신한다.
- gp3는 암호화·Retain·WaitForFirstConsumer를 사용한다. 복원 Pod도 대상 노드 풀을 지정한다.
- 현재 사용 중인 PVC 13개는 20GiB씩 요청한다. 이전 시 ClickHouse·MinIO는 최소 30GiB를
  확보하므로 데이터 280GiB, 노드 루트 80GiB씩을 합해 총 440GiB를 계획한다.
  실제 데이터 크기와 할당·청구 용량은 다르다.
- private 노드와 NAT Gateway 1개를 사용한다. 첫 접속은 loopback port-forward이며 ALB를 만들지 않는다.

2026-10-11 조회 가격으로 EKS 표준 지원·EC2 2대·gp3 440GiB·NAT 1개·공인 IPv4 1개의
168시간 고정비는 약 **$77.5**다. gp3 월 요금을 730시간으로 환산한 추정이며 로그·전송·세금·
노드 교체 중 추가 인스턴스 등은 별도다. Free Plan 대상 인스턴스라는 뜻이 사용료 0원이라는 뜻은 아니다.

## 현재 Mac의 구성 수집

저장소 루트에서 Python 3.12+, kubectl, OpenSSL을 사용한다. 아래 경로는 예시이므로 매번
새 디렉터리를 선택한다. 키와 bundle을 분리하고 생성 파일을 Git에 추가하지 않는다.

```sh
tool=infrastructure/gitops/scripts/eks_handoff.py
source_kube=.data/kubernetes-migration/20261011/kubeconfig
bundle=.data/eks-handoff-final/bundle
key=.data/eks-handoff-final/keys/key
python3 "$tool" capture --source-mode manifests \
  --kubeconfig "$source_kube" --output "$bundle" --key-file "$key"
```

`capture`는 서비스·데이터를 변경하지 않는다. 참조 Secret은 `configuration.enc` 안에 암호화하고
키는 600, 디렉터리는 700 권한으로 저장한다. `image-inventory.json`에는 초기화 컨테이너를
포함한 전체 이미지와 사용처만 기록한다. kubeconfig와 서비스 계정 토큰은 전달하지 않는다.

원본에 없는 수집 영수증 PVC를 만들어 넣지 않는다. 존재하는 영수증은 보존하고, workload가
참조하는 PVC가 없으면 실패한다. Argo CD가 관리하는 앱이 있으면 이 모드를 거절하고 기존
Argo 경로를 사용한다. custom service account/RBAC, 복수 replica, hostPath, 별도 affinity 등
자동 변환하지 않는 구성은 명시적으로 거절한다.

**`configuration.enc`만 있으면 구성 수집만 완료한 것이다. 데이터 백업 완료는
`backup.enc`와 `backup-completed.json`이 모두 있어야 한다.** 최종 냉간 백업은 이전 실행 직전에
새 bundle로 만들고, [기존 중단·재개 절차](README.md#현재-pc-구성-수집과-냉간-백업)를 따른다.
실행 중 평가와 예약이 없는지 확인하고 접수를 일시 중지한 뒤 Deployment → StatefulSet 순서로
정상 종료한다. 원래 replica와 접수 상태를 기록하고 성공·실패 모두 원래 상태로 복구한다.

```sh
python3 "$tool" backup --kubeconfig "$source_kube" \
  --node '<원본 노드 hostname>' --bundle "$bundle" --key-file "$key"
```

tar는 Linux 백업 Pod 안에서 실행하므로 Mac의 BSD tar 옵션 차이에 의존하지 않는다.
실행 중인 DB 파일을 그대로 복사하거나 원본 PVC를 삭제하지 않는다.

## 이미지 발행과 오프라인 변환

현재 `docker.io/govbiz-migration/*@sha256:...` 참조는 로컬로 수입한 이미지다. 태그에
`docker.io`가 있다고 공개 레지스트리에 발행된 것은 아니다. 재빌드 대신 검증된 기존 이미지를
선택한 계정의 private ECR에 발행하고 **실제 발행 결과 digest**를 기록한다.

Docker의 이미지 index ID, platform manifest digest, config digest를 같은 값으로 취급하지 않는다.
로컬 수입 기록을 대조하고 파일 레이어·실행 설정·linux/amd64 일치를 확인한다. ECR에서 다시
조회한 digest로 다음 JSON 매핑을 작성한다. 초기화 컨테이너도 빠짐없이 포함한다.

```json
{
  "docker.io/govbiz-migration/서비스@sha256:원본_digest":
    "계정.dkr.ecr.ap-southeast-2.amazonaws.com/govbiz-demo/서비스@sha256:발행_digest"
}
```

```sh
python3 "$tool" prepare --bundle "$bundle" --key-file "$key" \
  --pool-placement --image-map .data/eks-image-map.json \
  --output .data/eks-rendered
```

이 명령은 AWS 호출·적용·앱 기동을 하지 않는다. 이미지 매핑이 부족하거나 digest가 없으면 거절한다.
출력은 모두 비공개로 다룬다. 이전 replica는 `startup-plan.json`에 기록하고 workload는 0개로
멈춘 상태로 내보낸다. Service 이름·내부 연결·NetworkPolicy·DB 설정·복원 검사·probe를 보존하며,
개발 로그인 및 Ops 유료·정기 평가 실행은 비활성화한다. 기존 AI 키를 사용하는 실제 호출은
이전 확인 과정에서 실행하지 않는다.

| 출력 | 적용 시점 |
| --- | --- |
| `00-namespaces.json`, `10-claims.json` | 새 클러스터의 namespace·빈 EBS 준비 |
| `20-private-dependencies.json` | 복원 후 Secret·ConfigMap 주입. 내용 출력 금지 |
| `25-services-and-policies.json` | 기존 내부 서비스와 네트워크 정책 연결 |
| `30-data-stopped.json` | 모든 저장소를 정지 상태로 등록 |
| `50-workloads-stopped.json` | 앱을 정지 상태로 등록 |
| `startup-plan.json` | 원래 replica와 대상 풀 확인용 기록. Kubernetes manifest 아님 |

## AWS 생성과 복원 순서

1. 배포 대상 변경의 필수 CI를 확인한다. 별도 작업 사본에서 관리자 CIDR placeholder를 실제
   공인 IP `/32`로 바꾸고 `AWS_PROFILE=govbiz-eks eksctl create cluster --dry-run --config-file ...`로 검사한다.
   `--dry-run`에서는 `--profile` 인자를 함께 사용할 수 없으므로 환경변수로 프로필을 전달한다.
   지원 버전·한도·크레딧과 총비용을 확인한 뒤 실제 생성한다.
2. EKS 노드 두 대, EBS CSI·Pod Identity·VPC CNI와 NetworkPolicy, Elasticsearch의
   `vm.max_map_count=1048576`, ECR 이미지 pull 권한을 확인한다.
3. 전용 EKS kubeconfig로 namespace와 `storage-class.yaml`, 빈 PVC만 만든다.
4. 다음 명령으로 복원한다. 원본 namespace UID, 살아 있는 writer, 비어 있지 않은 목적 PVC는 거절한다.
   각 archive 전체의 인증이 끝나야 쓰기를 시작한다. 실패하면 원본·백업을 유지하고 새 빈 대상으로 재시도한다.

```sh
python3 "$tool" restore --kubeconfig .data/eks-kubeconfig \
  --pool-placement --bundle "$bundle" --key-file "$key"
```

5. Secret·ConfigMap·Service·NetworkPolicy와 정지 workload를 적용한다. 저장소부터 원래 replica로
   기동해 Ready를 확인한 뒤 Prefect·보고서 → AI·Catalog·Core·Ops → 실행기·웹 순서로 재개한다.
   모든 replica를 일괄 1로 바꾸지 말고 `startup-plan.json`과 원래 접수 상태를 따른다.
6. `18173:8080` 웹과 `13000:3000` Langfuse를 port-forward한다. 기존 관리자 로그인, 공고·평가
   이력·보고서 해시, 무료 평가, 로그아웃 후 접근 차단을 확인한다. 기존 모델의 유료 호출을 새로 하지 않는다.

이 경로는 현재 직접 배포 구성을 유지하는 첫 이전이다. Argo CD나 새 DB 스키마를 함께 도입하지 않는다.
시연 종료 후 원격 백업 확인 → 앱 중지 → 클러스터 정리 → Retain EBS·NAT·공인 IP·ECR·로그의
잔여 자원 확인을 진행한다. 데이터 삭제 대상과 보존할 백업은 종료 시 명시적으로 확정한다.

## 검증과 완료 경계

`infrastructure/gitops/scripts/test_eks_handoff.py`는 기존 암호화·손상 차단·원본 복원 거절과 함께
직접 배포 수집, 이미지 누락, PVC 보존, 두 풀 배치, RWO 공동 배치, 시드니 설정을 검사한다.
Linux Python 환경의 PyYAML·OpenSSL·GNU tar가 필요하며 기존 Infra CI의 테스트 탐색에 포함된다.
Mac에서는 GNU tar가 있는 격리 Linux 환경으로 파일 복원 테스트를 실행한다.

오프라인 schema 검사와 단위 테스트는 EKS 기동·실제 EBS 복원·AWS 네트워크 검증을 대신하지 않는다.
실제 클러스터 확인 전에는 AWS 이전 완료로 표시하지 않는다.

- [EKS 노드 그룹](https://docs.aws.amazon.com/eks/latest/eksctl/nodegroups.html)
- [Kubernetes Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [EKS 요금](https://aws.amazon.com/eks/pricing/) · [EBS 요금](https://aws.amazon.com/ebs/pricing/)
