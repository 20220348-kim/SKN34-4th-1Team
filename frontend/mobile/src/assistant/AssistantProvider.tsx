import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState, Keyboard, Modal, StyleSheet, View, useWindowDimensions } from 'react-native'
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAuth, type MobileSession } from '../auth/session'
import { ApiError, getApiBaseUrl } from '../api/client'
import { assistantUseCase, AssistantResponseError } from '../api/assistant'
import { assistantHelpEntries, assistantHelpInput } from '../content/assistantHelp'
import { AssistantScreen, type AssistantAction, type MobileAssistantMessage } from '../screens/AssistantScreen'
import { Button, Notice } from '../ui'
import { AssistantBlockingContext, AssistantContext, type AssistantDraft, type AssistantProgramDraft } from './context'
import { assistantCardDestination, assistantDestination, assistantOrigin, programQuestionDestination, type AssistantOrigin } from './assistantNavigation'
import { FloatingAssistantButton } from './FloatingAssistantButton'
import { defaultAssistantPosition, readAssistantPosition, saveAssistantPosition, type AssistantBounds, type AssistantPosition } from './assistantPosition'

type AssistantHandle = { open(): void }
type Delivery = { search?: AssistantDraft; program?: AssistantProgramDraft }

export function AssistantProvider({ children }: { children: ReactNode }) {
  const auth = useAuth(), pathname = usePathname(), params = useGlobalSearchParams()
  const dimensions = useWindowDimensions(), insets = useSafeAreaInsets()
  const [size, setSize] = useState({ width: dimensions.width, height: dimensions.height })
  const [blocked, setBlocked] = useState(0), [keyboard, setKeyboard] = useState(false), [foreground, setForeground] = useState(AppState.currentState === 'active')
  const [delivery, setDelivery] = useState<(Delivery & { owner: string }) | null>(null)
  const handle = useRef<AssistantHandle>(null)
  const available = auth.status === 'signedIn' && auth.session !== null
  const owner = available ? `${auth.session!.account.email}:${auth.session!.accessToken}` : null
  const origin = useMemo(() => assistantOrigin(pathname, params), [pathname, params.sourceCode, params.sourceProgramId, params.management, params.step, params.runId])
  const block = useCallback(() => {
    setBlocked(value => value + 1)
    let released = false
    return () => { if (!released) { released = true; setBlocked(value => Math.max(0, value - 1)) } }
  }, [])
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboard(true))
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(false))
    const state = AppState.addEventListener('change', value => setForeground(value === 'active'))
    return () => { show.remove(); hide.remove(); state.remove() }
  }, [])
  useEffect(() => { setDelivery(null) }, [owner])
  const context = useMemo(() => ({ available, open: () => { if (available && blocked === 0) handle.current?.open() },
    searchDraft: delivery?.owner === owner ? delivery.search ?? null : null,
    programDraft: delivery?.owner === owner ? delivery.program ?? null : null,
    consumeSearchDraft: (id: string) => setDelivery(value => value?.owner === owner && value.search?.id === id ? { ...value, search: undefined } : value),
    consumeProgramDraft: (id: string) => setDelivery(value => value?.owner === owner && value.program?.id === id ? { ...value, program: undefined } : value),
  }), [available, blocked, delivery, owner])
  const bounds = useMemo<AssistantBounds>(() => {
    const tabs = pathname === '/' || pathname.startsWith('/all') || ['/saved', '/report', '/pricing', '/collab', '/chat'].includes(pathname)
    const footer = pathname === '/' || pathname === '/chat' ? 140 : pathname === '/program' ? 80 : /\/preparation|\/reviews/.test(pathname) ? 96 : 0
    const minY = insets.top + 68
    return { width: size.width, minY, maxY: Math.max(minY, size.height - insets.bottom - (tabs ? 80 : 0) - footer - 70) }
  }, [pathname, size, insets.top, insets.bottom])
  return <AssistantBlockingContext.Provider value={block}><AssistantContext.Provider value={context}>
    <View style={local.root} onLayout={({ nativeEvent: { layout } }) => { if (layout.width > 0 && layout.height > 0) setSize({ width: layout.width, height: layout.height }) }}>
      {children}
      {available && <AuthenticatedAssistant key={owner} ref={handle} session={auth.session!} origin={origin} bounds={bounds}
        foreground={foreground} hidden={blocked > 0 || keyboard || !foreground || pathname.startsWith('/oauth')}
        deliver={value => { if (owner) setDelivery({ ...value, owner }) }} />}
    </View>
  </AssistantContext.Provider></AssistantBlockingContext.Provider>
}

const AuthenticatedAssistant = forwardRef<AssistantHandle, {
  session: MobileSession; origin: AssistantOrigin; bounds: AssistantBounds; hidden: boolean; foreground: boolean; deliver(value: Delivery): void
}>(function AuthenticatedAssistant({ session, origin, bounds, hidden, foreground, deliver }, ref) {
  const { invalidateSession } = useAuth(), router = useRouter()
  const [opened, setOpened] = useState(false), [messages, setMessages] = useState<MobileAssistantMessage[]>([]), [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [retryUntil, setRetryUntil] = useState(0), [clock, setClock] = useState(Date.now())
  const [entryOrigin, setEntryOrigin] = useState(origin)
  const [showHelp, setShowHelp] = useState(true)
  const [position, setPosition] = useState<AssistantPosition>(defaultAssistantPosition), [positionError, setPositionError] = useState<string | null>(null)
  const live = useRef(true), sequence = useRef(0), generation = useRef(0), positionRevision = useRef(0)
  const work = useRef<{ controller: AbortController; timer: ReturnType<typeof setTimeout>; messageId: string } | null>(null)
  const id = () => `${Date.now()}-${++sequence.current}`
  const api = getApiBaseUrl(), useCase = useMemo(() => assistantUseCase(session.accessToken), [session.accessToken])
  const aiEnabled = process.env.EXPO_PUBLIC_ASSISTANT_AI_ENABLED === 'true'
  const retryRemaining = Math.max(0, Math.ceil((retryUntil - clock) / 1000))
  function stop(message: string) {
    if (!work.current) return
    const messageId = work.current.messageId
    generation.current += 1; clearTimeout(work.current.timer); work.current.controller.abort(); work.current = null
    setMessages(previous => previous.map(message => message.id === messageId ? { ...message, failed: true } : message))
    setBusy(false); setError(message)
  }
  const open = useCallback(() => {
    if (Date.parse(session.expiresAt) <= Date.now()) { void invalidateSession().catch(() => undefined); return }
    if (origin.path !== entryOrigin.path || origin.program?.sourceCode !== entryOrigin.program?.sourceCode
      || origin.program?.sourceProgramId !== entryOrigin.program?.sourceProgramId) setShowHelp(true)
    Keyboard.dismiss(); setEntryOrigin(origin); setOpened(true)
  }, [session.expiresAt, invalidateSession, origin, entryOrigin])
  useImperativeHandle(ref, () => ({ open }), [open])
  useEffect(() => {
    live.current = true
    const revision = positionRevision.current
    readAssistantPosition(api, session.account.email).then(value => {
      if (live.current && revision === positionRevision.current) setPosition(value)
    }).catch(() => { if (live.current) setPositionError('버튼 위치를 불러오지 못했어요. 현재 위치에서 다시 옮길 수 있어요.') })
    return () => { live.current = false; generation.current += 1; if (work.current) { clearTimeout(work.current.timer); work.current.controller.abort() } }
  }, [api, session.account.email])
  useEffect(() => { if (!foreground) stop('앱이 백그라운드로 전환되어 답변 대기를 중지했어요. 입력을 확인하고 다시 전송해 주세요.') }, [foreground])
  useEffect(() => {
    if (retryUntil <= Date.now()) return
    const timer = setInterval(() => { const now = Date.now(); setClock(now); if (now >= retryUntil) clearInterval(timer) }, 1000)
    return () => clearInterval(timer)
  }, [retryUntil])
  const move = useCallback((value: AssistantPosition) => {
    positionRevision.current += 1; setPosition(value); setPositionError(null)
    void saveAssistantPosition(api, session.account.email, value).catch(() => {
      if (live.current) setPositionError('버튼 위치를 저장하지 못했어요. 현재 앱에서는 이동한 위치를 유지해요.')
    })
  }, [api, session.account.email])
  const startMove = useCallback(() => { positionRevision.current += 1 }, [])
  function close() {
    stop('답변 대기를 중지했어요. 서버에서 이미 시작한 처리나 비용이 취소되는 것은 아니에요. 입력은 유지돼요.')
    Keyboard.dismiss(); setOpened(false)
  }
  async function send() {
    const question = draft.trim()
    if (!aiEnabled || !question || busy || work.current || retryRemaining > 0 || question.length > 500) return
    setShowHelp(false)
    const controller = new AbortController(), revision = ++generation.current
    const timer = setTimeout(() => {
      if (live.current && generation.current === revision) stop('답변 결과를 확인하지 못했어요. 다시 전송하면 새 요청이에요. 입력을 확인해 주세요.')
    }, 45_000)
    const messageId = id()
    work.current = { controller, timer, messageId }; setBusy(true); setError(null)
    const history = messages.filter(message => !message.failed).map(message => ({ role: message.role, content: message.text }))
    setMessages(previous => [...previous, { id: messageId, role: 'USER', text: question, origin: entryOrigin }])
    try {
      const result = await useCase.execute({ message: question, history, context: entryOrigin.context, helpEntries: assistantHelpInput() }, controller.signal)
      if (!live.current || generation.current !== revision || controller.signal.aborted) return
      if (result.outcome === 'rate-limited') {
        setMessages(previous => previous.map(message => message.id === messageId ? { ...message, failed: true } : message))
        const now = Date.now(); setClock(now); setRetryUntil(now + (result.retryAfterSeconds ?? 0) * 1000)
        setError('요청이 많아요. 안내된 대기 시간 뒤 직접 다시 전송해 주세요.'); return
      }
      if (result.outcome === 'unavailable') {
        setMessages(previous => previous.map(message => message.id === messageId ? { ...message, failed: true } : message))
        setError('AI 도우미를 이용할 수 없어요. 입력은 유지돼요. 잠시 후 직접 다시 전송해 주세요.'); return
      }
      const answer = result.answer
      const text = answer.intent === 'UNCLEAR' ? answer.clarificationQuestion : answer.answer
      if (!text || answer.intent === 'SEARCH' && !answer.searchQuery) throw new AssistantResponseError()
      setMessages(previous => [...previous, { id: id(), role: 'ASSISTANT', text, answer, origin: entryOrigin, question }]); setDraft('')
    } catch (cause) {
      if (!live.current || generation.current !== revision) return
      if (cause instanceof ApiError && cause.status === 401) { void invalidateSession().catch(() => undefined); return }
      setMessages(previous => previous.map(message => message.id === messageId ? { ...message, failed: true } : message))
      setError(cause instanceof AssistantResponseError ? cause.message : '도우미에 연결하지 못했어요. 입력을 확인하고 직접 다시 전송해 주세요.')
    } finally {
      clearTimeout(timer)
      if (live.current && generation.current === revision) { work.current = null; setBusy(false) }
    }
  }
  function help(helpId: string) {
    const entry = assistantHelpEntries.find(value => value.id === helpId)
    if (!entry || busy) return
    setShowHelp(false)
    setError(null)
    setMessages(previous => [...previous, { id: id(), role: 'USER', text: entry.question, origin: entryOrigin },
      { id: id(), role: 'ASSISTANT', text: [entry.summary, ...entry.body, entry.limitation].filter(Boolean).join('\n\n'), helpId, origin: entryOrigin }])
  }
  function actionsFor(message: MobileAssistantMessage) {
    const actions: AssistantAction[] = []; let invalid = false
    const answer = message.answer
    const entry = assistantHelpEntries.find(value => value.id === (message.helpId ?? answer?.citations[0]))
    const navigation = entry?.action ?? answer?.navigation
    if ((answer?.intent === 'PROGRAM_QUESTION' || entry?.contextual === 'program-question') && message.origin.program) {
      const href = programQuestionDestination(message.origin)
      if (href) actions.push({ label: '이 공고의 원문에 질문하기', href, programQuestion: answer?.intent === 'PROGRAM_QUESTION' ? message.question ?? '' : '' })
    } else if (navigation) {
      const href = navigation.to === '/app/application-preparations/new' && message.origin.program
        ? { pathname: '/(tabs)/all/preparation/new' as const, params: { ...message.origin.program, from: 'program' } }
        : assistantDestination(navigation.to, { company: entry?.companyAction || answer?.accountTopic === 'COMPANY_PROFILE' })
      if (href) actions.push({ label: navigation.label, href, ...(answer?.intent === 'SEARCH' && answer.searchQuery ? { searchQuery: answer.searchQuery } : {}) })
      else invalid = true
    }
    for (const card of answer?.cards ?? []) {
      const href = assistantCardDestination(card)
      if (href) actions.push({ label: `${card.kind === 'PROGRAM' ? '공고' : '모집글'} 보기 · ${card.title}`, href })
      else invalid = true
    }
    return { actions, invalid }
  }
  function navigate(action: AssistantAction, message: MobileAssistantMessage) {
    if (busy || !live.current) return
    if (action.searchQuery) deliver({ search: { id: message.id, text: action.searchQuery } })
    else if (action.programQuestion !== undefined && message.origin.program) deliver({ program: { id: message.id, text: action.programQuestion, program: message.origin.program } })
    close(); router.navigate(action.href)
  }
  return <>
    {!opened && !hidden && <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <FloatingAssistantButton bounds={bounds} position={position} onOpen={open} onMove={move} onMoveStart={startMove} />
      {positionError && <View style={local.notice}><Notice error>{positionError}</Notice><Button label="위치 안내 닫기" variant="ghost" size="small" onPress={() => setPositionError(null)} /></View>}
    </View>}
    <Modal visible={opened && foreground} animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
      {opened && <SafeAreaProvider testID="assistant-modal-safe-area-provider">
        <AssistantScreen origin={entryOrigin} messages={messages} draft={draft} onDraft={setDraft} onSend={() => void send()} onClose={close}
          onStop={() => stop('답변 대기를 중지했어요. 서버에서 이미 시작한 처리나 비용이 취소되는 것은 아니에요. 입력은 유지돼요.')}
          onReset={() => { setMessages([]); setDraft(''); setError(null); setShowHelp(true) }} onHelp={help} busy={busy} error={error} retryRemaining={retryRemaining}
          aiEnabled={aiEnabled} showHelp={showHelp} actionsFor={actionsFor} onNavigate={navigate} />
      </SafeAreaProvider>}
    </Modal>
  </>
})
const local = StyleSheet.create({ root: { flex: 1 }, notice: { position: 'absolute', left: 16, right: 16, bottom: 100 } })
