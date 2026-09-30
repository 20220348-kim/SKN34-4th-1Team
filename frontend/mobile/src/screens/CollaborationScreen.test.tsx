import { Alert } from 'react-native'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { useAuth } from '../auth/session'
import { browseProposals, browseRecruitments, getProposal, respondProposal } from '../api/partners'
import { CollaborationScreen } from './CollaborationScreen'

jest.mock('expo-router', () => ({ useFocusEffect: (effect: () => () => void) => {
  const React = jest.requireActual<typeof import('react')>('react')
  React.useEffect(effect, [effect])
} }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/partners', () => ({ ...jest.requireActual('../api/partners'), browseRecruitments: jest.fn(),
  browseProposals: jest.fn(), getProposal: jest.fn(), respondProposal: jest.fn() }))

const recruitment = {
  id: 9, title: '정밀 가공 부품 국산화 과제, 수요처 찾습니다', seekingRole: 'DEMAND' as const,
  seekingCount: 2, region: '전국', capabilities: ['품질 검증'], recruitmentDeadline: '2026-10-07',
  status: 'OPEN' as const, isMine: false, proposalCount: 3, createdAt: '2026-09-28T10:00:00+09:00',
  company: { companyName: '한빛정밀', region: '경기', industry: '제조업', foundedYear: 2019,
    isEmailVerified: true, isBusinessVerified: true },
  program: { title: '2026년 중소기업제품 전용 구매 지원사업', organization: '중소벤처기업부', applicationEndDate: '2026-10-12' },
}
const received = {
  id: 15, status: 'PENDING' as const, message: '현장 실증에 함께 참여하고 싶습니다.', shareProfile: false, isSent: false,
  recruitment: { id: 9, title: recruitment.title, status: 'OPEN' as const, recruitmentDeadline: '2026-10-07' },
  counterpart: { companyName: '데이터브릿지', isEmailVerified: true, isBusinessVerified: true, profile: null,
    contact: null }, createdAt: '2026-09-28T10:00:00+09:00', expiresAt: '2026-10-05T10:00:00+09:00', respondedAt: null,
}
const onPendingCount = jest.fn()
const onOpenRecruitment = jest.fn()
const onLogin = jest.fn()

beforeEach(() => {
  onPendingCount.mockClear(); onOpenRecruitment.mockClear(); onLogin.mockClear()
  jest.mocked(browseRecruitments).mockReset().mockResolvedValue({ recruitments: [recruitment], total: 1, page: 1, pageSize: 20, totalPages: 1 })
  jest.mocked(browseProposals).mockReset().mockResolvedValue({ box: 'received', proposals: [received], pendingCount: 1 })
  jest.mocked(getProposal).mockReset().mockResolvedValue(received)
  jest.mocked(respondProposal).mockReset()
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null, invalidateSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
})

test('guests browse the real recruitment list without opening a private proposal box', async () => {
  render(<CollaborationScreen view="recruitments" onViewChange={jest.fn()} onPendingCount={onPendingCount}
    onOpenRecruitment={onOpenRecruitment} onLogin={onLogin} />)
  await screen.findByText(recruitment.title)
  expect(screen.getByText('제안 3건')).toBeTruthy()
  expect(screen.queryByText('품질 검증')).toBeNull()
  expect(browseProposals).not.toHaveBeenCalled()
  fireEvent.press(screen.getByText('상세 보기'))
  expect(onOpenRecruitment).toHaveBeenCalledWith(9)
})

test('received proposal defaults to pending, hides unshared company data, and reveals contact after accept', async () => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'my-token' },
    invalidateSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
  jest.mocked(respondProposal).mockResolvedValue({ ...received, status: 'ACCEPTED',
    counterpart: { ...received.counterpart, contact: { email: 'partner@example.test', businessNumber: '1234567890' } } })
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find((button) => button.text === '수락')?.onPress?.()
  })
  render(<CollaborationScreen view="box" onViewChange={jest.fn()} onPendingCount={onPendingCount}
    onOpenRecruitment={onOpenRecruitment} onLogin={onLogin} />)
  await screen.findByText('전체 1')
  fireEvent.press(screen.getByText('열기'))
  await screen.findByText('제안 메시지')
  expect(screen.queryByText(/2019년 설립/)).toBeNull()
  expect(screen.getByText('수락하면 공개돼요')).toBeTruthy()
  fireEvent.press(screen.getByText('수락'))
  await waitFor(() => expect(respondProposal).toHaveBeenCalledWith(15, 'accept', 'my-token'))
  await screen.findByText('partner@example.test', { exact: false })
  alert.mockRestore()
})

test('account switch never leaves the previous account proposal open', async () => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'first-token' },
    invalidateSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
  const view = render(<CollaborationScreen view="box" onViewChange={jest.fn()} onPendingCount={onPendingCount}
    onOpenRecruitment={onOpenRecruitment} onLogin={onLogin} />)
  await screen.findByText('열기')
  fireEvent.press(screen.getByText('열기'))
  await screen.findByText('제안 메시지')
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null,
    invalidateSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
  view.rerender(<CollaborationScreen view="box" onViewChange={jest.fn()} onPendingCount={onPendingCount}
    onOpenRecruitment={onOpenRecruitment} onLogin={onLogin} />)
  await screen.findByText('제안함은 로그인 후 확인할 수 있어요.')
  expect(screen.queryByText('제안 메시지')).toBeNull()
})
