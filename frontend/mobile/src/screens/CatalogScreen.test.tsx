import { act, fireEvent, render, screen, within } from '@testing-library/react-native'
import type { SupportProgramCatalogFilters } from '@govbiz/shared/domain/entities/SupportProgramCatalog'
import { CatalogScreen, initialFilters } from './CatalogScreen'
import { programClient } from '../api/client'

jest.mock('../api/client', () => ({ programClient: jest.fn(), errorMessage: () => '검색 조건을 확인해 주세요.' }))

const emptyPage = { programs: [], total: 0, page: 1, pageSize: 12, totalPages: 0, regions: [], categories: [],
  startupStages: [], applicantTypes: [], founderAges: [] }
const pendingNotice = '변경한 조건은 아직 적용되지 않았어요. 공고 검색을 눌러 적용해 주세요.'
const summary = () => within(screen.getByTestId('catalog-condition-summary'))

function choose(label: string, current: string, option: string) {
  fireEvent.press(screen.getByRole('button', { name: `${label}: ${current}` }))
  fireEvent.press(screen.getByRole('radio', { name: option }))
}

let browseCatalog: jest.Mock
beforeEach(() => {
  browseCatalog = jest.fn().mockResolvedValue(emptyPage)
  jest.mocked(programClient).mockReturnValue({ browseCatalog } as unknown as ReturnType<typeof programClient>)
})

describe('native catalog', () => {
  it('keeps draft input local until search and shows validation errors without crashing', async () => {
    render(<CatalogScreen onOpenProgram={jest.fn()} />)
    await screen.findByText('검색 결과 0건')
    expect(screen.getByText('적용된 검색 조건')).toBeTruthy()
    expect(summary().getByText('접수 상태: 접수 중')).toBeTruthy()
    fireEvent.changeText(screen.getByLabelText('공고명·기관명'), 'invalid\u200bkeyword')
    expect(browseCatalog).toHaveBeenCalledTimes(1)
    expect(screen.getByText(pendingNotice)).toBeTruthy()
    expect(summary().queryByText('검색어: invalid\u200bkeyword')).toBeNull()
    fireEvent.press(screen.getByText('공고 검색'))
    await screen.findByText('검색 조건을 확인해 주세요.')
    expect(browseCatalog).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('검색 결과 0건')).toBeNull()
    expect(screen.queryByText('적용된 검색 조건')).toBeNull()
    expect(screen.getByText('조회에 실패한 검색 조건')).toBeTruthy()
  })

  it('does not let a late old response overwrite the latest search', async () => {
    let resolveOld: (value: typeof emptyPage) => void = () => undefined
    browseCatalog.mockImplementationOnce(() => new Promise<typeof emptyPage>((resolve) => { resolveOld = resolve }))
    render(<CatalogScreen onOpenProgram={jest.fn()} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '새 검색')
    fireEvent.press(screen.getByText('공고 검색'))
    await screen.findByText('검색 결과 0건')
    await act(async () => { resolveOld({ ...emptyPage, total: 999 }) })
    expect(screen.queryByText('검색 결과 999건')).toBeNull()
    expect(screen.getByText('검색 결과 0건')).toBeTruthy()
    expect(summary().getByText('검색어: 새 검색')).toBeTruthy()
  })

  it('summarizes the searched conditions while details are collapsed and keeps draft choices separate', async () => {
    render(<CatalogScreen onOpenProgram={jest.fn()} />)
    await screen.findByText('검색 결과 0건')
    expect(summary().getByText('지역: 전체')).toBeTruthy()
    expect(summary().getByText('분야: 전체')).toBeTruthy()
    expect(summary().getByText('출처: 전체')).toBeTruthy()
    expect(summary().getByText('정렬: 최신순')).toBeTruthy()
    fireEvent.press(screen.getByRole('button', { name: '지역·분야·접수 조건' }))
    choose('지역', '전체', '서울')
    choose('분야', '전체', '기술')
    choose('출처', '전체 출처', '기업마당')
    choose('접수 상태', '접수 중', '접수 예정')
    choose('정렬', '최신순', '마감일순')
    fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '  창업 지원  ')
    expect(browseCatalog).toHaveBeenCalledTimes(1)
    expect(summary().getByText('지역: 전체')).toBeTruthy()
    expect(summary().queryByText('검색어: 창업 지원')).toBeNull()
    expect(screen.getByText(pendingNotice)).toBeTruthy()
    fireEvent.press(screen.getByRole('button', { name: '공고 검색' }))
    await screen.findByText('검색 결과 0건')
    expect(browseCatalog).toHaveBeenLastCalledWith({ ...initialFilters, keyword: '창업 지원', region: '서울',
      category: '기술', sourceCode: 'BIZINFO', status: 'UPCOMING', sort: 'DEADLINE' }, expect.any(AbortSignal))
    for (const label of ['검색어: 창업 지원', '지역: 서울', '분야: 기술', '출처: 기업마당', '접수 상태: 접수 예정', '정렬: 마감일순']) {
      expect(summary().getByText(label)).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: '지역: 서울' })).toBeNull()
    expect(screen.queryByText(pendingNotice)).toBeNull()
  })

  it('keeps applied filters on page changes, ignores surrounding whitespace and applies keyboard searches from page one', async () => {
    browseCatalog.mockImplementation(async (filters: SupportProgramCatalogFilters) => ({ ...emptyPage, total: 25, totalPages: 3, page: filters.page }))
    render(<CatalogScreen onOpenProgram={jest.fn()} />)
    await screen.findByText('1 / 3')
    fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '  수출  ')
    fireEvent(screen.getByLabelText('공고명·기관명'), 'submitEditing')
    await screen.findByText('적용된 검색 조건')
    expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: '수출', page: 1 }), expect.any(AbortSignal))
    fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '수출 ')
    expect(screen.queryByText(pendingNotice)).toBeNull()
    fireEvent.press(screen.getByRole('button', { name: '다음' }))
    await screen.findByText('2 / 3')
    expect(screen.queryByText(pendingNotice)).toBeNull()
    fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '다른 검색어')
    fireEvent.press(screen.getByRole('button', { name: '다음' }))
    await screen.findByText('3 / 3')
    expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: '수출', page: 3 }), expect.any(AbortSignal))
    expect(summary().getByText('검색어: 수출')).toBeTruthy()
    expect(summary().queryByText('검색어: 다른 검색어')).toBeNull()
    expect(screen.getByText(pendingNotice)).toBeTruthy()
    fireEvent(screen.getByLabelText('공고명·기관명'), 'submitEditing')
    await screen.findByText('1 / 3')
    expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: '다른 검색어', page: 1 }), expect.any(AbortSignal))
    expect(summary().getByText('검색어: 다른 검색어')).toBeTruthy()
    expect(screen.queryByText(pendingNotice)).toBeNull()
  })

  it('retains applied K-Startup classifications until a source change is searched and resets all filters', async () => {
    render(<CatalogScreen onOpenProgram={jest.fn()} />)
    await screen.findByText('검색 결과 0건')
    fireEvent.press(screen.getByRole('button', { name: '지역·분야·접수 조건' }))
    choose('출처', '전체 출처', 'K-Startup')
    choose('창업 업력', '전체', '예비창업자')
    choose('신청 대상', '전체', '일반인')
    choose('대표자 연령', '전체', '만 40세 이상')
    fireEvent.press(screen.getByRole('button', { name: '공고 검색' }))
    await screen.findByText('적용된 검색 조건')
    expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ sourceCode: 'KSTARTUP', startupStage: '예비창업자',
      applicantType: '일반인', founderAge: '만 40세 이상' }), expect.any(AbortSignal))
    fireEvent.press(screen.getByRole('button', { name: '지역·분야·접수 조건' }))
    choose('출처', 'K-Startup', '기업마당')
    for (const label of ['출처: K-Startup', '창업 업력: 예비창업자', '신청 대상: 일반인', '대표자 연령: 만 40세 이상']) {
      expect(summary().getByText(label)).toBeTruthy()
    }
    expect(screen.getByText(pendingNotice)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '창업 업력: 예비창업자' })).toBeNull()
    fireEvent.press(screen.getByRole('button', { name: '공고 검색' }))
    await screen.findByText('적용된 검색 조건')
    expect(summary().getByText('출처: 기업마당')).toBeTruthy()
    expect(summary().queryByText('창업 업력: 예비창업자')).toBeNull()
    expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ sourceCode: 'BIZINFO', startupStage: '',
      applicantType: '', founderAge: '' }), expect.any(AbortSignal))
    fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '적용하지 않은 입력')
    fireEvent.press(screen.getByRole('button', { name: '조건 초기화' }))
    await screen.findByText('적용된 검색 조건')
    expect(browseCatalog).toHaveBeenLastCalledWith(initialFilters, expect.any(AbortSignal))
    expect(summary().getByText('출처: 전체')).toBeTruthy()
    expect(summary().getByText('접수 상태: 접수 중')).toBeTruthy()
    expect(screen.getByDisplayValue('')).toBeTruthy()
    expect(screen.queryByText(pendingNotice)).toBeNull()
  })

  it('marks pending and failed requests separately and retries the requested filters without applying draft edits', async () => {
    render(<CatalogScreen onOpenProgram={jest.fn()} />)
    await screen.findByText('검색 결과 0건')
    let rejectSearch!: (cause: Error) => void
    browseCatalog.mockImplementationOnce(() => new Promise((_, reject) => { rejectSearch = reject }))
    fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '실패한 검색')
    fireEvent.press(screen.getByRole('button', { name: '공고 검색' }))
    expect(screen.getByText('조회 중인 검색 조건')).toBeTruthy()
    expect(screen.queryByText('검색 결과 0건')).toBeNull()
    expect(screen.queryByText('적용된 검색 조건')).toBeNull()
    expect(summary().getByText('검색어: 실패한 검색')).toBeTruthy()
    await act(async () => { await Promise.resolve() })
    await act(async () => { rejectSearch(new Error('network error')) })
    expect(screen.getByText('조회에 실패한 검색 조건')).toBeTruthy()
    expect(screen.queryByText('적용된 검색 조건')).toBeNull()
    fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '아직 검색하지 않은 입력')
    fireEvent.press(screen.getByRole('button', { name: '다시 불러오기' }))
    await screen.findByText('검색 결과 0건')
    expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: '실패한 검색' }), expect.any(AbortSignal))
    expect(summary().getByText('검색어: 실패한 검색')).toBeTruthy()
    expect(summary().queryByText('검색어: 아직 검색하지 않은 입력')).toBeNull()
    expect(screen.getByText(pendingNotice)).toBeTruthy()
  })

  it.each([1, 2])('keeps the all-status default and reset in a %i-program selection screen', async (maximum) => {
    render(<CatalogScreen onOpenProgram={jest.fn()} selection={{ maximum, keys: [], onToggle: jest.fn() }} />)
    await screen.findByText('검색 결과 0건')
    expect(summary().getByText('접수 상태: 전체')).toBeTruthy()
    expect(browseCatalog).toHaveBeenLastCalledWith({ ...initialFilters, status: 'ALL' }, expect.any(AbortSignal))
    fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '선택할 사업')
    fireEvent.press(screen.getByRole('button', { name: '공고 검색' }))
    await screen.findByText('적용된 검색 조건')
    expect(summary().getByText('검색어: 선택할 사업')).toBeTruthy()
    fireEvent.press(screen.getByRole('button', { name: '조건 초기화' }))
    await screen.findByText('적용된 검색 조건')
    expect(summary().getByText('접수 상태: 전체')).toBeTruthy()
    expect(summary().queryByText('검색어: 선택할 사업')).toBeNull()
    expect(browseCatalog).toHaveBeenLastCalledWith({ ...initialFilters, status: 'ALL' }, expect.any(AbortSignal))
    expect(screen.queryByText(pendingNotice)).toBeNull()
  })
})
