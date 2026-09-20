import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
} from 'react'

import {
  supportProgramChatSuggestions,
  useSupportProgramChat,
} from '../hooks/useSupportProgramChat'
import { useSupportProgramSearchReadiness } from '../hooks/useSupportProgramSearchReadiness'
import { formatSupportProgramEligibilityCounts } from '../supportProgramEligibility'
import { createChatConversationProposal } from './chatConversationProposal'
import { useSearchResultInterests } from './useSearchResultInterests'

/** 내부 훅을 조합해 ChatPage에 제공할 최종 화면 상태와 사용자 동작을 관리합니다. */
export function useChatPageViewModel() {
  const readiness = useSupportProgramSearchReadiness()
  const chat = useSupportProgramChat()
  const interests = useSearchResultInterests(chat.messages.some((message) => Boolean(message.programs?.length)))
  const displayProposal = createChatConversationProposal({
    isBusy: chat.isBusy,
    confirmedContext: chat.confirmedContext,
    interpretation: chat.interpretation,
    pendingClarification: chat.pendingClarification,
    canSearch: readiness.canSearch,
    hasUnsentMessage: chat.draft.trim().length > 0,
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
    ? '메시지의 조건 변경을 해석하고 있습니다. 아직 검색하지 않았습니다.'
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
      : '', [chat.isInterpreting, chat.interpretation.status, chat.interpretation.result?.clarificationQuestion,
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

  function handleRetrySearch() {
    if (!readiness.canSearch) return
    void chat.retrySearch()
  }

  function handleConfirmInterpretation() {
    if (!readiness.canSearch) return
    void chat.confirmInterpretation()
  }

  function handleRetryInterpretation() {
    void chat.retryInterpretation()
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
    searchOptions: chat.searchOptions,
    canSearch: readiness.canSearch,
    canRetrySearch: readiness.canSearch && chat.canRetrySearch,
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
