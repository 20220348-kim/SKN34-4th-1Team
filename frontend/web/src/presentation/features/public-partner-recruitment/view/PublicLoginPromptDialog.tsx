import { Link } from 'react-router'

import { WorkspaceModal } from '../../../shared/workspace/WorkspaceModal'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'
import { publicPartnerRecruitmentStyles as styles } from './PublicPartnerRecruitment.styles'
import { publicPartnerMemberBenefits } from './publicPartnerMessages'

/**
 * 비로그인 회원이 모집글을 자세히 보거나 제안하려 할 때 띄우는 로그인 안내입니다. 예전 오른쪽 안내 카드와 같은
 * 옅은 초록 카드로 뒤 화면을 흐리게 가리고, 로그인 뒤에는 같은 모집글로 돌아오도록 복귀 경로가 담긴 링크를 줍니다.
 */
export function PublicLoginPromptDialog({
  isOpen,
  loginPath,
  onClose,
}: {
  isOpen: boolean
  loginPath: string
  onClose: () => void
}) {
  return (
    <WorkspaceModal isOpen={isOpen} title="로그인하면 할 수 있는 일" tone="accent" blurBackdrop onClose={onClose}>
      <ul className={styles.ctaList}>
        {publicPartnerMemberBenefits.map((benefit) => <li key={benefit}>{benefit}</li>)}
      </ul>
      <div className={styles.ctaButtons}>
        <Link className={workspacePageStyles.primaryButton} to={loginPath}>로그인하고 제안하기</Link>
      </div>
    </WorkspaceModal>
  )
}
