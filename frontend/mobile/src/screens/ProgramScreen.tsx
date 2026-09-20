import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Text } from 'react-native'
import type { SupportProgram } from '@govbiz/shared/domain/entities/SupportProgram'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import type { SupportProgramEvidenceAnswer } from '@govbiz/shared/domain/entities/SupportProgramEvidenceAnswer'
import { savedSupportProgramDtoSchema, savedSupportProgramStatusDtoSchema } from '@govbiz/shared/data/models/SavedSupportProgramDto'
import { ApiError, apiRequest, errorMessage, programClient } from '../api/client'
import { useAuth } from '../auth/session'
import { statusLabels } from '../components/ProgramCard'
import { Button, Card, Field, Notice, Page, Subtitle, Title, colors, styles } from '../ui'

export function ProgramScreen({ identity, onLogin }: { identity: SupportProgramIdentity; onLogin: () => void }) {
  const { session, status, invalidateSession } = useAuth()
  const token = status === 'signedIn' ? session?.accessToken : undefined
  const client = useMemo(() => programClient(token), [token])
  const [program, setProgram] = useState<SupportProgram | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [saved, setSaved] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<SupportProgramEvidenceAnswer | null>(null)
  const [answerError, setAnswerError] = useState<string | null>(null)
  const [answering, setAnswering] = useState(false)
  const work = useRef<AbortController | null>(null)
  const saveWork = useRef<AbortController | null>(null)
  const sourceCode = identity.sourceCode
  const sourceProgramId = identity.sourceProgramId
  const params = new URLSearchParams({ sourceCode, sourceProgramId }).toString()

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true); setError(null); setProgram(null)
    client.getDetail({ sourceCode, sourceProgramId }, controller.signal)
      .then((value) => { if (active) setProgram(value) })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [client, sourceCode, sourceProgramId, retry])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    work.current?.abort(); saveWork.current?.abort()
    setAnswer(null); setAnswerError(null); setQuestion(''); setAnswering(false)
    setSaved(null); setSaveError(null); setSaving(false)
    if (token) apiRequest(`/api/v1/me/saved-programs/status?${params}`, { accessToken: token, signal: controller.signal })
      .then((value) => { if (active) setSaved(savedSupportProgramStatusDtoSchema.parse(value).saved) })
      .catch((cause: unknown) => {
        if (!active) return
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setSaveError(errorMessage(cause))
      })
    return () => { active = false; controller.abort(); work.current?.abort(); saveWork.current?.abort() }
  }, [token, params, retry, invalidateSession])

  async function toggleSave() {
    if (!token) { onLogin(); return }
    if (saved === null || saving) return
    const controller = new AbortController(); saveWork.current = controller
    setSaving(true); setSaveError(null)
    try {
      if (saved) await apiRequest(`/api/v1/me/saved-programs?${params}`, { method: 'DELETE', accessToken: token, signal: controller.signal })
      else savedSupportProgramDtoSchema.parse(await apiRequest('/api/v1/me/saved-programs', { method: 'POST', body: { sourceCode, sourceProgramId }, accessToken: token, signal: controller.signal }))
      if (!controller.signal.aborted) setSaved(!saved)
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setSaveError(errorMessage(cause))
      }
    } finally { if (!controller.signal.aborted) setSaving(false) }
  }

  async function ask() {
    if (!token) { onLogin(); return }
    if (!question.trim() || answering) return
    const controller = new AbortController(); work.current = controller
    setAnswering(true); setAnswerError(null); setAnswer(null)
    try {
      const result = await client.answerEvidenceQuestion({ sourceCode, sourceProgramId, question: question.trim() }, controller.signal)
      if (!controller.signal.aborted) setAnswer(result)
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setAnswerError(errorMessage(cause))
      }
    } finally { if (!controller.signal.aborted) setAnswering(false) }
  }

  async function openSource(url: string) {
    try { await Linking.openURL(url) } catch { setError('원문 링크를 열지 못했습니다. 다시 시도해 주세요.') }
  }

  return <Page>
    {loading && <ActivityIndicator color={colors.primary} accessibilityLabel="공고 상세를 불러오는 중" />}
    {error && <><Notice error>{error}</Notice><Button label="다시 불러오기" onPress={() => setRetry((value) => value + 1)} /></>}
    {!loading && !error && !program && <Notice>공고를 찾을 수 없습니다. 공고가 삭제되었거나 더 이상 제공되지 않을 수 있습니다.</Notice>}
    {program && <>
      <Text style={styles.badge}>{statusLabels[program.status]} · {program.sourceName}</Text>
      <Title>{program.title}</Title><Subtitle>{program.organization}</Subtitle>
      <Card><Text style={styles.heading}>접수 기간</Text><Text style={styles.body}>{program.applicationPeriod}</Text>
        <Text style={styles.heading}>지원 대상</Text><Text style={styles.body}>{program.targetDescription || '원문을 확인해 주세요.'}</Text>
        <Text style={styles.muted}>{program.regions.join(' · ')} / {program.categories.join(' · ')}</Text>
      </Card>
      <Card><Text style={styles.heading}>사업 내용</Text><Text selectable style={styles.body}>{program.summary || '공고 원문에서 확인해 주세요.'}</Text></Card>
      <Notice>공고 정보는 신청 자격의 확정 판정이 아닙니다. 제출 전 공식 공고의 요건과 마감일을 확인해 주세요.</Notice>
      <Button label={program.sourceCode === 'CNTRADE_NOTICE' ? '공식 공지 목록 열기' : '공식 공고 원문 열기'} onPress={() => void openSource(program.sourceUrl)} />
      <Button label={!token ? '로그인하고 관심 공고 저장' : saved ? '관심 공고에서 빼기' : '관심 공고에 저장'} variant="secondary"
        busy={saving} disabled={Boolean(token) && saved === null} onPress={() => void toggleSave()} />
      {saveError && <><Notice error>{saveError}</Notice><Button variant="ghost" label="저장 상태 다시 확인" onPress={() => setRetry((value) => value + 1)} /></>}
      <Card><Text style={styles.heading}>공고 원문에 질문하기</Text>
        <Subtitle>AI가 이 공고의 원문에서 근거를 찾아 답합니다.</Subtitle>
        {token ? <>
          <Field label="공고에 대해 궁금한 점" value={question} onChangeText={setQuestion} multiline maxLength={500}
            placeholder="신청할 때 필요한 서류는 무엇인가요?" editable={!answering} />
          <Button label="원문에서 답변 찾기" busy={answering} disabled={!question.trim()} onPress={() => void ask()} />
          {answering && <Button variant="ghost" label="답변 요청 취소" onPress={() => { work.current?.abort(); setAnswering(false) }} />}
        </> : <Button label="로그인하고 질문하기" variant="secondary" onPress={onLogin} />}
        {answerError && <Notice error>{answerError}</Notice>}
        {answer && <><Text style={styles.badge}>{answer.answerStatus === 'ANSWERED' ? 'AI 답변 · 원문 근거 포함' : '원문 근거 부족'}</Text>
          <Text selectable style={styles.body}>{answer.answer}</Text>
          {answer.citations.map((citation, index) => <Card key={`${citation.chunkOrder}-${index}`}>
            <Text selectable style={styles.body}>“{citation.excerpt}”</Text>
            <Button variant="ghost" label={`근거 ${index + 1} 원문 열기`} onPress={() => void openSource(citation.sourceUrl)} />
          </Card>)}
        </>}
      </Card>
    </>}
  </Page>
}
