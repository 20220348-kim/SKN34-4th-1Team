import { apiRequest } from './client'
import { browseProposals, browseRecruitments, getPartnerWebUrl } from './partners'
import { defaultPartnerRecruitmentQuery } from '@govbiz/shared/domain/entities/PartnerRecruitmentQuery'

jest.mock('./client', () => ({ apiRequest: jest.fn(), ApiError: class extends Error {}, errorMessage: () => '요청 실패' }))

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
