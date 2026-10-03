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

/** 진행 카드의 경과 시간입니다. 신청 문서의 진행 카드와 같은 표기("1분 20초 지남")를 씁니다. */
export function elapsedLabel(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safe / 60)
  return minutes > 0 ? `${minutes}분 ${safe % 60}초 지남` : `${safe}초 지남`
}

const reviewClockFormatter = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit' })

/** 목록 카드의 "오후 3:40 시작"처럼 같은 날 시각만 보입니다. */
export function formatReviewClock(value: string): string {
  return reviewClockFormatter.format(new Date(value))
}
