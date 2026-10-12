import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import type { GovAgentProgram } from '@govbiz/shared/domain/entities/GovAgent'

import {
  supportProgramChatSuggestions,
  useSupportProgramChat,
} from '../hooks/useSupportProgramChat'
import type { SupportProgramChatMessage } from '../state/chatSlice'
import { useSupportProgramSearchReadiness } from '../hooks/useSupportProgramSearchReadiness'
import { formatSupportProgramEligibilityCounts } from '../supportProgramEligibility'
import { planUsageView } from '../../../shared/plan-usage/planUsageView'
import { usePlanUsage } from '../../../shared/plan-usage/usePlanUsage'
import { evidenceQuestionSuggestions } from '../../support-program-detail/viewmodel/useEvidenceQuestionThread'
import { createChatConversationProposal } from './chatConversationProposal'
import { useSearchResultInterests } from './useSearchResultInterests'

/** 내부 훅을 조합해 ChatPage에 제공할 최종 화면 상태와 사용자 동작을 관리합니다. */
export function useChatPageViewModel() {
  const readiness = useSupportProgramSearchReadiness()
  const chat = useSupportProgramChat()
  const interests = useSearchResultInterests(chat.messages.some((message) => Boolean(message.programs?.length)))
  // AI 대화 검색 이용량입니다. 못 읽으면 줄을 그리지 않고 막지도 않습니다(서버가 다시 판단).
  const planUsage = usePlanUsage()
  const aiSearchUsage = planUsageView(planUsage.usage, 'AI_SEARCH')
  const evidenceUsage = planUsageView(planUsage.usage, 'EVIDENCE_QUESTION')
  // 한도를 다 쓰면 검색 실행(이 조건으로 검색 · 다시 검색)만 막습니다. 메시지 해석과 필터 검색은 이용량에 들지 않습니다.
  const searchLimitMessage = aiSearchUsage?.isLimitReached ? aiSearchUsage.limitMessage : null
  const displayProposal = createChatConversationProposal({
    isBusy: chat.isBusy,
    confirmedContext: chat.confirmedContext,
    interpretation: chat.interpretation,
    pendingClarification: chat.pendingClarification,
    canSearch: readiness.canSearch,
    hasUnsentMessage: chat.draft.trim().length > 0,
    searchLimitMessage,
  })
  const hasConfirmedSearch = chat.confirmedContext.query !== null
  const isComposingInput = useRef(false)
  const timelineRef = useRef<HTMLDivElement>(null)
  const composerInputRef = useRef<HTMLTextAreaElement>(null)
  const focusComposerAfterAction = useRef(false)
  const latestMessage = chat.messages.at(-1)
  const previousTimelineState = useRef({
    isInitial: true,
    latestMessageId: latestMessage?.id,
    interpretationStatus: chat.interpretation.status,
    isSearching: chat.isSearching,
  })
  const searchStatusAnnouncement = useMemo(() => chat.isInterpreting
    ? chat.isGovAgent ? 'Gov 에이전트가 요청을 처리하고 있습니다.' : '메시지의 조건 변경을 해석하고 있습니다. 아직 검색하지 않았습니다.'
    : chat.interpretation.status === 'ready'
      ? '조건 변경안이 준비되었습니다. 확인 버튼을 눌러야 검색합니다.'
      : chat.interpretation.status === 'clarification'
        ? `조건 확인이 필요합니다. ${chat.interpretation.result?.clarificationQuestion ?? ''}`
        : chat.isSearching
    ? '지원사업 공고를 검색하고 있습니다.'
    : latestMessage?.role === 'assistant' && latestMessage.programs
      ? latestMessage.totalCount !== undefined && latestMessage.totalCount > latestMessage.programs.length
        ? `지원사업 검색 결과 ${latestMessage.totalCount}건 중 ${latestMessage.programs.length}건을 표시했습니다. 표시된 공고: ${formatSupportProgramEligibilityCounts(latestMessage.programs)}. 추가 ${latestMessage.totalCount - latestMessage.programs.length}건은 회원가입 또는 로그인 후 확인할 수 있습니다.`
        : `지원사업 검색 결과 ${latestMessage.programs.length}건: ${formatSupportProgramEligibilityCounts(latestMessage.programs)}을 표시했습니다.`
      : '', [chat.isGovAgent, chat.isInterpreting, chat.interpretation.status, chat.interpretation.result?.clarificationQuestion,
        chat.isSearching, latestMessage])

  useEffect(() => {
    const previous = previousTimelineState.current
    const latestMessageId = chat.messages.at(-1)?.id
    const hasNewContent = (latestMessageId !== previous.latestMessageId && chat.messages.length > 1)
      || (chat.isSearching && !previous.isSearching)
      || (chat.interpretation.status !== previous.interpretationStatus
        && ['pending', 'ready', 'clarification'].includes(chat.interpretation.status))
    previousTimelineState.current = {
      isInitial: false,
      latestMessageId,
      interpretationStatus: chat.interpretation.status,
      isSearching: chat.isSearching,
    }
    if (focusComposerAfterAction.current) {
      focusComposerAfterAction.current = false
      composerInputRef.current?.focus()
      return
    }
    if (!hasNewContent && !previous.isInitial) return
    const timeline = timelineRef.current
    if (!timeline) return
    const overflowY = getComputedStyle(timeline).overflowY
    if (['auto', 'scroll'].includes(overflowY)) {
      const latestContent = timeline.lastElementChild
      const hasResults = chat.messages.at(-1)?.programs?.length
        && !chat.isSearching && chat.interpretation.status === 'idle'
      if (hasResults && latestContent) {
        // 안내문 길이에 관계없이 결과 제목과 첫 공고부터 보이도록 목록 상단을 맞춥니다.
        const resultStart = latestContent.querySelector('[data-search-results]') ?? latestContent
        timeline.scrollTop += resultStart.getBoundingClientRect().top
          - timeline.getBoundingClientRect().top - timeline.clientTop
      } else {
        // 로딩·조건 안내는 문서를 밀어내지 않고 대화 영역 안에서 보여 줍니다.
        timeline.scrollTop = timeline.scrollHeight
      }
    } else if (hasNewContent) {
      // 문서 스크롤을 사용하는 모바일 작업 화면은 새 내용을 문서 안에서 보여 줍니다.
      timeline.lastElementChild?.scrollIntoView?.({ block: 'start' })
    }
  }, [chat.messages, chat.isSearching, chat.interpretation.status])

  // 검색을 한 번 시도하면(성공 · 한도 초과 · 실패 · 시간 초과 · 취소) 이용량을 다시 읽습니다.
  const wasSearching = useRef(chat.isSearching)
  const reloadPlanUsage = planUsage.reload
  const wasGovBusy = useRef(false)
  useEffect(() => {
    if (wasGovBusy.current && !chat.isInterpreting) reloadPlanUsage()
    wasGovBusy.current = chat.isGovAgent && chat.isInterpreting
  }, [chat.isGovAgent, chat.isInterpreting, reloadPlanUsage])
  useEffect(() => {
    if (wasSearching.current && !chat.isSearching) reloadPlanUsage()
    wasSearching.current = chat.isSearching
  }, [chat.isSearching, reloadPlanUsage])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void chat.submitMessage()
  }

  function handleStartNewConversation() {
    focusComposerAfterAction.current = true
    chat.startNewConversation()
  }

  function handleCancelSearch() {
    focusComposerAfterAction.current = true
    chat.cancelSearch()
  }

  function handleSelectSuggestion(suggestion: string) {
    chat.selectSuggestion(suggestion)
  }

  /** Gov 선택 공고의 기본 질문을 입력칸을 거치지 않고 바로 보냅니다. 직접 쓴 질문과 같은 경로라 호출 수가 늘지 않습니다. */
  function handleAskGovQuestion(question: string) {
    void chat.submitMessage(question)
  }

  function handleRetrySearch() {
    if (!readiness.canSearch || searchLimitMessage) return
    void chat.retrySearch()
  }

  function handleConfirmInterpretation() {
    if (!readiness.canSearch || searchLimitMessage) return
    void chat.confirmInterpretation()
  }

  function handleRetryInterpretation() {
    void chat.retryInterpretation()
  }

  function handleClarificationInput() {
    composerInputRef.current?.focus()
  }

  function handleQuickReply(reply: string) {
    void chat.submitQuickReply(reply)
  }

  function handleDraftChange(event: ChangeEvent<HTMLTextAreaElement>) {
    chat.updateDraft(event.target.value)
  }

  function handleCompositionStart() {
    isComposingInput.current = true
  }

  function handleCompositionEnd() {
    isComposingInput.current = false
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (
      isComposingInput.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    ) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  function refetchReadiness() {
    void readiness.refetch()
  }

  return {
    isGovAgent: chat.isGovAgent,
    govProgram: chat.govProgram,
    selectGovProgram: chat.selectGovProgram,
    attachGovPreparation: chat.attachGovPreparation,
    attachGovReview: chat.attachGovReview,
    evidenceUsage,
    /**
     * 고른 공고에 바로 물을 원문 질문 기본 질문(지원 대상·신청 방법·신청 기간·문의처) 중 이 대화에서 아직 묻지 않은 것입니다.
     * 공고 상세 질문 패널과 같은 목록이며, 화면이 공고를 고른 때와 그 공고의 근거 답변 뒤에만 칩으로 둡니다.
     * 오늘 원문 질문을 다 쓴 때는 두지 않습니다.
     */
    govQuickQuestions: chat.isGovAgent && chat.govProgram && !evidenceUsage?.isLimitReached
      ? unaskedEvidenceQuestions(chat.messages, chat.govProgram) : [],
    handleAskGovQuestion,
    /** 공고를 고르지 않아 답하지 못한 요청입니다. 공고를 고른 동안만 [방금 질문을 이 공고로 묻기] 칩으로 다시 보냅니다. */
    govPendingQuestion: chat.isGovAgent && chat.govProgram ? chat.govPendingQuestion : null,
    setReturnToGovChat: chat.setReturnToGovChat,
    /** 선택 공고 막대 둘째 줄의 작업 칩(신청서 쓰기·중복 검토·파트너 찾기)입니다. 원문 질문 한도와 관계없고, 입력 중에는 두지 않습니다. */
    govTools: chat.isGovAgent && chat.govProgram && chat.draft.trim().length === 0
      ? (['APPLICATION', 'COMBINATION_REVIEW', 'PARTNERS'] as const) : [],
    handleStartGovTool: chat.startGovTool,
    isRestoredHistory: chat.isRestoredHistory,
    displayProposal,
    hasConfirmedSearch,
    hasSearchToReset: hasConfirmedSearch || chat.conversationCount > 0,
    interpretationError: chat.interpretation.error,
    canRetryInterpretation: chat.interpretation.status === 'failed' && Boolean(chat.interpretation.request),
    isInterpreting: chat.isInterpreting,
    isBusy: chat.isBusy,
    cancelInterpretation: chat.cancelInterpretation,
    handleConfirmInterpretation,
    handleRetryInterpretation,
    handleClarificationInput,
    handleQuickReply,
    searchOptions: chat.searchOptions,
    canSearch: readiness.canSearch,
    canRetrySearch: readiness.canSearch && chat.canRetrySearch && !searchLimitMessage,
    /** AI 대화 검색 이용량 한 줄입니다. 읽지 못했으면 null이라 그리지 않습니다. */
    aiSearchUsage,
    isReadyToSubmit: chat.isReadyToSubmit,
    conversationCount: chat.conversationCount,
    draft: chat.draft,
    isSearching: chat.isSearching,
    messages: chat.messages,
    searchError: chat.searchError,
    inputError: chat.inputError,
    interests,
    cancelSearch: handleCancelSearch,
    readiness,
    suggestions: supportProgramChatSuggestions,
    searchStatusAnnouncement,
    timelineRef,
    composerInputRef,
    handleSubmit,
    handleStartNewConversation,
    handleSelectSuggestion,
    handleRetrySearch,
    handleDraftChange,
    handleCompositionStart,
    handleCompositionEnd,
    handleInputKeyDown,
    refetchReadiness,
  }
}

/**
 * 고른 공고의 기본 질문 중 이 대화에서 아직 묻지 않은 것입니다. 그 공고의 근거 답변 바로 앞 사용자 말이
 * 기본 질문 문장과 같으면 물은 것으로 봅니다(직접 비슷하게 쓴 질문은 따로 가리지 않음).
 */
function unaskedEvidenceQuestions(messages: readonly SupportProgramChatMessage[], program: GovAgentProgram) {
  const asked = new Set(messages.flatMap((message, index) => {
    const answered = message.govEvidence?.program
    return answered?.sourceCode === program.sourceCode && answered.sourceProgramId === program.sourceProgramId
      ? [messages[index - 1]?.text] : []
  }))
  return evidenceQuestionSuggestions.filter((suggestion) => !asked.has(suggestion.question))
}
