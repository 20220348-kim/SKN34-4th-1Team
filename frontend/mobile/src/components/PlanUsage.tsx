import { useCallback, useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { planLabels, type PlanUsage } from '@govbiz/shared/domain/entities/PlanUsage'
import { planUsageUseCase } from '../api/planUsage'
import { Card, styles } from '../ui'
import { useAppForeground } from './useAppForeground'

/**
 * 현재 요금제를 읽습니다. token이 없으면 로그인 전이라 요금제가 없습니다. enabled가 켜질 때, 켜진 채 앱이 다시 앞으로 올 때,
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

/** 내 계정의 현재 요금제 한 줄입니다. 앱에서는 현재 상태만 보여 주고 결제나 요금제 변경 안내는 두지 않습니다. 읽지 못하면 보이지 않습니다. */
export function PlanUsageSection({ token }: { token: string }) {
  const { usage } = usePlanUsage(token, true)
  if (!usage?.plan) return null
  return <Card>
    <View style={local.plan}><Text style={styles.muted}>현재 요금제</Text><Text style={styles.label}>{planLabels[usage.plan]}</Text></View>
  </Card>
}

const local = StyleSheet.create({
  plan: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
})
