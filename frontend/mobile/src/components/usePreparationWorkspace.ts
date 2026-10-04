import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import type { ApplicationPreparationSummary } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import { listPreparations, listPreparationReviews, type PreparationReview } from '../api/preparation'
import { ApiError, errorMessage } from '../api/client'
import { useAuth } from '../auth/session'
import { useAppForeground } from './useAppForeground'

type Workspace = { owner: string | null; preparations: ApplicationPreparationSummary[] | null; reviews: PreparationReview[] | null;
  preparationError: string | null; reviewError: string | null; loading: boolean }
const empty = (owner: string | null): Workspace => ({ owner, preparations: null, reviews: null, preparationError: null, reviewError: null, loading: true })

/** Shared by the saved workspace and the saved program's preparation section. */
export function usePreparationWorkspace(token: string | null, enabled = true) {
  const { invalidateSession } = useAuth()
  const [state, setState] = useState<Workspace>(() => empty(token))
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const foreground = useAppForeground()
  useFocusEffect(useCallback(() => {
    if (!token || !enabled || !foreground) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setState((current) => current.owner === token ? { ...current, loading: true, preparationError: null, reviewError: null } : empty(token))
    const handleError = (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      return errorMessage(cause)
    }
    void Promise.allSettled([listPreparations(token, controller.signal), listPreparationReviews(token, controller.signal)]).then(([preparations, reviews]) => {
      if (controller.signal.aborted) return
      const next = { owner: token, loading: false,
        preparations: preparations.status === 'fulfilled' ? preparations.value : null,
        reviews: reviews.status === 'fulfilled' ? reviews.value : null,
        preparationError: preparations.status === 'rejected' ? handleError(preparations.reason) : null,
        reviewError: reviews.status === 'rejected' ? handleError(reviews.reason) : null }
      setState(next)
      if (!next.preparationError && !next.reviewError && next.reviews?.some(({ review, latestRun }) => latestRun?.inputRevision === review.inputRevision
        && (latestRun.status === 'QUEUED' || latestRun.status === 'RUNNING'))) timer = setTimeout(refresh, 10_000)
    })
    return () => { controller.abort(); clearTimeout(timer) }
  }, [token, enabled, foreground, revision, invalidateSession, refresh]))
  const visible = state.owner === token ? state : empty(token)
  return { ...visible, refresh }
}
