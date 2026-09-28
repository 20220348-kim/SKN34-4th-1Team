import { type FormEvent, useEffect, useRef } from 'react'

import type { SupportProgramIdentity } from '../../../../domain/repositories/SupportProgramRepository'
import { useEvidenceQuestionThread } from '../viewmodel/useEvidenceQuestionThread'
import { maximumSupportProgramEvidenceQuestionLength } from '../viewmodel/useSupportProgramEvidenceQuestionViewModel'
import { EvidenceQuestionFeedback } from './EvidenceQuestionFeedback'
import { supportProgramEvidenceQuestionStyles as q } from './SupportProgramEvidenceQuestionPage.styles'

/**
 * 공고 상세 안의 원문 질문 패널입니다. 넓은 화면은 오른쪽 할 일 카드 자리(400px)에, 좁은 화면은 아래 시트로 열려
 * 본문을 읽으면서 묻고 근거를 대조할 수 있습니다. 위에서 아래로 안내 → 질문·답 목록 → (빈 상태면 자주 묻는 질문) → 입력입니다.
 * 열리면 입력에 포커스가 가고, Esc로 닫습니다.
 */
export function EvidenceQuestionPanel({ identity, onClose }: { identity: SupportProgramIdentity; onClose: () => void }) {
  const thread = useEvidenceQuestionThread(identity)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const isTooLong = thread.questionLength > maximumSupportProgramEvidenceQuestionLength
  const isValidationFailed = thread.inlineState.status === 'validation-failed'

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 답이 올 때마다 목록 끝이 보이게 합니다.
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [thread.turns.length, thread.state.status])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void thread.submitQuestion()
  }

  return (
    <section
      id="support-program-ask"
      className={q.panel}
      aria-labelledby="support-program-ask-title"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
    >
      <div className={q.panelHeader}>
        <div className={q.panelHeading}>
          <h2 id="support-program-ask-title" className={q.panelTitle}>원문에 질문하기</h2>
          <span className={q.evidenceBadge}>근거 답변</span>
        </div>
        <button type="button" className={q.panelClose} onClick={onClose} aria-label="질문 패널 닫기" title="닫기">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <p className={q.panelDescription}>이 공고 원문에 있는 내용만 근거로 답해요. 최종 신청 조건은 원문 공고에서 다시 확인해 주세요.</p>

      <div className={q.panelThread} aria-live="polite">
        {thread.turns.map((turn) => (
          <div key={turn.id} className={q.panelTurn}>
            <p className={q.panelQuestion}>{turn.question}</p>
            <EvidenceQuestionFeedback state={turn.state} compact />
          </div>
        ))}
        {thread.state.status === 'loading' ? <p className={q.panelQuestion}>{thread.question}</p> : null}
        <EvidenceQuestionFeedback state={thread.inlineState} compact />
        {thread.showSuggestions ? (
          <div className={q.panelSuggestions} role="group" aria-label="예시 질문">
            <span className={q.panelSuggestionsLead}>예시</span>
            {thread.suggestions.map((suggestion) => (
              <button key={suggestion.label} type="button" className={q.panelSuggestion} onClick={() => { thread.updateQuestion(suggestion.question); inputRef.current?.focus() }}>
                {suggestion.label}
              </button>
            ))}
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      <form className={q.panelForm} onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="support-program-ask-question">공고 원문에 질문하기</label>
        <textarea
          ref={inputRef}
          id="support-program-ask-question"
          className={q.panelInput}
          aria-describedby={`support-program-ask-count${isTooLong ? ' support-program-ask-length-error' : ''}`}
          aria-invalid={isValidationFailed || isTooLong}
          disabled={thread.isAnswering}
          value={thread.question}
          onChange={(event) => thread.updateQuestion(event.target.value)}
          onKeyDown={(event) => {
            // Enter는 보내기, Shift+Enter는 줄바꿈입니다.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (thread.canSubmit) void thread.submitQuestion()
            }
          }}
          placeholder="예: 신청 대상과 제출해야 하는 서류를 알려줘"
          rows={2}
        />
        <div className={q.panelControls}>
          <span id="support-program-ask-count" className={q.evidenceCount}>
            {thread.questionLength} / {maximumSupportProgramEvidenceQuestionLength}자
          </span>
          {thread.isAnswering ? (
            <button type="button" className={q.evidenceCancelButton} onClick={thread.cancelQuestion}>질문 취소</button>
          ) : (
            <button type="submit" className={q.evidenceSubmitButton} disabled={!thread.canSubmit}>질문하고 근거 받기</button>
          )}
        </div>
        {isTooLong ? (
          <p id="support-program-ask-length-error" className={q.evidenceErrorCompact} role="alert">
            질문은 {maximumSupportProgramEvidenceQuestionLength}자 이하로 입력해 주세요.
          </p>
        ) : null}
      </form>
    </section>
  )
}
