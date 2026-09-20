import type { SupportProgramRequestError } from '../../../domain/errors/SupportProgramRequestError'

/** 검색과 근거 질문이 공유하는 안전한 안내이며 자동 재시도는 예약하지 않습니다. */
export function supportProgramRequestFailureMessage(error: SupportProgramRequestError): string {
  const reason = error.reason === 'rate-limited'
    ? '짧은 시간에 요청이 많아 잠시 제한되었습니다.'
    : '현재 다른 요청을 처리하고 있어 새 요청을 시작할 수 없습니다.'
  const retry = error.retryAfterSeconds === null
    ? '잠시 후 직접 다시 시도해 주세요.'
    : `약 ${error.retryAfterSeconds}초 후 직접 다시 시도해 주세요.`
  return `${reason} ${retry}`
}
