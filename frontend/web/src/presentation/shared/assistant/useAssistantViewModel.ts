import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router'

import { appContainer } from '../../../app/appContainer'
import { useAppDispatch, useAppSelector, useAppStore } from '../../../app/hooks'
import type { AskAssistantUseCase } from '../../../domain/usecases/AskAssistantUseCase'
import { isValidAssistantMessage } from '../../../domain/usecases/AskAssistantUseCase'
import type { BrowseSavedSupportProgramsUseCase } from '../../../domain/usecases/SavedSupportProgramUseCases'
import type { IsAssistantAiEnabled } from '../../../data/config/assistantAi'
import type { KakaoChannelChatUrl } from '../../../data/config/kakaoChannel'
import { AssistantApiError } from '../../../data/api/assistantApi'
import { draftChanged } from '../../features/chat/state/chatSlice'
import { useAuthSession } from '../auth/hooks/useAuthSession'
import { loginPathFor } from '../auth/returnPath'
import { findHelpEntry, helpEntriesForSurface } from '../help/helpContent'
import { useReceivedProposals } from '../partner-proposal/useReceivedProposals'
import {
  type AssistantCardButton,
  type AssistantMessage,
  type AssistantQuickReply,
  contactAnswer,
  findAssistantHelpTopic,
  freeTextAnswer,
  freeTextFailure,
  freeTextFallback,
  freeTextLoginAnswer,
  freeTextSessionExpired,
  greetingMessages,
  helpAnswer,
  isAssistantHiddenOn,
  loginBenefitsAnswer,
  loginPromptAnswer,
  otherQuestionReply,
  programIdentityFrom,
  quickRepliesFor,
  receivedProposalsAnswer,
  savedProgramsAnswer,
  topicAnswer,
  userMessage,
} from './assistantConversation'
import { assistantMessages } from './assistantMessages'
import { readAssistantConversation, writeAssistantConversation } from './assistantConversationStorage'
import {
  assistantConversationRestored, assistantConversationReplaced,
  assistantMessagesAdded, assistantQuickRepliesChanged,
} from './state/assistantSlice'

type SavedProgramsUseCase = Pick<BrowseSavedSupportProgramsUseCase, 'execute'>
type AskUseCase = Pick<AskAssistantUseCase, 'execute'>

/**
 * 자유 질문은 이 시간 안에 답이 없으면 끊고 다시 시도를 안내합니다. 도구 에이전트의 관심 공고 질문은 분류 → 원문 확보(최대 6초) →
 * 근거 판단·답의 두 번 호출이라 20초를 넘길 수 있어 그보다 넉넉히 둡니다.
 */
export const assistantAnswerTimeoutMs = 45_000

// 기존 import 경로를 유지합니다. 자유 질문에서는 최근 대화 최대 6개를 Core에 전송합니다.
export { assistantConversationStorageKey } from './state/assistantSlice'
const labelShownStorageKey = 'govbiz.assistant.labelShown'
/** 첫 방문에 런처 옆 라벨을 보여 주는 시간입니다. */
export const assistantLauncherLabelMs = 5_000

function readLabelShown(): boolean {
  try {
    return window.sessionStorage.getItem(labelShownStorageKey) === '1'
  } catch {
    return true
  }
}

/**
 * GovBiz 도우미 위젯의 대표 ViewModel입니다. 열림·대화·빠른 답변·라벨·안 읽음 배지를 소유하고,
 * 상태 질문은 기존 UseCase(관심 공고함·받은 제안함)로 답하고, 자유 질문만 Core의 도우미 API로 보냅니다.
 */
export function useAssistantViewModel(
  browseSavedPrograms: SavedProgramsUseCase = appContainer.resolve('browseSavedSupportProgramsUseCase'),
  kakaoChannelChatUrl: KakaoChannelChatUrl = appContainer.resolve('kakaoChannelChatUrl'),
  askAssistant: AskUseCase = appContainer.resolve('askAssistantUseCase'),
  isAssistantAiEnabled: IsAssistantAiEnabled = appContainer.resolve('isAssistantAiEnabled'),
) {
  const dispatchToStore = useAppDispatch()
  const store = useAppStore()
  const conversation = useAppSelector((state) => state.assistant)
  const { accountEmail, sessionVersion, authResolved, initialized, messages, quickReplies } = conversation
  const conversationSession = useMemo(() => ({ accountEmail, sessionVersion }), [accountEmail, sessionVersion])
  const { pathname, search } = useLocation()
  const { isAuthenticated, hasCompany } = useAuthSession()
  const receivedProposals = useReceivedProposals()
  // 채널 주소는 빌드 환경값이라 인스턴스 동안 고정입니다. 대화 규칙 함수에는 값으로 넘겨 환경을 직접 읽지 않게 합니다.
  const contactUrl = useMemo(() => kakaoChannelChatUrl(), [kakaoChannelChatUrl])
  // 모델 호출은 빌드 스위치로만 켭니다. 꺼져 있으면 자유 입력을 주제 알약으로 돌려보내 비용이 들지 않습니다.
  const aiEnabled = useMemo(() => isAssistantAiEnabled(), [isAssistantAiEnabled])
  // 자유 질문(모델 호출)은 회원만 씁니다. 로그인 전에는 입력창 대신 로그인 안내를 두고, 주제 알약 · 도움말은 그대로 씁니다.
  // 모델이 꺼져 있으면 자유 입력은 서버에 가지 않고 주제 알약으로 돌아가므로 지금처럼 입력창을 둡니다.
  const canAskFreeText = isAuthenticated || !aiEnabled
  const session = useMemo(() => ({ isAuthenticated, hasCompany, contactUrl }), [isAuthenticated, hasCompany, contactUrl])
  const [ui, setUi] = useState({ ...conversationSession, isOpen: false, isTyping: false, hasUnread: false })
  // 계정이 바뀐 첫 렌더에서도 이전 패널·입력 초안·배지를 표시하지 않습니다.
  const sameUiSession = ui.accountEmail === accountEmail && ui.sessionVersion === sessionVersion
  const isOpen = sameUiSession && ui.isOpen
  const isTyping = sameUiSession && ui.isTyping
  const hasUnread = sameUiSession && ui.hasUnread
  const [showLabel, setShowLabel] = useState(() => !readLabelShown())
  const isOpenRef = useRef(isOpen)
  isOpenRef.current = isOpen
  const mounted = useRef(true)
  const requests = useRef(new Map<AbortController, ReturnType<typeof setTimeout>>())
  const isCurrentSession = useCallback(() => {
    const current = store.getState().assistant
    return mounted.current && authResolved && current.authResolved
      && current.accountEmail === accountEmail && current.sessionVersion === sessionVersion
  }, [store, accountEmail, sessionVersion, authResolved])
  const updateUi = useCallback((changes: Partial<Pick<typeof ui, 'isOpen' | 'isTyping' | 'hasUnread'>>) => {
    if (!isCurrentSession()) return
    setUi((current) => ({
      ...(current.accountEmail === accountEmail && current.sessionVersion === sessionVersion
        ? current : { ...conversationSession, isOpen: false, isTyping: false, hasUnread: false }),
      ...changes,
    }))
  }, [accountEmail, sessionVersion, conversationSession, isCurrentSession])

  useEffect(() => {
    mounted.current = true
    setUi({ accountEmail, sessionVersion, isOpen: false, isTyping: false, hasUnread: false })
    const pending = requests.current
    return () => {
      mounted.current = false
      for (const [controller, timer] of pending) { clearTimeout(timer); controller.abort() }
      pending.clear()
    }
  }, [accountEmail, sessionVersion, authResolved])

  useEffect(() => {
    if (!authResolved || initialized || !isCurrentSession()) return
    const stored = readAssistantConversation(accountEmail)
    dispatchToStore(assistantConversationRestored({ ...conversationSession, messages: stored?.messages ?? [], quickReplies: stored?.quickReplies ?? [] }))
  }, [accountEmail, authResolved, initialized, isCurrentSession, dispatchToStore, conversationSession])

  // 첫 방문 라벨은 몇 초 뒤 접히고 그 세션에는 다시 보이지 않습니다.
  useEffect(() => {
    if (!showLabel) return
    const timer = setTimeout(() => {
      setShowLabel(false)
      try { window.sessionStorage.setItem(labelShownStorageKey, '1') } catch { /* 세션 저장 불가 */ }
    }, assistantLauncherLabelMs)
    return () => clearTimeout(timer)
  }, [showLabel])

  useEffect(() => {
    if (!initialized || !isCurrentSession()) return
    writeAssistantConversation(messages.length === 0 ? null : { accountEmail, messages, quickReplies })
  }, [accountEmail, messages, quickReplies, initialized, isCurrentSession])

  const routeReplies = useCallback(() => quickRepliesFor(session), [session])

  const append = useCallback((next: AssistantMessage[], followUps: AssistantQuickReply[]) => {
    if (!isCurrentSession()) return
    dispatchToStore(assistantMessagesAdded({ ...conversationSession, messages: next, quickReplies: followUps }))
    if (!isOpenRef.current) updateUi({ hasUnread: true })
  }, [dispatchToStore, conversationSession, isCurrentSession, updateUi])

  const open = useCallback(() => {
    if (!isCurrentSession()) return
    updateUi({ isOpen: true, hasUnread: false })
    setShowLabel(false)
    if (messages.length === 0) {
      dispatchToStore(assistantConversationReplaced({ ...conversationSession, messages: greetingMessages(), quickReplies: routeReplies() }))
    } else if (quickReplies.length === 0) {
      dispatchToStore(assistantQuickRepliesChanged({ ...conversationSession, quickReplies: routeReplies() }))
    }
  }, [messages.length, quickReplies.length, routeReplies, dispatchToStore, conversationSession, isCurrentSession, updateUi])

  const close = useCallback(() => updateUi({ isOpen: false }), [updateUi])

  const startNewConversation = useCallback(() => {
    if (!isCurrentSession()) return
    dispatchToStore(assistantConversationReplaced({ ...conversationSession, messages: greetingMessages(), quickReplies: routeReplies() }))
  }, [routeReplies, dispatchToStore, conversationSession, isCurrentSession])

  const returnTo = `${pathname}${search}`

  /**
   * 자유 질문을 Core에 보냅니다. 최근 대화 6개, 현재 화면 경로와 공고 선택 여부, 챗봇 표면의 도움말 전량을 함께 실어
   * 서버가 인용을 그 안에서만 인정하게 합니다. 45초 안에 답이 없으면 끊고 다시 시도를 안내합니다.
   */
  const submitText = useCallback(async (text: string) => {
    if (!isCurrentSession()) return
    const trimmed = text.trim()
    if (trimmed === '') return
    const asked = userMessage(trimmed)
    if (!aiEnabled || !isValidAssistantMessage(trimmed)) {
      append([asked, freeTextFallback()], routeReplies())
      return
    }
    // 서버가 비로그인 자유 질문을 받지 않으므로 보내지 않고 로그인을 안내합니다(이전 대화의 다시 시도 알약 등).
    if (!isAuthenticated) {
      const answer = freeTextLoginAnswer(returnTo)
      append([asked, answer], answer.role === 'assistant' ? answer.followUps : [])
      return
    }
    const history = messages.slice(-6).map((item) => (item.role === 'user'
      ? { role: 'USER' as const, content: item.text }
      : { role: 'ASSISTANT' as const, content: item.paragraphs.join(' ') }))
    dispatchToStore(assistantMessagesAdded({ ...conversationSession, messages: [asked], quickReplies: [] }))
    updateUi({ isTyping: true })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), assistantAnswerTimeoutMs)
    requests.current.set(controller, timer)
    try {
      const result = await askAssistant.execute({
        message: trimmed,
        history,
        context: { route: pathname.replace(/\/+$/, '') || '/', programSelected: programIdentityFrom(pathname, search) !== null },
        helpEntries: helpEntriesForSurface('chatbot').map((entry) => ({
          id: entry.id, title: entry.title, question: entry.question, summary: entry.summary, body: [...entry.body],
          limitation: entry.limitation, audience: entry.audience, status: entry.status,
          // 서버 계약은 경로만 받으므로 `?mode=filter` 같은 질의는 떼고 보냅니다. 버튼은 화면이 원본 항목으로 다시 만듭니다.
          action: entry.action === null ? null : { label: entry.action.label, to: entry.action.to.split('?')[0] ?? entry.action.to },
        })),
      }, controller.signal)
      if (!isCurrentSession()) return
      const answer = result.outcome === 'answered'
        ? freeTextAnswer(result.answer, { pathname, search, session, returnTo })
        : freeTextFailure(trimmed, result.outcome === 'rate-limited' ? assistantMessages.rateLimited(result.retryAfterSeconds) : assistantMessages.unavailable)
      append([answer], answer.role === 'assistant' && answer.followUps.length > 0 ? answer.followUps : routeReplies())
    } catch (error) {
      if (!isCurrentSession()) return
      // 세션이 끝나 서버가 로그인을 요구하면 일반 실패 대신 다시 로그인하라고 알립니다.
      const answer = error instanceof AssistantApiError && error.status === 401
        ? freeTextSessionExpired()
        : freeTextFailure(trimmed, assistantMessages.loadFailed)
      append([answer], answer.role === 'assistant' ? answer.followUps : [])
    } finally {
      clearTimeout(timer)
      requests.current.delete(controller)
      if (isCurrentSession()) updateUi({ isTyping: false })
    }
  }, [aiEnabled, append, askAssistant, isAuthenticated, messages, pathname, returnTo, routeReplies, search, session,
    dispatchToStore, conversationSession, isCurrentSession, updateUi])

  /** 검색 이동 버튼은 검색 입력창에 도우미가 고른 검색어를 미리 채웁니다. 검색 자체는 사용자가 보낼 때 시작합니다. */
  const prepareNavigation = useCallback((button: AssistantCardButton) => {
    if (!isCurrentSession()) return
    if (button.searchQuery !== undefined) dispatchToStore(draftChanged(button.searchQuery))
  }, [dispatchToStore, isCurrentSession])

  const pickQuickReply = useCallback(async (reply: AssistantQuickReply) => {
    if (!isCurrentSession()) return
    if (reply.kind === 'other') {
      dispatchToStore(assistantQuickRepliesChanged({ ...conversationSession, quickReplies: routeReplies() }))
      return
    }
    if (reply.kind === 'retry') {
      await submitText(reply.text ?? '')
      return
    }
    const asked = userMessage(reply.label)
    dispatchToStore(assistantMessagesAdded({ ...conversationSession, messages: [asked], quickReplies: [] }))

    if (reply.kind === 'topic') {
      const topic = reply.topicId === undefined ? undefined : findAssistantHelpTopic(reply.topicId)
      const answer = topic === undefined ? freeTextFallback() : topicAnswer(topic)
      append([answer], answer.role === 'assistant' && answer.followUps.length > 0 ? answer.followUps : routeReplies())
      return
    }
    if (reply.kind === 'help') {
      const entry = reply.helpId === undefined ? undefined : findHelpEntry(reply.helpId)
      const answer = entry === undefined ? freeTextFallback() : helpAnswer(entry, pathname)
      append([answer], answer.role === 'assistant' && answer.followUps.length > 0 ? answer.followUps : routeReplies())
      return
    }
    if (reply.kind === 'login-benefits') {
      const answer = loginBenefitsAnswer(returnTo)
      append([answer], answer.role === 'assistant' ? answer.followUps : [])
      return
    }
    if (reply.kind === 'contact') {
      const answer = contactAnswer(contactUrl)
      append([answer], answer.role === 'assistant' ? answer.followUps : [])
      return
    }
    if (!isAuthenticated) {
      const answer = loginPromptAnswer(returnTo)
      append([answer], [otherQuestionReply])
      return
    }
    if (reply.kind === 'received-proposals') {
      const answer = receivedProposalsAnswer(receivedProposals, session)
      append([answer], answer.role === 'assistant' ? answer.followUps : [])
      return
    }
    // 관심 공고는 UseCase로 읽습니다. 실패해도 대화를 막지 않고 안내로 남깁니다.
    updateUi({ isTyping: true })
    try {
      const saved = await browseSavedPrograms.execute()
      if (!isCurrentSession()) return
      const answer = savedProgramsAnswer(saved, new Date())
      append([answer], answer.role === 'assistant' ? answer.followUps : [])
    } catch {
      if (!isCurrentSession()) return
      append([{ ...freeTextFallback(), paragraphs: [assistantMessages.loadFailed], tone: 'warn', followUps: [reply, otherQuestionReply] } as AssistantMessage], [reply, otherQuestionReply])
    } finally {
      if (isCurrentSession()) updateUi({ isTyping: false })
    }
  }, [append, browseSavedPrograms, contactUrl, isAuthenticated, pathname, receivedProposals, returnTo, routeReplies, session, submitText,
    dispatchToStore, conversationSession, isCurrentSession, updateUi])

  return {
    /** 채팅 화면·로그인처럼 도우미를 두지 않는 화면입니다. 아래 고정 바 위로 올리는 일은 CSS(assistantLift)가 맡습니다. */
    isHidden: !authResolved || isAssistantHiddenOn(pathname),
    isOpen,
    open,
    close,
    toggle: () => { if (isOpen) close(); else open() },
    showLabel: showLabel && !isOpen,
    hasUnread: hasUnread && !isOpen,
    messages,
    quickReplies,
    isTyping,
    pickQuickReply: (reply: AssistantQuickReply) => { void pickQuickReply(reply) },
    /** 자유 질문 입력창을 둘지입니다. 거짓이면 입력창 대신 로그인 안내와 [loginPath] 링크를 둡니다. */
    canAskFreeText,
    loginPath: loginPathFor(returnTo),
    submitText: (text: string) => { void submitText(text) },
    prepareNavigation,
    startNewConversation,
  }
}

export type AssistantViewModel = ReturnType<typeof useAssistantViewModel>
