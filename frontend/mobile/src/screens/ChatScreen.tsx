import { useEffect, useMemo, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import type { SupportProgramConversationContext, SupportProgramInterpretation, SupportProgramPendingClarification } from '@govbiz/shared/domain/entities/SupportProgramConversation'
import type { SupportProgramSearchResponseDto } from '@govbiz/shared/data/models/SupportProgramDto'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { ApiError, errorMessage, programClient } from '../api/client'
import { useAuth } from '../auth/session'
import { ProgramCard } from '../components/ProgramCard'
import { Button, Card, Field, Notice, Page, Subtitle, Title, styles } from '../ui'

const emptyContext: SupportProgramConversationContext = {
  query: null, acceptingOnly: true,
  companyConditions: { region: null, industry: null, establishedOn: null, foundedYear: null, supportPurpose: null },
}

const conditionLabels = { region: '지역', industry: '업종', establishedOn: '설립일', foundedYear: '설립연도', supportPurpose: '지원 목적' }

export function ChatScreen({ onOpenProgram, onLogin }: {
  onOpenProgram: (identity: SupportProgramIdentity) => void; onLogin: () => void
}) {
  const { session, status, invalidateSession } = useAuth()
  const token = status === 'signedIn' ? session?.accessToken : undefined
  const client = useMemo(() => programClient(token), [token])
  const [message, setMessage] = useState('')
  const [context, setContext] = useState(emptyContext)
  const [proposal, setProposal] = useState<SupportProgramInterpretation | null>(null)
  const [clarification, setClarification] = useState<SupportProgramPendingClarification | null>(null)
  const [result, setResult] = useState<SupportProgramSearchResponseDto | null>(null)
  const [history, setHistory] = useState<{ role: 'user' | 'assistant'; text: string }[]>([])
  const [busy, setBusy] = useState<'interpret' | 'search' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    generation.current += 1
    request.current?.abort()
    setMessage(''); setContext(emptyContext); setProposal(null); setClarification(null); setResult(null)
    setHistory([]); setBusy(null); setError(null)
    return () => { generation.current += 1; request.current?.abort() }
  }, [token])

  function cancel() { generation.current += 1; request.current?.abort(); setBusy(null) }

  async function interpret() {
    if (!message.trim() || busy) return
    const controller = new AbortController(); request.current = controller
    const revision = ++generation.current
    const text = message.trim()
    setBusy('interpret'); setError(null)
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
    } catch (cause) {
      if (!controller.signal.aborted && generation.current === revision) {
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setError(errorMessage(cause))
      }
    } finally { if (generation.current === revision) setBusy(null) }
  }

  async function search() {
    if (busy || proposal?.status !== 'READY' || !proposal.proposedContext.query || message.trim()) return
    const controller = new AbortController(); request.current = controller
    const revision = ++generation.current
    const nextContext = proposal.proposedContext
    setBusy('search'); setError(null)
    try {
      const readiness = await client.getSearchReadiness(controller.signal)
      if (controller.signal.aborted || generation.current !== revision) return
      if (!readiness.indexReady || !['SEARCHABLE', 'SEARCHABLE_WITH_SYNC_FAILURE', 'SEARCHABLE_WITH_PARTIAL_SOURCES'].includes(readiness.searchState)) {
        setError('검색 데이터를 준비 중입니다. 잠시 후 다시 검색해 주세요.')
        return
      }
      const conditions = Object.fromEntries(Object.entries(nextContext.companyConditions).filter(([, value]) => value != null))
      const next = await client.search({ query: nextContext.query!, acceptingOnly: nextContext.acceptingOnly, companyConditions: conditions }, controller.signal)
      if (controller.signal.aborted || generation.current !== revision) return
      setContext(nextContext); setResult(next); setProposal(null); setClarification(null)
      setHistory((previous) => [...previous.slice(-9), { role: 'assistant', text: `관련 공고 ${next.totalCount}건을 찾았습니다.` }])
    } catch (cause) {
      if (!controller.signal.aborted && generation.current === revision) {
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setError(errorMessage(cause))
      }
    } finally { if (generation.current === revision) setBusy(null) }
  }

  return <Page>
    <Title>대화로 찾는 지원사업</Title><Subtitle>회사의 상황과 필요한 지원을 알려주세요. 검색 조건을 함께 정리합니다.</Subtitle>
    {history.length === 0 && <Notice>예: “서울에서 AI 서비스를 만드는 창업기업인데, 사업화 지원을 찾고 있어요.”</Notice>}
    {history.map((item, index) => <Card key={index}>
      <Text style={styles.badge}>{item.role === 'user' ? '나' : 'GovBiz AI'}</Text><Text selectable style={styles.body}>{item.text}</Text>
    </Card>)}
    <Field label="회사 상황이나 궁금한 점" placeholder="필요한 지원을 편하게 알려주세요." value={message} onChangeText={setMessage} multiline maxLength={500} editable={!busy} />
    <Button label="AI에게 보내기" busy={busy === 'interpret'} disabled={Boolean(busy) || !message.trim()} onPress={() => void interpret()} />
    {proposal?.status === 'READY' && <Card>
      <Text style={styles.heading}>이 조건으로 검색할까요?</Text><Text style={styles.body}>{proposal.proposedContext.query}</Text>
      {Object.entries(proposal.proposedContext.companyConditions).filter(([, value]) => value != null).map(([key, value]) =>
        <Text key={key} style={styles.body}>{conditionLabels[key as keyof typeof conditionLabels]}: {value}</Text>)}
      <Text style={styles.body}>접수 상태: {proposal.proposedContext.acceptingOnly ? '접수 중인 공고만' : '전체 공고'}</Text>
      {message.trim() && <Notice>입력한 내용을 먼저 AI에게 보내 조건을 갱신해 주세요.</Notice>}
      <Button label="조건 확인 · 공고 검색" busy={busy === 'search'} disabled={Boolean(busy) || Boolean(message.trim())} onPress={() => void search()} />
    </Card>}
    {busy && <Button label="요청 취소" variant="ghost" onPress={cancel} />}
    {error && <Notice error>{error}</Notice>}
    {result && <>
      <View style={styles.row}><Text style={styles.heading}>추천 공고</Text><Text style={styles.muted}>{result.totalCount}건</Text></View>
      {result.totalCount === 0 && <Notice>조건에 맞는 공고가 없습니다. 필요한 지원이나 회사 조건을 바꿔 보세요.</Notice>}
      {result.programs.map((program) => <ProgramCard key={JSON.stringify([program.sourceCode, program.id])} program={program} onOpen={onOpenProgram} />)}
      {result.resultToken && <><Notice>공개 검색에는 일부 결과가 표시됩니다. 로그인 후 검색하면 전체 추천을 볼 수 있습니다.</Notice><Button label="로그인하기" onPress={onLogin} /></>}
      <Text style={styles.muted}>AI 추천은 신청 자격의 확정 판정이 아닙니다. 실제 요건은 공고 원문에서 확인해 주세요.</Text>
    </>}
    {(history.length > 0 || result) && <Button label="새 대화" variant="ghost" onPress={() => {
      cancel(); setHistory([]); setContext(emptyContext); setProposal(null); setClarification(null); setResult(null); setError(null); setMessage('')
    }} />}
  </Page>
}
