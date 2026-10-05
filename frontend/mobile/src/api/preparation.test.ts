import { apiRequest } from './client'
import { listPreparations, listPreparationReviews, updatePreparationProgress } from './preparation'
import { preparation, preparationDetail, review, run } from '../test/preparationFixtures'

jest.mock('./client', () => ({ apiRequest: jest.fn() }))
beforeEach(() => { jest.mocked(apiRequest).mockReset() })

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
