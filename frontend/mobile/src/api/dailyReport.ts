import { dailyReportResponseSchema, dailyReportSettingsSchema } from '@govbiz/shared/data/models/DailyReportDto'
import type { DailyReportSettingsInput } from '@govbiz/shared/domain/entities/DailyReport'
import { apiRequest, ApiError, errorMessage } from './client'

const mine = '/api/v1/me/daily-reports'

export async function getDailyReportSettings(accessToken: string, signal?: AbortSignal) {
  return dailyReportSettingsSchema.parse(await apiRequest(`${mine}/settings`, { accessToken, signal }))
}

export async function getLatestDailyReport(accessToken: string, signal?: AbortSignal) {
  return dailyReportResponseSchema.parse(await apiRequest(`${mine}/latest`, { accessToken, signal })).report
}

export async function saveDailyReportSettings(accessToken: string, input: DailyReportSettingsInput, signal?: AbortSignal) {
  return dailyReportSettingsSchema.parse(await apiRequest(`${mine}/settings`, { method: 'PUT', body: input, accessToken, signal }))
}

export async function requestDailyReportEmailVerification(accessToken: string, signal?: AbortSignal) {
  const result = await apiRequest(`${mine}/verify-email`, { method: 'POST', accessToken, signal })
  if (result !== undefined) throw new Error('확인 메일 요청 응답을 확인하지 못했습니다.')
}

/** Keep API failure codes useful without showing raw server messages or account data. */
export function dailyReportErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.code === 'EMAIL_VERIFICATION_RATE_LIMITED') return '확인 메일은 5분 간격으로 요청할 수 있습니다.'
    if (cause.code === 'EMAIL_CONFIRMATION_REQUIRED') return '리포트 수신 주소를 먼저 확인해 주세요.'
    if (cause.code === 'EMAIL_CONSENT_REQUIRED') return '정기 이메일 수신 동의에 체크해 주세요.'
    if (cause.code === 'SEARCH_NOT_READY') return '검색 데이터가 준비되지 않았습니다. 나중에 다시 확인해 주세요.'
    if (cause.code?.includes('COMPANY')) return '기업 정보를 먼저 등록해 주세요.'
    if (cause.code?.includes('EMAIL') && cause.status === 503) return '현재 이메일 발송을 사용할 수 없습니다.'
  }
  return errorMessage(cause)
}
