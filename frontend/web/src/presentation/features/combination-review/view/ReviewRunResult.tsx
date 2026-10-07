import { useState } from 'react'
import { Link } from 'react-router'
import {
  reviewHeadline, reviewJudgmentLabels, reviewQuestions, reviewStageLabels, reviewVerdictLabels, reviewVerdictOf,
  type ReviewStageResult, type ReviewVerdict,
} from '@govbiz/shared/domain/entities/CombinationReviewResult'
import { appPaths } from '../../../shared/routes/appPaths'
import { reviewProgramKey, reviewStages, type ReviewRun } from '../../../../domain/entities/CombinationReview'
import { reviewRunFailureMessage } from '../viewmodel/reviewMessages'
import { reviewStyles as s } from './CombinationReview.styles'

const verdictBadges: Record<ReviewVerdict, string> = { warn: s.badgeWarn, info: s.badgeInfo, ok: s.badgeOk }
const verdictCells: Record<ReviewVerdict, string> = { warn: s.stageCellWarn, info: s.stageCellInfo, ok: s.stageCellOk }
const verdictOrder: ReviewVerdict[] = ['warn', 'info', 'ok']

const statusTerms: Record<string, string> = {
  NOT_STARTED: '‘시작 전’', IN_PROGRESS: '‘수행 중’', COMPLETED: '‘완료’', STOPPED: '‘중단’',
  UNKNOWN: '‘미확인’', YES: '‘예’', NO: '‘아니오’',
}
const displayReviewText = (text: string) => text.replace(
  /\b(?:NOT_STARTED|IN_PROGRESS|COMPLETED|STOPPED|UNKNOWN|YES|NO)\b/g,
  (term) => statusTerms[term] ?? term,
)

type Pair = NonNullable<ReviewRun['analysis']>['pairs'][number]
const stageRowId = (run: ReviewRun, pair: Pair, stage: ReviewStageResult) => `review-stage-${run.id}-${pair.firstProgramIndex}-${pair.secondProgramIndex}-${stage.stage}`

/**
 * 실행 결과입니다. 결론(판정 조합으로 정한 문장 · 단계 색 띠) → 먼저 확인할 것 → 접힌 단계 줄 → 접힌 원문 · 판단 한계 순으로 둡니다.
 * 주의(제한 · 충돌) 단계만 처음부터 펼치고, AI 요약 · 근거 원문 · 판단 한계는 눌러서 봅니다.
 */
export function ReviewRunResult({ run, currentRevision, names, download, downloading }: {
  run: ReviewRun; currentRevision: number; names: Record<string, string>; download: (index: number) => void; downloading: boolean
}) {
  // This prompt used internal (zero-based) indices in prose. Only adapt an
  // explicitly zero-based legacy summary; preserve stored data and source quotes.
  const summary = run.analysis?.summary ?? ''
  const legacySummary = run.configuration?.promptVersion === 'sha256:f0e60686c3d79629d9523b65583a801f0780b83e00a3bbcde043ae895e601bcb'
    && /사업\s*0(?![0-9])/.test(summary) && !/사업\s*2(?![0-9])/.test(summary)
  const displayedSummary = displayReviewText(legacySummary
    ? summary.replace(/사업(\s*)([01])(?![0-9])/g, (_match, space: string, index: string) => `사업${space}${Number(index) + 1}`)
    : summary)
  const pairs = run.analysis?.pairs ?? []
  const allStages = pairs.flatMap((pair) => pair.stages)
  const counts = verdictOrder.map((verdict) => [verdict, allStages.filter((stage) => reviewVerdictOf(stage.judgment) === verdict).length] as const).filter(([, count]) => count > 0)
  const headline = reviewHeadline(allStages, run.input.programs.map((program) => program.participation))
  const questions = reviewQuestions(allStages)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [allQuestions, setAllQuestions] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  // 주의(제한 · 충돌) 단계는 처음부터 펼칩니다. 사용자가 누른 줄만 따로 기억해, 진행 중이던 실행이 끝나 판단이 생겨도 같은 규칙이 적용됩니다.
  const [stageToggles, setStageToggles] = useState<Record<string, boolean>>({})
  const stageOpen = (id: string, stage: ReviewStageResult) => stageToggles[id] ?? reviewVerdictOf(stage.judgment) === 'warn'
  // 띠의 칸을 누르면 그 단계 줄을 펼치고 그 줄로 내려가 초점을 옮깁니다. 줄 머리는 늘 그려져 있어 바로 찾을 수 있습니다.
  const showStage = (id: string) => {
    setStageToggles((current) => ({ ...current, [id]: true }))
    const row = document.getElementById(id)
    const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
    row?.querySelector<HTMLButtonElement>('button[aria-expanded]')?.focus({ preventScroll: true })
  }
  const programName = (index: number) => {
    const program = run.input.programs[index]
    return program ? names[reviewProgramKey(program)] ?? `사업 ${index + 1}` : `사업 ${index + 1}`
  }
  const shownQuestions = allQuestions ? questions.all : questions.priority
  const limitationCount = (run.evidence?.coverageWarnings.length ?? 0) + (run.analysis?.limitations.length ?? 0)
  const summaryId = `review-summary-${run.id}`
  const questionsId = `review-questions-${run.id}`
  const sourcesId = `review-sources-${run.id}`
  return <section className="space-y-4" aria-label={`실행 ${run.id} 결과`}>
    {run.inputRevision !== currentRevision && <p className={s.warning}>과거 입력 버전의 결과입니다. 현재 저장 입력(버전 {currentRevision})에 대한 결과가 아닙니다.</p>}
    {run.status === 'QUEUED' && <p role="status" className={s.info}>분석 차례를 기다리고 있어요. 화면을 나가도 계속되고, 상태는 자동으로 확인해요.</p>}
    {run.status === 'RUNNING' && <p role="status" className={s.info}>공식 문서를 읽고 단계별로 판단하고 있어요. 화면을 나가도 계속되고, 상태는 자동으로 확인해요.</p>}
    {run.status === 'UNKNOWN' && <p role="status" className={s.warning}>분석 완료 여부를 확인할 수 없습니다. 중복 과금을 방지하기 위해 자동 재실행과 같은 검토의 새 분석을 차단했습니다. 운영자 확인이 필요합니다.</p>}
    {(run.status === 'FAILED' || run.status === 'INTERRUPTED') && <div className={`${s.warning} flex flex-wrap items-center justify-between gap-3`}>
      <p>{reviewRunFailureMessage(run.failureCode)}</p>
      <Link className={s.secondarySm} to={`${appPaths.combinationReviews}/${run.reviewId}?step=analysis`}>다시 시도</Link>
    </div>}
    {run.analysis && <>
      <section className={`${s.card} space-y-3`} aria-label="검토 결론">
        <div className="flex flex-wrap items-center gap-1.5">
          {counts.map(([verdict, count]) => <span key={verdict} className={`${s.badge} ${verdictBadges[verdict]}`}>{reviewVerdictLabels[verdict]} {count}</span>)}
          <span className="ml-auto text-xs text-slate-500 tabular-nums">{allStages.length}단계 판단</span>
        </div>
        <div className="space-y-1">
          <h2 className="text-lg leading-snug font-extrabold text-ink">{headline.title}</h2>
          <p className="text-sm leading-6 text-slate-600">{headline.reason}</p>
        </div>
        {pairs.map((pair) => <div key={`${pair.firstProgramIndex}:${pair.secondProgramIndex}`} role="group" aria-label={pairs.length > 1 ? `사업 ${pair.firstProgramIndex + 1} × 사업 ${pair.secondProgramIndex + 1} 단계별 판정` : '단계별 판정'} className="grid grid-cols-6 gap-1">
          {[...pair.stages].sort((a, b) => reviewStages.indexOf(a.stage) - reviewStages.indexOf(b.stage)).map((stage) => {
            const verdict = reviewVerdictOf(stage.judgment)
            const id = stageRowId(run, pair, stage)
            return <button key={stage.stage} type="button" className={`${s.stageCell} ${verdictCells[verdict]}`} aria-controls={id}
              aria-label={`${reviewStageLabels[stage.stage]} 단계 ${reviewVerdictLabels[verdict]} · 자세히 보기`} onClick={() => showStage(id)}>{reviewStageLabels[stage.stage]}</button>
          })}
        </div>)}
        <ul className="space-y-1">{run.input.programs.map((program, index) => <li key={reviewProgramKey(program)} className="flex items-baseline gap-2 text-sm">
          <span className={`${s.badge} ${s.badgeNeutral}`}>사업 {index + 1}</span><b className="min-w-0">{programName(index)}</b>
        </li>)}</ul>
        <p className="text-xs leading-5 text-slate-600">
          AI가 공식 원문을 읽은 결과이고 사람이 검수하지 않았어요. 제한을 못 찾은 것이 허용을 뜻하지는 않아요.
          {displayedSummary && <button type="button" className={`${s.textLink} ml-1.5`} aria-expanded={summaryOpen} aria-controls={summaryId} onClick={() => setSummaryOpen(!summaryOpen)}>{summaryOpen ? '요약 접기 ▴' : '요약 더 보기 ▾'}</button>}
        </p>
        {displayedSummary && <p id={summaryId} hidden={!summaryOpen} className="rounded-xl bg-surface-muted p-3 text-sm leading-7 whitespace-pre-wrap">{displayedSummary}</p>}
      </section>
      <section className={`${s.card} space-y-3`} aria-label="먼저 확인할 것">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-bold">먼저 확인할 것</h2>
          {questions.priority.length > 0 && <span className="text-xs text-slate-500">단계마다 하나씩 · 답하면 판단이 바뀔 수 있어요</span>}
          <Link className={`${s.primaryPill} ml-auto`} to={`${appPaths.combinationReviews}/${run.reviewId}?step=participation`} state={{ additionalFacts: run.input.additionalFacts }}>참여 상태 입력하고 다시 보기</Link>
        </div>
        {shownQuestions.length > 0 ? <ul id={questionsId} className="space-y-1.5 text-sm leading-6">{shownQuestions.map((question) => <li key={question.text} className="flex items-baseline gap-2">
          <span className={`${s.badge} ${s.badgeNeutral}`}>{reviewStageLabels[question.stage]}</span><span className="min-w-0">{displayReviewText(question.text)}</span>
        </li>)}</ul>
          : <p className={s.muted}>현재 분석에서 추가로 확인할 질문은 없어요.</p>}
        {questions.all.length > questions.priority.length && <button type="button" className={s.textLink} aria-expanded={allQuestions} aria-controls={questionsId} onClick={() => setAllQuestions(!allQuestions)}>
          {allQuestions ? '단계별 첫 질문만 보기 ▴' : `질문 ${questions.all.length}개 모두 보기 ▾`}
        </button>}
      </section>
      <section className="space-y-3" aria-label="단계별 판단">
        <h2 className="font-bold">단계별 판단 <span className="text-xs font-semibold text-slate-500">눌러서 펼쳐요</span></h2>
        {pairs.map((pair) => {
          const ordered = [...pair.stages].sort((a, b) => reviewStages.indexOf(a.stage) - reviewStages.indexOf(b.stage))
          const firstWarn = ordered.find((stage) => reviewVerdictOf(stage.judgment) === 'warn')
          return <div className="space-y-2" key={`${pair.firstProgramIndex}:${pair.secondProgramIndex}`}>
            {pairs.length > 1 && <h3 className="text-sm font-bold">사업 {pair.firstProgramIndex + 1} × 사업 {pair.secondProgramIndex + 1}</h3>}
            <div className={`${s.card} divide-y divide-slate-200 overflow-hidden p-0`}>
              {ordered.map((stage) => {
                const id = stageRowId(run, pair, stage)
                const open = stageOpen(id, stage)
                return <StageRow key={id} id={id} run={run} stage={stage} open={open} onToggle={() => setStageToggles((current) => ({ ...current, [id]: !open }))}
                  citationsOpen={stage === firstWarn} download={download} downloading={downloading} />
              })}
            </div>
          </div>
        })}
      </section>
    </>}
    {run.evidence && <section className={`${s.card} space-y-3`} aria-label="공식 원문과 수집 범위">
      <button type="button" className="flex w-full cursor-pointer items-center gap-2 text-left text-sm font-bold text-ink" aria-expanded={sourcesOpen} aria-controls={sourcesId} onClick={() => setSourcesOpen(!sourcesOpen)}>
        <span className="min-w-0 flex-1">공식 원문 {run.evidence.documents.length}개 · 판단 한계 {limitationCount}개</span>
        <span className={`${s.badge} ${s.badgeNeutral}`}>자동 수집 · 사람 미검수</span>
        <span aria-hidden="true">{sourcesOpen ? '▴' : '▾'}</span>
      </button>
      <div id={sourcesId} hidden={!sourcesOpen} className="space-y-3">
        <ul className="divide-y divide-slate-200">{run.evidence.documents.map((doc, i) => <li className="flex flex-wrap items-center gap-3 py-2 text-sm" key={i}>
          <span className="min-w-0 flex-1 break-all"><b>{doc.fileName}</b><span className="block text-xs text-slate-500">사업 {doc.programIndex + 1} · {doc.format}</span></span>
          {doc.sourcePageUrl && <a className={s.textLink} href={doc.sourcePageUrl} target="_blank" rel="noreferrer">공고 페이지 보기 ↗<span className="sr-only">: {doc.fileName}</span></a>}
          <button className={s.secondarySm} type="button" disabled={downloading} onClick={() => download(i)}>받기<span className="sr-only">: {doc.fileName}</span></button>
        </li>)}</ul>
        <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-slate-600">
          {run.evidence.coverageWarnings.map((warning, i) => <li key={`w${i}`}>{warning}</li>)}
          {run.analysis?.limitations.map((text, i) => <li key={`l${i}`}>{displayReviewText(text)}</li>)}
          <li>입력한 참여 상태 · 추가 설명과 자동 수집한 원문 범위 안에서만 판단했어요.</li>
          <li>두 공고 사이의 제한만 봤어요. 과거 수혜 이력 누적 · 사업비 정산 규정은 이 검토 범위 밖이에요.</li>
        </ul>
      </div>
    </section>}
  </section>
}

/** 단계 하나의 접히는 줄입니다. 접혀 있어도 단계 · 판정 · 판단 범위 · 질문/근거 수는 보이고, 근거 원문은 펼친 줄 안에서 한 번 더 눌러 봅니다. */
function StageRow({ id, run, stage, open, onToggle, citationsOpen, download, downloading }: {
  id: string; run: ReviewRun; stage: ReviewStageResult; open: boolean; onToggle: () => void; citationsOpen: boolean; download: (index: number) => void; downloading: boolean
}) {
  const [showCitations, setShowCitations] = useState(citationsOpen)
  const verdict = reviewVerdictOf(stage.judgment)
  const stageName = reviewStageLabels[stage.stage]
  const bodyId = `${id}-body`
  const scopeId = `${id}-scope`
  const citationsId = `${id}-citations`
  // 줄 머리의 글자는 인라인 조각이라 그대로 읽으면 "1신청확인 필요"처럼 붙어서, 읽을 이름을 따로 둡니다.
  const label = [`${reviewStages.indexOf(stage.stage) + 1}단계 ${stageName} ${reviewVerdictLabels[verdict]}`, reviewJudgmentLabels[stage.judgment],
    ...(stage.requiresInstitutionConfirmation ? ['기관 확인 필요'] : []), `질문 ${stage.questions.length}개`, `근거 ${stage.citations.length}개`].join(' · ')
  return <article id={id} className="scroll-mt-4" aria-label={`${stageName} 단계 판단`}>
    <h3 className="m-0">
      <button type="button" className={s.stageRowButton} aria-label={label} aria-describedby={stage.scope ? scopeId : undefined} aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-surface-muted text-xs font-bold text-ink-muted tabular-nums">{reviewStages.indexOf(stage.stage) + 1}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <b className="text-[0.95rem]">{stageName}</b>
            <span className={`${s.badge} ${verdictBadges[verdict]}`}>{reviewVerdictLabels[verdict]}</span>
            <span className="text-xs font-normal text-slate-500">{reviewJudgmentLabels[stage.judgment]}</span>
            {stage.requiresInstitutionConfirmation && <span className={`${s.badge} ${s.badgeNeutral}`}>기관 확인 필요</span>}
          </span>
          {stage.scope && <span id={scopeId} className={`mt-1 block text-xs font-normal text-slate-600 ${open ? 'whitespace-pre-wrap' : 'line-clamp-1'}`}>{displayReviewText(stage.scope)}</span>}
          <span className="mt-0.5 block text-xs font-normal text-ink-muted tabular-nums">질문 {stage.questions.length} · 근거 {stage.citations.length}</span>
        </span>
        <span className="mt-0.5 text-xs text-ink-muted" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
    </h3>
    <div id={bodyId} hidden={!open} className="space-y-2 px-4 pb-4 sm:pl-[3.25rem]">
      <p className="text-sm leading-7 whitespace-pre-wrap">{displayReviewText(stage.explanation)}</p>
      {stage.questions.length > 0 && <div className="text-sm"><b className="text-xs">확인 질문</b><ul className="mt-1 list-disc space-y-1 pl-5">{stage.questions.map((q, i) => <li key={i}>{displayReviewText(q)}</li>)}</ul></div>}
      {stage.citations.length > 0 && <>
        <button type="button" className={s.textLink} aria-expanded={showCitations} aria-controls={citationsId} onClick={() => setShowCitations(!showCitations)}>
          근거 원문 {stage.citations.length}개 {showCitations ? '접기 ▴' : '보기 ▾'}
        </button>
        <ol id={citationsId} hidden={!showCitations} className="space-y-2">
          {stage.citations.map((citation, i) => {
            const block = run.evidence?.blocks.find((b) => b.id === citation.evidenceId)
            const documentIndex = run.evidence?.documents.findIndex((d) => d.rawHash === block?.documentHash && d.programIndex === block?.programIndex) ?? -1
            const document = documentIndex >= 0 ? run.evidence!.documents[documentIndex] : undefined
            return <li className="rounded-xl border border-slate-200 p-3 text-sm" key={i}>
              <b className="block text-xs text-brand-primary break-all">근거 {i + 1} · 사업 {(block?.programIndex ?? 0) + 1}{block?.locator ? ` · ${block.locator}` : ''}</b>
              <blockquote className="mt-1 border-l-[3px] border-brand-primary/30 pl-2.5 whitespace-pre-wrap">{citation.quote}</blockquote>
              <div className="mt-2 flex flex-wrap gap-4">
                {document?.sourcePageUrl && <a className={s.textLink} href={document.sourcePageUrl} target="_blank" rel="noreferrer">공고 페이지 보기 ↗</a>}
                {documentIndex >= 0 && <button type="button" className={s.textLink} disabled={downloading} onClick={() => download(documentIndex)}>원문 받기</button>}
              </div>
            </li>
          })}
        </ol>
      </>}
    </div>
  </article>
}
