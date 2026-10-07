import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { randomUUID } from 'expo-crypto'
import { CombinationReviewUseCase } from '@govbiz/shared/domain/usecases/CombinationReviewUseCase'
import { reviewProgramKey, supportsAutomaticReview, validateReviewDraft, type CombinationReview, type ReviewDraft, type ReviewRun, type RunSummary } from '@govbiz/shared/domain/entities/CombinationReview'
import { CombinationReviewError } from '@govbiz/shared/domain/errors/CombinationReviewError'
import { MobileCombinationReviewRepository, reviewErrorMessage } from '../api/combinationReviews'
import { getApiBaseUrl } from '../api/client'
import { clearPendingReview, readPendingReview, savePendingReview, type PendingReviewRequest } from '../auth/reviewPending'
import { useAuth } from '../auth/session'

const activeRun = (run: RunSummary) => ['QUEUED', 'RUNNING', 'UNKNOWN'].includes(run.status)

/** One account/route instance owns drafts, cancellation and the acknowledged run. */
export function useCombinationReview(token: string, email: string, id: number | null, initialRunId?: number) {
  const useCase = useMemo(() => new CombinationReviewUseCase(new MobileCombinationReviewRepository(token)), [token])
  const { invalidateSession } = useAuth()
  const [review, setReview] = useState<CombinationReview | null>(null)
  const [draft, setDraft] = useState<ReviewDraft>({ title: '', programs: [] })
  const [facts, setFacts] = useState('')
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [run, setRun] = useState<ReviewRun | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<number | null>(initialRunId ?? null)
  const [pending, setPending] = useState<PendingReviewRequest | null>(null)
  const [storageReady, setStorageReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [operation, setOperation] = useState<'save' | 'analysis' | 'history' | null>(null)
  const busy = operation !== null
  const [saveError, setSaveError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [currentRevision, setCurrentRevision] = useState(0)
  const [revision, setRevision] = useState(0)
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive')
  const loaded = useRef(false)
  const lock = useRef(false)
  const mutation = useRef<AbortController | null>(null)
  const latest = useRef({ review, draft, facts, pending, runs, run, selectedRunId, storageReady })
  latest.current = { review, draft, facts, pending, runs, run, selectedRunId, storageReady }
  const baseUrl = getApiBaseUrl()
  const effectiveId = review?.id ?? id
  const refresh = useCallback(() => { setLoading(true); setRevision(value => value + 1) }, [])

  const fail = useCallback((cause: unknown) => {
    setError(reviewErrorMessage(cause))
    if (cause instanceof CombinationReviewError && cause.status === 401) void invalidateSession().catch(() => undefined)
  }, [invalidateSession])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', value => setForeground(value === 'active'))
    return () => subscription.remove()
  }, [])

  useFocusEffect(useCallback(() => {
    if (!foreground) return
    const controller = new AbortController()
    setLoading(true); setError(null); setOperation(null); setStorageReady(false)
    const reviewId = id ?? latest.current.review?.id
    void (async () => {
      const stored = await readPendingReview(baseUrl, email)
      if (controller.signal.aborted) return
      setPending(stored); setStorageReady(true)
      if (reviewId) {
        const [saved, page] = await Promise.all([useCase.get(reviewId, controller.signal), useCase.runs(reviewId, undefined, controller.signal)])
        if (controller.signal.aborted) return
        const current = latest.current
        const dirty = current.review !== null && JSON.stringify({ title: current.review.title, programs: current.review.programs }) !== JSON.stringify(current.draft)
        if (!loaded.current || !dirty) { setReview(saved); setDraft({ title: saved.title, programs: saved.programs }); setSaveError(null); loaded.current = true }
        else if (saved.inputRevision !== current.review?.inputRevision) setError('다른 화면에서 입력이 변경됐어요. 작성한 내용은 유지됩니다. 최신 저장 입력을 확인해 주세요.')
        setCurrentRevision(saved.inputRevision); setRuns(page.items); setCursor(page.nextBeforeId)
        if (!current.selectedRunId && page.items[0]) setSelectedRunId(page.items[0].id)
      }
    })().catch(cause => { if (!controller.signal.aborted) fail(cause) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); mutation.current?.abort() }
  }, [baseUrl, email, fail, foreground, id, revision, useCase]))

  useFocusEffect(useCallback(() => {
    if (!foreground || !effectiveId || !selectedRunId || loading || busy) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await useCase.run(effectiveId, selectedRunId, controller.signal)
        if (controller.signal.aborted) return
        const previous = latest.current.run
        const rank = (status: RunSummary['status']) => status === 'QUEUED' ? 1 : status === 'RUNNING' ? 2 : 3
        if (previous?.id === result.id && rank(previous.status) > rank(result.status)) return
        setRun(result)
        setRuns(previous => previous.map(item => item.id === result.id ? result : item))
        const stored = latest.current.pending
        if (stored?.reviewId === effectiveId && stored.request.requestKey === result.requestKey
          && stored.request.expectedRevision === result.inputRevision && stored.request.additionalFacts === result.input.additionalFacts) {
          await clearPendingReview(baseUrl, email)
          if (controller.signal.aborted) return
          setPending(null)
        }
        if (result.status === 'QUEUED' || result.status === 'RUNNING') timer = setTimeout(() => void poll(), 3_000)
      } catch (cause) { if (!controller.signal.aborted) fail(cause) }
    }
    void poll()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [baseUrl, busy, effectiveId, email, fail, foreground, loading, revision, selectedRunId, useCase]))

  function selectRun(runId: number) { setRun(null); setSelectedRunId(runId); setError(null); refresh() }
  function reloadInputs() { loaded.current = false; refresh() }

  /** 단계 이동은 입력만 저장한다. 분석 요청 키·추가 설명 보관과 유료 실행은 start가 소유한다. */
  async function saveInputs(): Promise<CombinationReview | null> {
    if (lock.current || loading) return null
    const snapshot = latest.current
    const controller = new AbortController(); mutation.current = controller
    lock.current = true; setOperation('save'); setError(null); setSaveError(null)
    try {
      if (!snapshot.storageReady) throw new Error('분석 요청 보관 상태를 먼저 확인한 뒤 입력을 저장해 주세요.')
      if (snapshot.pending) throw new Error('미확인 분석 요청이 있어 입력을 저장하지 않았어요. 같은 요청으로 먼저 확인해 주세요.')
      const input = validateReviewDraft(snapshot.draft)
      let saved = snapshot.review
      if (!saved) saved = await useCase.create(input, controller.signal)
      else if (JSON.stringify({ title: saved.title, programs: saved.programs }) !== JSON.stringify(input)) {
        await useCase.replace(saved.id, saved.inputRevision, input, controller.signal)
        if (controller.signal.aborted) return null
        saved = await useCase.get(saved.id, controller.signal)
      }
      if (controller.signal.aborted) return null
      if (JSON.stringify({ title: saved.title, programs: saved.programs }) !== JSON.stringify(input)) {
        throw new Error('저장된 입력이 작성한 내용과 달라 다음 단계로 이동하지 않았어요. 최신 입력을 확인해 주세요.')
      }
      const savedDraft = { title: saved.title, programs: saved.programs }
      latest.current = { ...latest.current, review: saved, draft: savedDraft }
      setReview(saved); setDraft(savedDraft); setCurrentRevision(saved.inputRevision); loaded.current = true
      return saved
    } catch (cause) {
      if (!controller.signal.aborted) { fail(cause); setSaveError(reviewErrorMessage(cause)) }
      return null
    } finally { lock.current = false; if (!controller.signal.aborted) setOperation(null) }
  }

  async function start(sameRequest = false) {
    if (lock.current) return
    const snapshot = latest.current
    if (!snapshot.storageReady) { setError('분석 요청 보관 상태를 먼저 확인해 주세요.'); return }
    if (snapshot.pending && !sameRequest) { setError('미확인 분석 요청이 있어요. 같은 요청으로 먼저 확인해 주세요.'); return }
    if (!sameRequest && snapshot.runs.some(activeRun)) { setError('대기·분석 중이거나 결과를 확인하는 중인 실행이 있어요. 지금은 새 분석을 시작할 수 없어요.'); return }
    if (sameRequest && (!snapshot.pending || snapshot.pending.reviewId !== effectiveId)) { setError('이 검토의 미확인 요청이 없어요.'); return }
    const controller = new AbortController(); mutation.current = controller
    lock.current = true; setOperation('analysis'); setError(null)
    let submitted: PendingReviewRequest | null = sameRequest ? snapshot.pending : null
    let posted = false
    try {
      if (!submitted) {
        const input = validateReviewDraft(snapshot.draft)
        if (!input.programs.every(supportsAutomaticReview)) throw new Error('선택한 공고는 현재 자동 분석을 지원하지 않아요.')
        const saved = snapshot.review
        if (!saved || JSON.stringify({ title: saved.title, programs: saved.programs }) !== JSON.stringify(input)) {
          throw new Error('검토 입력을 먼저 저장해 주세요. 이전 단계에서 다음을 누른 뒤 검토를 실행해 주세요.')
        }
        submitted = { reviewId: saved.id, request: { expectedRevision: saved.inputRevision, requestKey: randomUUID(), additionalFacts: snapshot.facts } }
        try { await savePendingReview(baseUrl, email, submitted) }
        catch { setStorageReady(false); throw new Error('분석 요청을 안전하게 보관하지 못해 분석을 시작하지 않았어요. 보관 상태를 다시 확인해 주세요.') }
        if (controller.signal.aborted) return
        setPending(submitted)
      }
      if (controller.signal.aborted) return
      posted = true
      const result = await useCase.start(submitted.reviewId, submitted.request, controller.signal)
      if (controller.signal.aborted) return
      setRun(result); setSelectedRunId(result.id); setRuns(previous => [result, ...previous.filter(item => item.id !== result.id)])
      await clearPendingReview(baseUrl, email)
      if (!controller.signal.aborted) setPending(null)
      return true
    } catch (cause) {
      if (controller.signal.aborted) return
      // Only a confirmed rejection allows discarding the key; transport/5xx outcomes retain it.
      if (submitted && cause instanceof CombinationReviewError && cause.status >= 400 && cause.status < 500) {
        try { await clearPendingReview(baseUrl, email); if (!controller.signal.aborted) setPending(null) }
        catch { setStorageReady(false) }
        posted = false
      }
      if (!controller.signal.aborted) fail(cause)
      return posted
    } finally { lock.current = false; if (!controller.signal.aborted) setOperation(null) }
  }

  async function moreRuns() {
    if (!effectiveId || !cursor || lock.current) return
    const controller = new AbortController(); mutation.current = controller; lock.current = true; setOperation('history')
    try {
      const page = await useCase.runs(effectiveId, cursor, controller.signal)
      if (!controller.signal.aborted) { setRuns(previous => [...previous, ...page.items.filter(item => !previous.some(old => old.id === item.id))]); setCursor(page.nextBeforeId) }
    } catch (cause) { if (!controller.signal.aborted) fail(cause) }
    finally { lock.current = false; if (!controller.signal.aborted) setOperation(null) }
  }

  const selectedKeys = draft.programs.map(reviewProgramKey)
  const dirty = review !== null && JSON.stringify({ title: review.title, programs: review.programs }) !== JSON.stringify(draft)
  return { review, draft, setDraft, facts, setFacts, runs, cursor, run, selectedRunId, pending, loading, busy, saving: operation === 'save', saveError, dirty, error, setError, storageReady,
    currentRevision, selectedKeys, active: runs.some(activeRun), saveInputs, start, selectRun, refresh, reloadInputs, moreRuns }
}
