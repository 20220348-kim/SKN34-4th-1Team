// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { createAppStore } from './app/store'
import { supportPrograms } from './data/fixtures/supportPrograms'
import { getSupportProgramSearchReturnTo } from './presentation/features/support-program-detail/view/supportProgramNavigation'
import {
  defaultCatalogApplicantTypes, defaultCatalogCategories, defaultCatalogFounderAges,
  defaultCatalogRegions, defaultCatalogStartupStages,
} from './presentation/features/support-program-catalog/viewmodel/catalogFilterOptions'
import { sessionRestored } from './presentation/shared/auth/state/authSlice'
import { chooseOption, optionLabels, optionValues, selectedValue } from './test/selectField'

vi.mock('./presentation/shared/core-api-status/CoreApiConnectionStatus', () => ({ CoreApiConnectionStatus: () => null }))
vi.mock('./presentation/features/chat/hooks/useSupportProgramSearchReadiness', () => ({ useSupportProgramSearchReadiness: () => ({
  canSearch: false, isError: false, isInitialLoading: false, isRefreshing: false, refetch: vi.fn(),
  data: { searchState: 'UNAVAILABLE', programCount: 10, indexReady: false, sources: [], lastSuccessfulSyncAt: null, lastFailedSyncAt: null },
}) }))
const program = { ...supportPrograms[0], title: '서울 수출 바우처', categories: ['수출'], regions: ['서울'], recommendationScore: null, matchedReasons: [] }
const catalog = { programs: [program], total: 1, page: 1, pageSize: 12, totalPages: 1, regions: ['서울', '경북', '전국'], categories: ['수출', '기술'] }
const startupProgram = { ...program, id: 'startup-1', sourceCode: 'KSTARTUP', sourceName: 'K-Startup',
  sourceUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do', title: 'K-Startup 창업 지원' }
const startupCatalog = { ...catalog, programs: [startupProgram],
  startupStages: ['3년미만', '특화 창업자'], applicantTypes: ['일반기업', '사회적기업'], founderAges: ['만 40세 이상', '연령 제한 없음'] }
const startupParams = { sourceCode: 'KSTARTUP', startupStage: '3년미만', applicantType: '일반기업', founderAge: '만 40세 이상' }
const undatedPrograms = [
  { sourceCode: 'MSIT', sourceName: '과학기술정보통신부', sourceUrl: 'https://www.msit.go.kr/bbs/view.do' },
  { sourceCode: 'CNTRADE_NOTICE', sourceName: '충청남도 온라인수출지원시스템', sourceUrl: 'https://cntrade.chungnam.go.kr/home/kor/M102638244/board.do' },
].map((source) => ({ ...program, ...source, id: source.sourceCode + '-1', title: source.sourceName + ' 공고',
  organization: source.sourceName, status: 'UNKNOWN', applicationStartDate: null, applicationEndDate: null, applicationPeriod: '공고 원문 확인' }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })
function Location() {
  const location = useLocation()
  const navigate = useNavigate()
  return <><output data-testid="location">{location.pathname}{location.search}</output><button type="button" onClick={() => navigate(-1)}>테스트 뒤로</button></>
}
function start(path = '/?mode=filter', authenticated = path.startsWith('/app/')) {
  const store = createAppStore()
  store.dispatch(sessionRestored(authenticated ? { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null } : null))
  render(<Provider store={store}><MemoryRouter initialEntries={[path]}><App /><Location /></MemoryRouter></Provider>)
  return store
}

describe('지원사업 직접 필터 검색', () => {
  it.each(undatedPrograms)('$sourceName의 기간 안내는 접수 상태를 자동 변경하지 않고 UNKNOWN 검색·상세 복귀를 보존한다', async (undated) => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const request = new URL(url)
      if (!request.pathname.endsWith('/catalog')) return Response.json(undated)
      if (request.searchParams.get('sourceCode') !== undated.sourceCode) return Response.json(catalog)
      return Response.json(request.searchParams.get('status') === 'OPEN'
        ? { ...catalog, programs: [], total: 0, totalPages: 0 }
        : { ...catalog, programs: [undated] })
    })
    vi.stubGlobal('fetch', fetchMock)
    start()
    await screen.findByRole('link', { name: program.title })
    expect(optionLabels(screen.getByRole('combobox', { name: '출처' }))).toContain(undated.sourceName)
    expect(screen.queryByText(/접수 기간을 제공하지 않는 공고/)).toBeNull()
    chooseOption(screen.getByRole('combobox', { name: '출처' }), undated.sourceCode)
    const status = screen.getByRole('combobox', { name: '접수 상태' })
    expect(selectedValue(status)).toBe('OPEN')
    expect(document.getElementById(status.getAttribute('aria-describedby')!)?.textContent).toContain('접수 기간을 제공하지 않는 공고')
    expect(fetchMock).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '검색' }))
    await screen.findByText('조건에 맞는 공고가 없어요.')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('status')).toBe('OPEN')
    chooseOption(screen.getByRole('combobox', { name: '접수 상태' }), 'UNKNOWN')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '검색' }))
    await screen.findByRole('link', { name: undated.title })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const params = new URL(fetchMock.mock.calls[2][0]).searchParams
    expect(params.get('sourceCode')).toBe(undated.sourceCode)
    expect(params.get('status')).toBe('UNKNOWN')
    expect(within(screen.getByRole('region', { name: '필터 검색 결과' })).getByText('상태 미확인')).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: undated.title }))
    await screen.findByRole('heading', { name: undated.title })
    expect(screen.queryByRole('link', { name: '이 공고에 질문하기' })).toBeNull()
    expect(screen.getByText(/이 제공처 공고는 아직 원문 근거 답변을 지원하지 않습니다/)).toBeTruthy()
    const sourceLink = screen.getByRole('link', { name: undated.sourceCode === 'CNTRADE_NOTICE'
      ? '공식 공지 목록 ↗' : undated.sourceName + ' 원문 보기 ↗' })
    expect(sourceLink.getAttribute('href')).toBe(undated.sourceUrl)
    expect(Boolean(screen.queryByText('제목으로 해당 공지를 확인해 주세요.'))).toBe(undated.sourceCode === 'CNTRADE_NOTICE')
    expect(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }).parentElement?.classList.contains('flex-wrap')).toBe(true)
    fireEvent.click(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }))
    await screen.findByRole('link', { name: undated.title })
    expect(selectedValue(screen.getByRole('combobox', { name: '출처' }))).toBe(undated.sourceCode)
    expect(selectedValue(screen.getByRole('combobox', { name: '접수 상태' }))).toBe('UNKNOWN')
    const restored = new URL(screen.getByTestId('location').textContent!, 'https://app.example').searchParams
    expect(restored.get('sourceCode')).toBe(undated.sourceCode)
    expect(restored.get('status')).toBe('UNKNOWN')
    chooseOption(screen.getByRole('combobox', { name: '접수 상태' }), 'ALL')
    chooseOption(screen.getByRole('combobox', { name: '출처' }), 'BIZINFO')
    expect(selectedValue(screen.getByRole('combobox', { name: '접수 상태' }))).toBe('ALL')
    expect(screen.queryByText(/접수 기간을 제공하지 않는 공고/)).toBeNull()
  })

  it.each(undatedPrograms)('K-Startup에서 $sourceName로 바꾸면 전용 조건만 비우고 접수 상태를 유지한다', async (undated) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(startupCatalog))
      .mockResolvedValueOnce(Response.json({ ...catalog, programs: [], total: 0, totalPages: 0 }))
    vi.stubGlobal('fetch', fetchMock)
    start('/?mode=filter&' + new URLSearchParams({ ...startupParams, status: 'ALL' }))
    await screen.findByRole('link', { name: startupProgram.title })
    chooseOption(screen.getByRole('combobox', { name: '출처' }), undated.sourceCode)
    expect(screen.queryByRole('button', { name: /K-Startup 추가 조건/ })).toBeNull()
    expect(selectedValue(screen.getByRole('combobox', { name: '접수 상태' }))).toBe('ALL')
    fireEvent.click(screen.getByRole('button', { name: '검색' }))
    await screen.findByText('조건에 맞는 공고가 없어요.')
    const params = new URL(fetchMock.mock.calls[1][0]).searchParams
    expect(params.get('sourceCode')).toBe(undated.sourceCode)
    expect(params.get('status')).toBe('ALL')
    for (const field of ['startupStage', 'applicantType', 'founderAge']) expect(params.has(field)).toBe(false)
    chooseOption(screen.getByRole('combobox', { name: '출처' }), 'KSTARTUP')
    fireEvent.click(screen.getByRole('button', { name: /K-Startup 추가 조건/ }))
    for (const label of ['창업 업력', '신청 대상', '대표자 연령']) {
      expect(selectedValue(screen.getByRole('combobox', { name: label }))).toBe('')
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(undatedPrograms)('$sourceName의 질문 URL을 직접 열어도 입력과 API 요청을 차단한다', (undated) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    start('/support-programs/detail/question?' + new URLSearchParams({ sourceCode: undated.sourceCode, sourceProgramId: undated.id }))
    expect(screen.getByText(/이 제공처 공고는 아직 원문 근거 답변을 지원하지 않습니다/)).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('출처 선택은 요청 없이 추가 조건을 펼치고 응답 전 기본값과 응답 후 초안을 보존한다', async () => {
    let complete!: (response: Response) => void
    const fetchMock = vi.fn().mockReturnValueOnce(new Promise<Response>((resolve) => { complete = resolve }))
      .mockResolvedValueOnce(Response.json(startupCatalog))
    vi.stubGlobal('fetch', fetchMock)
    start()
    expect(selectedValue(screen.getByRole('combobox', { name: '출처' }))).toBe('')
    expect(screen.queryByRole('button', { name: /K-Startup 추가 조건/ })).toBeNull()
    chooseOption(screen.getByRole('combobox', { name: '출처' }), 'KSTARTUP')
    const toggle = screen.getByRole('button', { name: /K-Startup 추가 조건/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('combobox', { name: '창업 업력' })).toBeNull()
    fireEvent.click(toggle)
    const fields = [
      { label: '창업 업력', values: defaultCatalogStartupStages, value: '3년미만', extra: '특화 창업자' },
      { label: '신청 대상', values: defaultCatalogApplicantTypes, value: '일반기업', extra: '사회적기업' },
      { label: '대표자 연령', values: defaultCatalogFounderAges, value: '만 40세 이상', extra: '연령 제한 없음' },
    ]
    const inputs = fields.map(({ label, values, value }) => {
      const input = screen.getByRole('combobox', { name: label })
      expect(optionValues(input)).toEqual(['', ...values])
      chooseOption(input, value)
      return input
    })
    expect(screen.getByText(/공고 분류 기준입니다/)).toBeTruthy()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await act(async () => complete(Response.json(startupCatalog)))
    fields.forEach(({ label, values, value, extra }, index) => {
      const input = screen.getByRole('combobox', { name: label })
      expect(input).toBe(inputs[index])
      expect(selectedValue(input)).toBe(value)
      expect(optionValues(input)).toEqual(['', ...values, extra])
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(screen.queryByRole('combobox', { name: '창업 업력' })).toBeNull()
    expect(toggle.textContent).toContain('3개 선택')
    fireEvent.click(screen.getByRole('button', { name: '검색' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const request = new URL(fetchMock.mock.calls[1][0])
    for (const [key, value] of Object.entries(startupParams)) expect(request.searchParams.get(key)).toBe(value)
    await screen.findByRole('link', { name: startupProgram.title })
    expect(selectedValue(screen.getByRole('combobox', { name: '창업 업력' }))).toBe('3년미만')
  })

  it.each(['', 'BIZINFO'])('출처를 %j로 바꾸면 추가 조건을 비우고 검색 시 URL과 요청에서 제외한다', async (sourceCode) => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => Response.json(new URL(url).searchParams.get('sourceCode') === 'BIZINFO' ? catalog : startupCatalog))
    vi.stubGlobal('fetch', fetchMock)
    start('/?mode=filter&' + new URLSearchParams({ ...startupParams, keyword: '창업', region: '서울' }))
    await screen.findByRole('link', { name: startupProgram.title })
    chooseOption(screen.getByRole('combobox', { name: '출처' }), sourceCode)
    expect(screen.queryByRole('button', { name: /K-Startup 추가 조건/ })).toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
    chooseOption(screen.getByRole('combobox', { name: '출처' }), 'KSTARTUP')
    fireEvent.click(screen.getByRole('button', { name: /K-Startup 추가 조건/ }))
    for (const label of ['창업 업력', '신청 대상', '대표자 연령']) {
      expect(selectedValue(screen.getByRole('combobox', { name: label }))).toBe('')
    }
    chooseOption(screen.getByRole('combobox', { name: '출처' }), sourceCode)
    fireEvent.click(screen.getByRole('button', { name: '검색' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const request = new URL(fetchMock.mock.calls[1][0])
    const browser = new URL(screen.getByTestId('location').textContent!, 'https://app.example')
    for (const params of [request.searchParams, browser.searchParams]) {
      expect(params.get('sourceCode')).toBe(sourceCode || null)
      for (const key of ['startupStage', 'applicantType', 'founderAge']) expect(params.has(key)).toBe(false)
      expect(params.get('keyword')).toBe('창업')
      expect(params.get('region')).toBe('서울')
    }
    await screen.findByRole('link', { name: sourceCode === 'BIZINFO' ? program.title : startupProgram.title })
  })

  it('추가 조건 검색은 첫 페이지로 이동하고 이전 조회를 취소하며 초기화로 전부 지운다', async () => {
    let complete!: (response: Response) => void
    const fetchMock = vi.fn().mockReturnValueOnce(new Promise<Response>((resolve) => { complete = resolve }))
      .mockImplementation(async () => Response.json(startupCatalog))
    vi.stubGlobal('fetch', fetchMock)
    start('/?mode=filter&sourceCode=KSTARTUP&page=2')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: /K-Startup 추가 조건/ }))
    chooseOption(screen.getByRole('combobox', { name: '창업 업력' }), '예비창업자')
    fireEvent.click(screen.getByRole('button', { name: '검색' }))
    await screen.findByRole('link', { name: startupProgram.title })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    const request = new URL(fetchMock.mock.calls[1][0])
    expect(request.searchParams.get('page')).toBe('1')
    expect(request.searchParams.get('sourceCode')).toBe('KSTARTUP')
    expect(request.searchParams.get('startupStage')).toBe('예비창업자')
    expect(new URL(screen.getByTestId('location').textContent!, 'https://app.example').searchParams.has('page')).toBe(false)
    await act(async () => complete(Response.json({ ...catalog, page: 2, programs: [], total: 0, totalPages: 0 })))
    expect(screen.getByRole('link', { name: startupProgram.title })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '필터 초기화' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(screen.getByTestId('location').textContent).toBe('/?mode=filter')
    expect(selectedValue(screen.getByRole('combobox', { name: '출처' }))).toBe('')
    expect(screen.queryByRole('button', { name: /K-Startup 추가 조건/ })).toBeNull()
    await screen.findByRole('link', { name: startupProgram.title })
  })

  it('뒤로 가기에서 출처·추가 조건과 목록에 없는 선택값을 복원한다', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => Response.json(new URL(url).searchParams.get('sourceCode') === 'BIZINFO' ? catalog : startupCatalog))
    vi.stubGlobal('fetch', fetchMock)
    const original = { ...startupParams, startupStage: '이전 공고 분류' }
    start('/?mode=filter&' + new URLSearchParams(original))
    await screen.findByRole('link', { name: startupProgram.title })
    expect(selectedValue(screen.getByRole('combobox', { name: '창업 업력' }))).toBe(original.startupStage)
    chooseOption(screen.getByRole('combobox', { name: '출처' }), 'BIZINFO')
    fireEvent.click(screen.getByRole('button', { name: '검색' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await screen.findByRole('link', { name: program.title })
    fireEvent.click(screen.getByRole('button', { name: '테스트 뒤로' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const request = new URL(fetchMock.mock.calls[2][0])
    for (const [key, value] of Object.entries(original)) expect(request.searchParams.get(key)).toBe(value)
    expect(selectedValue(screen.getByRole('combobox', { name: '창업 업력' }))).toBe(original.startupStage)
    expect(selectedValue(screen.getByRole('combobox', { name: '신청 대상' }))).toBe(original.applicantType)
    await screen.findByRole('link', { name: startupProgram.title })
  })

  it('K-Startup 오류 재시도는 적용 조건을 유지하고 미적용 추가 조건을 덮어쓰지 않는다', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(Response.json(startupCatalog))
    vi.stubGlobal('fetch', fetchMock)
    start('/?mode=filter&' + new URLSearchParams(startupParams))
    await screen.findByRole('button', { name: '다시 불러오기' })
    chooseOption(screen.getByRole('combobox', { name: '창업 업력' }), '예비창업자')
    fireEvent.click(screen.getByRole('button', { name: '다시 불러오기' }))
    await screen.findByRole('link', { name: startupProgram.title })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[0][0])
    expect(selectedValue(screen.getByRole('combobox', { name: '창업 업력' }))).toBe('예비창업자')
  })

  it.each([
    { name: '출처 무시', params: { sourceCode: 'KSTARTUP' }, body: catalog },
    { name: '추가 조건 미지원', params: startupParams, body: { ...catalog, programs: [startupProgram] } },
  ])('구 서버의 $name 응답을 결과로 표시하지 않고 조건을 보존해 수동 재시도한다', async ({ params, body }) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(body)).mockResolvedValueOnce(Response.json(startupCatalog))
    vi.stubGlobal('fetch', fetchMock)
    start('/?mode=filter&' + new URLSearchParams(params))
    await screen.findByRole('button', { name: '다시 불러오기' })
    expect(screen.queryByRole('link', { name: program.title })).toBeNull()
    expect(screen.queryByRole('link', { name: startupProgram.title })).toBeNull()
    expect(screen.queryByText('조건에 맞는 공고가 없어요.')).toBeNull()
    expect(selectedValue(screen.getByRole('combobox', { name: '출처' }))).toBe('KSTARTUP')
    expect(fetchMock).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '다시 불러오기' }))
    await screen.findByRole('link', { name: startupProgram.title })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[0][0])
  })

  it.each(['/', '/app/chat'])('%s의 K-Startup 상세 복귀에 추가 조건을 보존하고 미지원 질문을 열지 않는다', async (path) => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => Response.json(url.includes('/catalog?') ? startupCatalog : startupProgram))
    vi.stubGlobal('fetch', fetchMock)
    start(path + '?mode=filter&' + new URLSearchParams(startupParams))
    fireEvent.click(await screen.findByRole('link', { name: startupProgram.title }))
    await screen.findByRole('heading', { name: startupProgram.title })
    expect(screen.queryByRole('link', { name: '이 공고에 질문하기' })).toBeNull()
    expect(screen.getByText(/이 제공처 공고는 아직 원문 근거 답변을 지원하지 않습니다/)).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }))
    await screen.findByRole('link', { name: startupProgram.title })
    expect(selectedValue(screen.getByRole('combobox', { name: '출처' }))).toBe('KSTARTUP')
    expect(selectedValue(screen.getByRole('combobox', { name: '창업 업력' }))).toBe(startupParams.startupStage)
    const params = new URL(screen.getByTestId('location').textContent!, 'https://app.example').searchParams
    for (const [key, value] of Object.entries(startupParams)) expect(params.get(key)).toBe(value)
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/question'))).toBe(true)
  })

  it.each(['/', '/app/chat'])('%s에서 대화 입력 보존·키보드 탭 전환·AI 없이 조회한다', async (path) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(catalog))
    vi.stubGlobal('fetch', fetchMock)
    start(path)
    fireEvent.change(screen.getByRole('textbox', { name: '지원사업 검색어' }), { target: { value: '대화 초안' } })
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'AI 대화 검색' }), { key: 'ArrowRight' })
    await screen.findByRole('link', { name: program.title })
    expect(screen.getByRole('tab', { name: '필터 검색' }).getAttribute('aria-selected')).toBe('true')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0][0])).toContain('/catalog?')
    expect(screen.queryByText(/조건 확인 공고/)).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'AI 대화 검색' }))
    expect((screen.getByRole('textbox', { name: '지원사업 검색어' }) as HTMLTextAreaElement).value).toBe('대화 초안')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('지역·분야 전체 선택지를 접근 가능한 라디오 목록으로 바로 보여준다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(catalog))
    vi.stubGlobal('fetch', fetchMock)
    start()
    await screen.findByRole('link', { name: program.title })
    const regionGroup = within(screen.getByRole('group', { name: '지역' }))
    const categoryGroup = within(screen.getByRole('group', { name: '분야' }))
    expect(regionGroup.getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual(['', ...defaultCatalogRegions])
    expect(categoryGroup.getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual(['', ...defaultCatalogCategories])
    expect(screen.queryByRole('combobox', { name: '지역' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: '분야' })).toBeNull()
    expect((regionGroup.getByRole('radio', { name: '전체 지역' }) as HTMLInputElement).checked).toBe(true)
    expect((categoryGroup.getByRole('radio', { name: '전체 분야' }) as HTMLInputElement).checked).toBe(true)
    const seoul = regionGroup.getByRole('radio', { name: '서울' }) as HTMLInputElement
    seoul.focus()
    expect(document.activeElement).toBe(seoul)
    fireEvent.click(seoul)
    fireEvent.click(regionGroup.getByRole('radio', { name: '경북' }))
    expect(seoul.checked).toBe(false)
    expect((regionGroup.getByRole('radio', { name: '경북' }) as HTMLInputElement).checked).toBe(true)
    expect(regionGroup.getByRole('radio', { name: '경북' }).nextElementSibling?.classList.contains('peer-checked:hover:text-white')).toBe(true)
    expect(regionGroup.getAllByRole('radio').every((radio) => (radio as HTMLInputElement).name === seoul.name)).toBe(true)
    expect(seoul.name).not.toBe((categoryGroup.getByRole('radio', { name: '전체 분야' }) as HTMLInputElement).name)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each(['/', '/app/chat'])('%s에서 첫 응답 전부터 모든 기본 버튼을 표시하고 응답 후에도 버튼·초안을 유지한다', async (path) => {
    let resolve!: (response: Response) => void
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((done) => { resolve = done }))
    vi.stubGlobal('fetch', fetchMock)
    start(`${path}?mode=filter`)
    const form = screen.getByRole('form', { name: '공고 필터' })
    const regions = within(screen.getByRole('group', { name: '지역' })).getAllByRole('radio')
    const categories = within(screen.getByRole('group', { name: '분야' })).getAllByRole('radio')
    expect(regions.map((radio) => (radio as HTMLInputElement).value)).toEqual(['', ...defaultCatalogRegions])
    expect(categories.map((radio) => (radio as HTMLInputElement).value)).toEqual(['', ...defaultCatalogCategories])
    expect(within(form).queryByRole('status')).toBeNull()
    expect(within(screen.getByRole('region', { name: '필터 검색 결과' })).getByRole('status').textContent).toContain('공고를 불러오고 있어요')
    fireEvent.click(screen.getByRole('radio', { name: '부산' }))
    fireEvent.click(screen.getByRole('radio', { name: '창업' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '편집 중' } })
    const focusedRadio = screen.getByRole('radio', { name: '창업' })
    focusedRadio.focus()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await act(async () => resolve(Response.json(catalog)))
    expect(within(form).queryByRole('status')).toBeNull()
    within(screen.getByRole('group', { name: '지역' })).getAllByRole('radio').forEach((radio, index) => expect(radio).toBe(regions[index]))
    within(screen.getByRole('group', { name: '분야' })).getAllByRole('radio').forEach((radio, index) => expect(radio).toBe(categories[index]))
    expect((screen.getByRole('radio', { name: '부산' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: '창업' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('편집 중')
    expect(document.activeElement).toBe(focusedRadio)
    expect(screen.getByTestId('location').textContent).toBe(`${path}?mode=filter`)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('첫 조회 중에도 기본 필터로 검색하고 이전 응답은 취소한다', async () => {
    let resolve!: (response: Response) => void
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done }))
      .mockResolvedValueOnce(Response.json(catalog))
    vi.stubGlobal('fetch', fetchMock)
    start()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('radio', { name: '전국' }))
    fireEvent.click(screen.getByRole('radio', { name: '수출' }))
    fireEvent.click(screen.getByRole('button', { name: '검색' }))
    await screen.findByRole('link', { name: program.title })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    const request = new URL(fetchMock.mock.calls[1][0])
    expect(request.searchParams.get('region')).toBe('전국')
    expect(request.searchParams.get('category')).toBe('수출')
    await act(async () => resolve(Response.json({ ...catalog, programs: [], total: 0, totalPages: 0 })))
    expect(screen.getByRole('link', { name: program.title })).toBeTruthy()
    expect((screen.getByRole('radio', { name: '전국' }) as HTMLInputElement).checked).toBe(true)
  })

  it('빈 카탈로그에서도 기본 버튼을 유지하고 결과만 0건으로 표시한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...catalog, programs: [], total: 0, totalPages: 0, regions: [], categories: [] })))
    start()
    await screen.findByText('조건에 맞는 공고가 없어요.')
    expect(within(screen.getByRole('group', { name: '지역' })).getAllByRole('radio')).toHaveLength(19)
    expect(within(screen.getByRole('group', { name: '분야' })).getAllByRole('radio')).toHaveLength(19)
    fireEvent.click(screen.getByRole('radio', { name: '서울' }))
    fireEvent.click(screen.getByRole('radio', { name: '수출' }))
    expect((screen.getByRole('radio', { name: '서울' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: '수출' }) as HTMLInputElement).checked).toBe(true)
  })

  it('서버의 새 분류를 기본 목록 뒤에 중복 없이 추가하고 정확한 값으로 검색한다', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ ...catalog,
      regions: ['서울특별시', '서울'], categories: ['AI', '수출'] }))
    vi.stubGlobal('fetch', fetchMock)
    start()
    await screen.findByRole('link', { name: program.title })
    expect(within(screen.getByRole('group', { name: '지역' })).getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual(['', ...defaultCatalogRegions, '서울특별시'])
    expect(within(screen.getByRole('group', { name: '분야' })).getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual(['', ...defaultCatalogCategories, 'AI'])
    fireEvent.click(screen.getByRole('radio', { name: '서울특별시' }))
    fireEvent.click(screen.getByRole('radio', { name: 'AI' }))
    fireEvent.click(screen.getByRole('button', { name: '검색' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const request = new URL(fetchMock.mock.calls[1][0])
    expect(request.searchParams.get('region')).toBe('서울특별시')
    expect(request.searchParams.get('category')).toBe('AI')
  })

  it('편집만으로 요청하지 않고 검색으로 필터 적용·초기화를 수행한다', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json(catalog))
    vi.stubGlobal('fetch', fetchMock)
    start()
    await screen.findByRole('link', { name: program.title })
    fireEvent.click(screen.getByRole('radio', { name: '서울' }))
    fireEvent.click(screen.getByRole('radio', { name: '수출' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: ' 바우처 ' } })
    expect(fetchMock).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '검색' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const request = new URL(fetchMock.mock.calls[1][0])
    expect(request.searchParams.get('keyword')).toBe('바우처')
    expect(request.searchParams.get('region')).toBe('서울')
    expect(request.searchParams.get('category')).toBe('수출')
    await screen.findByRole('link', { name: program.title })
    fireEvent.click(screen.getByRole('button', { name: '필터 초기화' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
    expect((screen.getByRole('radio', { name: '전체 지역' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: '전체 분야' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('location').textContent).toBe('/?mode=filter')
  })

  it('미적용 초안도 초기화 버튼으로 지운다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json(catalog)))
    start()
    await screen.findByRole('link', { name: program.title })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '적용 전' } })
    fireEvent.click(screen.getByRole('radio', { name: '서울' }))
    fireEvent.click(screen.getByRole('radio', { name: '수출' }))
    fireEvent.click(screen.getByRole('button', { name: '필터 초기화' }))
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
    expect((screen.getByRole('radio', { name: '전체 지역' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: '전체 분야' }) as HTMLInputElement).checked).toBe(true)
  })

  it.each(['/', '/app/chat'])('%s에서 공고 상세·질문 왕복 시 필터 탭과 조건을 복원한다', async (path) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => Response.json(url.includes('/catalog?') ? catalog : program)))
    start(`${path}?mode=filter&region=%EC%84%9C%EC%9A%B8&category=%EC%88%98%EC%B6%9C`)
    const detailPath = path.startsWith('/app') ? '/app/support-programs/detail' : '/support-programs/detail'
    expect((await screen.findByRole('link', { name: program.title })).getAttribute('href')).toContain(`${detailPath}?`)
    fireEvent.click(await screen.findByRole('link', { name: program.title }))
    await screen.findByRole('heading', { name: program.title })
    if (path.startsWith('/app')) {
      fireEvent.click(screen.getByRole('link', { name: '이 공고에 질문하기' }))
      expect(screen.getByTestId('location').textContent).toContain(`${detailPath}/question?`)
      fireEvent.click(screen.getByRole('link', { name: '← 공고 상세로 돌아가기' }))
      await screen.findByRole('heading', { name: program.title })
    } else {
      // 원문 질문은 회원 기능이라 비로그인은 로그인 링크만 봅니다.
      expect(screen.getByRole('link', { name: '로그인하고 이 공고에 질문하기' })).toBeTruthy()
    }
    const back = screen.getByRole('link', { name: '← 검색 결과로 돌아가기' })
    expect(back.getAttribute('href')).toContain(`${path}?mode=filter`)
    fireEvent.click(back)
    await screen.findByRole('link', { name: program.title })
    expect(screen.getByRole('tab', { name: '필터 검색' }).getAttribute('aria-selected')).toBe('true')
    expect((screen.getByRole('radio', { name: '서울' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: '수출' }) as HTMLInputElement).checked).toBe(true)
  })

  it('로그인한 사용자의 공개 필터 URL을 조건과 함께 작업 화면으로 옮긴다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(catalog)))
    start('/?mode=filter&region=%EC%84%9C%EC%9A%B8&category=%EC%88%98%EC%B6%9C', true)
    await screen.findByRole('link', { name: program.title })
    expect(screen.getByTestId('location').textContent).toBe('/app/chat?mode=filter&region=%EC%84%9C%EC%9A%B8&category=%EC%88%98%EC%B6%9C')
    expect((screen.getByRole('radio', { name: '서울' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: '수출' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('complementary', { name: '작업 사이드바' })).toBeTruthy()
  })

  it('비로그인 사용자는 내부 필터 화면 대신 복귀 조건을 보존한 로그인 화면으로 보낸다', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const path = '/app/chat?mode=filter&region=%EC%84%9C%EC%9A%B8'
    start(path, false)
    const location = new URL(screen.getByTestId('location').textContent!, 'https://app.example')
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('next')).toBe(path)
    expect(screen.queryByRole('tab', { name: '필터 검색' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('현재 목록에 없는 URL 조건도 선택 상태를 잃지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(catalog)))
    start(`/?mode=filter&${new URLSearchParams({ region: '서울특별시', category: 'AI' })}`)
    expect((screen.getByRole('radio', { name: '서울특별시' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: 'AI' }) as HTMLInputElement).checked).toBe(true)
    await screen.findByRole('link', { name: program.title })
    expect((screen.getByRole('radio', { name: '서울특별시' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: 'AI' }) as HTMLInputElement).checked).toBe(true)
  })

  it('URL 페이지와 정렬을 복원하고 변경 시 첫 페이지로 이동한다', async () => {
    const programs = Array.from({ length: 12 }, (_, index) => ({ ...program, id: `page1-${index}` }))
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'))
      return Response.json({ ...catalog, total: 13, totalPages: 2, page, programs: page === 2 ? [program] : programs })
    })
    vi.stubGlobal('fetch', fetchMock)
    start('/?mode=filter&page=2&sort=DEADLINE')
    await screen.findByRole('link', { name: program.title })
    expect(screen.getByRole('button', { name: '2페이지' }).getAttribute('aria-current')).toBe('page')
    chooseOption(screen.getByRole('combobox', { name: '공고 정렬' }), 'RECENT')
    await waitFor(() => expect(screen.getAllByRole('link', { name: program.title })).toHaveLength(12))
    expect(screen.getByRole('button', { name: '1페이지' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(screen.getByRole('button', { name: '다음' }))
    await waitFor(() => expect(screen.getAllByRole('link', { name: program.title })).toHaveLength(1))
  })

  it('오류를 0건으로 숨기지 않고 수동 재시도한다', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(Response.json(catalog))
    vi.stubGlobal('fetch', fetchMock)
    start()
    await screen.findByRole('button', { name: '다시 불러오기' })
    const form = screen.getByRole('form', { name: '공고 필터' })
    expect(within(form).queryByRole('status')).toBeNull()
    expect(within(form).getAllByRole('radio')).toHaveLength(38)
    expect(within(screen.getByRole('region', { name: '필터 검색 결과' })).getByRole('alert')).toBeTruthy()
    expect(screen.queryByText('조건에 맞는 공고가 없어요.')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: '서울' }))
    fireEvent.click(screen.getByRole('radio', { name: '수출' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '미적용 검색어' } })
    expect(fetchMock).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '다시 불러오기' }))
    await screen.findByRole('link', { name: program.title })
    expect(within(form).getAllByRole('radio')).toHaveLength(38)
    expect((screen.getByRole('radio', { name: '서울' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: '수출' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('미적용 검색어')
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[0][0])
  })

  it('탭을 떠날 때 조회를 취소하고 늦은 응답을 무시한다', async () => {
    let resolve!: (response: Response) => void
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((done) => { resolve = done }))
    vi.stubGlobal('fetch', fetchMock)
    start()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('tab', { name: 'AI 대화 검색' }))
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    await act(async () => resolve(Response.json(catalog)))
    expect(screen.queryByRole('link', { name: program.title })).toBeNull()
  })

  it('조회가 멈춰도 10초 뒤 오류를 표시한다', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    start()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001) })
    expect(screen.getByRole('button', { name: '다시 불러오기' })).toBeTruthy()
    expect(within(screen.getByRole('form', { name: '공고 필터' })).getAllByRole('radio')).toHaveLength(38)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it.each(['//evil.example/?mode=filter', 'https://evil.example', '/admin?mode=filter', '/app/chat/../admin?mode=filter', '/app/admin?mode=filter'])('외부·허용되지 않은 복귀 주소를 차단한다 %s', (searchReturnTo) => {
    expect(getSupportProgramSearchReturnTo({ searchReturnTo })).toBe('/')
  })
})
