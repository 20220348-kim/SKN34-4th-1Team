import {
  hasPlanLimit,
  isNearPlanLimit,
  planLabels,
  planUsageCountText,
  planUsageFeatureLabels,
  planUsageResetText,
  type PlanUsageItem,
} from '@govbiz/shared/domain/entities/PlanUsage'
import { planUsagePercent } from '../../../shared/plan-usage/planUsageView'
import type { PlanUsageLoad } from '../../../shared/plan-usage/usePlanUsage'
import { workspacePageStyles, workspaceTagClassName } from '../../../shared/workspace/WorkspacePage.styles'
import { companyProfileStyles } from './CompanyProfilePage.styles'

/**
 * 프로필의 요금제와 이용량 카드입니다. 지금 요금제와 기능별로 이번 기간에 쓴 양, 다시 채워지는 때를 보여 줍니다.
 * 아직 한도를 정하지 않은 기능은 막대 없이 "제한 없음"으로 적습니다. 결제는 아직 없으므로 요금제를 바꾸는 동작은 두지 않습니다.
 */
export function PlanUsageSection({ load, onRetry }: { load: PlanUsageLoad; onRetry: () => void }) {
  const plan = load.status === 'ready' ? load.usage.plan : null
  return (
    <section className={workspacePageStyles.card} aria-label="요금제와 이용량">
      <div className={workspacePageStyles.cardHeader}>
        <h2 className={workspacePageStyles.cardTitle}>요금제와 이용량</h2>
        {plan !== null ? <span className={workspaceTagClassName('ok')}>{planLabels[plan]}</span> : null}
      </div>
      {load.status === 'loading' ? (
        <p className={workspacePageStyles.emptyNote} aria-live="polite">이용량을 불러오는 중이에요.</p>
      ) : null}
      {load.status === 'failed' ? (
        <div className={companyProfileStyles.settingRow}>
          <span className={companyProfileStyles.settingDescription} role="alert">이용량을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</span>
          <button className={workspacePageStyles.secondaryButton} type="button" onClick={onRetry}>다시 시도</button>
        </div>
      ) : null}
      {load.status === 'ready' ? (
        <ul className={companyProfileStyles.planUsageRows} aria-label="기능별 이용량">
          {load.usage.items.map((item) => <PlanUsageRow key={item.feature} item={item} />)}
        </ul>
      ) : null}
      <p className={companyProfileStyles.planNote}>결제는 아직 받지 않아요.</p>
    </section>
  )
}

/**
 * 기능 하나의 줄입니다. 진행 막대는 쓴 양을 한도 안에서만 채우고 화면 읽기 프로그램에는 "오늘 3/10회"처럼 읽힙니다.
 * 한도가 없으면 채울 기준이 없으므로 막대를 그리지 않습니다.
 */
function PlanUsageRow({ item }: { item: PlanUsageItem }) {
  const label = planUsageFeatureLabels[item.feature]
  const countText = planUsageCountText(item)
  const near = isNearPlanLimit(item)
  return (
    <li className={companyProfileStyles.planUsageRow}>
      <div className={companyProfileStyles.planUsageRowHead}>
        <span className={companyProfileStyles.accountValue}>{label}</span>
        <span className={near ? companyProfileStyles.planUsageCountWarning : companyProfileStyles.planUsageCount}>{countText}</span>
      </div>
      {hasPlanLimit(item) ? (
        <div
          className={companyProfileStyles.planUsageTrack}
          role="progressbar"
          aria-label={`${label} 이용량`}
          aria-valuenow={Math.min(item.used, item.limit)}
          aria-valuemin={0}
          aria-valuemax={item.limit}
          aria-valuetext={countText}
        >
          <div className={near ? companyProfileStyles.planUsageBarWarning : companyProfileStyles.planUsageBar} style={{ width: `${planUsagePercent(item)}%` }} />
        </div>
      ) : null}
      <span className={companyProfileStyles.planUsageReset}>{planUsageResetText(item)}</span>
    </li>
  )
}
