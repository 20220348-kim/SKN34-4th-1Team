import { useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { reviewStages, type ReviewRun, type RunStatus } from '@govbiz/shared/domain/entities/CombinationReview'
import {
  reviewHeadline, reviewJudgmentLabels, reviewQuestions, reviewStageLabels, reviewVerdictLabels, reviewVerdictOf,
  type ReviewStage, type ReviewStageResult, type ReviewVerdict,
} from '@govbiz/shared/domain/entities/CombinationReviewResult'
import { Button, Card, Notice, StatusBadge, badgeColors, colors, styles, type BadgeTone } from '../ui'
import { ReviewEvidenceQuote, TextToggle } from './ReviewEvidenceQuote'

export const reviewRunLabels: Record<RunStatus, string> = { QUEUED: '분석 대기', RUNNING: '분석 중', SUCCEEDED: '분석 완료', FAILED: '분석 실패', INTERRUPTED: '분석 중단', UNKNOWN: '결과 확인 필요' }
const verdictTones: Record<ReviewVerdict, BadgeTone> = { warn: 'warning', info: 'info', ok: 'success' }
const verdictOrder: ReviewVerdict[] = ['warn', 'info', 'ok']
const dateFormatter = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
export const reviewTime = (value: string) => dateFormatter.format(new Date(value))
const statusTerms: Record<string, string> = { NOT_STARTED: '시작 전', IN_PROGRESS: '수행 중', COMPLETED: '완료', STOPPED: '중단', UNKNOWN: '미확인', YES: '예', NO: '아니오' }
const displayText = (text: string) => text.replace(/\b(?:NOT_STARTED|IN_PROGRESS|COMPLETED|STOPPED|UNKNOWN|YES|NO)\b/g, value => statusTerms[value] ?? value)

type Pair = NonNullable<ReviewRun['analysis']>['pairs'][number]
type Citation = ReviewStageResult['citations'][number]
const orderedStages = (pair: Pair) => [...pair.stages].sort((a, b) => reviewStages.indexOf(a.stage) - reviewStages.indexOf(b.stage))
const citationKey = (citation: Citation) => `${citation.evidenceId} ${citation.quote}`

/**
 * 실행 결과입니다. 결론(판정 조합으로 정한 문장 · 단계 색 띠) → 먼저 확인할 것 → 접힌 단계 줄 → 접힌 원문 · 판단 한계 순으로 둬요.
 * 주의(제한 · 충돌) 단계만 처음부터 펼치고, AI 요약 · 근거 원문 · 판단 한계는 눌러서 봐요. 웹 결과 화면과 같은 shared 규칙을 써요.
 */
export function ReviewResult({ run, currentRevision, names, onSupplement, onRefresh }: {
  run: ReviewRun; currentRevision: number; names: Record<string, string>; onSupplement(): void; onRefresh(): void
}) {
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [allQuestions, setAllQuestions] = useState(false)
  // 사용자가 누른 단계 줄만 기억해, 진행 중이던 실행이 끝나 판단이 생겨도 "주의 단계만 펼침" 규칙이 그대로 적용돼요.
  const [stageToggles, setStageToggles] = useState<Record<string, boolean>>({})
  const [sources, setSources] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const pairs = run.analysis?.pairs ?? []
  const allStages = pairs.flatMap(pair => pair.stages)
  const counts = verdictOrder.map(verdict => [verdict, allStages.filter(stage => reviewVerdictOf(stage.judgment) === verdict).length] as const).filter(([, count]) => count > 0)
  const headline = reviewHeadline(allStages, run.input.programs.map(program => program.participation))
  const questions = reviewQuestions(allStages)
  const shownQuestions = allQuestions ? questions.all : questions.priority
  const summary = displayText(run.analysis?.summary ?? '')
  const limitationCount = (run.evidence?.coverageWarnings.length ?? 0) + (run.analysis?.limitations.length ?? 0)
  // 같은 인용을 고른 단계들입니다. 근거마다 "○○ 단계에도 인용"으로 알려요.
  const citedStages = new Map<string, ReviewStage[]>()
  for (const stage of allStages) for (const citation of stage.citations) {
    const stages = citedStages.get(citationKey(citation)) ?? []
    if (!stages.includes(stage.stage)) citedStages.set(citationKey(citation), [...stages, stage.stage])
  }
  async function openSource(url: string) {
    setLinkError(null)
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid source')
      await Linking.openURL(url)
    } catch { setLinkError('공식 원문을 열지 못했어요. 다시 시도해 주세요.') }
  }
  return <View style={{ gap: 12 }}>
    <View style={styles.row}><StatusBadge label={reviewRunLabels[run.status]} tone={run.status === 'SUCCEEDED' ? 'success' : run.status === 'UNKNOWN' ? 'warning' : 'info'} />
      <Text style={styles.muted}>{reviewTime(run.startedAt)} 접수</Text></View>
    <Card><Text accessibilityRole="header" style={styles.heading}>이 실행의 비교 대상</Text><Text style={styles.label}>{run.input.title}</Text>
      {run.input.programs.map((program, index) => <View key={index} testID={`comparison-program-${index + 1}`} style={local.comparisonProgram}>
        <Text style={local.programNumber}>사업 {index + 1}</Text>
        <Text style={styles.body}>{names[`${program.sourceCode}:${program.sourceProgramId}`] ?? '공고명 확인 필요'}</Text>
      </View>)}
    </Card>
    {run.inputRevision !== currentRevision && <Notice>입력 변경 전의 결과예요. 현재 입력에 대한 결과가 아닙니다. 이전 결과는 이력에 보관돼요.</Notice>}
    {(run.status === 'QUEUED' || run.status === 'RUNNING') && <Card><Text style={styles.heading}>{run.status === 'QUEUED' ? '검토 요청이 접수됐어요' : '공식 자료 수집·분석 중이에요'}</Text>
      <Text style={styles.body}>다른 화면으로 이동해도 요청은 유지돼요. 새 분석을 요청하지 않아도 상태를 다시 확인할 수 있어요.</Text></Card>}
    {run.status === 'UNKNOWN' && <Notice error>분석 완료 여부를 확인하지 못했어요. 중복 과금을 막기 위해 새 분석을 잠시 막아 뒀어요. 30분 안에 실패로 정리되면 다시 분석할 수 있어요.</Notice>}
    {(run.status === 'FAILED' || run.status === 'INTERRUPTED') && <Notice error>분석을 완료하지 못했어요. 자료 수집·분석 실패는 허용이나 근거 부족 판단을 의미하지 않습니다.
      {run.failureCode?.startsWith('SOURCE_') ? ' 공식 원문 또는 첨부 자료를 확인해 주세요.' : run.failureCode === 'QUEUE_EXPIRED' ? ' 대기 시간 안에 분석이 시작되지 않았어요.' : run.failureCode === 'RUN_OUTCOME_UNKNOWN_EXPIRED' ? ' 완료 여부를 끝내 확인하지 못해 실패로 정리했어요. 필요하면 다시 분석해 주세요.' : ''}</Notice>}
    {run.analysis && <>
      <Card>
        <View style={styles.row}>
          {counts.map(([verdict, count]) => <StatusBadge key={verdict} label={`${reviewVerdictLabels[verdict]} ${count}`} tone={verdictTones[verdict]} />)}
          <Text style={[styles.muted, local.stageCount]}>{allStages.length}단계 판단</Text>
        </View>
        <Text accessibilityRole="header" style={styles.heading}>{headline.title}</Text>
        <Text style={styles.body}>{headline.reason}</Text>
        {pairs.map((pair, pairIndex) => <View key={pairIndex} style={local.band}>
          {pairs.length > 1 && <Text style={styles.muted}>사업 {pair.firstProgramIndex + 1} × 사업 {pair.secondProgramIndex + 1}</Text>}
          <View style={local.bandCells}>{orderedStages(pair).map(stage => {
            const verdict = reviewVerdictOf(stage.judgment)
            return <Text key={stage.stage} testID={`band-${pairIndex}-${stage.stage}`} accessibilityLabel={`${reviewStageLabels[stage.stage]} 단계 ${reviewVerdictLabels[verdict]}`}
              style={[local.bandCell, badgeColors(verdictTones[verdict])]}>{reviewStageLabels[stage.stage]}</Text>
          })}</View>
        </View>)}
        <Text style={styles.muted}>AI가 공식 원문을 읽은 결과이고 사람이 검수하지 않았어요. 제한을 못 찾은 것이 허용을 뜻하지는 않아요.</Text>
        {summary !== '' && <TextToggle label={summaryOpen ? '요약 접기 ▴' : '요약 더 보기 ▾'} expanded={summaryOpen} onPress={() => setSummaryOpen(!summaryOpen)} />}
        {summaryOpen && <Text style={[styles.body, local.summary]}>{summary}</Text>}
      </Card>
      <Card>
        <Text accessibilityRole="header" style={styles.heading}>먼저 확인할 것</Text>
        {questions.priority.length > 0 && <Text style={styles.muted}>단계마다 하나씩 · 답하면 판단이 바뀔 수 있어요</Text>}
        {shownQuestions.length > 0 ? shownQuestions.map(question => <View key={question.text} testID="review-question" style={local.question}>
          <StatusBadge label={reviewStageLabels[question.stage]} /><Text style={[styles.body, local.questionText]}>{displayText(question.text)}</Text>
        </View>) : <Text style={styles.muted}>현재 분석에서 추가로 확인할 질문은 없어요.</Text>}
        {questions.all.length > questions.priority.length && <TextToggle label={allQuestions ? '단계별 첫 질문만 보기 ▴' : `질문 ${questions.all.length}개 모두 보기 ▾`}
          expanded={allQuestions} onPress={() => setAllQuestions(!allQuestions)} />}
        <Button label="참여 상태 입력하고 다시 보기" variant="secondary" onPress={onSupplement} />
      </Card>
      <View style={local.section}>
        <View style={styles.row}><Text accessibilityRole="header" style={styles.heading}>단계별 판단</Text><Text style={styles.muted}>눌러서 펼쳐요</Text></View>
        {pairs.map((pair, pairIndex) => {
          const ordered = orderedStages(pair)
          const firstWarn = ordered.find(stage => reviewVerdictOf(stage.judgment) === 'warn')
          return <View key={pairIndex} style={local.section}>
            {pairs.length > 1 && <Text style={styles.label}>사업 {pair.firstProgramIndex + 1} × 사업 {pair.secondProgramIndex + 1}</Text>}
            <View style={local.stageList}>{ordered.map((stage, index) => {
              const id = `${pairIndex}:${stage.stage}`
              const open = stageToggles[id] ?? reviewVerdictOf(stage.judgment) === 'warn'
              return <StageRow key={id} testID={`stage-${pairIndex}-${stage.stage}`} divided={index > 0} run={run} stage={stage} open={open}
                onToggle={() => setStageToggles(current => ({ ...current, [id]: !open }))} citationsOpen={stage === firstWarn}
                citedStages={citedStages} onOpenSource={url => void openSource(url)} />
            })}</View>
          </View>
        })}
      </View>
    </>}
    {run.evidence && <Card>
      <Pressable accessibilityRole="button" accessibilityLabel={`공식 원문 ${run.evidence.documents.length}개 · 판단 한계 ${limitationCount}개`} accessibilityState={{ expanded: sources }}
        onPress={() => setSources(!sources)} style={local.foldHeader}>
        <Text style={[styles.label, local.foldTitle]}>공식 원문 {run.evidence.documents.length}개 · 판단 한계 {limitationCount}개</Text>
        <Text accessible={false} style={styles.muted}>{sources ? '⌃' : '⌄'}</Text>
      </Pressable>
      {sources && <>
        <Text style={styles.muted}>자동 수집 · 사람 미검수 · {run.input.asOfDate} 기준</Text>
        {run.evidence.documents.map((doc, index) => <View key={index} style={{ gap: 6 }}>
          <Text style={styles.body}>{doc.fileName}</Text><Text style={styles.muted}>사업 {doc.programIndex + 1} · {doc.format}</Text>
          <Button label="공식 공고·원문 열기" variant="secondary" onPress={() => void openSource(doc.sourcePageUrl ?? doc.sourceUrl)} /></View>)}
        {run.evidence.coverageWarnings.map((warning, index) => <Text style={styles.body} key={`warning-${index}`}>• {warning}</Text>)}
        {run.analysis?.limitations.map((text, index) => <Text style={styles.body} key={`limit-${index}`}>• {displayText(text)}</Text>)}
        <Text style={styles.body}>• 입력한 참여 상태 · 추가 설명과 자동 수집한 원문 범위 안에서만 판단했어요.</Text>
        <Text style={styles.body}>• 두 공고 사이의 제한만 봤어요. 과거 수혜 이력 누적 · 사업비 정산 규정은 이 검토 범위 밖이에요.</Text>
      </>}
    </Card>}
    {linkError && <Notice error>{linkError}</Notice>}
    <Button label="상태 다시 확인" variant="secondary" onPress={onRefresh} />
  </View>
}

/** 단계 하나의 접히는 줄입니다. 접혀 있어도 단계 · 판정 · 판단 범위 · 질문/근거 수는 보이고, 근거 원문은 펼친 줄 안에서 한 번 더 눌러 봐요. */
function StageRow({ testID, divided, run, stage, open, onToggle, citationsOpen, citedStages, onOpenSource }: {
  testID: string; divided: boolean; run: ReviewRun; stage: ReviewStageResult; open: boolean; onToggle(): void; citationsOpen: boolean
  citedStages: ReadonlyMap<string, readonly ReviewStage[]>; onOpenSource(url: string): void
}) {
  const [showCitations, setShowCitations] = useState(citationsOpen)
  const verdict = reviewVerdictOf(stage.judgment)
  const stageName = reviewStageLabels[stage.stage]
  const number = reviewStages.indexOf(stage.stage) + 1
  // 줄 머리는 여러 조각이라 그대로 읽으면 붙어서, 읽을 이름을 따로 둬요.
  const label = [`${number}단계 ${stageName} ${reviewVerdictLabels[verdict]}`, reviewJudgmentLabels[stage.judgment],
    ...(stage.requiresInstitutionConfirmation ? ['기관 확인 필요'] : []), `질문 ${stage.questions.length}개`, `근거 ${stage.citations.length}개`].join(' · ')
  return <View testID={testID} style={divided && local.divided}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }} onPress={onToggle} style={local.stageHeader}>
      <Text style={local.stageNumber}>{number}</Text>
      <View style={local.stageSummary}>
        <View style={local.stageTitle}>
          <Text style={styles.label}>{stageName}</Text>
          <Text testID={`verdict-${testID}`} style={[styles.badge, badgeColors(verdictTones[verdict])]}>{reviewVerdictLabels[verdict]}</Text>
          <Text style={styles.muted}>{reviewJudgmentLabels[stage.judgment]}</Text>
          {stage.requiresInstitutionConfirmation && <StatusBadge label="기관 확인 필요" />}
        </View>
        {stage.scope !== '' && <Text style={styles.muted} numberOfLines={open ? undefined : 1}>{displayText(stage.scope)}</Text>}
        <Text style={styles.muted}>질문 {stage.questions.length} · 근거 {stage.citations.length}</Text>
      </View>
      <Text accessible={false} style={styles.muted}>{open ? '⌃' : '⌄'}</Text>
    </Pressable>
    {open && <View style={local.stageBody}>
      <Text style={styles.body}>{displayText(stage.explanation)}</Text>
      {stage.questions.length > 0 && <View style={{ gap: 4 }}><Text style={styles.label}>확인 질문</Text>
        {stage.questions.map((question, index) => <Text key={index} style={styles.body}>• {displayText(question)}</Text>)}</View>}
      {stage.citations.length > 0 && <>
        <TextToggle label={`근거 원문 ${stage.citations.length}개 ${showCitations ? '접기 ▴' : '보기 ▾'}`} expanded={showCitations} onPress={() => setShowCitations(!showCitations)} />
        {showCitations && stage.citations.map((citation, index) => <ReviewEvidenceQuote key={index} number={index + 1} run={run} citation={citation}
          alsoIn={(citedStages.get(citationKey(citation)) ?? []).filter(other => other !== stage.stage)} onOpenSource={onOpenSource} />)}
      </>}
    </View>}
  </View>
}

const local = StyleSheet.create({
  comparisonProgram: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, gap: 7 },
  programNumber: { color: colors.primaryText, fontSize: 13, fontWeight: '600' },
  stageCount: { marginLeft: 'auto' },
  band: { gap: 6 },
  bandCells: { flexDirection: 'row', gap: 4 },
  bandCell: { flex: 1, minWidth: 0, borderRadius: 8, overflow: 'hidden', paddingVertical: 8, textAlign: 'center', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  summary: { backgroundColor: colors.divider, borderRadius: 12, padding: 12, overflow: 'hidden' },
  question: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  questionText: { flex: 1 },
  section: { gap: 10 },
  stageList: { backgroundColor: colors.surface, borderRadius: 16, overflow: 'hidden' },
  divided: { borderTopWidth: 1, borderTopColor: colors.border },
  stageHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 44, paddingHorizontal: 16, paddingVertical: 12 },
  stageNumber: { width: 24, height: 24, marginTop: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.divider, color: colors.muted, fontSize: 12, lineHeight: 24, fontWeight: '700', textAlign: 'center' },
  stageSummary: { flex: 1, gap: 3 },
  stageTitle: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  stageBody: { gap: 8, paddingHorizontal: 16, paddingBottom: 16 },
  foldHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  foldTitle: { flex: 1 },
})
