import { useState } from 'react'
import { reviewStages, type ReviewRun } from '../../../../domain/entities/CombinationReview'
import { reviewRunFailureMessage } from '../viewmodel/reviewMessages'
import { reviewStyles as s } from './CombinationReview.styles'

const stages = { APPLICATION: '신청', SELECTION: '선정', COMMITMENT: '확약', AGREEMENT: '협약', EXECUTION: '수행', FUNDING: '교부' }
const judgments = { RESTRICTION_APPLIES: '제한 적용', PERMISSION_IN_SCOPE: '명시된 범위 내 허용', NEEDS_FACTS: '사용자 정보 부족', INSUFFICIENT_EVIDENCE: '공식 근거 부족', CONFLICTING_EVIDENCE: '규정 충돌' }
const statusTerms: Record<string, string> = {
  NOT_STARTED: '‘시작 전’', IN_PROGRESS: '‘수행 중’', COMPLETED: '‘완료’', STOPPED: '‘중단’',
  UNKNOWN: '‘미확인’', YES: '‘예’', NO: '‘아니오’',
}
const displayReviewText = (text: string) => text.replace(
  /\b(?:NOT_STARTED|IN_PROGRESS|COMPLETED|STOPPED|UNKNOWN|YES|NO)\b/g,
  (term) => statusTerms[term] ?? term,
)
export function ReviewRunResult({ run, currentRevision, download, downloading }: { run: ReviewRun; currentRevision: number; download: (index: number) => void; downloading: boolean }) {
  const [selectedStage, setSelectedStage] = useState<string | null>(null)
  const [expandedCitations, setExpandedCitations] = useState<string | null>(null)
  // This prompt used internal (zero-based) indices in prose. Only adapt an
  // explicitly zero-based legacy summary; preserve stored data and source quotes.
  const summary = run.analysis?.summary ?? ''
  const legacySummary = run.configuration?.promptVersion === 'sha256:f0e60686c3d79629d9523b65583a801f0780b83e00a3bbcde043ae895e601bcb'
    && /사업\s*0(?![0-9])/.test(summary) && !/사업\s*2(?![0-9])/.test(summary)
  const displayedSummary = displayReviewText(legacySummary
    ? summary.replace(/사업(\s*)([01])(?![0-9])/g, (_match, space: string, index: string) => `사업${space}${Number(index) + 1}`)
    : summary)
  return <section className="space-y-4" aria-label={`실행 ${run.id} 결과`}>
      {run.inputRevision !== currentRevision && <p className={`${s.warning} mt-3`}>과거 입력 버전의 결과입니다. 현재 저장 입력(버전 {currentRevision})에 대한 결과가 아닙니다.</p>}
      {run.status === 'QUEUED' && <p role="status" className={`${s.warning} mt-3`}>분석 대기 중입니다. 처리 가능한 순서에 따라 시작하며 새로고침해도 작업은 유지됩니다.</p>}
      {run.status === 'RUNNING' && <p role="status" className={`${s.warning} mt-3`}>공식 문서 수집·분석 중입니다. 상태를 자동으로 확인하며 새 분석을 중복 실행하지 않습니다.</p>}
      {run.status === 'UNKNOWN' && <p role="status" className={`${s.warning} mt-3`}>분석 완료 여부를 확인할 수 없습니다. 중복 과금을 방지하기 위해 자동 재실행과 같은 검토의 새 분석을 차단했습니다. 운영자 확인이 필요합니다.</p>}
      {(run.status === 'FAILED' || run.status === 'INTERRUPTED') && <p className={`${s.warning} mt-3`}>{reviewRunFailureMessage(run.failureCode)}</p>}
    <p className={s.warning}>공식 원문 기준의 AI 분석이며 사람이 검수한 정답이 아닙니다. 제한을 찾지 못한 것은 허용을 뜻하지 않습니다. 범위 내 허용도 전체 신청 자격이나 동시 수혜를 보장하지 않습니다.</p>
    {run.analysis && <>
      <section className={`${s.card} space-y-3`} aria-label="두 사업의 중복 지원 검토 요약">
        <h2 className="text-lg font-bold">두 사업의 중복 지원 검토 요약</h2>
        <p className={s.muted}>선택한 두 사업을 함께 신청하거나 지원받을 때의 제한 사항을 요약한 내용입니다.</p>
        <p className="whitespace-pre-wrap text-sm leading-6">{displayedSummary}</p>
      </section>
      {run.analysis.pairs.map((pair) => {
        const pairKey = `${run.id}:${pair.firstProgramIndex}:${pair.secondProgramIndex}`
        const activeStage = pair.stages.find((stage) => selectedStage === `${pairKey}:${stage.stage}`) ?? pair.stages.find((stage) => stage.stage === reviewStages[0])!
        const activeKey = `${pairKey}:${activeStage.stage}`
        const citationsExpanded = expandedCitations === activeKey
        return <section className="space-y-4" key={pairKey}>
          <div><h3 className="font-bold">두 사업의 단계별 비교</h3><p className={s.muted}>신청부터 교부까지 여섯 단계의 판단을 비교합니다.</p></div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="tablist" aria-label="중복 지원 분석 단계">
            {reviewStages.map((stageName, index) => {
              const stage = pair.stages.find((value) => value.stage === stageName)!
              const stageKey = `${pairKey}:${stageName}`
              const active = activeKey === stageKey
              const judgmentTone = stage.judgment === 'RESTRICTION_APPLIES' ? 'bg-red-100 text-red-800'
                : stage.judgment === 'PERMISSION_IN_SCOPE' ? 'bg-emerald-100 text-emerald-800'
                  : stage.judgment === 'NEEDS_FACTS' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-900'
              return <button type="button" role="tab" aria-label={`${index + 1}단계 · ${stages[stage.stage]} · ${judgments[stage.judgment]}`} aria-selected={active} aria-controls={`review-stage-${pairKey}`} className={`rounded-xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-emerald-700 ${active ? 'border-emerald-600 bg-emerald-50 shadow-sm' : 'border-slate-200 bg-white hover:border-emerald-300'}`} key={stageName} onClick={() => { setSelectedStage(stageKey); if (!active) setExpandedCitations(null) }}>
                <span className="block text-xs font-bold text-slate-500">{index + 1}단계</span>
                <span className="mt-1 block text-base font-bold">{stages[stage.stage]}</span>
                <span className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${judgmentTone}`}>{judgments[stage.judgment]}</span>
              </button>
            })}
          </div>
          <article id={`review-stage-${pairKey}`} role="tabpanel" className={s.card} aria-label={`${stages[activeStage.stage]} 분석 결과`}>
            <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-lg font-bold">{stages[activeStage.stage]} 단계 분석</h4><strong>{judgments[activeStage.judgment]}</strong></div>
            {activeStage.requiresInstitutionConfirmation && <p className="font-semibold text-amber-800">기관 확인 필요 · 기관 해석 미확인 사항은 판단 보류</p>}
            <p className="whitespace-pre-wrap text-sm"><strong>판단 범위:</strong> {displayReviewText(activeStage.scope)}</p>
            <p className="whitespace-pre-wrap text-sm leading-6">{displayReviewText(activeStage.explanation)}</p>
            {activeStage.questions.length > 0 && <div className="text-sm"><strong>확인 질문</strong><ul className="mt-2 list-disc space-y-1 pl-5">{activeStage.questions.map((q, i) => <li key={i}>{displayReviewText(q)}</li>)}</ul></div>}
            {activeStage.citations.length > 0 && <div className="mt-4">
              <button type="button" className={s.button} aria-expanded={citationsExpanded} aria-controls={`review-citations-${activeKey}`} onClick={() => setExpandedCitations(citationsExpanded ? null : activeKey)}>
                {citationsExpanded ? '원문인용 접기' : '원문인용 확인하기'}
              </button>
              <div id={`review-citations-${activeKey}`} hidden={!citationsExpanded} className="mt-3 space-y-3">
                {activeStage.citations.map((citation, i) => {
                  const block = run.evidence?.blocks.find((b) => b.id === citation.evidenceId)
                  const documentIndex = run.evidence?.documents.findIndex((d) => d.rawHash === block?.documentHash && d.programIndex === block?.programIndex) ?? -1
                  return <blockquote className="border-l-4 border-emerald-700 bg-emerald-50 p-3 text-sm" key={i}>
                    <p className="whitespace-pre-wrap">{citation.quote}</p>
                    <p className="mt-2 break-all text-xs">{citation.evidenceId} · 사업 {(block?.programIndex ?? 0) + 1} · {block?.locator}</p>
                    {documentIndex >= 0 && <button type="button" className={`${s.button} mt-2`} disabled={downloading} onClick={() => download(documentIndex)}>인용 원본 다운로드</button>}
                  </blockquote>
                })}
              </div>
            </div>}
          </article>
        </section>
      })}
      <section className={s.warning}>
        <h3 className="font-bold">분석 한계</h3>
        <p className="mt-1 text-sm">입력한 참여 상태와 추가 사실, 자동 수집한 공식 원문의 범위를 바탕으로 AI가 확정할 수 없는 내용과 추가 확인 사항을 정리했습니다.</p>
        <ul className="mt-2 list-disc pl-5">{run.analysis.limitations.map((text, i) => <li key={i}>{displayReviewText(text)}</li>)}</ul>
      </section>
    </>}
    {run.evidence && <section className={s.card}>
      <h3 className="font-bold">공식 원문과 수집 범위</h3><p className={s.muted}>자동 수집 · 사람 미검수</p>
      <ul className="mt-3 space-y-3">{run.evidence.documents.map((doc, i) => <li className="break-all text-sm" key={i}>
        <strong>사업 {doc.programIndex + 1} · {doc.fileName}</strong> ({doc.format})<br />
        {doc.sourcePageUrl && <><a href={doc.sourcePageUrl} target="_blank" rel="noreferrer" className="text-emerald-800 underline">공식 공고 페이지 열기</a>{' · '}</>}
        <button className={s.button} type="button" disabled={downloading} onClick={() => download(i)}>수집 원본 다운로드</button>
      </li>)}</ul>
      <ul className="mt-4 list-disc pl-5 text-sm">{run.evidence.coverageWarnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>
    </section>}
  </section>
}
