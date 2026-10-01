import { useCallback, useMemo } from 'react'

import { appContainer } from '../../../app/appContainer'
import { useAppDispatch, useAppSelector } from '../../../app/hooks'
import type { ApplicationDocumentGenerationJob, ApplicationFormDiscoveryJob } from '../../../domain/entities/ApplicationPreparation'
import {
  preparationJobsRefreshRequested,
  selectPreparationAnalysisJobs,
  selectPreparationDocumentJobs,
  selectPreparationJobsReadAt,
} from './state/preparationJobsSlice'

/** 진행 중인 작업이 있을 때 상태를 다시 읽는 간격입니다. */
export const preparationJobPollMs = 5_000
/** 결과 확인 중인 작업만 남았을 때 다시 읽는 간격입니다. 서버가 결과를 확정하거나 시간이 지나면 닫습니다. */
export const preparationJobSettlePollMs = 30_000
/** 끝난 분석을 화면에 남겨 두는 시간입니다. 이보다 오래된 분석은 카드도, 확인 전 표시도 두지 않습니다. */
export const finishedAnalysisWindowMs = 24 * 60 * 60 * 1000

/** 분석 작업과 문서 생성 작업이 함께 쓰는 상태입니다. */
type WatchedJob = { id: number; status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'; seen?: boolean }

export const isRunningJob = (job: WatchedJob) => job.status === 'QUEUED' || job.status === 'RUNNING'
export const isPendingJob = (job: WatchedJob) => isRunningJob(job) || job.status === 'UNKNOWN'
/** 끝났지만 사용자가 아직 결과 화면을 열지 않은 작업입니다. 확인 여부를 주지 않는 서버 응답은 확인한 것으로 봅니다. */
const isUnseenResult = (job: WatchedJob) => (job.status === 'SUCCEEDED' || job.status === 'FAILED') && job.seen === false

/** 다음에 다시 읽을 간격입니다. 기다릴 작업이 없으면 null입니다. */
export function preparationJobsPollMs(jobs: readonly WatchedJob[]): number | null {
  return jobs.some(isRunningJob) ? preparationJobPollMs : jobs.some(isPendingJob) ? preparationJobSettlePollMs : null
}

export function preparationProgramKey(job: { sourceCode: string; sourceProgramId: string }) {
  return `${job.sourceCode}:${job.sourceProgramId}`
}

function latestBy<Job extends WatchedJob>(jobs: readonly Job[], keyOf: (job: Job) => string | number): Job[] {
  const latest = new Map<string | number, Job>()
  for (const job of jobs) {
    const key = keyOf(job)
    const known = latest.get(key)
    if (!known || known.id < job.id) latest.set(key, job)
  }
  return [...latest.values()]
}

/**
 * 확인하지 않은 결과가 있는 준비 건과 공고입니다. 준비 건·공고마다 가장 최근 작업만 봅니다(그 작업이 카드에 보이는 결과입니다).
 * 분석은 시작한 지 하루가 지나면 카드에서 사라지므로 세지 않습니다. 사이드바 배지와 목록 카드가 같은 기준을 씁니다.
 */
export function unseenPreparationResults(
  analysisJobs: readonly ApplicationFormDiscoveryJob[], documentJobs: readonly ApplicationDocumentGenerationJob[], now: number,
): { preparationIds: number[]; programKeys: string[] } {
  return {
    preparationIds: latestBy(documentJobs, (job) => job.preparationId).filter(isUnseenResult).map((job) => job.preparationId),
    programKeys: latestBy(analysisJobs, preparationProgramKey)
      .filter((job) => isUnseenResult(job) && now - Date.parse(job.createdAt) <= finishedAnalysisWindowMs)
      .map(preparationProgramKey),
  }
}

/** 계정의 최근 분석 · 문서 생성 작업입니다. 읽고 다시 읽는 일은 `PreparationJobsSync`가 맡고, 여기서는 그 사본만 돌려줍니다. */
export function usePreparationJobs() {
  const analysisJobs = useAppSelector(selectPreparationAnalysisJobs)
  const documentJobs = useAppSelector(selectPreparationDocumentJobs)
  const readAt = useAppSelector(selectPreparationJobsReadAt)
  const unseen = useMemo(() => unseenPreparationResults(analysisJobs, documentJobs, readAt), [analysisJobs, documentJobs, readAt])
  return { analysisJobs, documentJobs, readAt, unseen }
}

/** 사이드바 "신청 문서 작성" 배지에 쓰는 확인 전 결과 수입니다. */
export function useUnseenPreparationResultCount(): number {
  const { unseen } = usePreparationJobs()
  return unseen.preparationIds.length + unseen.programKeys.length
}

/**
 * 작업을 새로 시작했거나 결과 화면을 열었을 때 부르는 동작입니다. 확인 표시는 서버에 저장하고(다른 기기에서도 같은 상태),
 * 끝나면 작업 목록을 다시 읽어 배지와 카드에 반영합니다. 표시에 실패해도 화면 사용은 막지 않습니다.
 */
export function usePreparationJobActions() {
  const useCase = appContainer.resolve('applicationPreparationUseCase')
  const dispatch = useAppDispatch()
  const refresh = useCallback(() => { dispatch(preparationJobsRefreshRequested()) }, [dispatch])
  const markDocumentJobsSeen = useCallback((preparationId: number) => {
    void useCase.markDocumentJobsSeen(preparationId).then(refresh).catch(() => undefined)
  }, [refresh, useCase])
  const markAnalysisSeen = useCallback((sourceCode: string, sourceProgramId: string) => {
    void useCase.markDiscoveryJobsSeen(sourceCode, sourceProgramId).then(refresh).catch(() => undefined)
  }, [refresh, useCase])
  return { refresh, markDocumentJobsSeen, markAnalysisSeen }
}
