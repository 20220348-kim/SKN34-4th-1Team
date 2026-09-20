import type { DailyReportEmailAction, DailyReportSettingsInput } from '../entities/DailyReport'
import type { DailyReportRepository } from '../repositories/DailyReportRepository'

export class DailyReportUseCase {
  private readonly repository: DailyReportRepository
  constructor(repository: DailyReportRepository) { this.repository = repository }
  settings(signal?: AbortSignal) { return this.repository.settings(signal) }
  saveSettings(input: DailyReportSettingsInput, signal?: AbortSignal) {
    const supportPurpose = input.supportPurpose.trim()
    if (supportPurpose.length > 100 || /\p{C}/u.test(supportPurpose)) throw new Error('지원 목적은 제어문자 없이 100자 이하로 입력해 주세요.')
    if (input.enabled && !input.consent) throw new Error('정기 리포트 이메일 수신에 동의해 주세요.')
    return this.repository.saveSettings({ ...input, supportPurpose }, signal)
  }
  verifyEmail(signal?: AbortSignal) { return this.repository.verifyEmail(signal) }
  emailAction(action: DailyReportEmailAction, token: string, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('유효하지 않은 이메일 링크입니다. 새 확인 메일을 요청해 주세요.')
    return this.repository.emailAction(action, token, signal)
  }
  latest(signal?: AbortSignal) { return this.repository.latest(signal) }
  preview(signal?: AbortSignal) { return this.repository.preview(signal) }
}
