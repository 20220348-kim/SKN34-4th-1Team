import { Link } from 'react-router'

import { useAuthSession } from '../auth/hooks/useAuthSession'
import { appPaths } from '../routes/appPaths'
import { workspacePageStyles } from '../workspace/WorkspacePage.styles'
import { WorkspacePageHeader } from '../workspace/WorkspacePageHeader'
import { type PartnerSection, PartnerSectionTabs } from './PartnerSectionTabs'

/**
 * 모집글·내 모집글·제안함 세 화면이 똑같이 쓰는 "파트너 관리" 머리글입니다. 제목·탭·작성 버튼을 한 줄에 두고 [active]만 다릅니다.
 * 기업을 등록하지 않은 회원은 작성 대신 프로필 등록으로 안내합니다.
 */
export function PartnerManagementHeader({ active }: { active: PartnerSection }) {
  const { hasCompany } = useAuthSession()

  return (
    <WorkspacePageHeader
      title="파트너 관리"
      tabs={<PartnerSectionTabs active={active} />}
      actions={
        <Link
          className={hasCompany ? workspacePageStyles.primaryButton : workspacePageStyles.secondaryButton}
          to={hasCompany ? appPaths.partnerNew : appPaths.profile}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          {hasCompany ? '모집글 작성' : '기업 등록 후 작성'}
        </Link>
      }
    />
  )
}
