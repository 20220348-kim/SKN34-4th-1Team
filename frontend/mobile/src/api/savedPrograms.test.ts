import { apiRequest } from './client'
import { getSavedProgramStatus, listSavedPrograms, removeSavedProgram, saveProgram } from './savedPrograms'
import { programDetail } from '../test/preparationFixtures'

jest.mock('./client', () => ({ apiRequest: jest.fn() }))
const identity = { sourceCode: programDetail.sourceCode, sourceProgramId: programDetail.id }
const saved = { savedAt: '2026-10-04T10:00:00+09:00', program: { ...programDetail, matchedReasons: [], recommendationScore: null, eligibilityReview: null } }
beforeEach(() => jest.mocked(apiRequest).mockReset())

test('list and status reject malformed responses instead of creating empty results', async () => {
  jest.mocked(apiRequest).mockResolvedValue({ programs: [saved] })
  await expect(listSavedPrograms('owner')).resolves.toMatchObject([{ savedAt: saved.savedAt, program: { id: identity.sourceProgramId } }])
  jest.mocked(apiRequest).mockResolvedValue({ saved: false })
  await expect(getSavedProgramStatus('owner', identity)).resolves.toBe(false)
  const [path] = jest.mocked(apiRequest).mock.calls[1]
  expect(new URL(path, 'https://api.example.test').searchParams.get('sourceProgramId')).toBe(identity.sourceProgramId)
  jest.mocked(apiRequest).mockResolvedValue({ programs: null, saved: 'false' })
  await expect(listSavedPrograms('owner')).rejects.toThrow()
  await expect(getSavedProgramStatus('owner', identity)).rejects.toThrow()
})

test('save uses the response timestamp and rejects a different source identity', async () => {
  jest.mocked(apiRequest).mockResolvedValue(saved)
  await expect(saveProgram('owner', identity)).resolves.toMatchObject({ savedAt: saved.savedAt })
  await expect(saveProgram('owner', { ...identity, sourceProgramId: 'different' })).rejects.toThrow('저장한 공고와 응답이 다릅니다.')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/saved-programs', expect.objectContaining({ method: 'POST', accessToken: 'owner', body: identity }))
})

test('removal forwards cancellation and preserves a failed DELETE', async () => {
  const signal = new AbortController().signal
  const failure = new Error('delete failed')
  jest.mocked(apiRequest).mockRejectedValue(failure)
  await expect(removeSavedProgram('owner', identity, signal)).rejects.toBe(failure)
  expect(apiRequest).toHaveBeenCalledWith(expect.stringContaining('/api/v1/me/saved-programs?'), { method: 'DELETE', accessToken: 'owner', signal })
})
