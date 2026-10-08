import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import {
  evidenceFormatOf, evidenceHasContext, evidenceLocatorLabel, evidencePreview, evidenceQuoteCut, evidenceQuoteRange, formatEvidenceText, isApplicationFormText,
  splitEvidenceKeywords, type EvidenceLine,
} from '@govbiz/shared/domain/entities/CombinationReviewEvidence'
import { reviewStageLabels, type ReviewStage, type ReviewStageResult } from '@govbiz/shared/domain/entities/CombinationReviewResult'
import type { ReviewRun } from '@govbiz/shared/domain/entities/CombinationReview'
import { Button, StatusBadge, colors, styles } from '../ui'

type Citation = ReviewStageResult['citations'][number]

/** 글자만 있는 작은 버튼입니다. 중복 검토 결과의 펼치기 · 보기 전환에 써요. */
export function TextToggle({ label, onPress, expanded, selected }: { label: string; onPress(): void; expanded?: boolean; selected?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ expanded, selected }} hitSlop={4} onPress={onPress} style={local.toggle}>
    <Text style={local.toggleText}>{label}</Text>
  </Pressable>
}

/**
 * 근거 원문 하나입니다. 저장된 인용문을 shared 규칙으로 정리해 중복 · 제한 낱말이 든 줄과 그 앞뒤 · 상위 항목만 먼저 보여 줘요.
 * 인용이 줄 중간에서 잘렸으면 생략 표시와 [이 부분 전체 보기](원문 조각 전체)를, 온전한 줄 단위 인용인데 조각에 앞뒤 줄이 더 있으면
 * [앞뒤 원문 보기](조각 전체, 인용한 줄은 표시)를, 그 밖에는 접힌 줄이 있을 때 [전체 n줄 보기]를 둬요.
 * [원문 그대로]는 저장된 인용을 줄바꿈까지 그대로 보여 줘요.
 * 파일 이름이 길면 출처 줄의 가운데를 줄여 사업 번호와 확장자 · 위치가 보이게 해요.
 */
export function ReviewEvidenceQuote({ number, run, citation, alsoIn, onOpenSource }: {
  number: number; run: ReviewRun; citation: Citation; alsoIn: readonly ReviewStage[]; onOpenSource(url: string): void
}) {
  const [view, setView] = useState<'preview' | 'full' | 'raw'>('preview')
  const block = run.evidence?.blocks.find(item => item.id === citation.evidenceId)
  const document = run.evidence?.documents.find(item => item.rawHash === block?.documentHash && item.programIndex === block?.programIndex)
  const format = evidenceFormatOf(block?.locator ?? '', document)
  const locator = block ? evidenceLocatorLabel(block.locator) : ''
  const lines = formatEvidenceText(citation.quote, format)
  const preview = evidencePreview(lines)
  const cut = block ? evidenceQuoteCut(block.text, citation.quote) : { start: false, end: false }
  const cutAny = cut.start || cut.end
  // 잘리지 않은 줄 단위 인용도 원문 조각에 앞뒤 줄이 더 있으면 조각 전체를 펼쳐 볼 수 있어요.
  const hasContext = !cutAny && block !== undefined && evidenceHasContext(block.text, citation.quote)
  const showsBlock = cutAny || hasContext
  const canExpand = showsBlock || preview.some(entry => entry.type === 'gap')
  const expandLabel = cutAny ? '이 부분 전체 보기 ▾' : hasContext ? '앞뒤 원문 보기 ▾' : `전체 ${lines.length}줄 보기 ▾`
  // 펼친 보기는 원문 조각 전체(앞뒤 원문이면 인용한 줄을 따로 표시) 또는 인용 전체를 정리한 줄이에요.
  const full = view === 'full' && showsBlock && block ? formatEvidenceText(block.text, format) : lines
  const quoted = view === 'full' && hasContext ? evidenceQuoteRange(full, lines) : null
  const fullLines = (from: number, to?: number) => full.slice(from, to).map((line, index) => <EvidenceLineView key={from + index} line={line} />)
  const source = [`사업 ${(block?.programIndex ?? 0) + 1}`, ...(document ? [document.fileName] : []), ...(locator ? [locator] : [])].join(' · ')
  const tags = [
    ...(isApplicationFormText(citation.quote) ? ['신청서 서식'] : []),
    ...(alsoIn.length > 3 ? [`다른 ${alsoIn.length}개 단계에도 인용`] : alsoIn.length > 0 ? [`${alsoIn.map(stage => reviewStageLabels[stage]).join('·')} 단계에도 인용`] : []),
  ]
  return <View style={local.card}>
    <View style={local.header}>
      <Text style={local.number}>근거 {number}</Text>
      <Text style={[styles.muted, local.source]} numberOfLines={1} ellipsizeMode="middle">{source}</Text>
    </View>
    {tags.length > 0 && <View style={local.tags}>{tags.map(tag => <StatusBadge key={tag} label={tag} />)}</View>}
    <View style={local.quote}>
      {view === 'raw' ? <Text style={local.text}>{citation.quote}</Text> : <>
        {view === 'full' && showsBlock && <Text style={local.note}>인용 앞뒤를 포함한 {locator || '원문 조각'} 전체예요.</Text>}
        {view === 'preview' && cut.start && <Text style={local.note}>… 앞 내용 생략</Text>}
        {view === 'full'
          ? quoted
            ? <>
              {fullLines(0, quoted.start)}
              <View testID="evidence-quoted-lines" style={local.quoted}>{fullLines(quoted.start, quoted.end)}</View>
              {fullLines(quoted.end)}
            </>
            : fullLines(0)
          : preview.map((entry, index) => entry.type === 'gap'
            ? <Text key={index} style={[local.note, local.gap]}>⋯ {entry.count}줄 접힘</Text>
            : <EvidenceLineView key={index} line={entry.line} />)}
        {view === 'preview' && cut.end && <Text style={local.note}>뒤로 이어짐 …</Text>}
      </>}
    </View>
    <View style={local.actions}>
      {canExpand && view !== 'raw' && <TextToggle label={view === 'full' ? '간단히 보기 ▴' : expandLabel}
        expanded={view === 'full'} onPress={() => setView(view === 'full' ? 'preview' : 'full')} />}
      <TextToggle label="원문 그대로" selected={view === 'raw'} onPress={() => setView(view === 'raw' ? 'preview' : 'raw')} />
    </View>
    {document && <Button label="공식 원문 확인" variant="secondary" size="small" onPress={() => onOpenSource(document.sourcePageUrl ?? document.sourceUrl)} />}
  </View>
}

/** 정리한 한 줄입니다. 글머리 단계만큼 들여 쓰고, 주석은 작게, 표 묶음은 "표" 표시를 붙여요. 관련 줄로 판정된 줄만 낱말을 강조해요. */
function EvidenceLineView({ line }: { line: EvidenceLine }) {
  const text = line.related
    ? splitEvidenceKeywords(line.text).map((part, index) => part.keyword ? <Text key={index} testID="evidence-keyword" style={local.keyword}>{part.text}</Text> : part.text)
    : line.text
  if (line.kind === 'heading') return <Text style={[local.text, local.heading]}>{text}</Text>
  const indent = line.kind === 'note' || (line.kind === 'item' && line.level === 3) ? 28 : line.kind === 'item' && line.level === 2 ? 14 : 0
  return <View style={[local.line, { paddingLeft: indent }]}>
    {line.kind === 'table' ? <Text style={local.table}>표</Text> : <Text style={local.marker}>{line.marker}</Text>}
    <Text style={[local.text, local.lineBody, line.kind === 'note' && local.noteText]}>{text}</Text>
  </View>
}

const local = StyleSheet.create({
  toggle: { minHeight: 36, justifyContent: 'center', alignSelf: 'flex-start' },
  toggleText: { color: colors.primary, fontSize: 13, lineHeight: 20, fontWeight: '700' },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  number: { color: colors.primary, fontSize: 13, lineHeight: 20, fontWeight: '700' },
  source: { flex: 1 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.fieldBorder, paddingLeft: 10, gap: 2 },
  // [앞뒤 원문 보기]에서 인용한 줄 묶음이에요. 왼쪽 막대와 옅은 바탕으로 구분하고, 글 위치는 다른 줄과 맞춰요.
  quoted: { marginLeft: -6, paddingLeft: 4, paddingRight: 6, paddingVertical: 2, borderLeftWidth: 2, borderLeftColor: colors.primary, borderRadius: 6, backgroundColor: colors.soft, gap: 2 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 22 },
  gap: { paddingLeft: 24 },
  line: { flexDirection: 'row', gap: 4 },
  marker: { width: 20, textAlign: 'center', color: colors.muted, fontSize: 13, lineHeight: 22 },
  table: { width: 20, height: 16, marginTop: 3, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.divider, color: colors.muted, fontSize: 10, lineHeight: 16, fontWeight: '700', textAlign: 'center' },
  text: { color: colors.text, fontSize: 13, lineHeight: 22 },
  lineBody: { flex: 1 },
  heading: { fontWeight: '700' },
  noteText: { color: colors.muted, fontSize: 12 },
  keyword: { backgroundColor: colors.warningSoft, color: colors.warning, fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 16 },
})
