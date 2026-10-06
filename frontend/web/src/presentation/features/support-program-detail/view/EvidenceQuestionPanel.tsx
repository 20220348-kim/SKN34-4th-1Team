import { type FormEvent, useEffect, useRef } from 'react'

import type { SupportProgramIdentity } from '../../../../domain/repositories/SupportProgramRepository'
import { assistantCover } from '../../../shared/assistant/assistantPlacement'
import { useEvidenceQuestionThread } from '../viewmodel/useEvidenceQuestionThread'
import { maximumSupportProgramEvidenceQuestionLength } from '../viewmodel/useSupportProgramEvidenceQuestionViewModel'
import { EvidenceQuestionFeedback } from './EvidenceQuestionFeedback'
import { supportProgramEvidenceQuestionStyles as q } from './SupportProgramEvidenceQuestionPage.styles'

/**
 * 공고 상세 위에 겹쳐 열리는 원문 질문 옆 패널입니다(화면 통일안 17). 넓은 화면은 오른쪽 400px 패널로 상세를 가리지 않고,
 * 좁은 화면은 아래 시트(최대 86%)가 됩니다. 머리(제목 · 공고 이름 · ✕) → 본문 스크롤(안내 · 질문·답 · 예시 · 입력) → 바닥([취소][질문 보내기]).
 * 열리면 입력에 포커스가 가고, Esc로 닫습니다. 답을 기다리는 중의 [취소]는 패널을 닫지 않고 요청만 멈춥니다.
 */
export function EvidenceQuestionPanel({ identity, programTitle, onClose }: {
  identity: SupportProgramIdentity
  programTitle: string
  onClose: () => void
}) {
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
    <form
      id="support-program-ask"
      className={q.panel}
      role="region"
      aria-labelledby="support-program-ask-title"
      // 오른쪽 옆 패널(좁은 화면은 아래 시트)이 도우미 런처 자리와 [질문 보내기]를 덮으므로 열려 있는 동안 런처를 숨깁니다.
      {...assistantCover.always}
      onSubmit={handleSubmit}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
    >
      <header className={q.panelHeader}>
        <span className={q.panelGrab} aria-hidden="true" />
        <div className={q.panelHeading}>
          <h2 id="support-program-ask-title" className={q.panelTitle}>원문에 질문하기</h2>
          <p className={q.panelSubtitle}>{programTitle}</p>
        </div>
        <button type="button" className={q.panelClose} onClick={onClose} aria-label="질문 패널 닫기" title="닫기">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>

      <div className={q.panelBody}>
        <p className={q.panelDescription}>공고 원문에 있는 내용만 근거로 답해요. 최종 신청 조건은 원문에서 다시 확인해 주세요.</p>

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

        <div className={q.panelField}>
          <label className={q.panelLabel} htmlFor="support-program-ask-question">질문</label>
          <textarea
            ref={inputRef}
            id="support-program-ask-question"
            className={q.panelInput}
            aria-label="공고 원문에 질문하기"
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
            rows={3}
          />
          <span id="support-program-ask-count" className={q.evidenceCount}>
            {thread.questionLength} / {maximumSupportProgramEvidenceQuestionLength}자 · Shift+Enter로 줄바꿈
          </span>
          {isTooLong ? (
            <p id="support-program-ask-length-error" className={q.evidenceErrorCompact} role="alert">
              질문은 {maximumSupportProgramEvidenceQuestionLength}자 이하로 입력해 주세요.
            </p>
          ) : null}
        </div>
      </div>

      <footer className={q.panelFooter}>
        {/* 답을 기다리는 중의 취소는 요청만 멈추고, 그 밖에는 패널을 닫습니다. */}
        <button type="button" className={q.panelGhostButton} onClick={thread.isAnswering ? thread.cancelQuestion : onClose}>취소</button>
        <button type="submit" className={q.panelSubmitButton} disabled={thread.isAnswering || !thread.canSubmit} aria-busy={thread.isAnswering}>
          {thread.isAnswering ? (
            <>
              <span className={q.panelSpinner} aria-hidden="true" />
              답변 찾는 중…
            </>
          ) : '질문 보내기'}
        </button>
      </footer>
    </form>
  )
}
