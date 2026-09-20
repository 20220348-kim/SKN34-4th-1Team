import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'react-redux'
import type { RootState } from '../../../../app/store'
import { CombinationReviewError } from '../../../../domain/errors/CombinationReviewError'
import { reviewFailureMessage } from './reviewMessages'

/** 세션 변경을 store에서 즉시 관찰한다. React 재렌더 전 도착한 응답도 반영하지 않는다. */
export function useReviewScope() {
  const store = useStore<RootState>()
  const owner = useRef(store.getState().auth)
  const active = useRef(true)
  const requests = useRef(new Map<string, AbortController>())
  const [busy, setBusy] = useState<string[]>([])
  const [error, setError] = useState<{ message: string; status?: number; code?: string; runId?: number | null } | null>(null)
  useEffect(() => {
    active.current = true
    const cancel = () => { for (const controller of requests.current.values()) controller.abort(); requests.current.clear() }
    const unsubscribe = store.subscribe(() => { if (store.getState().auth !== owner.current) { active.current = false; cancel() } })
    return () => { active.current = false; cancel(); unsubscribe() }
  }, [store])
  const perform = useCallback(async <T,>(name: string, operation: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void) => {
    if (!active.current || store.getState().auth !== owner.current || requests.current.has(name)) return
    const controller = new AbortController()
    requests.current.set(name, controller); setBusy([...requests.current.keys()]); setError(null)
    const current = () => active.current && !controller.signal.aborted && store.getState().auth === owner.current
    try { const value = await operation(controller.signal); if (current()) { accept(value); return true } }
    catch (failure) { if (current()) setError({ message: reviewFailureMessage(failure), ...(failure instanceof CombinationReviewError ? { status: failure.status, code: failure.code, runId: failure.runId } : {}) }) }
    finally {
      if (requests.current.get(name) === controller) requests.current.delete(name)
      if (current()) setBusy([...requests.current.keys()])
    }
  }, [store])
  return { perform, busy, error, setError }
}
