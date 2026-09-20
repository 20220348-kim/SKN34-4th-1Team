import { useCallback, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { ActivityIndicator, Text } from 'react-native'
import { savedSupportProgramListDtoSchema, toSavedSupportProgram } from '@govbiz/shared/data/models/SavedSupportProgramDto'
import type { SavedSupportProgram } from '@govbiz/shared/domain/entities/SavedSupportProgram'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { apiRequest, ApiError, errorMessage } from '../api/client'
import { useAuth } from '../auth/session'
import { Page, Button, Notice, Card, Title, styles } from '../ui'

type SavedState = { token: string | null; programs: SavedSupportProgram[]; loading: boolean; error: string | null }

export function SavedProgramsScreen({ onOpenProgram }: { onOpenProgram(identity: SupportProgramIdentity): void }) {
  const { session, status, refreshSession, invalidateSession } = useAuth()
  const token = session?.accessToken ?? null
  const [state, setState] = useState<SavedState>({ token: null, programs: [], loading: true, error: null })
  const [revision, setRevision] = useState(0)
  const [removing, setRemoving] = useState<string | null>(null)
  const mutation = useRef<AbortController | null>(null)

  useFocusEffect(useCallback(() => {
    const controller = new AbortController()
    mutation.current?.abort()
    setRemoving(null)
    setState({ token, programs: [], loading: true, error: null })
    if (token) {
      void apiRequest('/api/v1/me/saved-programs', { accessToken: token, signal: controller.signal }).then((payload) => {
        const programs = savedSupportProgramListDtoSchema.parse(payload).programs.map(toSavedSupportProgram)
        if (!controller.signal.aborted) setState({ token, programs, loading: false, error: null })
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.status === 401) void invalidateSession().catch(() => undefined)
        setState({ token, programs: [], loading: false, error: errorMessage(error) })
      })
    }
    return () => { controller.abort(); mutation.current?.abort() }
  }, [token, revision, invalidateSession]))

  async function removeProgram(identity: SupportProgramIdentity) {
    if (!token || removing) return
    mutation.current?.abort()
    const controller = new AbortController()
    mutation.current = controller
    const key = JSON.stringify(identity)
    setRemoving(key)
    setState((current) => ({ ...current, error: null }))
    try {
      const query = new URLSearchParams(identity)
      await apiRequest(`/api/v1/me/saved-programs?${query}`, { method: 'DELETE', accessToken: token, signal: controller.signal })
      if (!controller.signal.aborted) setState((current) => current.token !== token ? current : { ...current, programs: current.programs.filter(({ program }) => program.sourceCode !== identity.sourceCode || program.id !== identity.sourceProgramId) })
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof ApiError && error.status === 401) void invalidateSession().catch(() => undefined)
      setState((current) => current.token !== token ? current : { ...current, error: errorMessage(error) })
    } finally {
      if (mutation.current === controller) setRemoving(null)
    }
  }

  if (status === 'loading') return <Page><ActivityIndicator accessibilityLabel="로그인 상태 확인 중" /></Page>
  if (status === 'unavailable') return <Page><Notice error>로그인 상태를 확인하지 못했습니다.</Notice><Button label="다시 확인" onPress={() => void refreshSession()} /></Page>
  if (!token) return <Page><Title>관심 공고</Title><Notice>내 정보 탭에서 로그인하면 웹과 앱에 저장한 관심 공고를 볼 수 있습니다.</Notice></Page>
  const visible = state.token === token ? state : { programs: [], loading: true, error: null }
  return <Page>
    <Title>관심 공고</Title>
    <Text style={styles.muted}>웹과 앱에서 저장한 공고를 한곳에서 확인하세요.</Text>
    <Button label="새로고침" variant="secondary" disabled={visible.loading || !!removing} onPress={() => setRevision((value) => value + 1)} />
    {visible.loading && <ActivityIndicator accessibilityLabel="관심 공고 불러오는 중" />}
    {visible.error && <Notice error>{visible.error}</Notice>}
    {!visible.loading && !visible.error && visible.programs.length === 0 && <Notice>아직 관심 공고가 없습니다. 공고 상세 화면에서 저장해 보세요.</Notice>}
    {visible.programs.map(({ program, savedAt }) => {
      const identity = { sourceCode: program.sourceCode, sourceProgramId: program.id }
      return <Card key={JSON.stringify(identity)}>
        <Text style={styles.heading}>{program.title}</Text>
        <Text style={styles.muted}>{program.organization} · {program.applicationPeriod}</Text>
        <Text style={styles.muted}>저장일 {savedAt.slice(0, 10)}</Text>
        <Button label="공고 상세" onPress={() => onOpenProgram(identity)} />
        <Button label="관심 공고에서 삭제" variant="ghost" disabled={removing !== null} busy={removing === JSON.stringify(identity)} onPress={() => void removeProgram(identity)} />
      </Card>
    })}
  </Page>
}
