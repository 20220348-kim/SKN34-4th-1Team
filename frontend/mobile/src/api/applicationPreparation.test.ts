import { ApiError, createApiFetch } from './client'
import { applicationPreparationUseCase, discardDeletedPendingPreparation, parsePreparationId, prepareApplicationDocumentDownload } from './applicationPreparation'
import { clearPendingPreparationIfUnchanged } from '../auth/preparationPending'
import { documentPreparation, documentForm, documentFile, documentJob } from '../test/applicationDocumentFixtures'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'

jest.mock('./client', () => ({ ...jest.requireActual('./client'), getApiBaseUrl: () => 'https://api.example.test', createApiFetch: jest.fn() }))
jest.mock('../auth/preparationPending', () => ({ clearPendingPreparationIfUnchanged: jest.fn() }))
const fetchApi = jest.fn()
const response = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response

const downloadPath = `/api/v1/application-preparations/9/documents/11/download?ticket=${'a'.repeat(43)}`
const downloadLink = { preparationId: 9, fileId: 11, downloadPath, expiresAt: '2026-10-07T12:02:00+09:00' }

test('browser download authenticates only link creation and returns the exact API file URL', async () => {
  fetchApi.mockResolvedValue(response(downloadLink))
  await expect(prepareApplicationDocumentDownload('owned-session', 9, 11)).resolves.toBe(`https://api.example.test${downloadPath}`)
  expect(createApiFetch).toHaveBeenCalledWith('owned-session')
  expect(fetchApi).toHaveBeenCalledTimes(1)
  expect(fetchApi).toHaveBeenCalledWith('https://api.example.test/api/v1/application-preparations/9/documents/11/download-link',
    expect.objectContaining({ method: 'POST', cache: 'no-store', headers: { Accept: 'application/json' } }))
})

test.each([
  { preparationId: 8 }, { fileId: 12 }, { expiresAt: 'invalid' },
  { downloadPath: `https://evil.test${downloadPath}` }, { downloadPath: `https://api.example.test${downloadPath}` },
  { downloadPath: downloadPath.replace('/11/', '/12/') }, { downloadPath: `${downloadPath}&accessToken=session` },
  { downloadPath: downloadPath.replace('a'.repeat(43), 'login.jwt.token') }, { downloadPath: '//evil.test/file' },
])('browser download rejects an invalid, foreign or mismatched response: %j', async invalid => {
  fetchApi.mockResolvedValue(response({ ...downloadLink, ...invalid }))
  await expect(prepareApplicationDocumentDownload('owned', 9, 11)).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' })
})

test('browser download exposes backend failures and refuses a late link after cancellation', async () => {
  fetchApi.mockResolvedValue(response({ code: 'APPLICATION_PREPARATION_NOT_FOUND' }, 404))
  await expect(prepareApplicationDocumentDownload('owned', 9, 11)).rejects.toMatchObject({ status: 404, code: 'APPLICATION_PREPARATION_NOT_FOUND' })
  fetchApi.mockRejectedValue(new ApiError(401, 'expired'))
  await expect(prepareApplicationDocumentDownload('expired', 9, 11)).rejects.toMatchObject({ status: 401 })
  let finish!: (value: Response) => void
  fetchApi.mockReturnValue(new Promise<Response>(resolve => { finish = resolve }))
  const controller = new AbortController()
  const pending = prepareApplicationDocumentDownload('owned', 9, 11, controller.signal)
  controller.abort(); finish(response(downloadLink))
  await expect(pending).rejects.toThrow('취소')
  const innerSignal = fetchApi.mock.calls[2][1].signal as AbortSignal
  expect(innerSignal.aborted).toBe(true)
})

test('keeps an active document job deletion conflict as an error without retrying', async () => {
  fetchApi.mockResolvedValue(response({ code: 'APPLICATION_PREPARATION_RUN_CONFLICT' }, 409))
  await expect(applicationPreparationUseCase('owned').delete(9)).rejects.toMatchObject({
    status: 409, code: 'APPLICATION_PREPARATION_RUN_CONFLICT',
  })
  expect(fetchApi).toHaveBeenCalledTimes(1)
  expect(fetchApi).toHaveBeenCalledWith(expect.stringMatching(/\/application-preparations\/9$/), expect.objectContaining({ method: 'DELETE' }))
})
beforeEach(() => { fetchApi.mockReset(); jest.mocked(createApiFetch).mockReturnValue(fetchApi); jest.mocked(clearPendingPreparationIfUnchanged).mockReset().mockResolvedValue(true) })
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

const pending = { kind: 'document' as const, preparationId: 9, expectedRevision: 1, requestKey: '11111111-1111-4111-8111-111111111111' }
test('pending recovery reads the owned target and only clears a coded missing document', async () => {
  fetchApi.mockResolvedValue(response({ code: 'APPLICATION_PREPARATION_NOT_FOUND' }, 404))
  await discardDeletedPendingPreparation('owned-session', 'owner@test.com', pending)
  expect(fetchApi).toHaveBeenCalledTimes(1)
  expect(fetchApi).toHaveBeenCalledWith('https://api.example.test/api/v1/application-preparations/9', expect.objectContaining({ method: 'GET' }))
  expect(clearPendingPreparationIfUnchanged).toHaveBeenCalledWith('https://api.example.test', 'owner@test.com', pending, undefined)
})
test.each([
  [404, {}], [404, { code: 'APPLICATION_DOCUMENT_NOT_FOUND' }], [503, { code: 'REQUEST_FAILED' }], [401, { code: 'AUTHENTICATION_REQUIRED' }],
])('pending recovery retains its key on %s unless the document itself is confirmed missing', async (status, payload) => {
  fetchApi.mockResolvedValue(response(payload, status))
  await expect(discardDeletedPendingPreparation('owned', 'owner@test.com', pending)).rejects.toBeInstanceOf(ApplicationPreparationError)
  expect(clearPendingPreparationIfUnchanged).not.toHaveBeenCalled()
})
test('existing targets, network failures and changed storage cannot discard a pending request', async () => {
  fetchApi.mockResolvedValueOnce(response(documentPreparation)).mockRejectedValueOnce(new TypeError('offline'))
  await expect(discardDeletedPendingPreparation('owned', 'owner@test.com', pending)).rejects.toThrow('문서가 남아')
  await expect(discardDeletedPendingPreparation('owned', 'owner@test.com', pending)).rejects.toMatchObject({ status: 0 })
  expect(clearPendingPreparationIfUnchanged).not.toHaveBeenCalled()
  fetchApi.mockResolvedValue(response({ code: 'APPLICATION_PREPARATION_NOT_FOUND' }, 404))
  jest.mocked(clearPendingPreparationIfUnchanged).mockResolvedValue(false)
  await expect(discardDeletedPendingPreparation('owned', 'owner@test.com', pending)).rejects.toThrow('보관 요청이 변경')
})
test('a late missing-target response after cancellation never clears the stored key', async () => {
  let finish!: (value: Response) => void
  fetchApi.mockReturnValue(new Promise<Response>(resolve => { finish = resolve }))
  const controller = new AbortController()
  const checking = discardDeletedPendingPreparation('owned', 'owner@test.com', pending, controller.signal)
  controller.abort(); finish(response({ code: 'APPLICATION_PREPARATION_NOT_FOUND' }, 404))
  await expect(checking).rejects.toBeDefined()
  expect(clearPendingPreparationIfUnchanged).not.toHaveBeenCalled()
})
