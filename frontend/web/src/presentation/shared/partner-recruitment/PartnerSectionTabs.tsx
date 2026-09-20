import { Link } from 'react-router'

import { usePendingReceivedProposalCount } from '../partner-proposal/useReceivedProposals'
import { appPaths } from '../routes/appPaths'
import { workspaceChipClassName } from '../workspace/WorkspacePage.styles'

export type PartnerSection = 'recruitments' | 'mine' | 'proposals'

const partnerSectionTabStyles = {
  nav: 'flex flex-wrap items-center gap-2',
  badge: 'ml-[0.35rem] inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-brand-primary px-[0.4rem] text-[0.68rem] font-extrabold text-white',
} as const

/**
 * 사이드바의 "파트너 관리" 아래 세 화면(모집글·내 모집글·제안함)을 오가는 탭입니다. 머리글의 제목 옆 같은 줄에 두고 주소는 그대로 써서
 * 기존 링크와 복귀 경로가 유지됩니다. 제안함 탭에는 받은 제안의 대기 건수를 붙입니다(0이면 숨김).
 */
export function PartnerSectionTabs({ active }: { active: PartnerSection }) {
  const pendingCount = usePendingReceivedProposalCount()
  const tabs: { key: PartnerSection; label: string; to: string }[] = [
    { key: 'recruitments', label: '모집글', to: appPaths.partners },
    { key: 'mine', label: '내 모집글', to: appPaths.myPartners },
    { key: 'proposals', label: '제안함', to: appPaths.proposals },
  ]

  return (
    <nav className={partnerSectionTabStyles.nav} aria-label="파트너 관리 탭">
      {tabs.map((tab) => (
        <Link
          className={workspaceChipClassName(tab.key === active)}
          key={tab.key}
          to={tab.to}
          aria-current={tab.key === active ? 'page' : undefined}
        >
          {tab.label}
          {tab.key === 'proposals' && pendingCount !== null && pendingCount > 0 ? (
            <span className={partnerSectionTabStyles.badge} aria-label={`대기 ${pendingCount}건`}>{pendingCount}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  )
}
