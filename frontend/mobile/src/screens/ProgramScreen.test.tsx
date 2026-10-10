import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Alert, Linking, Modal, StyleSheet } from 'react-native'
import { PlanQuotaExceededError } from '@govbiz/shared/domain/errors/PlanQuotaError'
import { ApiError, apiRequest, programClient } from '../api/client'
import { useAuth } from '../auth/session'
import { colors } from '../ui'
import { ProgramScreen } from './ProgramScreen'
import { preparation, preparationDetail, programDetail } from '../test/preparationFixtures'

jest.mock('expo-router', () => ({ useFocusEffect: (effect: () => void) => { const React = jest.requireActual<typeof import('react')>('react'); React.useEffect(effect, [effect]) } }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), apiRequest: jest.fn(), programClient: jest.fn() }))
// 공식 첨부 카드는 원문을 따로 읽어 이 화면 흐름과 무관하므로 격리합니다. 첨부 동작은 ProgramAttachments.test가 확인합니다.
jest.mock('../components/ProgramAttachments', () => ({ ProgramAttachments: () => null }))
const answer = jest.fn()
const identity = { sourceCode: 'BIZINFO', sourceProgramId: 'P/123' }
const invalidateSession = jest.fn()
const resetsAt = '2026-10-09T00:00:00+09:00'
const questionUsage = (used: number) => ({ plan: 'FREE', items: [
  { feature: 'AI_SEARCH', period: 'DAY', limit: 10, used: 0, resetsAt },
  { feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: 10, used, resetsAt },
] })
function respond(path: string) {
  if (path === '/api/v1/plan-usage') return Promise.resolve(questionUsage(0))
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
  for (const value of ['한눈에 보기', '서울', '경기', '기술', '창업']) expect(screen.getByText(value)).toBeTruthy()
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
  { sourceCode: 'MSIT', status: 'signedOut' },
  { sourceCode: 'MSIT', status: 'signedIn' },
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
  fireEvent.press(screen.getByText('질문 보내기'))
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


test('evidence suggestions fill without sending and successful questions remain as a local thread', async () => {
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  fireEvent.press(screen.getByLabelText('원문에 질문하기'))
  fireEvent.press(screen.getByLabelText('지원 대상'))
  expect(answer).not.toHaveBeenCalled()
  expect(screen.getByLabelText('공고에 대해 궁금한 점').props.value).toBe('지원 대상이 어떻게 되나요?')
  fireEvent.press(screen.getByLabelText('질문 보내기'))
  await screen.findByText('공고 원문 답변')
  expect(screen.getByLabelText('공고에 대해 궁금한 점').props.value).toBe('')
  expect(screen.getByText('지원 대상이 어떻게 되나요?')).toBeTruthy()
  answer.mockResolvedValueOnce({ answerStatus: 'INSUFFICIENT_EVIDENCE', answer: '공식 근거가 부족합니다.', citations: [] })
  fireEvent.changeText(screen.getByLabelText('공고에 대해 궁금한 점'), '추가 질문')
  fireEvent.press(screen.getByLabelText('질문 보내기'))
  await screen.findByText('공식 근거가 부족합니다.')
  expect(screen.getByText('공고 원문 답변')).toBeTruthy()
  expect(screen.getByText('추가 질문')).toBeTruthy()
})

test('K-Startup evidence citations show the server source label and open the official detail page', async () => {
  const kStartupUrl = 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=178927'
  const kStartup = { sourceCode: 'KSTARTUP', sourceProgramId: '178927' }
  jest.mocked(programClient).mockReturnValue({ getDetail: jest.fn().mockResolvedValue({
    ...programDetail, sourceCode: 'KSTARTUP', id: '178927', sourceName: 'K-Startup', sourceUrl: kStartupUrl,
  }), answerEvidenceQuestion: answer } as unknown as ReturnType<typeof programClient>)
  answer.mockResolvedValueOnce({ answerStatus: 'ANSWERED', answer: '참가신청서와 발표자료를 제출합니다.', citations: [{
    excerpt: '제출서류: 참가신청서 1부, 발표자료 1부', sourceUrl: kStartupUrl, sourceLabel: 'K-Startup 상세 본문', chunkOrder: 2,
  }] })
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
  render(<ProgramScreen identity={kStartup} onLogin={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  fireEvent.press(screen.getByLabelText('원문에 질문하기'))
  fireEvent.changeText(screen.getByLabelText('공고에 대해 궁금한 점'), '제출 서류는?')
  fireEvent.press(screen.getByLabelText('질문 보내기'))
  await screen.findByText('참가신청서와 발표자료를 제출합니다.')
  expect(answer).toHaveBeenCalledWith({ ...kStartup, question: '제출 서류는?' }, expect.anything())
  fireEvent.press(screen.getByLabelText('근거 1 · K-Startup 상세 본문 ↗'))
  expect(open).toHaveBeenCalledWith(kStartupUrl)
})

test('the question sheet reads the daily question count when opened, warns from 80% and rereads it after each question', async () => {
  let used = 7
  jest.mocked(apiRequest).mockImplementation(path => path === '/api/v1/plan-usage' ? Promise.resolve(questionUsage(used)) : respond(path))
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  expect(jest.mocked(apiRequest).mock.calls.some(([path]) => path === '/api/v1/plan-usage')).toBe(false)
  fireEvent.press(screen.getByLabelText('원문에 질문하기'))
  await screen.findByText('공고 원문 질문 오늘 7/10회')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/plan-usage', expect.objectContaining({ accessToken: 'owner' }))
  used = 8
  fireEvent.changeText(screen.getByLabelText('공고에 대해 궁금한 점'), '신청 서류는?')
  await act(async () => { fireEvent.press(screen.getByLabelText('질문 보내기')) })
  await screen.findByText('공고 원문 답변')
  const warning = '공고 원문 질문 오늘 8/10회 · 자정(서울 시간)에 다시 채워져요.'
  await screen.findByText(warning)
  expect(StyleSheet.flatten(screen.getByText(warning).props.style).color).toBe(colors.warning)
  expect(screen.getByLabelText('공고에 대해 궁금한 점').props.editable).toBe(true)
})

test('a used-up daily question limit disables the input with its message instead of requesting AI', async () => {
  jest.mocked(apiRequest).mockImplementation(path => path === '/api/v1/plan-usage' ? Promise.resolve(questionUsage(10)) : respond(path))
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  fireEvent.press(screen.getByLabelText('원문에 질문하기'))
  await screen.findByText('오늘 공고 원문 질문 10회를 모두 썼어요. 자정(서울 시간)에 다시 채워져요.')
  expect(screen.getByLabelText('공고에 대해 궁금한 점').props.editable).toBe(false)
  expect(screen.queryByText('예시 질문')).toBeNull()
  expect(screen.getByLabelText('질문 보내기')).toBeDisabled()
  fireEvent.press(screen.getByLabelText('질문 보내기'))
  expect(answer).not.toHaveBeenCalled()
  expect(screen.queryByText(/업그레이드|요금제 보기|결제/)).toBeNull()
})

test('a quota rejection after a stale count leaves a single limit message and keeps the draft', async () => {
  let used = 9
  jest.mocked(apiRequest).mockImplementation(path => path === '/api/v1/plan-usage' ? Promise.resolve(questionUsage(used)) : respond(path))
  answer.mockImplementationOnce(async () => {
    used = 10
    throw new PlanQuotaExceededError({ feature: 'EVIDENCE_QUESTION', period: 'DAY', plan: 'FREE', limit: 10, resetsAt })
  })
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  fireEvent.press(screen.getByLabelText('원문에 질문하기'))
  const stale = '공고 원문 질문 오늘 9/10회 · 자정(서울 시간)에 다시 채워져요.'
  await screen.findByText(stale)
  fireEvent.changeText(screen.getByLabelText('공고에 대해 궁금한 점'), '마지막 질문')
  // 거절 뒤 이용량을 다시 읽는 비동기 흐름까지 끝낸 뒤 확인합니다.
  await act(async () => { fireEvent.press(screen.getByLabelText('질문 보내기')) })
  await waitFor(() => expect(screen.queryByText(stale)).toBeNull())
  // 거절 안내와 다시 읽은 이용량이 같은 문장이라 한 번만 보입니다.
  expect(screen.getAllByText('오늘 공고 원문 질문 10회를 모두 썼어요. 자정(서울 시간)에 다시 채워져요.')).toHaveLength(1)
  expect(screen.getByLabelText('공고에 대해 궁금한 점').props.editable).toBe(false)
  expect(screen.getByLabelText('질문 보내기')).toBeDisabled()
  expect(screen.getByLabelText('공고에 대해 궁금한 점').props.value).toBe('마지막 질문')
  expect(answer).toHaveBeenCalledTimes(1)
})

test('cancelling an evidence request preserves the draft and never displays its late answer', async () => {
  let finish!: (value: unknown) => void
  answer.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  fireEvent.press(screen.getByLabelText('원문에 질문하기'))
  fireEvent.changeText(screen.getByLabelText('공고에 대해 궁금한 점'), '취소할 질문')
  fireEvent.press(screen.getByLabelText('질문 보내기'))
  await screen.findByLabelText('원문에서 답변을 찾는 중')
  fireEvent.press(screen.getByLabelText('요청 중지'))
  expect(screen.getByLabelText('공고에 대해 궁금한 점').props.value).toBe('취소할 질문')
  await act(async () => finish({ answerStatus: 'ANSWERED', answer: '늦은 답변', citations: [] }))
  expect(screen.queryByText('늦은 답변')).toBeNull()
})

test.each(['닫기', '시트 닫기', '기기 뒤로가기'])('closing via %s requires an explicit stop and preserves the draft on reopening', async closeLabel => {
  const alert = jest.spyOn(Alert, 'alert')
  let finish!: (value: unknown) => void
  answer.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  fireEvent.press(screen.getByLabelText('원문에 질문하기'))
  fireEvent.changeText(screen.getByLabelText('공고에 대해 궁금한 점'), '유지할 질문')
  fireEvent.press(screen.getByLabelText('질문 보내기'))
  await screen.findByLabelText('원문에서 답변을 찾는 중')
  const signal = answer.mock.calls[0][1] as AbortSignal
  if (closeLabel === '기기 뒤로가기') act(() => screen.UNSAFE_getAllByType(Modal).find(item => item.props.visible)?.props.onRequestClose())
  else fireEvent.press(screen.getByLabelText(closeLabel, { includeHiddenElements: closeLabel === '시트 닫기' }))
  expect(signal.aborted).toBe(false)
  expect(alert).toHaveBeenCalledWith('답변 요청을 중지할까요?', expect.any(String), expect.any(Array))
  const stop = alert.mock.calls.at(-1)![2]!.find(button => button.text === '중지하고 닫기')!.onPress!
  act(() => stop())
  expect(signal.aborted).toBe(true)
  await act(async () => finish({ answerStatus: 'ANSWERED', answer: '늦은 답변', citations: [] }))
  fireEvent.press(screen.getByLabelText('원문에 질문하기'))
  expect(screen.getByLabelText('공고에 대해 궁금한 점').props.value).toBe('유지할 질문')
  expect(screen.queryByText('늦은 답변')).toBeNull()
})

test('continuing to wait keeps the request active and shows its eventual answer', async () => {
  const alert = jest.spyOn(Alert, 'alert')
  let finish!: (value: unknown) => void
  answer.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  fireEvent.press(screen.getByLabelText('원문에 질문하기'))
  fireEvent.changeText(screen.getByLabelText('공고에 대해 궁금한 점'), '기다릴 질문')
  fireEvent.press(screen.getByLabelText('질문 보내기'))
  await screen.findByLabelText('원문에서 답변을 찾는 중')
  fireEvent.press(screen.getByLabelText('닫기'))
  const keepWaiting = alert.mock.calls.at(-1)![2]!.find(button => button.text === '계속 기다리기')!
  act(() => keepWaiting.onPress?.())
  expect((answer.mock.calls[0][1] as AbortSignal).aborted).toBe(false)
  await act(async () => finish({ answerStatus: 'ANSWERED', answer: '기다린 답변', citations: [] }))
  expect(screen.getByText('기다린 답변')).toBeTruthy()
  expect(screen.getByLabelText('공고에 대해 궁금한 점').props.value).toBe('')
})

test.each(['account', 'program'] as const)('a stale close confirmation cannot stop a new request after the %s changes', async destination => {
  const alert = jest.spyOn(Alert, 'alert')
  const pending: ((value: unknown) => void)[] = []
  answer.mockImplementation(() => new Promise(resolve => { pending.push(resolve) }))
  const client = { getDetail: jest.fn().mockResolvedValue(programDetail), answerEvidenceQuestion: answer }
  jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
  const props = { identity, onLogin: jest.fn() }
  const view = render(<ProgramScreen {...props} />)
  await screen.findByText('테스트 지원사업')
  fireEvent.press(screen.getByLabelText('원문에 질문하기'))
  fireEvent.changeText(screen.getByLabelText('공고에 대해 궁금한 점'), '이전 질문')
  fireEvent.press(screen.getByLabelText('질문 보내기'))
  await screen.findByLabelText('원문에서 답변을 찾는 중')
  fireEvent.press(screen.getByLabelText('닫기'))
  const stop = alert.mock.calls.at(-1)![2]!.find(button => button.text === '중지하고 닫기')!.onPress!
  const nextIdentity = destination === 'program' ? { ...identity, sourceProgramId: 'P/999' } : identity
  if (destination === 'account') jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'next-owner' }, invalidateSession } as unknown as ReturnType<typeof useAuth>)
  else client.getDetail.mockResolvedValue({ ...programDetail, id: 'P/999', title: '다음 공고' })
  view.rerender(<ProgramScreen {...props} identity={nextIdentity} />)
  await screen.findAllByText(destination === 'program' ? '다음 공고' : '테스트 지원사업')
  await waitFor(() => expect((answer.mock.calls[0][1] as AbortSignal).aborted).toBe(true))
  fireEvent.changeText(screen.getByLabelText('공고에 대해 궁금한 점'), '새 대상의 질문')
  fireEvent.press(screen.getByLabelText('질문 보내기'))
  await waitFor(() => expect(answer).toHaveBeenCalledTimes(2))
  const nextSignal = answer.mock.calls[1][1] as AbortSignal
  act(() => stop())
  expect(nextSignal.aborted).toBe(false)
  expect(screen.getByLabelText('공고에 대해 궁금한 점').props.value).toBe('새 대상의 질문')
  await act(async () => {
    pending[0]({ answerStatus: 'ANSWERED', answer: '이전 답변', citations: [] })
    pending[1]({ answerStatus: 'ANSWERED', answer: '새 대상의 답변', citations: [] })
  })
  expect(screen.queryByText('이전 답변')).toBeNull()
  expect(screen.getByText('새 대상의 답변')).toBeTruthy()
})


test('a failed follow-up keeps the prior answer and current question for explicit retry', async () => {
  render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  fireEvent.press(screen.getByLabelText('원문에 질문하기'))
  fireEvent.changeText(screen.getByLabelText('공고에 대해 궁금한 점'), '첫 질문')
  fireEvent.press(screen.getByLabelText('질문 보내기'))
  await screen.findByText('공고 원문 답변')
  answer.mockRejectedValueOnce(new Error('offline'))
  fireEvent.changeText(screen.getByLabelText('공고에 대해 궁금한 점'), '재시도할 질문')
  fireEvent.press(screen.getByLabelText('질문 보내기'))
  await screen.findByText('연결하지 못했거나 응답을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.')
  expect(screen.getByText('공고 원문 답변')).toBeTruthy()
  expect(screen.getByLabelText('공고에 대해 궁금한 점').props.value).toBe('재시도할 질문')
  expect(answer).toHaveBeenCalledTimes(2)
  fireEvent.press(screen.getByLabelText('질문 보내기'))
  await waitFor(() => expect(answer).toHaveBeenCalledTimes(3))
  await waitFor(() => expect(screen.getByLabelText('공고에 대해 궁금한 점').props.value).toBe(''))
})

test.each(['account', 'program'] as const)('changing the %s clears the thread and discards a previous pending answer', async destination => {
  const view = render(<ProgramScreen identity={identity} onLogin={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  fireEvent.press(screen.getByLabelText('원문에 질문하기'))
  fireEvent.changeText(screen.getByLabelText('공고에 대해 궁금한 점'), '이전 질문')
  fireEvent.press(screen.getByLabelText('질문 보내기'))
  await screen.findByText('공고 원문 답변')
  let finish!: (value: unknown) => void
  answer.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.changeText(screen.getByLabelText('공고에 대해 궁금한 점'), '이전 대상의 추가 질문')
  fireEvent.press(screen.getByLabelText('질문 보내기'))
  await waitFor(() => expect(answer).toHaveBeenCalledTimes(2))
  const pendingSignal = answer.mock.calls[1][1] as AbortSignal
  const nextIdentity = destination === 'program' ? { ...identity, sourceProgramId: 'P/999' } : identity
  if (destination === 'account') jest.mocked(useAuth).mockReturnValue({ status: 'signedIn',
    session: { accessToken: 'next-owner' }, invalidateSession } as unknown as ReturnType<typeof useAuth>)
  else jest.mocked(programClient).mockReturnValue({ getDetail: jest.fn().mockResolvedValue({ ...programDetail, id: 'P/999', title: '다음 공고' }),
    answerEvidenceQuestion: answer } as unknown as ReturnType<typeof programClient>)
  view.rerender(<ProgramScreen identity={nextIdentity} onLogin={jest.fn()} />)
  await waitFor(() => expect(pendingSignal.aborted).toBe(true))
  expect(screen.queryByText('공고 원문 답변')).toBeNull()
  expect(screen.queryByText('이전 질문')).toBeNull()
  await act(async () => finish({ answerStatus: 'ANSWERED', answer: '이전 대상의 늦은 답변', citations: [] }))
  expect(screen.queryByText('이전 대상의 늦은 답변')).toBeNull()
  await waitFor(() => expect(screen.getByLabelText('공고에 대해 궁금한 점').props.value).toBe(''))
})
