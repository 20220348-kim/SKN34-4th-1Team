import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { appContainer } from '../../../../app/appContainer'
import type { ApplicationFormDiscoveryJob, ApplicationPreparationListStatus, ApplicationPreparationPage } from '../../../../domain/entities/ApplicationPreparation'
import type { WorkspaceToastNotice } from '../../../shared/workspace/WorkspaceToast'

type FailedRequest = { kind: 'list'; beforeId?: number } | { kind: 'delete'; id: number }

/** 끝난 분석을 목록 위 안내에 남겨 두는 시간입니다. 진행 중인 분석은 시간과 무관하게 보여 줍니다. */
export const formAnalysisWindowMs = 24 * 60 * 60 * 1000
/** 진행 중인 분석이 있을 때 상태를 다시 읽는 간격입니다. */
export const formAnalysisPollMs = 5_000

/** 결과 확인 중인 분석만 남았을 때 상태를 다시 읽는 간격입니다. 서버가 결과를 확정하거나 늦어도 30분 뒤에 닫습니다. */
export const formAnalysisSettlePollMs = 30_000

/**
 * 분석 작업 하나를 화면에서 다루는 상태입니다. active는 대기·분석 중, unknown은 시작한 뒤 결과를 확인하지 못해 서버가 확인 중인 작업,
 * settled는 결과 불명이던 작업이 그 공고의 양식 조회로 결과가 확정돼 닫힌 작업입니다(실패가 아니라 "결과를 확인해 보라"는 뜻).
 * source는 분석은 끝났지만 작성할 양식을 얻지 못한 경우로, 실제로 양식이 없는 공고일 수 있어 실패가 아니라 "원문 참고"로 알립니다.
 */
export type FormAnalysisState = 'active' | 'unknown' | 'done' | 'settled' | 'source' | 'failed'
export type FormAnalysisRow = { job: ApplicationFormDiscoveryJob; state: FormAnalysisState }
/** 목록에 한 번에 보이는 분석 카드 수입니다. 신청 문서 카드가 밀려 내려가지 않게 두 줄(3열 기준)까지만 둡니다. */
export const maxFormAnalysisCards = 6

const running = (job: ApplicationFormDiscoveryJob) => job.status === 'QUEUED' || job.status === 'RUNNING'
const pending = (job: ApplicationFormDiscoveryJob) => running(job) || job.status === 'UNKNOWN'

/**
 * 작성할 양식을 얻지 못한 채 끝난 분석입니다(양식이 없거나, 분석할 수 없는 첨부이거나, 공고·첨부가 없어진 경우).
 * 서버는 실패로 기록하지만 다시 분석해도 같은 결과이므로, 실패 대신 공식 원문을 참고하도록 안내합니다.
 */
export function formAnalysisNeedsSource(code: string | null): boolean {
  return ['NO_FORM', 'SOURCE_UNSUPPORTED', 'SOURCE_TOO_LARGE', 'SOURCE_NOT_FOUND'].includes((code ?? '').replace(/^APPLICATION_FORM_/, ''))
}

/** 분석 작업의 화면 상태입니다. 끝난 지 하루가 지난 분석은 더 알리지 않으므로 null입니다. */
export function formAnalysisState(job: ApplicationFormDiscoveryJob, now = Date.now()): FormAnalysisState | null {
  if (running(job)) return 'active'
  if (job.status === 'UNKNOWN') return 'unknown'
  const started = Date.parse(job.createdAt)
  if (Number.isNaN(started) || now - started > formAnalysisWindowMs) return null
  if (job.status === 'SUCCEEDED') return 'done'
  if (job.failureCode === 'RUN_OUTCOME_SETTLED') return 'settled'
  return formAnalysisNeedsSource(job.failureCode) ? 'source' : 'failed'
}

/**
 * 목록에 "양식 분석" 카드로 보일 분석입니다. 공고마다 가장 최근 분석 하나만 남기고, 진행 중·결과 확인 중인 것은 늘,
 * 끝난 것(완료·결과 확인됨·원문 참고·실패)은 시작한 지 하루 안의 것만 돌려줍니다. 진행 중, 결과 확인 중, 끝난 것 순이고 그 안에서는 최근 순입니다.
 * 분석은 신청 문서가 아니라 서버의 분석 작업 기록입니다.
 */
export function recentFormAnalyses(jobs: readonly ApplicationFormDiscoveryJob[], now = Date.now()): FormAnalysisRow[] {
  const latest = new Map<string, ApplicationFormDiscoveryJob>()
  for (const job of jobs) {
    const key = `${job.sourceCode}:${job.sourceProgramId}`
    const known = latest.get(key)
    if (!known || known.id < job.id) latest.set(key, job)
  }
  const rows = [...latest.values()].sort((left, right) => right.id - left.id).flatMap<FormAnalysisRow>((job) => {
    const state = formAnalysisState(job, now)
    return state ? [{ job, state }] : []
  })
  const waiting = (row: FormAnalysisRow) => row.state === 'active' || row.state === 'unknown'
  return [...rows.filter((row) => row.state === 'active'), ...rows.filter((row) => row.state === 'unknown'), ...rows.filter((row) => !waiting(row))]
}

/** 지켜보던 분석이 끝났을 때의 토스트 문구입니다. 결과 확인 중으로 넘어간 것은 아직 끝난 것이 아니라 알리지 않습니다. */
function finishedAnalysisNotice(job: ApplicationFormDiscoveryJob): string {
  if (job.status === 'SUCCEEDED') return `양식 분석이 끝났어요 · ${job.programTitle}`
  if (job.failureCode === 'RUN_OUTCOME_SETTLED') return `양식 분석 결과가 확인됐어요 · ${job.programTitle}`
  return formAnalysisNeedsSource(job.failureCode)
    ? `작성할 양식을 찾지 못했어요. 원문을 참고해 주세요 · ${job.programTitle}`
    : `양식을 분석하지 못했어요 · ${job.programTitle}`
}
type ListBusyState = 'initial' | 'more' | null

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('신청 준비 목록을 불러오지 못했습니다.')
}

function listStatusFrom(value: string | null): ApplicationPreparationListStatus | undefined {
  return value === 'in_progress' || value === 'done' ? value : undefined
}

export function useApplicationPreparationListViewModel() {
  const useCase = appContainer.resolve('applicationPreparationUseCase')
  const [searchParams, setSearchParams] = useSearchParams()
  // 진행 중·완료 칩은 주소의 ?status= 와 같이 움직여 새로고침·뒤로 가기에도 남는다.
  const status = listStatusFrom(searchParams.get('status'))
  const [toast, setToast] = useState<WorkspaceToastNotice | null>(null)
  const [page, setPage] = useState<ApplicationPreparationPage | null>(null)
  const [busy, setBusy] = useState<ListBusyState>(null)
  const [error, setError] = useState<Error | null>(null)
  const [failedRequest, setFailedRequest] = useState<FailedRequest | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [analysisJobs, setAnalysisJobs] = useState<ApplicationFormDiscoveryJob[]>([])
  const knownAnalysisJobs = useRef<ApplicationFormDiscoveryJob[]>([])
  const activeController = useRef<AbortController | null>(null)
  const deleteController = useRef<AbortController | null>(null)
  const deleteGuard = useRef<number | null>(null)
  const requestSequence = useRef(0)

  const load = useCallback((beforeId?: number) => {
    activeController.current?.abort()
    const controller = new AbortController()
    const sequence = ++requestSequence.current
    const append = beforeId !== undefined
    activeController.current = controller
    setBusy(append ? 'more' : 'initial')
    setError(null)
    setFailedRequest(null)
    // 필터를 바꿔 처음부터 다시 읽을 때도 기존 목록은 남겨 둡니다. 화면이 흐리게 보여 주다가 새 결과로 바꿉니다.

    void useCase.list({ ...(beforeId === undefined ? {} : { beforeId }), ...(status === undefined ? {} : { status }) }, controller.signal).then((result) => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      setPage((previous) => append && previous
        ? {
            ...result,
            items: [...previous.items, ...result.items.filter(
              (item) => !previous.items.some(({ id }) => id === item.id),
            )],
          }
        : result)
    }).catch((caught: unknown) => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      // 처음부터 읽기에 실패하면 다른 필터의 목록을 지금 필터의 결과처럼 남기지 않습니다. 더 보기 실패는 읽은 목록을 둡니다.
      if (!append) setPage(null)
      setError(asError(caught))
      setFailedRequest({ kind: 'list', beforeId })
    }).finally(() => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      activeController.current = null
      setBusy(null)
    })

    return controller
  }, [useCase, status])

  useEffect(() => {
    const controller = load()
    return () => {
      controller.abort()
      deleteController.current?.abort()
      deleteGuard.current = null
      if (activeController.current === controller) activeController.current = null
      requestSequence.current += 1
    }
  }, [load])

  // 계정의 최근 양식 분석을 읽습니다(GET · AI 호출 없음). 진행 중인 분석이 있으면 끝날 때까지, 결과 확인 중인 분석만 남으면 느리게 다시 읽고,
  // 이 화면에 있는 동안 끝나면(완료·실패·결과 확인됨) 토스트로 알립니다. 안내를 못 읽어도 목록은 그대로 쓸 수 있으므로 실패는 알리지 않습니다.
  const analysisPollMs = analysisJobs.some(running) ? formAnalysisPollMs : analysisJobs.some(pending) ? formAnalysisSettlePollMs : null
  useEffect(() => {
    const controller = new AbortController()
    const read = () => useCase.discoveryJobs(controller.signal).then((jobs) => {
      if (controller.signal.aborted) return
      const finished = jobs.find((job) => !pending(job) && knownAnalysisJobs.current.some((known) => known.id === job.id && pending(known)))
      knownAnalysisJobs.current = jobs
      setAnalysisJobs(jobs)
      if (finished) setToast({ id: Date.now(), text: finishedAnalysisNotice(finished) })
    }).catch(() => undefined)
    if (analysisPollMs === null) { void read(); return () => controller.abort() }
    const timer = setInterval(() => { void read() }, analysisPollMs)
    return () => { clearInterval(timer); controller.abort() }
  }, [analysisPollMs, useCase])

  const deletePreparation = useCallback(async (id: number): Promise<boolean> => {
    if (deleteGuard.current !== null) return false
    deleteGuard.current = id
    deleteController.current?.abort()
    const controller = new AbortController()
    deleteController.current = controller
    setDeletingId(id)
    setError(null)
    setFailedRequest(null)
    try {
      await useCase.delete(id, controller.signal)
      if (controller.signal.aborted || deleteController.current !== controller) return false
      setPage((current) => current ? { ...current, items: current.items.filter((item) => item.id !== id) } : current)
      setToast({ id: Date.now(), text: '삭제했어요.' })
      return true
    } catch (caught) {
      if (!controller.signal.aborted && deleteController.current === controller) {
        setError(asError(caught))
        setFailedRequest({ kind: 'delete', id })
      }
      return false
    } finally {
      if (deleteController.current === controller) {
        deleteController.current = null
        deleteGuard.current = null
        setDeletingId(null)
      }
    }
  }, [useCase])

  const retry = useCallback(() => {
    if (failedRequest?.kind === 'list') load(failedRequest.beforeId)
    if (failedRequest?.kind === 'delete') void deletePreparation(failedRequest.id)
  }, [failedRequest, load, deletePreparation])

  const setStatus = useCallback((next: ApplicationPreparationListStatus | undefined) => {
    setSearchParams(next === undefined ? {} : { status: next }, { replace: true })
  }, [setSearchParams])

  return {
    page,
    /**
     * 목록 맨 앞에 카드로 보일 양식 분석입니다. 전체 탭에서 목록을 읽은 뒤에만 보이고, 끝난 분석은 그 공고의 신청 문서가
     * 이미 목록에 있으면 뺍니다(같은 공고가 두 카드로 보이지 않게). 진행 중·결과 확인 중인 분석은 그대로 둡니다.
     */
    analyses: status === undefined && page !== null
      ? recentFormAnalyses(analysisJobs).filter(({ job, state }) => state === 'active' || state === 'unknown'
        || !page.items.some((item) => item.sourceCode === job.sourceCode && item.sourceProgramId === job.sourceProgramId)).slice(0, maxFormAnalysisCards)
      : [],
    status,
    setStatus,
    toast,
    dismissToast: () => setToast(null),
    error,
    retry,
    deletePreparation,
    deletingId,
    loadMore: () => page?.nextBeforeId ? load(page.nextBeforeId) : undefined,
    /** 첫 쪽을 읽는 중입니다. 처음 들어왔을 때와 필터를 바꿨을 때 모두 해당하며, 뒤쪽은 `page`에 이전 목록이 남아 있습니다. */
    isInitialLoading: busy === 'initial',
    isLoadingMore: busy === 'more',
  }
}
