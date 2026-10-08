import { useCallback, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { ApiError, errorMessage } from '../api/client'
import { listSavedPrograms, removeSavedProgram, saveProgram } from '../api/savedPrograms'
import { useAuth } from '../auth/session'
import { Button, Notice } from '../ui'

const keyOf = (identity: SupportProgramIdentity) => JSON.stringify([identity.sourceCode, identity.sourceProgramId])
type State = { owner: string | null; saved: Set<string>; pending: Set<string>; ready: boolean; error: string | null; errors: Record<string, string> }
const empty = (owner: string | null): State => ({ owner, saved: new Set(), pending: new Set(), ready: false, error: null, errors: {} })

/** AI 검색과 필터 검색의 관심 상태를 한 번 읽고, 같은 공고의 변경을 함께 반영합니다. */
export function useSearchProgramInterests() {
  const { status, session, invalidateSession } = useAuth()
  const token = status === 'signedIn' ? session?.accessToken ?? null : null
  const [state, setState] = useState<State>(() => empty(token))
  const [revision, setRevision] = useState(0)
  const work = useRef<{ controller: AbortController; pending: Set<string> } | null>(null)
  useFocusEffect(useCallback(() => {
    if (!token) return
    const current = { controller: new AbortController(), pending: new Set<string>() }
    work.current = current; setState(empty(token))
    void listSavedPrograms(token, current.controller.signal).then(items => {
      if (!current.controller.signal.aborted) setState({ ...empty(token), ready: true,
        saved: new Set(items.map(({ program }) => keyOf({ sourceCode: program.sourceCode, sourceProgramId: program.id }))) })
    }).catch(cause => {
      if (current.controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setState({ ...empty(token), error: '관심 공고 상태를 불러오지 못했어요. 다시 확인해 주세요.' })
    })
    return () => { current.controller.abort(); work.current = null }
  }, [token, revision, invalidateSession]))
  const visible = state.owner === token ? state : empty(token)
  async function toggle(identity: SupportProgramIdentity) {
    const current = work.current, key = keyOf(identity)
    if (!token || !visible.ready || !current || current.controller.signal.aborted || current.pending.has(key)) return
    current.pending.add(key)
    setState(value => ({ ...value, pending: new Set(current.pending), errors: { ...value.errors, [key]: '' } }))
    const wasSaved = visible.saved.has(key)
    try {
      if (wasSaved) await removeSavedProgram(token, identity, current.controller.signal)
      else await saveProgram(token, identity, current.controller.signal)
      if (current.controller.signal.aborted) return
      setState(value => {
        const saved = new Set(value.saved)
        if (wasSaved) saved.delete(key); else saved.add(key)
        return { ...value, saved }
      })
    } catch (cause) {
      if (current.controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setState(value => ({ ...value, errors: { ...value.errors, [key]: errorMessage(cause) } }))
    } finally {
      current.pending.delete(key)
      if (!current.controller.signal.aborted) setState(value => ({ ...value, pending: new Set(current.pending) }))
    }
  }
  return { ...visible, authenticated: Boolean(token), available: status === 'signedIn' || status === 'signedOut',
    toggle, retry: () => setRevision(value => value + 1) }
}

export type SearchProgramInterests = ReturnType<typeof useSearchProgramInterests>

export function ProgramInterestButton({ identity, title, interests, onLogin }: {
  identity: SupportProgramIdentity; title: string; interests: SearchProgramInterests; onLogin(): void
}) {
  const key = keyOf(identity), saved = interests.saved.has(key), busy = interests.pending.has(key)
  const label = saved ? '관심 공고에서 빼기' : '관심 공고에 추가'
  return <>
    <Button label={label} accessibilityLabel={`${title} ${label}`} variant="secondary" busy={busy}
      disabled={!interests.available || interests.authenticated && !interests.ready}
      onPress={() => interests.authenticated ? void interests.toggle(identity) : onLogin()} />
    {interests.errors[key] && <Notice error>{interests.errors[key]}</Notice>}
  </>
}
