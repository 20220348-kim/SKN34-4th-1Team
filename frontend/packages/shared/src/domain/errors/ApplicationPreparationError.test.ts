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

  it('explains that a disabled generation worker needs administrator action while preserving saved answers', () => {
    const error = new ApplicationPreparationError(503, 'APPLICATION_DOCUMENT_GENERATION_UNAVAILABLE')
    expect(error.message).toContain('문서 생성 작업 처리가 비활성화되어 있습니다')
    expect(error.message).toContain('저장된 답변은 유지')
    expect(error.message).toContain('관리자 확인')
    expect(error.message).not.toContain('잠시 후 다시 시도')
  })
})
