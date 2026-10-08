import { useState, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import {
  reviewAnswerHeadline, reviewAnswerToneOf, reviewAnswerVerdictLabels, reviewConsequenceMomentLabels, reviewQuestionLabels, reviewQuestionShortLabels,
  type ReviewAnswerTone,
} from '@govbiz/shared/domain/entities/CombinationReviewResult'
import type { ReviewAnswer, ReviewCitation, ReviewQuestionKind, ReviewRun } from '@govbiz/shared/domain/entities/CombinationReview'
import { badgeColors, colors, styles, type BadgeTone } from '../ui'
import { ReviewEvidenceQuote, TextToggle } from './ReviewEvidenceQuote'
import { citationKey, displayReviewText } from './reviewText'

/** 판정 칩 색이에요: 불가 · 조건부 · 기관 확인 · 규정 없음(허용 아님) · 가능. 색 단계는 웹과 같은 shared 규칙을 써요. */
const toneBadges: Record<ReviewAnswerTone, BadgeTone> = { warn: 'danger', conditional: 'warning', ask: 'info', neutral: 'neutral', ok: 'success' }
const conditionResults = { ALLOWED: { label: '가능', tone: 'success' }, NOT_ALLOWED: { label: '불가', tone: 'danger' } } as const

/**
 * 세 질문 방식(v3)의 결과예요. 결론 카드(질문별 판정 칩 · 판정 조합으로 정한 결론 문장 · "찾지 못함 ≠ 허용" · 접힌 AI 요약) →
 * 질문 카드 3장(판정 칩 · 설명 · 조건 → 결과 칩 · 기관에 물어볼 것 · 근거 원문 · 걸리면 생기는 일) → 내 상황으로 좁히기 순으로 둬요. 웹 결과와 같은 순서예요.
 */
export function ReviewAnswerResult({ run, answers, summary, narrowing, onOpenSource }: {
  run: ReviewRun; answers: readonly ReviewAnswer[]; summary: string; narrowing?: ReactNode; onOpenSource(url: string): void
}) {
  const [summaryOpen, setSummaryOpen] = useState(false)
  const headline = reviewAnswerHeadline(answers)
  // 같은 인용을 고른 질문들이에요. 근거마다 "○○ 질문에도 인용"으로 알려요.
  const citedQuestions = new Map<string, ReviewQuestionKind[]>()
  for (const answer of answers) for (const citation of citationsOf(answer)) {
    const questions = citedQuestions.get(citationKey(citation)) ?? []
    if (!questions.includes(answer.question)) citedQuestions.set(citationKey(citation), [...questions, answer.question])
  }
  const alsoIn = (question: ReviewQuestionKind) => (citation: ReviewCitation) => {
    const others = (citedQuestions.get(citationKey(citation)) ?? []).filter(other => other !== question)
    return others.length > 0 ? `${others.map(other => reviewQuestionShortLabels[other]).join(' · ')} 질문에도 인용` : null
  }
  const missedSources = (run.evidence?.coverageWarnings.length ?? 0) > 0
  return <>
    <View testID="review-conclusion" style={styles.card}>
      <View style={styles.row}>
        {answers.map(answer => {
          const verdict = reviewAnswerVerdictLabels[answer.verdict]
          return <Text key={answer.question} testID={`answer-chip-${answer.question}`} accessibilityLabel={`${reviewQuestionShortLabels[answer.question]} 질문 ${verdict}`}
            style={[styles.badge, badgeColors(toneBadges[reviewAnswerToneOf(answer.verdict)])]}>{`${reviewQuestionShortLabels[answer.question]} · ${verdict}`}</Text>
        })}
        <Text style={[styles.muted, local.count]}>질문 {answers.length}개 판단</Text>
      </View>
      <Text accessibilityRole="header" style={styles.heading}>{headline.title}</Text>
      <Text style={styles.body}>{headline.reason}</Text>
      <Text style={styles.muted}>AI가 공식 원문을 읽은 결과이고 사람이 검수하지 않았어요. 제한을 못 찾은 것이 허용을 뜻하지는 않아요.</Text>
      {summary !== '' && <TextToggle label={summaryOpen ? '요약 접기 ▴' : '요약 더 보기 ▾'} expanded={summaryOpen} onPress={() => setSummaryOpen(!summaryOpen)} />}
      {summaryOpen && <Text style={[styles.body, local.summary]}>{summary}</Text>}
    </View>
    {answers.map((answer, index) => <QuestionCard key={answer.question} testID={`answer-${answer.question}`} number={index + 1} run={run} answer={answer}
      missedSources={missedSources} alsoIn={alsoIn(answer.question)} onOpenSource={onOpenSource} />)}
    {narrowing}
  </>
}

/** 답 하나에 쓰인 모든 인용(답 · 조건 · 조치)이에요. */
function citationsOf(answer: ReviewAnswer): ReviewCitation[] {
  return [...answer.citations, ...answer.conditions.flatMap(condition => condition.citations), ...answer.consequences.flatMap(consequence => consequence.citations)]
}

/**
 * 질문 하나의 카드예요. 답 근거는 처음부터 펼치고, 조건 · 조치의 근거는 눌러서 봐요.
 * 규정 없음은 허용이 아니라는 안내를, 수집하지 못한 첨부가 있으면 그 사실도 함께 적어요.
 */
function QuestionCard({ testID, number, run, answer, missedSources, alsoIn, onOpenSource }: {
  testID: string; number: number; run: ReviewRun; answer: ReviewAnswer; missedSources: boolean
  alsoIn: (citation: ReviewCitation) => string | null; onOpenSource(url: string): void
}) {
  const verdict = reviewAnswerVerdictLabels[answer.verdict]
  return <View testID={testID} style={styles.card}>
    <View style={local.head}>
      <Text accessibilityRole="header" style={[styles.heading, local.fill]}>{`${number}. ${reviewQuestionLabels[answer.question]}`}</Text>
      <Text testID={`${testID}-verdict`} accessibilityLabel={`판정 ${verdict}`} style={[styles.badge, badgeColors(toneBadges[reviewAnswerToneOf(answer.verdict)])]}>{verdict}</Text>
    </View>
    <Text style={styles.body}>{displayReviewText(answer.explanation)}</Text>
    {answer.verdict === 'NO_RULE' && <Text style={styles.muted}>
      {`두 공고에서 이 질문에 해당하는 규정을 찾지 못했어요. 허용을 뜻하지는 않아요.${missedSources ? ' 읽지 못한 첨부가 있어 아래 판단 한계를 함께 확인해 주세요.' : ''}`}
    </Text>}
    {answer.conditions.length > 0 && <View style={local.list}>{answer.conditions.map((condition, index) => {
      const result = conditionResults[condition.result]
      return <View key={index} testID={`${testID}-condition-${index}`} style={local.box}>
        <View style={local.head}>
          <Text style={[styles.body, local.fill]}>{displayReviewText(condition.condition)}</Text>
          <Text accessibilityElementsHidden importantForAccessibility="no" style={styles.muted}>→</Text>
          <Text testID={`${testID}-condition-${index}-result`} accessibilityLabel={`결과 ${result.label}`} style={[styles.badge, badgeColors(result.tone)]}>{result.label}</Text>
        </View>
        {condition.citations.length > 0 && <CitationList label="근거" run={run} citations={condition.citations} alsoIn={alsoIn} initiallyOpen={false} onOpenSource={onOpenSource} />}
      </View>
    })}</View>}
    {answer.institutionQuestion.trim() !== '' && <View testID={`${testID}-institution`} style={local.ask}>
      <Text style={local.askLabel}>기관에 물어볼 것</Text>
      <Text style={styles.body}>{displayReviewText(answer.institutionQuestion)}</Text>
    </View>}
    {answer.citations.length > 0 && <CitationList label="근거 원문" run={run} citations={answer.citations} alsoIn={alsoIn} initiallyOpen onOpenSource={onOpenSource} />}
    {answer.consequences.length > 0 && <View testID={`${testID}-consequences`} style={local.box}>
      <Text style={styles.label}>걸리면 생기는 일</Text>
      {answer.consequences.map((consequence, index) => {
        const moment = reviewConsequenceMomentLabels[consequence.moment]
        return <View key={index} testID={`${testID}-consequence-${index}`} style={local.list}>
          <View style={local.head}>
            <Text accessibilityLabel={`${moment} 시점`} style={[styles.badge, badgeColors('neutral')]}>{moment}</Text>
            <Text style={[styles.body, local.fill]}>{displayReviewText(consequence.action)}</Text>
          </View>
          {consequence.citations.length > 0 && <CitationList label="근거" run={run} citations={consequence.citations} alsoIn={alsoIn} initiallyOpen={false} onOpenSource={onOpenSource} />}
        </View>
      })}
    </View>}
  </View>
}

/** 근거 원문 묶음이에요. [근거 n개 보기]로 펼치고 접으며, 원문 카드는 단계 결과와 같은 ReviewEvidenceQuote를 써요. */
function CitationList({ label, run, citations, alsoIn, initiallyOpen, onOpenSource }: {
  label: string; run: ReviewRun; citations: readonly ReviewCitation[]; alsoIn: (citation: ReviewCitation) => string | null
  initiallyOpen: boolean; onOpenSource(url: string): void
}) {
  const [open, setOpen] = useState(initiallyOpen)
  return <>
    <TextToggle label={`${label} ${citations.length}개 ${open ? '접기 ▴' : '보기 ▾'}`} expanded={open} onPress={() => setOpen(!open)} />
    {open && citations.map((citation, index) => <ReviewEvidenceQuote key={index} number={index + 1} run={run} citation={citation}
      alsoIn={alsoIn(citation)} onOpenSource={onOpenSource} />)}
  </>
}

const local = StyleSheet.create({
  count: { marginLeft: 'auto' },
  summary: { backgroundColor: colors.divider, borderRadius: 12, padding: 12, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  fill: { flex: 1 },
  list: { gap: 8 },
  box: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, gap: 8 },
  ask: { backgroundColor: colors.infoSoft, borderRadius: 12, padding: 12, gap: 4 },
  askLabel: { color: colors.info, fontSize: 13, lineHeight: 20, fontWeight: '700' },
})
