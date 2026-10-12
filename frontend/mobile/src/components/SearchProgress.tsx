import { useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import {
  formatSupportProgramSearchElapsed, supportProgramSearchElapsedSeconds, supportProgramSearchSteps, supportProgramSearchWaitNote,
} from '@govbiz/shared/domain/entities/SupportProgramSearchProgress'
import { colors, styles } from '../ui'

/**
 * AI 검색 대기 단계·지난 시간·안내입니다(웹과 같은 문구). 단계는 화면이 아는 사건으로만 넘기고, 서버가 하는 공고 찾기·
 * 자격 확인은 보통 걸리는 시간만 적습니다. 지난 시간은 매초 바뀌므로 읽어 주는 영역에 두지 않고 안내 문구만 알립니다.
 */
export function SearchProgress({ startedAt }: { startedAt: number | null }) {
  const elapsed = useElapsedSeconds(startedAt)
  const note = elapsed === null ? null : supportProgramSearchWaitNote(elapsed)
  return <View testID="ai-search-progress" style={local.box}>
    <View style={local.header}>
      <ActivityIndicator color={colors.primary} />
      <Text accessibilityLiveRegion="polite" style={local.title}>지원사업 검색 중</Text>
      {elapsed ? <Text style={local.elapsed}>{formatSupportProgramSearchElapsed(elapsed)} 지났어요</Text> : null}
    </View>
    <View accessibilityLabel="검색 단계" style={local.steps}>
      {supportProgramSearchSteps.map((step) => <View key={step.label} style={local.step}>
        <Text style={[styles.body, step.state === 'done' && { color: colors.primary, fontWeight: '600' }]}>
          {step.state === 'done' ? '✓ ' : '○ '}{step.label}</Text>
        <Text style={styles.muted}>{step.note}</Text>
      </View>)}
    </View>
    {note ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{note}</Text> : null}
  </View>
}

/** 검색을 보낸 시각부터 1초마다 지난 시간을 다시 셉니다. 시각을 모르면 null입니다. */
function useElapsedSeconds(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt === null ? null : supportProgramSearchElapsedSeconds(startedAt, now)
}

const local = StyleSheet.create({
  box: { gap: 10, paddingVertical: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { color: colors.text, fontSize: 15, lineHeight: 24, fontWeight: '600' },
  elapsed: { marginLeft: 'auto', color: colors.muted, fontSize: 13, lineHeight: 20, fontVariant: ['tabular-nums'] },
  steps: { gap: 4, paddingLeft: 2 },
  step: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
})
