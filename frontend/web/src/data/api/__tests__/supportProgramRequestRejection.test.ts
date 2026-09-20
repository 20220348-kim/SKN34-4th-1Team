import { afterEach, describe, expect, it, vi } from 'vitest'

import { SupportProgramRequestError } from '../../../domain/errors/SupportProgramRequestError'
import { SupportProgramRepositoryImpl } from '../../repositories/SupportProgramRepositoryImpl'
import {
  answerSupportProgramEvidenceQuestionApi,
  searchSupportProgramsApi,
  SupportProgramApiError,
  SupportProgramRequestApiError,
} from '../supportProgramApi'

afterEach(() => vi.unstubAllGlobals())

const command = { query: '서울 AI', sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', question: '신청 대상은?' }

describe('support program request admission HTTP boundary', () => {
  it.each([
    [429, 'SUPPORT_PROGRAM_RATE_LIMITED', 'rate-limited'],
    [503, 'SUPPORT_PROGRAM_BUSY', 'busy'],
  ] as const)('maps the validated %s contract into a domain failure for both costly operations', async (status, code, reason) => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(problemResponse(status, { code })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchSupportProgramsApi(command)).rejects.toMatchObject({
      name: 'SupportProgramRequestApiError', code, retryAfterSeconds: 12,
    })
    await expect(answerSupportProgramEvidenceQuestionApi(command)).rejects.toBeInstanceOf(SupportProgramRequestApiError)

    const repository = new SupportProgramRepositoryImpl()
    for (const request of [() => repository.search(command), () => repository.answerEvidenceQuestion(command)]) {
      const error = await request().catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(SupportProgramRequestError)
      expect(error).toMatchObject({ reason, retryAfterSeconds: 12 })
      expect(error).not.toHaveProperty('status')
      expect(error).not.toHaveProperty('code')
      expect(String(error)).not.toContain('private server detail')
    }
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each([
    [{ retryAfterSeconds: 0 }, '0'],
    [{ retryAfterSeconds: 61 }, '61'],
    [{ retryAfterSeconds: 1.5 }, '1.5'],
    [{ retryAfterSeconds: '12' }, '12'],
    [{ retryAfterSeconds: null }, '12'],
    [{ retryAfterSeconds: 12 }, '13'],
    [{ retryAfterSeconds: 12 }, 'tomorrow'],
    [{ retryAfterSeconds: 12 }, null],
  ])('does not trust malformed or inconsistent retry hints: %o / %s', async (changes, header) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problemResponse(429, changes, header)))

    await expect(new SupportProgramRepositoryImpl().search(command)).rejects.toMatchObject({
      reason: 'rate-limited', retryAfterSeconds: null,
    })
  })

  it.each([1, 60])('accepts valid retry duration boundary %s', async (seconds) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problemResponse(429, { retryAfterSeconds: seconds }, String(seconds))))
    await expect(new SupportProgramRepositoryImpl().search(command)).rejects.toMatchObject({ retryAfterSeconds: seconds })
  })

  it.each([
    [429, { status: 503 }],
    [429, { code: 'SUPPORT_PROGRAM_BUSY' }],
    [503, { code: 'SUPPORT_PROGRAM_RATE_LIMITED' }],
    [503, { code: 'UPSTREAM_FAILURE' }],
    [503, { title: null }],
  ])('keeps unknown or malformed %s problems as existing generic errors: %o', async (status, changes) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(problemResponse(status, changes))))
    const failure = await new SupportProgramRepositoryImpl().search(command).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SupportProgramApiError)
    expect(failure).not.toBeInstanceOf(SupportProgramRequestError)
    if (status === 503) {
      await expect(new SupportProgramRepositoryImpl().answerEvidenceQuestion(command)).resolves.toEqual({ outcome: 'unavailable' })
    }
  })

  it.each(['text/html', 'application/json'])('does not interpret a %s error body as the admission contract', async (contentType) => {
    const response = problemResponse(429)
    response.headers.set('Content-Type', contentType)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(new SupportProgramRepositoryImpl().search(command)).rejects.not.toBeInstanceOf(SupportProgramRequestError)
  })

  it('does not expose invalid JSON errors or start a retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('private server detail', {
      status: 503, headers: { 'Content-Type': 'application/problem+json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new SupportProgramRepositoryImpl().search(command)).rejects.toBeInstanceOf(SupportProgramApiError)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

function problemResponse(status: number, changes: Record<string, unknown> = {}, retryAfter: string | null = '12') {
  return new Response(JSON.stringify({
    type: 'about:blank', title: 'Request rejected', status,
    detail: 'private server detail', instance: '/api/v1/support-programs/search',
    code: status === 429 ? 'SUPPORT_PROGRAM_RATE_LIMITED' : 'SUPPORT_PROGRAM_BUSY',
    retryAfterSeconds: 12, ...changes,
  }), {
    status,
    headers: {
      'Content-Type': 'application/problem+json; charset=UTF-8',
      ...(retryAfter === null ? {} : { 'Retry-After': retryAfter }),
    },
  })
}
