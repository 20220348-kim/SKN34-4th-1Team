import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import * as Clipboard from 'expo-clipboard'
import { apiRequest, programClient } from '../api/client'
import { closeRecruitment, getRecruitment, sendProposal } from '../api/partners'
import { useAuth } from '../auth/session'
import { RecruitmentDetailScreen } from './RecruitmentDetailScreen'

jest.mock('expo-router', () => ({ useFocusEffect: (effect: () => () => void) => {
  const React = jest.requireActual<typeof import('react')>('react')
  React.useEffect(effect, [effect])
} }))
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), apiRequest: jest.fn(), programClient: jest.fn() }))
jest.mock('../api/partners', () => ({ ...jest.requireActual('../api/partners'), getRecruitment: jest.fn(),
  sendProposal: jest.fn(), closeRecruitment: jest.fn() }))

const recruitment = {
  id: 9, title: '정밀 가공 부품 국산화 과제, 수요처 찾습니다', seekingRole: 'DEMAND' as const,
  seekingCount: 2, region: '전국', capabilities: ['부품 구매 계획', '품질 검증'], recruitmentDeadline: '2026-10-07',
  status: 'OPEN' as const, isMine: false, proposalCount: 3, createdAt: '2026-09-28T10:00:00+09:00',
  company: { companyName: '한빛정밀', region: '경기', industry: '제조업', foundedYear: 2019,
    isEmailVerified: true, isBusinessVerified: true },
  program: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_123', title: '2026년 중소기업제품 전용 구매 지원사업',
    organization: '중소벤처기업부', summary: '', targetDescription: '', applicationPeriod: '2026-09-08 ~ 2026-10-12',
    applicationEndDate: '2026-10-12', sourceUrl: 'https://www.bizinfo.go.kr/detail?id=PBLN_123' },
  body: '시제품을 실제로 구매·검증해 주실 수요처를 찾습니다.', myProposal: null,
  ownRole: 'LEAD' as const, minimumCompanyAgeYears: null, updatedAt: '2026-09-28T10:00:00+09:00',
}
const company = { businessNumber: '1234567890', companyName: '넥스트웨이브', businessStatus: '계속사업자',
  businessStatusCode: '01', region: '경기', industry: '제조업', foundedYear: 2019, homepageUrl: null,
  businessVerifiedAt: '2026-09-28T10:00:00+09:00', updatedAt: '2026-09-28T10:00:00+09:00' }
const callbacks = { onLogin: jest.fn(), onCompany: jest.fn(), onProgram: jest.fn(), onInbox: jest.fn() }

beforeEach(() => {
  Object.values(callbacks).forEach((callback) => callback.mockClear())
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: {
    accessToken: 'my-token', account: { company: { businessStatusCode: '01' } },
  }, invalidateSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
  jest.mocked(getRecruitment).mockReset().mockResolvedValue(recruitment)
  jest.mocked(apiRequest).mockReset().mockResolvedValue(company)
  jest.mocked(programClient).mockReset().mockReturnValue({ getDetail: jest.fn().mockResolvedValue({ status: 'OPEN' })
  } as unknown as ReturnType<typeof programClient>)
  jest.mocked(sendProposal).mockReset().mockResolvedValue({ id: 15,
    recruitment: { id: 9, title: recruitment.title, status: 'OPEN', recruitmentDeadline: recruitment.recruitmentDeadline },
    status: 'PENDING' } as Awaited<ReturnType<typeof sendProposal>>)
  jest.mocked(closeRecruitment).mockReset()
  jest.mocked(Clipboard.setStringAsync).mockClear()
  delete process.env.EXPO_PUBLIC_WEB_BASE_URL
})

test('connected program retains its composite identity and the web share link needs an explicit origin', async () => {
  render(<RecruitmentDetailScreen id={9} {...callbacks} />)
  await screen.findByText('협업 소개', {}, { timeout: 5_000 })
  fireEvent.press(screen.getByLabelText(/연결된 공고 .* 상세 보기/))
  expect(callbacks.onProgram).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_123' })
  fireEvent.press(screen.getByText('링크 복사'))
  await screen.findByText('웹 주소가 설정되지 않았습니다. 앱의 공개 웹 주소 설정을 확인해 주세요.')
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled()
  process.env.EXPO_PUBLIC_WEB_BASE_URL = 'https://example.test/'
  fireEvent.press(screen.getByText('링크 복사'))
  await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith('https://example.test/partners/detail?recruitmentId=9'))
})

test('connected program uses its current API status and shows the full future deadline', async () => {
  jest.mocked(getRecruitment).mockResolvedValueOnce({ ...recruitment,
    program: { ...recruitment.program, applicationEndDate: '2027-06-30' } })
  render(<RecruitmentDetailScreen id={9} {...callbacks} />)
  await screen.findByText('접수 중')
  expect(screen.getByText('접수 마감일 2027.06.30')).toBeTruthy()
  expect(screen.queryByText('접수 마감 06.30')).toBeNull()
})

test('proposal requires an explicit message and keeps the checked company profile independent of contact release', async () => {
  render(<RecruitmentDetailScreen id={9} {...callbacks} />)
  await screen.findByText('협업 소개')
  expect(sendProposal).not.toHaveBeenCalled()
  fireEvent.press(screen.getByText('제안 보내기'))
  await screen.findByText('제안 메시지 *')
  expect(screen.getByText(/넥스트웨이브 · 경기 · 제조업 · 2019년 설립/)).toBeTruthy()
  expect(screen.getByText('연락처는 제안 수락 후 공개돼요.')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('기업 정보 함께 보이기'))
  fireEvent.changeText(screen.getByLabelText('제안 메시지'), '제조 현장 실증에 참여하겠습니다.')
  fireEvent.press(screen.getByText('보내기'))
  await waitFor(() => expect(sendProposal).toHaveBeenCalledWith(9,
    { message: '제조 현장 실증에 참여하겠습니다.', shareProfile: false }, 'my-token', expect.anything()))
  await screen.findByText('제안을 보냈어요')
})
