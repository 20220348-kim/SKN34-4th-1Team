// @vitest-environment jsdom
import { asValue } from 'awilix/browser'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appContainer } from '../../../../app/appContainer'
import { createAppStore } from '../../../../app/store'
import { signedIn, signedOut } from '../../../shared/auth/state/authSlice'
import { reviewProgramKey, unknownParticipation, type ReviewProgram } from '../../../../domain/entities/CombinationReview'
import type { SupportProgram } from '../../../../domain/entities/SupportProgram'
import { CombinationReviewError } from '../../../../domain/errors/CombinationReviewError'
import { CombinationReviewUseCase } from '../../../../domain/usecases/CombinationReviewUseCase'
import { CombinationReviewRepositoryImpl } from '../../../../data/repositories/CombinationReviewRepositoryImpl'
import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import { CombinationReviewEditorPage, CombinationReviewListPage, CombinationReviewRunResultPage } from './CombinationReviewPages'
import { reviewFixture, runFixture } from '../testing/reviewFixtures'
import { useReviewSessionIsolation } from '../viewmodel/useReviewSessionIsolation'
import { chooseOption, optionLabels, selectedValue } from '../../../../test/selectField'

const original = appContainer.resolve('combinationReviewUseCase')
const originalCatalog = appContainer.resolve('browseSupportProgramsUseCase')
const originalDetail = appContainer.resolve('getSupportProgramDetailUseCase')
const originalSavedPrograms = appContainer.resolve('browseSavedSupportProgramsUseCase')
const browseSavedPrograms = vi.fn()
const browsePrograms = vi.fn()
const repository = { list: vi.fn(), get: vi.fn(), create: vi.fn(), delete: vi.fn(), replace: vi.fn(), runs: vi.fn(), run: vi.fn(), start: vi.fn(), source: vi.fn() }
/** 검색 결과·관심 공고로 쓰는 공고입니다. 기업마당 숫자형 공고라 자동 분석을 지원합니다. */
function catalogProgram(id: string, overrides: Partial<SupportProgram> = {}): SupportProgram {
  return { ...structuredClone(supportPrograms[0]!), id, ...overrides }
}
function catalogPage(programs: SupportProgram[]) {
  return { programs, total: programs.length, page: 1, pageSize: 10, totalPages: 1, regions: [], categories: [], startupStages: [], applicantTypes: [], founderAges: [] }
}
const savedEntries = (...programs: SupportProgram[]) => programs.map((program) => ({ savedAt: '2026-09-12T10:00:00+09:00', program }))
/** 1단계의 사업 칸(사업 1 · 사업 2)입니다. */
const slot = (number: number) => screen.getByRole('group', { name: `사업 ${number}` })
const nextButton = () => screen.getByRole('button', { name: '다음 →' }) as HTMLButtonElement
const programKeys = (programs: ReviewProgram[]) => programs.map(reviewProgramKey)
beforeEach(() => {
  sessionStorage.clear(); vi.resetAllMocks()
  browsePrograms.mockResolvedValue(catalogPage([]))
  repository.get.mockResolvedValue(structuredClone(reviewFixture))
  repository.runs.mockResolvedValue({ items: [], nextBeforeId: null })
  repository.run.mockResolvedValue(structuredClone(runFixture))
  repository.start.mockImplementation(async (_id, request) => ({
    ...structuredClone(runFixture), inputRevision: request.expectedRevision, requestKey: request.requestKey,
    input: { ...structuredClone(runFixture.input), additionalFacts: request.additionalFacts },
  }))
  repository.list.mockResolvedValue({ items: [], nextBeforeId: null })
  repository.delete.mockResolvedValue(undefined)
  browseSavedPrograms.mockResolvedValue([])
  appContainer.register({
    combinationReviewUseCase: asValue(new CombinationReviewUseCase(repository)),
    browseSupportProgramsUseCase: asValue({ execute: browsePrograms }),
    browseSavedSupportProgramsUseCase: asValue({ execute: browseSavedPrograms }),
    getSupportProgramDetailUseCase: asValue({ execute: vi.fn(async (identity) => ({ ...supportPrograms[0], sourceCode: identity.sourceCode, id: identity.sourceProgramId, title: identity.sourceProgramId === 'PBLN_100' ? '청년창업 사업화 지원 공고' : '딥테크 성장 지원 공고' })) }),
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); appContainer.register({ combinationReviewUseCase: asValue(original), browseSupportProgramsUseCase: asValue(originalCatalog), browseSavedSupportProgramsUseCase: asValue(originalSavedPrograms), getSupportProgramDetailUseCase: asValue(originalDetail) }) })
function Isolation() { useReviewSessionIsolation(); return null }
function LocationProbe() { const location = useLocation(); return <output data-testid="location">{location.pathname + location.search}</output> }
const currentLocation = () => screen.getByTestId('location').textContent
function mount(path = '/app/combination-reviews/12?step=analysis', strict = false) {
  const store = createAppStore()
  store.dispatch(signedIn({ email: 'a@example.com', role: 'USER', tier: 'MEMBER', emailVerified: false, hasPassword: true, accountType: null, onboarded: true, company: null }))
  const screenTree = <Provider store={store}><Isolation /><MemoryRouter initialEntries={[path]}><LocationProbe /><Routes>
    <Route path="/app/combination-reviews" element={<CombinationReviewListPage />} />
    <Route path="/app/combination-reviews/new" element={<CombinationReviewEditorPage create />} />
    <Route path="/app/combination-reviews/:reviewId/runs/:runId" element={<CombinationReviewRunResultPage />} />
    <Route path="/app/combination-reviews/:reviewId" element={<CombinationReviewEditorPage />} />
  </Routes></MemoryRouter></Provider>
  const rendered = render(strict ? <StrictMode>{screenTree}</StrictMode> : screenTree)
  return { store, ...rendered }
}
describe('review screens and execution safety', () => {
  it('shows the review title and both ancestor links on results and navigates back', async () => {
    mount('/app/combination-reviews/12/runs/30')
    expect(await screen.findByRole('heading', { level: 1, name: '검토 결과' })).toBeTruthy()
    const navigation = within(screen.getByRole('navigation', { name: '상위 화면' }))
    await waitFor(() => expect(navigation.getAllByRole('link').map((link) => link.textContent)).toEqual(['중복 지원·수혜 검토', reviewFixture.title]))
    expect(navigation.getByRole('link', { name: '중복 지원·수혜 검토' }).getAttribute('href')).toBe('/app/combination-reviews')
    expect(screen.getByRole('link', { name: '입력 수정' }).getAttribute('href')).toBe('/app/combination-reviews/12?step=participation')
    fireEvent.click(navigation.getByRole('link', { name: reviewFixture.title }))
    expect(await screen.findByRole('region', { name: '분석 실행' })).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: '중복 지원·수혜 검토' }))
    expect(await screen.findByRole('heading', { level: 1, name: '중복 지원·수혜 검토' })).toBeTruthy()
    expect(repository.start).not.toHaveBeenCalled()
  })

  it('clears and changes slots of a saved review in place and starts a newly chosen program from unknown participation', async () => {
    const first = catalogProgram('PBLN_100', { title: '청년창업 사업화 지원 공고' })
    const another = catalogProgram('PBLN_400', { title: '새로 고른 공고' })
    browseSavedPrograms.mockResolvedValue(savedEntries(first, another))
    repository.replace.mockResolvedValue(undefined)
    mount('/app/combination-reviews/12')
    await screen.findByDisplayValue(reviewFixture.title)
    // 저장한 두 공고가 저장 순서대로 사업 1 · 사업 2 칸에 보입니다.
    expect(await within(slot(1)).findByText('청년창업 사업화 지원 공고')).toBeTruthy()
    expect(within(slot(2)).getByText('딥테크 성장 지원 공고')).toBeTruthy()
    expect(screen.getByText('2/2')).toBeTruthy()

    // [빼기]는 그 칸만 비우고 다른 칸의 공고는 제자리에 둡니다. 포커스는 비운 칸의 [공고 고르기]로 옮깁니다.
    fireEvent.click(within(slot(1)).getByRole('button', { name: '사업 1 공고 빼기' }))
    expect(document.activeElement).toBe(within(slot(1)).getByRole('button', { name: '사업 1 공고 고르기' }))
    expect(within(slot(1)).queryByText('청년창업 사업화 지원 공고')).toBeNull()
    expect(within(slot(2)).getByText('딥테크 성장 지원 공고')).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(nextButton().disabled).toBe(true)
    expect(document.getElementById(nextButton().getAttribute('aria-describedby')!)!.textContent).toBe('공고를 2개 고르면 넘어갈 수 있어요 · 지금 1개')

    // [바꾸기]로 연 패널을 Esc로 닫으면 바꾸지 않고 [바꾸기]로 포커스가 돌아옵니다.
    const change = within(slot(2)).getByRole('button', { name: '사업 2 공고 바꾸기' })
    fireEvent.click(change)
    fireEvent.keyDown(screen.getByRole('dialog', { name: '공고 고르기' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '공고 고르기' })).toBeNull()
    expect(document.activeElement).toBe(change)
    expect(within(slot(2)).getByText('딥테크 성장 지원 공고')).toBeTruthy()

    fireEvent.click(change)
    const panel = screen.getByRole('dialog', { name: '공고 고르기' })
    expect(within(panel).getByText('사업 2로 비교할 공고 1개를 골라 주세요')).toBeTruthy()
    fireEvent.click(await within(panel).findByRole('radio', { name: /새로 고른 공고/ }))
    fireEvent.click(within(panel).getByRole('button', { name: '사업 2로 선택' }))
    expect(screen.queryByRole('dialog', { name: '공고 고르기' })).toBeNull()
    expect(within(slot(2)).getByText('새로 고른 공고')).toBeTruthy()
    expect(document.activeElement).toBe(within(slot(2)).getByRole('button', { name: '사업 2 공고 바꾸기' }))

    // 사업 1을 고를 때 사업 2의 공고는 흐리게 두고 고를 수 없습니다.
    fireEvent.click(within(slot(1)).getByRole('button', { name: '사업 1 공고 고르기' }))
    const other = screen.getByRole('dialog', { name: '공고 고르기' })
    const taken = await within(other).findByRole('radio', { name: /새로 고른 공고/ }) as HTMLInputElement
    expect(taken.disabled).toBe(true)
    expect(within(other).getByText('사업 2로 고름')).toBeTruthy()
    fireEvent.click(within(other).getByRole('radio', { name: /청년창업 사업화 지원 공고/ }))
    fireEvent.click(within(other).getByRole('button', { name: '사업 1로 선택' }))
    expect(within(slot(1)).getByText('청년창업 사업화 지원 공고')).toBeTruthy()

    fireEvent.click(nextButton())
    expect(await screen.findAllByText('지금 어디까지 진행했나요?')).toHaveLength(2)
    const saved = repository.replace.mock.calls[0][2]
    expect(programKeys(saved.programs)).toEqual(['BIZINFO:PBLN_100', 'BIZINFO:PBLN_400'])
    // 칸을 바꾼 공고는 저장돼 있던 참여 상태를 이어받지 않고 모름에서 시작합니다.
    expect(saved.programs.map((program: ReviewProgram) => program.participation)).toEqual([unknownParticipation(), unknownParticipation()])
    expect(saved.programs.map((program: ReviewProgram) => program.subProgramId)).toEqual([null, null])
    expect(repository.start).not.toHaveBeenCalled()
  })

  it('shows the name only and the unsupported warning inside a slot whose program detail fails to load', async () => {
    repository.get.mockResolvedValue({ ...structuredClone(reviewFixture), programs: [reviewFixture.programs[0], { ...reviewFixture.programs[1], sourceProgramId: 'R2026-1' }] })
    const detail = vi.mocked(appContainer.resolve('getSupportProgramDetailUseCase').execute)
    const loaded = detail.getMockImplementation()!
    detail.mockImplementation(async (identity, signal) => {
      if (identity.sourceProgramId === 'R2026-1') throw new Error('offline')
      return loaded(identity, signal)
    })
    mount('/app/combination-reviews/12')
    await screen.findByDisplayValue(reviewFixture.title)
    expect(within(slot(2)).getByText('공고 정보를 불러오지 못함')).toBeTruthy()
    expect(within(slot(2)).queryByText('접수 중')).toBeNull()
    expect(within(slot(2)).getByText('현재 자동 분석을 지원하지 않는 공고입니다.')).toBeTruthy()
    expect(within(slot(2)).getByRole('button', { name: '사업 2 공고 바꾸기' })).toBeTruthy()
    // 읽은 공고는 신청 문서의 고른 공고 카드처럼 접수 상태 · 출처 배지와 기관 · 접수 기간을 보입니다.
    expect(within(slot(1)).getByText('청년창업 사업화 지원 공고')).toBeTruthy()
    expect(within(slot(1)).getByText('접수 중')).toBeTruthy()
    expect(within(slot(1)).getByText('기업마당')).toBeTruthy()
    expect(within(slot(1)).getByText(`${supportPrograms[0]!.organization} · 접수 ${supportPrograms[0]!.applicationPeriod}`)).toBeTruthy()
    expect(within(slot(1)).queryByText('현재 자동 분석을 지원하지 않는 공고입니다.')).toBeNull()
    expect(within(slot(1)).getByRole('link', { name: /공고 상세/ }).getAttribute('href')).toBe('/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN_100')
    expect(screen.getByText(/선택한 공고는 현재 자동 분석을 지원하지 않습니다/)).toBeTruthy()
  })

  it('submits once then polls queued and running work until completion without another POST', async () => {
    vi.useFakeTimers()
    // 현재 입력 버전(2)으로 접수한 실행입니다.
    const queued = { ...runFixture, inputRevision: 2, status: 'QUEUED', analysis: null, evidence: null, configuration: null, finishedAt: null }
    repository.start.mockImplementation(async (_id, request) => ({ ...queued, requestKey: request.requestKey }))
    repository.run.mockResolvedValueOnce({ ...queued, status: 'RUNNING' }).mockResolvedValue({ ...runFixture, inputRevision: 2 })
    await act(async () => { mount() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '검토 실행' })) })
    expect(screen.getByRole('link', { name: /#30 · 입력 버전 2 · 대기 중/ })).toBeTruthy()
    expect(screen.getByText('분석 차례를 기다리고 있어요')).toBeTruthy()
    expect(screen.queryByText(/응답을 확인하지 못한 분석 요청/)).toBeNull()
    // 진행 중에는 주 버튼이 상태를 보이며 잠기고, 누를 수 없는 이유를 버튼에 연결합니다.
    const waiting = screen.getByRole('button', { name: '차례 기다리는 중…' }) as HTMLButtonElement
    expect(waiting.disabled).toBe(true)
    expect(document.getElementById(waiting.getAttribute('aria-describedby')!)!.textContent).toBe('분석이 끝나면 다시 실행할 수 있어요')
    expect(within(screen.getByRole('region', { name: '분석 진행' })).getByText(/초 지남$/)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByRole('link', { name: /#30 · 입력 버전 2 · 분석 중/ })).toBeTruthy()
    expect(screen.getByText('공식 문서를 읽고 단계별로 판단하고 있어요')).toBeTruthy()
    expect((screen.getByRole('button', { name: '분석 중…' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByRole('link', { name: /#30 · 입력 버전 2 · 분석 완료/ })).toBeTruthy()
    // 끝나면 진행 카드 대신 최근 결과 카드가 보이고, 현재 입력의 결과이므로 [결과 보기]가 주 동작이 됩니다.
    expect(screen.queryByRole('region', { name: '분석 진행' })).toBeNull()
    expect(within(screen.getByRole('region', { name: '최근 실행' })).getByText('최근 분석이 끝났어요')).toBeTruthy()
    expect(screen.getByRole('link', { name: '결과 보기 →' }).getAttribute('href')).toBe('/app/combination-reviews/12/runs/30')
    expect((screen.getByRole('button', { name: '다시 실행' }) as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(repository.run).toHaveBeenCalledTimes(2)
    expect(repository.start).toHaveBeenCalledTimes(1)
  })
  it('resumes status checks from persisted history after reopening and stops on logout', async () => {
    vi.useFakeTimers()
    const queued = { ...runFixture, status: 'QUEUED', analysis: null, finishedAt: null }
    repository.runs.mockResolvedValue({ items: [queued], nextBeforeId: null })
    repository.run.mockResolvedValue(queued)
    let mounted!: ReturnType<typeof mount>
    await act(async () => { mounted = mount() })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByRole('link', { name: /#30 · 입력 버전 1 · 대기 중/ })).toBeTruthy()
    expect(repository.run).toHaveBeenCalledTimes(1)
    expect(repository.start).not.toHaveBeenCalled()
    act(() => mounted.store.dispatch(signedOut()))
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(repository.run).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('region', { name: '실행 30 결과' })).toBeNull()
  })
  it('pauses failed polling until the user checks the saved run again', async () => {
    vi.useFakeTimers()
    repository.runs.mockResolvedValue({ items: [{ ...runFixture, status: 'QUEUED', analysis: null }], nextBeforeId: null })
    repository.run.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue(runFixture)
    await act(async () => { mount() })
    await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
    expect(repository.run).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/상태 자동 조회가 멈췄어요/)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: /#30 · 입력 버전/ })) })
    expect(screen.getByRole('region', { name: '실행 30 결과' })).toBeTruthy()
    expect(repository.start).not.toHaveBeenCalled()
  })
  it('blocks a new analysis for an unknown outcome without polling or resubmitting', async () => {
    vi.useFakeTimers()
    repository.runs.mockResolvedValue({ items: [{ ...runFixture, status: 'UNKNOWN', analysis: null }], nextBeforeId: null })
    repository.run.mockResolvedValue({ ...runFixture, status: 'UNKNOWN', analysis: null, failureCode: 'RUN_OUTCOME_UNKNOWN' })
    await act(async () => { mount() })
    expect(screen.getByText(/완료 여부를 확인할 수 없는 실행/)).toBeTruthy()
    expect((screen.getByRole('button', { name: '검토 실행' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(repository.run).not.toHaveBeenCalled()
    expect(repository.start).not.toHaveBeenCalled()
  })
  it('fills two empty slots from the saved list and the full search of the shared picker panel', async () => {
    const saved = catalogProgram('PBLN_301', { title: '관심 공고 하나' })
    const closed = catalogProgram('PBLN_302', { title: '접수 끝난 공고', status: 'CLOSED' })
    const unsupported = catalogProgram('R2026-9', { title: '자동 분석 미지원 공고' })
    browseSavedPrograms.mockResolvedValue(savedEntries(saved))
    browsePrograms.mockResolvedValue(catalogPage([saved, closed, unsupported]))
    repository.create.mockResolvedValue(structuredClone(reviewFixture))
    mount('/app/combination-reviews/new')

    // 빈 칸 두 개로 시작하고, 관심 공고는 패널을 열 때 읽습니다.
    const programs = screen.getByRole('region', { name: '비교할 공고' })
    expect(within(programs).getByText('0/2')).toBeTruthy()
    expect(within(programs).getByText('공고 두 개를 골라 주세요. 접수가 끝난 공고도 참여 이력 검토에 쓸 수 있어요.')).toBeTruthy()
    expect(within(slot(1)).getByText('비교할 공고를 아직 고르지 않았어요')).toBeTruthy()
    expect(within(slot(2)).getByRole('button', { name: '사업 2 공고 고르기' })).toBeTruthy()
    expect(browseSavedPrograms).not.toHaveBeenCalled()
    expect(nextButton().disabled).toBe(true)

    const pickFirst = within(slot(1)).getByRole('button', { name: '사업 1 공고 고르기' })
    fireEvent.click(pickFirst)
    const panel = screen.getByRole('dialog', { name: '공고 고르기' })
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(within(panel).getByText('사업 1로 비교할 공고 1개를 골라 주세요')).toBeTruthy()
    expect(document.activeElement).toBe(within(panel).getByRole('tab', { name: '관심 공고함' }))
    const confirmFirst = within(panel).getByRole('button', { name: '사업 1로 선택' }) as HTMLButtonElement
    expect(confirmFirst.disabled).toBe(true)
    // 고르기만 하면 바로 확정할 수 있습니다(신청 문서와 달리 양식 조회가 없음).
    fireEvent.click(await within(panel).findByRole('radio', { name: /관심 공고 하나/ }))
    expect(confirmFirst.disabled).toBe(false)
    fireEvent.click(confirmFirst)
    expect(screen.queryByRole('dialog', { name: '공고 고르기' })).toBeNull()
    expect(within(slot(1)).getByText('관심 공고 하나')).toBeTruthy()
    expect(within(slot(1)).getByText('기업마당')).toBeTruthy()
    expect(within(slot(1)).getByRole('link', { name: /공고 상세/ }).getAttribute('href')).toBe('/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN_301')
    expect(document.activeElement).toBe(within(slot(1)).getByRole('button', { name: '사업 1 공고 바꾸기' }))
    expect(within(programs).getByText('1/2')).toBeTruthy()

    fireEvent.click(within(slot(2)).getByRole('button', { name: '사업 2 공고 고르기' }))
    const second = screen.getByRole('dialog', { name: '공고 고르기' })
    expect(within(second).getByText('사업 2로 비교할 공고 1개를 골라 주세요')).toBeTruthy()
    // 사업 1에서 고른 공고는 흐리게 두고 고를 수 없습니다.
    expect((await within(second).findByRole('radio', { name: /관심 공고 하나/ }) as HTMLInputElement).disabled).toBe(true)
    expect(within(second).getByText('사업 1로 고름')).toBeTruthy()
    fireEvent.click(within(second).getByRole('tab', { name: '전체 검색' }))
    // 전체 검색은 접수가 끝난 공고도 보이도록 접수 상태 "전체"로 찾습니다.
    const closedRadio = await within(second).findByRole('radio', { name: /접수 끝난 공고/ })
    expect(browsePrograms).toHaveBeenCalledOnce()
    expect(browsePrograms.mock.calls[0][0]).toMatchObject({ keyword: '', status: 'ALL', page: 1 })
    expect((within(second).getByRole('radio', { name: /관심 공고 하나/ }) as HTMLInputElement).disabled).toBe(true)
    // 자동 분석을 지원하지 않는 공고는 행 아래에 알립니다.
    const unsupportedRow = within(second).getByRole('radio', { name: /자동 분석 미지원 공고/ }).closest('label')!.parentElement!
    expect(unsupportedRow.textContent).toContain('현재 자동 분석을 지원하지 않는 공고입니다.')
    expect(closedRadio.closest('label')!.parentElement!.textContent).not.toContain('현재 자동 분석을 지원하지 않는 공고입니다.')
    fireEvent.click(closedRadio)
    fireEvent.click(within(second).getByRole('button', { name: '사업 2로 선택' }))
    expect(within(slot(2)).getByText('접수 끝난 공고')).toBeTruthy()
    expect(within(slot(2)).getByText('접수 마감')).toBeTruthy()
    expect(within(programs).getByText('2/2')).toBeTruthy()

    // 제목과 두 칸이 모두 있어야 넘어갈 수 있습니다.
    expect(nextButton().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('검토 제목'), { target: { value: '두 공고 검토' } })
    expect(nextButton().disabled).toBe(false)
    fireEvent.click(nextButton())
    await waitFor(() => expect(repository.create).toHaveBeenCalledOnce())
    expect(repository.create.mock.calls[0][0].programs).toEqual([
      { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_301', subProgramId: null, participation: unknownParticipation() },
      { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_302', subProgramId: null, participation: unknownParticipation() },
    ])
    expect(repository.start).not.toHaveBeenCalled()
  })

  it('starts a review opened from a program detail with that program already in slot 1', async () => {
    const other = catalogProgram('PBLN_500', { title: '다른 관심 공고' })
    browseSavedPrograms.mockResolvedValue(savedEntries(other))
    repository.create.mockResolvedValue(structuredClone(reviewFixture))
    mount('/app/combination-reviews/new?sourceCode=BIZINFO&sourceProgramId=PBLN_100')

    expect(await within(slot(1)).findByText('청년창업 사업화 지원 공고')).toBeTruthy()
    expect(within(slot(1)).getByText(`${supportPrograms[0]!.organization} · 접수 ${supportPrograms[0]!.applicationPeriod}`)).toBeTruthy()
    expect(within(slot(2)).getByRole('button', { name: '사업 2 공고 고르기' })).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()
    // 미리 고르기는 공고 상세만 조회하고 검토를 만들거나 분석을 보내지 않습니다.
    expect(repository.create).not.toHaveBeenCalled()
    expect(repository.start).not.toHaveBeenCalled()

    fireEvent.click(within(slot(2)).getByRole('button', { name: '사업 2 공고 고르기' }))
    const panel = screen.getByRole('dialog', { name: '공고 고르기' })
    fireEvent.click(await within(panel).findByRole('radio', { name: /다른 관심 공고/ }))
    fireEvent.click(within(panel).getByRole('button', { name: '사업 2로 선택' }))
    fireEvent.change(screen.getByLabelText('검토 제목'), { target: { value: '상세에서 시작한 검토' } })
    fireEvent.click(nextButton())

    await waitFor(() => expect(repository.create).toHaveBeenCalledOnce())
    expect(programKeys(repository.create.mock.calls[0][0].programs)).toEqual(['BIZINFO:PBLN_100', 'BIZINFO:PBLN_500'])
  })

  it.each(['?sourceCode=bizinfo&sourceProgramId=PBLN_100', '?sourceCode=BIZINFO&sourceProgramId=%20', '?sourceProgramId=PBLN_100'])(
    'starts a new review without a preselected program for an invalid address %s', (search) => {
      mount(`/app/combination-reviews/new${search}`)
      expect(screen.getByText('0/2')).toBeTruthy()
      expect(within(slot(1)).getByRole('button', { name: '사업 1 공고 고르기' })).toBeTruthy()
      expect(within(slot(2)).getByRole('button', { name: '사업 2 공고 고르기' })).toBeTruthy()
    })

  it.each([201, 404])('handles new review save HTTP %s through the production adapter', async (status) => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (_url.includes('/catalog')) return Response.json({ programs: supportPrograms.slice(0, 2).map((program, index) => ({ ...program, id: `PBLN_${index + 100}`, recommendationScore: null, eligibilityReview: null, matchedReasons: [] })), total: 2, page: 1, pageSize: 10, totalPages: 1, regions: [], categories: [], startupStages: [], applicantTypes: [], founderAges: [] })
      if (init?.method === 'POST' && _url.endsWith('/runs')) {
        const request = JSON.parse(String(init.body))
        return Response.json({ ...runFixture, inputRevision: request.expectedRevision, requestKey: request.requestKey, input: { ...runFixture.input, title: reviewFixture.title, programs: reviewFixture.programs, additionalFacts: request.additionalFacts } })
      }
      if (init?.method === 'POST') return Response.json(status === 201 ? reviewFixture : { status: 404, error: 'Not Found' }, { status })
      return Response.json(_url.includes('/runs') ? { items: [], nextBeforeId: null } : reviewFixture)
    })
    vi.stubGlobal('fetch', fetch)
    appContainer.register({
      combinationReviewUseCase: asValue(new CombinationReviewUseCase(new CombinationReviewRepositoryImpl())),
      browseSupportProgramsUseCase: asValue(originalCatalog),
    })
    mount('/app/combination-reviews/new')
    fireEvent.change(screen.getByLabelText('검토 제목'), { target: { value: reviewFixture.title } })
    // 관심 공고함이 비어 있으면 패널이 전체 검색으로 열립니다. 사업 2에서는 사업 1의 공고를 고를 수 없어 다음 공고를 고릅니다.
    for (const number of [1, 2]) {
      fireEvent.click(within(slot(number)).getByRole('button', { name: `사업 ${number} 공고 고르기` }))
      const panel = screen.getByRole('dialog', { name: '공고 고르기' })
      const choices = await within(panel).findAllByRole('radio')
      fireEvent.click(choices.find((choice) => !(choice as HTMLInputElement).disabled)!)
      fireEvent.click(within(panel).getByRole('button', { name: `사업 ${number}로 선택` }))
    }
    expect(screen.getByText('2/2')).toBeTruthy()
    expect(within(slot(1)).getByText(supportPrograms[0]!.title)).toBeTruthy()
    expect(within(slot(2)).getByText(supportPrograms[1]!.title)).toBeTruthy()
    // 패널을 열 때마다 카탈로그를 접수 상태 "전체"로 한 번 찾습니다(접수 마감 공고도 고를 수 있음).
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [url] of fetch.mock.calls) {
      expect(new URL(url).pathname).toMatch(/\/catalog$/)
      expect(new URL(url).searchParams.get('status')).toBe('ALL')
    }
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    if (status === 201) {
      // 새 검토는 1단계 [다음]에서 만들어지고, 참여 상태 단계로 넘어갈 뿐 분석은 보내지 않는다.
      expect(await screen.findAllByText('지금 어디까지 진행했나요?')).toHaveLength(2)
      expect(screen.getByRole('heading', { level: 1, name: reviewFixture.title })).toBeTruthy()
    } else {
      expect((await screen.findByRole('alert')).textContent).toContain('Core API 실행 버전')
      expect(screen.getByDisplayValue(reviewFixture.title)).toBeTruthy()
      expect(screen.getByRole('heading', { level: 1, name: '새 검토' })).toBeTruthy()
    }
    // 모든 폭에서 아래에 붙는 단계 바는 도우미 런처를 그 위로 올립니다.
    expect(document.querySelector('[data-assistant-lift="always"]')?.textContent).toContain('다음')
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0][0]).toMatch(/\/api\/v1\/combination-reviews$/)
  })
  it('saves a changed input on the step change and starts analysis only from the analysis step', async () => {
    repository.replace.mockResolvedValue(undefined)
    mount('/app/combination-reviews/12'); await screen.findByDisplayValue(reviewFixture.title)
    fireEvent.change(screen.getByLabelText('검토 제목'), { target: { value: '수정된 제목' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(await screen.findAllByText('지금 어디까지 진행했나요?')).toHaveLength(2)
    expect(repository.replace).toHaveBeenCalledWith(12, 2, expect.objectContaining({ title: '수정된 제목' }), expect.any(AbortSignal))
    expect(screen.getAllByText('자동 저장됨').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(await screen.findByRole('region', { name: '분석 실행' })).toBeTruthy()
    expect(repository.replace).toHaveBeenCalledTimes(1)
    expect(repository.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '검토 실행' }))
    await screen.findByText(/저장된 실행을 확인했습니다/)
    expect(repository.get).toHaveBeenCalledTimes(1)
    expect(repository.start).toHaveBeenCalledWith(12, expect.objectContaining({ expectedRevision: 3 }), expect.any(AbortSignal))
  })
  it('saves a changed participation status before showing the analysis step', async () => {
    repository.replace.mockResolvedValue(undefined)
    mount('/app/combination-reviews/12?step=participation'); await screen.findAllByText('지금 어디까지 진행했나요?')
    chooseOption(screen.getByLabelText('사업 2 현재 진행 상태'), 'COMMITMENT')
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(await screen.findByRole('region', { name: '분석 실행' })).toBeTruthy()
    const saved = repository.replace.mock.calls[0][2]
    expect(saved.programs[1].participation.commitmentSubmitted).toBe('YES')
    expect(repository.start).not.toHaveBeenCalled()
  })
  it('focuses the server version error and preserves edited inputs', async () => {
    repository.replace.mockRejectedValue(new CombinationReviewError(404, 'COMBINATION_REVIEW_API_UNAVAILABLE'))
    mount('/app/combination-reviews/12'); await screen.findByDisplayValue(reviewFixture.title)
    fireEvent.change(screen.getByLabelText('검토 제목'), { target: { value: '보존할 입력' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Core API 실행 버전')
    // 포커스 이동은 렌더 뒤 effect에서 일어나므로 느린 환경(CI)에서도 기다립니다.
    await waitFor(() => expect(document.activeElement).toBe(alert))
    expect(screen.getByDisplayValue('보존할 입력')).toBeTruthy()
  })
  it('clears a selection-step validation error after the corrected input advances', async () => {
    mount('/app/combination-reviews/12'); await screen.findByDisplayValue(reviewFixture.title)
    fireEvent.change(screen.getByLabelText('검토 제목'), { target: { value: '' } })
    const next = screen.getByRole('button', { name: '다음 →' }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
    expect(document.getElementById(next.getAttribute('aria-describedby')!)!.textContent).toBe('검토 제목을 입력하면 넘어갈 수 있어요')
    fireEvent.change(screen.getByLabelText('검토 제목'), { target: { value: '제목' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect((await screen.findByRole('alert')).textContent).toContain('제목은 제어문자 없이 1~200자로 입력해 주세요.')
    expect(repository.replace).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('검토 제목'), { target: { value: '수정한 검토 제목' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))

    expect(await screen.findAllByText('지금 어디까지 진행했나요?')).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('keeps the step in the address so going back and reopening show the same step', async () => {
    mount('/app/combination-reviews/12'); await screen.findByDisplayValue(reviewFixture.title)
    expect(currentLocation()).toBe('/app/combination-reviews/12')
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    await screen.findAllByText('지금 어디까지 진행했나요?')
    expect(currentLocation()).toBe('/app/combination-reviews/12?step=participation')
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    await screen.findByRole('region', { name: '분석 실행' })
    expect(currentLocation()).toBe('/app/combination-reviews/12?step=analysis')
    fireEvent.click(screen.getByRole('button', { name: '← 이전' }))
    await screen.findAllByText('지금 어디까지 진행했나요?')
    fireEvent.click(screen.getByRole('button', { name: '← 이전' }))
    await screen.findByDisplayValue(reviewFixture.title)
    expect(currentLocation()).toBe('/app/combination-reviews/12')
    cleanup()
    mount('/app/combination-reviews/12?step=participation')
    expect(await screen.findAllByText('지금 어디까지 진행했나요?')).toHaveLength(2)
    expect(repository.replace).not.toHaveBeenCalled()
  })
  it('shows the latest run state of each review on the list and routes each action to the matching screen', async () => {
    const run = (id: number, status: string, inputRevision = 2) => ({ id, inputRevision, status, failureCode: status === 'FAILED' ? 'SOURCE_UNSUPPORTED' : null, startedAt: new Date(Date.now() - 125_000).toISOString(), finishedAt: ['QUEUED', 'RUNNING'].includes(status) ? null : '2026-09-09T10:05:00+09:00' })
    const item = (id: number, title: string, latestRun: unknown) => ({ id, title, inputRevision: 2, createdAt: reviewFixture.createdAt, updatedAt: reviewFixture.updatedAt, latestRun })
    repository.list.mockResolvedValue({ items: [
      item(15, '진행 중인 검토', run(50, 'RUNNING')), item(14, '끝난 검토', run(40, 'SUCCEEDED')),
      item(13, '지난 입력 검토', run(35, 'SUCCEEDED', 1)), item(12, '실패한 검토', run(30, 'FAILED')),
    ], nextBeforeId: null })
    mount('/app/combination-reviews')
    const cards = within(await screen.findByRole('list', { name: '저장한 검토' })).getAllByRole('listitem')
    expect(within(cards[0]!).getByText('분석 중')).toBeTruthy()
    expect(within(cards[0]!).getByText(/2분 지남/)).toBeTruthy()
    expect(within(cards[0]!).getByRole('link', { name: '진행 보기: 진행 중인 검토' }).getAttribute('href')).toBe('/app/combination-reviews/15?step=analysis')
    fireEvent.click(within(cards[0]!).getByRole('button', { name: '검토 메뉴: 진행 중인 검토' }))
    expect((within(screen.getByRole('menu', { name: '검토 메뉴' })).getByRole('menuitem', { name: '삭제' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(cards[1]!).getByText('분석 완료')).toBeTruthy()
    expect(within(cards[1]!).getByRole('link', { name: '결과 보기: 끝난 검토' }).getAttribute('href')).toBe('/app/combination-reviews/14/runs/40')
    expect(within(cards[2]!).getByText(/입력을 바꾼 뒤에는 아직 실행하지 않았어요/)).toBeTruthy()
    expect(within(cards[3]!).getByText('분석 실패')).toBeTruthy()
    expect(within(cards[3]!).getByRole('link', { name: '자세히 보기: 실패한 검토' }).getAttribute('href')).toBe('/app/combination-reviews/12/runs/30')
  })
  it('refreshes only running reviews on the list until they finish', async () => {
    vi.useFakeTimers()
    const running = { id: 50, inputRevision: 2, status: 'RUNNING', failureCode: null, startedAt: new Date().toISOString(), finishedAt: null }
    repository.list.mockResolvedValue({ items: [
      { id: 15, title: '진행 중인 검토', inputRevision: 2, createdAt: reviewFixture.createdAt, updatedAt: reviewFixture.updatedAt, latestRun: running },
      { id: 14, title: '실행 전 검토', inputRevision: 1, createdAt: reviewFixture.createdAt, updatedAt: reviewFixture.updatedAt, latestRun: null },
    ], nextBeforeId: null })
    repository.runs.mockResolvedValueOnce({ items: [running], nextBeforeId: null })
      .mockResolvedValue({ items: [{ ...running, status: 'SUCCEEDED', finishedAt: new Date().toISOString() }], nextBeforeId: null })
    await act(async () => { mount('/app/combination-reviews') })
    expect(screen.getByText('분석 중')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(repository.runs).toHaveBeenCalledTimes(1)
    expect(repository.runs.mock.calls[0][0]).toBe(15)
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(screen.getByText('분석 완료')).toBeTruthy()
    expect(screen.getByRole('link', { name: '결과 보기: 진행 중인 검토' }).getAttribute('href')).toBe('/app/combination-reviews/15/runs/50')
    await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
    expect(repository.runs).toHaveBeenCalledTimes(2)
    expect(repository.list).toHaveBeenCalledTimes(1)
  })
  it('mounts with GET only and renders empty list', async () => {
    mount('/app/combination-reviews')
    await screen.findByText('아직 저장한 검토가 없어요')
    // 목록 위 안내 문구는 두지 않습니다. 검토 범위 안내는 새 검토 화면에만 있습니다.
    expect(screen.queryByText(/저장한 검토와 실행 기록은 본인만 볼 수 있어요/)).toBeNull()
    expect(screen.queryByText(/두 공고를 함께 신청 · 선정 · 수행할 수 있는지 봐요/)).toBeNull()
    expect(screen.getAllByRole('link', { name: '새 검토' }).every((link) => link.getAttribute('href') === '/app/combination-reviews/new')).toBe(true)
    expect(repository.create).not.toHaveBeenCalled(); expect(repository.start).not.toHaveBeenCalled()
  })
  it('appends cursor pages', async () => {
    repository.list.mockResolvedValueOnce({ items: [reviewFixture], nextBeforeId: 12 }).mockResolvedValueOnce({ items: [{ ...reviewFixture, id: 11, title: '이전 검토' }], nextBeforeId: null })
    mount('/app/combination-reviews')
    fireEvent.click(await screen.findByRole('button', { name: '더 보기' }))
    await screen.findByText('이전 검토')
    expect(repository.list.mock.calls[1][0]).toBe(12)
    expect(screen.getByText(reviewFixture.title)).toBeTruthy()
    expect(screen.getAllByText('2026년 9월 9일 오전 10:00 수정')).toHaveLength(2)
    expect(screen.queryByText(/2026-09-09T10:00:00/)).toBeNull()
    // 실행 전인 검토는 "실행 전" 배지와 [이어서 입력]으로 입력 화면에 갑니다.
    const resume = screen.getAllByRole('link', { name: /^이어서 입력/ })
    expect(resume).toHaveLength(2)
    expect(resume[0].getAttribute('href')).toBe('/app/combination-reviews/12')
    expect(screen.getAllByText('실행 전')).toHaveLength(2)
  })
  it('deletes a review only after explicit confirmation and removes it from the list', async () => {
    repository.list.mockResolvedValue({ items: [reviewFixture], nextBeforeId: null })
    mount('/app/combination-reviews')
    fireEvent.click(await screen.findByRole('button', { name: `검토 메뉴: ${reviewFixture.title}` }))
    const menu = screen.getByRole('menu', { name: '검토 메뉴' })
    expect(within(menu).getByRole('menuitem', { name: '입력 수정' }).getAttribute('href')).toBe('/app/combination-reviews/12')
    fireEvent.click(within(menu).getByRole('menuitem', { name: '삭제' }))
    const dialog = screen.getByRole('dialog', { name: '검토를 삭제할까요?' })
    expect(repository.delete).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '삭제' }))
    await screen.findByText('아직 저장한 검토가 없어요')
    expect(screen.getByText('검토를 삭제했어요')).toBeTruthy()
    expect(repository.delete).toHaveBeenCalledWith(reviewFixture.id, expect.any(AbortSignal))
  })
  it.each(['QUEUED', 'RUNNING', 'UNKNOWN'])('blocks list deletion while the latest run is %s', async (status) => {
    repository.list.mockResolvedValue({ items: [{ ...reviewFixture, latestRun: { ...runFixture, status } }], nextBeforeId: null })
    mount('/app/combination-reviews')
    fireEvent.click(await screen.findByRole('button', { name: `검토 메뉴: ${reviewFixture.title}` }))
    const button = within(screen.getByRole('menu', { name: '검토 메뉴' })).getByRole('menuitem', { name: '삭제' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(screen.queryByRole('dialog', { name: '검토를 삭제할까요?' })).toBeNull()
    expect(repository.delete).not.toHaveBeenCalled()
  })
  it('shows a raced deletion conflict inside the confirmation dialog and retains the review', async () => {
    repository.list.mockResolvedValue({ items: [reviewFixture], nextBeforeId: null })
    repository.delete.mockRejectedValue(new CombinationReviewError(409, 'COMBINATION_REVIEW_DELETE_CONFLICT'))
    mount('/app/combination-reviews')
    fireEvent.click(await screen.findByRole('button', { name: `검토 메뉴: ${reviewFixture.title}` }))
    fireEvent.click(within(screen.getByRole('menu', { name: '검토 메뉴' })).getByRole('menuitem', { name: '삭제' }))
    const dialog = screen.getByRole('dialog', { name: '검토를 삭제할까요?' })
    fireEvent.click(within(dialog).getByRole('button', { name: '삭제' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('검토를 삭제할 수 없습니다')
    expect(screen.getByRole('list', { name: '저장한 검토' }).textContent).toContain(reviewFixture.title)
    expect(screen.queryByText('검토를 삭제했어요')).toBeNull()
    expect(repository.delete).toHaveBeenCalledTimes(1)
    expect(repository.start).not.toHaveBeenCalled()
  })
  it('preserves form on 409 without rendering latest saved input controls', async () => {
    repository.replace.mockRejectedValue(new CombinationReviewError(409, 'COMBINATION_REVIEW_REVISION_CONFLICT'))
    mount('/app/combination-reviews/12'); await screen.findByDisplayValue(reviewFixture.title)
    fireEvent.change(screen.getByLabelText('검토 제목'), { target: { value: '내 편집 내용' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    await screen.findByRole('alert')
    expect(repository.replace.mock.calls[0][1]).toBe(2)
    expect(screen.queryByText('최신 저장 입력 확인')).toBeNull()
    expect(screen.queryByText('최신 입력 조회')).toBeNull()
    expect(screen.getByDisplayValue('내 편집 내용')).toBeTruthy()
    expect(repository.replace).toHaveBeenCalledTimes(1)
  })
  it('retains one logical request after response loss and across remount, with no automatic POST', async () => {
    repository.start.mockRejectedValueOnce(new TypeError('network lost')).mockImplementation(async (_id, request) => ({ ...runFixture, requestKey: request.requestKey }))
    const view = mount(); await screen.findByRole('button', { name: '검토 실행' })
    fireEvent.click(screen.getByRole('button', { name: '← 이전' }))
    fireEvent.change(screen.getByLabelText('분석에 참고할 추가 설명 (선택)'), { target: { value: '한 번만 전달할 설명' } })
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    const button = screen.getByRole('button', { name: '검토 실행' }); fireEvent.click(button); fireEvent.click(button)
    await screen.findByRole('alert')
    expect(repository.start).toHaveBeenCalledTimes(1)
    const input = repository.start.mock.calls[0][1]
    expect(input.additionalFacts).toBe('한 번만 전달할 설명')
    view.unmount(); mount(); await screen.findByText(/응답을 확인하지 못한 분석 요청/)
    expect(repository.start).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '검토 실행' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    await screen.findByRole('link', { name: /#30 · 입력 버전 1 · 분석 완료/ })
    expect(repository.start.mock.calls[1][1]).toEqual(input)
  })
  it.each([
    ['KSTARTUP', '177911'],
    ['MSIT', '3186573'],
    ['CNTRADE_NOTICE', '3862'],
  ])('allows automatic analysis when a selected program is an official numeric %s notice', async (sourceCode, sourceProgramId) => {
    repository.get.mockResolvedValue({
      ...structuredClone(reviewFixture),
      programs: [
        reviewFixture.programs[0],
        { ...reviewFixture.programs[1], sourceCode, sourceProgramId },
      ],
    })

    mount()

    const button = await screen.findByRole('button', { name: '검토 실행' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(screen.queryByText(/자동 분석은 지원하지 않습니다/)).toBeNull()
  })
  it.each([422, 429, 503])('shows %s as technical error with saved failed run', async (status) => {
    const failedRun = { ...runFixture, status: 'FAILED' as const, analysis: null, failureCode: 'SOURCE_UNSUPPORTED' }
    repository.start.mockRejectedValue(new CombinationReviewError(status, 'SOURCE_UNSUPPORTED', 30))
    repository.run.mockResolvedValue(failedRun)
    repository.runs.mockResolvedValue({ items: [failedRun], nextBeforeId: null })
    mount(); await screen.findByRole('button', { name: '다시 실행' })
    expect(within(screen.getByRole('region', { name: '최근 실행' })).getByRole('link', { name: /자세히 보기/ }).getAttribute('href')).toBe('/app/combination-reviews/12/runs/30')
    fireEvent.click(screen.getByRole('button', { name: '다시 실행' }))
    fireEvent.click(await screen.findByText('실패 실행 #30 확인'))
    await screen.findByText(/공식 첨부 문서를 자동으로 읽을 수 없어 분석해 드릴 수 없습니다/)
    expect(optionLabels(screen.getByLabelText('실행 결과 선택')).some((label) => /실행 #30 · 분석 실패/.test(label))).toBe(true)
    expect(screen.queryByText(/SOURCE_UNSUPPORTED/)).toBeNull()
    expect(screen.queryByText(/기술 실패/)).toBeNull()
    expect(screen.queryByText('공식 근거 부족')).toBeNull()
  })
  it.each([
    ['SOURCE_NOT_FOUND', '공식 원문 또는 첨부 문서를 찾을 수 없어'],
    ['SOURCE_UNAVAILABLE', '공식 공고 제공처에 일시적으로 연결할 수 없어'],
    ['SOURCE_INVALID', '공식 원문 또는 첨부 문서를 정상적으로 확인할 수 없어'],
    ['SOURCE_TOO_LARGE', '공식 첨부 문서의 수나 분량이 자동 분석 한도를 초과해'],
    ['ANALYSIS_UNAVAILABLE', '분석 서비스에 일시적으로 연결할 수 없어'],
    ['ANALYSIS_INVALID', '분석 결과를 안전하게 확인할 수 없어'],
    ['RUN_FAILED', '분석 처리 중 일시적인 시스템 오류가 발생해'],
    ['QUEUE_EXPIRED', '분석 요청이 대기 시간 안에 처리되지 않아'],
    ['ACCOUNT_INACTIVE', '계정 상태가 변경되어 분석을 진행할 수 없습니다'],
  ])('explains the saved %s failure without exposing its internal code', async (failureCode, message) => {
    repository.run.mockResolvedValue({ ...runFixture, status: 'FAILED', analysis: null, failureCode })

    mount('/app/combination-reviews/12/runs/30')

    expect(await screen.findByText(new RegExp(message))).toBeTruthy()
    expect(screen.queryByText(new RegExp(failureCode))).toBeNull()
  })
  it('shows auth expiry and clears personal view', async () => {
    repository.get.mockRejectedValue(new CombinationReviewError(401, 'UNAUTHENTICATED'))
    const { store } = mount()
    fireEvent.click(await screen.findByText('다시 로그인'))
    expect(store.getState().auth.status).toBe('anonymous')
    expect(screen.queryByRole('region', { name: '분석 실행' })).toBeNull()
  })
  it('allows explicit cleanup only after a confirmed revision rejection, without another POST', async () => {
    repository.start.mockRejectedValue(new CombinationReviewError(409, 'COMBINATION_REVIEW_REVISION_CONFLICT'))
    mount(); await screen.findByRole('button', { name: '검토 실행' })
    fireEvent.click(screen.getByRole('button', { name: '검토 실행' }))
    fireEvent.click(await screen.findByText('버전 충돌로 거절된 실행 요청 정리'))
    expect(screen.queryByText(/응답을 확인하지 못한 분석 요청/)).toBeNull()
    expect(Object.keys(sessionStorage)).toHaveLength(0)
    expect(repository.start).toHaveBeenCalledTimes(1)
  })
  it('drops late analysis on account switch and clears request journal', async () => {
    let finish!: (value: typeof runFixture) => void
    repository.start.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { store } = mount(); await screen.findByRole('button', { name: '검토 실행' })
    fireEvent.click(screen.getByRole('button', { name: '검토 실행' }))
    expect(Object.keys(sessionStorage).length).toBe(1)
    act(() => { store.dispatch(signedIn({ email: 'b@example.com', role: 'USER', tier: 'MEMBER', emailVerified: false, hasPassword: true, accountType: null, onboarded: true, company: null })) })
    await act(async () => finish(runFixture))
    expect(Object.keys(sessionStorage).length).toBe(0)
    expect(screen.queryByRole('region', { name: '실행 30 결과' })).toBeNull()
    expect(repository.start.mock.calls[0][2].aborted).toBe(true)
    act(() => { store.dispatch(signedOut()) })
  })
  it.each([
    ['sha256:f0e60686c3d79629d9523b65583a801f0780b83e00a3bbcde043ae895e601bcb', '사업 0(가 공고)과 사업 1(나 공고)의 제한입니다. 사업 10은 원문 제목입니다.', '사업 1(가 공고)과 사업 2(나 공고)의 제한입니다. 사업 10은 원문 제목입니다.'],
    ['sha256:f0e60686c3d79629d9523b65583a801f0780b83e00a3bbcde043ae895e601bcb', '사업 1과 사업 2의 제한입니다.', '사업 1과 사업 2의 제한입니다.'],
    ['sha256:new-prompt', '사업 1과 사업 2의 제한입니다.', '사업 1과 사업 2의 제한입니다.'],
  ])('displays legacy summary numbering without rewriting citations (%s, %s)', async (promptVersion, summary, expected) => {
    const run = structuredClone(runFixture)
    run.configuration = { ...run.configuration!, promptVersion }
    run.analysis!.summary = summary
    const citation = run.analysis!.pairs[0].stages[0].citations[0]
    citation.quote = '사업 0과 사업 1은 원문에 적힌 표현입니다.'
    repository.run.mockResolvedValue(run)
    mount('/app/combination-reviews/12/runs/30')
    const region = await screen.findByRole('region', { name: '검토 요약' })
    expect(within(region).getByText(expected)).toBeTruthy()
    const application = screen.getByRole('article', { name: '신청 단계 판단' })
    fireEvent.click(within(application).getByRole('button', { name: /근거 1개/ }))
    expect(within(application).getByText(citation.quote)).toBeTruthy()
    expect(repository.start).not.toHaveBeenCalled()
  })
  it('summarizes verdicts, collects questions and shows six stage cards with sources without execution metadata', async () => {
    repository.runs.mockResolvedValue({ items: [runFixture], nextBeforeId: null })
    const view = mount()
    const scrollTo = vi.fn()
    view.container.scrollTo = scrollTo
    await screen.findByRole('button', { name: '다시 실행' })
    // 지난 입력 버전의 결과라 [결과 보기]는 주 동작이 아니고, 최근 실행 카드가 다른 버전임을 알립니다.
    expect(screen.queryByRole('link', { name: '결과 보기 →' })).toBeNull()
    expect(within(screen.getByRole('region', { name: '최근 실행' })).getByText(/지금 입력과 다른 버전의 결과예요/)).toBeTruthy()
    const resultLink = await screen.findByRole('link', { name: /#30 · 입력 버전/ })
    expect(resultLink.getAttribute('href')).toBe('/app/combination-reviews/12/runs/30')
    expect(screen.queryByRole('region', { name: '실행 30 결과' })).toBeNull()
    fireEvent.click(resultLink)
    await screen.findByRole('region', { name: '실행 30 결과' })
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' })
    expect(screen.getByText(/과거 입력 버전의 결과/)).toBeTruthy()
    expect(screen.queryByText(/BIZINFO:PBLN_/)).toBeNull()
    expect(screen.getByText('제한을 찾지 못한 것은 허용이 아니에요')).toBeTruthy()
    expect(screen.queryByText(/당시 제목:/)).toBeNull()
    expect(screen.queryByText(/실행별 추가 설명:/)).toBeNull()
    expect(screen.queryByText(/프롬프트/)).toBeNull()
    const summary = screen.getByRole('region', { name: '검토 요약' })
    // 판정 다섯 가지를 주의(제한 · 충돌) · 확인 필요(정보 · 근거 부족) · 가능(범위 내 허용)으로 센다.
    expect(within(summary).getByText('주의 2')).toBeTruthy()
    expect(within(summary).getByText('확인 필요 3')).toBeTruthy()
    expect(within(summary).getByText('가능 1')).toBeTruthy()
    // 실행 당시 사업 순서(뒤바뀐 순서)대로 공고 이름을 보인다.
    expect(within(summary).getAllByRole('listitem').map((item) => item.textContent)).toEqual([expect.stringMatching(/^사업 1딥테크 성장 지원 공고/), expect.stringMatching(/^사업 2청년창업 사업화 지원 공고/)])
    expect(within(summary).getByText(runFixture.analysis!.summary)).toBeTruthy()
    const questions = screen.getByRole('region', { name: '확인할 정보' })
    expect(within(questions).getAllByText('지원 목적이 동일한가요?')).toHaveLength(1)
    expect(within(questions).getByRole('link', { name: '입력 보완하기' }).getAttribute('href')).toBe('/app/combination-reviews/12?step=participation')
    const cards = screen.getAllByRole('article')
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual(['확약 단계 판단', '수행 단계 판단', '신청 단계 판단', '선정 단계 판단', '협약 단계 판단', '교부 단계 판단'])
    // 첫 주의 카드만 근거를 펼쳐 둔다.
    const first = within(cards[0]!).getByRole('button', { name: /근거 1개/ })
    const citations = document.getElementById(first.getAttribute('aria-controls')!)!
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(citations.hidden).toBe(false)
    expect(within(cards[0]!).getByText(/PDF 3쪽, 문단 2/)).toBeTruthy()
    expect(within(cards[0]!).getByRole('link', { name: '공고 페이지 보기 ↗' }).getAttribute('href')).toBe(runFixture.evidence!.documents[0].sourcePageUrl)
    expect(within(cards[0]!).getByRole('button', { name: '원문 받기' })).toBeTruthy()
    fireEvent.click(first)
    expect(citations.hidden).toBe(true)
    expect(within(cards[1]!).getByRole('button', { name: /근거 1개/ }).getAttribute('aria-expanded')).toBe('false')
    expect(within(cards[2]!).getByText('기관 확인 필요')).toBeTruthy()
    expect(within(cards[5]!).queryByText('기관 확인 필요')).toBeNull()
    const sources = screen.getByRole('region', { name: '공식 원문과 수집 범위' })
    expect(within(sources).getByRole('link', { name: '공고 페이지 보기 ↗: 공식-원문-모의.pdf' }).getAttribute('href')).toBe(runFixture.evidence!.documents[0].sourcePageUrl)
    expect(within(sources).getAllByRole('button', { name: '받기: 공식-원문-모의.pdf' })).toHaveLength(1)
    expect(within(sources).getByText(/두 공고 사이의 제한만 봤어요/)).toBeTruthy()
    expect(screen.queryByText(/SHA-256/)).toBeNull()
    expect(screen.queryByText(/파서 fixture-v1/)).toBeNull()
    expect(screen.queryByText(/수집 2026-09-09T09:00:00/)).toBeNull()
    expect(repository.start).not.toHaveBeenCalled()
  })
  it('explains analysis limitations and presents model status codes in Korean', async () => {
    const run = structuredClone(runFixture)
    run.analysis!.summary = '사업 1은 YES이고 사업 2는 UNKNOWN입니다.'
    run.analysis!.limitations = ['협약은 NO이고 수행은 NOT_STARTED이며 교부는 UNKNOWN입니다.']
    run.analysis!.pairs[0].stages[0].scope = 'IN_PROGRESS 상태까지 확인'
    run.analysis!.pairs[0].stages[0].explanation = 'COMPLETED 또는 STOPPED 여부는 UNKNOWN입니다.'
    run.analysis!.pairs[0].stages[0].questions = ['선정 결과가 YES인가요?']
    repository.run.mockResolvedValue(run)

    mount('/app/combination-reviews/12/runs/30')

    expect(await screen.findByText('사업 1은 ‘예’이고 사업 2는 ‘미확인’입니다.')).toBeTruthy()
    expect(screen.getByText(/입력한 참여 상태 · 추가 설명과 자동 수집한 원문 범위/)).toBeTruthy()
    expect(screen.getByText('협약은 ‘아니오’이고 수행은 ‘시작 전’이며 교부는 ‘미확인’입니다.')).toBeTruthy()
    expect(screen.getByText(/‘수행 중’ 상태까지 확인/)).toBeTruthy()
    expect(screen.getByText('‘완료’ 또는 ‘중단’ 여부는 ‘미확인’입니다.')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '확인할 정보' })).getByText('선정 결과가 ‘예’인가요?')).toBeTruthy()
  })
  it('loads the selected result automatically after the application StrictMode remount', async () => {
    mount('/app/combination-reviews/12/runs/30', true)

    expect(await screen.findByRole('region', { name: '실행 30 결과' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull()
    expect(repository.run).toHaveBeenCalledWith(12, 30, expect.any(AbortSignal))
  })
  it('switches to another execution result without returning to the analysis page', async () => {
    const olderRun = { ...structuredClone(runFixture), id: 29, startedAt: '2026-09-08T09:00:00+09:00' }
    repository.runs.mockResolvedValue({ items: [runFixture, olderRun], nextBeforeId: null })
    repository.run.mockImplementation(async (_reviewId, selectedRunId) => selectedRunId === 29 ? olderRun : runFixture)
    mount('/app/combination-reviews/12/runs/30')
    await screen.findByRole('region', { name: '실행 30 결과' })
    const runLabels = optionLabels(screen.getByLabelText('실행 결과 선택'))
    expect(runLabels.some((label) => /실행 #30 · 분석 완료 · 2026년 9월 9일 오전 9:00/.test(label))).toBe(true)
    expect(runLabels.some((label) => /실행 #29 · 분석 완료 · 2026년 9월 8일 오전 9:00/.test(label))).toBe(true)
    expect(screen.queryByText(/2026-09-0[89]T09:00:00/)).toBeNull()

    chooseOption(screen.getByLabelText('실행 결과 선택'), '29')

    expect(await screen.findByRole('region', { name: '실행 29 결과' })).toBeTruthy()
    expect(repository.run).toHaveBeenCalledWith(12, 29, expect.any(AbortSignal))
  })
  it('uses one current status per program while keeping independent saved facts', async () => {
    mount('/app/combination-reviews/12'); await screen.findByDisplayValue(reviewFixture.title)
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(await screen.findByText(/사업 1 · 청년창업 사업화 지원 공고/)).toBeTruthy()
    expect(screen.queryByLabelText('사업 1 신청')).toBeNull()
    expect(screen.queryByLabelText('사업 1 선정')).toBeNull()
    expect(screen.getAllByText('지금 어디까지 진행했나요?')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('사업 1 현재 진행 상태'), { target: { value: 'IN_PROGRESS' } })
    expect(selectedValue(screen.getByLabelText('사업 1 현재 진행 상태'))).toBe('IN_PROGRESS')
    expect(selectedValue(screen.getByLabelText('사업 1 지원금 교부 여부'))).toBe('UNKNOWN')
    await waitFor(() => expect(repository.start).not.toHaveBeenCalled())
  })
  it('deduplicates stage questions above the collapsed detail and opens the input step', async () => {
    const run = structuredClone(runFixture)
    run.analysis!.pairs[0].stages[0].questions = ['두 사업의 비용이 같나요?']
    run.analysis!.pairs[0].stages[1].questions = ['두 사업의 비용이 같나요?', '확약서를 제출했나요?']
    repository.run.mockResolvedValue(run)
    mount('/app/combination-reviews/12/runs/30')
    const questions = await screen.findByRole('region', { name: '확인할 정보' })
    expect(within(questions).getAllByText('두 사업의 비용이 같나요?')).toHaveLength(1)
    // 다른 단계의 질문(지원 목적)까지 모아 중복 없이 3개다.
    expect(within(questions).getByText('3개 · 답하면 판단이 바뀔 수 있어요')).toBeTruthy()
    fireEvent.click(within(questions).getByRole('link', { name: '입력 보완하기' }))
    expect(await screen.findAllByText('지금 어디까지 진행했나요?')).toHaveLength(2)
    expect(selectedValue(screen.getByLabelText('사업 1 현재 진행 상태'))).toBe('IN_PROGRESS')
    expect((screen.getByLabelText('분석에 참고할 추가 설명 (선택)') as HTMLTextAreaElement).value).toBe(run.input.additionalFacts)
    expect(repository.replace).not.toHaveBeenCalled()
    expect(repository.start).not.toHaveBeenCalled()
  })
  it('does not mark a loaded review dirty before the user edits its status', async () => {
    mount('/app/combination-reviews/12'); await screen.findByDisplayValue(reviewFixture.title)
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    await screen.findAllByText('지금 어디까지 진행했나요?')
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    await screen.findByRole('region', { name: '분석 실행' })
    expect(screen.queryByText(/저장하지 않은 입력이 있습니다/)).toBeNull()
    expect(repository.replace).not.toHaveBeenCalled()
  })
  it('moves the workspace scroll area to the top whenever the step changes', async () => {
    const view = mount('/app/combination-reviews/12')
    const scrollTo = vi.fn()
    view.container.scrollTo = scrollTo
    await screen.findByDisplayValue(reviewFixture.title)

    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: 'auto' })
  })
})

describe('loading placeholders', () => {
  // 스켈레톤 막대는 낭독하지 않는 장식이라 클래스로 셉니다. 버튼 스피너(animate-spin)는 세지 않습니다.
  const placeholders = () => document.querySelectorAll('[class*="animate-pulse"]').length

  it('draws card placeholders only after 300ms while the list, a saved review and a run result first load', async () => {
    vi.useFakeTimers()
    repository.list.mockReturnValue(new Promise(() => {}))
    repository.get.mockReturnValue(new Promise(() => {}))
    repository.run.mockReturnValue(new Promise(() => {}))
    for (const path of ['/app/combination-reviews', '/app/combination-reviews/12?step=participation', '/app/combination-reviews/12/runs/30']) {
      const { unmount } = mount(path)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByText(/불러오는 중입니다/).getAttribute('role')).toBe('status')
      expect(placeholders()).toBe(0)
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      expect(placeholders()).toBeGreaterThan(0)
      unmount()
    }
  })

  it('keeps loaded reviews and shows progress on the more button instead of list placeholders', async () => {
    repository.list.mockResolvedValueOnce({ items: [reviewFixture], nextBeforeId: 12 }).mockReturnValueOnce(new Promise(() => {}))
    mount('/app/combination-reviews')
    fireEvent.click(await screen.findByRole('button', { name: '더 보기' }))
    const more = screen.getByRole('button', { name: '불러오는 중…' })
    expect(more.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByText(reviewFixture.title)).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(placeholders()).toBe(0)
  })
})
