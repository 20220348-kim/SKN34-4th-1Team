import { ddayToneClassNames } from '../workspace/WorkspaceStates.styles'
import { workspacePageStyles } from '../workspace/WorkspacePage.styles'
import { recruitmentDday } from './partnerRecruitmentLabels'

/**
 * 모집글 카드 왼쪽 태그 줄에 붙는 모집 마감 D-day 배지입니다(신청 문서 카드의 D-day와 같은 자리).
 * 색은 shared `ddayTone`(7일 이내 빨강 · 30일 이내 노랑 · 그 뒤 초록)이고, 마감된 글에는 그리지 않습니다.
 */
export function RecruitmentDdayTag({ deadline, closed }: { deadline: string; closed: boolean }) {
  const dday = recruitmentDday(deadline, closed)
  if (dday === null) return null
  return <span className={`${workspacePageStyles.tag} ${ddayToneClassNames[dday.tone]}`}><span className="sr-only">모집 마감 </span>{dday.label}</span>
}
