import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { SupportProgramDetail } from '@govbiz/shared/domain/entities/SupportProgram'
import { splitSupportProgramTarget, supportProgramApplicationRouteLabel, supportProgramContactParts } from '@govbiz/shared/domain/entities/SupportProgramSections'
import { daysUntil, formatDday, programStatusLabels } from '@govbiz/shared/domain/labels'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import type { SupportProgramEvidenceAnswer } from '@govbiz/shared/domain/entities/SupportProgramEvidenceAnswer'
import { ApiError, errorMessage, programClient, readProgramDetail } from '../api/client'
import { getSavedProgramStatus, removeSavedProgram, saveProgram } from '../api/savedPrograms'
import { useAuth } from '../auth/session'
import { AppIcon } from '../components/AppIcon'
import { PartnerSheet } from '../components/PartnerSheet'
import { ProgramPreparationSection } from '../components/PreparationRows'
import { ProgramAttachments } from '../components/ProgramAttachments'
import { Button, Card, Field, Notice, Page, StatusBadge, Subtitle, Title, colors, ddayBadgeTone, styles } from '../ui'

export function ProgramScreen({ identity, onLogin, resumeAction, onResumed }: {
  identity: SupportProgramIdentity; onLogin: (action?: 'save' | 'question') => void
  resumeAction?: { action: 'save' | 'question'; token: string }; onResumed?(): void
}) {
  const { session, status, invalidateSession, refreshSession } = useAuth()
  const token = status === 'signedIn' ? session?.accessToken : undefined
  const client = useMemo(() => programClient(token), [token])
  const [program, setProgram] = useState<SupportProgramDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [saved, setSaved] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState<{ question: string; answer: SupportProgramEvidenceAnswer }[]>([])
  const [answerError, setAnswerError] = useState<string | null>(null)
  const [answering, setAnswering] = useState(false)
  const [questionOpen, setQuestionOpen] = useState(false)
  const insets = useSafeAreaInsets()
  const work = useRef<AbortController | null>(null)
  const questionRevision = useRef(0)
  const saveWork = useRef<AbortController | null>(null)
  const resumed = useRef(false)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const sourceCode = identity.sourceCode
  const sourceProgramId = identity.sourceProgramId

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true); setError(null); setProgram(null)
    readProgramDetail(client, { sourceCode, sourceProgramId }, controller.signal)
      .then((value) => { if (active) setProgram(value) })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [client, sourceCode, sourceProgramId, retry])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    questionRevision.current += 1
    work.current?.abort(); saveWork.current?.abort()
    setTurns([]); setAnswerError(null); setQuestion(''); setAnswering(false)
    setSaved(null); setSaveError(null); setSaving(false)
    if (token) getSavedProgramStatus(token, { sourceCode, sourceProgramId }, controller.signal)
      .then((value) => { if (active) setSaved(value) })
      .catch((cause: unknown) => {
        if (!active) return
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setSaveError(errorMessage(cause))
      })
    return () => { questionRevision.current += 1; active = false; controller.abort(); work.current?.abort(); saveWork.current?.abort() }
  }, [token, sourceCode, sourceProgramId, retry, invalidateSession])

  async function toggleSave() {
    if (!token) { onLogin('save'); return }
    if (saved === null || saving) return
    const controller = new AbortController(); saveWork.current = controller
    setSaving(true); setSaveError(null)
    try {
      if (saved) await removeSavedProgram(token, { sourceCode, sourceProgramId }, controller.signal)
      else await saveProgram(token, { sourceCode, sourceProgramId }, controller.signal)
      if (!controller.signal.aborted) { setSaved(!saved); setSaveNotice(saved ? null : '관심 공고함에 담았어요.') }
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setSaveError(errorMessage(cause))
      }
    } finally { if (!controller.signal.aborted) setSaving(false) }
  }

  useEffect(() => {
    if (!resumeAction || resumed.current || resumeAction.token !== token || !program) return
    if (resumeAction.action === 'save' && saved === null) return
    resumed.current = true; onResumed?.()
    if (resumeAction.action === 'question') { if (program.evidenceQuestionSupported) setQuestionOpen(true) }
    else if (!saved) void toggleSave()
    else setSaveNotice('이미 관심 공고함에 담은 공고예요.')
  }, [resumeAction, token, program, saved])

  async function ask() {
    if (!program?.evidenceQuestionSupported) return
    if (!token) { onLogin('question'); return }
    if (!question.trim() || answering || work.current && !work.current.signal.aborted) return
    const asked = question.trim()
    const controller = new AbortController(); work.current = controller
    questionRevision.current += 1
    setAnswering(true); setAnswerError(null)
    try {
      const result = await client.answerEvidenceQuestion({ sourceCode, sourceProgramId, question: asked }, controller.signal)
      if (!controller.signal.aborted) { setTurns(previous => [...previous, { question: asked, answer: result }]); setQuestion('') }
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setAnswerError(errorMessage(cause))
      }
    } finally { if (work.current === controller) { work.current = null; if (!controller.signal.aborted) setAnswering(false) } }
  }

  async function openSource(url: string) {
    try { await Linking.openURL(url) } catch { setError('원문 링크를 열지 못했습니다. 다시 시도해 주세요.') }
  }

  async function call(tel: string) {
    try { await Linking.openURL(`tel:${tel}`) } catch { setError('전화 앱을 열지 못했어요. 번호를 직접 입력해 주세요.') }
  }

  const deadline = program?.status === 'OPEN' ? daysUntil(program.applicationEndDate) : null
  const statusColor = program?.status === 'OPEN' ? colors.primary : program?.status === 'UPCOMING' ? colors.info : colors.muted
  // 공식 API 값만 보여 줍니다. K-Startup은 지원·제외 대상을 나누고, 신청 방법은 공식 신청 필드로 분류한 경로입니다.
  const target = program ? splitSupportProgramTarget(program.sourceCode, program.targetDescription) : null
  const routeLabel = program ? supportProgramApplicationRouteLabel(program.applicationRoute) : null
  const applicationUrl = program?.applicationRoute.url ?? null
  const contactParts = program?.contact ? supportProgramContactParts(program.contact) : []
  function stopQuestion() {
    questionRevision.current += 1
    work.current?.abort(); work.current = null
    setAnswering(false)
  }
  function closeQuestion() {
    if (!answering) { setQuestionOpen(false); return }
    const revision = questionRevision.current
    Alert.alert('답변 요청을 중지할까요?', '입력한 질문은 유지돼요. 화면 대기를 중지해도 서버에서 이미 시작한 처리가 중단되는 것은 아니에요.', [
      { text: '계속 기다리기', style: 'cancel' },
      { text: '중지하고 닫기', onPress: () => {
        if (questionRevision.current !== revision) return
        stopQuestion(); setQuestionOpen(false)
      } },
    ])
  }
  return <View style={local.page}><Page bottomSafeArea={!program} backgroundColor={colors.surface}>
    {status === 'unavailable' && <><Notice error>로그인 상태를 확인한 뒤 저장과 원문 질문을 이용할 수 있어요.</Notice>
      <Button label="로그인 상태 다시 확인" onPress={() => void refreshSession()} /></>}
    {loading && <ActivityIndicator color={colors.primary} accessibilityLabel="공고 상세를 불러오는 중" />}
    {error && <><Notice error>{error}</Notice><Button label="다시 불러오기" onPress={() => setRetry((value) => value + 1)} /></>}
    {!loading && !error && !program && <Notice>공고를 찾을 수 없습니다. 공고가 삭제되었거나 더 이상 제공되지 않을 수 있습니다.</Notice>}
    {program && <>
      <View style={local.meta}><View style={[local.dot, { backgroundColor: statusColor }]} /><Text style={[local.status, { color: statusColor }]}>{programStatusLabels[program.status]}</Text>
        {deadline !== null && <StatusBadge label={formatDday(deadline)} tone={ddayBadgeTone(deadline)} />}
        <View style={{ flex: 1 }} /><Text style={styles.muted}>{program.sourceName}</Text></View>
      <Title>{program.title}</Title>
      <Subtitle>{program.organization}</Subtitle>
      <View style={local.glance}><Text style={[styles.heading, { paddingTop: 14 }]}>한눈에 보기</Text>
        <View style={local.fact}><Text style={styles.muted}>접수 기간</Text><Text style={[styles.body, local.factValue]}>{program.applicationPeriod}</Text></View>
        <View style={local.fact}><Text style={styles.muted}>신청 방법</Text><Text style={[routeLabel ? styles.body : styles.muted, local.factValue]}>{routeLabel ?? '공고 원문에서 확인해 주세요'}</Text></View>
        {contactParts.length > 0 && <View style={local.factStacked}><Text style={styles.muted}>문의처</Text><Text selectable style={styles.body}>
          {contactParts.map(({ text, tel }, index) => tel
            ? <Text key={index} style={local.phone} accessibilityRole="link" accessibilityLabel={`${text} 전화 걸기`} onPress={() => void call(tel)}>{text}</Text>
            : <Text key={index}>{text}</Text>)}
        </Text></View>}
        <View style={local.fact}><Text style={styles.muted}>지역</Text><View style={[styles.row, { flex: 1, justifyContent: 'flex-end' }]}>{program.regions.length ? program.regions.map(value => <StatusBadge key={value} label={value} />) : <Text style={styles.muted}>지역 정보 없음</Text>}</View></View>
        <View style={local.fact}><Text style={styles.muted}>분야</Text><View style={[styles.row, { flex: 1, justifyContent: 'flex-end' }]}>{program.categories.length ? program.categories.map(value => <StatusBadge key={value} label={value} />) : <Text style={styles.muted}>분야 정보 없음</Text>}</View></View>
        {program.supervisingInstitutionType ? <View style={local.fact}><Text style={styles.muted}>주관 기관 유형</Text><Text style={[styles.body, local.factValue]}>{program.supervisingInstitutionType}</Text></View> : null}
      </View>
      {token && saved && <ProgramPreparationSection key={`${token}:${sourceCode}:${sourceProgramId}`} identity={identity} token={token} />}
      {saveError && <><Notice error>{saveError}</Notice><Button variant="ghost" label="저장 상태 다시 확인" onPress={() => setRetry((value) => value + 1)} /></>}
      {saveNotice && <Notice>{saveNotice}</Notice>}
      {!program.evidenceQuestionSupported && <Notice>이 제공처 공고는 아직 원문 근거 답변을 지원하지 않습니다. 공식 공고 원문에서 확인해 주세요.</Notice>}
      <Card><Text style={styles.heading}>지원 내용</Text><Text selectable style={styles.body}>{program.summary || '공고 원문에서 확인해 주세요.'}</Text></Card>
      <Card>
        <Text style={styles.heading}>지원 대상</Text><Text style={styles.body}>{target?.target || '원문을 확인해 주세요.'}</Text>
        {target?.excluded ? <><Text style={styles.heading}>제외 대상</Text><Text style={styles.body}>{target.excluded}</Text></> : null}
        {program.preferenceDescription ? <><Text style={styles.heading}>우대 사항</Text><Text style={styles.body}>{program.preferenceDescription}</Text></> : null}
      </Card>
      {program.applicationRoute.method ? <Card><Text style={styles.heading}>신청 방법</Text><Text selectable style={styles.body}>{program.applicationRoute.method}</Text></Card> : null}
      <ProgramAttachments client={client} identity={identity} />
      {applicationUrl ? <Button variant="secondary" label={program.applicationRoute.type === 'GOOGLE_FORMS' ? '구글 설문 신청서 열기' : '신청 사이트 열기'}
        onPress={() => void openSource(applicationUrl)} /> : null}
      <Notice>공고 정보는 신청 자격의 확정 판정이 아닙니다. 제출 전 공식 공고의 요건과 마감일을 확인해 주세요.</Notice>
      <Button variant="secondary" label={program.sourceCode === 'CNTRADE_NOTICE' ? '공식 공지 목록 열기' : '공식 공고 원문 열기'} onPress={() => void openSource(program.sourceUrl)} />
    </>}
  </Page>
    {program && <View style={[local.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={!token ? '로그인하고 관심 공고 저장' : saved ? '관심 공고에서 빼기' : '관심 공고에 저장'}
        accessibilityState={{ selected: !!saved, disabled: saving || Boolean(token) && saved === null || status === 'loading' || status === 'unavailable' }} disabled={saving || Boolean(token) && saved === null || status === 'loading' || status === 'unavailable'}
        onPress={() => void toggleSave()} style={local.bookmark}>{saving ? <ActivityIndicator color={colors.primary} />
          : <AppIcon name="bookmark" color={colors.primary} selected={!!saved} size={21} />}</Pressable>
      <View style={{ flex: 1 }}>{program.evidenceQuestionSupported ? <Button label="원문에 질문하기" disabled={status === 'loading' || status === 'unavailable'} onPress={() => {
        if (!token) onLogin('question')
        else setQuestionOpen(true)
      }} /> : <Button label={program.sourceCode === 'CNTRADE_NOTICE' ? '공식 공지 목록 확인' : '공식 원문 확인'} onPress={() => void openSource(program.sourceUrl)} />}</View>
    </View>}
    <PartnerSheet visible={questionOpen && Boolean(program?.evidenceQuestionSupported)} title="원문에 질문하기" onClose={closeQuestion}
      actions={token ? <><Button label={answering ? '요청 중지' : '닫기'} variant="secondary" style={{ flex: 1 }} onPress={() => {
        if (answering) stopQuestion(); else closeQuestion()
      }} /><Button label={answering ? '답변 찾는 중…' : '질문 보내기'} style={{ flex: 2 }} busy={answering} disabled={!question.trim() || answering}
        onPress={() => void ask()} /></> : <Button label="로그인하고 질문하기" onPress={() => { closeQuestion(); onLogin('question') }} />}>
      {program && <>
        <Text style={styles.muted}>{program.title}</Text>
        <Subtitle>공고 원문에 있는 내용만 근거로 답해요. 최종 신청 조건은 원문에서 다시 확인해 주세요.</Subtitle>
        {turns.map((turn, turnIndex) => <View key={turnIndex} style={{ gap: 10 }}>
          <View style={local.question}><Text selectable style={styles.body}>{turn.question}</Text></View>
          <Text style={styles.badge}>{turn.answer.answerStatus === 'ANSWERED' ? 'AI 답변 · 원문 근거 포함' : '원문 근거 부족'}</Text>
          <Text selectable style={styles.body}>{turn.answer.answer}</Text>
          {turn.answer.citations.map((citation, index) => <Card key={`${turnIndex}-${citation.chunkOrder}-${index}`}>
            <Text selectable style={styles.body}>“{citation.excerpt}”</Text>
            <Button variant="ghost" label={`근거 ${index + 1} · ${citation.sourceLabel} ↗`} onPress={() => void openSource(citation.sourceUrl)} />
          </Card>)}
        </View>)}
        {answering && <><View style={local.question}><Text style={styles.body}>{question.trim()}</Text></View><ActivityIndicator accessibilityLabel="원문에서 답변을 찾는 중" color={colors.primary} /></>}
        {answerError && <Notice error>{answerError}</Notice>}
        {token && <>
          {!turns.length && !question && !answering && <View><Text style={styles.muted}>예시 질문</Text><View style={styles.row}>
            {evidenceSuggestions.map(([label, value]) => <Button key={label} label={label} size="small" variant="secondary" onPress={() => setQuestion(value)} />)}
          </View></View>}
          <Field label="공고에 대해 궁금한 점" value={question} onChangeText={setQuestion} multiline maxLength={500}
            placeholder="공고에 대해 궁금한 점을 물어보세요" editable={!answering} />
          <Text style={[styles.muted, { textAlign: 'right' }]}>{Array.from(question).length} / 500자</Text>
        </>}
      </>}
    </PartnerSheet>
  </View>
}

const evidenceSuggestions = [
  ['지원 대상', '지원 대상이 어떻게 되나요?'], ['신청 방법', '신청 방법과 접수처를 알려 주세요.'],
  ['신청 기간', '신청 기간은 언제까지인가요?'], ['문의처', '문의처와 연락처를 알려 주세요.'],
] as const

const local = StyleSheet.create({
  question: { backgroundColor: colors.soft, borderRadius: 12, padding: 13 },
  page: { flex: 1, backgroundColor: colors.surface },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  status: { fontSize: 12, fontWeight: '600' },
  glance: { backgroundColor: colors.background, borderRadius: 12, paddingHorizontal: 12 },
  fact: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  factValue: { flex: 1, textAlign: 'right' },
  // 문의처는 기업마당 원문처럼 길 수 있어 이름 아래에 왼쪽 정렬로 둡니다.
  factStacked: { paddingVertical: 12, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  phone: { color: colors.primary, fontWeight: '600', textDecorationLine: 'underline' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  bookmark: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
})
