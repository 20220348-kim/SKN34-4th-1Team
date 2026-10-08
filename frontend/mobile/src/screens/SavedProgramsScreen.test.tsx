import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import { apiRequest } from '../api/client'
import { useAuth } from '../auth/session'
import { SavedProgramsScreen } from './SavedProgramsScreen'
import { preparation, preparationDetail, programDetail, review, run } from '../test/preparationFixtures'

const mockPush = jest.fn(), mockNavigate = jest.fn()
jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args), navigate: (...args: unknown[]) => mockNavigate(...args) },
  useFocusEffect: (effect: () => void) => { const React = jest.requireActual<typeof import('react')>('react'); React.useEffect(effect, [effect]) } }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), apiRequest: jest.fn() }))
const invalidateSession = jest.fn()
const auth = (accessToken: string) => ({ session: { accessToken }, status: 'signedIn', invalidateSession, refreshSession: jest.fn() })
const saved = { savedAt: '2026-09-19', program: { ...programDetail, matchedReasons: [], recommendationScore: null, eligibilityReview: null } }

function respond(path: string) {
  if (path === '/api/v1/me/saved-programs') return Promise.resolve({ programs: [saved] })
  if (path.startsWith('/api/v1/application-preparations?')) return Promise.resolve({ items: [preparation], nextBeforeId: null })
  if (path.startsWith('/api/v1/combination-reviews?')) return Promise.resolve({ items: [], nextBeforeId: null })
  throw new Error(`Unexpected request ${path}`)
}
beforeEach(() => {
  mockPush.mockReset(); mockNavigate.mockReset()
  jest.mocked(apiRequest).mockReset().mockImplementation(respond)
  jest.mocked(useAuth).mockReturnValue(auth('first-token') as unknown as ReturnType<typeof useAuth>)
})

test('preparation work filters the document status and application stage independently from review work', async () => {
  const completed = { ...preparation, id: 10, formTitle: '완료 문서', hasCurrentDocument: true, progressStage: 'APPLIED' }
  jest.mocked(apiRequest).mockImplementation(path => path.startsWith('/api/v1/application-preparations?')
    ? Promise.resolve({ items: [preparation, completed], nextBeforeId: null }) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  fireEvent.press(await screen.findByRole('tab', { name: '준비 중인 작업 2' }))
  fireEvent.press(screen.getByLabelText('준비 작업 필터 열기'))
  fireEvent.press(screen.getByLabelText('작업 종류: 전체 작업'))
  fireEvent.press(screen.getByRole('radio', { name: '신청 문서' }))
  fireEvent.press(screen.getByLabelText('작업 상태: 전체 상태'))
  fireEvent.press(screen.getByRole('radio', { name: '초안 완료' }))
  fireEvent.press(screen.getByLabelText('신청 진행 단계: 전체 단계'))
  fireEvent.press(screen.getByRole('radio', { name: '제출 완료' }))
  fireEvent.press(screen.getByLabelText('결과 1건 보기'))
  expect(screen.getByLabelText('완료 문서 · 일반 신청 열기')).toBeTruthy()
  expect(screen.queryByLabelText('사업계획서 · 일반 신청 열기')).toBeNull()
  fireEvent.press(screen.getByLabelText('준비 작업 필터 초기화'))
  expect(screen.getByLabelText('사업계획서 · 일반 신청 열기')).toBeTruthy()
})

test('review status filters separate failed runs from results for changed inputs', async () => {
  const changed = { ...review, id: 7, title: '입력 바뀐 검토', inputRevision: 2 }
  jest.mocked(apiRequest).mockImplementation(path => path.startsWith('/api/v1/combination-reviews?')
    ? Promise.resolve({ items: [review, changed], nextBeforeId: null })
    : path.endsWith('/5') ? Promise.resolve(review) : path.endsWith('/7') ? Promise.resolve(changed)
      : path.includes('/runs?') ? Promise.resolve({ items: [{ ...run, status: 'FAILED' }], nextBeforeId: null }) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  fireEvent.press(await screen.findByRole('tab', { name: '준비 중인 작업 3' }))
  fireEvent.press(screen.getByLabelText('준비 작업 필터 열기'))
  fireEvent.press(screen.getByLabelText('작업 종류: 전체 작업'))
  fireEvent.press(screen.getByRole('radio', { name: '중복 검토' }))
  fireEvent.press(screen.getByLabelText('작업 상태: 전체 상태'))
  fireEvent.press(screen.getByRole('radio', { name: '분석 실패' }))
  fireEvent.press(screen.getByLabelText('결과 1건 보기'))
  expect(screen.getByLabelText('동시 신청 검토 열기')).toBeTruthy()
  expect(screen.queryByLabelText('입력 바뀐 검토 열기')).toBeNull()
  fireEvent.press(screen.getByLabelText('준비 작업 필터 열기'))
  fireEvent.press(screen.getByLabelText('작업 상태: 분석 실패'))
  fireEvent.press(screen.getByRole('radio', { name: '입력 변경' }))
  fireEvent.press(screen.getByLabelText('결과 1건 보기'))
  expect(screen.getByLabelText('입력 바뀐 검토 열기')).toBeTruthy()
  expect(screen.queryByLabelText('동시 신청 검토 열기')).toBeNull()
})

test('a delayed previous account response cannot reveal saved programs or preparation work', async () => {
  let finish!: (value: unknown) => void
  jest.mocked(apiRequest).mockImplementation((path, options) => {
    if (options?.accessToken === 'second-token') return Promise.resolve(path === '/api/v1/me/saved-programs' ? { programs: [] } : { items: [], nextBeforeId: null })
    if (path === '/api/v1/me/saved-programs') return new Promise((resolve) => { finish = resolve })
    return respond(path)
  })
  const view = render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await waitFor(() => expect(finish).toBeDefined())
  jest.mocked(useAuth).mockReturnValue(auth('second-token') as unknown as ReturnType<typeof useAuth>)
  view.rerender(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await act(async () => finish({ programs: [saved] }))
  await screen.findByText(/아직 관심 공고가 없습니다/)
  expect(screen.queryByText('테스트 지원사업')).toBeNull()
  fireEvent.press(screen.getByRole('tab', { name: '준비 중인 작업 0' }))
  expect(screen.queryByText(/사업계획서/)).toBeNull()
})
test('saved navigation and preparation filters distinguish the full source identity', async () => {
  const other = { ...saved, program: { ...saved.program, sourceCode: 'KSTARTUP', sourceName: 'K-Startup', title: '다른 제공처 공고',
    sourceUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do' } }
  jest.mocked(apiRequest).mockImplementation((path) => path === '/api/v1/me/saved-programs' ? Promise.resolve({ programs: [saved, other] }) : respond(path))
  const open = jest.fn()
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={open} />)
  await screen.findByText('다른 제공처 공고')
  await waitFor(() => expect(screen.getByLabelText('테스트 지원사업 진행 단계 바꾸기').props.accessibilityState.disabled).toBe(false))
  fireEvent.press(screen.getByLabelText('관심 공고 필터 열기'))
  fireEvent.press(screen.getByLabelText('진행 단계 준비 중'))
  fireEvent.press(screen.getByLabelText('닫기'))
  expect(screen.queryByText('다른 제공처 공고')).toBeNull()
  fireEvent.press(screen.getByText('상세 보기'))
  expect(open).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'P/123' })
})
test('successful removal offers undo and restores the server returned saved date', async () => {
  jest.mocked(apiRequest).mockImplementation((path, options) => options?.method === 'DELETE' ? Promise.resolve(undefined)
    : options?.method === 'POST' ? Promise.resolve({ ...saved, savedAt: '2026-10-01' }) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  fireEvent.press(screen.getByLabelText('테스트 지원사업 관심 공고에서 빼기'))
  await screen.findByText('관심 공고에서 뺐어요')
  expect(screen.queryByText('테스트 지원사업')).toBeNull()
  fireEvent.press(screen.getByLabelText('되돌리기'))
  await screen.findByText('10.01 담음')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/saved-programs', expect.objectContaining({
    method: 'POST', accessToken: 'first-token', body: { sourceCode: 'BIZINFO', sourceProgramId: 'P/123' },
  }))
})
test('failed removal retains the card and never offers a successful undo notice', async () => {
  jest.mocked(apiRequest).mockImplementation((path, options) => options?.method === 'DELETE' ? Promise.reject(new Error('offline')) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  fireEvent.press(screen.getByLabelText('테스트 지원사업 관심 공고에서 빼기'))
  await screen.findByText(/연결하지 못했거나/)
  expect(screen.getByText('테스트 지원사업')).toBeTruthy()
  expect(screen.queryByText('관심 공고에서 뺐어요')).toBeNull()
})
test('preparation load errors stay explicit while saved cards remain usable', async () => {
  jest.mocked(apiRequest).mockImplementation((path) => path.startsWith('/api/v1/application-preparations?') ? Promise.reject(new Error('offline')) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await screen.findByText(/신청 문서 조회 실패/)
  expect(screen.getByText('테스트 지원사업')).toBeTruthy()
  expect(screen.getByText('단계 미확인')).toBeTruthy()
  expect(screen.queryByText('관심 1')).toBeNull()
})
test('preparation work uses saved answer counts and current review runs', async () => {
  jest.mocked(apiRequest).mockImplementation((path) => path.startsWith('/api/v1/combination-reviews?') ? Promise.resolve({ items: [review], nextBeforeId: null })
    : path.endsWith('/5') ? Promise.resolve(review) : path.includes('/runs?') ? Promise.resolve({ items: [run], nextBeforeId: null }) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await screen.findByRole('tab', { name: '준비 중인 작업 2' })
  fireEvent.press(screen.getByRole('tab', { name: '준비 중인 작업 2' }))
  expect(screen.getByText('3개 항목 중 1개 확인')).toBeTruthy()
  expect(screen.getByText('작성 중')).toBeTruthy()
  expect(screen.getByText('분석 완료')).toBeTruthy()
  expect(screen.queryByText('초안 완료')).toBeNull()
})

test('a running review for previous inputs cannot be shown as the current analysis', async () => {
  jest.mocked(apiRequest).mockImplementation((path) => path.startsWith('/api/v1/combination-reviews?') ? Promise.resolve({ items: [review], nextBeforeId: null })
    : path.endsWith('/5') ? Promise.resolve({ ...review, inputRevision: 2 })
      : path.includes('/runs?') ? Promise.resolve({ items: [{ ...run, status: 'RUNNING', finishedAt: null }], nextBeforeId: null }) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await screen.findByRole('tab', { name: '준비 중인 작업 2' })
  fireEvent.press(screen.getByRole('tab', { name: '준비 중인 작업 2' }))
  expect(screen.getByText('입력 변경')).toBeTruthy()
  expect(screen.queryByLabelText('중복 검토 진행 중')).toBeNull()
  expect(screen.queryByText('분석 완료')).toBeNull()
})

test('search, multiple choices and reset filter the existing saved data without additional requests', async () => {
  const first = { ...saved, program: { ...saved.program, title: '서울 기술 지원', organization: '기술 지원센터', regions: ['서울', '경기'], categories: ['기술'], applicationEndDate: '2026-10-08' } }
  const second = { ...saved, program: { ...saved.program, sourceCode: 'KSTARTUP', sourceName: 'K-Startup', title: '부산 창업 지원', organization: '창업 지원센터', regions: ['부산'], categories: ['창업'],
    targetDescription: '예비창업자', sourceUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do', applicationEndDate: '2026-10-04' } }
  jest.mocked(apiRequest).mockImplementation(path => path === '/api/v1/me/saved-programs' ? Promise.resolve({ programs: [first, second] }) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await screen.findByText('서울 기술 지원')
  const count = jest.mocked(apiRequest).mock.calls.length
  expect(screen.getAllByText(/^(서울 기술 지원|부산 창업 지원)$/).map(node => node.props.children)).toEqual(['부산 창업 지원', '서울 기술 지원'])
  fireEvent.changeText(screen.getByLabelText('담은 공고 검색'), '지원센터')
  fireEvent.press(screen.getByLabelText('관심 공고 필터 열기'))
  fireEvent.press(screen.getByLabelText('지역 서울'))
  fireEvent.press(screen.getByLabelText('지역 부산'))
  expect(screen.getByLabelText('지역 서울').props.accessibilityState.checked).toBe(true)
  expect(screen.getByLabelText('지역 부산').props.accessibilityState.checked).toBe(true)
  fireEvent.press(screen.getByLabelText('닫기'))
  expect(screen.getByText('부산 창업 지원')).toBeTruthy()
  expect(screen.getByText('서울 기술 지원')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('관심 공고 필터 열기'))
  fireEvent.press(screen.getByLabelText('분야 기술'))
  fireEvent.press(screen.getByLabelText('닫기'))
  expect(screen.queryByText('부산 창업 지원')).toBeNull()
  fireEvent.press(screen.getByLabelText('관심 공고 필터 열기'))
  fireEvent.press(screen.getByLabelText('대상 예비창업자'))
  fireEvent.press(screen.getByLabelText('닫기'))
  expect(screen.getByText('조건에 맞는 관심 공고가 없습니다.')).toBeTruthy()
  expect(screen.queryByLabelText('공고 찾기')).toBeNull()
  fireEvent.press(screen.getByText('필터 초기화'))
  expect(screen.getByText('서울 기술 지원')).toBeTruthy()
  expect(screen.getByText('부산 창업 지원')).toBeTruthy()
  expect(apiRequest).toHaveBeenCalledTimes(count)
}, 15_000)

test('list stage editing uses the selected source identity and stored progress revision', async () => {
  let updated = false
  const other = { ...saved, program: { ...saved.program, sourceCode: 'KSTARTUP', sourceName: 'K-Startup', title: '별도 제공처 사업', sourceUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do' } }
  jest.mocked(apiRequest).mockImplementation((path, options) => {
    if (path === '/api/v1/me/saved-programs') return Promise.resolve({ programs: [saved, other] })
    if (path.startsWith('/api/v1/application-preparations?')) return Promise.resolve({ items: [preparation, { ...preparation, id: 10, sourceCode: 'KSTARTUP', progressRevision: updated ? 5 : 4, progressStage: updated ? 'APPLIED' : 'PREPARING' }], nextBeforeId: null })
    if (options?.method === 'PUT') { updated = true; return Promise.resolve({ ...preparationDetail, id: 10, progressStage: 'APPLIED', progressRevision: 5,
      form: { ...preparationDetail.form, sourceCode: 'KSTARTUP' } }) }
    return respond(path)
  })
  const open = jest.fn()
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={open} />)
  await waitFor(() => expect(screen.getByLabelText('테스트 지원사업 진행 단계 바꾸기').props.accessibilityState.disabled).toBe(false))
  fireEvent.press(screen.getByLabelText('별도 제공처 사업 진행 단계 바꾸기'))
  fireEvent.press(screen.getByLabelText('제출 완료'))
  fireEvent.press(screen.getByText('저장'))
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith('/api/v1/application-preparations/10/progress-stage', expect.objectContaining({
    method: 'PUT', accessToken: 'first-token', body: { expectedProgressRevision: 4, progressStage: 'APPLIED' },
  })))
  await screen.findByText('제출 완료')
  expect(within(screen.getByLabelText('테스트 지원사업 진행 단계 바꾸기')).getByText('준비 중')).toBeTruthy()
  expect(open).not.toHaveBeenCalled()
})

test('pipeline keeps document stages separate and excludes documents for unsaved programs', async () => {
  let updated = false
  const second = { ...preparation, id: 11, formTitle: '별도 작성본', progressStage: 'APPLIED', progressRevision: 4 }
  jest.mocked(apiRequest).mockImplementation((path, options) => {
    if (path.startsWith('/api/v1/application-preparations?')) return Promise.resolve({ items: [preparation,
      { ...second, progressStage: updated ? 'DOCUMENT_REVIEW' : 'APPLIED', progressRevision: updated ? 5 : 4 },
      { ...preparation, id: 12, sourceCode: 'KSTARTUP', programTitle: '담지 않은 사업', formTitle: '숨겨야 하는 작성본' }], nextBeforeId: null })
    if (options?.method === 'PUT') { updated = true; return Promise.resolve({ ...preparationDetail, id: 11, progressStage: 'DOCUMENT_REVIEW', progressRevision: 5 }) }
    return respond(path)
  })
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await waitFor(() => expect(screen.getByLabelText('테스트 지원사업 진행 단계 바꾸기').props.accessibilityState.disabled).toBe(false))
  fireEvent.press(screen.getByRole('tab', { name: '진행 관리' }))
  expect(screen.getByRole('tab', { name: '관심 0건' })).toBeTruthy()
  expect(screen.getByRole('tab', { name: '준비 중 1건' }).props.accessibilityState.selected).toBe(true)
  expect(screen.getByRole('tab', { name: '제출 완료 1건' })).toBeTruthy()
  expect(screen.queryByText('숨겨야 하는 작성본')).toBeNull()
  expect(screen.queryByText('별도 작성본')).toBeNull()
  fireEvent.press(screen.getByRole('tab', { name: '제출 완료 1건' }))
  fireEvent.press(screen.getByLabelText('별도 작성본 단계 바꾸기'))
  expect(screen.getByLabelText('제출 완료').props.accessibilityState.checked).toBe(true)
  fireEvent.press(screen.getByLabelText('서류 심사'))
  fireEvent.press(screen.getByText('저장'))
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith('/api/v1/application-preparations/11/progress-stage', expect.objectContaining({
    body: { expectedProgressRevision: 4, progressStage: 'DOCUMENT_REVIEW' },
  })))
  await screen.findByRole('tab', { name: '심사 중 1건' })
  expect(screen.getByRole('tab', { name: '제출 완료 0건' }).props.accessibilityState.selected).toBe(true)
  expect(screen.getByRole('tab', { name: '준비 중 1건' })).toBeTruthy()
  fireEvent.press(screen.getByRole('tab', { name: '심사 중 1건' }))
  expect(screen.getByText('별도 작성본')).toBeTruthy()
  expect(screen.getByText('서류 심사')).toBeTruthy()
})

test('progress conflicts remain explicit and keep the stage sheet open', async () => {
  const { ApiError } = jest.requireActual<typeof import('../api/client')>('../api/client')
  jest.mocked(apiRequest).mockImplementation((path, options) => options?.method === 'PUT' ? Promise.reject(new ApiError(409, 'conflict')) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await waitFor(() => expect(screen.getByLabelText('테스트 지원사업 진행 단계 바꾸기').props.accessibilityState.disabled).toBe(false))
  fireEvent.press(screen.getByLabelText('테스트 지원사업 진행 단계 바꾸기'))
  fireEvent.press(screen.getByLabelText('제출 완료'))
  fireEvent.press(screen.getByText('저장'))
  await screen.findByText(/다른 화면에서 진행 단계가 변경/)
  expect(screen.getByLabelText('제출 완료')).toBeTruthy()
})

test('a program without a document starts the existing selection flow instead of a stage update', async () => {
  jest.mocked(apiRequest).mockImplementation(path => path.startsWith('/api/v1/application-preparations?') ? Promise.resolve({ items: [], nextBeforeId: null }) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await within(await screen.findByLabelText('테스트 지원사업 진행 단계 바꾸기')).findByText('관심')
  fireEvent.press(screen.getByLabelText('테스트 지원사업 진행 단계 바꾸기'))
  fireEvent.press(screen.getByLabelText('이 공고로 신청 문서 작성'))
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/all/preparation/new', params: { sourceCode: 'BIZINFO', sourceProgramId: 'P/123' } })
  expect(jest.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'POST' || options?.method === 'PUT')).toBe(false)
})

test('empty work sections navigate independently without creating or analyzing anything', async () => {
  jest.mocked(apiRequest).mockImplementation(path => path === '/api/v1/me/saved-programs' ? Promise.resolve({ programs: [] }) : Promise.resolve({ items: [], nextBeforeId: null }))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await screen.findByLabelText('공고 찾기')
  fireEvent.press(screen.getByLabelText('공고 찾기'))
  expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/', params: { mode: 'filter' } })
  fireEvent.press(screen.getByRole('tab', { name: '준비 중인 작업 0' }))
  fireEvent.press(screen.getByLabelText('새 신청문서'))
  fireEvent.press(screen.getByLabelText('새 검토'))
  expect(mockPush).toHaveBeenNthCalledWith(1, '/all/preparation/new')
  expect(mockPush).toHaveBeenNthCalledWith(2, '/all/reviews/new')
  expect(jest.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'POST' || options?.method === 'PUT')).toBe(false)
})

test('failed queries cannot become empty creation prompts or a zero-stage pipeline', async () => {
  jest.mocked(apiRequest).mockImplementation(path => path === '/api/v1/me/saved-programs' ? Promise.resolve({ programs: [saved] })
    : Promise.reject(new Error('offline')))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await screen.findByText(/신청 문서 조회 실패/)
  fireEvent.press(screen.getByRole('tab', { name: '진행 관리' }))
  expect(screen.getByText(/신청 준비를 확인하지 못해 진행 단계를 표시할 수 없어요/)).toBeTruthy()
  expect(screen.queryByText('관심 0건')).toBeNull()
  fireEvent.press(screen.getByRole('tab', { name: '준비 중인 작업' }))
  expect(screen.queryByText('아직 신청 문서가 없습니다.')).toBeNull()
  expect(screen.queryByLabelText('새 신청문서')).toBeNull()
  expect(screen.queryByLabelText('새 검토')).toBeNull()
})

test('changing accounts clears the previous search and cannot keep a private stage sheet visible', async () => {
  jest.mocked(apiRequest).mockImplementation((path, options) => options?.accessToken === 'second-token'
    ? Promise.resolve(path === '/api/v1/me/saved-programs' ? { programs: [] } : { items: [], nextBeforeId: null }) : respond(path))
  const view = render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await waitFor(() => expect(screen.getByLabelText('테스트 지원사업 진행 단계 바꾸기').props.accessibilityState.disabled).toBe(false))
  fireEvent.changeText(screen.getByLabelText('담은 공고 검색'), '테스트')
  fireEvent.press(screen.getByLabelText('테스트 지원사업 진행 단계 바꾸기'))
  jest.mocked(useAuth).mockReturnValue(auth('second-token') as unknown as ReturnType<typeof useAuth>)
  view.rerender(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await screen.findByText(/아직 관심 공고가 없습니다/)
  expect(screen.getByLabelText('담은 공고 검색').props.value).toBe('')
  expect(screen.queryByLabelText('제출 완료')).toBeNull()
  expect(screen.queryByText('테스트 지원사업')).toBeNull()
})
