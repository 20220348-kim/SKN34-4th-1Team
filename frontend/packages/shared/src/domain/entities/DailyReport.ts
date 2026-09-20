export type DailyReportSettings = {
  supportPurpose: string
  enabled: boolean
  emailConfirmed: boolean
  emailDeliveryAvailable: boolean
  schedulerEnabled: boolean
  sendHour: number
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
