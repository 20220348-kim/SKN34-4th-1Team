import type { SupportProgramSearchReadiness } from '../../../../domain/entities/SupportProgramSearchReadiness'
import { useChatPageViewModel } from '../viewmodel/useChatPageViewModel'
import { companyConditionFields } from '../viewmodel/chatConversationProposal'
import { ConversationProposal } from './ConversationProposal'
import { ProgramResults } from './ProgramResults'
import { SearchIntroTitle } from './SearchIntroTitle'
import type { ChatSearchOptions } from '../state/chatSlice'
import {
  chatMessageBubbleClassName,
  chatMessageRowClassName,
  chatPageStyles,
} from './ChatPage.styles'

/** 공개 검색은 첫 전송 후 기존 중앙 소개에서 대화·하단 입력으로 전환하며 작업 채팅은 하단 배치를 유지합니다. */
export type ChatPageLayout = 'landing' | 'workspace'

export function ChatPage({ layout = 'landing' }: { layout?: ChatPageLayout }) {
  const {
    isRestoredHistory,
    displayProposal,
    hasConfirmedSearch,
    interpretationError,
    canRetryInterpretation,
    isInterpreting,
    isBusy,
    cancelInterpretation,
    handleConfirmInterpretation,
    handleRetryInterpretation,
    canRetrySearch,
    cancelSearch,
    composerInputRef,
    conversationCount,
    draft,
    handleCompositionEnd,
    handleCompositionStart,
    handleDraftChange,
    handleInputKeyDown,
    handleRetrySearch,
    handleSelectSuggestion,
    handleSubmit,
    isReadyToSubmit,
    messages,
    readiness,
    refetchReadiness,
    searchError,
    inputError,
    interests,
    searchOptions,
    searchStatusAnnouncement,
    suggestions,
    timelineRef,
  } = useChatPageViewModel()

  const hasReadinessNotice = readiness.isInitialLoading || readiness.isError
    || readiness.data?.searchState !== 'SEARCHABLE'
  const isLandingIntro = layout === 'landing' && conversationCount === 0
  const isDockedLanding = layout === 'landing' && !isLandingIntro
  const isGuest = layout === 'landing'

  const searchContextControls = hasConfirmedSearch ? (
    <div className={chatPageStyles.searchContextControls}>
      <p id="support-program-current-conditions" className={chatPageStyles.currentConditions}>
        적용 중인 조건: {formatSearchOptions(searchOptions)}
      </p>
    </div>
  ) : null

  const introBlock = (
    <div className={chatPageStyles.intro}>
      <SearchIntroTitle />
      <p className={chatPageStyles.introDescription}>
        회사의 지역과 업종, 필요한 지원을 알려주세요.
        <br className="max-chat:hidden" /> 관련 공고와 확인할 신청 조건을 함께 안내합니다.
      </p>
    </div>
  )

  const composerFooter = (
    <div className={isDockedLanding ? chatPageStyles.guestComposerFooter : chatPageStyles.composerFooter}>
      <small className={`${chatPageStyles.composerHint} ${isDockedLanding ? chatPageStyles.dockedComposerHint : ''}`}>
        Enter로 전송 · Shift+Enter로 줄바꿈
      </small>
    </div>
  )

  const composerInputGroup = (
      <div className={isDockedLanding ? chatPageStyles.guestComposerGroup : chatPageStyles.composerInputGroup}>
        <textarea
          ref={composerInputRef}
          className={isDockedLanding ? chatPageStyles.guestComposerInput : `${chatPageStyles.composerInput} ${isLandingIntro ? chatPageStyles.landingComposerInput : chatPageStyles.workspaceComposerInput}`}
          aria-label="지원사업 검색어"
          aria-describedby={[
            hasReadinessNotice ? 'support-program-search-readiness' : null,
            hasConfirmedSearch ? 'support-program-current-conditions' : null,
          ].filter(Boolean).join(' ') || undefined}
          value={draft}
          disabled={isInterpreting}
          onChange={handleDraftChange}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onKeyDown={handleInputKeyDown}
          placeholder={isLandingIntro
            ? '예: 서울에서 AI 서비스를 만드는 창업기업입니다. 사업화 지원을 받을 수 있을까요?'
            : isDockedLanding ? '지원사업·조건을 입력해 주세요.'
              : '찾고 싶은 지원사업이나 변경할 조건을 알려주세요.'}
          rows={isLandingIntro ? 3 : 1}
        />
        {!isDockedLanding ? composerFooter : null}
        {isBusy ? (
          <button
            key="cancel"
            type="button"
            className={isDockedLanding ? chatPageStyles.guestCancelButton : chatPageStyles.cancelSearchButton}
            onClick={(event) => {
              // 취소 후 전송 버튼으로 바뀌어도 이 클릭이 폼을 다시 제출하지 않게 합니다.
              event.preventDefault()
              cancelSearch()
            }}
          >
            취소
          </button>
        ) : (
          <button
            key="submit"
            type="submit"
            className={isDockedLanding ? chatPageStyles.guestSubmitButton : chatPageStyles.submitButton}
            aria-label="검색 전송"
            disabled={!isReadyToSubmit}
          >
            <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5m-7 7 7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
  )

  const composerErrors = inputError ? (
    <div className={chatPageStyles.searchError} role="alert">{inputError}</div>
  ) : null

  const suggestionChips = (
    <div className={chatPageStyles.suggestions} aria-label="예시 질문">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          className={chatPageStyles.suggestedQuestionButton}
          onClick={() => handleSelectSuggestion(suggestion)}
          disabled={isBusy}
        >
          {suggestion}
        </button>
      ))}
    </div>
  )

  const timeline = (
    <div
      className={
        layout === 'workspace' ? chatPageStyles.workspaceTimeline
          : isLandingIntro ? chatPageStyles.emptyTimeline : chatPageStyles.guestTimeline
      }
      ref={timelineRef}
      role="region"
      aria-label="대화 내역"
      tabIndex={isLandingIntro ? -1 : 0}
    >
      <p
        className={chatPageStyles.searchStatus}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {searchStatusAnnouncement}
      </p>
      {isRestoredHistory ? <p className="mb-3 text-center text-xs text-sample-muted">저장된 대화입니다. 공고 상태와 신청 조건은 현재 원문에서 다시 확인해 주세요.</p> : null}
      {messages.map((message, index) => {
        // 공개 첫 화면은 소개 영역이 환영 안내를 대신합니다. 대화 상태 자체는 유지합니다.
        if (layout === 'landing' && index === 0) return null
        const isUser = message.role === 'user'
        const isLatest = index === messages.length - 1
        const isCurrentFailure = isLatest && !isBusy && (
          (message.failure === 'search' && searchError === message.text)
          || (message.failure === 'interpretation' && interpretationError === message.text)
        )
        const retrySearch = isLatest && !isBusy && message.failure === 'search' && canRetrySearch
        const retryInterpretation = isLatest && !isBusy && message.failure === 'interpretation' && canRetryInterpretation

        return (
          <article
            key={message.id}
            className={isGuest ? `${chatPageStyles.guestMessageRow} ${isUser ? 'justify-end' : ''}` : chatMessageRowClassName(isUser)}
          >
            {!isUser && !isGuest ? (
              <span className={chatPageStyles.assistantAvatar}>
                G
              </span>
            ) : null}
            <div className={isGuest ? (isUser ? chatPageStyles.guestUserContent : chatPageStyles.guestAssistantContent) : chatPageStyles.messageContent}>
              <div className={`${isGuest ? (isUser ? chatPageStyles.guestUserBubble : chatPageStyles.guestAssistantBubble) : chatMessageBubbleClassName(isUser)} ${message.failure ? chatPageStyles.failureMessageBubble : ''}`}>
                {message.failure ? (
                  <p className="m-0" role={isCurrentFailure ? 'alert' : undefined}>{message.text}</p>
                ) : message.text}
                {retrySearch || retryInterpretation ? (
                  <div className={chatPageStyles.messageActions}>
                    <button type="button" className={chatPageStyles.messageRetryButton}
                      onClick={retrySearch ? handleRetrySearch : handleRetryInterpretation}>
                      {retrySearch ? '다시 검색' : '다시 해석'}
                    </button>
                  </div>
                ) : null}
              </div>
              {message.searchOptions && isUser ? (
                <div>
                  <p className={chatPageStyles.searchSnapshot}>검색 당시 조건: {formatSearchOptions(message.searchOptions)}</p>
                  {message.searchQuery ? <p className={chatPageStyles.searchSnapshot}>확인한 검색 의도: {message.searchQuery}</p> : null}
                </div>
              ) : null}
              {layout === 'workspace' && message.id === messages[0]?.id ? (
                <div className={chatPageStyles.suggestedQuestions}>
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className={chatPageStyles.suggestedQuestionButton}
                      onClick={() => handleSelectSuggestion(suggestion)}
                      disabled={isBusy}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              ) : null}
              {message.programs?.length ? (
                <ProgramResults programs={message.programs} totalCount={message.totalCount} resultToken={message.resultToken} interests={interests} />
              ) : null}
            </div>
          </article>
        )
      })}
      {isBusy ? (
        <div className={chatPageStyles.messageRow}>
          {!isGuest ? <span className={chatPageStyles.assistantAvatar}>G</span> : null}
          <div className={chatPageStyles.searchingBubble} role="group"
            aria-label={isInterpreting ? '조건 해석 진행 중' : '지원사업 검색 진행 중'}>
            <div className={chatPageStyles.loadingHeader}>
              <strong className={chatPageStyles.loadingLabel}>{isInterpreting ? '조건 해석 중' : '지원사업 검색 중'}</strong>
              <span className={chatPageStyles.loadingDots} aria-hidden="true">
                {[0, 160, 320].map((delay) => (
                  <span key={delay} className={chatPageStyles.loadingDot} style={{ animationDelay: `${delay}ms` }} />
                ))}
              </span>
            </div>
            <p className={chatPageStyles.loadingDescription}>
              {isInterpreting ? '조건 변경안을 해석하고 있어요. 아직 검색하지 않았습니다…' : '공고를 찾아보고 있어요…'}
            </p>
            <div className={chatPageStyles.loadingTrack} aria-hidden="true">
              <span className={chatPageStyles.loadingSweep} />
            </div>
          </div>
        </div>
      ) : null}
      {displayProposal ? (
        <ConversationProposal proposal={displayProposal}
          onConfirm={handleConfirmInterpretation} onCancel={cancelInterpretation} />
      ) : null}
    </div>
  )

  const readinessNotice = (
    <SupportProgramSearchReadinessNotice
      readiness={readiness.data}
      isError={readiness.isError}
      isInitialLoading={readiness.isInitialLoading}
      isRefreshing={readiness.isRefreshing}
      onRetry={refetchReadiness}
    />
  )

  if (layout === 'workspace') {
    // 로그인 뒤의 작업 화면은 대화와 하단 입력창으로 구성합니다.
    return (
      <main className={chatPageStyles.workspacePage}>
        <h1 className="sr-only">지원사업 채팅</h1>
        <section className={chatPageStyles.workspaceShell}>
          {timeline}
          <form className={chatPageStyles.composerWorkspace} onSubmit={handleSubmit}>
            {readinessNotice}
            {searchContextControls}
            {composerInputGroup}
            {composerErrors}
          </form>
        </section>
      </main>
    )
  }

  return (
    <main className={chatPageStyles.page} data-guest-chat>
      <section className={`${chatPageStyles.workspace} ${isLandingIntro ? chatPageStyles.introWorkspace : chatPageStyles.conversationWorkspace}`}>
        {isLandingIntro ? introBlock : <h1 className="sr-only">지원사업 채팅</h1>}
        {timeline}
        {/* 같은 폼·입력 노드를 유지하여 전환 중 요청 수명과 한글 입력 상태를 보존합니다. */}
        <form className={isLandingIntro ? chatPageStyles.composer : chatPageStyles.guestComposerDock} onSubmit={handleSubmit}>
          {!isLandingIntro ? readinessNotice : null}
          {searchContextControls}
          {composerInputGroup}
          {composerErrors}
          {isDockedLanding ? composerFooter : null}
          {isDockedLanding ? <small className={chatPageStyles.guestDisclaimer}>
            AI 답변은 참고용입니다. 최종 신청 조건은 공고 원문에서 확인하세요.
          </small> : null}
        </form>
        {isLandingIntro ? suggestionChips : null}
        {isLandingIntro ? <p className={chatPageStyles.sourceHint}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Z" /><path d="m8 12 3 3 5-6" />
          </svg>
          최종 신청 조건은 원문에서 확인하세요.
        </p> : null}
        {isLandingIntro ? readinessNotice : null}
      </section>
    </main>
  )
}

type SupportProgramSearchReadinessNoticeProps = {
  readiness: SupportProgramSearchReadiness | undefined
  isError: boolean
  isInitialLoading: boolean
  isRefreshing: boolean
  onRetry: () => void
}

function SupportProgramSearchReadinessNotice({
  readiness,
  isError,
  isInitialLoading,
  isRefreshing,
  onRetry,
}: SupportProgramSearchReadinessNoticeProps) {
  if (isInitialLoading) {
    return (
      <section
        id="support-program-search-readiness"
        className={chatPageStyles.readinessNotice}
        aria-live="polite"
        aria-atomic="true"
      >
        공고 데이터 상태를 확인하고 있습니다.
      </section>
    )
  }

  if (isError || !readiness) {
    return (
      <section
        id="support-program-search-readiness"
        className={chatPageStyles.readinessErrorNotice}
        role="alert"
      >
        <span>공고 데이터 상태를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.</span>
        <button
          type="button"
          className={chatPageStyles.readinessRetryButton}
          onClick={onRetry}
          disabled={isRefreshing}
        >
          {isRefreshing ? '확인 중…' : '상태 다시 확인'}
        </button>
      </section>
    )
  }

  const message = getReadinessNoticeMessage(readiness)
  if (message === null) return null
  const isUnavailable = readiness.searchState === 'UNAVAILABLE'

  return (
    <section
      id="support-program-search-readiness"
      className={isUnavailable
        ? chatPageStyles.readinessErrorNotice
        : chatPageStyles.readinessNotice}
      role={isUnavailable ? 'alert' : undefined}
      aria-live={isUnavailable ? undefined : 'polite'}
    >
      <span>{message}</span>
      {isUnavailable || readiness.searchState === 'SEARCHABLE_WITH_PARTIAL_SOURCES' ? (
        <button
          type="button"
          className={chatPageStyles.readinessRetryButton}
          onClick={onRetry}
          disabled={isRefreshing}
        >
          {isRefreshing ? '확인 중…' : '상태 다시 확인'}
        </button>
      ) : null}
    </section>
  )
}

function getReadinessNoticeMessage(readiness: SupportProgramSearchReadiness) {
  switch (readiness.searchState) {
    case 'PREPARING':
      return '공고를 준비하고 있습니다. 잠시만 기다려 주세요.'
    case 'SEARCHABLE':
      return null
    case 'SEARCHABLE_WITH_SYNC_FAILURE':
      return '최신 공고를 불러오지 못해 이전에 저장한 공고에서 검색합니다.'
    case 'SEARCHABLE_WITH_PARTIAL_SOURCES':
      return '일부 제공처의 공고만 검색할 수 있습니다.'
    case 'UNAVAILABLE':
      return '현재 공고 데이터를 검색할 수 없습니다. 잠시 후 다시 확인해 주세요.'
  }
}

function formatSearchOptions(options: ChatSearchOptions) {
  const conditions = companyConditionFields.flatMap((field) => {
    const value = options.companyConditions?.[field.key]
    return value ? [`${field.label}: ${value}`] : []
  })
  return [options.acceptingOnly ? '접수 중만' : '접수 상태: 전체', ...conditions,
    ...(conditions.length ? [] : ['기업 조건 미입력'])].join(' · ')
}
