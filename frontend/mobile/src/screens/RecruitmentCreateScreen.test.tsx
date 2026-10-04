import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Alert } from 'react-native'
import type { SupportProgram } from '@govbiz/shared/domain/entities/SupportProgram'
import type { PartnerRecruitment } from '@govbiz/shared/domain/entities/PartnerRecruitment'
import { ApiError } from '../api/client'
import { createRecruitment } from '../api/partners'
import { listSavedPrograms } from '../api/savedPrograms'
import { useAuth } from '../auth/session'
import { RecruitmentCreateScreen } from './RecruitmentCreateScreen'

jest.mock('expo-router', () => ({ useNavigation: () => ({ dispatch: jest.fn() }), useFocusEffect: (effect: () => (() => void) | undefined) => {
  const React = jest.requireActual<typeof import('react')>('react')
  React.useEffect(effect, [effect])
} }))
jest.mock('expo-router/react-navigation', () => ({ usePreventRemove: jest.fn() }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/partners', () => ({ ...jest.requireActual('../api/partners'), createRecruitment: jest.fn() }))
jest.mock('../api/savedPrograms', () => ({ listSavedPrograms: jest.fn() }))

const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)
const after = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
const program: SupportProgram = { sourceCode: 'BIZINFO', id: 'same-id', title: '공동 제조 과제', organization: '지원 기관',
  summary: '', categories: [], regions: ['전국'], targetDescription: '제조 중소기업', applicationPeriod: '',
  applicationStartDate: null, applicationEndDate: after(2), status: 'OPEN', sourceName: '기업마당',
  sourceUrl: 'https://example.test/program', matchedReasons: [], recommendationScore: null, eligibilityReview: null }
const callbacks = { onLogin: jest.fn(), onCompany: jest.fn(), onSavedPrograms: jest.fn(), onCreated: jest.fn(), onCancel: jest.fn() }
const invalidateSession = jest.fn().mockResolvedValue(undefined)
const auth = { status: 'signedIn', session: { accessToken: 'owner-token', account: {
  email: 'owner@example.test', company: { companyName: '우리 기업', businessStatusCode: '01' },
} }, invalidateSession } as unknown as ReturnType<typeof useAuth>

beforeEach(() => {
  Object.values(callbacks).forEach(callback => callback.mockClear())
  invalidateSession.mockClear()
  jest.mocked(useAuth).mockReturnValue(auth)
  jest.mocked(listSavedPrograms).mockReset().mockResolvedValue([{ savedAt: '', program }])
  jest.mocked(createRecruitment).mockReset().mockResolvedValue({ outcome: 'created', recruitment: { id: 19 } as PartnerRecruitment })
})
afterEach(() => jest.restoreAllMocks())

test('cancelling a populated draft preserves its inputs until the user confirms leaving', () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  render(<RecruitmentCreateScreen {...callbacks} />)
  fireEvent.changeText(screen.getByLabelText('모집글 제목 *'), '작성 중인 모집글')
  fireEvent.changeText(screen.getByLabelText('협업 소개 *'), '입력한 협업 소개')
  fireEvent.press(screen.getByLabelText('취소'))
  expect(callbacks.onCancel).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('작성 중인 모집글을 나갈까요?', expect.any(String), expect.any(Array))
  act(() => alert.mock.calls[0][2]?.find(button => button.style === 'cancel')?.onPress?.())
  expect(screen.getByLabelText('모집글 제목 *').props.value).toBe('작성 중인 모집글')
  expect(screen.getByLabelText('협업 소개 *').props.value).toBe('입력한 협업 소개')
  fireEvent.press(screen.getByLabelText('취소'))
  act(() => alert.mock.calls[1][2]?.find(button => button.text === '나가기')?.onPress?.())
  expect(callbacks.onCancel).toHaveBeenCalledTimes(1)
})

test('an untouched draft cancels without a discard confirmation', () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  render(<RecruitmentCreateScreen {...callbacks} />)
  fireEvent.press(screen.getByLabelText('취소'))
  expect(callbacks.onCancel).toHaveBeenCalledTimes(1)
  expect(alert).not.toHaveBeenCalled()
})

async function chooseProgram(label = '공고 선택: 기업마당 공동 제조 과제') {
  fireEvent.press(screen.getByLabelText('관심 공고함에서 선택'))
  await screen.findByLabelText(label)
  fireEvent.press(screen.getByLabelText(label))
}
async function fillRequired() {
  await chooseProgram()
  fireEvent.press(screen.getByLabelText('모집 마감일 선택'))
  fireEvent.press(screen.getByLabelText(`마감일 ${today}`))
  fireEvent.changeText(screen.getByLabelText('모집글 제목 *'), '  제조 과제 참여기업 모집  ')
  fireEvent.changeText(screen.getByLabelText('협업 소개 *'), '  우리는 총괄을 맡고 AI 기술을 보유한 참여기업을 찾습니다.  ')
}

test('direct access requires login and a registered active business without reading private programs', () => {
  jest.mocked(useAuth).mockReturnValue({ ...auth, status: 'signedOut', session: null })
  const view = render(<RecruitmentCreateScreen {...callbacks} />)
  fireEvent.press(screen.getByLabelText('로그인하기'))
  expect(callbacks.onLogin).toHaveBeenCalledTimes(1)
  for (const company of [null, { companyName: '휴업 기업', businessStatusCode: '02' }]) {
    jest.mocked(useAuth).mockReturnValue({ ...auth, session: { ...auth.session!, account: { ...auth.session!.account, company } } } as ReturnType<typeof useAuth>)
    view.rerender(<RecruitmentCreateScreen {...callbacks} />)
    expect(screen.queryByLabelText('모집글 제목 *')).toBeNull()
    fireEvent.press(screen.getByLabelText('기업 정보 확인'))
  }
  expect(callbacks.onCompany).toHaveBeenCalledTimes(2)
  expect(listSavedPrograms).not.toHaveBeenCalled()
  expect(createRecruitment).not.toHaveBeenCalled()
})

test('saved picker loads only on opening, preserves composite identity, and blocks closed and today-closing programs', async () => {
  const second = { ...program, sourceCode: 'SMES24', sourceName: '중소벤처24' }
  jest.mocked(listSavedPrograms).mockResolvedValue([program, second, { ...program, id: 'closed', title: '접수 종료', status: 'CLOSED' as const },
    { ...program, id: 'today', title: '오늘 종료', applicationEndDate: today }].map(program => ({ program, savedAt: '' })))
  render(<RecruitmentCreateScreen {...callbacks} />)
  expect(listSavedPrograms).not.toHaveBeenCalled()
  await chooseProgram('공고 선택: 중소벤처24 공동 제조 과제')
  expect(listSavedPrograms).toHaveBeenCalledWith('owner-token', expect.any(AbortSignal))
  fireEvent.press(screen.getByLabelText('공고 변경'))
  await screen.findByLabelText('공고 선택: 기업마당 접수 종료')
  expect(screen.getByLabelText('공고 선택: 기업마당 접수 종료').props.accessibilityState.disabled).toBe(true)
  expect(screen.getByLabelText('공고 선택: 기업마당 오늘 종료').props.accessibilityState.disabled).toBe(true)
  expect(screen.getByLabelText('공고 선택: 중소벤처24 공동 제조 과제').props.accessibilityState.selected).toBe(true)
  expect(screen.getByLabelText('공고 선택: 기업마당 공동 제조 과제').props.accessibilityState.selected).toBe(false)
})

test('calendar allows today and the day before program closing, but blocks the program closing day', async () => {
  render(<RecruitmentCreateScreen {...callbacks} />)
  await chooseProgram()
  fireEvent.press(screen.getByLabelText('모집 마감일 선택'))
  if (after(1).slice(0, 7) !== today.slice(0, 7)) fireEvent.press(screen.getByLabelText('다음 달'))
  expect(screen.getByLabelText(`마감일 ${after(1)}`).props.accessibilityState.disabled).toBe(false)
  // The month boundary may place the closing day on the next calendar page.
  if (after(2).slice(0, 7) === after(1).slice(0, 7)) expect(screen.getByLabelText(`마감일 ${after(2)}`).props.accessibilityState.disabled).toBe(true)
  fireEvent.press(screen.getByLabelText(`마감일 ${after(1)}`))
  expect(screen.getByLabelText('모집 마감일 선택').props.accessibilityLabel).toBe('모집 마감일 선택')
})

test('invalid form never posts, while explicit submit preserves roles, conditions and a pending capability', async () => {
  render(<RecruitmentCreateScreen {...callbacks} />)
  fireEvent.press(screen.getByLabelText('모집글 등록'))
  expect(screen.getByText('관심 공고함에서 연결할 공고를 선택해 주세요.')).toBeTruthy()
  expect(createRecruitment).not.toHaveBeenCalled()
  await fillRequired()
  fireEvent.press(screen.getByLabelText('찾는 역할 수요처'))
  fireEvent.press(screen.getByLabelText('찾는 기업 수 늘리기'))
  fireEvent.changeText(screen.getByLabelText('희망 최소 업력 (선택)'), '0')
  fireEvent.press(screen.getByLabelText('모집글 등록'))
  expect(screen.getByText('희망 업력은 1~50년의 정수로 입력하거나 비워 두세요.')).toBeTruthy()
  expect(createRecruitment).not.toHaveBeenCalled()
  fireEvent.changeText(screen.getByLabelText('희망 최소 업력 (선택)'), '3')
  fireEvent.changeText(screen.getByLabelText('필요 역량 입력'), ' AI 분석 ')
  fireEvent.press(screen.getByLabelText('모집글 등록'))
  await waitFor(() => expect(createRecruitment).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'same-id',
    ownRole: 'LEAD', seekingRole: 'DEMAND', seekingCount: 2, region: '전국', capabilities: ['AI 분석'],
    minimumCompanyAgeYears: 3, recruitmentDeadline: today, title: '제조 과제 참여기업 모집',
    body: '우리는 총괄을 맡고 AI 기술을 보유한 참여기업을 찾습니다.' }, 'owner-token', expect.any(AbortSignal)))
  expect(callbacks.onCreated).toHaveBeenCalledWith(19)
})

test('double submit is guarded and a server conflict keeps all typed content', async () => {
  let finish!: (result: Awaited<ReturnType<typeof createRecruitment>>) => void
  jest.mocked(createRecruitment).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  render(<RecruitmentCreateScreen {...callbacks} />)
  await fillRequired()
  fireEvent.press(screen.getByLabelText('모집글 등록'))
  fireEvent.press(screen.getByLabelText('모집글 등록'))
  expect(createRecruitment).toHaveBeenCalledTimes(1)
  await act(async () => finish({ outcome: 'already-exists' }))
  expect(screen.getByText('이 공고에는 이미 내 모집글이 있어요. 공고당 모집글은 하나만 등록할 수 있어요.')).toBeTruthy()
  expect(screen.getByLabelText('모집글 제목 *').props.value).toBe('  제조 과제 참여기업 모집  ')
  expect(callbacks.onCreated).not.toHaveBeenCalled()
})

test('saved-program failures can be retried without showing fake programs', async () => {
  jest.mocked(listSavedPrograms).mockRejectedValueOnce(new Error('network error'))
  render(<RecruitmentCreateScreen {...callbacks} />)
  fireEvent.press(screen.getByLabelText('관심 공고함에서 선택'))
  await screen.findByLabelText('관심 공고 다시 불러오기')
  expect(screen.queryByText('공동 제조 과제')).toBeNull()
  fireEvent.press(screen.getByLabelText('관심 공고 다시 불러오기'))
  await screen.findByLabelText('공고 선택: 기업마당 공동 제조 과제')
})

test('empty saved programs offer the existing saved tab', async () => {
  jest.mocked(listSavedPrograms).mockResolvedValue([])
  render(<RecruitmentCreateScreen {...callbacks} />)
  fireEvent.press(screen.getByLabelText('관심 공고함에서 선택'))
  await screen.findByLabelText('관심 공고함으로')
  fireEvent.press(screen.getByLabelText('관심 공고함으로'))
  expect(callbacks.onSavedPrograms).toHaveBeenCalledTimes(1)
})

test('session expiry invalidates login, and late results after changing accounts cannot navigate', async () => {
  jest.mocked(createRecruitment).mockRejectedValueOnce(new ApiError(401, '로그인이 만료되었습니다.'))
  const view = render(<RecruitmentCreateScreen {...callbacks} />)
  await fillRequired()
  fireEvent.press(screen.getByLabelText('모집글 등록'))
  await waitFor(() => expect(invalidateSession).toHaveBeenCalledTimes(1))
  let finish!: (result: Awaited<ReturnType<typeof createRecruitment>>) => void
  jest.mocked(createRecruitment).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.press(screen.getByLabelText('모집글 등록'))
  await waitFor(() => expect(createRecruitment).toHaveBeenCalledTimes(2))
  const signal = jest.mocked(createRecruitment).mock.calls[1][2]!
  jest.mocked(useAuth).mockReturnValue({ ...auth, session: { ...auth.session!, accessToken: 'other-owner' } })
  view.rerender(<RecruitmentCreateScreen {...callbacks} />)
  expect(signal.aborted).toBe(true)
  expect(screen.getByLabelText('모집글 제목 *').props.value).toBe('')
  await act(async () => finish({ outcome: 'created', recruitment: { id: 19 } as PartnerRecruitment }))
  expect(callbacks.onCreated).not.toHaveBeenCalled()
})
