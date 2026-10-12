import type { ReactNode } from 'react'
import { Link } from 'react-router'

import type { PartnerRecruitmentSummary } from '../../../domain/entities/PartnerRecruitment'
import { partnerRecruitmentStyles } from '../../features/partner-recruitment/view/PartnerRecruitment.styles'
import { appPaths } from '../routes/appPaths'
import { workspacePageStyles, workspaceTagClassName } from '../workspace/WorkspacePage.styles'
import {
  companyInitial,
  companySummaryLine,
  programDeadlineLabel,
  recruitmentConditionTags,
  recruitmentDeadlineText,
} from './partnerRecruitmentLabels'
import { RecruitmentDdayTag } from './RecruitmentDdayTag'

/**
 * 파트너 관리 목록의 모집글 카드입니다. Gov 대화의 맞춤 추천도 같은 카드를 쓰고, 추천 이유처럼 화면마다 덧붙일 줄은
 * [children]으로 조건 태그 아래에 넣습니다.
 */
export function RecruitmentCard({ recruitment, children }: { recruitment: PartnerRecruitmentSummary; children?: ReactNode }) {
  const cardClassName = recruitment.isMine
    ? workspacePageStyles.outlinedCard
    : workspacePageStyles.card

  return (
    <article className={cardClassName} aria-label={recruitment.title}>
      <div className={partnerRecruitmentStyles.cardTop}>
        {/* 남은 날은 신청 문서 카드처럼 왼쪽 태그 옆 D-day 배지로, 오른쪽에는 마감 날짜만 둡니다. */}
        <span className={partnerRecruitmentStyles.tagRow}>
          <span className={workspaceTagClassName(recruitment.isMine ? 'warn' : 'ok')}>
            {recruitment.isMine ? '내가 쓴 모집글' : '기업마당 공고'}
          </span>
          {/* 상태 태그가 없는 카드라 마감된 글은 여기서 "모집 마감"을 알리고, 모집 중이면 D-day를 붙입니다. */}
          {recruitment.status === 'CLOSED' ? <span className={workspaceTagClassName('muted')}>모집 마감</span> : null}
          <RecruitmentDdayTag deadline={recruitment.recruitmentDeadline} closed={recruitment.status === 'CLOSED'} />
        </span>
        <span className={partnerRecruitmentStyles.mineDeadline}>
          {recruitmentDeadlineText(recruitment.recruitmentDeadline)}
        </span>
      </div>

      <div className="flex flex-col gap-[0.2rem]">
        <h3 className={partnerRecruitmentStyles.cardTitle}>{recruitment.title}</h3>
        <p className={partnerRecruitmentStyles.cardProgram}>
          {recruitment.program.title} · {recruitment.program.organization} ·{' '}
          {programDeadlineLabel(recruitment.program.applicationEndDate)}
        </p>
      </div>

      <div className={partnerRecruitmentStyles.authorRow}>
        <span
          className={`${partnerRecruitmentStyles.authorAvatar} ${
            recruitment.isMine
              ? partnerRecruitmentStyles.authorAvatarMine
              : partnerRecruitmentStyles.authorAvatarOther
          }`}
          aria-hidden="true"
        >
          {companyInitial(recruitment.company.companyName)}
        </span>
        <span className="min-w-0">
          <span className={partnerRecruitmentStyles.authorName}>{recruitment.company.companyName}</span>
          <span className={partnerRecruitmentStyles.authorSummary}>{companySummaryLine(recruitment.company)}</span>
        </span>
      </div>

      <div className={partnerRecruitmentStyles.tagRow}>
        {recruitmentConditionTags(recruitment).map((tag) => (
          <span className={workspaceTagClassName('muted')} key={tag} title={tag}>
            {tag}
          </span>
        ))}
      </div>

      {children}

      <div className={partnerRecruitmentStyles.cardFooter}>
        {recruitment.isMine ? (
          <span className={partnerRecruitmentStyles.cardFooterNote}>
            받은 제안 {recruitment.proposalCount}건
          </span>
        ) : (
          <span className={partnerRecruitmentStyles.cardFooterNote}>
            제안 {recruitment.proposalCount}건
          </span>
        )}
        <Link
          className={recruitment.isMine ? workspacePageStyles.secondaryButton : workspacePageStyles.primaryButton}
          to={`${appPaths.partnerDetail}?${new URLSearchParams({ recruitmentId: String(recruitment.id) })}`}
        >
          {recruitment.isMine ? '받은 제안 보기' : '자세히 보기'}
        </Link>
      </div>
    </article>
  )
}
