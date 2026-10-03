import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApplicationPreparationRepositoryImpl } from '../../repositories/ApplicationPreparationRepositoryImpl'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const queuedJob = { id: 501, preparationId: 1, expectedRevision: 3, status: 'QUEUED', stage: null, fileIds: [], failureCode: null,
  failureMessage: null, mappingMigration: null, createdAt: '2026-09-30T10:00:00+09:00', finishedAt: null }

it('submits a generation job with a request key and bounds the short request', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  }))
  vi.stubGlobal('fetch', fetcher)
  const pending = new ApplicationPreparationRepositoryImpl().submitDocumentJob(1, 3, undefined, '12345678-1234-1234-1234-123456789abc')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
  await vi.advanceTimersByTimeAsync(14_000)
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(2_000)
  await rejected
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][0]).toContain('/1/documents/jobs')
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ requestKey: '12345678-1234-1234-1234-123456789abc', expectedRevision: 3 })
})

it('reads a job by id and lists the recent jobs of a preparation', async () => {
  const done = { ...queuedJob, status: 'SUCCEEDED', stage: 'SAVING', fileIds: [8], finishedAt: '2026-09-30T10:01:00+09:00' }
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(queuedJob, { status: 202 }))
    .mockResolvedValueOnce(Response.json(done)).mockResolvedValueOnce(Response.json([done]))
  vi.stubGlobal('fetch', fetcher)
  const repository = new ApplicationPreparationRepositoryImpl()
  expect(await repository.submitDocumentJob(1, 3)).toEqual(queuedJob)
  expect(JSON.parse(fetcher.mock.calls[0][1].body).requestKey).toMatch(/^[0-9a-f-]{36}$/)
  expect(await repository.documentJob(1, 501)).toEqual(done)
  expect(fetcher.mock.calls[1][0]).toContain('/1/documents/jobs/501')
  expect(fetcher.mock.calls[1][1].credentials).toBe('include')
  expect(await repository.documentJobs(1)).toEqual([done])
  expect(fetcher.mock.calls[2][0]).toContain('/1/documents/jobs')
})

it('lists the recent jobs of the account without naming a preparation', async () => {
  const done = { ...queuedJob, status: 'SUCCEEDED', stage: 'SAVING', fileIds: [8], finishedAt: '2026-09-30T10:01:00+09:00' }
  const other = { ...queuedJob, id: 502, preparationId: 2 }
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json([other, done]))
  vi.stubGlobal('fetch', fetcher)
  expect(await new ApplicationPreparationRepositoryImpl().recentDocumentJobs()).toEqual([other, done])
  expect(String(fetcher.mock.calls[0][0])).toMatch(/\/application-preparations\/documents\/jobs$/)
  expect(fetcher.mock.calls[0][1].credentials).toBe('include')
})

it('marks finished results as seen with POST requests that return no body', async () => {
  const fetcher = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetcher)
  const repository = new ApplicationPreparationRepositoryImpl()
  await expect(repository.markDocumentJobsSeen(7)).resolves.toBeUndefined()
  expect(String(fetcher.mock.calls[0][0])).toMatch(/\/application-preparations\/7\/documents\/jobs\/seen$/)
  expect(fetcher.mock.calls[0][1].method).toBe('POST')
  expect(fetcher.mock.calls[0][1].body).toBeUndefined()
  await expect(repository.markDiscoveryJobsSeen('BIZINFO', 'PBLN_1')).resolves.toBeUndefined()
  expect(String(fetcher.mock.calls[1][0])).toMatch(/\/forms\/discovery-jobs\/seen$/)
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1' })
})

it('rejects job responses whose state and result disagree or belong elsewhere', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ ...queuedJob, status: 'SUCCEEDED', fileIds: [], finishedAt: '2026-09-30T10:01:00+09:00' }))
    .mockResolvedValueOnce(Response.json({ ...queuedJob, status: 'FAILED', finishedAt: '2026-09-30T10:01:00+09:00' }))
    .mockResolvedValueOnce(Response.json({ ...queuedJob, preparationId: 2 }))
    .mockResolvedValueOnce(Response.json({ ...queuedJob, id: 502 })))
  const repository = new ApplicationPreparationRepositoryImpl()
  await expect(repository.submitDocumentJob(1, 3)).rejects.toThrow('응답 형식')
  await expect(repository.submitDocumentJob(1, 3)).rejects.toThrow('응답 형식')
  await expect(repository.submitDocumentJob(1, 3)).rejects.toThrow('응답 형식')
  await expect(repository.documentJob(1, 501)).rejects.toThrow('응답 형식')
})

it('carries the owner-scoped migration diff of a failed job and confirms it with the same revision', async () => {
  const notice = { status: 'MAPPING_CHANGED', approvalToken: '12345678-1234-1234-1234-123456789abc',
    expectedRevision: 3, expiresInSeconds: 900, changes: [{ fieldLabel: '기업 개요 · 업체명',
      changeType: 'TARGET_CHANGED', oldLocation: '표 1 · 기업명', newLocation: '표 2 · 기업명' }] }
  const failed = { ...queuedJob, status: 'FAILED', stage: 'MAPPING', failureCode: 'APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED',
    failureMessage: '입력 위치가 변경됐습니다.', mappingMigration: notice, finishedAt: '2026-09-30T10:01:00+09:00' }
  const confirmed = { status: 'REGENERATION_REQUIRED', preparationId: 1, inputRevision: 3,
    formVersionId: 'approved-form-v2' }
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(failed)).mockResolvedValueOnce(Response.json(confirmed))
  vi.stubGlobal('fetch', fetcher)
  const repository = new ApplicationPreparationRepositoryImpl()
  expect((await repository.documentJob(1, 501)).mappingMigration).toEqual(notice)
  expect(await repository.confirmDocumentMappingMigration(1, 3, notice.approvalToken)).toEqual(confirmed)
  expect(fetcher.mock.calls[1][0]).toContain('/1/documents/mapping-migration/confirm')
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ expectedRevision: 3, approvalToken: notice.approvalToken })
})

it('downloads the native document with credentials and validates binary content', async () => {
  const file = { id: 8, inputRevision: 3, fileName: '신청서.hwpx', mediaType: 'application/hwp+zip', size: 4,
    filledAnswerCount: 1, unfilledAnswerCount: 0, unfilledAnswers: [] }
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json([file]))
    .mockResolvedValueOnce(new Response(new Uint8Array([80, 75, 3, 4]), { headers: { 'Content-Type': file.mediaType } }))
    .mockResolvedValueOnce(new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }))
  vi.stubGlobal('fetch', fetcher)
  const repository = new ApplicationPreparationRepositoryImpl()
  expect(await repository.documents(1)).toEqual([file])
  expect(fetcher.mock.calls[0][0]).toContain('/1/documents')
  const downloaded = await repository.downloadDocument(1, 8)
  expect(downloaded.size).toBe(4)
  expect(fetcher.mock.calls[1][1].credentials).toBe('include')
  expect(fetcher.mock.calls[1][0]).toContain('/1/documents/8/download')
  await expect(repository.downloadDocument(1, 8)).rejects.toThrow('응답 형식')
})

it('reads answers left out of a draft with their reason and, for an overflowing cell, its capacity', async () => {
  const unfilledAnswers = [
    { fieldId: 'plan:summary', fieldLabel: '사업 계획 / 요약', value: '긴 요약', reason: 'OVERFLOW', capacity: 40 },
    { fieldId: 'company:site', fieldLabel: '기업 개요 / 사업장', value: '전세', reason: 'SLOT_MISMATCH', capacity: null },
  ]
  const file = { id: 8, inputRevision: 3, fileName: '신청서.hwpx', mediaType: 'application/hwp+zip', size: 4,
    filledAnswerCount: 1, unfilledAnswerCount: 2, unfilledAnswers }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([file]))
    .mockResolvedValueOnce(Response.json([{ ...file, unfilledAnswers: [{ ...unfilledAnswers[0], reason: 'TRUNCATED' }, unfilledAnswers[1]] }])))
  const repository = new ApplicationPreparationRepositoryImpl()
  expect(await repository.documents(1)).toEqual([file])
  await expect(repository.documents(1)).rejects.toThrow()
})

it('reads how many cells still hold a writing example and rejects an impossible count', async () => {
  const file = { id: 8, inputRevision: 3, fileName: '신청서.hwpx', mediaType: 'application/hwp+zip', size: 4,
    filledAnswerCount: 1, unfilledAnswerCount: 0, unfilledAnswers: [], remainingExampleCount: 2 }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([file]))
    .mockResolvedValueOnce(Response.json([{ ...file, remainingExampleCount: -1 }])))
  const repository = new ApplicationPreparationRepositoryImpl()
  expect(await repository.documents(1)).toEqual([file])
  await expect(repository.documents(1)).rejects.toThrow()
})

it.each([
  ['DOCX', '신청서.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['XLSX', '신청서.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
])('accepts a %s draft and its native download media type', async (_format, fileName, mediaType) => {
  const file = { id: 9, inputRevision: 3, fileName, mediaType, size: 4, filledAnswerCount: 1, unfilledAnswerCount: 0, unfilledAnswers: [] }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json([file]))
    .mockResolvedValueOnce(new Response(new Uint8Array([80, 75, 3, 4]), { headers: { 'Content-Type': file.mediaType } })))
  const repository = new ApplicationPreparationRepositoryImpl()
  expect(await repository.documents(1)).toEqual([file])
  expect((await repository.downloadDocument(1, 9)).size).toBe(4)
})

const form = {
  formVersionId: 'verified-form-v1',
  sourceCode: 'BIZINFO',
  sourceProgramId: 'PBLN_1',
  programTitle: '지원사업',
  formTitle: '사업계획서',
  sourceUrl: 'https://www.bizinfo.go.kr/form',
  attachmentFileName: '사업계획서.hwpx',
  attachmentSha256: 'a'.repeat(64),
  verificationStatus: 'SOURCE_HASH_AND_LOCATORS_VERIFIED',
  institutionReviewed: false,
  supportedServiceFields: ['TECHNICAL_SUPPORT'],
  sections: [{
    key: 'company-overview', title: '기업 개요', locator: 'HWPX paragraph 1', description: '기업을 설명합니다.', status: 'NOT_STARTED',
    fields: [{ key: 'company-name', label: '업체명', guidance: '업체명을 입력합니다.', required: true }], facts: [],
  }],
}
const detail = {
  contents: [],
  id: 1,
  inputRevision: 1,
  progressStage: 'PREPARING',
  progressRevision: 1,
  progressStageUpdatedAt: '2026-09-11T00:00:00+09:00',
  serviceField: 'TECHNICAL_SUPPORT',
  createdAt: '2026-09-11T00:00:00+09:00',
  updatedAt: '2026-09-11T00:00:00+09:00',
  form,
}
const creation = {
  sourceCode: form.sourceCode,
  sourceProgramId: form.sourceProgramId,
  formVersionId: form.formVersionId,
  serviceField: 'TECHNICAL_SUPPORT' as const,
}

it('preserves manual-only fields from the Core response', async () => {
  const manual = { ...form, sections: form.sections.map((section) => ({ ...section,
    fields: section.fields.map((field) => ({ ...field, documentWritable: false })),
  })) }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ items: [manual] })))
  const result = await new ApplicationPreparationRepositoryImpl().forms()
  expect(result[0].sections[0].fields[0].documentWritable).toBe(false)
})

it('validates draft, edited content and confirmation responses across the HTTP boundary', async () => {
  const version = { id: 10, sectionKey: 'company-overview', inputRevision: 1, kind: 'AI_DRAFT', content: '기업 개요',
    stale: false, createdAt: detail.updatedAt, confirmedAt: null }
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ ...detail, contents: [version] }))
    .mockResolvedValueOnce(Response.json({ ...detail, contents: [{ ...version, id: 11, kind: 'USER_EDIT', content: '수정본' }, version] }))
    .mockResolvedValueOnce(Response.json({ ...detail, contents: [{ ...version, id: 11, confirmedAt: detail.updatedAt }] }))
    .mockResolvedValueOnce(Response.json({ ...detail, contents: [{ ...version, sectionKey: 'invented' }] }))
  vi.stubGlobal('fetch', fetcher)
  const repository = new ApplicationPreparationRepositoryImpl()
  const input = { expectedRevision: 1, expectedVersionId: null, requestKey: '0a504895-77bd-4d34-bc61-3e6d12389042' }
  await repository.generateDraft(1, 'company-overview', input)
  await repository.saveContent(1, 'company-overview', { expectedRevision: 1, expectedVersionId: 10, content: '수정본' })
  await repository.confirmContent(1, 'company-overview', { expectedRevision: 1, expectedVersionId: 11 })
  expect(fetcher.mock.calls[0][0]).toContain('/1/sections/company-overview/drafts')
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(input)
  expect(fetcher.mock.calls[1][1].method).toBe('PUT')
  expect(fetcher.mock.calls[2][0]).toContain('/confirmations')
  await expect(repository.generateDraft(1, 'company-overview', input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})

describe('application preparation HTTP boundary', () => {
  it('rejects mismatched job identity and missing completed results', async () => {
    const job = { id: 7, sourceCode: 'MSIT', sourceProgramId: '1', programTitle: '과기정통부 지원사업', programSourceUrl: 'https://www.msit.go.kr/bbs/view.do?nttSeqNo=1', status: 'QUEUED', result: null, failureCode: null, createdAt: detail.createdAt }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(job, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ...job, id: 8 }))
      .mockResolvedValueOnce(Response.json({ ...job, status: 'SUCCEEDED' })))
    const repository = new ApplicationPreparationRepositoryImpl()
    await expect(repository.discover('BIZINFO', 'PBLN_1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(repository.discoveryJob(7)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(repository.discoveryJob(7)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('uses GET only when restoring account job history and details', async () => {
    const job = { id: 7, sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', programTitle: form.programTitle, programSourceUrl: form.sourceUrl, status: 'UNKNOWN', result: null,
      failureCode: 'RUN_OUTCOME_UNKNOWN', createdAt: detail.createdAt }
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json([job])).mockResolvedValueOnce(Response.json(job))
    vi.stubGlobal('fetch', fetchMock)
    const repository = new ApplicationPreparationRepositoryImpl()
    await expect(repository.discoveryJobs()).resolves.toEqual([job])
    await expect(repository.discoveryJob(7)).resolves.toEqual(job)
    expect(fetchMock.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'GET'])
  })

  it('deletes an owned preparation with the exact 204 contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(new ApplicationPreparationRepositoryImpl().delete(7)).resolves.toBeUndefined()

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/v1\/application-preparations\/7$/)
    expect(options).toMatchObject({ method: 'DELETE', credentials: 'include', cache: 'no-store' })
    expect(options.body).toBeUndefined()
  })

  it('uses the exact URLs, methods, body, session cookie and no-store options', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ items: [form] }))
      .mockResolvedValueOnce(Response.json({ id: 7, sourceCode: form.sourceCode, sourceProgramId: form.sourceProgramId, programTitle: form.programTitle, programSourceUrl: form.sourceUrl,
        status: 'SUCCEEDED', result: { items: [form], warnings: [], cached: false }, failureCode: null, createdAt: detail.createdAt }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ items: [], nextBeforeId: null }))
      .mockResolvedValueOnce(Response.json(detail, { status: 201 }))
      .mockResolvedValueOnce(Response.json(detail))
    vi.stubGlobal('fetch', fetchMock)
    const repository = new ApplicationPreparationRepositoryImpl()
    await repository.forms()
    await repository.discover('BIZINFO', 'PBLN_1')
    await repository.list({ beforeId: 20, status: 'done' })
    await repository.create(creation)
    await repository.get(1)

    const calls = fetchMock.mock.calls as [string, RequestInit][]
    expect(calls.map(([url]) => url)).toEqual([
      expect.stringMatching(/\/api\/v1\/application-preparations\/forms$/),
      expect.stringMatching(/\/api\/v1\/application-preparations\/forms\/discovery-jobs$/),
      expect.stringMatching(/\/api\/v1\/application-preparations\?size=20&beforeId=20&status=done$/),
      expect.stringMatching(/\/api\/v1\/application-preparations$/),
      expect.stringMatching(/\/api\/v1\/application-preparations\/1$/),
    ])
    expect(calls.map(([, options]) => options.method)).toEqual(['GET', 'POST', 'GET', 'POST', 'GET'])
    for (const [, options] of calls) {
      expect(options).toMatchObject({ credentials: 'include', cache: 'no-store' })
      expect(options.signal).toBeInstanceOf(AbortSignal)
    }
    expect(calls[0]?.[1].body).toBeUndefined()
    expect(JSON.parse(calls[1]?.[1].body as string)).toEqual({ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', requestKey: expect.any(String) })
    expect(calls[3]?.[1].headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(calls[3]?.[1].body as string)).toEqual(creation)
  })

  it('preserves known server errors and converts authentication failures', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ code: 'APPLICATION_FORM_NOT_SUPPORTED' }, { status: 422 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 })))
    const repository = new ApplicationPreparationRepositoryImpl()

    await expect(repository.create(creation)).rejects.toMatchObject({
      status: 422,
      code: 'APPLICATION_FORM_NOT_SUPPORTED',
      message: '현재 지원하지 않는 공고·양식·지원 분야입니다.',
    })
    await expect(repository.get(1)).rejects.toMatchObject({
      status: 401,
      message: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
    })
  })

  it('uses a form-discovery-specific message for an invalid AI response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      Response.json({ code: 'AI_SERVICE_INVALID_RESPONSE' }, { status: 502 }),
    ))

    await expect(new ApplicationPreparationRepositoryImpl().discover('BIZINFO', 'PBLN_1')).rejects.toMatchObject({
      status: 502,
      code: 'APPLICATION_FORM_AI_INVALID_RESPONSE',
      message: expect.stringContaining('공식 첨부의 문항 근거'),
    })
  })

  it('distinguishes an unavailable feature endpoint from a missing owned preparation', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ code: 'APPLICATION_PREPARATION_NOT_FOUND' }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ code: 'APPLICATION_PREPARATION_NOT_FOUND' }, { status: 404 })))
    const repository = new ApplicationPreparationRepositoryImpl()

    await expect(repository.forms()).rejects.toMatchObject({
      status: 404,
      code: 'APPLICATION_PREPARATION_API_UNAVAILABLE',
      message: expect.stringContaining('Core·AI Service 이미지를 갱신'),
    })
    await expect(repository.list()).rejects.toMatchObject({
      status: 404,
      code: 'APPLICATION_PREPARATION_API_UNAVAILABLE',
    })
    await expect(repository.get(404)).rejects.toMatchObject({
      status: 404,
      code: 'APPLICATION_PREPARATION_NOT_FOUND',
      message: '신청 준비 건을 찾을 수 없습니다.',
    })
  })

  it('rejects malformed JSON, contract violations, mismatched ids and mismatched creation selections', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{', { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(Response.json({ ...detail, form: { ...form, institutionReviewed: true } }))
      .mockResolvedValueOnce(Response.json({ ...detail, id: 2 }))
      .mockResolvedValueOnce(Response.json({ ...detail, form: { ...form, formVersionId: 'another-form-v1' } })))
    const repository = new ApplicationPreparationRepositoryImpl()

    await expect(repository.get(1)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(repository.get(1)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(repository.get(1)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(repository.create(creation)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('converts network failures to a safe message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('socket path and host details')))

    await expect(new ApplicationPreparationRepositoryImpl().list()).rejects.toMatchObject({
      status: 0,
      code: 'REQUEST_FAILED',
      message: 'Core API에 연결하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.',
    })
  })

  it('posts interpretation and puts only the confirmed input snapshot', async () => {
    const interpreted = {
      runId: 5,
      inputRevision: 1,
      sectionKey: 'company-overview',
      suggestions: [{ fieldKey: 'company-name', status: 'PROVIDED', value: '새봄테크', evidenceQuote: '새봄테크' }],
      missingFields: [],
      nextQuestion: null,
    }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json(interpreted))
      .mockResolvedValueOnce(Response.json({ ...detail, inputRevision: 2 })))
    const repository = new ApplicationPreparationRepositoryImpl()
    const interpretation = { expectedRevision: 1, requestKey: crypto.randomUUID(), message: '새봄테크' }
    await repository.interpret(1, 'company-overview', interpretation)
    const inputs = { expectedRevision: 1, facts: [{ fieldKey: 'company-name', status: 'PROVIDED' as const, value: '새봄테크', sourceText: '새봄테크' }] }
    await repository.replaceInputs(1, 'company-overview', inputs)

    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][]
    expect(calls.map(([, options]) => options.method)).toEqual(['POST', 'PUT'])
    expect(calls[0]?.[0]).toMatch(/\/1\/sections\/company-overview\/messages$/)
    expect(calls[1]?.[0]).toMatch(/\/1\/sections\/company-overview\/inputs$/)
    expect(JSON.parse(calls[0]?.[1].body as string)).toEqual(interpretation)
    expect(JSON.parse(calls[1]?.[1].body as string)).toEqual(inputs)
  })

  it('updates the owned progress stage with its independent revision', async () => {
    const updated = { ...detail, progressStage: 'APPLIED', progressRevision: 2 }
    const fetchMock = vi.fn().mockResolvedValue(Response.json(updated))
    vi.stubGlobal('fetch', fetchMock)

    await expect(new ApplicationPreparationRepositoryImpl().updateProgress(1, {
      expectedProgressRevision: 1,
      progressStage: 'APPLIED',
    })).resolves.toEqual(updated)

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/1\/progress-stage$/)
    expect(options.method).toBe('PUT')
    expect(JSON.parse(options.body as string)).toEqual({ expectedProgressRevision: 1, progressStage: 'APPLIED' })
  })

  it('propagates cancellation to fetch without converting it to a visible request error', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const request = new ApplicationPreparationRepositoryImpl().list(undefined, controller.signal)

    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    const requestSignal = fetchMock.mock.calls[0]?.[1]?.signal
    expect(requestSignal?.aborted).toBe(true)
  })
})


it('reads active snapshots through the availability HTTP contract without posting a discovery job', async () => {
  const response = { state: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', status: 'AVAILABLE',
    reasonCode: 'FORM_FOUND', nextRetryAt: null, attemptCount: 1 }, forms: { items: [form] } }
  const fetcher = vi.fn().mockResolvedValue(Response.json(response))
  vi.stubGlobal('fetch', fetcher)
  const result = await new ApplicationPreparationRepositoryImpl().availability('BIZINFO', 'PBLN_1')
  expect(result.forms.items[0].formVersionId).toBe(form.formVersionId)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][0]).toContain('/forms/availability?sourceCode=BIZINFO&sourceProgramId=PBLN_1')
  expect(fetcher.mock.calls[0][1].method).toBe('GET')
  expect(fetcher.mock.calls[0][1].credentials).toBe('include')
})

it.each(['PENDING', 'STALE', 'NO_FORM', 'DOCUMENT_UNAVAILABLE', 'TOO_LARGE', 'RETRY_WAITING', 'REVIEW_REQUIRED'])('preserves the reason for %s with no active forms', async (status) => {
  const response = { state: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', status,
    reasonCode: 'SOURCE_CHECK_REQUIRED', nextRetryAt: null, attemptCount: 1 }, forms: { items: [] } }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(response)))
  await expect(new ApplicationPreparationRepositoryImpl().availability('BIZINFO', 'PBLN_1')).resolves.toEqual(response)
})

it('rejects inconsistent availability states, duplicate snapshots, and snapshots from another notice', async () => {
  const state = { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', status: 'AVAILABLE', reasonCode: 'FORM_FOUND', nextRetryAt: null, attemptCount: 1 }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ state, forms: { items: [] } }))
    .mockResolvedValueOnce(Response.json({ state, forms: { items: [{ ...form, sourceProgramId: 'PBLN_2' }] } }))
    .mockResolvedValueOnce(Response.json({ state: { ...state, status: 'PENDING' }, forms: { items: [form] } }))
    .mockResolvedValueOnce(Response.json({ state, forms: { items: [form, form] } })))
  const repository = new ApplicationPreparationRepositoryImpl()
  for (let index = 0; index < 4; index++) await expect(repository.availability('BIZINFO', 'PBLN_1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})

 it('reads the authenticated guide and rejects another preparation identity', async () => {
  const body = { preparationId: 30, inputRevision: 1, totalCount: 0, readyCount: 0, needsReviewCount: 0, missingCount: 0,
    directInputCount: 0, externalMappingVerified: false, officialApplicationUrl: null, items: [], savedAnswers: [] }
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(body)).mockResolvedValueOnce(Response.json({ ...body, preparationId: 31 }))
  vi.stubGlobal('fetch', fetcher)
  const repository = new ApplicationPreparationRepositoryImpl()
  expect(await repository.onlineInputGuide(30)).toEqual(body)
  expect(fetcher.mock.calls[0][0]).toContain('/30/online-input-guide')
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'include', cache: 'no-store' })
  await expect(repository.onlineInputGuide(30)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})
