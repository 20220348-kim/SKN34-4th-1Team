import { afterEach, describe, expect, it, vi } from 'vitest'

import { SupportProgramSearchTimeoutError } from '../../../domain/errors/SupportProgramSearchTimeoutError'
import { emptyConversationContext } from '../../fixtures/supportProgramConversation'
import { SupportProgramRepositoryImpl } from '../../repositories/SupportProgramRepositoryImpl'
import { searchSupportProgramsApi, SupportProgramApiError, SupportProgramSearchTimeoutApiError } from '../supportProgramApi'

afterEach(() => vi.unstubAllGlobals())

const timeoutProblem = {
  type: 'urn:govbiz:problem:ai-service-timeout', title: 'AI Service Gateway Timeout', status: 504,
  detail: 'private server detail', instance: '/api/v1/support-programs/search', code: 'AI_SERVICE_TIMEOUT',
}

function problemResponse(changes: Record<string, unknown> = {}, contentType = 'application/problem+json; charset=UTF-8', status = 504) {
  return new Response(JSON.stringify({ ...timeoutProblem, ...changes }), {
    status, headers: { 'Content-Type': contentType },
  })
}

describe('검색 서버 시간 초과 HTTP 경계', () => {
  it('유효한 504 Problem만 API 오류에서 안전한 검색 도메인 오류로 변환하며 재시도하지 않는다', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(problemResponse()))
    vi.stubGlobal('fetch', fetchMock)
    await expect(searchSupportProgramsApi({ query: '서울 지원금' })).rejects.toBeInstanceOf(SupportProgramSearchTimeoutApiError)
    const error = await new SupportProgramRepositoryImpl().search({ query: '서울 지원금' }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(SupportProgramSearchTimeoutError)
    expect(error).not.toHaveProperty('status')
    expect(error).not.toHaveProperty('code')
    expect(String(error)).not.toContain('private server detail')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    { code: 'AI_SERVICE_UNAVAILABLE' }, { status: 503 }, { type: 'urn:unknown' },
    { title: null }, { detail: undefined }, { instance: '/another-endpoint' },
  ])('잘못되거나 알 수 없는 504 Problem은 일반 오류로 남긴다: %o', async (changes) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problemResponse(changes)))
    const error = await new SupportProgramRepositoryImpl().search({ query: '지원금' }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(SupportProgramApiError)
    expect(error).not.toBeInstanceOf(SupportProgramSearchTimeoutApiError)
    expect(error).not.toBeInstanceOf(SupportProgramSearchTimeoutError)
  })

  it.each(['text/html', 'application/json'])('잘못된 Content-Type %s이면 시간 초과 계약으로 인정하지 않는다', async (contentType) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problemResponse({}, contentType)))
    await expect(new SupportProgramRepositoryImpl().search({ query: '지원금' })).rejects.not.toBeInstanceOf(SupportProgramSearchTimeoutError)
  })

  it('잘못된 JSON과 HTTP 상태가 다르면 일반 오류로 남긴다', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('private upstream response', { status: 504, headers: { 'Content-Type': 'application/problem+json' } }))
      .mockResolvedValueOnce(problemResponse({}, 'application/problem+json', 502)))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await new SupportProgramRepositoryImpl().search({ query: '지원금' }).catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(SupportProgramApiError)
      expect(error).not.toBeInstanceOf(SupportProgramSearchTimeoutApiError)
      expect(String(error)).not.toContain('private upstream response')
    }
  })

  it('동일한 504 응답이어도 조건 해석과 원문 질문의 기존 오류 경로는 변경하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(problemResponse())))
    const repository = new SupportProgramRepositoryImpl()
    const requests = [
      () => repository.interpretConversation({ message: '서울', context: emptyConversationContext, pendingClarification: null }),
      () => repository.answerEvidenceQuestion({ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', question: '지원 대상은?' }),
    ]
    for (const request of requests) {
      const error = await request().catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(SupportProgramSearchTimeoutError)
      expect(error).not.toBeInstanceOf(SupportProgramSearchTimeoutApiError)
    }
  })
})
