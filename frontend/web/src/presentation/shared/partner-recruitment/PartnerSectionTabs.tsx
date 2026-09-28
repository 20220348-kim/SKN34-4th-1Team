import { Link } from 'react-router'

import { appPaths } from '../routes/appPaths'
import { workspacePageStyles } from '../workspace/WorkspacePage.styles'

export type PartnerSection = 'recruitments' | 'mine'

/**
 * 사이드바의 "파트너 관리" 아래 두 화면(모집글·내 모집글)을 오가는 탭입니다. 머리글의 제목 옆 같은 줄에 두고 주소는 그대로 써서
 * 기존 링크와 복귀 경로가 유지됩니다. 제안함은 사이드바의 별도 메뉴(협업 · 제안함)로 갑니다.
 */
export function PartnerSectionTabs({ active }: { active: PartnerSection }) {
  const tabs: { key: PartnerSection; label: string; to: string }[] = [
    { key: 'recruitments', label: '모집글', to: appPaths.partners },
    { key: 'mine', label: '내 모집글', to: appPaths.myPartners },
  ]

  return (
    <nav className={workspacePageStyles.segment} aria-label="파트너 관리 탭">
      {tabs.map((tab) => (
        <Link
          className={workspacePageStyles.segmentTab}
          key={tab.key}
          to={tab.to}
          aria-current={tab.key === active ? 'page' : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}
