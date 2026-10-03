import { apiRequest, ApiError } from './client'
import { browseProposals, browseRecruitments, createRecruitment, getPartnerWebUrl } from './partners'
import { defaultPartnerRecruitmentQuery } from '@govbiz/shared/domain/entities/PartnerRecruitmentQuery'

jest.mock('./client', () => ({ ...jest.requireActual('./client'), apiRequest: jest.fn() }))

afterEach(() => { delete process.env.EXPO_PUBLIC_WEB_BASE_URL; jest.mocked(apiRequest).mockReset() })

test('mobile recruitment search sends every selected role and region with the bearer token', async () => {
  jest.mocked(apiRequest).mockResolvedValue({ recruitments: [], total: 0, page: 2, pageSize: 20, totalPages: 2 })
  const query = { ...defaultPartnerRecruitmentQuery, keyword: '부품', seekingRoles: ['DEMAND', 'PARTICIPANT'] as const,
    regions: ['경기', '서울'], mineOnly: true, page: 2 }
  await browseRecruitments({ ...query, seekingRoles: [...query.seekingRoles] }, 'owned-token')
  const [path, options] = jest.mocked(apiRequest).mock.calls[0]
  const url = new URL(path, 'https://api.example.test')
  expect(url.searchParams.getAll('seekingRole')).toEqual(['DEMAND', 'PARTICIPANT'])
  expect(url.searchParams.getAll('region')).toEqual(['경기', '서울'])
  expect(url.searchParams.get('mine')).toBe('true')
  expect(url.searchParams.get('page')).toBe('2')
  expect(options).toMatchObject({ accessToken: 'owned-token' })
})

test('proposal inbox rejects a response for the wrong box', async () => {
  jest.mocked(apiRequest).mockResolvedValue({ box: 'sent', proposals: [], pendingCount: 0 })
  await expect(browseProposals('received', 'owned-token')).rejects.toThrow('요청한 제안함')
})

test('sharing never guesses a web host from the API origin', () => {
  expect(() => getPartnerWebUrl('/partners/detail', 12)).toThrow('웹 주소가 설정되지')
  process.env.EXPO_PUBLIC_WEB_BASE_URL = 'https://example.test/'
  expect(getPartnerWebUrl('/partners/detail', 12)).toBe('https://example.test/partners/detail?recruitmentId=12')
  process.env.EXPO_PUBLIC_WEB_BASE_URL = 'https://example.test/other/'
  expect(() => getPartnerWebUrl('/partners/detail', 12)).toThrow('HTTPS origin')
})

const createInput = { sourceCode: 'BIZINFO', sourceProgramId: 'program-9', title: '  협업 모집  ', body: '  공동 연구 파트너를 찾습니다.  ',
  ownRole: 'LEAD' as const, seekingRole: 'PARTICIPANT' as const, seekingCount: 1, region: '전국',
  capabilities: [' AI 분석 ', 'AI 분석'], minimumCompanyAgeYears: null, recruitmentDeadline: '2099-10-04' }
const createdDto = { id: 9, title: '협업 모집', body: '공동 연구 파트너를 찾습니다.', ownRole: 'LEAD', seekingRole: 'PARTICIPANT',
  seekingCount: 1, region: '전국', capabilities: ['AI 분석'], recruitmentDeadline: '2099-10-04', status: 'OPEN',
  isMine: true, proposalCount: 0, createdAt: '2099-10-04T10:00:00+09:00', updatedAt: '2099-10-04T10:00:00+09:00',
  company: { companyName: '작성 기업', region: '서울', industry: '제조업', foundedYear: 2020, isEmailVerified: true, isBusinessVerified: true },
  program: { sourceCode: 'BIZINFO', sourceProgramId: 'program-9', title: '연구 지원사업', organization: '지원 기관',
    summary: '', targetDescription: '', applicationPeriod: '', applicationEndDate: '2099-10-05', sourceUrl: 'https://example.test/program' } }

test('creation normalizes shared input, posts with Bearer authentication, and maps the existing response contract', async () => {
  jest.mocked(apiRequest).mockResolvedValue(createdDto)
  const signal = new AbortController().signal
  const result = await createRecruitment(createInput, 'owner-token', signal)
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/partners/recruitments', { method: 'POST', accessToken: 'owner-token', signal,
    body: { ...createInput, title: '협업 모집', body: '공동 연구 파트너를 찾습니다.', capabilities: ['AI 분석'] } })
  expect(result).toMatchObject({ outcome: 'created', recruitment: { id: 9, isMine: true,
    program: { sourceCode: 'BIZINFO', sourceProgramId: 'program-9' } } })
})

test('invalid input, malformed DTO and mismatched composite program identity cannot report success', async () => {
  expect(() => createRecruitment({ ...createInput, title: ' ' }, 'owner')).toThrow('title')
  expect(apiRequest).not.toHaveBeenCalled()
  jest.mocked(apiRequest).mockResolvedValueOnce({ id: 9 })
  await expect(createRecruitment(createInput, 'owner')).rejects.toThrow()
  jest.mocked(apiRequest).mockResolvedValueOnce({ ...createdDto, program: { ...createdDto.program, sourceCode: 'SMES24' } })
  await expect(createRecruitment(createInput, 'owner')).rejects.toThrow('작성한 모집글과 응답이 다릅니다.')
})

test.each([
  ['COMPANY_REQUIRED', 'company-required'], ['ACTIVE_BUSINESS_REQUIRED', 'company-required'],
  ['RECRUITMENT_PROGRAM_NOT_FOUND', 'program-not-found'], ['RECRUITMENT_PROGRAM_CLOSED', 'program-closed'],
  ['RECRUITMENT_DEADLINE_NOT_ALLOWED', 'deadline-not-allowed'], ['RECRUITMENT_ALREADY_EXISTS', 'already-exists'],
])('creation preserves the explicit %s failure', async (code, outcome) => {
  jest.mocked(apiRequest).mockRejectedValueOnce(new ApiError(422, '실패', code))
  await expect(createRecruitment(createInput, 'owner')).resolves.toMatchObject({ outcome })
})

test('creation does not turn authentication or unexpected network failures into a successful result', async () => {
  const unauthorized = new ApiError(401, '다시 로그인')
  jest.mocked(apiRequest).mockRejectedValueOnce(unauthorized)
  await expect(createRecruitment(createInput, 'owner')).rejects.toBe(unauthorized)
  const unavailable = new ApiError(503, '서버 오류')
  jest.mocked(apiRequest).mockRejectedValueOnce(unavailable)
  await expect(createRecruitment(createInput, 'owner')).rejects.toBe(unavailable)
})
