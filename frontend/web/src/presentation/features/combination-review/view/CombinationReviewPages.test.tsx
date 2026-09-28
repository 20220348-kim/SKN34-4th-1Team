// @vitest-environment jsdom
import { asValue } from 'awilix/browser'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appContainer } from '../../../../app/appContainer'
import { createAppStore } from '../../../../app/store'
import { signedIn, signedOut } from '../../../shared/auth/state/authSlice'
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
const repository = { list: vi.fn(), get: vi.fn(), create: vi.fn(), delete: vi.fn(), replace: vi.fn(), runs: vi.fn(), run: vi.fn(), start: vi.fn(), source: vi.fn() }
beforeEach(() => {
  sessionStorage.clear(); vi.resetAllMocks()
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
    browseSavedSupportProgramsUseCase: asValue({ execute: browseSavedPrograms }),
    getSupportProgramDetailUseCase: asValue({ execute: vi.fn(async (identity) => ({ ...supportPrograms[0], sourceCode: identity.sourceCode, id: identity.sourceProgramId, title: identity.sourceProgramId === 'PBLN_100' ? '청년창업 사업화 지원 공고' : '딥테크 성장 지원 공고' })) }),
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); appContainer.register({ combinationReviewUseCase: asValue(original), browseSupportProgramsUseCase: asValue(originalCatalog), browseSavedSupportProgramsUseCase: asValue(originalSavedPrograms), getSupportProgramDetailUseCase: asValue(originalDetail) }) })
function Isolation() { useReviewSessionIsolation(); return null }
function mount(path = '/app/combination-reviews/12?step=analysis', strict = false) {
  const store = createAppStore()
  store.dispatch(signedIn({ email: 'a@example.com', role: 'USER', tier: 'MEMBER', emailVerified: false, hasPassword: true, accountType: null, onboarded: true, company: null }))
  const screenTree = <Provider store={store}><Isolation /><MemoryRouter initialEntries={[path]}><Routes>
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
    expect(await screen.findByRole('heading', { level: 1, name: `${reviewFixture.title} 결과` })).toBeTruthy()
    const navigation = within(screen.getByRole('navigation', { name: '상위 화면' }))
    expect(navigation.getAllByRole('link').map((link) => link.textContent)).toEqual(['중복 지원 수혜 검토', '공고 분석'])
    expect(navigation.getByRole('link', { name: '중복 지원 수혜 검토' }).getAttribute('href')).toBe('/app/combination-reviews')
    fireEvent.click(navigation.getByRole('link', { name: '공고 분석' }))
    expect(await screen.findByRole('heading', { level: 1, name: '공고 분석' })).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: '중복 지원·수혜 검토' }))
    expect(await screen.findByRole('heading', { level: 1, name: '중복 지원·수혜 검토' })).toBeTruthy()
    expect(repository.start).not.toHaveBeenCalled()
  })

  it('keeps selected programs in order and removes only the chosen program', async () => {
    mount('/app/combination-reviews/12')
    await screen.findByDisplayValue(reviewFixture.title)
    const selected = within(screen.getByLabelText('현재 선택한 공고'))
    await selected.findByText(/사업 1 · 청년창업 사업화 지원 공고/)
    expect(selected.getByText(/사업 2 · 딥테크 성장 지원 공고/)).toBeTruthy()
    fireEvent.click(selected.getByRole('button', { name: /청년창업 사업화 지원 공고.*선택 해제/ }))
    expect(selected.queryByText(/청년창업/)).toBeNull()
    expect(selected.getByText(/사업 1 · 딥테크 성장 지원 공고/)).toBeTruthy()
    expect((screen.getByRole('button', { name: '다음: 참여 상태 설정' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('submits once then polls queued and running work until completion without another POST', async () => {
    vi.useFakeTimers()
    const queued = { ...runFixture, status: 'QUEUED', analysis: null, evidence: null, configuration: null, finishedAt: null }
    repository.start.mockImplementation(async (_id, request) => ({ ...queued, requestKey: request.requestKey }))
    repository.run.mockResolvedValueOnce({ ...queued, status: 'RUNNING' }).mockResolvedValue(runFixture)
    await act(async () => { mount() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '새 분석 실행' })) })
    expect(screen.getByRole('link', { name: /#30 · 입력 버전 1 · 대기 중/ })).toBeTruthy()
    expect(screen.queryByText('같은 요청 확인')).toBeNull()
    expect((screen.getByRole('button', { name: '새 분석 실행' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByRole('link', { name: /#30 · 입력 버전 1 · 분석 중/ })).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByRole('link', { name: /#30 · 입력 버전 1 · 분석 완료/ })).toBeTruthy()
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
    expect(screen.getByText(/상태 자동 조회가 중단/)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: /#30 · 입력 버전/ })) })
    expect(screen.getByRole('region', { name: '실행 30 결과' })).toBeTruthy()
    expect(repository.start).not.toHaveBeenCalled()
  })
  it('blocks a new analysis for an unknown outcome without polling or resubmitting', async () => {
    vi.useFakeTimers()
    repository.runs.mockResolvedValue({ items: [{ ...runFixture, status: 'UNKNOWN', analysis: null }], nextBeforeId: null })
    repository.run.mockResolvedValue({ ...runFixture, status: 'UNKNOWN', analysis: null, failureCode: 'RUN_OUTCOME_UNKNOWN' })
    await act(async () => { mount() })
    expect(screen.getByText(/결과 확인이 필요한 실행/)).toBeTruthy()
    expect((screen.getByRole('button', { name: '새 분석 실행' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(repository.run).not.toHaveBeenCalled()
    expect(repository.start).not.toHaveBeenCalled()
  })
  it('adds two saved notices to a new review without a catalog search', async () => {
    const programs = supportPrograms.slice(0, 2).map((program, index) => ({ ...structuredClone(program), id: `saved-${index + 1}` }))
    browseSavedPrograms.mockResolvedValueOnce(programs.map((program, index) => ({ savedAt: `2026-09-12T10:0${index}:00+09:00`, program })))
    mount('/app/combination-reviews/new')

    const selectionSummary = screen.getByLabelText('현재 선택한 공고')
    expect(selectionSummary.className).toContain('min-h-12')
    expect(screen.getByText('선택한 공고가 없습니다.')).toBeTruthy()
    expect(browseSavedPrograms).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '관심 공고함에서 선택' }))
    const dialog = await screen.findByRole('dialog', { name: '관심 공고함에서 선택' })
    const savedPrograms = await within(dialog).findByRole('list', { name: '중복 지원 검토 관심 공고 목록' })
    fireEvent.click(within(savedPrograms).getByRole('button', { name: `${programs[0]!.title} 관심 공고 선택` }))
    fireEvent.click(within(savedPrograms).getByRole('button', { name: `${programs[1]!.title} 관심 공고 선택` }))

    expect(screen.getAllByText('2/2 선택')).toHaveLength(2)
    expect(within(savedPrograms).getAllByRole('button', { name: /관심 공고 선택 해제$/ })).toHaveLength(2)
    expect(selectionSummary.children).toHaveLength(2)
    expect(browseSavedPrograms).toHaveBeenCalledWith(expect.any(AbortSignal))
    fireEvent.click(within(dialog).getByRole('button', { name: '선택 완료' }))
    expect(screen.queryByRole('dialog', { name: '관심 공고함에서 선택' })).toBeNull()
  })

  it('shows an explicit empty message only after opening the saved-program picker', async () => {
    mount('/app/combination-reviews/new')
    expect(screen.queryByText('관심 공고함에 담은 공고가 없습니다.')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '관심 공고함에서 선택' }))

    expect(await screen.findByText('관심 공고함에 담은 공고가 없습니다.')).toBeTruthy()
    expect(screen.queryByText(/관심 공고를 불러오지 못했습니다/)).toBeNull()
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
    fireEvent.click(screen.getByText('공고 검색'))
    const choices = await screen.findAllByRole('button', { name: '선택' })
    fireEvent.click(choices[0]); fireEvent.click(choices[1])
    expect(screen.getByText('2/2 선택')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '선택 해제' })).toHaveLength(2)
    expect(screen.getByLabelText('현재 선택한 공고').children).toHaveLength(2)
    expect(fetch).toHaveBeenCalledOnce()
    expect(new URL(fetch.mock.calls[0][0]).pathname).toMatch(/\/catalog$/)
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get('status')).toBe('ALL')
    fireEvent.click(screen.getByText('다음: 참여 상태 설정'))
    fireEvent.click(screen.getByText('입력 저장 후 분석 시작'))
    if (status === 201) {
      await screen.findByRole('heading', { name: '공고 분석' })
      await waitFor(() => expect(fetch.mock.calls.filter(([url, init]) => init?.method === 'POST' && String(url).endsWith('/runs'))).toHaveLength(1))
    } else {
      expect((await screen.findByRole('alert')).textContent).toContain('Core API 실행 버전')
      fireEvent.click(screen.getByText('이전: 제목·공고 선택'))
      expect(screen.getByDisplayValue(reviewFixture.title)).toBeTruthy()
      expect(screen.getByRole('heading', { name: '새 검토' })).toBeTruthy()
    }
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(posts).toHaveLength(status === 201 ? 2 : 1)
    expect(posts[0][0]).toMatch(/\/api\/v1\/combination-reviews$/)
  })
  it('updates the acknowledged input version and starts analysis with the same action', async () => {
    repository.replace.mockResolvedValue(undefined)
    mount('/app/combination-reviews/12'); await screen.findByDisplayValue(reviewFixture.title)
    fireEvent.change(screen.getByLabelText('검토 제목'), { target: { value: '수정된 제목' } })
    fireEvent.click(screen.getByText('다음: 참여 상태 설정'))
    fireEvent.click(screen.getByText('입력 저장 후 분석 시작'))
    await screen.findByText('분석이 완료되어 저장된 결과를 표시합니다.')
    expect(screen.getByText('검토 #12 · 저장 입력 버전 3')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '공고 분석' })).toBeTruthy()
    expect(screen.queryByLabelText('이번 실행의 추가 설명')).toBeNull()
    expect(repository.get).toHaveBeenCalledTimes(1)
    expect(repository.start).toHaveBeenCalledWith(12, expect.objectContaining({ expectedRevision: 3 }), expect.any(AbortSignal))
  })
  it('focuses the server version error and preserves edited inputs', async () => {
    repository.replace.mockRejectedValue(new CombinationReviewError(404, 'COMBINATION_REVIEW_API_UNAVAILABLE'))
    mount('/app/combination-reviews/12'); await screen.findByDisplayValue(reviewFixture.title)
    fireEvent.change(screen.getByLabelText('검토 제목'), { target: { value: '보존할 입력' } })
    fireEvent.click(screen.getByText('다음: 참여 상태 설정'))
    fireEvent.click(screen.getByText('입력 저장 후 분석 시작'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Core API 실행 버전')
    // 포커스 이동은 렌더 뒤 effect에서 일어나므로 느린 환경(CI)에서도 기다립니다.
    await waitFor(() => expect(document.activeElement).toBe(alert))
    fireEvent.click(screen.getByText('이전: 제목·공고 선택'))
    expect(screen.getByDisplayValue('보존할 입력')).toBeTruthy()
  })
  it('clears a selection-step validation error after the corrected input advances', async () => {
    mount('/app/combination-reviews/12'); await screen.findByDisplayValue(reviewFixture.title)
    fireEvent.change(screen.getByLabelText('검토 제목'), { target: { value: '' } })
    fireEvent.click(screen.getByText('다음: 참여 상태 설정'))
    expect((await screen.findByRole('alert')).textContent).toContain('제목은 제어문자 없이 1~200자로 입력해 주세요.')

    fireEvent.change(screen.getByLabelText('검토 제목'), { target: { value: '수정한 검토 제목' } })
    fireEvent.click(screen.getByText('다음: 참여 상태 설정'))

    expect(screen.getByRole('heading', { name: '공고별 참여 상태' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('mounts with GET only and renders empty list', async () => {
    mount('/app/combination-reviews')
    await screen.findByText('아직 저장한 검토가 없습니다.')
    expect(screen.queryByText(/두 사업의 참여 사실과 공식 원문을 비교합니다/)).toBeNull()
    expect(screen.getByText('저장한 검토와 실행 이력은 본인만 조회할 수 있습니다.')).toBeTruthy()
    expect(repository.create).not.toHaveBeenCalled(); expect(repository.start).not.toHaveBeenCalled()
  })
  it('appends cursor pages', async () => {
    repository.list.mockResolvedValueOnce({ items: [reviewFixture], nextBeforeId: 12 }).mockResolvedValueOnce({ items: [{ ...reviewFixture, id: 11, title: '이전 검토' }], nextBeforeId: null })
    mount('/app/combination-reviews')
    fireEvent.click(await screen.findByText('이전 검토 더 보기'))
    await screen.findByText('이전 검토')
    expect(repository.list.mock.calls[1][0]).toBe(12)
    expect(screen.getByText(reviewFixture.title)).toBeTruthy()
    expect(screen.getAllByText(/수정 2026년 9월 9일 오전 10:00/)).toHaveLength(2)
    expect(screen.queryByText(/2026-09-09T10:00:00/)).toBeNull()
    expect(screen.getAllByRole('link', { name: '결과 보기' })).toHaveLength(2)
  })
  it('deletes a review only after explicit confirmation and removes it from the list', async () => {
    repository.list.mockResolvedValue({ items: [reviewFixture], nextBeforeId: null })
    mount('/app/combination-reviews')
    fireEvent.click(await screen.findByRole('button', { name: '삭제' }))
    expect(repository.delete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '정말 삭제' }))
    await screen.findByText('아직 저장한 검토가 없습니다.')
    expect(repository.delete).toHaveBeenCalledWith(reviewFixture.id, expect.any(AbortSignal))
  })
  it('preserves form on 409 without rendering latest saved input controls', async () => {
    repository.replace.mockRejectedValue(new CombinationReviewError(409, 'COMBINATION_REVIEW_REVISION_CONFLICT'))
    mount('/app/combination-reviews/12'); await screen.findByDisplayValue(reviewFixture.title)
    fireEvent.change(screen.getByLabelText('검토 제목'), { target: { value: '내 편집 내용' } })
    fireEvent.click(screen.getByText('다음: 참여 상태 설정'))
    expect(screen.queryByText('공고별 현재 상태')).toBeNull()
    fireEvent.click(screen.getByText('입력 저장 후 분석 시작'))
    await screen.findByRole('alert')
    expect(repository.replace.mock.calls[0][1]).toBe(2)
    expect(screen.queryByText('최신 저장 입력 확인')).toBeNull()
    expect(screen.queryByText('최신 입력 조회')).toBeNull()
    fireEvent.click(screen.getByText('이전: 제목·공고 선택'))
    expect(screen.getByDisplayValue('내 편집 내용')).toBeTruthy()
    expect(repository.replace).toHaveBeenCalledTimes(1)
  })
  it('retains one logical request after response loss and across remount, with no automatic POST', async () => {
    repository.start.mockRejectedValueOnce(new TypeError('network lost')).mockImplementation(async (_id, request) => ({ ...runFixture, requestKey: request.requestKey }))
    const view = mount(); await screen.findByText('새 분석 실행')
    fireEvent.click(screen.getByText('← 참여 상태 수정'))
    fireEvent.change(screen.getByLabelText('분석에 참고할 추가 설명 (선택)'), { target: { value: '한 번만 전달할 설명' } })
    const button = screen.getByText('입력 저장 후 분석 시작'); fireEvent.click(button); fireEvent.click(button)
    await screen.findByRole('alert')
    expect(repository.start).toHaveBeenCalledTimes(1)
    const input = repository.start.mock.calls[0][1]
    view.unmount(); mount(); await screen.findByText('같은 요청 확인')
    expect(repository.start).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('같은 요청 확인'))
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

    const button = await screen.findByRole('button', { name: '새 분석 실행' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(screen.queryByText(/자동 분석은 지원하지 않습니다/)).toBeNull()
  })
  it.each([422, 429, 503])('shows %s as technical error with saved failed run', async (status) => {
    const failedRun = { ...runFixture, status: 'FAILED' as const, analysis: null, failureCode: 'SOURCE_UNSUPPORTED' }
    repository.start.mockRejectedValue(new CombinationReviewError(status, 'SOURCE_UNSUPPORTED', 30))
    repository.run.mockResolvedValue(failedRun)
    repository.runs.mockResolvedValue({ items: [failedRun], nextBeforeId: null })
    mount(); await screen.findByText('새 분석 실행')
    fireEvent.click(screen.getByText('새 분석 실행'))
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
    expect(screen.queryByRole('heading', { name: '공고 분석' })).toBeNull()
  })
  it('allows explicit cleanup only after a confirmed revision rejection, without another POST', async () => {
    repository.start.mockRejectedValue(new CombinationReviewError(409, 'COMBINATION_REVIEW_REVISION_CONFLICT'))
    mount(); await screen.findByText('새 분석 실행')
    fireEvent.click(screen.getByText('새 분석 실행'))
    fireEvent.click(await screen.findByText('버전 충돌로 거절된 실행 요청 정리'))
    expect(screen.queryByText('같은 요청 확인')).toBeNull()
    expect(Object.keys(sessionStorage)).toHaveLength(0)
    expect(repository.start).toHaveBeenCalledTimes(1)
  })
  it('drops late analysis on account switch and clears request journal', async () => {
    let finish!: (value: typeof runFixture) => void
    repository.start.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { store } = mount(); await screen.findByText('새 분석 실행')
    fireEvent.click(screen.getByText('새 분석 실행'))
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
    const region = await screen.findByRole('region', { name: '두 사업의 중복 지원 검토 요약' })
    expect(within(region).getByText(expected)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '원문인용 확인하기' }))
    expect(screen.getByText(citation.quote)).toBeTruthy()
    expect(repository.start).not.toHaveBeenCalled()
  })
  it('labels the review summary and shows warnings, six stages and sources without execution metadata', async () => {
    repository.runs.mockResolvedValue({ items: [runFixture], nextBeforeId: null })
    const view = mount()
    const scrollTo = vi.fn()
    view.container.scrollTo = scrollTo
    await screen.findByText('새 분석 실행')
    const resultLink = await screen.findByRole('link', { name: /#30 · 입력 버전/ })
    expect(resultLink.getAttribute('href')).toBe('/app/combination-reviews/12/runs/30')
    expect(screen.queryByRole('region', { name: '실행 30 결과' })).toBeNull()
    fireEvent.click(resultLink)
    await screen.findByRole('region', { name: '실행 30 결과' })
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' })
    expect(screen.getByText(/과거 입력 버전의 결과/)).toBeTruthy()
    expect(screen.queryByText(/BIZINFO:PBLN_/)).toBeNull()
    expect(screen.getByText(/공식 원문 기준의 AI 분석이며/)).toBeTruthy()
    expect(screen.queryByText(/당시 제목:/)).toBeNull()
    expect(screen.queryByText(/실행별 추가 설명:/)).toBeNull()
    expect(screen.queryByText('실행 당시 사업 순서·참여 상태')).toBeNull()
    expect(screen.queryByText(/프롬프트/)).toBeNull()
    const summary = screen.getByRole('region', { name: '두 사업의 중복 지원 검토 요약' })
    expect(within(summary).getByRole('heading', { name: '두 사업의 중복 지원 검토 요약' })).toBeTruthy()
    expect(within(summary).getByText('선택한 두 사업을 함께 신청하거나 지원받을 때의 제한 사항을 요약한 내용입니다.')).toBeTruthy()
    expect(within(summary).getByText(runFixture.analysis!.summary)).toBeTruthy()
    expect(screen.getAllByRole('tab')).toHaveLength(6)
    const citationsButton = screen.getByRole('button', { name: '원문인용 확인하기' })
    const citations = document.getElementById(citationsButton.getAttribute('aria-controls')!)!
    expect(citationsButton.getAttribute('aria-expanded')).toBe('false')
    expect(citations.hidden).toBe(true)
    expect(screen.queryByRole('button', { name: '인용 원본 다운로드' })).toBeNull()
    fireEvent.click(citationsButton)
    expect(citationsButton.getAttribute('aria-expanded')).toBe('true')
    expect(citations.hidden).toBe(false)
    expect(screen.getByRole('button', { name: '인용 원본 다운로드' })).toBeTruthy()
    expect(screen.getByText(/PDF 3쪽, 문단 2/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '원문인용 접기' }))
    expect(citations.hidden).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '원문인용 확인하기' }))
    expect(screen.getByRole('tab', { name: '1단계 · 신청 · 사용자 정보 부족' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: '2단계 · 선정 · 공식 근거 부족' }))
    expect(screen.getByRole('tab', { name: '1단계 · 신청 · 사용자 정보 부족' }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tabpanel', { name: '선정 분석 결과' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '원문인용 확인하기' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: '인용 원본 다운로드' })).toBeNull()
    const sourceLink = screen.getByRole('link', { name: '공식 공고 페이지 열기' })
    expect(sourceLink.getAttribute('href')).toBe(runFixture.evidence!.documents[0].sourcePageUrl)
    expect(screen.getAllByRole('button', { name: '수집 원본 다운로드' })).toHaveLength(1)
    expect(screen.queryByText(/SHA-256/)).toBeNull()
    expect(screen.queryByText(/파서 fixture-v1/)).toBeNull()
    expect(screen.queryByText(/수집 2026-09-09T09:00:00/)).toBeNull()
    expect(screen.queryByRole('link', { name: '공식 출처 열기' })).toBeNull()
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
    expect(screen.getByText(/입력한 참여 상태와 추가 사실, 자동 수집한 공식 원문의 범위/)).toBeTruthy()
    expect(screen.getByText('협약은 ‘아니오’이고 수행은 ‘시작 전’이며 교부는 ‘미확인’입니다.')).toBeTruthy()
    expect(screen.getByText(/‘수행 중’ 상태까지 확인/)).toBeTruthy()
    expect(screen.getByText('‘완료’ 또는 ‘중단’ 여부는 ‘미확인’입니다.')).toBeTruthy()
    expect(screen.getByText('선정 결과가 ‘예’인가요?')).toBeTruthy()
  })
  it('loads the selected result automatically after the application StrictMode remount', async () => {
    mount('/app/combination-reviews/12/runs/30', true)

    expect(await screen.findByRole('region', { name: '실행 30 결과' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '실행 결과 다시 불러오기' })).toBeNull()
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
  it('keeps UNKNOWN independent from other participation fields', async () => {
    mount('/app/combination-reviews/12'); await screen.findByDisplayValue(reviewFixture.title)
    fireEvent.click(screen.getByText('다음: 참여 상태 설정'))
    expect(screen.getByText(/사업 1 · 청년창업 사업화 지원 공고/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('사업 1 신청'), { target: { value: 'YES' } })
    expect(selectedValue(screen.getByLabelText('사업 1 교부'))).toBe('UNKNOWN')
    expect(selectedValue(screen.getByLabelText('사업 1 확약'))).toBe('NO')
    await waitFor(() => expect(repository.start).not.toHaveBeenCalled())
  })
  it('explains all six participation states on mouse hover and keyboard focus', async () => {
    mount('/app/combination-reviews/12'); await screen.findByDisplayValue(reviewFixture.title)
    fireEvent.click(screen.getByText('다음: 참여 상태 설정'))
    const descriptions = [
      ['신청', '해당 사업에 신청서를 제출하여 접수가 이루어졌는지를 선택합니다.'],
      ['선정', '평가·심사 후 지원 대상으로 선정되었다는 통보를 받았는지를 선택합니다.'],
      ['확약', '선정 이후 사업 참여나 의무 이행을 위한 확약서를 제출했는지를 선택합니다.'],
      ['협약', '주관기관과 지원 조건 및 사업 수행에 관한 협약을 체결했는지를 선택합니다.'],
      ['수행', '협약 이후 사업이 시작 전·수행 중·완료·중단 중 어느 상태인지 선택합니다.'],
      ['교부', '지원금·보조금이 실제로 지급(교부)되었는지를 선택합니다.'],
    ]

    for (const [label, description] of descriptions) {
      const helpButtons = screen.getAllByRole('button', { name: `${label} 도움말` })
      expect(helpButtons).toHaveLength(2)
      const tooltip = document.getElementById(helpButtons[0]!.getAttribute('aria-describedby')!)!
      expect(tooltip.textContent).toBe(description)
      // 말풍선은 항상 설명으로 연결돼 있고, 마우스를 올리거나 포커스가 올 때만 보입니다(위치는 화면 밖으로 나가지 않게 훅이 잡음).
      expect(tooltip.className).toContain('invisible')
      fireEvent.mouseEnter(helpButtons[0]!.parentElement!)
      expect(tooltip.className).toContain('visible')
      expect(tooltip.className).not.toContain('invisible')
      fireEvent.mouseLeave(helpButtons[0]!.parentElement!)
      expect(tooltip.className).toContain('invisible')
    }
    const firstHelp = screen.getAllByRole('button', { name: '신청 도움말' })[0]!
    fireEvent.focus(firstHelp)
    expect(document.getElementById(firstHelp.getAttribute('aria-describedby')!)!.className).not.toContain('invisible')
    fireEvent.blur(firstHelp)
    expect(document.getElementById(firstHelp.getAttribute('aria-describedby')!)!.className).toContain('invisible')
  })
  it('moves the workspace scroll area to the top whenever the step changes', async () => {
    const view = mount('/app/combination-reviews/12')
    const scrollTo = vi.fn()
    view.container.scrollTo = scrollTo
    await screen.findByDisplayValue(reviewFixture.title)

    fireEvent.click(screen.getByText('다음: 참여 상태 설정'))

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: 'auto' })
  })
})
