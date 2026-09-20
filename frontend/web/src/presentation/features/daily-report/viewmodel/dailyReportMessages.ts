import { DailyReportError } from '../../../../domain/errors/DailyReportError'

/** 외부 오류 본문·메일 주소·토큰은 화면이나 로그에 그대로 노출하지 않습니다. */
export function dailyReportFailureMessage(error: unknown): string {
  if (error instanceof DailyReportError) {
    if (error.status === 401) return '로그인이 만료되었습니다. 다시 로그인해 주세요.'
    if (error.code === 'REPORT_DAILY_BUDGET_EXCEEDED') return '오늘의 리포트 생성 한도에 도달했습니다. 내일 다시 시도해 주세요.'
    if (error.code === 'REPORT_CAPACITY_EXCEEDED') return '다른 리포트를 생성하고 있습니다. 잠시 기다린 뒤 다시 시도해 주세요.'
    if (error.code === 'EMAIL_VERIFICATION_RATE_LIMITED') return '확인 메일은 5분 간격으로 요청할 수 있습니다. 받은 메일함과 스팸함을 먼저 확인해 주세요.'
    if (error.code === 'EMAIL_CONFIRMATION_REQUIRED') return '리포트 수신 주소를 먼저 확인해 주세요. 확인 메일의 버튼을 누른 뒤 상태를 새로고침해 주세요.'
    if (error.code === 'EMAIL_CONSENT_REQUIRED') return '정기 리포트 이메일 수신 동의에 직접 체크해 주세요.'
    if (error.code === 'SEARCH_NOT_READY') return '검색할 공고 데이터나 색인이 아직 준비되지 않았습니다. 데이터가 준비된 뒤 다시 시도해 주세요.'
    if (error.status === 429) return '요청량 제한으로 처리하지 못했습니다. 잠시 기다린 뒤 다시 시도해 주세요.'
    if (error.code.includes('TOKEN')) return '만료되었거나 이미 사용한 이메일 링크입니다. 새 확인 메일을 요청해 주세요.'
    if (error.code.includes('COMPANY')) return '기업 정보를 먼저 등록해 주세요.'
    if (error.code.includes('EMAIL') && error.status === 503) return '현재 이메일 발송을 사용할 수 없습니다. 운영자의 발송 설정이 필요합니다.'
    if (error.status === 409) return '현재 상태에서는 처리할 수 없습니다. 상태 새로고침 후 이메일 확인 여부와 오늘의 생성 결과를 확인해 주세요.'
    if (error.status === 503) return '검색 또는 리포트 서비스를 사용할 수 없습니다. 데이터 준비 상태를 확인한 뒤 다시 시도해 주세요.'
    if (error.status === 400) return '입력 내용이나 이메일 링크를 확인해 주세요. 만료된 링크라면 새 확인 메일을 요청해 주세요.'
    if (error.code === 'INVALID_RESPONSE') return '리포트 응답을 검증하지 못했습니다. 결과를 표시하지 않습니다.'
  }
  if (error instanceof DOMException && error.name === 'AbortError') return '응답 대기 시간이 지났습니다. 서버 생성은 계속될 수 있으니 상태 새로고침으로 확인해 주세요.'
  return '요청을 처리하지 못했습니다. 입력은 유지됩니다. 상태 새로고침 후 다시 시도해 주세요.'
}
