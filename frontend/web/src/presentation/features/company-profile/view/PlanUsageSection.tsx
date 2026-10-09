import { Link } from 'react-router'

import { planLabels } from '@govbiz/shared/domain/entities/PlanUsage'
import type { PlanUsageLoad } from '../../../shared/plan-usage/usePlanUsage'
import { appPaths } from '../../../shared/routes/appPaths'
import { workspacePageStyles, workspaceTagClassName } from '../../../shared/workspace/WorkspacePage.styles'
import { companyProfileStyles } from './CompanyProfilePage.styles'

/**
 * 프로필의 요금제 카드입니다. 지금 요금제를 보여 줍니다.
 * 결제는 아직 없으므로 요금제를 바꾸는 동작은 두지 않고 요금제 안내 화면으로만 잇습니다.
 */
export function PlanUsageSection({ load, onRetry }: { load: PlanUsageLoad; onRetry: () => void }) {
  const plan = load.status === 'ready' ? load.usage.plan : null
  return (
    <section className={workspacePageStyles.card} aria-label="요금제">
      <div className={workspacePageStyles.cardHeader}>
        <h2 className={workspacePageStyles.cardTitle}>요금제</h2>
        {plan !== null ? <span className={workspaceTagClassName('ok')}>{planLabels[plan]}</span> : null}
      </div>
      {load.status === 'loading' ? (
        <p className={workspacePageStyles.emptyNote} aria-live="polite">요금제를 불러오는 중이에요.</p>
      ) : null}
      {load.status === 'failed' ? (
        <div className={companyProfileStyles.settingRow}>
          <span className={companyProfileStyles.settingDescription} role="alert">요금제를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</span>
          <button className={workspacePageStyles.secondaryButton} type="button" onClick={onRetry}>다시 시도</button>
        </div>
      ) : null}
      <p className={companyProfileStyles.planNote}>
        결제는 아직 받지 않아요. 요금제별 내용은 요금제 화면에서 볼 수 있어요.{' '}
        <Link className={workspacePageStyles.quietLink} to={appPaths.pricing}>요금제 보기</Link>
      </p>
    </section>
  )
}
