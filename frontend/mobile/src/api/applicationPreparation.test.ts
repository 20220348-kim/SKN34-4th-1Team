import { ApiError, createApiFetch } from './client'
import { applicationPreparationUseCase, parsePreparationId } from './applicationPreparation'
import { documentPreparation, documentForm, documentFile, documentJob } from '../test/applicationDocumentFixtures'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'

jest.mock('./client', () => ({ ...jest.requireActual('./client'), getApiBaseUrl: () => 'https://api.example.test', createApiFetch: jest.fn() }))
const fetchApi = jest.fn()
const response = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response
beforeEach(() => { fetchApi.mockReset(); jest.mocked(createApiFetch).mockReturnValue(fetchApi) })
test('uses authenticated mobile transport and rejects another preparation identity', async () => {
  fetchApi.mockResolvedValue(response(documentPreparation))
  const api = applicationPreparationUseCase('owned-session')
  await expect(api.get(9)).resolves.toEqual(documentPreparation)
  expect(createApiFetch).toHaveBeenCalledWith('owned-session')
  expect(fetchApi).toHaveBeenCalledWith('https://api.example.test/api/v1/application-preparations/9', expect.objectContaining({ method: 'GET', cache: 'no-store' }))
  await expect(api.get(8)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})
test('input save enforces producer revision and sends facts without invoking AI', async () => {
  fetchApi.mockResolvedValueOnce(response({ ...documentPreparation, inputRevision: 2 })).mockResolvedValueOnce(response(documentPreparation))
  const input = { expectedRevision: 1, facts: [] }
  await applicationPreparationUseCase('owned').replaceInputs(9, 'company', input)
  expect(fetchApi).toHaveBeenCalledWith(expect.stringMatching(/\/company\/inputs$/), expect.objectContaining({ method: 'PUT', body: JSON.stringify(input) }))
  await expect(applicationPreparationUseCase('owned').replaceInputs(9, 'company', input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})
test('preserves mapping migration and server errors instead of returning empty documents', async () => {
  const migration = { status: 'MAPPING_CHANGED', approvalToken: '11111111-1111-4111-8111-111111111111', expectedRevision: 1, expiresInSeconds: 60,
    changes: [{ fieldLabel: '기업명', changeType: 'TARGET_CHANGED', oldLocation: '표1', newLocation: '표2' }] }
  fetchApi.mockResolvedValue(response({ code: 'APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED', mappingMigration: migration }, 409))
  await expect(applicationPreparationUseCase('owned').submitDocumentJob(9, 1, undefined, 'request-key')).rejects.toMatchObject({ status: 409, mappingMigration: migration })
  fetchApi.mockResolvedValue(response({}, 503))
  await expect(applicationPreparationUseCase('owned').documents(9)).rejects.toBeInstanceOf(ApplicationPreparationError)
})
test('availability validates source pair and job submission uses the supplied idempotency key', async () => {
  fetchApi.mockResolvedValueOnce(response({ state: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_123', status: 'AVAILABLE', reasonCode: 'READY', nextRetryAt: null, attemptCount: 1 }, forms: { items: [documentForm] } }))
  await expect(applicationPreparationUseCase('owned').availability('KSTARTUP', '123')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  fetchApi.mockResolvedValue(response(documentJob))
  await applicationPreparationUseCase('owned').submitDocumentJob(9, 1, undefined, '11111111-1111-4111-8111-111111111111')
  expect(fetchApi).toHaveBeenLastCalledWith(expect.stringMatching(/\/9\/documents\/jobs$/), expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRevision: 1, requestKey: '11111111-1111-4111-8111-111111111111' }) }))
})
test('file metadata does not expose arbitrary filename formats', async () => {
  fetchApi.mockResolvedValue(response([{ ...documentFile, fileName: '../credentials.env' }]))
  await expect(applicationPreparationUseCase('owned').documents(9)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  for (const value of ['0', '-1', '1e2', '9007199254740992', ['1']]) expect(parsePreparationId(value)).toBeNull()
})
test('binary download authentication failure retains the domain error used to clear expired sessions', async () => {
  fetchApi.mockRejectedValue(new ApiError(401, '로그인이 만료되었습니다.'))
  await expect(applicationPreparationUseCase('expired').downloadDocument(9, 11)).rejects.toMatchObject({ status: 401 })
})

test('missing recent-job API is distinguished from a network failure and uncoded server error', async () => {
  const api = applicationPreparationUseCase('owned')
  fetchApi.mockResolvedValue(response({ error: 'Not Found' }, 404))
  await expect(api.recentDocumentJobs()).rejects.toMatchObject({ status: 404, code: 'APPLICATION_PREPARATION_API_UNAVAILABLE' })
  fetchApi.mockResolvedValue(response({ error: 'Service Unavailable' }, 503))
  await expect(api.recentDocumentJobs()).rejects.toMatchObject({ status: 503, message: expect.stringContaining('서버에서 신청문서 요청을 처리하지 못했습니다') })
  fetchApi.mockRejectedValue(new TypeError('Network request failed'))
  await expect(api.recentDocumentJobs()).rejects.toMatchObject({ status: 0, message: expect.stringContaining('연결하지 못했습니다') })
})

test('current producer document metadata reaches the mobile consumer without losing overflow or examples', async () => {
  const file = { ...documentFile, filledAnswerCount: 1, unfilledAnswerCount: 1, remainingExampleCount: 2,
    unfilledAnswers: [{ fieldId: 'company:goal', fieldLabel: '추진 목표', value: '생산 개선', reason: 'OVERFLOW', capacity: 12 }] }
  fetchApi.mockResolvedValue(response([file]))
  await expect(applicationPreparationUseCase('owned').documents(9)).resolves.toEqual([file])
})
