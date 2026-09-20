import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router'

import { appContainer } from '../../../app/appContainer'
import { useAppDispatch } from '../../../app/hooks'
import type { AskAssistantUseCase } from '../../../domain/usecases/AskAssistantUseCase'
import { isValidAssistantMessage } from '../../../domain/usecases/AskAssistantUseCase'
import type { BrowseSavedSupportProgramsUseCase } from '../../../domain/usecases/SavedSupportProgramUseCases'
import type { IsAssistantAiEnabled } from '../../../data/config/assistantAi'
import type { KakaoChannelChatUrl } from '../../../data/config/kakaoChannel'
import { draftChanged } from '../../features/chat/state/chatSlice'
import { useAuthSession } from '../auth/hooks/useAuthSession'
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
  greetingMessages,
  helpAnswer,
  isAssistantHiddenOn,
  isComposerScreen,
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

type SavedProgramsUseCase = Pick<BrowseSavedSupportProgramsUseCase, 'execute'>
type AskUseCase = Pick<AskAssistantUseCase, 'execute'>

/**
 * 자유 질문은 이 시간 안에 답이 없으면 끊고 다시 시도를 안내합니다. 도구 에이전트의 관심 공고 질문은 분류 → 원문 확보(최대 6초) →
 * 근거 판단·답의 두 번 호출이라 20초를 넘길 수 있어 그보다 넉넉히 둡니다.
 */
export const assistantAnswerTimeoutMs = 45_000

/** 대화는 브라우저 세션 동안만 남습니다. 탭을 닫으면 사라지고 서버에는 보내지 않습니다. */
export const assistantConversationStorageKey = 'govbiz.assistant.conversation'
const labelShownStorageKey = 'govbiz.assistant.labelShown'
/** 첫 방문에 런처 옆 라벨을 보여 주는 시간입니다. */
export const assistantLauncherLabelMs = 5_000

type StoredConversation = { messages: AssistantMessage[]; quickReplies: AssistantQuickReply[] }

function readStored(): StoredConversation | null {
  try {
    const raw = window.sessionStorage.getItem(assistantConversationStorageKey)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Partial<StoredConversation>
    if (!Array.isArray(record.messages) || !Array.isArray(record.quickReplies)) return null
    return { messages: record.messages, quickReplies: record.quickReplies }
  } catch {
    return null
  }
}

function writeStored(value: StoredConversation | null) {
  try {
    if (value === null) window.sessionStorage.removeItem(assistantConversationStorageKey)
    else window.sessionStorage.setItem(assistantConversationStorageKey, JSON.stringify(value))
  } catch {
    // 저장이 막힌 브라우저에서는 대화가 새로고침에 남지 않을 뿐입니다.
  }
}

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
  const { pathname, search } = useLocation()
  const { isAuthenticated, hasCompany } = useAuthSession()
  const receivedProposals = useReceivedProposals()
  // 채널 주소는 빌드 환경값이라 인스턴스 동안 고정입니다. 대화 규칙 함수에는 값으로 넘겨 환경을 직접 읽지 않게 합니다.
  const contactUrl = useMemo(() => kakaoChannelChatUrl(), [kakaoChannelChatUrl])
  // 모델 호출은 빌드 스위치로만 켭니다. 꺼져 있으면 자유 입력을 주제 알약으로 돌려보내 비용이 들지 않습니다.
  const aiEnabled = useMemo(() => isAssistantAiEnabled(), [isAssistantAiEnabled])
  const session = useMemo(() => ({ isAuthenticated, hasCompany, contactUrl }), [isAuthenticated, hasCompany, contactUrl])
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<AssistantMessage[]>(() => readStored()?.messages ?? [])
  const [quickReplies, setQuickReplies] = useState<AssistantQuickReply[]>(() => readStored()?.quickReplies ?? [])
  const [isTyping, setIsTyping] = useState(false)
  const [hasUnread, setHasUnread] = useState(false)
  const [showLabel, setShowLabel] = useState(() => !readLabelShown())
  const isOpenRef = useRef(isOpen)
  isOpenRef.current = isOpen

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
    writeStored(messages.length === 0 ? null : { messages, quickReplies })
  }, [messages, quickReplies])

  const routeReplies = useCallback(() => quickRepliesFor(session), [session])

  const append = useCallback((next: AssistantMessage[], followUps: AssistantQuickReply[]) => {
    setMessages((current) => [...current, ...next])
    setQuickReplies(followUps)
    if (!isOpenRef.current) setHasUnread(true)
  }, [])

  const open = useCallback(() => {
    setIsOpen(true)
    setHasUnread(false)
    setShowLabel(false)
    if (messages.length === 0) {
      setMessages(greetingMessages())
      setQuickReplies(routeReplies())
    } else if (quickReplies.length === 0) {
      setQuickReplies(routeReplies())
    }
  }, [messages.length, quickReplies.length, routeReplies])

  const close = useCallback(() => setIsOpen(false), [])

  const startNewConversation = useCallback(() => {
    setMessages(greetingMessages())
    setQuickReplies(routeReplies())
  }, [routeReplies])

  const returnTo = `${pathname}${search}`

  /**
   * 자유 질문을 Core에 보냅니다. 최근 대화 6개, 현재 화면 경로와 공고 선택 여부, 챗봇 표면의 도움말 전량을 함께 실어
   * 서버가 인용을 그 안에서만 인정하게 합니다. 45초 안에 답이 없으면 끊고 다시 시도를 안내합니다.
   */
  const submitText = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (trimmed === '') return
    const asked = userMessage(trimmed)
    if (!aiEnabled || !isValidAssistantMessage(trimmed)) {
      append([asked, freeTextFallback()], routeReplies())
      return
    }
    const history = messages.slice(-6).map((item) => (item.role === 'user'
      ? { role: 'USER' as const, content: item.text }
      : { role: 'ASSISTANT' as const, content: item.paragraphs.join(' ') }))
    setMessages((current) => [...current, asked])
    setQuickReplies([])
    setIsTyping(true)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), assistantAnswerTimeoutMs)
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
      const answer = result.outcome === 'answered'
        ? freeTextAnswer(result.answer, { pathname, search, session, returnTo })
        : freeTextFailure(trimmed, result.outcome === 'rate-limited' ? assistantMessages.rateLimited(result.retryAfterSeconds) : assistantMessages.unavailable)
      append([answer], answer.role === 'assistant' && answer.followUps.length > 0 ? answer.followUps : routeReplies())
    } catch {
      const answer = freeTextFailure(trimmed, assistantMessages.loadFailed)
      append([answer], answer.role === 'assistant' ? answer.followUps : [])
    } finally {
      clearTimeout(timer)
      setIsTyping(false)
    }
  }, [aiEnabled, append, askAssistant, messages, pathname, returnTo, routeReplies, search, session])

  /** 검색 이동 버튼은 검색 입력창에 도우미가 고른 검색어를 미리 채웁니다. 검색 자체는 사용자가 보낼 때 시작합니다. */
  const prepareNavigation = useCallback((button: AssistantCardButton) => {
    if (button.searchQuery !== undefined) dispatchToStore(draftChanged(button.searchQuery))
  }, [dispatchToStore])

  const pickQuickReply = useCallback(async (reply: AssistantQuickReply) => {
    if (reply.kind === 'other') {
      setQuickReplies(routeReplies())
      return
    }
    if (reply.kind === 'retry') {
      await submitText(reply.text ?? '')
      return
    }
    const asked = userMessage(reply.label)
    setMessages((current) => [...current, asked])
    setQuickReplies([])

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
    setIsTyping(true)
    try {
      const saved = await browseSavedPrograms.execute()
      const answer = savedProgramsAnswer(saved, new Date())
      append([answer], answer.role === 'assistant' ? answer.followUps : [])
    } catch {
      append([{ ...freeTextFallback(), paragraphs: [assistantMessages.loadFailed], tone: 'warn', followUps: [reply, otherQuestionReply] } as AssistantMessage], [reply, otherQuestionReply])
    } finally {
      setIsTyping(false)
    }
  }, [append, browseSavedPrograms, contactUrl, isAuthenticated, pathname, receivedProposals, returnTo, routeReplies, session, submitText])

  return {
    isHidden: isAssistantHiddenOn(pathname),
    isLifted: isComposerScreen(pathname),
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
    submitText: (text: string) => { void submitText(text) },
    prepareNavigation,
    startNewConversation,
  }
}

export type AssistantViewModel = ReturnType<typeof useAssistantViewModel>
