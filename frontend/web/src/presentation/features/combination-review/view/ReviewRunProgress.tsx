import type { RunStatus } from '../../../../domain/entities/CombinationReview'
import { WorkProgress } from '../../../shared/workspace/WorkProgress'
import { reviewStyles as s } from './CombinationReview.styles'

/**
 * 접수한 중복 검토 분석의 진행 카드입니다. 신청 문서의 양식 분석 · 초안 진행 카드와 같은 틀(공용 `WorkProgress`)로
 * 서버가 주는 상태(대기 · 분석 중)와 접수 뒤 지난 시간만 보여 주고, 세부 단계나 남은 · 예상 시간은 지어내지 않습니다.
 * 검토 입력 화면은 상태 바뀜을 따로 알리므로 [live]를 끄고, 검토 결과 화면은 이 카드가 상태를 알립니다.
 */
export function ReviewRunProgress({ status, elapsedSeconds, note, live = false }: {
  status: RunStatus; elapsedSeconds: number | null; note: string; live?: boolean
}) {
  const running = status === 'RUNNING'
  return <WorkProgress label="분석 진행" live={live} elapsedSeconds={elapsedSeconds} note={note}
    title={running ? '공식 문서를 읽고 단계별로 판단하고 있어요' : '분석 차례를 기다리고 있어요'}>
    <ol className={s.progressSteps} aria-label="진행 단계">
      <li className={running ? s.progressStepDone : s.progressStepNow} aria-current={running ? undefined : 'step'}>{running ? '✓ 접수 · 대기' : '● 접수 · 대기 중'}</li>
      <li className={running ? s.progressStepNow : s.progressStep} aria-current={running ? 'step' : undefined}>{running ? '● 원문 수집 · 분석 중' : '원문 수집 · 분석'}</li>
    </ol>
  </WorkProgress>
}
