import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyConversationContext, readyConversationProposal, seoulConversationContext } from '../../fixtures/supportProgramConversation'
import { SupportProgramRepositoryImpl } from '../../repositories/SupportProgramRepositoryImpl'
import { interpretSupportProgramConversationApi, SupportProgramApiError, SupportProgramInterpretationApiError } from '../supportProgramApi'
import { SupportProgramRequestError } from '../../../domain/errors/SupportProgramRequestError'
import { SupportProgramInterpretationError } from '../../../domain/errors/SupportProgramInterpretationError'

afterEach(() => vi.unstubAllGlobals())

describe('공개 조건 해석 HTTP 경계', () => {
  const command = { message: '서울 SW 사업화', context: emptyConversationContext, pendingClarification: null }
  it('필수 null context 필드를 JSON으로 보내고 제안을 도메인으로 변환한다', async () => {
    const proposal = readyConversationProposal(seoulConversationContext)
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(proposal)))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    await expect(new SupportProgramRepositoryImpl().interpretConversation(command, signal)).resolves.toEqual(proposal)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new URL(url).pathname).toBe('/api/v1/support-programs/conversation/interpret')
    expect(new URL(url).search).toBe('')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual(command)
    expect(init.signal).toBe(signal)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('미확정 제안과 0건 검색 요약을 전송하고 설명 답변을 표시할 도메인 값으로 변환한다', async () => {
    const request = { ...command, message: '왜 못찾아?', pendingProposal: seoulConversationContext,
      lastSearch: { context: seoulConversationContext, resultCount: 0 } }
    const answer = { status: 'ANSWERED', proposedContext: seoulConversationContext,
      clarificationQuestion: null, changedFields: [], answer: '현재 검색 조건에 맞는 공고가 0건입니다.' }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(answer)))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new SupportProgramRepositoryImpl().interpretConversation(request)).resolves.toEqual(answer)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual(request)
  })

  it('추가 질문과 준비된 제안의 초안을 동시에 전송하지 않는다', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(interpretSupportProgramConversationApi({ ...command, pendingProposal: seoulConversationContext,
      pendingClarification: { question: '지역은?', draftContext: emptyConversationContext } })).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('잘못된 READY와 장애를 정보 부족이나 검색 성공으로 바꾸지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      ...readyConversationProposal(emptyConversationContext),
    }))).mockResolvedValueOnce(new Response('', { status: 503 })))
    await expect(interpretSupportProgramConversationApi(command)).rejects.toThrow()
    await expect(new SupportProgramRepositoryImpl().interpretConversation(command)).rejects.toThrow()
  })

  it.each([
    [429, 'SUPPORT_PROGRAM_RATE_LIMITED', 'rate-limited'],
    [503, 'SUPPORT_PROGRAM_BUSY', 'busy'],
  ] as const)('해석도 기존 %s 요청 제한 계약을 안전한 도메인 오류로 전달한다', async (status, code, reason) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ type: 'urn:limited', title: 'Limited', status,
      detail: 'private', instance: '/api/v1/support-programs/conversation/interpret', code, retryAfterSeconds: 10,
    }), { status, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '10' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new SupportProgramRepositoryImpl().interpretConversation(command))
      .rejects.toEqual(new SupportProgramRequestError(reason, 10))
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each(['timeout', 'unavailable'] as const)('검증된 %s만 안전한 해석 도메인 오류로 변환하고 재시도하지 않는다', async (reason) => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(interpretationFailureResponse(reason)))
    vi.stubGlobal('fetch', fetchMock)
    const apiError = await interpretSupportProgramConversationApi(command).catch((failure: unknown) => failure)
    expect(apiError).toBeInstanceOf(SupportProgramInterpretationApiError)
    expect(apiError).toMatchObject({ reason })
    const domainError = await new SupportProgramRepositoryImpl().interpretConversation(command).catch((failure: unknown) => failure)
    expect(domainError).toBeInstanceOf(SupportProgramInterpretationError)
    expect(domainError).toMatchObject({ reason })
    for (const error of [apiError, domainError]) {
      expect(error).not.toHaveProperty('status')
      expect(error).not.toHaveProperty('code')
      expect(error).not.toHaveProperty('detail')
      expect(String(error)).not.toContain('private server detail')
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['timeout', { code: 'AI_SERVICE_UNAVAILABLE' }],
    ['unavailable', { code: 'AI_SERVICE_TIMEOUT' }],
    ['timeout', { status: 503 }],
    ['unavailable', { status: 504 }],
    ['timeout', { type: 'urn:govbiz:problem:ai-service-unavailable' }],
    ['unavailable', { type: 'urn:govbiz:problem:ai-service-timeout' }],
    ['timeout', { instance: '/api/v1/support-programs/search' }],
    ['unavailable', { instance: '/another-endpoint' }],
    ['timeout', { title: '' }],
    ['unavailable', { detail: undefined }],
  ] as const)('잘못되거나 해석 endpoint와 다른 %s 계약은 일반 오류로 남긴다: %o', async (reason, changes) => {
    const fetchMock = vi.fn().mockResolvedValue(interpretationFailureResponse(reason, changes))
    vi.stubGlobal('fetch', fetchMock)
    const error = await new SupportProgramRepositoryImpl().interpretConversation(command).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(SupportProgramApiError)
    expect(error).not.toBeInstanceOf(SupportProgramInterpretationApiError)
    expect(error).not.toBeInstanceOf(SupportProgramInterpretationError)
    expect(String(error)).not.toContain('private server detail')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    ['timeout', 'text/html'], ['unavailable', 'text/html'],
    ['timeout', 'application/json'], ['unavailable', 'application/json'],
  ] as const)('%s의 Content-Type이 %s이면 검증된 AI 장애로 인정하지 않는다', async (reason, contentType) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(interpretationFailureResponse(reason, {}, contentType)))
    const error = await new SupportProgramRepositoryImpl().interpretConversation(command).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(SupportProgramApiError)
    expect(error).not.toBeInstanceOf(SupportProgramInterpretationError)
  })

  it.each(['timeout', 'unavailable'] as const)('%s의 HTTP 상태가 다르거나 JSON이 손상되면 일반 오류를 유지한다', async (reason) => {
    const status = reason === 'timeout' ? 504 : 503
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(interpretationFailureResponse(reason, {}, 'application/problem+json', status === 504 ? 503 : 504))
      .mockResolvedValueOnce(new Response('private server detail', { status, headers: { 'Content-Type': 'application/problem+json' } }))
    vi.stubGlobal('fetch', fetchMock)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await new SupportProgramRepositoryImpl().interpretConversation(command).catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(SupportProgramApiError)
      expect(error).not.toBeInstanceOf(SupportProgramInterpretationApiError)
      expect(error).not.toBeInstanceOf(SupportProgramInterpretationError)
      expect(String(error)).not.toContain('private server detail')
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('요청 취소를 숨기지 않는다', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))
    const promise = interpretSupportProgramConversationApi(command, controller.signal)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
})

function interpretationFailureResponse(
  reason: 'timeout' | 'unavailable',
  changes: Record<string, unknown> = {},
  contentType = 'application/problem+json; charset=UTF-8',
  httpStatus = reason === 'timeout' ? 504 : 503,
) {
  return new Response(JSON.stringify({
    type: `urn:govbiz:problem:ai-service-${reason}`,
    title: 'AI Service failure',
    status: reason === 'timeout' ? 504 : 503,
    detail: 'private server detail',
    instance: '/api/v1/support-programs/conversation/interpret',
    code: reason === 'timeout' ? 'AI_SERVICE_TIMEOUT' : 'AI_SERVICE_UNAVAILABLE',
    ...changes,
  }), { status: httpStatus, headers: { 'Content-Type': contentType } })
}
