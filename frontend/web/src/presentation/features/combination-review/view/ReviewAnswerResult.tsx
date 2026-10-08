import { type ReactNode, useState } from 'react'
import {
  reviewAnswerHeadline, reviewAnswerToneOf, reviewAnswerVerdictLabels, reviewConsequenceMomentLabels, reviewQuestionLabels, reviewQuestionShortLabels,
  type ReviewAnswerTone,
} from '@govbiz/shared/domain/entities/CombinationReviewResult'
import { reviewProgramKey, type ReviewAnswer, type ReviewCitation, type ReviewQuestionKind, type ReviewRun } from '../../../../domain/entities/CombinationReview'
import { reviewStyles as s } from './CombinationReview.styles'
import { EvidenceQuote } from './EvidenceQuote'
import { citationKey, displayReviewText } from './reviewText'

/** 판정 칩 색입니다: 불가 · 조건부 · 기관 확인 · 규정 없음(허용 아님) · 가능. */
const toneBadges: Record<ReviewAnswerTone, string> = { warn: s.badgeDanger, conditional: s.badgeWarn, ask: s.badgeInfo, neutral: s.badgeNeutral, ok: s.badgeOk }
const conditionResults = { ALLOWED: { label: '가능', badge: s.badgeOk }, NOT_ALLOWED: { label: '불가', badge: s.badgeDanger } } as const

type Download = { download: (index: number) => void; downloading: boolean }

/**
 * 세 질문 방식(v3)의 결과입니다. 결론 카드(질문별 판정 칩 · 판정 조합으로 정한 결론 문장 · "찾지 못함 ≠ 허용" · 접힌 AI 요약) →
 * 질문 카드 3장(판정 칩 · 설명 · 조건 → 결과 칩 · 근거 원문 · 기관에 물어볼 것 · 걸리면 생기는 일) → 내 상황으로 좁히기 순으로 둡니다.
 */
export function ReviewAnswerResult({ run, answers, programNames, summary, narrowing, download, downloading }: Download & {
  run: ReviewRun; answers: readonly ReviewAnswer[]; programNames: readonly string[]; summary: string; narrowing?: ReactNode
}) {
  const [summaryOpen, setSummaryOpen] = useState(false)
  const headline = reviewAnswerHeadline(answers)
  const summaryId = `review-summary-${run.id}`
  // 같은 인용을 고른 질문들입니다. 근거마다 "○○ 질문에도 인용"으로 알립니다.
  const citedQuestions = new Map<string, ReviewQuestionKind[]>()
  for (const answer of answers) {
    for (const citation of citationsOf(answer)) {
      const questions = citedQuestions.get(citationKey(citation)) ?? []
      if (!questions.includes(answer.question)) citedQuestions.set(citationKey(citation), [...questions, answer.question])
    }
  }
  const alsoIn = (question: ReviewQuestionKind) => (citation: ReviewCitation) => {
    const others = (citedQuestions.get(citationKey(citation)) ?? []).filter((other) => other !== question)
    return others.length > 0 ? `${others.map((other) => reviewQuestionShortLabels[other]).join(' · ')} 질문에도 인용` : null
  }
  return <>
    <section className={`${s.card} space-y-3`} aria-label="검토 결론">
      <div className="flex flex-wrap items-center gap-1.5">
        {answers.map((answer) => <span key={answer.question} className={`${s.badge} ${toneBadges[reviewAnswerToneOf(answer.verdict)]}`}>
          {reviewQuestionShortLabels[answer.question]} · {reviewAnswerVerdictLabels[answer.verdict]}
        </span>)}
        <span className="ml-auto text-xs text-slate-500 tabular-nums">질문 {answers.length}개 판단</span>
      </div>
      <div className="space-y-1">
        <h2 className="text-lg leading-snug font-extrabold text-ink">{headline.title}</h2>
        <p className="text-sm leading-6 text-slate-600">{headline.reason}</p>
      </div>
      <ul className="space-y-1">{run.input.programs.map((program, index) => <li key={reviewProgramKey(program)} className="flex items-baseline gap-2 text-sm">
        <span className={`${s.badge} ${s.badgeNeutral}`}>사업 {index + 1}</span><b className="min-w-0">{programNames[index]}</b>
      </li>)}</ul>
      <p className="text-xs leading-5 text-slate-600">
        AI가 공식 원문을 읽은 결과이고 사람이 검수하지 않았어요. 제한을 못 찾은 것이 허용을 뜻하지는 않아요.
        {summary && <button type="button" className={`${s.textLink} ml-1.5`} aria-expanded={summaryOpen} aria-controls={summaryId} onClick={() => setSummaryOpen(!summaryOpen)}>{summaryOpen ? '요약 접기 ▴' : '요약 더 보기 ▾'}</button>}
      </p>
      {summary && <p id={summaryId} hidden={!summaryOpen} className="rounded-xl bg-surface-muted p-3 text-sm leading-7 whitespace-pre-wrap">{summary}</p>}
    </section>
    <section className="space-y-3" aria-label="세 질문">
      {answers.map((answer, index) => <QuestionCard key={answer.question} id={`review-answer-${run.id}-${answer.question}`} number={index + 1} run={run} answer={answer}
        missedSources={(run.evidence?.coverageWarnings.length ?? 0) > 0} alsoIn={alsoIn(answer.question)} download={download} downloading={downloading} />)}
    </section>
    {narrowing}
  </>
}

/** 답 하나에 쓰인 모든 인용(답 · 조건 · 조치)입니다. */
function citationsOf(answer: ReviewAnswer): ReviewCitation[] {
  return [...answer.citations, ...answer.conditions.flatMap((condition) => condition.citations), ...answer.consequences.flatMap((consequence) => consequence.citations)]
}

/**
 * 질문 하나의 카드입니다. 답 근거는 처음부터 펼치고, 조건 · 조치의 근거는 눌러서 봅니다.
 * 규정 없음은 허용이 아니라는 안내를, 수집하지 못한 첨부가 있으면 그 사실도 함께 적습니다.
 */
function QuestionCard({ id, number, run, answer, missedSources, alsoIn, download, downloading }: Download & {
  id: string; number: number; run: ReviewRun; answer: ReviewAnswer; missedSources: boolean; alsoIn: (citation: ReviewCitation) => string | null
}) {
  const headingId = `${id}-heading`
  const tone = reviewAnswerToneOf(answer.verdict)
  return <article id={id} className={`${s.card} scroll-mt-4 space-y-3`} aria-labelledby={headingId}>
    <div className="flex flex-wrap items-start gap-2">
      <h3 id={headingId} className="m-0 min-w-0 flex-1 text-[0.95rem] leading-snug font-bold">{number}. {reviewQuestionLabels[answer.question]}</h3>
      <span className={`${s.badge} ${toneBadges[tone]}`}>{reviewAnswerVerdictLabels[answer.verdict]}</span>
    </div>
    <p className="text-sm leading-7 whitespace-pre-wrap">{displayReviewText(answer.explanation)}</p>
    {answer.verdict === 'NO_RULE' && <p className={s.muted}>
      두 공고에서 이 질문에 해당하는 규정을 찾지 못했어요. 허용을 뜻하지는 않아요.{missedSources && ' 읽지 못한 첨부가 있어 아래 판단 한계를 함께 확인해 주세요.'}
    </p>}
    {answer.conditions.length > 0 && <ul className="space-y-2" aria-label="조건별 결과">{answer.conditions.map((condition, index) => {
      const result = conditionResults[condition.result]
      return <li key={index} className="space-y-2 rounded-xl border border-line p-3">
        <div className="flex flex-wrap items-start gap-2 text-sm leading-6">
          <span className="min-w-0 flex-1">{displayReviewText(condition.condition)}</span>
          <span className="text-ink-muted" aria-hidden="true">→</span>
          <span className={`${s.badge} ${result.badge}`}><span className="sr-only">결과: </span>{result.label}</span>
        </div>
        {condition.citations.length > 0 && <CitationList id={`${id}-condition-${index}`} label="근거" run={run} citations={condition.citations} alsoIn={alsoIn}
          initiallyOpen={false} download={download} downloading={downloading} />}
      </li>
    })}</ul>}
    {answer.institutionQuestion.trim() && <div className={s.info}>
      <b className="block text-xs">기관에 물어볼 것</b>
      <p className="mt-1 whitespace-pre-wrap">{displayReviewText(answer.institutionQuestion)}</p>
    </div>}
    {answer.citations.length > 0 && <CitationList id={`${id}-evidence`} label="근거 원문" run={run} citations={answer.citations} alsoIn={alsoIn}
      initiallyOpen download={download} downloading={downloading} />}
    {answer.consequences.length > 0 && <div className="space-y-2 rounded-xl border border-line p-3" role="group" aria-label="걸리면 생기는 일">
      <b className="block text-xs">걸리면 생기는 일</b>
      <ul className="space-y-2">{answer.consequences.map((consequence, index) => <li key={index} className="space-y-1.5 text-sm">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className={`${s.badge} ${s.badgeNeutral}`}>{reviewConsequenceMomentLabels[consequence.moment]}</span>
          <span className="min-w-0 flex-1 leading-6">{displayReviewText(consequence.action)}</span>
        </div>
        {consequence.citations.length > 0 && <CitationList id={`${id}-consequence-${index}`} label="근거" run={run} citations={consequence.citations} alsoIn={alsoIn}
          initiallyOpen={false} download={download} downloading={downloading} />}
      </li>)}</ul>
    </div>}
  </article>
}

/** 근거 원문 묶음입니다. [근거 n개 보기]로 펼치고 접으며, 원문 카드는 단계 결과와 같은 EvidenceQuote를 씁니다. */
function CitationList({ id, label, run, citations, alsoIn, initiallyOpen, download, downloading }: Download & {
  id: string; label: string; run: ReviewRun; citations: readonly ReviewCitation[]; alsoIn: (citation: ReviewCitation) => string | null; initiallyOpen: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const listId = `${id}-list`
  return <>
    <button type="button" className={s.textLink} aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
      {label} {citations.length}개 {open ? '접기 ▴' : '보기 ▾'}
    </button>
    <ol id={listId} hidden={!open} className="space-y-2">
      {citations.map((citation, index) => <EvidenceQuote key={index} id={`${id}-${index}`} number={index + 1} run={run} citation={citation} alsoIn={alsoIn(citation)}
        download={download} downloading={downloading} />)}
    </ol>
  </>
}
