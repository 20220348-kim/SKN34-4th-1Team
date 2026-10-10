import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import {
  findPlanUsageItem, hasPlanLimit, planEndsText, isNearPlanLimit, isPlanLimitReached, planNameText, planQuotaExceededMessage,
  planUsageCountText, planUsageFeatureLabels, planUsageResetText, planUsageUsedText,
  type PlanCode, type PlanUsage, type PlanUsageFeature, type PlanUsageItem, type PlanUsagePeriod,
} from '@govbiz/shared/domain/entities/PlanUsage'
import { planUsageUseCase } from '../api/planUsage'
import { Button, Card, colors, styles } from '../ui'
import { useAppForeground } from './useAppForeground'

/**
 * 요금제 이용량을 읽습니다. token이 없으면 로그인 전 체험 이용량입니다. enabled가 켜질 때, 켜진 채 앱이 다시 앞으로 올 때,
 * reload를 부를 때 새로 읽습니다. 다른 계정에서 읽은 값은 돌려주지 않고, 읽지 못하면 usage 없이 failed입니다.
 */
export function usePlanUsage(token: string | undefined, enabled: boolean) {
  const foreground = useAppForeground()
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{ token: string | undefined; usage: PlanUsage | null } | null>(null)
  useEffect(() => {
    if (!enabled || !foreground) return
    const controller = new AbortController()
    planUsageUseCase(token).usage(controller.signal)
      .then(usage => { if (!controller.signal.aborted) setResult({ token, usage }) })
      .catch(() => { if (!controller.signal.aborted) setResult({ token, usage: null }) })
    return () => controller.abort()
  }, [enabled, foreground, token, revision])
  const reload = useCallback(() => setRevision(value => value + 1), [])
  const current = result?.token === token ? result : null
  return { usage: current?.usage ?? null, failed: current?.usage === null, reload }
}

/**
 * 한 기능의 이용량 한 줄입니다. 한도의 80%부터 주의 색으로 다시 채워지는 때를, 다 쓰면 한도 안내를 보여 줍니다.
 * 아직 한도를 정하지 않은 요금제는 그리지 않습니다.
 */
export function PlanUsageLine({ item, plan }: { item: PlanUsageItem; plan: PlanCode | null }) {
  if (!hasPlanLimit(item)) return null
  const reached = isPlanLimitReached(item)
  const near = isNearPlanLimit(item)
  // 로그인 전에는 AI 대화 검색 체험만 셉니다.
  const count = `${plan === null ? '로그인 전 체험' : planUsageFeatureLabels[item.feature]} ${planUsageCountText(item)}`
  // 평소 횟수는 조용히 바꾸고, 주의·한도 안내로 바뀔 때만 화면 낭독기가 읽게 합니다.
  return <Text accessibilityLiveRegion={reached || near ? 'polite' : 'none'} style={[local.line, (reached || near) && local.warning]}>
    {reached ? planQuotaExceededMessage({ ...item, plan }) : near ? `${count} · ${planUsageResetText(item)}` : count}
  </Text>
}

/**
 * 신청 문서·중복 검토처럼 기능 하나를 쓰는 버튼 가까이에 두는 이용량 한 줄입니다. 화면이 열려 있는 동안 읽고,
 * revision이 바뀌면(예: 생성·실행 요청이 끝남) 다시 읽습니다. 한도가 없거나 읽지 못하면 그리지 않습니다.
 */
export function FeatureUsageLine({ token, feature, revision }: { token: string; feature: PlanUsageFeature; revision?: unknown }) {
  const { usage, reload } = usePlanUsage(token, true)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    reload()
  }, [revision, reload])
  const item = findPlanUsageItem(usage, feature)
  return usage && item ? <PlanUsageLine item={item} plan={usage.plan} /> : null
}

const periodGroups: readonly { period: PlanUsagePeriod; title: string }[] = [
  { period: 'DAY', title: '오늘' },
  { period: 'MONTH', title: '이번 달' },
  { period: 'PLAN', title: '이번 기간' },
]

/**
 * 내 계정의 요금제와 기능별 이용량입니다. 앱에서는 지금 요금제와 체험·이용권이 끝나는 날만 보여 주고
 * 결제·요금제 바꾸기·체험 시작 동작은 두지 않습니다(App Store 3.1.3). 무엇을 한 번으로 세는지는 요금제 탭에 둡니다.
 * 같은 때 다시 채워지는 기능끼리(오늘 · 이번 달 · 유료 이용권의 이번 기간) 묶어 그때를 한 번만 적습니다.
 */
export function PlanUsageSection({ token }: { token: string }) {
  const { usage, failed, reload } = usePlanUsage(token, true)
  if (!usage && !failed) return null
  const endsText = planEndsText(usage)
  const planName = usage ? planNameText(usage) : null
  return <Card>
    <Text accessibilityRole="header" style={styles.heading}>요금제와 이용량</Text>
    {usage ? <>
      {planName && <View style={local.plan}><Text style={styles.muted}>현재 요금제</Text><Text style={styles.label}>{planName}</Text></View>}
      {endsText && <Text style={styles.muted}>{endsText}</Text>}
      {periodGroups.map(({ period, title }) => {
        const items = usage.items.filter(item => item.period === period)
        if (!items.length) return null
        return <View key={period} style={local.group}>
          <View style={local.groupHeader}>
            <Text style={[styles.label, local.groupTitle]}>{title}</Text>
            <Text style={styles.muted}>{planUsageResetText(items[0]!)}</Text>
          </View>
          {items.map(item => <PlanUsageRow key={item.feature} item={item} />)}
        </View>
      })}
      <Text style={styles.muted}>결제는 아직 받지 않아요.</Text>
    </> : <>
      <Text style={styles.muted}>이용량을 불러오지 못했어요.</Text>
      <Button label="이용량 다시 불러오기" variant="secondary" size="small" onPress={reload} />
    </>}
  </Card>
}

/** 기능 하나의 줄입니다. 오른쪽에 남은 양, 막대 아래에 한도 중 쓴 양을 적습니다. 한도가 없으면 막대 없이 "제한 없음"으로 적습니다. */
function PlanUsageRow({ item }: { item: PlanUsageItem }) {
  const label = planUsageFeatureLabels[item.feature]
  const warning = isPlanLimitReached(item) || isNearPlanLimit(item)
  const usedText = planUsageUsedText(item)
  return <View style={local.row}>
    <View style={local.rowHeader}>
      <Text style={[styles.body, local.rowLabel]}>{label}</Text>
      <Text style={[styles.label, warning && local.warning]}>{planUsageCountText(item)}</Text>
    </View>
    {hasPlanLimit(item) && <View accessible accessibilityRole="progressbar" accessibilityLabel={`${label} 이용량`}
      accessibilityValue={{ min: 0, max: item.limit, now: Math.min(item.used, item.limit), text: usedText ?? undefined }} style={local.track}>
      <View style={[local.bar, { width: `${item.limit > 0 ? Math.min(item.used, item.limit) / item.limit * 100 : 100}%` }, warning && local.warningBar]} />
    </View>}
    {usedText && <Text style={styles.muted}>{usedText}</Text>}
  </View>
}


const local = StyleSheet.create({
  line: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  warning: { color: colors.warning },
  plan: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  group: { gap: 6 },
  groupHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, paddingTop: 6 },
  groupTitle: { color: colors.muted },
  row: { gap: 6, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowLabel: { flex: 1 },
  track: { height: 6, borderRadius: 99, backgroundColor: colors.track, overflow: 'hidden' },
  bar: { height: 6, borderRadius: 99, backgroundColor: colors.primary },
  warningBar: { backgroundColor: colors.warning },
})
