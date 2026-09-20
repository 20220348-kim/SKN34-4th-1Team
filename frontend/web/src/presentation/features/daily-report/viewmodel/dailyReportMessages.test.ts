import { describe, expect, it } from 'vitest'
import { DailyReportError } from '../../../../domain/errors/DailyReportError'
import { dailyReportFailureMessage } from './dailyReportMessages'

describe('리포트 실패 안내', () => {
  it.each([
    ['REPORT_DAILY_BUDGET_EXCEEDED', 429, '내일 다시 시도'],
    ['REPORT_CAPACITY_EXCEEDED', 429, '다른 리포트를 생성'],
    ['EMAIL_VERIFICATION_RATE_LIMITED', 429, '5분 간격'],
    ['EMAIL_CONFIRMATION_REQUIRED', 409, '수신 주소를 먼저 확인'],
    ['EMAIL_CONSENT_REQUIRED', 409, '수신 동의에 직접 체크'],
    ['SEARCH_NOT_READY', 503, '공고 데이터나 색인이 아직 준비'],
  ])('%s의 실제 해결 방법을 안내한다', (code, status, expected) => {
    expect(dailyReportFailureMessage(new DailyReportError(status, code))).toContain(expected)
  })

  it('일일 한도와 일반 요청량 제한을 확인 메일 재요청 간격으로 안내하지 않는다', () => {
    const daily = dailyReportFailureMessage(new DailyReportError(429, 'REPORT_DAILY_BUDGET_EXCEEDED'))
    expect(daily).not.toContain('잠시')
    expect(daily).not.toContain('5분')
    const general = dailyReportFailureMessage(new DailyReportError(429, 'RATE_LIMITED'))
    expect(general).not.toContain('메일')
    expect(general).not.toContain('5분')
  })

  it('예상하지 못한 외부 오류의 상세 메시지를 표시하지 않는다', () => {
    expect(dailyReportFailureMessage(new Error('secret SMTP authentication information'))).not.toContain('secret')
  })
})
