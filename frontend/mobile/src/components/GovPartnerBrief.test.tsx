import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { emptyPartnerRecruitmentConditions, type PartnerRecruitmentRecommendations } from '@govbiz/shared/domain/entities/PartnerRecruitmentRecommendation'
import { useAuth } from '../auth/session'
import { recommendRecruitments } from '../api/partners'
import { ownedRecruitment } from '../test/recruitmentFixtures'
import { GovPartnerBrief } from './GovPartnerBrief'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/partners', () => ({ ...jest.requireActual('../api/partners'), recommendRecruitments: jest.fn() }))
const empty: PartnerRecruitmentRecommendations = { items: [], total: 0, basis: {
  hasCompany: false, profileSet: false, roles: [], capabilityCount: 0, myProgramCount: 0, region: null }, relax: [], suggestedProgram: null }
const conditions = { seekingRoles: ['DEMAND' as const], regions: ['경기'], keywords: ['배터리', '실증'],
  program: { sourceCode: 'BIZINFO', sourceProgramId: 'same-id' } }
const actions = { onOpenPartners: jest.fn(), onOpenRecruitment: jest.fn(), onCompany: jest.fn(), onCreateRecruitment: jest.fn() }
beforeEach(() => {
  Object.values(actions).forEach(mock => mock.mockReset())
  jest.mocked(useAuth).mockReturnValue({ session: { accessToken: 'owner' }, invalidateSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
  jest.mocked(recommendRecruitments).mockReset().mockResolvedValue(empty)
})

test('empty results include company setup and selected saved program creation with its composite identity', async () => {
  const suggestedProgram = { ...conditions.program, title: '배터리 사업' }
  jest.mocked(recommendRecruitments).mockResolvedValue({ ...empty, suggestedProgram })
  render(<GovPartnerBrief conditions={conditions} live active disabled={false} {...actions} />)
  await screen.findByText('기업을 등록하고 역할·역량을 채우면 더 맞춰 드려요.')
  expect(screen.getByText('조건에 맞는 열린 모집글이 없어요.')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('기업 등록하기')); expect(actions.onCompany).toHaveBeenCalledTimes(1)
  fireEvent.press(screen.getByLabelText('이 공고로 모집글 쓰기')); expect(actions.onCreateRecruitment).toHaveBeenCalledWith(suggestedProgram)
  fireEvent.press(screen.getByLabelText('같은 조건으로 파트너 관리에서 보기'))
  expect(actions.onOpenPartners).toHaveBeenCalledWith(conditions)
})

test('only productive relaxations appear and removal reuses the recommendation API without changing other filters', async () => {
  jest.mocked(recommendRecruitments).mockResolvedValue({ ...empty, relax: [{ type: 'ROLE', count: 0 }, { type: 'PROGRAM', count: 4 }] })
  render(<GovPartnerBrief conditions={conditions} live active disabled={false} {...actions} />)
  await screen.findByLabelText('선택한 공고 빼고 보기 (4건)')
  expect(screen.queryByLabelText('찾는 역할 빼고 보기 (0건)')).toBeNull()
  await act(async () => fireEvent.press(screen.getByLabelText('선택한 공고 빼고 보기 (4건)')))
  expect(recommendRecruitments).toHaveBeenLastCalledWith({ ...conditions, program: null }, 'owner', expect.any(AbortSignal))
  await act(async () => fireEvent.press(screen.getByLabelText('배터리 (순서만) 조건 빼기')))
  fireEvent.press(screen.getByLabelText('같은 조건으로 파트너 관리에서 보기'))
  expect(actions.onOpenPartners).toHaveBeenCalledWith({ ...conditions, program: null, keywords: ['실증'] })
})

test('profile basis, recruitment information, reasons, cautions and detail action are available together', async () => {
  jest.mocked(recommendRecruitments).mockResolvedValue({ ...empty, total: 1, basis: { ...empty.basis, hasCompany: true,
    profileSet: true, roles: ['DEMAND'], capabilityCount: 2, myProgramCount: 1, region: '서울' }, items: [{ recruitment: ownedRecruitment,
      reasons: [{ type: 'CAPABILITY', values: ['실증'], programSource: null }], cautions: [{ type: 'OTHER_REGION', value: '경기' }] }] })
  render(<GovPartnerBrief live active disabled={false} {...actions} />)
  await screen.findByText('파트너 모집글 맞춤 1건')
  expect(screen.getByText(ownedRecruitment.program.title)).toBeTruthy()
  expect(screen.getByText('필요 역량 1개 일치')).toBeTruthy()
  expect(screen.getByText('희망 지역 경기 · 우리 서울')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('기준 바꾸기')); expect(actions.onCompany).toHaveBeenCalledTimes(1)
  fireEvent.press(screen.getByLabelText('상세 보기')); expect(actions.onOpenRecruitment).toHaveBeenCalledWith(ownedRecruitment.id)
})

test('an unset profile of an existing company links to collaboration settings', async () => {
  jest.mocked(recommendRecruitments).mockResolvedValue({ ...empty, basis: { ...empty.basis, hasCompany: true } })
  render(<GovPartnerBrief live active disabled={false} {...actions} />)
  fireEvent.press(await screen.findByLabelText('협업·파트너 설정'))
  expect(actions.onCompany).toHaveBeenCalledTimes(1)
})

test('request failure stays an error until retry succeeds', async () => {
  jest.mocked(recommendRecruitments).mockRejectedValueOnce(new Error('연결 실패'))
  render(<GovPartnerBrief live active disabled={false} {...actions} />)
  await screen.findByLabelText('파트너 모집글 다시 확인')
  expect(screen.queryByText('지금 우리 회사에 맞는 열린 모집글이 없어요.')).toBeNull()
  fireEvent.press(screen.getByLabelText('파트너 모집글 다시 확인'))
  await screen.findByText('지금 우리 회사에 맞는 열린 모집글이 없어요.')
  expect(recommendRecruitments).toHaveBeenCalledTimes(2)
})

test('hidden or historic cards do not fetch and a stopped request cannot display late results', async () => {
  let finish!: (result: PartnerRecruitmentRecommendations) => void
  jest.mocked(recommendRecruitments).mockReturnValue(new Promise(resolve => { finish = resolve }))
  const view = render(<GovPartnerBrief live active disabled={false} {...actions} />)
  const signal = jest.mocked(recommendRecruitments).mock.calls[0][2]!
  view.rerender(<GovPartnerBrief live active={false} disabled={false} {...actions} />)
  expect(signal.aborted).toBe(true)
  await act(async () => finish(empty))
  expect(screen.queryByLabelText('기업 등록하기')).toBeNull()
  view.rerender(<GovPartnerBrief live={false} active disabled={false} {...actions} />)
  fireEvent.press(screen.getByLabelText('파트너 관리에서 전체 보기'))
  expect(actions.onOpenPartners).toHaveBeenCalledWith(emptyPartnerRecruitmentConditions)
  await waitFor(() => expect(recommendRecruitments).toHaveBeenCalledTimes(1))
})
