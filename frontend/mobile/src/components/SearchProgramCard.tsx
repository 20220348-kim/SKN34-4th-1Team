import { useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import type { SupportProgram } from '@govbiz/shared/domain/entities/SupportProgram'
import { daysUntil, formatDday, programStatusLabels } from '@govbiz/shared/domain/labels'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { nationwideRegion, regionNames, toRegionName } from '@govbiz/shared/domain/entities/Region'
import { Button, Notice, badgeColors, colors, ddayBadgeTone } from '../ui'
import { ProgramInterestButton, type SearchProgramInterests } from './SearchProgramInterests'
import { AppIcon } from './AppIcon'

export function SearchProgramCard({ program, onOpen, interests, onLogin, searchRegion }: { program: SupportProgram; onOpen?(identity: SupportProgramIdentity): void
  searchRegion?: string | null
  interests?: SearchProgramInterests; onLogin?(): void }) {
  const [linkError, setLinkError] = useState<string | null>(null)
  const review = program.eligibilityReview
  const deadline = daysUntil(program.applicationEndDate)
  const statusColor = program.status === 'OPEN' ? colors.primaryText : program.status === 'UPCOMING' ? colors.info : colors.muted
  const quotes = [...new Set([...(review?.target.evidence ?? []), ...(review?.region.evidence ?? [])].map(item => item.quote))]
  const requestedRegion = searchRegion ? toRegionName(searchRegion.trim().split(/\s+/)[0]!) : null
  const regions = program.regions.map(toRegionName)
  const otherRegion = requestedRegion !== null && requestedRegion !== nationwideRegion
    && regionNames.some(value => value === requestedRegion) && regions.length > 0
    && regions.every(value => regionNames.some(known => known === value) && value !== nationwideRegion && value !== requestedRegion)
  async function openSource() {
    setLinkError(null)
    try { await Linking.openURL(program.sourceUrl) }
    catch { setLinkError('공식 원문을 열지 못했습니다. 다시 시도해 주세요.') }
  }
  return <View style={[local.card, !onOpen && { padding: 12, gap: 7 }]}>
    <View style={local.meta}><View testID="program-status-dot" style={[local.dot, { backgroundColor: statusColor }]} />
      <Text style={[local.status, { color: statusColor }]}>{programStatusLabels[program.status]}</Text>
      {deadline !== null && <Text style={[local.deadline, badgeColors(ddayBadgeTone(deadline))]}>
        {formatDday(deadline)}</Text>}
      {program.recommendationScore !== null && <Text style={local.score}>관련도 {program.recommendationScore}</Text>}</View>
    <View style={local.titleRow}><Text style={[local.title, { flex: 1 }, !onOpen && { fontSize: 14, lineHeight: 21 }]}>{program.title}</Text>
      {onOpen && interests && onLogin && <ProgramInterestButton identity={{ sourceCode: program.sourceCode, sourceProgramId: program.id }} title={program.title} interests={interests} onLogin={onLogin} showError={false} />}
    </View>
    {interests?.errors[JSON.stringify([program.sourceCode, program.id])] && <Notice error>{interests.errors[JSON.stringify([program.sourceCode, program.id])]}</Notice>}
    {onOpen && <Text style={local.description}>{[program.organization, ...program.regions].filter(Boolean).join(' · ')}</Text>}
    {onOpen && <Text style={local.description}>{program.applicationPeriod}</Text>}
    {onOpen && otherRegion && <Notice>다른 지역 조건 확인 필요{'\n'}검색 지역({requestedRegion})과 공고 분류 지역({program.regions.join(' · ')})이 달라요. 분류만으로 신청 가능 여부를 판단하지 말고 원문의 지역 조건을 확인해 주세요.</Notice>}
    {onOpen && review?.region.status === 'UNKNOWN' && <Text style={local.evidence}>지역 조건 확인 · {review.region.explanation}</Text>}
    <View style={[local.quote, !onOpen && { padding: 8, gap: 6 }]}>
      <Text style={[local.badge, review && review.status !== 'MATCH' ? { backgroundColor: colors.warningSoft, color: colors.warning }
        : !review && { backgroundColor: colors.divider, color: colors.secondaryText }]}>
        {review?.status === 'MATCH' ? onOpen ? '조건 확인 · API 본문 기준' : '조건 확인' : review ? '확인 필요' : '자격 미평가'}</Text>
      {quotes.length > 0 ? (onOpen ? quotes : quotes.slice(0, 1)).map(quote => <Text selectable key={quote} style={[local.evidence, !onOpen && { fontSize: 12, lineHeight: 19 }]}>{quote}</Text>)
        : <Text style={local.evidence}>확인 가능한 본문 인용이 제공되지 않았습니다.</Text>}
    </View>
    {onOpen && <>
      <View style={local.actions}>
        <Pressable accessibilityRole="link" accessibilityLabel={program.sourceCode === 'CNTRADE_NOTICE' ? '공식 공지 목록 보러가기' : '원문 보러가기'}
          onPress={() => void openSource()} style={({ pressed }) => [local.sourceLink, pressed && { opacity: 0.9 }]}>
          <Text style={local.sourceLabel}>{program.sourceCode === 'CNTRADE_NOTICE' ? '공식 공지 목록 보러가기' : '원문 보러가기'}</Text>
          <AppIcon name="externalLink" color={colors.primaryText} size={15} />
        </Pressable>
        <Button label="상세 보기" accessibilityLabel={`${program.title}, 상세 보기`} variant="secondary"
          onPress={() => onOpen({ sourceCode: program.sourceCode, sourceProgramId: program.id })} /></View>
      {linkError && <Notice error>{linkError}</Notice>}
      <Text style={local.disclaimer}>관련도는 추천 순서용 점수예요. 최종 신청 조건은 원문에서 확인하세요.</Text>
    </>}
  </View>
}

const local = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 18, padding: 16, gap: 10 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  deadline: { fontSize: 12, lineHeight: 18, fontWeight: '600', backgroundColor: colors.divider, color: colors.secondaryText,
    borderRadius: 6, overflow: 'hidden', paddingHorizontal: 7, paddingVertical: 3 },
  status: { color: colors.primaryText, fontSize: 13, lineHeight: 20, fontWeight: '600' },
  score: { marginLeft: 'auto', color: colors.primaryText, fontSize: 13, lineHeight: 20, fontWeight: '600' },
  title: { color: colors.text, fontSize: 17, lineHeight: 25, fontWeight: '600' },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  description: { color: colors.secondaryText, fontSize: 13, lineHeight: 20 },
  quote: { backgroundColor: colors.background, borderRadius: 12, padding: 12, gap: 8 },
  badge: { alignSelf: 'flex-start', overflow: 'hidden', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3,
    color: colors.primaryText, backgroundColor: colors.soft, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  evidence: { color: colors.secondaryText, fontSize: 13, lineHeight: 21 },
  actions: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' },
  sourceLink: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, flexShrink: 1 },
  sourceLabel: { color: colors.primaryText, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  disclaimer: { color: colors.muted, fontSize: 12, lineHeight: 19 },
})
