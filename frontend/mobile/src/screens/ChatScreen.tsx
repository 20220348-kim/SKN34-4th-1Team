import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from 'react-native'
import { randomUUID } from 'expo-crypto'
import type { ChatConversationSnapshot, ChatConversationSummary, ChatMessage } from '@govbiz/shared/domain/entities/ChatConversation'
import type { SupportProgramConversationContext, SupportProgramInterpretation, SupportProgramPendingClarification } from '@govbiz/shared/domain/entities/SupportProgramConversation'
import type { SupportProgramSearchResult } from '@govbiz/shared/domain/entities/SupportProgramSearchResult'
import { RestoreSupportProgramSearchUseCase } from '@govbiz/shared/domain/usecases/RestoreSupportProgramSearchUseCase'
import { SearchSupportProgramsUseCase } from '@govbiz/shared/domain/usecases/SearchSupportProgramsUseCase'
import { SupportProgramSearchRestoreError } from '@govbiz/shared/domain/errors/SupportProgramSearchRestoreError'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { ApiError, errorMessage, programClient, requestResultUnconfirmed, requestRetryAfterSeconds } from '../api/client'
import { restoreSearchResults, searchPrograms } from '../api/searchResults'
import { deleteChatConversation, getChatConversation, listChatConversations, saveChatConversation } from '../api/chatConversations'
import type { LoginRequest } from '../auth/loginFlow'
import { useAuth } from '../auth/session'
import { SearchProgramCard } from '../components/SearchProgramCard'
import { SearchConditionCard } from '../components/SearchConditionCard'
import { AppIcon } from '../components/AppIcon'
import { PartnerSheet } from '../components/PartnerSheet'
import type { SearchProgramInterests } from '../components/SearchProgramInterests'
import { Button, Notice, colors, styles } from '../ui'

import { chatSearchOptions, chatSnapshot, contextFromSearch, emptyChatContext as emptyContext } from './chatConversationState'

type TimelineTarget = 'message' | 'waiting' | 'answer' | 'proposal' | 'results' | 'notice'

export function ChatScreen({ onOpenProgram, onLogin, keyboardOffset = 0, active = true, interests }: {
  onOpenProgram: (identity: SupportProgramIdentity) => void; onLogin: (request?: LoginRequest) => void; keyboardOffset?: number; active?: boolean
  interests?: SearchProgramInterests
}) {
  const { session, status, invalidateSession } = useAuth()
  const composerInput = useRef<TextInput>(null)
  const timeline = useRef<ScrollView>(null)
  const scrollRevision = useRef(0)
  const scrollFrame = useRef<number | null>(null)
  const timelineActive = useRef(active)
  const timelineSize = useRef({ viewport: 0, content: 0 })
  const pendingScroll = useRef<{ id: number; target: TimelineTarget; layout?: { y: number; height: number } } | null>(null)
  const [timelineVersions, setTimelineVersions] = useState({ message: 0, waiting: 0, answer: 0, proposal: 0, results: 0, notice: 0 })
  const token = status === 'signedIn' ? session?.accessToken : undefined
  const client = useMemo(() => programClient(token), [token])
  const [message, setMessage] = useState('')
  const [context, setContext] = useState(emptyContext)
  const [proposal, setProposal] = useState<SupportProgramInterpretation | null>(null)
  const [clarification, setClarification] = useState<SupportProgramPendingClarification | null>(null)
  const [result, setResult] = useState<SupportProgramSearchResult | null>(null)
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState<'interpret' | 'search' | 'restore' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryAction, setRetryAction] = useState<'interpret' | 'search' | null>(null)
  const [retryUnconfirmed, setRetryUnconfirmed] = useState(false)
  const [retryUntil, setRetryUntil] = useState(0)
  const [retryClock, setRetryClock] = useState(Date.now())
  const retryRemaining = Math.max(0, Math.ceil((retryUntil - retryClock) / 1000))
  useEffect(() => {
    if (retryUntil <= Date.now()) return
    const timer = setInterval(() => { const now = Date.now(); setRetryClock(now); if (now >= retryUntil) clearInterval(timer) }, 1000)
    return () => clearInterval(timer)
  }, [retryUntil])
  function markRetry(cause: unknown, action: 'interpret' | 'search') {
    setRetryAction(action); setRetryUnconfirmed(requestResultUnconfirmed(cause))
    const wait = requestRetryAfterSeconds(cause)
    const now = Date.now(); setRetryClock(now); setRetryUntil(wait ? now + wait * 1000 : 0)
  }
  const [sessionNotice, setSessionNotice] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const previousToken = useRef(token)
  const pendingRestore = useRef<{ resultToken: string; context: SupportProgramConversationContext; history: typeof history } | null>(null)
  const retryRestore = useRef<typeof pendingRestore.current>(null)
  const [restoreFailure, setRestoreFailure] = useState<'expired' | 'unavailable' | null>(null)
  const email = session?.account?.email
  const historyWork = useRef<AbortController | null>(null)
  const conversationVersion = useRef(0)
  const unsavedSnapshot = useRef<ChatConversationSnapshot | null>(null)
  const [savingHistory, setSavingHistory] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [records, setRecords] = useState<ChatConversationSummary[]>([])
  const [recordsCursor, setRecordsCursor] = useState<number | null>(null)
  const [loadingRecords, setLoadingRecords] = useState(false)
  const [recordsError, setRecordsError] = useState<string | null>(null)
  const [deletingRecord, setDeletingRecord] = useState<string | null>(null)
  const deletionId = useRef<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [historyRestored, setHistoryRestored] = useState(false)

  function cancelScrollFrame() {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = null
  }

  function clearTimelineScroll() { cancelScrollFrame(); pendingScroll.current = null }

  function requestTimelineScroll(target: TimelineTarget) {
    cancelScrollFrame()
    const id = ++scrollRevision.current
    pendingScroll.current = { id, target }
    // Remount only the new target so equal-sized replies also report their current layout.
    setTimelineVersions(previous => ({ ...previous, [target]: id }))
  }

  function scrollPendingTimeline() {
    const pending = pendingScroll.current
    if (!timelineActive.current || !pending?.layout || timelineSize.current.viewport <= 0
      || timelineSize.current.content < pending.layout.y + pending.layout.height || scrollFrame.current !== null) return
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null
      const current = pendingScroll.current
      if (!timelineActive.current || current?.id !== pending.id || !current.layout || !timeline.current) return
      if (timelineSize.current.viewport <= 0 || timelineSize.current.content < current.layout.y + current.layout.height) return
      const y = Math.max(0, Math.min(current.layout.y - 16, timelineSize.current.content - timelineSize.current.viewport))
      timeline.current.scrollTo({ y, animated: true })
      pendingScroll.current = null
    })
  }

  function recordTimelineTarget(target: TimelineTarget, id: number, event: LayoutChangeEvent) {
    const pending = pendingScroll.current
    const { y, width, height } = event.nativeEvent.layout
    if (pending?.target !== target || pending.id !== id || width <= 0 || height <= 0) return
    pending.layout = { y, height }
    scrollPendingTimeline()
  }

  useEffect(() => {
    timelineActive.current = active
    if (active) scrollPendingTimeline()
    return cancelScrollFrame
  }, [active])

  useEffect(() => {
    clearTimelineScroll()
    const selected = !previousToken.current && token ? pendingRestore.current : null
    previousToken.current = token; pendingRestore.current = null; retryRestore.current = null
    generation.current += 1
    request.current?.abort(); historyWork.current?.abort()
    conversationVersion.current = 0; unsavedSnapshot.current = null
    deletionId.current = null; setDeletingRecord(null); setDeleteError(null)
    setSavingHistory(false); setHistoryError(null); setRecordsOpen(false); setRecords([]); setRecordsCursor(null); setLoadingRecords(false); setRecordsError(null); setHistoryRestored(false)
    setMessage(''); setContext(emptyContext); setProposal(null); setClarification(null); setResult(null)
    setHistory([]); setBusy(null); setError(null); setRetryAction(null); setRetryUntil(0)
    setRestoreFailure(null)
    if (token) setSessionNotice(null)
    if (selected && token) void restore(selected, token)
    return () => { generation.current += 1; request.current?.abort(); historyWork.current?.abort(); clearTimelineScroll() }
  }, [token])

  async function persist(snapshot: ChatConversationSnapshot) {
    if (!token || !email || deletionId.current) return
    unsavedSnapshot.current = snapshot
    const controller = new AbortController(); historyWork.current = controller
    const revision = generation.current
    setSavingHistory(true); setHistoryError(null)
    try {
      const id = snapshot.messages.find(item => item.role === 'user')!.id
      const saved = await saveChatConversation(token, email, id, conversationVersion.current, snapshot, controller.signal)
      if (controller.signal.aborted || revision !== generation.current) return
      conversationVersion.current = saved.version; unsavedSnapshot.current = null
    } catch (cause) {
      if (controller.signal.aborted || revision !== generation.current) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setHistoryError(cause instanceof ApiError ? cause.message : '대화 기록을 저장하지 못했어요. 현재 대화는 유지됩니다. 다시 저장해 주세요.')
    } finally { if (!controller.signal.aborted && revision === generation.current) setSavingHistory(false) }
  }

  function confirmDiscard(action: () => void) {
    if (busy || savingHistory || loadingRecords || deletionId.current) return
    if (unsavedSnapshot.current) Alert.alert('저장하지 못한 대화가 있어요', '화면을 바꾸면 저장하지 못한 내용은 사라질 수 있어요.', [
      { text: '계속 보기', style: 'cancel' }, { text: '이동하기', onPress: action },
    ])
    else action()
  }

  function newConversation() {
    generation.current += 1; request.current?.abort(); historyWork.current?.abort(); clearTimelineScroll()
    pendingRestore.current = null; retryRestore.current = null; conversationVersion.current = 0; unsavedSnapshot.current = null
    setHistory([]); setContext(emptyContext); setResult(null); setProposal(null); setClarification(null); setMessage('')
    setError(null); setRetryAction(null); setRetryUntil(0); setHistoryError(null); setRestoreFailure(null); setSessionNotice(null)
    setHistoryRestored(false)
    timeline.current?.scrollTo({ y: 0, animated: false })
  }

  async function readRecords(before: number | null = null) {
    if (!token || !email || busy || savingHistory || loadingRecords || deletionId.current) return
    historyWork.current?.abort()
    const controller = new AbortController(); historyWork.current = controller
    setRecordsOpen(true); setLoadingRecords(true); setRecordsError(null); setDeleteError(null)
    if (before === null) { setRecords([]); setRecordsCursor(null) }
    try {
      const page = await listChatConversations(token, email, before, controller.signal)
      if (controller.signal.aborted) return
      setRecords(previous => before === null ? page.items : [...previous, ...page.items.filter(item => !previous.some(existing => existing.id === item.id))])
      setRecordsCursor(page.nextCursor)
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setRecordsError('대화 기록을 불러오지 못했어요. 다시 시도해 주세요.')
    } finally { if (!controller.signal.aborted) setLoadingRecords(false) }
  }

  async function openConversation(id: string) {
    if (!token || !email || loadingRecords || savingHistory || busy || deletionId.current) return
    historyWork.current?.abort(); clearTimelineScroll()
    const controller = new AbortController(); historyWork.current = controller
    const revision = ++generation.current
    setLoadingRecords(true); setRecordsError(null)
    try {
      const detail = await getChatConversation(token, email, id, controller.signal)
      if (controller.signal.aborted || revision !== generation.current) return
      const snapshot = detail.snapshot
      const restoredContext = contextFromSearch(snapshot.conversationQuery, snapshot.searchOptions)
      const latestResult = [...snapshot.messages].reverse().find(item => item.programs !== undefined)
      const restoredProposal = snapshot.interpretation.result ?? (snapshot.pendingProposal
        ? { status: 'READY' as const, proposedContext: snapshot.pendingProposal, clarificationQuestion: null, changedFields: [] } : null)
      conversationVersion.current = detail.conversation.version; unsavedSnapshot.current = null
      setHistory(snapshot.messages); setContext(restoredContext); setMessage(''); setProposal(restoredProposal); setClarification(snapshot.pendingClarification)
      setResult(latestResult ? { query: latestResult.searchQuery ?? '', programs: latestResult.programs!, totalCount: latestResult.totalCount ?? latestResult.programs!.length,
        resultToken: latestResult.resultToken ?? null, expiresAt: latestResult.expiresAt ?? null } : null)
      pendingRestore.current = null; retryRestore.current = null
      setRetryAction(null); setRetryUnconfirmed(false)
      setHistoryError(null); setError(snapshot.searchError ?? snapshot.interpretation.error ?? null); setRestoreFailure(null); setSessionNotice(null); setRecordsOpen(false)
      setHistoryRestored(true)
      requestTimelineScroll(restoredProposal?.status === 'READY' ? 'proposal' : latestResult ? 'results' : 'answer')
    } catch (cause) {
      if (controller.signal.aborted || revision !== generation.current) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setRecordsError(cause instanceof ApiError && cause.status === 404 ? '이 대화 기록은 더 이상 찾을 수 없어요.' : '대화를 열지 못했어요. 다시 시도해 주세요.')
    } finally { if (!controller.signal.aborted && revision === generation.current) setLoadingRecords(false) }
  }

  function confirmDelete(record: ChatConversationSummary) {
    if (busy || savingHistory || loadingRecords || deletionId.current) return
    const revision = generation.current
    Alert.alert('대화 기록을 삭제할까요?', `“${record.title}”의 질문·답변·추천 공고가 삭제됩니다. 삭제한 기록은 복구할 수 없어요.`, [
      { text: '취소', style: 'cancel' }, { text: '삭제', style: 'destructive', onPress: () => {
        if (revision === generation.current && previousToken.current === token) void removeConversation(record.id)
      } },
    ])
  }

  async function removeConversation(id: string) {
    if (!token || !email || busy || savingHistory || loadingRecords || deletionId.current) return
    deletionId.current = id; setDeletingRecord(id); setDeleteError(null)
    historyWork.current?.abort()
    const controller = new AbortController(); historyWork.current = controller
    const revision = generation.current
    try {
      await deleteChatConversation(token, email, id, controller.signal)
      if (controller.signal.aborted || revision !== generation.current) return
      setRecords(previous => previous.filter(record => record.id !== id))
      deletionId.current = null; setDeletingRecord(null)
      if (history.find(item => item.role === 'user')?.id === id) newConversation()
    } catch (cause) {
      if (controller.signal.aborted || revision !== generation.current) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setDeleteError('대화 기록을 삭제하지 못했어요. 기록은 유지됩니다. 다시 삭제해 주세요.')
    } finally {
      if (!controller.signal.aborted && revision === generation.current) { deletionId.current = null; setDeletingRecord(null) }
    }
  }

  function closeRecords() {
    if (deletionId.current) return
    historyWork.current?.abort(); setLoadingRecords(false); setRecordsOpen(false)
  }

  async function restore(selected: NonNullable<typeof pendingRestore.current>, accessToken: string) {
    const controller = new AbortController(); request.current = controller
    const revision = ++generation.current
    setBusy('restore'); setError(null); setRestoreFailure(null); retryRestore.current = selected
    requestTimelineScroll('waiting')
    try {
      const restored = await new RestoreSupportProgramSearchUseCase({
        restoreSearch: (resultToken, signal) => restoreSearchResults(accessToken, resultToken, signal),
      }).execute(selected.resultToken, controller.signal)
      if (controller.signal.aborted || generation.current !== revision) return
      const restoredHistory = selected.history.map(item => item.resultToken === selected.resultToken
        ? { ...item, programs: restored.programs, totalCount: restored.totalCount, resultToken: restored.resultToken, expiresAt: restored.expiresAt } : item)
      const lastResult = [...restoredHistory].reverse().find(item => item.programs !== undefined)!
      const lastContext = contextFromSearch(lastResult.searchQuery ?? null, lastResult.searchOptions ?? chatSearchOptions(restored.context))
      setContext(lastContext); setResult({ query: lastResult.searchQuery ?? '', programs: lastResult.programs!, totalCount: lastResult.totalCount ?? lastResult.programs!.length,
        resultToken: lastResult.resultToken ?? null, expiresAt: lastResult.expiresAt ?? null })
      setHistory(restoredHistory); retryRestore.current = null
      requestTimelineScroll('results')
      setBusy(null)
      await persist(chatSnapshot(restoredHistory, lastContext, null, null))
    } catch (cause) {
      if (controller.signal.aborted || generation.current !== revision) return
      if (cause instanceof SupportProgramSearchRestoreError && cause.reason === 'unauthorized') {
        setSessionNotice('로그인이 만료되었습니다. 다시 로그인해 주세요.')
        retryRestore.current = null; void invalidateSession().catch(() => undefined)
      } else {
        setRestoreFailure(cause instanceof SupportProgramSearchRestoreError && cause.reason === 'expired' ? 'expired' : 'unavailable')
      }
      setError(cause instanceof SupportProgramSearchRestoreError && cause.reason === 'unauthorized' ? null
        : cause instanceof SupportProgramSearchRestoreError ? cause.message : '검색 결과를 불러오지 못했습니다. 다시 시도해 주세요.')
      requestTimelineScroll('notice')
    } finally { if (generation.current === revision) setBusy(null) }
  }

  function cancel() { generation.current += 1; request.current?.abort(); setBusy(null); clearTimelineScroll() }

  async function interpret() {
    if (!message.trim() || busy || savingHistory || loadingRecords || deletionId.current || history.length >= 197 || retryUntil > Date.now()) return
    const controller = new AbortController(); request.current = controller
    const revision = ++generation.current
    const text = message.trim()
    setBusy('interpret'); setError(null); setRetryAction(null)
    requestTimelineScroll('message')
    pendingRestore.current = null; retryRestore.current = null; setRestoreFailure(null)
    setSessionNotice(null)
    try {
      const next = await client.interpretConversation({ message: text, context,
        pendingClarification: clarification, pendingProposal: proposal?.status === 'READY' ? proposal.proposedContext : null,
        lastSearch: result ? { context, resultCount: result.totalCount } : null,
      }, controller.signal)
      if (controller.signal.aborted || generation.current !== revision) return
      setProposal(next); setMessage('')
      const nextClarification = next.status === 'CLARIFICATION_REQUIRED' && next.clarificationQuestion
        ? { question: next.clarificationQuestion, draftContext: next.proposedContext } : null
      setClarification(nextClarification)
      const nextHistory: ChatMessage[] = [...history, { id: randomUUID(), role: 'user', text },
        { id: randomUUID(), role: 'assistant', text: next.answer ?? next.clarificationQuestion ?? '아래 검색 조건을 확인해 주세요.' }]
      setHistory(nextHistory)
      requestTimelineScroll(next.status === 'READY' ? 'proposal' : 'answer')
      setBusy(null)
      await persist(chatSnapshot(nextHistory, context, next, nextClarification))
    } catch (cause) {
      if (!controller.signal.aborted && generation.current === revision) {
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setError(errorMessage(cause))
        markRetry(cause, 'interpret')
        requestTimelineScroll('notice')
      }
    } finally { if (generation.current === revision) setBusy(null) }
  }

  async function search() {
    if (busy || savingHistory || loadingRecords || deletionId.current || proposal?.status !== 'READY' || !proposal.proposedContext.query || message.trim() || retryUntil > Date.now()) return
    const controller = new AbortController(); request.current = controller
    const revision = ++generation.current
    const nextContext = proposal.proposedContext
    setBusy('search'); setError(null); setRetryAction(null)
    let completed: SupportProgramSearchResult | null = null
    requestTimelineScroll('waiting')
    try {
      const readiness = await client.getSearchReadiness(controller.signal)
      if (controller.signal.aborted || generation.current !== revision) return
      if (!readiness.indexReady || !['SEARCHABLE', 'SEARCHABLE_WITH_SYNC_FAILURE', 'SEARCHABLE_WITH_PARTIAL_SOURCES'].includes(readiness.searchState)) {
        setError('검색 데이터를 준비 중입니다. 잠시 후 다시 검색해 주세요.')
        setRetryAction('search'); setRetryUnconfirmed(false)
        requestTimelineScroll('notice')
        return
      }
      const conditions = Object.fromEntries(Object.entries(nextContext.companyConditions).filter(([, value]) => value != null))
      let next = await new SearchSupportProgramsUseCase({ search: (command, signal) => searchPrograms(token, command, signal) })
        .execute({ query: nextContext.query!, acceptingOnly: nextContext.acceptingOnly, companyConditions: conditions }, controller.signal)
      if (controller.signal.aborted || generation.current !== revision) return
      completed = next
      if (token && next.resultToken) next = await new RestoreSupportProgramSearchUseCase({
        restoreSearch: (resultToken, signal) => restoreSearchResults(token, resultToken, signal),
      }).execute(next.resultToken, controller.signal)
      if (controller.signal.aborted || generation.current !== revision) return
      setContext(nextContext); setResult(next); setProposal(null); setClarification(null)
      const nextHistory: ChatMessage[] = [...history, { id: randomUUID(), role: 'assistant', text: `관련 공고 ${next.totalCount}건을 찾았습니다.`,
        programs: next.programs, totalCount: next.totalCount, resultToken: next.resultToken, expiresAt: next.expiresAt,
        searchQuery: nextContext.query!, searchOptions: chatSearchOptions(nextContext) }]
      setHistory(nextHistory)
      requestTimelineScroll('results')
      setBusy(null)
      await persist(chatSnapshot(nextHistory, nextContext, null, null))
    } catch (cause) {
      if (!controller.signal.aborted && generation.current === revision) {
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        if (token && completed?.resultToken && cause instanceof SupportProgramSearchRestoreError) {
          const known = completed
          const nextHistory: ChatMessage[] = [...history, { id: randomUUID(), role: 'assistant', text: '검색은 완료됐지만 전체 결과를 아직 불러오지 못했어요.',
            programs: known.programs, totalCount: known.totalCount, resultToken: known.resultToken, expiresAt: known.expiresAt,
            searchQuery: nextContext.query!, searchOptions: chatSearchOptions(nextContext) }]
          retryRestore.current = { resultToken: known.resultToken!, context: nextContext, history: nextHistory }
          setHistory(nextHistory); setContext(nextContext); setResult(known); setProposal(null)
          setRetryAction(null)
          if (cause.reason === 'unauthorized') {
            retryRestore.current = null; setSessionNotice('로그인이 만료됐어요. 다시 로그인해 주세요.')
            void invalidateSession().catch(() => undefined)
          } else {
            setRestoreFailure(cause.reason === 'expired' ? 'expired' : 'unavailable')
            setError('검색은 완료됐지만 전체 결과를 불러오지 못했어요. 같은 결과를 다시 확인해 주세요.')
          }
        } else { setError(errorMessage(cause)); markRetry(cause, 'search') }
        requestTimelineScroll('notice')
      }
    } finally { if (generation.current === revision) setBusy(null) }
  }

  const introductory = history.length === 0 && !proposal && !result && !busy
  const latestResultId = [...history].reverse().find(item => item.programs !== undefined)?.id
  const blocked = Boolean(busy) || savingHistory || loadingRecords || deletingRecord !== null
  function retryRequest() {
    if (blocked || retryRemaining > 0) return
    const revision = generation.current
    const action = () => {
      if (generation.current !== revision) return
      if (retryAction === 'search') void search()
      else void interpret()
    }
    if (retryUnconfirmed) Alert.alert('같은 요청을 다시 보낼까요?', '이전 요청의 결과를 확인하지 못했어요. 다시 보내면 새 요청이 실행돼요.', [
      { text: '입력 계속 확인', style: 'cancel' }, { text: '새 요청으로 다시 시도', onPress: action },
    ])
    else action()
  }
  function renderResults(item: ChatMessage) {
    const latest = item.id === latestResultId
    const programs = item.programs ?? []
    const totalCount = item.totalCount ?? programs.length
    return <View key={latest ? `results-${item.id}-${timelineVersions.results}` : item.id}
      testID={latest ? 'ai-search-results' : 'ai-search-previous-results'} style={local.contentGroup}
      onLayout={latest ? event => recordTimelineTarget('results', timelineVersions.results, event) : undefined}>
      <View style={styles.row}><Text style={styles.heading}>추천 공고</Text><Text style={styles.muted}>{totalCount}건</Text></View>
      {totalCount === 0 && <Notice>조건에 맞는 공고가 없습니다. 필요한 지원이나 회사 조건을 바꿔 보세요.</Notice>}
      {programs.map(program => <SearchProgramCard key={JSON.stringify([program.sourceCode, program.id])} program={program} onOpen={onOpenProgram}
        interests={interests} onLogin={() => onLogin()} searchRegion={item.searchOptions?.companyConditions?.region ?? null} />)}
      {!token && item.resultToken && totalCount > programs.length && <View style={local.locked}>
        <Text style={styles.heading}>이번 추천에 {totalCount - programs.length}건이 더 있어요</Text>
        <Text style={styles.body}>로그인하면 이번 추천 {totalCount}건을 같은 검색에서 확인할 수 있어요.</Text>
        <Button label="로그인하고 이번 추천 보기" disabled={status !== 'signedOut' || blocked} onPress={() => {
          pendingRestore.current = { resultToken: item.resultToken!, context: contextFromSearch(item.searchQuery ?? null, item.searchOptions ?? chatSearchOptions(context)), history }
          onLogin({ direct: true, message: '이번 검색 결과를 그대로 이어서 확인할 수 있어요.', onCancel: () => { pendingRestore.current = null } })
        }} />
        <Button label="회원가입하고 이번 추천 보기" variant="secondary" disabled={status !== 'signedOut' || blocked} onPress={() => {
          pendingRestore.current = { resultToken: item.resultToken!, context: contextFromSearch(item.searchQuery ?? null, item.searchOptions ?? chatSearchOptions(context)), history }
          onLogin({ direct: true, mode: 'signup', message: '가입한 뒤 이번 추천 결과를 그대로 확인할 수 있어요.', onCancel: () => { pendingRestore.current = null } })
        }} />
        <View accessibilityLabel="로그인 후 확인할 지원사업" style={local.lockPreview}>
          <View style={local.lockLine} /><Text style={styles.muted}>로그인 후 확인할 수 있는 지원사업</Text>
        </View>
      </View>}
    </View>
  }
  return <KeyboardAvoidingView testID="ai-search-keyboard-container" style={local.page}
    behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={keyboardOffset} enabled={active}>
    {(token || history.length > 0) && <View style={local.historyToolbar}>
      {savingHistory && <ActivityIndicator accessibilityLabel="대화 기록 저장 중" color={colors.primary} />}
      {token && <Button label="대화 기록" variant="ghost" size="small" disabled={blocked} onPress={() => void readRecords()} />}
      <Button label="새 대화" variant="ghost" size="small" disabled={blocked} onPress={() => confirmDiscard(newConversation)} />
    </View>}
    <ScrollView ref={timeline} testID="ai-search-timeline" bounces={false} overScrollMode="never" style={local.scroll} contentContainerStyle={[local.timeline, introductory && { flexGrow: 1 }]}
      onLayout={event => { timelineSize.current.viewport = event.nativeEvent.layout.height; scrollPendingTimeline() }}
      onContentSizeChange={(_width, height) => { timelineSize.current.content = height; scrollPendingTimeline() }}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      {historyRestored && <Notice>이전 대화의 추천 공고는 저장 당시 정보예요. 최신 접수 상태와 신청 조건은 공고 상세에서 확인해 주세요.</Notice>}
      {introductory ? <View style={local.intro}>
        <View style={local.brandMark}><Text style={local.brandLetter}>G</Text></View>
        <Text accessibilityRole="header" style={local.introTitle}>우리 회사에 맞는 지원사업,</Text>
        <Text style={[local.introTitle, { color: colors.primary }]}>AI와 함께 <Text style={{ textDecorationLine: 'underline' }}>무료로</Text> 찾아보세요.</Text>
        <Text style={local.introDescription}>회사의 지역과 업종, 필요한 지원을 알려주세요.{'\n'}관련 공고와 확인할 신청 조건을 함께 안내합니다.</Text>
      </View> : null}
      {history.map((item, index) => <Fragment key={item.id}>{item.role === 'user'
        ? <View key={index} style={local.userBubble}><Text selectable style={styles.body}>{item.text}</Text></View>
        : <View key={index === history.length - 1 ? `answer-${index}-${timelineVersions.answer}` : index} style={local.assistant}
          testID={index === history.length - 1 ? 'ai-search-latest-answer' : undefined}
          onLayout={index === history.length - 1 ? event => recordTimelineTarget('answer', timelineVersions.answer, event) : undefined}>
          <View style={local.assistantName}><Text style={local.miniMark}>G</Text><Text style={local.name}>GovBiz AI</Text></View>
          {index === history.length - 1 && proposal?.status === 'CLARIFICATION_REQUIRED' && !busy
            ? <View testID="ai-search-clarification" style={local.clarification}>
              <Text style={local.clarificationEyebrow}>조금만 더 알려주세요</Text>
              <Text selectable style={local.clarificationQuestion}>{proposal.clarificationQuestion}</Text>
              <Text style={styles.muted}>답변을 입력해 주세요. 아직 검색하지 않았어요.</Text>
              <Button label="추가 내용 입력하기" variant="secondary" onPress={() => composerInput.current?.focus()} />
            </View> : <Text selectable style={local.answer}>{item.text}</Text>}
        </View>}{item.programs !== undefined && renderResults(item)}</Fragment>)}
      {busy === 'interpret' && <View key={`message-${timelineVersions.message}`} testID="ai-search-pending-message" style={local.userBubble}
        onLayout={event => recordTimelineTarget('message', timelineVersions.message, event)}><Text style={styles.body}>{message}</Text></View>}
      {busy && <View key={`waiting-${timelineVersions.waiting}`} testID="ai-search-waiting" accessibilityLiveRegion="polite" style={local.waiting}
        onLayout={event => recordTimelineTarget('waiting', timelineVersions.waiting, event)}><ActivityIndicator color={colors.primary} />
        <Text style={styles.body}>{busy === 'interpret' ? '검색 조건을 정리하는 중이에요.' : busy === 'restore' ? '로그인 전 검색 결과를 불러오는 중이에요.' : '공고를 찾는 중이에요.'}</Text></View>}
      {proposal?.status === 'READY' && <View key={`proposal-${timelineVersions.proposal}`} testID="ai-search-proposal" style={local.contentGroup}
        onLayout={event => recordTimelineTarget('proposal', timelineVersions.proposal, event)}>
        {message.trim() && <Notice>입력한 내용을 먼저 AI에게 보내 조건을 갱신해 주세요.</Notice>}
        <SearchConditionCard context={proposal.proposedContext} busy={Boolean(busy)} disabled={blocked || Boolean(message.trim()) || retryRemaining > 0 || retryUnconfirmed && retryAction === 'search'}
          onConfirm={() => void search()} onEdit={() => { setMessage(proposal.proposedContext.query ?? ''); setRetryAction(null); setRetryUnconfirmed(false); composerInput.current?.focus() }} />
      </View>}
      {(error || sessionNotice || restoreFailure) && <View key={`notice-${timelineVersions.notice}`} testID="ai-search-notice" style={local.contentGroup}
        onLayout={event => recordTimelineTarget('notice', timelineVersions.notice, event)}>
        {error && <Notice error>{error}</Notice>}
        {retryAction && <Button label={retryRemaining > 0 ? `${retryRemaining}초 후 다시 시도` : '다시 시도'} variant="secondary"
          disabled={blocked || retryRemaining > 0} onPress={retryRequest} />}
        {sessionNotice && <><Notice error>{sessionNotice}</Notice><Button label="다시 로그인" onPress={() => onLogin({ direct: true })} /></>}
        {restoreFailure === 'unavailable' && token && <Button label="검색 결과 다시 불러오기" disabled={Boolean(busy)}
          onPress={() => { if (retryRestore.current) void restore(retryRestore.current, token) }} />}
        {restoreFailure === 'expired' && <Button label="같은 조건으로 다시 검색" onPress={() => {
          const selected = retryRestore.current
          if (!selected) return
          setHistory(selected.history.filter(item => item.programs === undefined)); setContext(selected.context)
          setProposal({ status: 'READY', proposedContext: selected.context, clarificationQuestion: null, changedFields: [] })
          setMessage(''); setError(null); setRestoreFailure(null); retryRestore.current = null
          requestTimelineScroll('proposal')
        }} />}
      </View>}
      {historyError && <View style={local.contentGroup}><Notice error>{historyError}</Notice>
        <Button label="대화 다시 저장" variant="secondary" disabled={blocked} onPress={() => { if (unsavedSnapshot.current) void persist(unsavedSnapshot.current) }} /></View>}
      {history.length >= 197 && <Notice>이 대화의 기록 한도에 도달했어요. 새 대화에서 이어서 질문해 주세요.</Notice>}
      {(history.length > 0 || result) && proposal?.status !== 'CLARIFICATION_REQUIRED' && <View style={local.contentGroup}>
        {result?.totalCount === 0 && <Notice>
          지원받고 싶은 내용과 회사의 지역·업종을 추가로 알려 주세요. 기존 대화의 조건을 이어서 정리해요.
        </Notice>}
        <Button label="추가 내용 입력하기" variant="secondary" disabled={Boolean(busy)} onPress={() => composerInput.current?.focus()} />
      </View>}
      {introductory && status === 'signedOut' && <View style={local.guestHint}><Text style={local.hintText}>
        로그인 없이 검색과 협업 모집글을 둘러볼 수 있어요.{'\n'}공고 저장과 맞춤 리포트는 로그인 후 이용해요.</Text></View>}
    </ScrollView>
    <View testID="ai-search-composer" style={local.composerDock}>
      <View style={local.composer}>
        <TextInput ref={composerInput} accessibilityLabel="회사 상황이나 궁금한 점" placeholder={introductory
          ? '예: 서울에서 AI 서비스를 만드는 창업기업입니다. 사업화 지원을 받을 수 있을까요?'
          : '지원사업·조건을 입력해 주세요.'}
          placeholderTextColor={colors.placeholder} value={message} onChangeText={value => { setMessage(value); if (!busy) { setRetryAction(null); setRetryUnconfirmed(false) } }} multiline maxLength={500}
          editable={!blocked} style={local.input} />
        <Pressable accessibilityRole="button" accessibilityLabel={busy ? '요청 취소' : 'AI에게 보내기'}
          accessibilityState={{ disabled: !busy && (!message.trim() || blocked || history.length >= 197 || retryRemaining > 0), busy: Boolean(busy) }} disabled={!busy && (!message.trim() || blocked || history.length >= 197 || retryRemaining > 0)}
          onPress={busy ? cancel : () => void interpret()} style={[local.send, !busy && !message.trim() && { backgroundColor: colors.track }]}>
          {busy ? <View style={local.stop} /> : <AppIcon name="arrowUp" color={message.trim() ? colors.surface : colors.placeholder} size={22} />}
        </Pressable>
      </View>
      <Text style={local.disclaimer}>AI 답변은 참고용입니다. 최종 신청 조건은 공고 원문에서 확인하세요.</Text>
    </View>
    <PartnerSheet visible={recordsOpen} title="대화 기록" compact bottomSafeArea={false} onClose={closeRecords}
      actions={<Button label="닫기" accessibilityLabel="대화 기록 닫기" variant="secondary" disabled={deletingRecord !== null} style={{ flex: 1 }} onPress={closeRecords} />}>
      {loadingRecords && <ActivityIndicator accessibilityLabel="대화 기록 불러오는 중" color={colors.primary} />}
      {recordsError && <><Notice error>{recordsError}</Notice><Button label="대화 기록 다시 불러오기" disabled={loadingRecords} onPress={() => void readRecords()} /></>}
      {deleteError && <Notice error>{deleteError}</Notice>}
      {!loadingRecords && !recordsError && records.length === 0 && <Notice>저장한 대화가 없어요. 로그인 후 나눈 대화는 자동으로 저장됩니다.</Notice>}
      {records.map(record => <View key={record.id} style={local.recordRow}><Pressable accessibilityRole="button" accessibilityLabel={`대화 열기: ${record.title}`}
        disabled={loadingRecords || deletingRecord !== null} onPress={() => confirmDiscard(() => void openConversation(record.id))}
        style={({ pressed }) => [local.historyRow, pressed && { backgroundColor: colors.divider }]}>
        <Text numberOfLines={2} style={styles.body}>{record.title}</Text>
        <Text style={styles.muted}>{record.updatedAt.slice(0, 10)}</Text>
      </Pressable><Pressable accessibilityRole="button" accessibilityLabel={`대화 삭제: ${record.title}`}
        accessibilityState={{ disabled: loadingRecords || deletingRecord !== null, busy: deletingRecord === record.id }}
        disabled={loadingRecords || deletingRecord !== null} onPress={() => confirmDelete(record)}
        style={({ pressed }) => [local.deleteRecord, pressed && { backgroundColor: colors.divider }]}>
        {deletingRecord === record.id ? <ActivityIndicator accessibilityLabel="대화 기록 삭제 중" color={colors.muted} /> : <AppIcon name="trash" color={colors.muted} size={19} />}
      </Pressable></View>)}
      {recordsCursor !== null && <Button label="이전 대화 더 보기" variant="secondary" disabled={loadingRecords || deletingRecord !== null} onPress={() => void readRecords(recordsCursor)} />}
    </PartnerSheet>
  </KeyboardAvoidingView>
}

const local = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surface }, scroll: { flex: 1 },
  historyToolbar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 16, gap: 8 },
  historyRow: { flex: 1, minHeight: 56, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 12, gap: 4 },
  recordRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  deleteRecord: { width: 48, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  timeline: { paddingHorizontal: 16, paddingTop: 16, gap: 16, width: '100%', maxWidth: 720, alignSelf: 'center' },
  contentGroup: { gap: 16 },
  intro: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 32 },
  brandMark: { width: 54, height: 54, borderRadius: 17, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  brandLetter: { color: colors.primary, fontSize: 30, fontWeight: '700' },
  introTitle: { color: colors.text, fontSize: 26, fontWeight: '700', lineHeight: 38, textAlign: 'center' },
  introDescription: { color: colors.secondaryText, fontSize: 15, lineHeight: 25, textAlign: 'center', marginTop: 14 },
  guestHint: { backgroundColor: colors.soft, borderRadius: 14, padding: 14 }, hintText: { color: colors.primaryText, fontSize: 13, lineHeight: 22 },
  userBubble: { alignSelf: 'flex-end', maxWidth: '86%', backgroundColor: colors.divider, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 12 },
  assistant: { gap: 10 }, assistantName: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  miniMark: { overflow: 'hidden', backgroundColor: colors.primary, color: colors.surface, fontSize: 12, fontWeight: '700', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6 },
  clarification: { padding: 16, borderRadius: 20, borderWidth: 1, borderColor: '#CFE8DA', backgroundColor: colors.surface, gap: 12 },
  clarificationEyebrow: { color: colors.primaryText, fontSize: 14, lineHeight: 21, fontWeight: '600' },
  clarificationQuestion: { color: colors.text, fontSize: 17, lineHeight: 26, fontWeight: '600' },
  name: { color: colors.text, fontSize: 14, fontWeight: '600' }, answer: { color: colors.text, fontSize: 15, lineHeight: 26 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  locked: { backgroundColor: colors.soft, borderWidth: 1, borderColor: '#BFE3CF', borderRadius: 18, padding: 18, gap: 12 },
  lockPreview: { backgroundColor: colors.track, borderRadius: 12, padding: 14, gap: 12 },
  lockLine: { width: '70%', height: 14, borderRadius: 4, backgroundColor: colors.fieldBorder },
  composerDock: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, backgroundColor: colors.surface },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, maxWidth: 720, alignSelf: 'center', width: '100%' },
  input: { flex: 1, minWidth: 0, minHeight: 64, maxHeight: 140, borderWidth: 1, borderColor: colors.fieldBorder,
    borderRadius: 24, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, lineHeight: 25, color: colors.text, backgroundColor: colors.surface },
  send: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.text, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  stop: { width: 14, height: 14, backgroundColor: colors.surface, borderRadius: 3 },
  disclaimer: { color: colors.muted, fontSize: 12, lineHeight: 19, textAlign: 'center', marginTop: 8 },
})
