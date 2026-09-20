export const runLabels = { QUEUED: '대기 중', RUNNING: '분석 중', SUCCEEDED: '분석 완료', FAILED: '분석 실패', INTERRUPTED: '실행 중단', UNKNOWN: '결과 확인 필요' }

const reviewDateTimeFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

export function formatReviewDateTime(value: string): string {
  return reviewDateTimeFormatter.format(new Date(value))
}
