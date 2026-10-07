import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { SupportProgramCatalogFilters } from '@govbiz/shared/domain/entities/SupportProgramCatalog'
import { regionNames } from '@govbiz/shared/domain/entities/Region'
import { supportProgramCategories } from '@govbiz/shared/domain/entities/SupportProgramCategory'
import { CatalogScreen, initialFilters } from './CatalogScreen'
import { programClient } from '../api/client'

jest.mock('../api/client', () => ({ programClient: jest.fn(), errorMessage: () => '검색 조건을 확인해 주세요.' }))
const emptyPage = { programs: [], total: 0, page: 1, pageSize: 12, totalPages: 0, regions: [], categories: [], startupStages: [], applicantTypes: [], founderAges: [] }
let browseCatalog: jest.Mock
beforeEach(() => {
  browseCatalog = jest.fn().mockResolvedValue(emptyPage)
  jest.mocked(programClient).mockReturnValue({ browseCatalog } as unknown as ReturnType<typeof programClient>)
})
function choose(label: string, current: string, value: string) {
  fireEvent.press(screen.getByRole('button', { name: `${label}: ${current}` }))
  fireEvent.press(screen.getByRole('radio', { name: value }))
}
async function openFilters() {
  await screen.findByText('검색 결과 0건')
  fireEvent.press(screen.getByLabelText('공고 필터 열기'))
}

test('keyboard search keeps draft input local and rejects invalid input before an HTTP request', async () => {
  render(<CatalogScreen onOpenProgram={jest.fn()} />)
  await screen.findByText('검색 결과 0건')
  fireEvent.changeText(screen.getByLabelText('공고명·기관명'), 'invalid\u200bkeyword')
  expect(browseCatalog).toHaveBeenCalledTimes(1)
  fireEvent(screen.getByLabelText('공고명·기관명'), 'submitEditing')
  await screen.findByText('검색 조건을 확인해 주세요.')
  expect(browseCatalog).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('검색 결과 0건')).toBeNull()
})

test('the single filter sheet includes web defaults and provider additions, and multiple choices apply immediately', async () => {
  browseCatalog.mockResolvedValue({ ...emptyPage, regions: ['제공처 추가 지역'], categories: ['추가 분야'] })
  render(<CatalogScreen onOpenProgram={jest.fn()} />)
  await openFilters()
  expect(screen.getAllByRole('checkbox', { name: /^지역 / })).toHaveLength(regionNames.length + 1)
  expect(screen.getAllByRole('checkbox', { name: /^분야 / })).toHaveLength(supportProgramCategories.length + 1)
  fireEvent.press(screen.getByLabelText('지역 서울'))
  await waitFor(() => expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ region: '서울', page: 1 }), expect.any(AbortSignal)))
  fireEvent.press(screen.getByLabelText('지역 경기'))
  fireEvent.press(screen.getByLabelText('분야 기술'))
  await waitFor(() => expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ region: '서울,경기', category: '기술' }), expect.any(AbortSignal)))
  fireEvent.press(screen.getByLabelText('지역 전체'))
  await waitFor(() => expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ region: '', category: '기술' }), expect.any(AbortSignal)))
  fireEvent.press(await screen.findByText('결과 0건 보기'))
  fireEvent.press(screen.getByLabelText('기술 조건 해제'))
  await waitFor(() => expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ category: '' }), expect.any(AbortSignal)))
})

test('K-Startup uses all official classifications and changing the provider clears its extra conditions', async () => {
  browseCatalog.mockResolvedValue({ ...emptyPage, startupStages: ['특화 창업자'] })
  render(<CatalogScreen onOpenProgram={jest.fn()} />)
  await openFilters()
  choose('출처', '전체 출처', 'K-Startup')
  await screen.findByText('K-Startup 추가 조건')
  fireEvent.press(screen.getByLabelText('창업 업력: 전체'))
  expect(screen.getAllByRole('radio')).toHaveLength(9)
  fireEvent.press(screen.getByRole('radio', { name: '2년미만' }))
  choose('신청 대상', '전체', '일반기업')
  choose('대표자 연령', '전체', '만 40세 이상')
  await waitFor(() => expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ sourceCode: 'KSTARTUP', startupStage: '2년미만', applicantType: '일반기업', founderAge: '만 40세 이상' }), expect.any(AbortSignal)))
  choose('출처', 'K-Startup', '기업마당')
  await waitFor(() => expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ sourceCode: 'BIZINFO', startupStage: '', applicantType: '', founderAge: '' }), expect.any(AbortSignal)))
  expect(screen.queryByText('K-Startup 추가 조건')).toBeNull()
})

test('all five statuses and the missing-period notice remain available', async () => {
  render(<CatalogScreen onOpenProgram={jest.fn()} />)
  await openFilters()
  choose('출처', '전체 출처', '과학기술정보통신부')
  expect(screen.getByText(/접수 기간을 제공하지 않는 공고/)).toBeTruthy()
  fireEvent.press(screen.getByLabelText('접수 상태: 접수 중'))
  expect(screen.getAllByRole('radio')).toHaveLength(5)
  for (const label of ['전체 접수 상태', '접수 중', '접수 예정', '접수 마감', '상태 확인 필요']) expect(screen.getByRole('radio', { name: label })).toBeTruthy()
  fireEvent.press(screen.getByRole('radio', { name: '상태 확인 필요' }))
  await waitFor(() => expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'UNKNOWN' }), expect.any(AbortSignal)))
})

test('a late cancelled response cannot overwrite the latest keyboard search', async () => {
  let resolveOld!: (value: typeof emptyPage) => void
  browseCatalog.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  render(<CatalogScreen onOpenProgram={jest.fn()} />)
  await act(async () => { await Promise.resolve() })
  fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '새 검색')
  fireEvent(screen.getByLabelText('공고명·기관명'), 'submitEditing')
  await screen.findByText('검색 결과 0건')
  await act(async () => resolveOld({ ...emptyPage, total: 999 }))
  expect(screen.queryByText('검색 결과 999건')).toBeNull()
  expect(screen.getByText('검색어: 새 검색 ×')).toBeTruthy()
})

test('pagination retains the submitted keyword and a changed filter starts at page one', async () => {
  browseCatalog.mockImplementation(async (filters: SupportProgramCatalogFilters) => ({ ...emptyPage, total: 25, totalPages: 3, page: filters.page }))
  render(<CatalogScreen onOpenProgram={jest.fn()} />)
  await screen.findByText('1 / 3')
  fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '  수출  ')
  fireEvent(screen.getByLabelText('공고명·기관명'), 'submitEditing')
  await waitFor(() => expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: '수출', page: 1 }), expect.any(AbortSignal)))
  fireEvent.press(screen.getByRole('button', { name: '다음' }))
  await screen.findByText('2 / 3')
  fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '미제출 검색어')
  fireEvent.press(screen.getByLabelText('공고 필터 열기'))
  fireEvent.press(screen.getByLabelText('지역 경기'))
  await waitFor(() => expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: '수출', region: '경기', page: 1 }), expect.any(AbortSignal)))
})

test.each([1, 2])('selection with a maximum of %i retains the all-status initial value and reset', async maximum => {
  render(<CatalogScreen onOpenProgram={jest.fn()} selection={{ maximum, keys: [], onToggle: jest.fn() }} />)
  await openFilters()
  expect(browseCatalog).toHaveBeenLastCalledWith({ ...initialFilters, status: 'ALL' }, expect.any(AbortSignal))
  fireEvent.press(screen.getByLabelText('지역 서울'))
  fireEvent.press(screen.getByText('초기화'))
  await waitFor(() => expect(browseCatalog).toHaveBeenLastCalledWith({ ...initialFilters, status: 'ALL' }, expect.any(AbortSignal)))
})


test('failed retrieval is explicit and retry keeps the submitted conditions instead of a later draft', async () => {
  render(<CatalogScreen onOpenProgram={jest.fn()} />)
  await screen.findByText('검색 결과 0건')
  browseCatalog.mockRejectedValueOnce(new Error('network unavailable'))
  fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '실패한 검색')
  fireEvent(screen.getByLabelText('공고명·기관명'), 'submitEditing')
  await screen.findByText('검색 조건을 확인해 주세요.')
  expect(screen.queryByText('검색 결과 0건')).toBeNull()
  fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '미제출 입력')
  fireEvent.press(screen.getByLabelText('다시 불러오기'))
  await screen.findByText('검색 결과 0건')
  expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: '실패한 검색' }), expect.any(AbortSignal))
  expect(screen.getByLabelText('공고명·기관명').props.value).toBe('미제출 입력')
})


test('selecting every shared region stays within the existing multi-value HTTP contract', async () => {
  render(<CatalogScreen onOpenProgram={jest.fn()} />)
  await openFilters()
  for (const region of regionNames) fireEvent.press(screen.getByRole('checkbox', { name: `지역 ${region}` }))
  await waitFor(() => expect(browseCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ region: regionNames.join(',') }), expect.any(AbortSignal)))
  expect(screen.queryByText('검색 조건을 확인해 주세요.')).toBeNull()
  await screen.findByText('검색 결과 0건')
})
