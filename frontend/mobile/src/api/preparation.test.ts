import { apiRequest } from './client'
import { getPreparationWebUrl, listPreparations, listPreparationReviews, updatePreparationProgress } from './preparation'
import { preparation, preparationDetail, review, run } from '../test/preparationFixtures'

jest.mock('./client', () => ({ apiRequest: jest.fn() }))
beforeEach(() => { jest.mocked(apiRequest).mockReset(); delete process.env.EXPO_PUBLIC_WEB_BASE_URL })
afterEach(() => { delete process.env.EXPO_PUBLIC_WEB_BASE_URL })

test('all preparation pages retain bearer authentication and composite program identities', async () => {
  jest.mocked(apiRequest).mockResolvedValueOnce({ items: [preparation], nextBeforeId: 9 })
    .mockResolvedValueOnce({ items: [{ ...preparation, id: 8, sourceCode: 'KSTARTUP' }], nextBeforeId: null })
  const items = await listPreparations('owner')
  expect(items.map((item) => item.sourceCode)).toEqual(['BIZINFO', 'KSTARTUP'])
  expect(apiRequest).toHaveBeenLastCalledWith('/api/v1/application-preparations?size=50&beforeId=9', expect.objectContaining({ accessToken: 'owner' }))
})
test('a repeated cursor cannot silently omit preparation pages or loop', async () => {
  jest.mocked(apiRequest).mockResolvedValue({ items: [preparation], nextBeforeId: 9 })
  await expect(listPreparations('owner')).rejects.toThrow('페이지 응답')
  expect(apiRequest).toHaveBeenCalledTimes(2)
})
test('review summaries read current inputs and the latest run without starting analysis', async () => {
  jest.mocked(apiRequest).mockImplementation((path) => Promise.resolve(path.includes('/runs?') ? { items: [run], nextBeforeId: null }
    : path === '/api/v1/combination-reviews/5' ? review : { items: [review], nextBeforeId: null }))
  expect(await listPreparationReviews('owner')).toEqual([{ review, latestRun: run }])
  expect(jest.mocked(apiRequest).mock.calls.every(([, options]) => options?.method === undefined && options?.accessToken === 'owner')).toBe(true)
})
test('progress updates use the stored revision and reject a mismatched response', async () => {
  jest.mocked(apiRequest).mockResolvedValue({ ...preparationDetail, progressStage: 'APPLIED', progressRevision: 2 })
  await updatePreparationProgress(preparation, 'APPLIED', 'owner')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/application-preparations/9/progress-stage', expect.objectContaining({
    method: 'PUT', accessToken: 'owner', body: { expectedProgressRevision: 1, progressStage: 'APPLIED' },
  }))
  jest.mocked(apiRequest).mockResolvedValue({ ...preparationDetail, id: 7, progressStage: 'APPLIED', progressRevision: 2 })
  await expect(updatePreparationProgress(preparation, 'APPLIED', 'owner')).rejects.toThrow('응답이 요청과 다릅니다')
})
test('deferred web screens require a configured origin and preserve a preparation source identity', () => {
  expect(() => getPreparationWebUrl('/app/application-preparations/new')).toThrow('웹 주소가 설정되지')
  process.env.EXPO_PUBLIC_WEB_BASE_URL = 'https://example.test/'
  const url = new URL(getPreparationWebUrl('/app/application-preparations/new', { sourceCode: 'BIZINFO', sourceProgramId: 'P/123' }))
  expect(url.searchParams.get('sourceProgramId')).toBe('P/123')
  expect(() => getPreparationWebUrl('/unrelated')).toThrow('지원하지 않는')
})
