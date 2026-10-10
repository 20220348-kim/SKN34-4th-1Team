import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanQuotaExceededError, QuotaUnavailableError } from '@govbiz/shared/domain/errors/PlanQuotaError'

import { SupportProgramRequestError } from '../../../domain/errors/SupportProgramRequestError'
import { SupportProgramRepositoryImpl } from '../../repositories/SupportProgramRepositoryImpl'
import {
  answerSupportProgramEvidenceQuestionApi,
  searchSupportProgramsApi,
  SupportProgramApiError,
  SupportProgramRequestApiError,
} from '../supportProgramApi'

// 하루 한도 안내는 다시 채워질 때까지 남은 시간을 적으므로 시계를 서울 저녁 9시(자정 3시간 전)로 고정합니다. 타이머는 실제로 둡니다.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-08T21:00:00+09:00')) })
afterEach(() => { vi.useRealTimers() })

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

  it('passes plan quota rejections through the repository unchanged so the screens show the shared message', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(problemResponse(429, { code: 'PLAN_QUOTA_EXCEEDED', feature: 'AI_SEARCH', period: 'DAY', plan: 'FREE',
        limit: 10, used: 10, resetsAt: '2026-10-09T00:00:00+09:00' }))
      .mockResolvedValueOnce(problemResponse(429, { code: 'PLAN_QUOTA_EXCEEDED', feature: 'EVIDENCE_QUESTION', period: 'DAY', plan: 'FREE',
        limit: 10, used: 10, resetsAt: '2026-10-09T00:00:00+09:00', instance: '/api/v1/support-programs/detail/answers' }))
      .mockResolvedValueOnce(problemResponse(503, { code: 'QUOTA_UNAVAILABLE' })))
    const repository = new SupportProgramRepositoryImpl()

    const search = await repository.search(command).catch((error: unknown) => error)
    expect(search).toBeInstanceOf(PlanQuotaExceededError)
    expect((search as Error).message).toBe('오늘 AI 대화 검색 10회를 모두 썼어요. 약 3시간 뒤에 다시 채워져요. 필터 검색은 계속 쓸 수 있어요.')
    const question = await repository.answerEvidenceQuestion(command).catch((error: unknown) => error)
    expect(question).toBeInstanceOf(PlanQuotaExceededError)
    expect((question as Error).message).toBe('오늘 공고 원문 질문 10회를 모두 썼어요. 약 3시간 뒤에 다시 채워져요.')
    // 이용량 확인 실패(503)는 원문 답변 장애('unavailable')로 바꾸지 않고 그대로 올립니다.
    expect(await repository.answerEvidenceQuestion(command).catch((error: unknown) => error)).toBeInstanceOf(QuotaUnavailableError)
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
