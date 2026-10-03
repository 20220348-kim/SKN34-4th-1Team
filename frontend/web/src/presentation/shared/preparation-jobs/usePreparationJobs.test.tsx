// @vitest-environment jsdom
import { asValue } from 'awilix/browser'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { appContainer } from '../../../app/appContainer'
import { createAppStore } from '../../../app/store'
import type { ApplicationDocumentGenerationJob, ApplicationFormDiscoveryJob } from '../../../domain/entities/ApplicationPreparation'
import { signedIn } from '../auth/state/authSlice'
import { PreparationJobsSync } from './PreparationJobsSync'
import {
  finishedAnalysisWindowMs,
  preparationJobPollMs,
  unseenPreparationResults,
  usePreparationJobActions,
  useUnseenPreparationResultCount,
} from './usePreparationJobs'

vi.unmock('./PreparationJobsSync')

// 화면은 읽은 시각(실제 현재)으로 "하루 안"을 판정하므로, 작업 시각도 현재 기준으로 둡니다(고정 날짜는 하루가 지나면 깨집니다).
const now = Date.now()
const recent = new Date(now - 60_000).toISOString()

function documentJob(overrides: Partial<ApplicationDocumentGenerationJob>): ApplicationDocumentGenerationJob {
  return { id: 1, preparationId: 10, expectedRevision: 1, status: 'SUCCEEDED', stage: 'SAVING', fileIds: [1], failureCode: null,
    failureMessage: null, mappingMigration: null, createdAt: recent, finishedAt: recent, seen: false, ...overrides }
}

function analysisJob(overrides: Partial<ApplicationFormDiscoveryJob>): ApplicationFormDiscoveryJob {
  return { id: 1, sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', programTitle: '공고', programSourceUrl: null, status: 'SUCCEEDED',
    result: null, failureCode: null, createdAt: recent, seen: false, ...overrides }
}

const useCase = { discoveryJobs: vi.fn(), recentDocumentJobs: vi.fn(), markDocumentJobsSeen: vi.fn(), markDiscoveryJobsSeen: vi.fn() }
const original = appContainer.resolve('applicationPreparationUseCase')

beforeEach(() => {
  appContainer.register({ applicationPreparationUseCase: asValue(useCase as unknown as typeof original) })
  useCase.discoveryJobs.mockResolvedValue([])
  useCase.recentDocumentJobs.mockResolvedValue([])
  useCase.markDocumentJobsSeen.mockResolvedValue(undefined)
  useCase.markDiscoveryJobsSeen.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
  appContainer.register({ applicationPreparationUseCase: asValue(original) })
})

it('counts only the latest finished result that has not been opened, per preparation and per program', () => {
  const unseen = unseenPreparationResults([
    analysisJob({ id: 5, sourceProgramId: 'PBLN_1' }),
    // 같은 공고의 예전 분석은 최신 분석이 가리므로 세지 않습니다.
    analysisJob({ id: 4, sourceProgramId: 'PBLN_2', seen: true }),
    analysisJob({ id: 3, sourceProgramId: 'PBLN_2', status: 'FAILED' }),
    // 진행 중 · 결과 확인 중은 아직 끝난 것이 아닙니다.
    analysisJob({ id: 6, sourceProgramId: 'PBLN_3', status: 'RUNNING' }),
    analysisJob({ id: 7, sourceProgramId: 'PBLN_4', status: 'UNKNOWN' }),
    // 하루가 지난 분석은 카드에서도 사라지므로 세지 않습니다.
    analysisJob({ id: 2, sourceProgramId: 'PBLN_5', createdAt: new Date(now - 2 * finishedAnalysisWindowMs).toISOString() }),
  ], [
    documentJob({ id: 9, preparationId: 10 }),
    documentJob({ id: 8, preparationId: 11, status: 'FAILED', fileIds: [], seen: false }),
    documentJob({ id: 7, preparationId: 12, seen: true }),
    documentJob({ id: 6, preparationId: 13, status: 'RUNNING', stage: 'WRITING', fileIds: [], finishedAt: null }),
    // 확인 여부를 주지 않는 서버 응답은 확인한 것으로 봅니다.
    documentJob({ id: 5, preparationId: 14, seen: undefined }),
  ], now)
  expect(unseen.programKeys).toEqual(['BIZINFO:PBLN_1'])
  expect(unseen.preparationIds.sort()).toEqual([10, 11])
})

function Probe() {
  const count = useUnseenPreparationResultCount()
  const { markDocumentJobsSeen, markAnalysisSeen } = usePreparationJobActions()
  return <>
    <output aria-label="확인 전 결과">{count}</output>
    <button type="button" onClick={() => markDocumentJobsSeen(10)}>초안 확인</button>
    <button type="button" onClick={() => markAnalysisSeen('BIZINFO', 'PBLN_1')}>분석 확인</button>
  </>
}

function mount() {
  const store = createAppStore()
  store.dispatch(signedIn({ email: 'owner@example.com', role: 'USER', tier: 'MEMBER', emailVerified: false, hasPassword: true, accountType: null, onboarded: true, company: null }))
  render(<Provider store={store}><PreparationJobsSync /><Probe /></Provider>)
}

it('reads the account jobs once for the sidebar count and reads again after a result is marked as seen', async () => {
  useCase.discoveryJobs.mockResolvedValueOnce([analysisJob({})]).mockResolvedValue([analysisJob({ seen: true })])
  useCase.recentDocumentJobs.mockResolvedValueOnce([documentJob({})]).mockResolvedValue([documentJob({ seen: true })])
  mount()
  await waitFor(() => expect(screen.getByLabelText('확인 전 결과').textContent).toBe('2'))
  expect(useCase.discoveryJobs).toHaveBeenCalledTimes(1)

  // 확인 표시는 서버에 저장하고, 끝나면 목록을 다시 읽어 수를 맞춥니다.
  await act(async () => { screen.getByRole('button', { name: '초안 확인' }).click() })
  expect(useCase.markDocumentJobsSeen).toHaveBeenCalledWith(10)
  await waitFor(() => expect(screen.getByLabelText('확인 전 결과').textContent).toBe('0'))
  expect(useCase.discoveryJobs).toHaveBeenCalledTimes(2)

  await act(async () => { screen.getByRole('button', { name: '분석 확인' }).click() })
  expect(useCase.markDiscoveryJobsSeen).toHaveBeenCalledWith('BIZINFO', 'PBLN_1')
})

it('keeps reading while a job is running so the count appears when it finishes on another screen', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const running = documentJob({ status: 'RUNNING', stage: 'WRITING', fileIds: [], finishedAt: null })
  useCase.recentDocumentJobs.mockResolvedValueOnce([running]).mockResolvedValue([documentJob({})])
  mount()
  await waitFor(() => expect(useCase.recentDocumentJobs).toHaveBeenCalledTimes(1))
  expect(screen.getByLabelText('확인 전 결과').textContent).toBe('0')
  await act(async () => { await vi.advanceTimersByTimeAsync(preparationJobPollMs) })
  await waitFor(() => expect(screen.getByLabelText('확인 전 결과').textContent).toBe('1'))
})

it('retries a failed first read a few times and then waits for the next request', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  useCase.discoveryJobs.mockRejectedValue(new Error('down'))
  useCase.recentDocumentJobs.mockRejectedValue(new Error('down'))
  mount()
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(useCase.discoveryJobs).toHaveBeenCalledTimes(1)
  // 기다릴 작업이 없을 때의 실패는 세 번까지만 다시 읽습니다.
  await act(async () => { await vi.advanceTimersByTimeAsync(10 * preparationJobPollMs) })
  expect(useCase.discoveryJobs).toHaveBeenCalledTimes(4)

  // 결과 화면을 열거나 작업을 시작해 새로 읽기를 요청하면 다시 읽습니다.
  useCase.discoveryJobs.mockResolvedValue([analysisJob({})])
  useCase.recentDocumentJobs.mockResolvedValue([])
  await act(async () => { screen.getByRole('button', { name: '초안 확인' }).click(); await vi.advanceTimersByTimeAsync(0) })
  expect(screen.getByLabelText('확인 전 결과').textContent).toBe('1')
})

it('stops polling when every read keeps failing so requests do not go out forever', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const running = documentJob({ status: 'RUNNING', stage: 'WRITING', fileIds: [], finishedAt: null })
  useCase.recentDocumentJobs.mockResolvedValueOnce([running]).mockRejectedValue(new Error('expired'))
  useCase.discoveryJobs.mockResolvedValueOnce([]).mockRejectedValue(new Error('expired'))
  mount()
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  await act(async () => { await vi.advanceTimersByTimeAsync(60 * preparationJobPollMs) })
  // 처음 한 번 + 연달아 실패한 열두 번까지만 읽고 멈춥니다.
  expect(useCase.recentDocumentJobs).toHaveBeenCalledTimes(13)
})
