import {
  hasPlanLimit,
  isNearPlanLimit,
  isPlanLimitReached,
  planEndsText,
  planLabels,
  planUsageCountingRules,
  planUsageCountText,
  planUsageDeletionNote,
  planUsageFeatureLabels,
  planUsageResetText,
  planUsageUsedText,
  type PlanUsageItem,
  type PlanUsagePeriod,
} from '@govbiz/shared/domain/entities/PlanUsage'
import { planUsagePercent } from '../../../shared/plan-usage/planUsageView'
import type { PlanUsageLoad } from '../../../shared/plan-usage/usePlanUsage'
import { HelpTip } from '../../../shared/workspace/HelpTip'
import { workspacePageStyles, workspaceTagClassName } from '../../../shared/workspace/WorkspacePage.styles'
import { companyProfileStyles } from './CompanyProfilePage.styles'

const periodGroups: readonly { period: PlanUsagePeriod; title: string }[] = [
  { period: 'DAY', title: '오늘' },
  { period: 'MONTH', title: '이번 달' },
  { period: 'PLAN', title: '이번 기간' },
]

/**
 * 프로필의 요금제와 이용량 카드입니다. 지금 요금제와 기능별로 이번 기간에 남은 양을 보여 줍니다.
 * 같은 때 다시 채워지는 기능끼리(오늘 · 이번 달 · 유료 이용권의 이번 기간) 묶어 그때를 한 번만 적고, 무엇을 한 번으로 세는지는 제목 옆 ? 도움말에 둡니다.
 * 유료 이용권이면 언제까지 쓸 수 있는지 함께 적습니다.
 * 아직 한도를 정하지 않은 기능은 막대 없이 "제한 없음"으로 적습니다. 결제는 아직 없으므로 요금제를 바꾸는 동작은 두지 않습니다.
 */
export function PlanUsageSection({ load, onRetry }: { load: PlanUsageLoad; onRetry: () => void }) {
  const plan = load.status === 'ready' ? load.usage.plan : null
  const endsText = load.status === 'ready' ? planEndsText(load.usage) : null
  return (
    <section className={workspacePageStyles.card} aria-label="요금제와 이용량">
      <div className={workspacePageStyles.cardHeader}>
        <span className={companyProfileStyles.planTitleRow}>
          <h2 className={workspacePageStyles.cardTitle}>요금제와 이용량</h2>
          <CountingHelp />
        </span>
        {plan !== null ? <span className={workspaceTagClassName('ok')}>{planLabels[plan]}</span> : null}
      </div>
      {endsText ? <p className={companyProfileStyles.planNote}>{endsText}</p> : null}
      {load.status === 'loading' ? (
        <p className={workspacePageStyles.emptyNote} aria-live="polite">이용량을 불러오는 중이에요.</p>
      ) : null}
      {load.status === 'failed' ? (
        <div className={companyProfileStyles.settingRow}>
          <span className={companyProfileStyles.settingDescription} role="alert">이용량을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</span>
          <button className={workspacePageStyles.secondaryButton} type="button" onClick={onRetry}>다시 시도</button>
        </div>
      ) : null}
      {load.status === 'ready' ? periodGroups.map(({ period, title }) => {
        const items = load.usage.items.filter((item) => item.period === period)
        if (items.length === 0) return null
        return (
          <section className={companyProfileStyles.planUsageGroup} key={period} aria-label={`${title} 이용량`}>
            <div className={companyProfileStyles.planUsageGroupHead}>
              <span className={companyProfileStyles.planUsageGroupTitle}>{title}</span>
              <span className={companyProfileStyles.planUsageReset}>{planUsageResetText(items[0]!)}</span>
            </div>
            <ul className={companyProfileStyles.planUsageRows} aria-label={`${title} 기능별 이용량`}>
              {items.map((item) => <PlanUsageRow key={item.feature} item={item} />)}
            </ul>
          </section>
        )
      }) : null}
      <p className={companyProfileStyles.planNote}>결제는 아직 받지 않아요.</p>
    </section>
  )
}

/** 기능마다 무엇을 한 번으로 세는지 알려 줍니다. 대화만 해도 줄어드는지, 지우면 돌아오는지를 미리 알 수 있게 합니다. */
function CountingHelp() {
  return (
    <HelpTip label="이용량을 세는 기준 도움말" title="이용량을 세는 기준">
      <ul className={companyProfileStyles.planHelpList}>
        {(Object.keys(planUsageCountingRules) as (keyof typeof planUsageCountingRules)[]).map((feature) => (
          <li key={feature}><strong>{planUsageFeatureLabels[feature]}</strong> {planUsageCountingRules[feature]}</li>
        ))}
      </ul>
      <p className="m-0">{planUsageDeletionNote}</p>
    </HelpTip>
  )
}

/**
 * 기능 하나의 줄입니다. 오른쪽에 남은 양을, 막대 아래에 한도 중 쓴 양을 적습니다. 화면 읽기 프로그램에는 막대가 "10회 중 3회 썼어요"로 읽힙니다.
 * 한도가 없으면 채울 기준이 없으므로 막대 없이 쓴 양과 "제한 없음"만 적습니다.
 */
function PlanUsageRow({ item }: { item: PlanUsageItem }) {
  const label = planUsageFeatureLabels[item.feature]
  const countText = planUsageCountText(item)
  const usedText = planUsageUsedText(item)
  const warn = isNearPlanLimit(item) || isPlanLimitReached(item)
  return (
    <li className={companyProfileStyles.planUsageRow}>
      <div className={companyProfileStyles.planUsageRowHead}>
        <span className={companyProfileStyles.accountValue}>{label}</span>
        <span className={warn ? companyProfileStyles.planUsageCountWarning : companyProfileStyles.planUsageCount}>{countText}</span>
      </div>
      {hasPlanLimit(item) ? (
        <div
          className={companyProfileStyles.planUsageTrack}
          role="progressbar"
          aria-label={`${label} 이용량`}
          aria-valuenow={Math.min(item.used, item.limit)}
          aria-valuemin={0}
          aria-valuemax={item.limit}
          aria-valuetext={usedText ?? countText}
        >
          <div className={warn ? companyProfileStyles.planUsageBarWarning : companyProfileStyles.planUsageBar} style={{ width: `${planUsagePercent(item)}%` }} />
        </div>
      ) : null}
      {usedText ? <span className={companyProfileStyles.planUsageReset}>{usedText}</span> : null}
    </li>
  )
}
