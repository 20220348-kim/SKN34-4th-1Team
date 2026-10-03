import { useState } from 'react'
import { Link } from 'react-router'
import { appPaths } from '../../../shared/routes/appPaths'
import { reviewProgramKey, reviewStages, type ReviewRun } from '../../../../domain/entities/CombinationReview'
import { reviewRunFailureMessage } from '../viewmodel/reviewMessages'
import { reviewStyles as s } from './CombinationReview.styles'

type Stage = NonNullable<ReviewRun['analysis']>['pairs'][number]['stages'][number]
type Judgment = Stage['judgment']

const stages = { APPLICATION: '신청', SELECTION: '선정', COMMITMENT: '확약', AGREEMENT: '협약', EXECUTION: '수행', FUNDING: '교부' }
const judgments = { RESTRICTION_APPLIES: '제한 적용', PERMISSION_IN_SCOPE: '명시된 범위 내 허용', NEEDS_FACTS: '사용자 정보 부족', INSUFFICIENT_EVIDENCE: '공식 근거 부족', CONFLICTING_EVIDENCE: '규정 충돌' }
// 판정 다섯 가지를 세 묶음으로 보여 준다: 주의(제한 · 충돌) → 확인 필요(정보 · 근거 부족) → 가능(명시된 범위 내 허용).
const verdicts = {
  warn: { label: '주의', tone: s.badgeWarn },
  info: { label: '확인 필요', tone: s.badgeInfo },
  ok: { label: '가능', tone: s.badgeOk },
} as const
type Verdict = keyof typeof verdicts
const verdictOf = (judgment: Judgment): Verdict => judgment === 'RESTRICTION_APPLIES' || judgment === 'CONFLICTING_EVIDENCE' ? 'warn'
  : judgment === 'PERMISSION_IN_SCOPE' ? 'ok' : 'info'
const verdictOrder: Verdict[] = ['warn', 'info', 'ok']

const statusTerms: Record<string, string> = {
  NOT_STARTED: '‘시작 전’', IN_PROGRESS: '‘수행 중’', COMPLETED: '‘완료’', STOPPED: '‘중단’',
  UNKNOWN: '‘미확인’', YES: '‘예’', NO: '‘아니오’',
}
const displayReviewText = (text: string) => text.replace(
  /\b(?:NOT_STARTED|IN_PROGRESS|COMPLETED|STOPPED|UNKNOWN|YES|NO)\b/g,
  (term) => statusTerms[term] ?? term,
)

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
  const allStages = run.analysis?.pairs.flatMap((pair) => pair.stages) ?? []
  const counts = verdictOrder.map((verdict) => [verdict, allStages.filter((stage) => verdictOf(stage.judgment) === verdict).length] as const).filter(([, count]) => count > 0)
  const questions = [...new Set(allStages.flatMap((stage) => stage.questions.map((question) => question.trim())).filter(Boolean))]
  const programName = (index: number) => {
    const program = run.input.programs[index]
    return program ? names[reviewProgramKey(program)] ?? `사업 ${index + 1}` : `사업 ${index + 1}`
  }
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
      <section className={`${s.card} space-y-3`} aria-label="검토 요약">
        <div className="flex flex-wrap items-center gap-1.5">
          {counts.map(([verdict, count]) => <span key={verdict} className={`${s.badge} ${verdicts[verdict].tone}`}>{verdicts[verdict].label} {count}</span>)}
          <span className="ml-auto text-xs text-slate-500 tabular-nums">{allStages.length}단계 판단</span>
        </div>
        <ul className="space-y-1">{run.input.programs.map((program, index) => <li key={reviewProgramKey(program)} className="flex items-baseline gap-2 text-sm">
          <span className={`${s.badge} ${s.badgeNeutral}`}>사업 {index + 1}</span><b className="min-w-0">{programName(index)}</b>
        </li>)}</ul>
        <p className="text-sm leading-7 whitespace-pre-wrap">{displayedSummary}</p>
      </section>
      <div className={s.info} role="note"><strong className="block">제한을 찾지 못한 것은 허용이 아니에요</strong>공식 원문을 AI가 읽고 판단한 결과이며 사람이 검수한 정답이 아니에요. "가능"도 전체 신청 자격이나 동시 수혜를 보장하지 않아요.</div>
      <section className={`${s.card} space-y-2`} aria-label="확인할 정보">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-bold">확인할 정보</h2>
          {questions.length > 0 && <span className="text-xs text-slate-500">{questions.length}개 · 답하면 판단이 바뀔 수 있어요</span>}
          <Link className={`${s.secondarySm} ml-auto`} to={`${appPaths.combinationReviews}/${run.reviewId}?step=participation`} state={{ additionalFacts: run.input.additionalFacts }}>입력 보완하기</Link>
        </div>
        {questions.length > 0 ? <ul className="list-disc space-y-1 pl-5 text-sm leading-6">{questions.map((question) => <li key={question}>{displayReviewText(question)}</li>)}</ul>
          : <p className={s.muted}>현재 분석에서 추가로 확인할 질문은 없어요.</p>}
      </section>
      <section className="space-y-3" aria-label="단계별 판단">
        <h2 className="font-bold">단계별 판단 <span className="text-xs font-semibold text-slate-500">주의 → 확인 필요 → 가능 순</span></h2>
        {run.analysis.pairs.map((pair) => {
          const pairKey = `${run.id}:${pair.firstProgramIndex}:${pair.secondProgramIndex}`
          const sorted = [...pair.stages].sort((a, b) => verdictOrder.indexOf(verdictOf(a.judgment)) - verdictOrder.indexOf(verdictOf(b.judgment))
            || reviewStages.indexOf(a.stage) - reviewStages.indexOf(b.stage))
          return <div className="space-y-3" key={pairKey}>
            {run.analysis!.pairs.length > 1 && <h3 className="text-sm font-bold">사업 {pair.firstProgramIndex + 1} × 사업 {pair.secondProgramIndex + 1}</h3>}
            {sorted.map((stage, index) => <StageCard key={`${pairKey}:${stage.stage}`} run={run} stage={stage}
              defaultOpen={index === 0 && verdictOf(stage.judgment) === 'warn'} download={download} downloading={downloading} />)}
          </div>
        })}
      </section>
    </>}
    {run.evidence && <section className={`${s.card} space-y-3`} aria-label="공식 원문과 수집 범위">
      <div className="flex flex-wrap items-center gap-2"><h2 className="font-bold">공식 원문과 수집 범위</h2><span className={`${s.badge} ${s.badgeNeutral}`}>자동 수집 · 사람 미검수</span></div>
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
    </section>}
  </section>
}

/** 단계 하나의 판단 카드입니다. 근거 인용은 접어 두고 "근거 n개"로 펼칩니다(첫 주의 카드만 펼친 채). */
function StageCard({ run, stage, defaultOpen, download, downloading }: { run: ReviewRun; stage: Stage; defaultOpen: boolean; download: (index: number) => void; downloading: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const verdict = verdicts[verdictOf(stage.judgment)]
  const stageName = stages[stage.stage]
  const citationsId = `review-citations-${run.id}-${stage.stage}`
  return <article className={`${s.card} space-y-2`} aria-label={`${stageName} 단계 판단`}>
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-bold text-slate-500 tabular-nums">{reviewStages.indexOf(stage.stage) + 1}단계</span>
      <h3 className="font-bold">{stageName}</h3>
      <span className={`${s.badge} ${verdict.tone}`}>{verdict.label}</span>
      <span className="text-xs text-slate-500">{judgments[stage.judgment]}</span>
      {stage.requiresInstitutionConfirmation && <span className={`${s.badge} ${s.badgeNeutral}`}>기관 확인 필요</span>}
      {stage.citations.length > 0 && <button type="button" className={`${s.textLink} ml-auto`} aria-expanded={open} aria-controls={citationsId} onClick={() => setOpen(!open)}>근거 {stage.citations.length}개 {open ? '▴' : '▾'}</button>}
    </div>
    <p className="text-xs text-slate-600 whitespace-pre-wrap"><b>판단 범위</b> · {displayReviewText(stage.scope)}</p>
    <p className="text-sm leading-7 whitespace-pre-wrap">{displayReviewText(stage.explanation)}</p>
    {stage.questions.length > 0 && <div className="text-sm"><b className="text-xs">확인 질문</b><ul className="mt-1 list-disc space-y-1 pl-5">{stage.questions.map((q, i) => <li key={i}>{displayReviewText(q)}</li>)}</ul></div>}
    {stage.citations.length > 0 && <ol id={citationsId} hidden={!open} className="space-y-2">
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
    </ol>}
  </article>
}
