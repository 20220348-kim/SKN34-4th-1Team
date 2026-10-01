# 리뷰 승인 0명과 필수 CI 병합 조건

PR 리뷰 승인 수는 **0명**으로 유지한다. 필수 CI 성공과 리뷰 승인은 서로 다른 조건이다.
이미지 발행 가드는 병합을 차단하지 않으므로 GitHub의 실제 활성 ruleset이 필요하다.
이 코드 변경만으로 원격 보호가 설정됐다고 판단하지 않는다.

## 필수 검증

[ci_policy.py](../infrastructure/release/ci_policy.py)가 다섯 workflow의 기존 16개 작업과
다음 다섯 종합 판정의 이름을 관리한다. 이미지 발행의 [gate.py](../infrastructure/release/gate.py)도
같은 목록을 사용한다. 필수 검증은 총 **21개**다.

| workflow | 종합 판정 |
|---|---|
| `ci.yml` | `Required CI / GovBiz` |
| `catalog-ci.yml` | `Required CI / Catalog` |
| `ops-ci.yml` | `Required CI / Ops` |
| `infra-ci.yml` | `Required CI / Infra` |
| `llmops-ci.yml` | `Required CI / LLMOps` |

각 종합 job은 `always()`로 실행하고 모든 선행 작업이 `success`일 때만 성공한다.
실패·취소·건너뛰기·필수 작업 누락은 실패다. GitHub가 개별 skipped check를 병합 허용으로
취급할 수 있으므로 종합 판정이 필요하다. 기존 16개 작업도 필수로 유지해 재실행 중인 작업을
이전 종합 판정 성공만으로 통과시키지 않는다. workflow 전체가 시작되지 않으면 새 SHA의
필수 check가 없으므로 병합은 대기한다. 작업 이름·matrix·의존관계 변경은 정책 테스트로 확인한다.

## 실제 규칙 적용과 확인

저장소 루트에서 GitHub CLI의 기존 인증을 사용한다. 관리 권한과 `api.github.com` 접근이 필요하다.
토큰을 명령 인자·Git·채팅에 넣지 않는다. 아래 도구는 원격 설정을 변경하지 않는다.

```bash
python3 -B infrastructure/release/merge_protection.py check \
  --repository ilil1/SKN34-4th-1Team --branch main

mkdir -p work/merge-protection
python3 -B infrastructure/release/merge_protection.py ruleset \
  --repository ilil1/SKN34-4th-1Team --branch main \
  > work/merge-protection/ruleset.json
```

JSON은 `main`에만 적용하는 전용 ruleset이다. PR 경로·리뷰 0명·최신 base 반영·GitHub Actions 앱에
묶인 21개 check·빈 bypass 목록을 포함한다. 별도 배포 브랜치를 만들지 않는다.
기존 deletion/non-fast-forward 규칙이나 조직 규칙은 삭제·교체하지 않는다.

1. 이 변경을 포함한 PR에서 다섯 종합 판정이 실제 생성되는지 먼저 확인한다.
2. **Settings → Rules → Rulesets**에서 JSON을 가져오거나 같은 전용 ruleset을 설정한다.
   동명 ruleset이 있으면 수정하며 중복 생성하지 않는다. 대상 `main`, `Active`, 승인 0명,
   필수 check 21개, strict, bypass 없음이 검토 대상이다.
3. 위 `check`를 다시 실행한다. 활성 branch rules와 원본 ruleset, 기존 branch protection까지 조회한다.
   다른 조직·저장소 규칙이 리뷰를 요구하거나 우회를 허용하면 보고하며 자동으로 약화하지 않는다.
4. 시험 PR에서 필수 작업 실패/실행 중에는 병합할 수 없고, 최신 SHA의 21개 check가 성공한 뒤에는
   리뷰 승인 없이 병합 가능한지 확인한다. 시험용 실패를 기본 브랜치에 병합하지 않는다.
   재실행·새 커밋·base 변경도 확인하고 PR URL, head/base SHA, check run과 규칙 ID를 기록한다.

종료 코드 `0`은 **규칙 구성 확인**, `1`은 정책 불일치, `2`는 접근·증거 부족으로 **UNKNOWN**이다.
403/404를 보호 없음이나 성공으로 바꾸지 않는다. 우회 목록을 볼 수 없는 경우도 UNKNOWN이다.
`merge_behavior_verified=false`는 시험 PR의 실제 병합 차단까지 실행하지 않았다는 뜻이다.

관리자·앱·팀의 bypass 항목이 없어도 관리자는 규칙 자체를 수정할 수 있다. 병합 우회 권한과
규칙 편집 권한을 구별해 기록하고, 조직 소유 저장소의 상위 규칙은 해당 관리자와 확인한다.

공식 계약: [필수 상태 검사](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging),
[ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets),
[branch rules API](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch),
[job 의존성](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds).

이번 클라우드 작업에서는 GitHub API가 403으로 차단되어 실제 규칙·우회 권한·최신 CI 상태를
확정하지 못했다. 과거 ruleset 기록을 현재 상태로 재사용하지 않는다. 원격 적용과 시험 PR 검증은 남아 있다.
