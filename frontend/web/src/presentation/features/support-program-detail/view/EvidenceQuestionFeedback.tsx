import type { SupportProgramEvidenceQuestionState } from '../viewmodel/useSupportProgramEvidenceQuestionViewModel'
import { supportProgramEvidenceQuestionStyles as s } from './SupportProgramEvidenceQuestionPage.styles'

/**
 * 원문 질문 한 건의 결과입니다. 답이 오면 답변과 근거 인용을, 아니면 상태에 맞는 안내를 보여 줍니다.
 * 원문 질문 화면과 공고 상세의 질문 패널이 같은 부품을 씁니다.
 */
export function EvidenceQuestionFeedback({ state, compact = false }: { state: SupportProgramEvidenceQuestionState; compact?: boolean }) {
  if (state.status === 'idle') return null

  if (state.status === 'loading') {
    return (
      <p className={compact ? s.evidenceFeedbackCompact : s.evidenceFeedback} role="status" aria-live="polite">
        공고 원문에서 답변 근거를 찾고 있습니다.
      </p>
    )
  }

  if (state.status === 'answered') {
    return (
      <article className={compact ? s.evidenceAnswerCompact : s.evidenceAnswer} aria-live="polite">
        <p className={s.evidenceAnswerEyebrow}>원문 근거 답변</p>
        <p className={s.evidenceAnswerText}>{state.answer.answer}</p>
        <h2 className={s.evidenceCitationTitle}>답변 근거</h2>
        <ol className={s.evidenceCitationList}>
          {state.answer.citations.map((citation, index) => (
            <li key={`${citation.chunkOrder}:${citation.sourceUrl}:${citation.excerpt}`} className={s.evidenceCitation}>
              <blockquote className={s.evidenceExcerpt}>{citation.excerpt}</blockquote>
              <a className={s.evidenceSourceLink} href={citation.sourceUrl} target="_blank" rel="noreferrer">
                근거 {index + 1} 원문 보기 ↗
              </a>
            </li>
          ))}
        </ol>
      </article>
    )
  }

  if (state.status === 'validation-failed' || state.status === 'rate-limited' || state.status === 'busy') {
    return <p className={compact ? s.evidenceErrorCompact : s.evidenceError} role="alert">{state.message}</p>
  }

  const message = evidenceFeedbackMessage(state.status)
  const isFailure = state.status === 'failed' || state.status === 'unavailable' || state.status === 'timed-out'
  const className = isFailure
    ? (compact ? s.evidenceErrorCompact : s.evidenceError)
    : (compact ? s.evidenceFeedbackCompact : s.evidenceFeedback)
  return (
    <p className={className} role={isFailure ? 'alert' : 'status'} aria-live="polite">
      {message}
    </p>
  )
}

function evidenceFeedbackMessage(
  status: Exclude<SupportProgramEvidenceQuestionState['status'], 'idle' | 'loading' | 'answered' | 'validation-failed' | 'rate-limited' | 'busy'>,
) {
  const messages = {
    cancelled: '질문 요청을 취소했습니다.',
    'timed-out': '답변 시간이 초과되었습니다. 입력한 질문을 다시 전송해 주세요.',
    'insufficient-evidence': '공고 원문에서 이 질문에 답할 만큼 충분한 근거를 찾지 못했습니다. 원문 공고를 확인해 주세요.',
    'not-supported': '이 제공처 공고는 아직 원문 근거 답변을 지원하지 않습니다. 원문 공고에서 확인해 주세요.',
    unavailable: '원문 근거 답변을 지금 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    failed: '질문에 답하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  } as const
  return messages[status]
}
