import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { appContainer } from '../../../../app/appContainer'
import type {
  ApplicationDocumentGenerationJob,
  ApplicationFormDiscoveryJob,
  ApplicationPreparationListStatus,
  ApplicationPreparationPage,
  ApplicationPreparationSummary,
} from '../../../../domain/entities/ApplicationPreparation'
import {
  finishedAnalysisWindowMs,
  isPendingJob as pending,
  isRunningJob as running,
  preparationJobPollMs,
  preparationJobSettlePollMs,
  preparationProgramKey,
  usePreparationJobActions,
  usePreparationJobs,
} from '../../../shared/preparation-jobs/usePreparationJobs'
import type { WorkspaceToastNotice } from '../../../shared/workspace/WorkspaceToast'

type FailedRequest = { kind: 'list'; beforeId?: number } | { kind: 'delete'; id: number }

/** 끝난 분석을 목록에 남겨 두는 시간과 작업을 다시 읽는 간격입니다. 값은 사이드바 배지와 함께 쓰는 공용 작업 목록의 것입니다. */
export const formAnalysisWindowMs = finishedAnalysisWindowMs
export const formAnalysisPollMs = preparationJobPollMs
export const formAnalysisSettlePollMs = preparationJobSettlePollMs

/**
 * 분석 작업 하나를 화면에서 다루는 상태입니다. active는 대기·분석 중, unknown은 시작한 뒤 결과를 확인하지 못해 서버가 확인 중인 작업,
 * settled는 결과 불명이던 작업이 그 공고의 양식 조회로 결과가 확정돼 닫힌 작업입니다(실패가 아니라 "결과를 확인해 보라"는 뜻).
 * source는 분석은 끝났지만 작성할 양식을 얻지 못한 경우로, 실제로 양식이 없는 공고일 수 있어 실패가 아니라 "원문 참고"로 알립니다.
 */
export type FormAnalysisState = 'active' | 'unknown' | 'done' | 'settled' | 'source' | 'failed'
export type FormAnalysisRow = { job: ApplicationFormDiscoveryJob; state: FormAnalysisState }
/** 목록에 한 번에 보이는 분석 카드 수입니다. 신청 문서 카드가 밀려 내려가지 않게 두 줄(3열 기준)까지만 둡니다. */
export const maxFormAnalysisCards = 6

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

/**
 * 목록 카드에 입히는 초안 만들기 상태입니다. active는 대기·만드는 중, unknown은 결과 확인 중, failed는 지금 답변 버전의 초안을
 * 만들지 못한 경우입니다. 실패는 답변을 고치거나(버전이 바뀜) 다시 만들어 초안이 생기면 사라집니다.
 */
export type DocumentJobState = { kind: 'active' | 'unknown' | 'failed'; job: ApplicationDocumentGenerationJob }

/** 그 준비 건의 가장 최근 문서 생성 작업으로 카드 상태를 정합니다. 끝난 작업(성공)은 목록의 완료 표시가 맡습니다. */
export function documentJobState(item: ApplicationPreparationSummary, jobs: readonly ApplicationDocumentGenerationJob[]): DocumentJobState | null {
  const latest = jobs.filter((job) => job.preparationId === item.id)
    .reduce<ApplicationDocumentGenerationJob | undefined>((newest, job) => !newest || newest.id < job.id ? job : newest, undefined)
  if (!latest) return null
  if (running(latest)) return { kind: 'active', job: latest }
  if (latest.status === 'UNKNOWN') return { kind: 'unknown', job: latest }
  return latest.status === 'FAILED' && latest.expectedRevision === item.inputRevision && item.hasCurrentDocument !== true
    ? { kind: 'failed', job: latest } : null
}

/** 앞서 본 작업 목록과 견주어, 그사이 끝난(대기·진행·결과 확인 중이 아니게 된) 작업을 돌려줍니다. */
function finishedSince<Job extends { id: number; status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' }>(before: readonly Job[], now: readonly Job[]): Job[] {
  return now.filter((job) => !pending(job) && before.some((known) => known.id === job.id && pending(known)))
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
  /** 작업이 끝났을 때 공고명을 알리려고 지금 목록을 들고 있습니다. */
  const pageRef = useRef<ApplicationPreparationPage | null>(null)
  useEffect(() => { pageRef.current = page }, [page])
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

  // 계정의 최근 양식 분석과 문서 생성 작업입니다. 읽기는 작업 화면 틀의 PreparationJobsSync가 맡고(사이드바 배지와 같은 사본),
  // 이 화면에 있는 동안 지켜보던 작업이 끝나면 토스트로 알리며 초안이 만들어진 카드는 완료로 바꿉니다.
  const { analysisJobs, documentJobs, readAt: analysesReadAt, unseen } = usePreparationJobs()
  const { refresh: refreshJobs, markDocumentJobsSeen } = usePreparationJobActions()
  // 답변을 고쳐 버전이 달라진 문서의 예전 실패는 카드에서 더 알리지 않으므로, 확인 전 표시가 남지 않게 확인한 것으로 돌립니다.
  const obsoleteFailuresMarked = useRef(new Set<number>())
  useEffect(() => {
    for (const item of page?.items ?? []) {
      if (!unseen.preparationIds.includes(item.id) || obsoleteFailuresMarked.current.has(item.id)) continue
      const latest = documentJobs.filter((job) => job.preparationId === item.id).reduce<ApplicationDocumentGenerationJob | undefined>(
        (newest, job) => !newest || newest.id < job.id ? job : newest, undefined)
      if (latest?.status === 'FAILED' && latest.expectedRevision !== item.inputRevision) {
        obsoleteFailuresMarked.current.add(item.id)
        markDocumentJobsSeen(item.id)
      }
    }
  }, [documentJobs, markDocumentJobsSeen, page, unseen])
  const knownAnalysisJobs = useRef(analysisJobs)
  const knownDocumentJobs = useRef(documentJobs)
  useEffect(() => {
    const finished = finishedSince(knownAnalysisJobs.current, analysisJobs)
    knownAnalysisJobs.current = analysisJobs
    finished.forEach((job) => setToast({ id: Date.now(), text: finishedAnalysisNotice(job) }))
  }, [analysisJobs])
  useEffect(() => {
    const finished = finishedSince(knownDocumentJobs.current, documentJobs)
    knownDocumentJobs.current = documentJobs
    finished.forEach((job) => {
      const title = pageRef.current?.items.find((item) => item.id === job.preparationId)?.programTitle
      if (job.status === 'SUCCEEDED') {
        setPage((current) => current ? {
          ...current,
          items: current.items.map((item) => item.id === job.preparationId && item.inputRevision === job.expectedRevision ? { ...item, hasCurrentDocument: true } : item),
        } : current)
      }
      setToast({ id: Date.now(), text: `${job.status === 'SUCCEEDED' ? '초안을 만들었어요' : '초안을 만들지 못했어요'}${title ? ` · ${title}` : ''}` })
    })
  }, [documentJobs])

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
      // 지운 문서의 작업이 사이드바의 확인 전 수에 남지 않게 작업 목록을 다시 읽습니다.
      refreshJobs()
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
  }, [refreshJobs, useCase])

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
     * 이미 목록에 있으면 뺍니다(같은 공고가 두 카드로 보이지 않게). 진행 중·결과 확인 중인 분석과 아직 확인하지 않은 결과는 그대로 둡니다.
     */
    analyses: status === undefined && page !== null
      // "하루 안"은 사이드바 배지와 같은 시각(마지막으로 읽은 때)으로 판정하고, 확인 전 결과는 다른 끝난 분석보다 앞에 두어 카드 수 한도에 밀리지 않게 합니다.
      ? recentFormAnalyses(analysisJobs, analysesReadAt).filter(({ job, state }) => state === 'active' || state === 'unknown'
        || unseen.programKeys.includes(preparationProgramKey(job))
        || !page.items.some((item) => item.sourceCode === job.sourceCode && item.sourceProgramId === job.sourceProgramId))
        .map((row, index) => ({ row, index, rank: row.state === 'active' ? 0 : row.state === 'unknown' ? 1 : unseen.programKeys.includes(preparationProgramKey(row.job)) ? 2 : 3 }))
        .sort((left, right) => left.rank - right.rank || left.index - right.index)
        .map(({ row }) => row).slice(0, maxFormAnalysisCards)
      : [],
    /** 분석 작업을 마지막으로 읽은 시각입니다. 분석 카드의 경과 시간을 이 시각 기준으로 그립니다. */
    analysesReadAt,
    /** 끝났지만 아직 결과 화면을 열지 않은 분석·초안입니다. 카드에 "새 결과"를 붙이고, 그 화면을 열면 사라집니다. */
    isAnalysisUnseen: (job: ApplicationFormDiscoveryJob) => unseen.programKeys.includes(preparationProgramKey(job)),
    isDocumentResultUnseen: (item: ApplicationPreparationSummary) => unseen.preparationIds.includes(item.id),
    /** 카드에 입힐 초안 만들기 상태입니다(만드는 중 · 결과 확인 중 · 실패). 해당 없으면 null입니다. */
    documentJobStateOf: (item: ApplicationPreparationSummary) => documentJobState(item, documentJobs),
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
