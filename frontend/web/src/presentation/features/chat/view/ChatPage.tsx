import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link, matchPath, useNavigate } from 'react-router'

import { useAppSelector } from '../../../../app/hooks'
import { useChatSheetClosedCount, useChatSheetLocation } from '../../../shared/chat-sheet/useChatSheet'
import type { SupportProgramSearchReadiness } from '../../../../domain/entities/SupportProgramSearchReadiness'
import { PlanUsageLine } from '../../../shared/plan-usage/PlanUsageLine'
import { appPaths } from '../../../shared/routes/appPaths'
import { continueLabel, preparationPath, programKey, useProgramPreparations } from '../hooks/useProgramPreparations'
import { useChatPageViewModel } from '../viewmodel/useChatPageViewModel'
import { companyConditionFields } from '../viewmodel/chatConversationProposal'
import { ConversationProposal } from './ConversationProposal'
import { ProgramResults } from './ProgramResults'
import { GovApplicationCard, GovPartnerBrief, GovReviewCard } from './GovWork'
import { EvidenceQuestionFeedback } from '../../support-program-detail/view/EvidenceQuestionFeedback'
import { ZeroResultHelp } from './ZeroResultHelp'
import { SearchIntroTitle } from './SearchIntroTitle'
import { govToolTexts, type ChatSearchOptions, type GovAgentTool } from '../state/chatSlice'
import {
  chatMessageBubbleClassName,
  chatMessageRowClassName,
  chatPageStyles,
} from './ChatPage.styles'

/** 공개 검색은 첫 전송 후 기존 중앙 소개에서 대화·하단 입력으로 전환하며 작업 채팅은 하단 배치를 유지합니다. */
export type ChatPageLayout = 'landing' | 'workspace'

export function ChatPage({ layout = 'landing' }: { layout?: ChatPageLayout }) {
  const accountEmail = useAppSelector((state) => state.auth.account?.email)
  const {
    isGovAgent,
    govProgram,
    selectGovProgram,
    attachGovReview,
    evidenceUsage,
    govQuickQuestions,
    handleAskGovQuestion,
    govPendingQuestion,
    setReturnToGovChat,
    govTools,
    handleStartGovTool,
    isRestoredHistory,
    displayProposal,
    interpretationError,
    canRetryInterpretation,
    isInterpreting,
    isBusy,
    cancelInterpretation,
    handleConfirmInterpretation,
    handleRetryInterpretation,
    handleClarificationInput,
    handleQuickReply,
    zeroResultHelp,
    handleSearchRelaxation,
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
    searchStatusAnnouncement,
    suggestions,
    timelineRef,
    aiSearchUsage,
  } = useChatPageViewModel()

  // 처음 상태 확인 중과 최신 동기화 실패 안내는 깜빡여 보여 숨겼으므로 접근성 참조도 걸지 않습니다.
  // const hasReadinessNotice = readiness.isInitialLoading || readiness.isError
  //   || readiness.data?.searchState !== 'SEARCHABLE'
  const hasReadinessNotice = !readiness.isInitialLoading && (readiness.isError
    || (readiness.data?.searchState !== 'SEARCHABLE'
      && readiness.data?.searchState !== 'SEARCHABLE_WITH_SYNC_FAILURE'))
  const isLandingIntro = layout === 'landing' && conversationCount === 0
  const isDockedLanding = layout === 'landing' && !isLandingIntro
  const isGuest = layout === 'landing'
  // 로그인 뒤 대화의 입력칸입니다. 키보드 안내(Enter·Shift+Enter)는 화면에 두지 않고 화면 낭독기에만 알립니다.
  const isWorkspaceComposer = !isLandingIntro && !isDockedLanding
  // 가장 최근 업무 카드만 활성화합니다. 이전 기록은 저장된 결과를 여는 링크로 남깁니다.
  const latestToolMessageId = messages.findLast((message) => message.govApplication || message.govReview || message.govPartners)?.id
  const [workRefresh, setWorkRefresh] = useState(0)
  const isLiveWork = (message: (typeof messages)[number]) => isGovAgent && layout === 'workspace' && message.id === latestToolMessageId
    && (!message.govApplication || (govProgram?.sourceCode === message.govApplication.program.sourceCode
      && govProgram.sourceProgramId === message.govApplication.program.sourceProgramId))
  const refreshWork = useCallback(() => setWorkRefresh((value) => value + 1), [])
  // 카드 버튼으로 연 시트를 닫으면 대화는 그대로이므로, 카드가 상태를 다시 읽게 합니다.
  const cardRefresh = workRefresh + useChatSheetClosedCount()
  // 신청 문서는 신청 문서 화면에서 만들어지므로, 카드와 [신청 문서 쓰기] 칩은 공고로 내 신청 준비를 찾아 지금 상태를 보여 줍니다.
  const preparations = useProgramPreparations(isGovAgent && layout === 'workspace'
    && (govProgram !== null || messages.some((message) => message.govApplication)), cardRefresh)
  const selectedPreparation = govProgram && preparations?.phase === 'ready' ? preparations.byProgram.get(programKey(govProgram)) ?? null : null
  // 공고를 고르기 전에 작업 칩을 누르면 최근 검색 결과의 [이 공고로 작업]에 고리를 두르고 먼저 할 일을 알립니다.
  // 그 결과에서 공고를 고르면 누른 칩을 막대에서 한 번 강조하고, 실행은 사용자가 칩을 다시 눌러야 합니다(신청 문서 쓰기는 유료 분석이 바로 시작될 수 있음).
  const latestResultsId = messages.findLast((message) => Boolean(message.programs?.length))?.id ?? null
  const [selectCue, setSelectCue] = useState<{ count: number; tool: GovAgentTool; resultsId: string | null } | null>(null)
  const [cuedTool, setCuedTool] = useState<{ tool: GovAgentTool; program: string } | null>(null)
  const activeSelectCue = !govProgram && selectCue?.resultsId === latestResultsId ? selectCue : null
  const selectCueMessage = !activeSelectCue ? ''
    : activeSelectCue.resultsId ? '[이 공고로 작업]을 눌러 공고를 골라 주세요.' : '먼저 지원사업을 검색해 주세요.'
  const isCuedTool = (tool: GovAgentTool) => cuedTool?.tool === tool && govProgram !== null && cuedTool.program === programKey(govProgram)
  function cueProgramSelection(tool: GovAgentTool) {
    setSelectCue((current) => ({ count: (current?.count ?? 0) + 1, tool, resultsId: latestResultsId }))
    if (!latestResultsId) composerInputRef.current?.focus()
  }
  // Gov 대화를 카드 · 시트에서 떠나면 그때 연 신청 문서 · 중복 검토 · 파트너 화면이 [대화로 돌아가기]를 보입니다(사이드바 메뉴로 옮기면 두지 않음).
  // 환영 인사뿐인 대화면 두지 않습니다.
  const hasConversation = useRef(false)
  hasConversation.current = messages.length > 1
  useEffect(() => {
    if (!isGovAgent || layout !== 'workspace') return
    setReturnToGovChat(false)
    return () => setReturnToGovChat(hasConversation.current)
  }, [isGovAgent, layout, setReturnToGovChat])
  // 대화에서 연 새 검토 시트에서 검토를 저장하면(주소가 새 검토 → 그 검토로 바뀜) 그 번호를 최근 중복 검토 카드에 붙여
  // 카드가 진행과 결과를 따라가게 합니다. 카드 버튼 · 칩으로 연 시트만 붙이고, 시트를 닫으면 표시를 지웁니다.
  const sheetLocation = useChatSheetLocation()
  const reviewSheet = useRef<{ fromChat: boolean; previousPath: string | null }>({ fromChat: false, previousPath: null })
  const openReviewSheet = useCallback(() => { reviewSheet.current.fromChat = true }, [])
  useEffect(() => {
    const state = reviewSheet.current
    const previous = state.previousPath
    state.previousPath = sheetLocation?.pathname ?? null
    // 시트가 닫힐 때(열려 있다가 없어질 때)만 표시를 지웁니다. 칩을 누른 직후 시트가 뜨기 전의 화면에서는 지우지 않습니다.
    if (!sheetLocation) { if (previous !== null) state.fromChat = false; return }
    if (!state.fromChat || previous !== appPaths.combinationReviewNew || !latestToolMessageId) return
    const reviewId = Number(matchPath(appPaths.combinationReviewDetail, sheetLocation.pathname)?.params.reviewId)
    if (!Number.isSafeInteger(reviewId) || reviewId <= 0) return
    state.fromChat = false
    attachGovReview(latestToolMessageId, reviewId)
  })
  /** 작업 칩은 카드를 만들고, 신청 문서 · 중복 검토는 그 화면을 대화 위 시트로 바로 엽니다(직접 누른 경우만, 말로 요청한 카드는 카드만 둠). */
  const navigate = useNavigate()
  function startGovTool(tool: GovAgentTool) {
    if (!govProgram) return
    setCuedTool(null)
    handleStartGovTool(tool)
    const params = new URLSearchParams({ sourceCode: govProgram.sourceCode, sourceProgramId: govProgram.sourceProgramId })
    if (tool === 'APPLICATION') navigate(`${appPaths.applicationPreparationNew}?${params}&analyze=1`)
    if (tool === 'COMBINATION_REVIEW') {
      openReviewSheet()
      navigate(`${appPaths.combinationReviewNew}?${params}`)
    }
  }
  // 원문 질문 기본 질문 칩은 공고를 고른 때의 마지막 메시지와 그 공고의 근거 답변 아래에만 둡니다(이어 묻기).
  // 다음 메시지가 오면 아래로 따라 내려가지 않고 사라져 대화에 지난 칩이 쌓이지 않습니다.
  const govProgramKey = govProgram ? `${govProgram.sourceCode}:${govProgram.sourceProgramId}` : null
  const latestMessageId = messages.at(-1)?.id
  const [askAnchor, setAskAnchor] = useState({ programKey: govProgramKey, messageId: latestMessageId })
  if (askAnchor.programKey !== govProgramKey) setAskAnchor({ programKey: govProgramKey, messageId: latestMessageId })

  /**
   * 공개 첫 화면의 첫 전송은 소개가 사라지고 입력창이 아래로 내려가는 큰 전환이라 View Transition으로 잇습니다.
   * 첫 메시지는 전송 즉시 동기로 쌓이므로 flushSync 한 번이면 전환 전후 화면이 잡힙니다.
   * 지원하지 않는 브라우저와 움직임 줄이기 설정에서는 지금처럼 바로 바뀝니다.
   */
  function handleLandingSubmit(event: FormEvent<HTMLFormElement>) {
    const canTransition = isLandingIntro && typeof document.startViewTransition === 'function'
      && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!canTransition) { handleSubmit(event); return }
    event.preventDefault()
    document.startViewTransition(() => { flushSync(() => handleSubmit(event)) })
  }

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
      {!isWorkspaceComposer ? (
        <small className={`${chatPageStyles.composerHint} ${isDockedLanding ? chatPageStyles.dockedComposerHint : ''}`}>
          Enter로 전송 · Shift+Enter로 줄바꿈
        </small>
      ) : null}
      {/* AI 대화 검색 이용량입니다. 한도를 정하지 않은 요금제는 그리지 않습니다. */}
      {aiSearchUsage ? (
        <PlanUsageLine
          view={aiSearchUsage}
          className={isDockedLanding ? chatPageStyles.dockedComposerUsage : chatPageStyles.composerUsage}
        />
      ) : null}
    </div>
  )

  const composerInputGroup = (
      <div className={isDockedLanding ? chatPageStyles.guestComposerGroup : chatPageStyles.composerInputGroup}>
        <textarea
          ref={composerInputRef}
          className={isDockedLanding ? chatPageStyles.guestComposerInput : `${chatPageStyles.composerInput} ${isLandingIntro ? chatPageStyles.landingComposerInput : chatPageStyles.workspaceComposerInput}`}
          aria-label="지원사업 검색어"
          aria-describedby={[hasReadinessNotice ? 'support-program-search-readiness' : null, isWorkspaceComposer ? 'chat-composer-keys' : null]
            .filter(Boolean).join(' ') || undefined}
          value={draft}
          disabled={isInterpreting}
          onChange={handleDraftChange}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onKeyDown={handleInputKeyDown}
          placeholder={isGovAgent ? '지원사업 검색, 공고 질문, 신청 준비, 중복 검토, 파트너 조회를 요청해 주세요.' : isLandingIntro
            ? '예: 서울에서 AI 서비스를 만드는 창업기업입니다. 사업화 지원을 받을 수 있을까요?'
            : isDockedLanding ? '지원사업·조건을 입력해 주세요.'
              : '찾고 싶은 지원사업이나 변경할 조건을 알려주세요.'}
          rows={isLandingIntro ? 3 : 1}
        />
        {!isDockedLanding ? composerFooter : null}
        {isWorkspaceComposer ? <span id="chat-composer-keys" className="sr-only">Enter로 전송, Shift+Enter로 줄바꿈</span> : null}
        {isBusy ? (
          <button
            key="cancel"
            type="button"
            className={isDockedLanding ? chatPageStyles.guestCancelButton : chatPageStyles.cancelSearchButton}
            aria-label="취소"
            onClick={(event) => {
              // 취소 후 전송 버튼으로 바뀌어도 이 클릭이 폼을 다시 제출하지 않게 합니다.
              event.preventDefault()
              cancelSearch()
            }}
          >
            {/* 전송 화살표와 같은 자리에 같은 크기의 둥근 버튼으로 두고, 안에는 정지 표시(네모)만 그립니다. */}
            <svg width="25" height="25" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" rx="2" />
            </svg>
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
      {isRestoredHistory ? <p className="mb-3 text-center text-xs text-ink-muted">저장된 대화입니다. 공고 상태와 신청 조건은 현재 원문에서 다시 확인해 주세요.</p> : null}
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
        const answeredSelected = Boolean(govProgram && message.govEvidence
          && message.govEvidence.program.sourceCode === govProgram.sourceCode
          && message.govEvidence.program.sourceProgramId === govProgram.sourceProgramId)
        const showQuickQuestions = isGovAgent && layout === 'workspace' && isLatest && !isUser && govQuickQuestions.length > 0
          && (message.id === askAnchor.messageId || answeredSelected)
        // 공고를 고르지 않아 답하지 못한 요청은 공고를 고른 때의 마지막 메시지 아래에 한 번 다시 묻기 칩으로 둡니다(누를 때만 보냄).
        const pendingQuestion = isGovAgent && layout === 'workspace' && isLatest && !isUser && message.id === askAnchor.messageId
          ? govPendingQuestion : null

        return (
          <article
            key={message.id}
            data-message-id={message.id}
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
                ) : message.govEvidence ? <>
                  <p className="mb-2 text-sm font-semibold">{message.govEvidence.program.title}</p>
                  <EvidenceQuestionFeedback compact state={message.govEvidence.answer.answerStatus === 'ANSWERED'
                    ? { status: 'answered', answer: message.govEvidence.answer } : { status: 'insufficient-evidence' }} />
                </> : isGovAgent && index === 0
                  ? '안녕하세요. Gov 에이전트입니다. 지원사업 검색, 공고 원문 질문, 신청 준비, 중복 지원 검토와 파트너 조회를 같은 대화에서 도와드립니다.'
                  : message.text}
                {retrySearch || retryInterpretation ? (
                  <div className={chatPageStyles.messageActions}>
                    <button type="button" className={chatPageStyles.messageRetryButton}
                      onClick={retrySearch ? handleRetrySearch : handleRetryInterpretation}>
                      {retrySearch ? '다시 검색' : isGovAgent ? '다시 요청' : '다시 해석'}
                    </button>
                  </div>
                ) : null}
              </div>
              {/* 신청 문서 · 중복 검토는 대화에 단계 띠가 있는 작업 카드만 두고, 입력이 필요한 일은 카드 버튼이 대화 위 시트로 엽니다. */}
              {message.govApplication ? <GovApplicationCard application={message.govApplication} refresh={cardRefresh} preparations={preparations}
                live={isLiveWork(message)} onChanged={refreshWork} /> : null}
              {message.govReview ? <GovReviewCard review={message.govReview} refresh={cardRefresh}
                live={isLiveWork(message)} onOpenSheet={openReviewSheet} /> : null}
              {message.govPartners ? (isGovAgent && layout === 'workspace' && message.id === latestToolMessageId
                ? <GovPartnerBrief key={`${accountEmail}:${message.id}`} conditions={message.govPartners.conditions} />
                : <div className="mt-3 rounded-xl border border-line p-4 text-sm">
                  <Link className="text-brand-primary underline" to={appPaths.partners}>파트너 모집글 보기</Link>
                </div>) : null}
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
              {showQuickQuestions || pendingQuestion !== null ? (
                <div className={chatPageStyles.suggestedQuestions} role="group" aria-label={answeredSelected ? '이어서 묻기' : '이 공고에 바로 묻기'}>
                  <span className="self-center text-xs text-ink-muted">{answeredSelected ? '이어서 묻기' : '이 공고에 바로 묻기'}</span>
                  {pendingQuestion !== null ? (
                    <button type="button" className={chatPageStyles.govQuickQuestionButton} disabled={isBusy} title={pendingQuestion}
                      aria-label={`방금 질문을 이 공고로 묻기: ${pendingQuestion}`} onClick={() => handleAskGovQuestion(pendingQuestion)}>
                      ‘{pendingQuestion.length > 20 ? `${pendingQuestion.slice(0, 20)}…` : pendingQuestion}’ 이 공고로 묻기
                    </button>
                  ) : null}
                  {showQuickQuestions && govQuickQuestions.map((suggestion) => (
                    <button key={suggestion.label} type="button" className={chatPageStyles.govQuickQuestionButton} disabled={isBusy}
                      onClick={() => handleAskGovQuestion(suggestion.question)}>
                      {suggestion.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {message.programs?.length ? (
                <ProgramResults programs={message.programs} totalCount={message.totalCount} resultToken={message.resultToken} interests={interests}
                  selectCue={activeSelectCue?.resultsId === message.id ? activeSelectCue.count : undefined}
                  onSelectProgram={isGovAgent && !isBusy ? (program) => {
                    const identity = { sourceCode: program.sourceCode, sourceProgramId: program.id }
                    selectGovProgram({ ...identity, title: program.title })
                    setCuedTool(activeSelectCue ? { tool: activeSelectCue.tool, program: programKey(identity) } : null)
                    setSelectCue(null)
                    composerInputRef.current?.focus()
                  } : undefined} />
              ) : zeroResultHelp?.messageId === message.id ? (
                <ZeroResultHelp explanation={zeroResultHelp.explanation} relaxations={zeroResultHelp.relaxations}
                  disabled={isBusy} onRelax={handleSearchRelaxation} onRephrase={handleClarificationInput} />
              ) : null}
            </div>
          </article>
        )
      })}
      {isBusy ? (
        <div className={chatPageStyles.messageRow}>
          {!isGuest ? <span className={chatPageStyles.assistantAvatar}>G</span> : null}
          <div className={chatPageStyles.searchingBubble} role="group"
            aria-label={isInterpreting ? isGovAgent ? 'Gov 에이전트 처리 중' : '조건 해석 진행 중' : '지원사업 검색 진행 중'}>
            <div className={chatPageStyles.loadingHeader}>
              <strong className={chatPageStyles.loadingLabel}>{isInterpreting ? isGovAgent ? 'Gov 에이전트 처리 중' : '조건 해석 중' : '지원사업 검색 중'}</strong>
              <span className={chatPageStyles.loadingDots} aria-hidden="true">
                {[0, 160, 320].map((delay) => (
                  <span key={delay} className={chatPageStyles.loadingDot} style={{ animationDelay: `${delay}ms` }} />
                ))}
              </span>
            </div>
            <p className={chatPageStyles.loadingDescription}>
              {isInterpreting ? isGovAgent ? '요청에 맞는 기능으로 처리하고 있어요…' : '조건 변경안을 해석하고 있어요. 아직 검색하지 않았습니다…' : '공고를 찾아보고 있어요…'}
            </p>
            <div className={chatPageStyles.loadingTrack} aria-hidden="true">
              <span className={chatPageStyles.loadingSweep} />
            </div>
          </div>
        </div>
      ) : null}
      {displayProposal ? (
        <ConversationProposal proposal={displayProposal}
          onConfirm={handleConfirmInterpretation} onCancel={cancelInterpretation} onClarify={handleClarificationInput}
          onQuickReply={handleQuickReply} />
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
        <h1 className="sr-only">{isGovAgent ? 'Gov 에이전트' : '지원사업 채팅'}</h1>
        <section className={chatPageStyles.workspaceShell}>
          {timeline}
          <form className={chatPageStyles.composerWorkspace} onSubmit={handleSubmit}>
            {isGovAgent ? <div className="px-3 py-2 text-sm text-ink-muted">
              {/* 선택 공고 막대는 두 줄입니다. 첫 줄: 제목(길면 줄이고 마우스를 올리면 전체) · 원문 질문 남은 횟수 · 해제(✕). 둘째 줄: 작업 칩.
                  공고를 고르기 전에는 막대 배경과 첫 줄 없이 같은 모양·크기의 작업 칩만 막대 안과 같은 들여쓰기로 둡니다. */}
              {govProgram ? <div className={chatPageStyles.govProgramBar} role="region" aria-label="선택한 공고">
                <div className={chatPageStyles.govProgramHeader}>
                  <span className={chatPageStyles.govProgramTitle}>선택한 공고: <strong className="text-ink" title={govProgram.title}>{govProgram.title}</strong></span>
                  {/* 원문 질문 남은 횟수는 적게 남았거나 다 썼을 때만 알립니다(다 쓰면 이어 묻기 칩이 사라지는 이유). */}
                  {evidenceUsage && (evidenceUsage.isNearLimit || evidenceUsage.isLimitReached)
                    ? <PlanUsageLine view={evidenceUsage} className={chatPageStyles.govProgramUsage} /> : null}
                  <button type="button" disabled={isBusy} className={chatPageStyles.govProgramClearButton} aria-label="선택 해제" title="선택 해제"
                    onClick={() => selectGovProgram(null)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                {/* 둘째 줄은 작업 칩 [신청 문서 쓰기] · [중복 검토] · [파트너 찾기]입니다. 원문 질문 기본 질문은 대화 안 이어 묻기 칩으로 둡니다.
                    작업 칩은 질문 칩과 색을 달리해 누르면 일이 시작된다는 것을 구분하고, 경로 선택 없이 작업 카드를 만들어 대화 안에 펼칩니다.
                    이 공고로 이미 쓰는 신청 문서가 있으면 [신청 문서 쓰기] 대신 [이어서 쓰기 · n/m] 또는 [초안 보기]로 그 화면을 엽니다.
                    처리 중에는 줄을 그대로 두고 누를 수 없게만 해 막대 높이가 줄었다 늘지 않게 합니다. */}
                {govTools.length > 0 ? <div className="flex flex-wrap items-center gap-2" role="group" aria-label="이 공고로 작업하기">
                  {govTools.map((tool) => tool === 'APPLICATION' && selectedPreparation && !isBusy ? (
                    <Link key={tool} className={isCuedTool(tool) ? `${chatPageStyles.govToolButton} ${chatPageStyles.govToolCue}` : chatPageStyles.govToolButton}
                      to={preparationPath(selectedPreparation)}>
                      {selectedPreparation.hasCurrentDocument ? '초안 보기' : continueLabel(selectedPreparation)}
                    </Link>
                  ) : (
                    <button key={tool} type="button" disabled={isBusy}
                      className={isCuedTool(tool) ? `${chatPageStyles.govToolButton} ${chatPageStyles.govToolCue}` : chatPageStyles.govToolButton}
                      title={tool === 'APPLICATION' ? '저장된 양식이 없으면 입력칸 분석(유료 AI)을 바로 시작해요' : undefined}
                      onClick={() => startGovTool(tool)}>
                      {govToolTexts[tool].label}
                    </button>
                  ))}
                </div> : null}
              </div> : <div className={chatPageStyles.govToolPreviewRow}>
                {/* 같은 작업 칩을 미리 두되, 누르면 실행하지 않고 [이 공고로 작업]을 먼저 누르도록 이끕니다. */}
                {govTools.length > 0 ? <div className="flex flex-wrap items-center gap-2" role="group" aria-label="공고를 고르면 할 수 있는 작업">
                  {govTools.map((tool) => (
                    <button key={tool} type="button" className={chatPageStyles.govToolButton} disabled={isBusy}
                      onClick={() => cueProgramSelection(tool)}>
                      {govToolTexts[tool].label}
                    </button>
                  ))}
                  <span className={chatPageStyles.govToolPreviewMessage} aria-live="polite">{selectCueMessage}</span>
                </div> : null}
                {evidenceUsage && (evidenceUsage.isNearLimit || evidenceUsage.isLimitReached)
                  ? <PlanUsageLine view={evidenceUsage} className="mt-1.5 text-xs" /> : null}
              </div>}
            </div> : null}
            {readinessNotice}
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
        <form className={isLandingIntro ? chatPageStyles.composer : chatPageStyles.guestComposerDock} onSubmit={handleLandingSubmit}>
          {!isLandingIntro ? readinessNotice : null}
          {/* 고지는 입력창 바로 위에 둡니다. 대화가 스크롤되면 흰 도크 뒤로 들어가며 위쪽 가장자리에서 서서히 가려집니다. */}
          {isDockedLanding ? <small className={chatPageStyles.guestDisclaimer}>
            AI 답변은 참고용입니다. 최종 신청 조건은 공고 원문에서 확인하세요.
          </small> : null}
          {composerInputGroup}
          {composerErrors}
          {isDockedLanding ? composerFooter : null}
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
    // 처음 상태를 확인하는 잠깐 동안만 나타났다 사라져 깜빡여 보이므로 안내를 숨깁니다.
    // return (
    //   <section
    //     id="support-program-search-readiness"
    //     className={chatPageStyles.readinessNotice}
    //     aria-live="polite"
    //     aria-atomic="true"
    //   >
    //     공고 데이터 상태를 확인하고 있습니다.
    //   </section>
    // )
    return null
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
      // 저장된 공고로 검색은 그대로 되고 안내만 깜빡여 보여 숨깁니다.
      // return '최신 공고를 불러오지 못해 이전에 저장한 공고에서 검색합니다.'
      return null
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
