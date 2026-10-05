export type DailyReportSettings = {
  supportPurpose: string
  enabled: boolean
  emailConfirmed: boolean
  emailDeliveryAvailable: boolean
  schedulerEnabled: boolean
  sendHour: number
}

/**
 * 리포트 발송 시작 시각(서울 기준 0~23시)을 "오전 8시"·"오후 1시"처럼 적습니다. 자정은 "오전 0시", 정오는 "오후 12시"입니다.
 * 웹과 모바일의 수신 설정·다음 리포트 안내가 같은 표기를 씁니다.
 */
export function sendHourLabel(hour: number): string {
  return hour < 12 ? `오전 ${hour}시` : `오후 ${hour === 12 ? 12 : hour - 12}시`
}

export type DailyReportSettingsInput = { supportPurpose: string; enabled: boolean; consent: boolean }
export type DailyReportEmailAction = 'confirm' | 'unsubscribe'

export type DailyReportItem = {
  sourceCode: string
  sourceProgramId: string
  title: string
  sourceUrl: string
  applicationPeriod: string
  relevanceScore: number | null
  matchedReasons: string[]
  eligibilityStatus: string
  eligibilityNote: string
  evidenceStatus: 'ANSWERED' | 'INSUFFICIENT_EVIDENCE' | 'UNSUPPORTED' | 'FAILED'
  evidenceAnswer: string | null
  citations: { excerpt: string; sourceUrl: string }[]
}

/** 생성 당시 기업 조건과 결과를 보관한 일일 리포트입니다. 점수는 선정확률이 아닙니다. */
export type DailyReport = {
  id: number
  reportDate: string
  status: 'GENERATING' | 'READY' | 'FAILED'
  deliveryStatus: 'NOT_REQUESTED' | 'SENDING' | 'SENT' | 'UNKNOWN' | 'SKIPPED'
  companyName: string
  region: string
  industry: string
  supportPurpose: string
  generatedAt: string | null
  programs: DailyReportItem[]
  warnings: string[]
  errorMessage: string | null
}
