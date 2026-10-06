import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Linking } from 'react-native'
import { ApiError, apiRequest, programClient } from '../api/client'
import { useAuth } from '../auth/session'
import { ProgramScreen } from './ProgramScreen'
import { preparation, preparationDetail, programDetail } from '../test/preparationFixtures'

jest.mock('expo-router', () => ({ useFocusEffect: (effect: () => void) => { const React = jest.requireActual<typeof import('react')>('react'); React.useEffect(effect, [effect]) } }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), apiRequest: jest.fn(), programClient: jest.fn() }))
const answer = jest.fn()
const identity = { sourceCode: 'BIZINFO', sourceProgramId: 'P/123' }
const invalidateSession = jest.fn()
function respond(path: string) {
  if (path.includes('/saved-programs/status?')) return Promise.resolve({ saved: true })
  if (path.startsWith('/api/v1/application-preparations?')) return Promise.resolve({ items: [preparation], nextBeforeId: null })
  if (path.startsWith('/api/v1/combination-reviews?')) return Promise.resolve({ items: [], nextBeforeId: null })
  throw new Error(`Unexpected request ${path}`)
}
beforeEach(() => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owner' }, invalidateSession } as unknown as ReturnType<typeof useAuth>)
  jest.mocked(apiRequest).mockReset().mockImplementation(respond)
  answer.mockReset().mockResolvedValue({ answerStatus: 'ANSWERED', answer: '공고 원문 답변', citations: [] })
  jest.mocked(programClient).mockReturnValue({ getDetail: jest.fn().mockResolvedValue(programDetail), answerEvidenceQuestion: answer } as unknown as ReturnType<typeof programClient>)
})
afterEach(() => jest.restoreAllMocks())

// Windows에서 첫 React Native 렌더링의 모듈 초기화가 기본 5초를 넘는 경우를 허용합니다.
test.each(['signedOut', 'signedIn'] as const)('program information and its official source are immediately available to %s', async (status) => {
  if (status === 'signedOut') jest.mocked(useAuth).mockReturnValue({ status, session: null, invalidateSession } as unknown as ReturnType<typeof useAuth>)
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
  const login = jest.fn()
  const detail = { ...programDetail, organization: '지원 기관', regions: ['서울', '경기'], categories: ['기술', '창업'], summary: '연구 개발 비용을 지원합니다.' }
  const getDetail = jest.fn().mockResolvedValue(detail)
  jest.mocked(programClient).mockReturnValue({ getDetail, answerEvidenceQuestion: answer } as unknown as ReturnType<typeof programClient>)
  render(<ProgramScreen identity={identity} onLogin={login} />)
  await screen.findByText('테스트 지원사업')
  expect(screen.getByText('지원 기관')).toBeTruthy()
  expect(screen.getByText('중소기업')).toBeTruthy()
  expect(screen.getByText('서울 · 경기 / 기술 · 창업')).toBeTruthy()
  expect(screen.getByText(detail.summary)).toBeTruthy()
  expect(screen.getByText('공고 정보는 신청 자격의 확정 판정이 아닙니다. 제출 전 공식 공고의 요건과 마감일을 확인해 주세요.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '더 보기' })).toBeNull()
  expect(screen.queryByRole('button', { name: '접기' })).toBeNull()
  fireEvent.press(screen.getByLabelText('공식 공고 원문 열기'))
  expect(open).toHaveBeenCalledWith(detail.sourceUrl)
  expect(getDetail).toHaveBeenCalledTimes(1)
  expect(login).not.toHaveBeenCalled()
  expect(answer).not.toHaveBeenCalled()
}, 15_000)

test.each([
  { sourceCode: 'KSTARTUP', status: 'signedOut' },
  { sourceCode: 'KSTARTUP', status: 'signedIn' },
  { sourceCode: 'CNTRADE_NOTICE', status: 'signedOut' },
  { sourceCode: 'CNTRADE_NOTICE', status: 'signedIn' },
] as const)('unsupported $sourceCode evidence offers an official source to $status without login or an AI request', async ({ sourceCode, status }) => {
  if (status === 'signedOut') jest.mocked(useAuth).mockReturnValue({ status, session: null, invalidateSession } as unknown as ReturnType<typeof useAuth>)
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
  const login = jest.fn()
  jest.mocked(programClient).mockReturnValue({ getDetail: jest.fn().mockResolvedValue({ ...programDetail, sourceCode, evidenceQuestionSupported: false }), answerEvidenceQuestion: answer } as unknown as ReturnType<typeof programClient>)
  render(<ProgramScreen identity={{ sourceCode, sourceProgramId: identity.sourceProgramId }} onLogin={login} />)
  const footerLabel = sourceCode === 'CNTRADE_NOTICE' ? '공식 공지 목록 확인' : '공식 원문 확인'
  await screen.findByLabelText(footerLabel)
  expect(screen.queryByLabelText('원문에 질문하기')).toBeNull()
  expect(screen.getByText(/이 제공처 공고는 아직 원문 근거 답변을 지원하지 않습니다/)).toBeTruthy()
  fireEvent.press(screen.getByLabelText(sourceCode === 'CNTRADE_NOTICE' ? '공식 공지 목록 열기' : '공식 공고 원문 열기'))
  fireEvent.press(screen.getByLabelText(footerLabel))
  expect(open).toHaveBeenCalledTimes(2)
  expect(open).toHaveBeenCalledWith(programDetail.sourceUrl)
  expect(login).not.toHaveBeenCalled()
  expect(answer).not.toHaveBeenCalled()
})

test('a resumed question for newly unsupported evidence cannot reopen the question sheet', async () => {
  const resumed = jest.fn()
  jest.mocked(programClient).mockReturnValue({ getDetail: jest.fn().mockResolvedValue({ ...programDetail, evidenceQuestionSupported: false }), answerEvidenceQuestion: answer } as unknown as ReturnType<typeof programClient>)
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} resumeAction={{ action: 'question', token: 'owner' }} onResumed={resumed} />)
  await screen.findByLabelText('공식 원문 확인')
  expect(resumed).toHaveBeenCalledTimes(1)
  expect(screen.queryByLabelText('공고에 대해 궁금한 점')).toBeNull()
  expect(answer).not.toHaveBeenCalled()
})
test('saved program preparation changes only the selected document with its stored progress revision', async () => {
  let updated = false
  jest.mocked(apiRequest).mockImplementation((path, options) => {
    if (options?.method === 'PUT') { updated = true; return Promise.resolve({ ...preparationDetail, progressStage: 'APPLIED', progressRevision: 2 }) }
    if (updated && path.startsWith('/api/v1/application-preparations?')) return Promise.resolve({ items: [{ ...preparation, progressStage: 'APPLIED', progressRevision: 2 }], nextBeforeId: null })
    return respond(path)
  })
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByText('담은 공고라 보여요')
  await screen.findByLabelText('진행 단계 바꾸기')
  fireEvent.press(screen.getByLabelText('진행 단계 바꾸기'))
  fireEvent.press(screen.getByLabelText('제출 완료'))
  fireEvent.press(screen.getByText('저장'))
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith('/api/v1/application-preparations/9/progress-stage', expect.objectContaining({
    method: 'PUT', accessToken: 'owner', body: { expectedProgressRevision: 1, progressStage: 'APPLIED' },
  })))
  await waitFor(() => expect(screen.queryByText('진행 단계 바꾸기')).toBeNull())
  await waitFor(() => expect(screen.getAllByText('제출 완료').length).toBeGreaterThan(0))
})
test('a progress conflict stays visible instead of reporting a successful stage update', async () => {
  jest.mocked(apiRequest).mockImplementation((path, options) => options?.method === 'PUT' ? Promise.reject(new ApiError(409, 'conflict')) : respond(path))
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByLabelText('진행 단계 바꾸기')
  fireEvent.press(screen.getByLabelText('진행 단계 바꾸기'))
  fireEvent.press(screen.getByLabelText('제출 완료'))
  fireEvent.press(screen.getByText('저장'))
  await screen.findByText(/다른 화면에서 진행 단계가 변경/)
  expect(screen.getByText('진행 단계 바꾸기')).toBeTruthy()
})
test('question entry preserves the existing explicit AI request and visible program details', async () => {
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  expect(answer).not.toHaveBeenCalled()
  expect(screen.getByText('중소기업')).toBeTruthy()
  fireEvent.press(screen.getByText('원문에 질문하기'))
  expect(answer).not.toHaveBeenCalled()
  fireEvent.changeText(screen.getByLabelText('공고에 대해 궁금한 점'), '신청 서류는?')
  fireEvent.press(screen.getByText('원문에서 답변 찾기'))
  await screen.findByText('공고 원문 답변')
  expect(answer).toHaveBeenCalledWith({ ...identity, question: '신청 서류는?' }, expect.anything())
})
test('details show the official application route and split K-Startup exclusions without a placeholder support amount', async () => {
  jest.mocked(programClient).mockReturnValue({ getDetail: jest.fn().mockResolvedValue({
    ...programDetail, sourceCode: 'KSTARTUP', targetDescription: '지원 대상: 창업 3년 이내 기업\n제외 대상: 휴·폐업 중인 기업',
    applicationRoute: { method: '구글 설문으로 신청', url: 'https://forms.gle/abc', type: 'GOOGLE_FORMS' },
  }), answerEvidenceQuestion: answer } as unknown as ReturnType<typeof programClient>)
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  expect(screen.getByText('온라인 신청 (구글 설문)')).toBeTruthy()
  expect(screen.queryByText('지원 규모')).toBeNull()
  expect(screen.queryByText('문의처')).toBeNull()
  // 지원·제외 대상과 신청 방법은 접지 않고 처음부터 보입니다.
  expect(screen.getByText('창업 3년 이내 기업')).toBeTruthy()
  expect(screen.getByText('제외 대상')).toBeTruthy()
  expect(screen.getByText('휴·폐업 중인 기업')).toBeTruthy()
  expect(screen.getByText('구글 설문으로 신청')).toBeTruthy()
  fireEvent.press(screen.getByText('구글 설문 신청서 열기'))
  expect(open).toHaveBeenCalledWith('https://forms.gle/abc')
  open.mockRestore()
})
test('an unknown application route asks to check the notice and shows no apply button', async () => {
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  expect(screen.getByText('공고 원문에서 확인해 주세요')).toBeTruthy()
  // 한눈에 보기의 이름만 있고 공식 신청 방법 문장 카드는 없습니다.
  expect(screen.getAllByText('신청 방법')).toHaveLength(1)
  expect(screen.queryByText(/신청 사이트 열기|구글 설문 신청서 열기/)).toBeNull()
  expect(screen.queryByText('우대 사항')).toBeNull()
})
test('official contact, institution type and preferences come from the catalog and the phone opens the dialer', async () => {
  jest.mocked(programClient).mockReturnValue({ getDetail: jest.fn().mockResolvedValue({
    ...programDetail, sourceCode: 'KSTARTUP', contact: { department: '창업보육센터', phoneNumber: '0312508269', text: null },
    preferenceDescription: '1인창조, 재창업', supervisingInstitutionType: '공공기관',
  }), answerEvidenceQuestion: answer } as unknown as ReturnType<typeof programClient>)
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  expect(screen.getByText('문의처')).toBeTruthy()
  expect(screen.getByText('창업보육센터')).toBeTruthy()
  expect(screen.getByText('주관 기관 유형')).toBeTruthy()
  expect(screen.getByText('공공기관')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('031-250-8269 전화 걸기'))
  expect(open).toHaveBeenCalledWith('tel:0312508269')
  expect(screen.getByText('우대 사항')).toBeTruthy()
  expect(screen.getByText('1인창조, 재창업')).toBeTruthy()
  open.mockRestore()
})
test('guests do not request a private preparation workspace', async () => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null, invalidateSession } as unknown as ReturnType<typeof useAuth>)
  const login = jest.fn()
  render(<ProgramScreen identity={identity} onLogin={login} />)
  await screen.findByText('테스트 지원사업')
  expect(apiRequest).not.toHaveBeenCalled()
  expect(screen.queryByText('담은 공고라 보여요')).toBeNull()
  fireEvent.press(screen.getByLabelText('로그인하고 관심 공고 저장'))
  expect(login).toHaveBeenCalledTimes(1)
  expect(login).toHaveBeenCalledWith('save')
})

test('the bookmark still removes only the selected saved program', async () => {
  jest.mocked(apiRequest).mockImplementation((path, options) => options?.method === 'DELETE' ? Promise.resolve(undefined) : respond(path))
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByLabelText('관심 공고에서 빼기')
  fireEvent.press(screen.getByLabelText('관심 공고에서 빼기'))
  await screen.findByLabelText('관심 공고에 저장')
  expect(apiRequest).toHaveBeenCalledWith(`/api/v1/me/saved-programs?${new URLSearchParams(identity)}`, expect.objectContaining({
    method: 'DELETE', accessToken: 'owner',
  }))
  expect(screen.queryByText('담은 공고라 보여요')).toBeNull()
  expect(screen.getByText('중소기업')).toBeTruthy()
  expect(answer).not.toHaveBeenCalled()
})

test('the resumed save is idempotent for an already saved program and never removes it', async () => {
  const resumed = jest.fn()
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} resumeAction={{ action: 'save', token: 'owner' }} onResumed={resumed} />)
  await screen.findByText('이미 관심 공고함에 담은 공고예요.')
  expect(resumed).toHaveBeenCalledTimes(1)
  expect(jest.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'POST' || options?.method === 'DELETE')).toBe(false)
})
test('resuming an original question opens input without issuing an AI request', async () => {
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} resumeAction={{ action: 'question', token: 'owner' }} />)
  await screen.findByLabelText('공고에 대해 궁금한 점')
  expect(answer).not.toHaveBeenCalled()
})
test('a continuation belonging to a different session cannot save or open questions', async () => {
  const resumed = jest.fn()
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} resumeAction={{ action: 'question', token: 'other' }} onResumed={resumed} />)
  await screen.findByText('테스트 지원사업')
  expect(screen.queryByLabelText('공고에 대해 궁금한 점')).toBeNull()
  expect(resumed).not.toHaveBeenCalled()
})
