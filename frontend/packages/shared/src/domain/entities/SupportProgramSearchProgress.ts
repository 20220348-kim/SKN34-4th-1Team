/**
 * AI 검색을 기다리는 동안 웹·앱이 함께 보여 주는 단계와 안내입니다.
 *
 * 서버는 진행 단계를 따로 알려 주지 않으므로 화면이 확실히 아는 사건만 단계로 넘깁니다. 조건 정리는 사용자가 확인한
 * 조건으로 검색을 보낸 순간 끝나고, 공고 찾기와 자격 확인은 한 요청 안에서 서버가 차례로 하므로 둘 다 진행 중으로 두고
 * 보통 걸리는 시간만 적습니다(측정: 검색 전체 약 27초, 그중 자격 확인을 겸한 순위 매기기 약 21초).
 * 결과가 오면 대기 화면 대신 결과를 보여 줍니다. 시간에 맞춰 단계를 넘기거나 가짜 진행률을 그리지 않습니다.
 */
export type SupportProgramSearchStep = {
  label: string
  state: 'done' | 'running'
  /** 끝난 단계는 "완료", 진행 중인 단계는 보통 걸리는 시간입니다. */
  note: string
}

export const supportProgramSearchSteps: readonly SupportProgramSearchStep[] = [
  { label: '조건 정리', state: 'done', note: '완료' },
  { label: '공고 찾기', state: 'running', note: '보통 5초 안팎' },
  { label: '자격 확인', state: 'running', note: '보통 20초 안팎' },
]

/** 검색을 보낸 시각부터 지난 초입니다. 시계가 거꾸로 가도 0 아래로 내려가지 않습니다. */
export function supportProgramSearchElapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000))
}

/** 지난 시간을 "12초", "1분 5초"처럼 씁니다. */
export function formatSupportProgramSearchElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}초`
  const rest = seconds % 60
  return rest ? `${Math.floor(seconds / 60)}분 ${rest}초` : `${Math.floor(seconds / 60)}분`
}

/**
 * 10초가 지나면 보통 걸리는 시간을, 그보다 한참 오래 걸리면 평소보다 늦다는 것을 알립니다. 10초 전에는 안내가 없습니다.
 * 10초는 사용자가 기다리며 주의를 유지하는 한계로 흔히 쓰는 기준입니다.
 */
export function supportProgramSearchWaitNote(elapsedSeconds: number): string | null {
  if (elapsedSeconds < 10) return null
  if (elapsedSeconds < 45) return '후보 공고마다 지원 대상과 지역을 확인하고 있어요. 보통 30초 안팎 걸려요.'
  return '평소보다 오래 걸리고 있어요. 조금만 더 기다려 주세요.'
}
