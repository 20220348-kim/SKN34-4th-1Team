import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import type { ApplicationOnlineInputGuide } from '@govbiz/shared/domain/entities/ApplicationOnlineInputGuide'
import { formatSavedApplicationAnswers } from '@govbiz/shared/domain/entities/ApplicationOnlineInputGuide'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { applicationPreparationUseCase } from '../api/applicationPreparation'
import { getApiBaseUrl } from '../api/client'
import { shareApplicationFile } from '../api/applicationDocumentFiles'
import { useAuth } from '../auth/session'
import { PreparationAccess } from '../components/ApplicationPreparationUi'
import { Button, Card, Notice, Page, StatusBadge, colors, styles } from '../ui'

export function ApplicationOnlineInputScreen({ id, onLogin, onEditor }: { id: number; onLogin(): void; onEditor(): void }) {
  const auth = useAuth()
  if (auth.status !== 'signedIn' || !auth.session) return <PreparationAccess onLogin={onLogin} />
  return <OwnedOnline key={`${auth.session.accessToken}:${id}`} id={id} token={auth.session.accessToken} email={auth.session.account.email} onEditor={onEditor} />
}
function OwnedOnline({ id, token, email, onEditor }: { id: number; token: string; email: string; onEditor(): void }) {
  const { invalidateSession } = useAuth()
  const useCase = useMemo(() => applicationPreparationUseCase(token), [token])
  const [guide, setGuide] = useState<ApplicationOnlineInputGuide | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const request = useRef<AbortController | null>(null)
  const focused = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort() } }, [])
  useFocusEffect(useCallback(() => {
    focused.current = true
    return () => {
      focused.current = false
      request.current?.abort(); request.current = null; setBusy(false)
    }
  }, []))
  useFocusEffect(useCallback(() => {
    const controller = new AbortController(); setGuide(null); setError(null)
    void Promise.all([useCase.onlineInputGuide(id, controller.signal), useCase.get(id, controller.signal)]).then(([result, detail]) => {
      if (controller.signal.aborted) return
      if (result.inputRevision !== detail.inputRevision) throw new Error('저장된 답변이 바뀌었어요. 답변 입력 화면에서 최신 내용을 확인해 주세요.')
      setGuide(result)
    }).catch(cause => { if (!controller.signal.aborted) {
      if (cause instanceof ApplicationPreparationError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setError(cause instanceof Error ? cause.message : '온라인 신청 안내를 확인하지 못했어요.')
    } })
    return () => controller.abort()
  }, [id, useCase, revision, invalidateSession]))
  async function copy(value: string) {
    try { await Clipboard.setStringAsync(value); if (mounted.current) setNotice('답변을 복사했어요.') }
    catch { if (mounted.current) setError('답변을 복사하지 못했어요. 다시 시도해 주세요.') }
  }
  async function saveTxt() {
    if (!guide || busy || !focused.current) return
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(null)
    try {
      await shareApplicationFile(`${getApiBaseUrl()}:${email}`, new Blob(['\uFEFF', formatSavedApplicationAnswers(guide)], { type: 'text/plain;charset=utf-8' }), `신청답변-${id}.txt`, () => mounted.current && focused.current && !controller.signal.aborted, controller.signal)
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '답변 파일을 저장하지 못했어요.') }
    finally {
      if (request.current === controller) {
        request.current = null
        if (mounted.current && !controller.signal.aborted) setBusy(false)
      }
    }
  }
  const statuses = { READY: '준비 완료', NEEDS_REVIEW: '확인 필요', MISSING: '답변 필요', DIRECT_INPUT: '직접 처리 필요' }
  return <Page><Text style={styles.title}>온라인 신청을 준비하세요</Text><Notice>저장 답변을 복사해 공식 신청 화면에 직접 입력해요. 자동 입력이나 최종 제출은 하지 않습니다.</Notice>
    {error && <><Notice error>{error}</Notice><Button label="입력 안내 다시 확인" variant="secondary" onPress={() => setRevision(value => value + 1)} /></>}
    {notice && <Notice>{notice}</Notice>}
    {!guide && !error && <ActivityIndicator accessibilityLabel="온라인 신청 안내 불러오는 중" color={colors.primary} />}
    {guide && <><Text style={styles.heading}>준비된 답변 {guide.readyCount} / {guide.totalCount}</Text>
      {!guide.externalMappingVerified && <Notice>공식 신청 문항과 저장 답변의 대응 관계를 직접 확인해 주세요.</Notice>}
      {guide.items.map((item, index) => <Card key={item.sourceControlId ?? item.fieldId ?? String(index)}><View style={styles.row}><StatusBadge label={statuses[item.status]} tone={item.status === 'READY' ? 'success' : 'warning'} /></View>
        <Text style={styles.heading}>{item.label}</Text><Text style={styles.muted}>{item.required ? '필수' : '선택'}{item.inputMode === 'UNKNOWN' ? ' · 입력 형태 미확인' : ''}</Text>
        {item.answer && <Text style={styles.body}>{item.answer}</Text>}
        <Button label="답변 복사" accessibilityLabel={`${item.label} 답변 복사`} variant="secondary" disabled={!item.copyable || !item.answer} onPress={() => void copy(item.answer!)} />
      </Card>)}
      <Button label="저장 답변 전체 복사" variant="secondary" disabled={!guide.savedAnswers.length} onPress={() => void copy(formatSavedApplicationAnswers(guide))} />
      <Button label="TXT로 내려받기·공유" variant="secondary" disabled={!guide.savedAnswers.length || busy} busy={busy} onPress={() => void saveTxt()} />
      {guide.officialApplicationUrl && <Button label="공식 신청 페이지 열기" onPress={() => void Linking.openURL(guide.officialApplicationUrl!).catch(() => setError('공식 신청 페이지를 열지 못했어요.'))} />}
    </>}
    <Button label="답변 입력으로 돌아가기" variant="ghost" onPress={onEditor} />
  </Page>
}
