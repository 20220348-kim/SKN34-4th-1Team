import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Alert } from 'react-native'
import { useAuth } from '../auth/session'
import { ApiError } from '../api/client'
import { createRecruitment, getRecruitment, updateRecruitment } from '../api/partners'
import { listSavedPrograms } from '../api/savedPrograms'
import { ownedRecruitment, recruitmentDateAfter } from '../test/recruitmentFixtures'
import { RecruitmentCreateScreen } from './RecruitmentCreateScreen'

jest.mock('expo-router', () => ({ useNavigation: () => ({ dispatch: jest.fn() }), useFocusEffect: (effect: () => (() => void) | undefined) => {
  const React = jest.requireActual<typeof import('react')>('react'); React.useEffect(effect, [effect])
} }))
jest.mock('expo-router/react-navigation', () => ({ usePreventRemove: jest.fn() }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/partners', () => ({ ...jest.requireActual('../api/partners'), createRecruitment: jest.fn(), getRecruitment: jest.fn(), updateRecruitment: jest.fn() }))
jest.mock('../api/savedPrograms', () => ({ listSavedPrograms: jest.fn() }))
const callbacks = { onLogin: jest.fn(), onCompany: jest.fn(), onSavedPrograms: jest.fn(), onCreated: jest.fn(), onCancel: jest.fn() }
const invalidate = jest.fn().mockResolvedValue(undefined)
const auth = { status: 'signedIn', session: { accessToken: 'owner', account: { email: 'owner@test.com', company: { companyName: '등록 기업', businessStatusCode: '01' } } }, invalidateSession: invalidate } as unknown as ReturnType<typeof useAuth>
beforeEach(() => {
  Object.values(callbacks).forEach(fn => fn.mockClear()); invalidate.mockClear()
  jest.mocked(useAuth).mockReturnValue(auth)
  jest.mocked(getRecruitment).mockReset().mockResolvedValue(ownedRecruitment)
  jest.mocked(updateRecruitment).mockReset().mockResolvedValue({ outcome: 'updated', recruitment: ownedRecruitment })
  jest.mocked(createRecruitment).mockClear(); jest.mocked(listSavedPrograms).mockClear()
})
afterEach(() => jest.restoreAllMocks())

test('direct edit access requires a verified session and active company before reading private ownership', () => {
  jest.mocked(useAuth).mockReturnValue({ ...auth, status: 'signedOut', session: null })
  const view = render(<RecruitmentCreateScreen recruitmentId={19} {...callbacks} />)
  fireEvent.press(screen.getByLabelText('로그인하기'))
  expect(callbacks.onLogin).toHaveBeenCalledTimes(1)
  jest.mocked(useAuth).mockReturnValue({ ...auth, session: { ...auth.session!, account: { ...auth.session!.account, company: null } } })
  view.rerender(<RecruitmentCreateScreen recruitmentId={19} {...callbacks} />)
  fireEvent.press(screen.getByLabelText('기업 정보 확인'))
  expect(callbacks.onCompany).toHaveBeenCalledTimes(1)
  expect(getRecruitment).not.toHaveBeenCalled(); expect(updateRecruitment).not.toHaveBeenCalled()
})

test('editing hydrates all existing content and locks its program without reading saved programs or posting', async () => {
  render(<RecruitmentCreateScreen recruitmentId={19} {...callbacks} />)
  await screen.findByDisplayValue(ownedRecruitment.title)
  expect(getRecruitment).toHaveBeenCalledWith(19, 'owner', expect.any(AbortSignal))
  expect(screen.getByDisplayValue(ownedRecruitment.body)).toBeTruthy()
  expect(screen.getByDisplayValue('3')).toBeTruthy()
  expect(screen.getByLabelText('우리 역할 참여기관').props.accessibilityState.checked).toBe(true)
  expect(screen.getByLabelText('찾는 역할 수요처').props.accessibilityState.checked).toBe(true)
  expect(screen.getByText('2곳')).toBeTruthy()
  expect(screen.getByLabelText('희망 지역: 경기')).toBeTruthy()
  expect(screen.getByText('현장 실증 ×')).toBeTruthy()
  expect(screen.getByText('품질 검증 ×')).toBeTruthy()
  expect(screen.queryByLabelText('공고 변경')).toBeNull()
  expect(screen.queryByLabelText('관심 공고함에서 선택')).toBeNull()
  expect(screen.getByLabelText('수정 내용 저장').props.accessibilityState.disabled).toBe(true)
  expect(listSavedPrograms).not.toHaveBeenCalled()
  expect(updateRecruitment).not.toHaveBeenCalled(); expect(createRecruitment).not.toHaveBeenCalled()
})

test('an explicit edit saves content and a pending capability without source identifiers', async () => {
  render(<RecruitmentCreateScreen recruitmentId={19} {...callbacks} />)
  await screen.findByDisplayValue(ownedRecruitment.title)
  fireEvent.changeText(screen.getByLabelText('모집글 제목 *'), '  수정한 제목  ')
  fireEvent.changeText(screen.getByLabelText('협업 소개 *'), '  수정한 소개  ')
  fireEvent.press(screen.getByLabelText('우리 역할 주관기관'))
  fireEvent.press(screen.getByLabelText('찾는 기업 수 늘리기'))
  fireEvent.changeText(screen.getByLabelText('필요 역량 입력'), ' AI 분석 ')
  fireEvent.press(screen.getByLabelText('수정 내용 저장'))
  await waitFor(() => expect(callbacks.onCreated).toHaveBeenCalledWith(19))
  expect(updateRecruitment).toHaveBeenCalledWith(19, { title: '수정한 제목', body: '수정한 소개', ownRole: 'LEAD', seekingRole: 'DEMAND',
    seekingCount: 3, region: '경기', capabilities: ['현장 실증', '품질 검증', 'AI 분석'], minimumCompanyAgeYears: 3,
    recruitmentDeadline: ownedRecruitment.recruitmentDeadline }, 'owner', expect.any(AbortSignal))
  expect(createRecruitment).not.toHaveBeenCalled()
})

test.each([{ isMine: false, status: 'OPEN' as const, message: '내가 쓴 모집글만 수정할 수 있어요.' },
  { isMine: true, status: 'CLOSED' as const, message: '마감된 모집글은 수정할 수 없어요.' }])('direct access rejects noneditable recruitment %j', async ({ message, ...state }) => {
  jest.mocked(getRecruitment).mockResolvedValue({ ...ownedRecruitment, ...state })
  render(<RecruitmentCreateScreen recruitmentId={19} {...callbacks} />)
  await screen.findByText(message)
  expect(screen.queryByLabelText('모집글 제목 *')).toBeNull()
  expect(updateRecruitment).not.toHaveBeenCalled()
})

test('a failed load can be retried and does not render an empty edit form', async () => {
  jest.mocked(getRecruitment).mockRejectedValueOnce(new ApiError(503, '연결 오류'))
  render(<RecruitmentCreateScreen recruitmentId={19} {...callbacks} />)
  await screen.findByLabelText('모집글 다시 불러오기')
  expect(screen.queryByLabelText('모집글 제목 *')).toBeNull()
  fireEvent.press(screen.getByLabelText('모집글 다시 불러오기'))
  await screen.findByDisplayValue(ownedRecruitment.title)
  expect(getRecruitment).toHaveBeenCalledTimes(2)
})

test('editing uses the linked-program deadline limit and blocks invalid content before PUT', async () => {
  render(<RecruitmentCreateScreen recruitmentId={19} {...callbacks} />)
  await screen.findByDisplayValue(ownedRecruitment.title)
  fireEvent.changeText(screen.getByLabelText('모집글 제목 *'), '수정한 제목')
  fireEvent.press(screen.getByLabelText('모집 마감일 선택'))
  const end = ownedRecruitment.program.applicationEndDate!
  if (end.slice(0, 7) !== ownedRecruitment.recruitmentDeadline.slice(0, 7)) fireEvent.press(screen.getByLabelText('다음 달'))
  expect(screen.getByLabelText(`마감일 ${end}`).props.accessibilityState.disabled).toBe(true)
  fireEvent.press(screen.getByText('닫기'))
  fireEvent.changeText(screen.getByLabelText('희망 최소 업력 (선택)'), '0')
  fireEvent.press(screen.getByLabelText('수정 내용 저장'))
  expect(screen.getByText('희망 업력은 1~50년의 정수로 입력하거나 비워 두세요.')).toBeTruthy()
  expect(updateRecruitment).not.toHaveBeenCalled()
})

test('an unchanged hydrated form leaves silently, but edited input is preserved until discard confirmation', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  render(<RecruitmentCreateScreen recruitmentId={19} {...callbacks} />)
  await screen.findByDisplayValue(ownedRecruitment.title)
  fireEvent.press(screen.getByLabelText('취소'))
  expect(alert).not.toHaveBeenCalled(); expect(callbacks.onCancel).toHaveBeenCalledTimes(1)
  fireEvent.changeText(screen.getByLabelText('협업 소개 *'), '수정 중인 소개')
  fireEvent.press(screen.getByLabelText('취소'))
  expect(callbacks.onCancel).toHaveBeenCalledTimes(1)
  expect(alert).toHaveBeenCalledWith('수정 중인 모집글을 나갈까요?', expect.any(String), expect.any(Array))
  expect(screen.getByDisplayValue('수정 중인 소개')).toBeTruthy()
  act(() => alert.mock.calls[0][2]?.find(button => button.text === '나가기')?.onPress?.())
  expect(callbacks.onCancel).toHaveBeenCalledTimes(2)
})

test('double save is guarded and a network failure preserves edited inputs for a manual retry', async () => {
  let fail!: (reason: Error) => void
  jest.mocked(updateRecruitment).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
  render(<RecruitmentCreateScreen recruitmentId={19} {...callbacks} />)
  await screen.findByDisplayValue(ownedRecruitment.title)
  fireEvent.changeText(screen.getByLabelText('모집글 제목 *'), '유지할 제목')
  fireEvent.press(screen.getByLabelText('수정 내용 저장')); fireEvent.press(screen.getByLabelText('수정 내용 저장'))
  expect(updateRecruitment).toHaveBeenCalledTimes(1)
  await act(async () => fail(new ApiError(503, '저장 실패')))
  expect(screen.getByDisplayValue('유지할 제목')).toBeTruthy()
  expect(callbacks.onCreated).not.toHaveBeenCalled()
  expect(screen.getByLabelText('수정 내용 저장').props.accessibilityState.disabled).toBe(false)
})

test.each(['not-found', 'forbidden', 'closed'] as const)('a %s save rejection keeps input and blocks further writes', async (outcome) => {
  jest.mocked(updateRecruitment).mockResolvedValue({ outcome })
  render(<RecruitmentCreateScreen recruitmentId={19} {...callbacks} />)
  await screen.findByDisplayValue(ownedRecruitment.title)
  fireEvent.changeText(screen.getByLabelText('모집글 제목 *'), '유지할 제목')
  fireEvent.press(screen.getByLabelText('수정 내용 저장'))
  await screen.findByLabelText('모집글 상세 다시 확인')
  expect(screen.getByDisplayValue('유지할 제목')).toBeTruthy()
  expect(screen.getByLabelText('수정 내용 저장').props.accessibilityState.disabled).toBe(true)
  expect(callbacks.onCreated).not.toHaveBeenCalled()
})

test('a server deadline rejection is explicit and allows correcting the draft', async () => {
  jest.mocked(updateRecruitment).mockResolvedValue({ outcome: 'deadline-not-allowed', latestAllowedDeadline: recruitmentDateAfter(9) })
  render(<RecruitmentCreateScreen recruitmentId={19} {...callbacks} />)
  await screen.findByDisplayValue(ownedRecruitment.title)
  fireEvent.changeText(screen.getByLabelText('모집글 제목 *'), '수정한 제목')
  fireEvent.press(screen.getByLabelText('수정 내용 저장'))
  await screen.findByText('모집 마감일이 허용되지 않아요. 공고 접수 마감 전날까지의 날짜인지 확인해 주세요.')
  expect(screen.getByDisplayValue('수정한 제목')).toBeTruthy()
  expect(screen.getByLabelText('수정 내용 저장').props.accessibilityState.disabled).toBe(false)
  expect(callbacks.onCreated).not.toHaveBeenCalled()
})

test('401 invalidates the session and an old save response cannot navigate after an account switch', async () => {
  jest.mocked(updateRecruitment).mockRejectedValueOnce(new ApiError(401, '로그인 만료'))
  const view = render(<RecruitmentCreateScreen recruitmentId={19} {...callbacks} />)
  await screen.findByDisplayValue(ownedRecruitment.title)
  fireEvent.changeText(screen.getByLabelText('모집글 제목 *'), '수정한 제목')
  fireEvent.press(screen.getByLabelText('수정 내용 저장'))
  await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1))
  let finish!: (value: Awaited<ReturnType<typeof updateRecruitment>>) => void
  jest.mocked(updateRecruitment).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.press(screen.getByLabelText('수정 내용 저장'))
  const signal = jest.mocked(updateRecruitment).mock.calls[1][3]!
  jest.mocked(getRecruitment).mockResolvedValue({ ...ownedRecruitment, isMine: false })
  jest.mocked(useAuth).mockReturnValue({ ...auth, session: { ...auth.session!, accessToken: 'other' } })
  view.rerender(<RecruitmentCreateScreen recruitmentId={19} {...callbacks} />)
  await screen.findByText('내가 쓴 모집글만 수정할 수 있어요.')
  expect(signal.aborted).toBe(true)
  await act(async () => finish({ outcome: 'updated', recruitment: ownedRecruitment }))
  expect(callbacks.onCreated).not.toHaveBeenCalled()
  expect(screen.queryByDisplayValue('수정한 제목')).toBeNull()
})

test('a response changing the fixed program cannot report edit success', async () => {
  jest.mocked(updateRecruitment).mockResolvedValue({ outcome: 'updated', recruitment: { ...ownedRecruitment, program: { ...ownedRecruitment.program, sourceProgramId: 'other' } } })
  render(<RecruitmentCreateScreen recruitmentId={19} {...callbacks} />)
  await screen.findByDisplayValue(ownedRecruitment.title)
  fireEvent.changeText(screen.getByLabelText('모집글 제목 *'), '수정한 제목')
  fireEvent.press(screen.getByLabelText('수정 내용 저장'))
  await waitFor(() => expect(screen.getByLabelText('수정 내용 저장').props.accessibilityState.busy).toBe(false))
  expect(callbacks.onCreated).not.toHaveBeenCalled()
  expect(screen.getByDisplayValue('수정한 제목')).toBeTruthy()
})
