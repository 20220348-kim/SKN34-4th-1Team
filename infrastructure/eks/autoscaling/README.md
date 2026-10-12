# 기존 두 노드와 자동 확장

AWS 무료 플랜을 유지하며 `m7i-flex.large` 두 대를 기본으로 사용한다.
`application` 풀은 최소 1 / 최대 2대, `observability` 풀은 1대로 고정하여 전체 EC2는
**최소 2 / 최대 3대**다. `node-pool.yaml`은 기존 풀에 대한 Cluster Autoscaler의
Pod Identity 역할만 만든다. 노드·VPC·업무 데이터 볼륨은 생성하지 않는다.

## 용량과 비용

2026-10-12 두 노드의 합산 사용량은 CPU 약 0.35~0.39코어, 메모리 약 7.8GiB였다.
이는 관측 시점의 사용량이며 최대 부하 측정이 아니다. 8GiB 한 대에는 여유가 부족하다.
16GiB 한 대로 통합하려 했지만 현재 계정의 Free plan이 인스턴스 생성을 차단했다.
사용자 결정에 따라 유료 플랜 전환 없이 기존 두 대를 유지한다.

시드니 Linux 온디맨드 조회값으로 두 대는 시간당 $0.2394, 세 대는 $0.3591이다.
EKS·ALB·NAT·데이터 EBS 비용은 별도이며 크레딧 잔액과 실제 청구액은 다를 수 있다.
이 구성은 기본 두 대의 비용을 절감하지 않는다. 추가 한 대는 필요할 때만 사용한다.

## 확장 경로

`CPU 사용 증가 → HPA가 API Pod 증가 → 자원 요청을 수용할 노드 부족 → Cluster Autoscaler가 EC2 추가`

- API Gateway·Core·AI: CPU 요청량 대비 60%, Pod 최소 1 / 최대 3.
- Core·AI CPU 요청은 기존 운영값인 각각 100m를 유지한다. CPU 사용 상한과 다른 값이며,
  HPA·스케줄러·노드 확장이 동일한 요청량을 사용한다. 기존 100m를 200m로 늘리면 총합이
  두 노드 용량 안이어도 개별 노드의 빈 공간에 배치되지 않아 세 번째 노드가 상시 필요해진다.
- 두 기존 노드 그룹에 `govbiz.io/http-pool=shared` 라벨을 추가한다. Gateway·Core·AI만
  이 라벨로 배치하며, 새 application 노드에도 EKS가 같은 라벨을 부여한다.
- Catalog·Ops·평가·DB·Langfuse는 단일 실행과 기존 역할별 배치를 유지한다.
  PVC 이동이나 DB 재배치는 하지 않는다. 평가 실행기와 결과 서버의 동일 호스트 affinity도 유지한다.
- Catalog·Ops는 각각 `catalog-mysql`·`ops-mysql`과 같은 노드에 배치한다. 기존 노드와
  추가 노드가 같은 application 라벨을 사용하므로 라벨만으로 제한하면 이 두 단일 실행
  서비스가 추가 노드에 남고 PDB가 축소를 막는다. DB Pod를 기준으로 배치하여 특정 EC2의
  호스트명을 고정하지 않고 추가 노드의 회수를 가능하게 한다. 재배치는 기존 Recreate
  배포에서 수행하며, 중복 writer 생성이나 PDB 완화를 사용하지 않는다.
- 기존 Metrics Server와 Cluster Autoscaler 1.36.0을 사용하며 EKS Auto Mode를 켜지 않는다.
  클러스터 minor 버전 변경 시 Autoscaler도 함께 검토한다.
- Autoscaler는 고정된 observability 노드에서 실행한다. `pdb.yaml`의 `minAvailable: 1`은
  application 풀의 영속·단일 실행 Pod 12개의 자발적 퇴거를 차단한다. DB를 재시작하지 않고
  보호하며, 직접 Pod 삭제나 노드 장애를 막는 기능은 아니다.
- HPA는 5분 안정화 후 한 번에 Pod 1개씩 줄인다. 노드는 10분의 축소 대기 시간을 둔다.
- CPU 기반 확장은 OpenAI 응답 대기·DB 병목·요청 수 자체를 측정하지 않는다. CPU 증가 없이
  지연만 늘어나는 경우는 이 HPA의 대상이 아니다.
- Core의 검색 admission과 로그인 시도 제한은 프로세스별이다. 복제 수 증가만큼 전체
  허용량이 늘어나며 전역 사용자 한도로 간주하지 않는다.
- 데이터 저장소는 단일 복제·같은 AZ의 EBS 구성이다. 이 변경은 DB 고가용성을 제공하지 않는다.

## 적용 순서

1. 현재 Deployment·StatefulSet·PVC/PV·Argo Application을 비공개 작업 폴더에 보관한다.
   Secret 값이나 환경변수가 담긴 파일은 Git·이슈·CI artifact에 올리지 않는다.
2. 자원 사용량과 요청량을 확인한다. 기존 `application` 노드 그룹은 min 1 / max 2로,
   `observability`는 min 1 / max 1로 유지한다. 이후 갱신에서 `desiredSize`를 반복 지정하여
   Autoscaler가 정한 현재 크기를 덮어쓰지 않는다.
3. 두 노드 그룹의 EKS managed labels에 `govbiz.io/http-pool=shared`를 추가한다.
   기존 `govbiz.io/workload-pool` 라벨은 유지한다.
4. `node-pool.yaml`을 CloudFormation으로 생성하여 Pod Identity를 연결한다. 현재 계정에
   이미 같은 ServiceAccount의 연결이 있다면 중복 생성하지 않고 해당 스택을 갱신한다.
5. `aws eks describe-nodegroup`으로 application ASG 이름을 확인하고 아래 태그를
   **ASG에 직접** 적용한다. EKS Nodegroup 태그만으로는 전파되지 않는다.

   | ASG 태그 | 값 |
   |---|---|
   | `k8s.io/cluster-autoscaler/enabled` | `true` |
   | `k8s.io/cluster-autoscaler/govbiz-eks` | `owned` |
   | `govbiz.io/workload-pool` | `application` |

   IAM 변경 권한은 세 태그를 모두 가진 ASG에만 부여한다. observability ASG에는 붙이지 않는다.
6. `kubectl apply -f infrastructure/eks/autoscaling/pdb.yaml`로 단일 실행 Pod를 보호한다.
   기존 PVC나 Pod template을 변경하지 않는다. `cluster-autoscaler.yaml`을 적용하고
   Pod Identity 인증·ASG 발견을 확인한다. 수동 drain 때도 PDB를 존중하며 강제로 무시하지 않는다.
7. 전환 중 배포 workflow를 잠시 보류한다. Argo 비공개 Kustomize patch에서는 Core·AI만
   공용 HTTP 라벨로 바꾸고 Core graceful shutdown 환경값도 반영한다.
   `/spec/replicas` 무시는 Core·AI에만 적용하고 `RespectIgnoreDifferences=true`를 유지한다.
8. 변경 커밋의 필수 CI가 통과한 뒤 자동 배포한다. 이미지·설정·단일 실행 서비스 검증은 유지한다.
9. API Gateway는 `kubectl apply -k infrastructure/eks/api-gateway`로 갱신한다.
   HPA 적용 후 `replicas`를 수동 고정하지 않는다. 기존 ALB·Ingress·Secret을 유지한다.
10. 서비스 준비·기존 PVC 13개 Bound·운영 API 응답을 확인한다. 유료 모델 호출 없이 제한된
    부하로 HPA를 확인하고, 임시 Pod로 노드 자동 생성·축소를 확인한 뒤 테스트 자원을 제거한다.
    합성 검증은 실제 사용자 트래픽의 성능 보장이 아니다.
11. 배포 workflow·Argo 자동 동기화 상태를 확인하고 작업용 임시 EKS 접속 주소를 제거한다.

## 복구

HPA와 Autoscaler를 먼저 정지하고 Core·AI·Gateway를 각각 1개로 되돌린다.
저장해 둔 selector와 Argo runtime patch를 복구한 뒤 준비 상태를 확인한다.
추가 application 노드에 업무 Pod가 없는지 확인한 후 해당 풀을 min/max/desired 1로 되돌린다.
기존 두 노드 그룹의 역할·런치 템플릿·PVC를 삭제하지 않는다.

## 확인 명령

```sh
kubectl get nodes -L govbiz.io/workload-pool,govbiz.io/http-pool
kubectl top nodes
kubectl -n govbiz-msa get hpa
kubectl -n kube-system get configmap cluster-autoscaler-status -o yaml
kubectl get pvc -A
kubectl -n argocd get application govbiz-eks
```

[AWS 노드 자동 확장](https://docs.aws.amazon.com/eks/latest/userguide/autoscaling.html) ·
[기존 시드니 배치](../sydney-demo.md) · [Argo 배포 흐름](../argo-cd.md)
