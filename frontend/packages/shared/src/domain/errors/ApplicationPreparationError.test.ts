import { describe, expect, it } from 'vitest'
import { ApplicationPreparationError } from './ApplicationPreparationError'

describe('application preparation request errors', () => {
  it('distinguishes an unreachable server from an HTTP error response', () => {
    expect(new ApplicationPreparationError(0, 'REQUEST_FAILED').message).toContain('연결하지 못했습니다')
    const serverError = new ApplicationPreparationError(503, 'REQUEST_FAILED')
    expect(serverError.message).toContain('서버에서 신청문서 요청을 처리하지 못했습니다')
    expect(serverError.message).not.toContain('연결하지 못했습니다')
  })

  it('retains the unavailable API and expired session guidance', () => {
    expect(new ApplicationPreparationError(404, 'APPLICATION_PREPARATION_API_UNAVAILABLE').message).toContain('현재 연결된 서버')
    expect(new ApplicationPreparationError(401, 'REQUEST_FAILED').message).toContain('로그인이 만료되었습니다')
  })
})
