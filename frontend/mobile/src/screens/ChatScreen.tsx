import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from 'react-native'
import type { SupportProgramConversationContext, SupportProgramInterpretation, SupportProgramPendingClarification } from '@govbiz/shared/domain/entities/SupportProgramConversation'
import type { SupportProgramSearchResult } from '@govbiz/shared/domain/entities/SupportProgramSearchResult'
import { RestoreSupportProgramSearchUseCase } from '@govbiz/shared/domain/usecases/RestoreSupportProgramSearchUseCase'
import { SearchSupportProgramsUseCase } from '@govbiz/shared/domain/usecases/SearchSupportProgramsUseCase'
import { SupportProgramSearchRestoreError } from '@govbiz/shared/domain/errors/SupportProgramSearchRestoreError'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { ApiError, errorMessage, programClient } from '../api/client'
import { restoreSearchResults, searchPrograms } from '../api/searchResults'
import type { LoginRequest } from '../auth/loginFlow'
import { useAuth } from '../auth/session'
import { SearchProgramCard } from '../components/SearchProgramCard'
import { SearchConditionCard } from '../components/SearchConditionCard'
import { AppIcon } from '../components/AppIcon'
import { Button, Notice, colors, styles } from '../ui'

const emptyContext: SupportProgramConversationContext = {
  query: null, acceptingOnly: true,
  companyConditions: { region: null, industry: null, establishedOn: null, foundedYear: null, supportPurpose: null },
}

type TimelineTarget = 'message' | 'waiting' | 'answer' | 'proposal' | 'results' | 'notice'

export function ChatScreen({ onOpenProgram, onLogin, keyboardOffset = 0, active = true }: {
  onOpenProgram: (identity: SupportProgramIdentity) => void; onLogin: (request?: LoginRequest) => void; keyboardOffset?: number; active?: boolean
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
  const [history, setHistory] = useState<{ role: 'user' | 'assistant'; text: string }[]>([])
  const [busy, setBusy] = useState<'interpret' | 'search' | 'restore' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sessionNotice, setSessionNotice] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const previousToken = useRef(token)
  const pendingRestore = useRef<{ resultToken: string; context: SupportProgramConversationContext; history: typeof history } | null>(null)
  const retryRestore = useRef<typeof pendingRestore.current>(null)
  const [restoreFailure, setRestoreFailure] = useState<'expired' | 'unavailable' | null>(null)

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
    request.current?.abort()
    setMessage(''); setContext(emptyContext); setProposal(null); setClarification(null); setResult(null)
    setHistory([]); setBusy(null); setError(null)
    setRestoreFailure(null)
    if (token) setSessionNotice(null)
    if (selected && token) void restore(selected, token)
    return () => { generation.current += 1; request.current?.abort(); clearTimelineScroll() }
  }, [token])

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
      setContext(restored.context); setResult(restored); setHistory(selected.history); retryRestore.current = null
      requestTimelineScroll('results')
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
    if (!message.trim() || busy) return
    const controller = new AbortController(); request.current = controller
    const revision = ++generation.current
    const text = message.trim()
    setBusy('interpret'); setError(null)
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
      setClarification(next.status === 'CLARIFICATION_REQUIRED' && next.clarificationQuestion
        ? { question: next.clarificationQuestion, draftContext: next.proposedContext } : null)
      setHistory((previous) => [...previous.slice(-8), { role: 'user', text },
        { role: 'assistant', text: next.answer ?? next.clarificationQuestion ?? '아래 검색 조건을 확인해 주세요.' }])
      requestTimelineScroll(next.status === 'READY' ? 'proposal' : 'answer')
    } catch (cause) {
      if (!controller.signal.aborted && generation.current === revision) {
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setError(errorMessage(cause))
        requestTimelineScroll('notice')
      }
    } finally { if (generation.current === revision) setBusy(null) }
  }

  async function search() {
    if (busy || proposal?.status !== 'READY' || !proposal.proposedContext.query || message.trim()) return
    const controller = new AbortController(); request.current = controller
    const revision = ++generation.current
    const nextContext = proposal.proposedContext
    setBusy('search'); setError(null)
    requestTimelineScroll('waiting')
    try {
      const readiness = await client.getSearchReadiness(controller.signal)
      if (controller.signal.aborted || generation.current !== revision) return
      if (!readiness.indexReady || !['SEARCHABLE', 'SEARCHABLE_WITH_SYNC_FAILURE', 'SEARCHABLE_WITH_PARTIAL_SOURCES'].includes(readiness.searchState)) {
        setError('검색 데이터를 준비 중입니다. 잠시 후 다시 검색해 주세요.')
        requestTimelineScroll('notice')
        return
      }
      const conditions = Object.fromEntries(Object.entries(nextContext.companyConditions).filter(([, value]) => value != null))
      let next = await new SearchSupportProgramsUseCase({ search: (command, signal) => searchPrograms(token, command, signal) })
        .execute({ query: nextContext.query!, acceptingOnly: nextContext.acceptingOnly, companyConditions: conditions }, controller.signal)
      if (controller.signal.aborted || generation.current !== revision) return
      if (token && next.resultToken) next = await new RestoreSupportProgramSearchUseCase({
        restoreSearch: (resultToken, signal) => restoreSearchResults(token, resultToken, signal),
      }).execute(next.resultToken, controller.signal)
      if (controller.signal.aborted || generation.current !== revision) return
      setContext(nextContext); setResult(next); setProposal(null); setClarification(null)
      setHistory((previous) => [...previous.slice(-9), { role: 'assistant', text: `관련 공고 ${next.totalCount}건을 찾았습니다.` }])
      requestTimelineScroll('results')
    } catch (cause) {
      if (!controller.signal.aborted && generation.current === revision) {
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setError(errorMessage(cause))
        requestTimelineScroll('notice')
      }
    } finally { if (generation.current === revision) setBusy(null) }
  }

  const introductory = history.length === 0 && !proposal && !result && !busy
  return <KeyboardAvoidingView testID="ai-search-keyboard-container" style={local.page}
    behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={keyboardOffset} enabled={active}>
    <ScrollView ref={timeline} testID="ai-search-timeline" bounces={false} overScrollMode="never" style={local.scroll} contentContainerStyle={[local.timeline, introductory && { flexGrow: 1 }]}
      onLayout={event => { timelineSize.current.viewport = event.nativeEvent.layout.height; scrollPendingTimeline() }}
      onContentSizeChange={(_width, height) => { timelineSize.current.content = height; scrollPendingTimeline() }}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      {introductory ? <View style={local.intro}>
        <View style={local.brandMark}><Text style={local.brandLetter}>G</Text></View>
        <Text accessibilityRole="header" style={local.introTitle}>우리 회사의 다음 기회,</Text>
        <Text style={[local.introTitle, { color: colors.primary }]}>말로 찾아보세요</Text>
        <Text style={local.introDescription}>지역 · 업종 · 필요한 지원을 알려 주세요.{'\n'}AI가 검색 조건을 정리해 드려요.</Text>
      </View> : null}
      {history.map((item, index) => item.role === 'user'
        ? <View key={index} style={local.userBubble}><Text selectable style={styles.body}>{item.text}</Text></View>
        : <View key={index === history.length - 1 ? `answer-${index}-${timelineVersions.answer}` : index} style={local.assistant}
          testID={index === history.length - 1 ? 'ai-search-latest-answer' : undefined}
          onLayout={index === history.length - 1 ? event => recordTimelineTarget('answer', timelineVersions.answer, event) : undefined}>
          <View style={local.assistantName}><Text style={local.miniMark}>G</Text><Text style={local.name}>GovBiz AI</Text></View>
          <Text selectable style={local.answer}>{item.text}</Text></View>)}
      {busy === 'interpret' && <View key={`message-${timelineVersions.message}`} testID="ai-search-pending-message" style={local.userBubble}
        onLayout={event => recordTimelineTarget('message', timelineVersions.message, event)}><Text style={styles.body}>{message}</Text></View>}
      {busy && <View key={`waiting-${timelineVersions.waiting}`} testID="ai-search-waiting" accessibilityLiveRegion="polite" style={local.waiting}
        onLayout={event => recordTimelineTarget('waiting', timelineVersions.waiting, event)}><ActivityIndicator color={colors.primary} />
        <Text style={styles.body}>{busy === 'interpret' ? '검색 조건을 정리하는 중이에요.' : busy === 'restore' ? '로그인 전 검색 결과를 불러오는 중이에요.' : '공고를 찾는 중이에요.'}</Text></View>}
      {proposal?.status === 'READY' && <View key={`proposal-${timelineVersions.proposal}`} testID="ai-search-proposal" style={local.contentGroup}
        onLayout={event => recordTimelineTarget('proposal', timelineVersions.proposal, event)}>
        {message.trim() && <Notice>입력한 내용을 먼저 AI에게 보내 조건을 갱신해 주세요.</Notice>}
        <SearchConditionCard context={proposal.proposedContext} busy={Boolean(busy)} disabled={Boolean(busy) || Boolean(message.trim())}
          onConfirm={() => void search()} onEdit={() => { setMessage(proposal.proposedContext.query ?? ''); composerInput.current?.focus() }} />
      </View>}
      {(error || sessionNotice || restoreFailure) && <View key={`notice-${timelineVersions.notice}`} testID="ai-search-notice" style={local.contentGroup}
        onLayout={event => recordTimelineTarget('notice', timelineVersions.notice, event)}>
        {error && <Notice error>{error}</Notice>}
        {sessionNotice && <><Notice error>{sessionNotice}</Notice><Button label="다시 로그인" onPress={() => onLogin({ direct: true })} /></>}
        {restoreFailure === 'unavailable' && token && <Button label="검색 결과 다시 불러오기" disabled={Boolean(busy)}
          onPress={() => { if (retryRestore.current) void restore(retryRestore.current, token) }} />}
        {restoreFailure === 'expired' && <Button label="같은 조건으로 다시 검색" onPress={() => {
          const selected = retryRestore.current
          if (!selected) return
          setProposal({ status: 'READY', proposedContext: selected.context, clarificationQuestion: null, changedFields: [] })
          setMessage(''); setError(null); setRestoreFailure(null); retryRestore.current = null
          requestTimelineScroll('proposal')
        }} />}
      </View>}
      {result && <View key={`results-${timelineVersions.results}`} testID="ai-search-results" style={local.contentGroup}
        onLayout={event => recordTimelineTarget('results', timelineVersions.results, event)}>
        <View style={styles.row}><Text style={styles.heading}>추천 공고</Text><Text style={styles.muted}>{result.totalCount}건</Text></View>
        {result.totalCount === 0 && <Notice>조건에 맞는 공고가 없습니다. 필요한 지원이나 회사 조건을 바꿔 보세요.</Notice>}
        {result.programs.map(program => <SearchProgramCard key={JSON.stringify([program.sourceCode, program.id])} program={program} onOpen={onOpenProgram} />)}
        {!token && result.resultToken && result.totalCount > result.programs.length && <View style={local.locked}>
          <Text style={styles.heading}>추가 지원사업 {result.totalCount - result.programs.length}건이 있어요</Text>
          <Text style={styles.body}>로그인하면 이번 추천 결과를 최대 5건까지 확인할 수 있어요.</Text>
          <Button label="로그인하고 모두 보기" disabled={status !== 'signedOut' || Boolean(busy)} onPress={() => {
            pendingRestore.current = { resultToken: result.resultToken!, context, history }
            onLogin({ direct: true, message: '이번 검색 결과를 그대로 이어서 확인할 수 있어요.', onCancel: () => { pendingRestore.current = null } })
          }} />
          <View accessibilityLabel="로그인 후 확인할 지원사업" style={local.lockPreview}>
            <View style={local.lockLine} /><Text style={styles.muted}>로그인 후 확인할 수 있는 지원사업</Text>
          </View>
        </View>}
      </View>}
      {(history.length > 0 || result) && <Button label="새 대화" variant="ghost" onPress={() => {
        cancel(); pendingRestore.current = null; retryRestore.current = null; setRestoreFailure(null); setSessionNotice(null)
        setHistory([]); setContext(emptyContext); setProposal(null); setClarification(null); setResult(null); setError(null); setMessage('')
      }} />}
      {introductory && status === 'signedOut' && <View style={local.guestHint}><Text style={local.hintText}>
        로그인 없이 검색과 협업 모집글을 둘러볼 수 있어요.{'\n'}공고 저장과 맞춤 리포트는 로그인 후 이용해요.</Text></View>}
    </ScrollView>
    <View testID="ai-search-composer" style={local.composerDock}>
      <View style={local.composer}>
        <TextInput ref={composerInput} accessibilityLabel="회사 상황이나 궁금한 점" placeholder="어떤 지원사업을 찾고 있나요?"
          placeholderTextColor={colors.placeholder} value={message} onChangeText={setMessage} multiline maxLength={500}
          editable={!busy} style={local.input} />
        <Pressable accessibilityRole="button" accessibilityLabel={busy ? '요청 취소' : 'AI에게 보내기'}
          accessibilityState={{ disabled: !busy && !message.trim(), busy: Boolean(busy) }} disabled={!busy && !message.trim()}
          onPress={busy ? cancel : () => void interpret()} style={[local.send, !busy && !message.trim() && { backgroundColor: colors.track }]}>
          {busy ? <View style={local.stop} /> : <AppIcon name="arrowUp" color={message.trim() ? colors.surface : colors.placeholder} size={22} />}
        </Pressable>
      </View>
      <Text style={local.disclaimer}>AI 답변은 참고용입니다. 최종 신청 조건은 공고 원문에서 확인하세요.</Text>
    </View>
  </KeyboardAvoidingView>
}

const local = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surface }, scroll: { flex: 1 },
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
  name: { color: colors.text, fontSize: 14, fontWeight: '600' }, answer: { color: colors.text, fontSize: 15, lineHeight: 26 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  locked: { backgroundColor: colors.soft, borderWidth: 1, borderColor: '#BFE3CF', borderRadius: 18, padding: 18, gap: 12 },
  lockPreview: { backgroundColor: colors.track, borderRadius: 12, padding: 14, gap: 12 },
  lockLine: { width: '70%', height: 14, borderRadius: 4, backgroundColor: colors.fieldBorder },
  composerDock: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, backgroundColor: colors.surface },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, maxWidth: 720, alignSelf: 'center', width: '100%' },
  input: { flex: 1, minWidth: 0, minHeight: 64, maxHeight: 140, borderWidth: 1, borderColor: colors.fieldBorder,
    borderRadius: 24, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, lineHeight: 25, color: colors.text, backgroundColor: colors.surface },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.text, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  stop: { width: 14, height: 14, backgroundColor: colors.surface, borderRadius: 3 },
  disclaimer: { color: colors.muted, fontSize: 12, lineHeight: 19, textAlign: 'center', marginTop: 8 },
})
