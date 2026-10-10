import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { getEvaluation, getEvaluationReview, getRagMaterial, OpsApiError } from '../../../data/ops/opsApi'
import type { EvaluationRun, RagComparison } from '../../../data/ops/opsApi'
import { WorkspacePageHeader } from '../../shared/workspace/WorkspacePageHeader'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

type Comparison = NonNullable<EvaluationRun['comparison']>
type CaseMaterial = { id: string; question: string; document: string; expected: string; candidate: string | null; reference: string | null }
type Metric = { label: string; description: string; candidate: number | null; reference: number | null; unit?: 'ms' | 'tokens'; candidateCoverage?: string; referenceCoverage?: string }
const percent = (value: number | null) => value === null ? '미측정' : `${Number((value * 100).toFixed(1))}%`
const statusLabel = (value: string) => ({ ANSWERED: '답변 제공', INSUFFICIENT_EVIDENCE: '근거 부족으로 답변 보류' })[value] ?? value
const origins = {
  'synthetic-contract-check': '합성 데이터 · 실제 모델 실행 없음',
  'integration-stub-replay': '테스트 대역의 실행 기록',
  'recorded-live-evaluation': '실제 모델로 생성한 실행 기록',
  'recorded-capture-replay': '저장된 실행 기록 재평가',
}
const ragDescriptions = {
  retrievalRecallAtK: ['근거 검색 재현율', '기대 근거 청크 중 검색 결과에 포함된 비율입니다. 기대 근거가 있는 사례만 측정합니다.'],
  answerCitationRecall: ['답변 인용 재현율', '기대 근거 청크 중 답변이 인용한 비율입니다. 문장의 사실성이나 불필요한 인용까지 평가하지는 않습니다.'],
  answerStatusAccuracy: ['답변 상태 일치율', '답변 제공·근거 부족 판단이 참조 조건과 일치한 비율입니다. 답변 내용 전체의 정확도를 뜻하지 않습니다.'],
} as const
const fixedDescriptions = {
  statusAccuracy: ['답변 상태 일치율', '답변 제공·근거 부족 판단이 참조 조건과 일치한 비율입니다.'],
  referenceCitationRecall: ['답변 인용 재현율', '참조 조건에서 기대한 근거를 답변이 얼마나 인용했는지 나타냅니다.'],
  failureRate: ['실행 실패율', '평가 사례 중 실행 오류가 기록된 비율입니다. 낮을수록 실행 오류가 적습니다.'],
  missingRate: ['응답 누락률', '평가 사례 중 응답 기록이 없는 비율입니다.'],
  meanLatencyMs: ['평균 응답 시간', '저장된 응답 지연 시간의 평균입니다. 단위는 밀리초(ms)입니다.'],
  meanInputTokens: ['평균 입력 토큰', '기록된 입력 토큰 사용량의 평균입니다. 요금이 아닌 토큰 수입니다.'],
  meanOutputTokens: ['평균 출력 토큰', '기록된 출력 토큰 사용량의 평균입니다. 요금이 아닌 토큰 수입니다.'],
  semanticFaithfulness: ['의미 충실도', '답변의 의미가 근거에 충실한지 평가한 값입니다. 측정 기록이 없으면 미측정으로 표시합니다.'],
} as const

function metrics(comparison: Comparison): Metric[] {
  if (comparison.schema_version === 2) return comparison.metrics.map((item) => ({
    label: fixedDescriptions[item.key][0], description: fixedDescriptions[item.key][1],
    candidate: item.candidate, reference: item.reference,
    unit: item.key === 'meanLatencyMs' ? 'ms' : ['meanInputTokens', 'meanOutputTokens'].includes(item.key) ? 'tokens' : undefined,
  }))
  return (Object.keys(ragDescriptions) as Array<keyof typeof ragDescriptions>).map((key) => {
    const current = comparison.current.metrics[key], reference = comparison.reference.metrics[key]
    return {
      label: ragDescriptions[key][0], description: ragDescriptions[key][1], candidate: current.value, reference: reference.value,
      candidateCoverage: `${current.measuredCaseCount}건 측정 / 대상 ${current.eligibleCaseCount}건`,
      referenceCoverage: `${reference.measuredCaseCount}건 측정 / 대상 ${reference.eligibleCaseCount}건`,
    }
  })
}

export function EvaluationReport({ onExpired }: { onExpired: () => void }) {
  const { runId = '' } = useParams()
  const [run, setRun] = useState<EvaluationRun | null>(null)
  const [material, setMaterial] = useState<CaseMaterial[] | null>(null)
  const [dataType, setDataType] = useState<string | undefined>()
  const [error, setError] = useState('')
  const [materialError, setMaterialError] = useState('')
  const [reload, setReload] = useState(0)
  const expiry = useRef(onExpired); expiry.current = onExpired
  useEffect(() => {
    const controller = new AbortController()
    setRun(null); setMaterial(null); setDataType(undefined); setError(''); setMaterialError('')
    const read = async () => {
      let loaded = false
      try {
        const result = await getEvaluation(runId, controller.signal)
        if (controller.signal.aborted) return
        setRun(result); loaded = true
        if (result.status !== 'COMPLETED' || !result.comparison) return
        if (result.comparison.schema_version === 3) {
          const source = await getRagMaterial(runId, controller.signal)
          if (controller.signal.aborted) return
          setDataType(source.data_type)
          setMaterial(source.cases.map((item) => ({ id: item.case_id, question: item.question, document: item.document_id,
            expected: item.expected_status, candidate: item.candidate.answer, reference: item.reference.answer })))
        } else {
          const review = await getEvaluationReview(runId, controller.signal)
          if (controller.signal.aborted) return
          if (!review.material) { setMaterialError(review.material_error || '저장된 질문·답변 자료가 없습니다.'); return }
          setDataType(review.material.data_type)
          setMaterial(review.material.cases.map((item) => ({ id: item.case_id, question: item.question, document: item.document_title,
            expected: item.expected_status, candidate: item.answer, reference: item.reference_answer })))
        }
      } catch (reason) {
        if (controller.signal.aborted) return
        if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) { expiry.current(); return }
        const message = reason instanceof Error ? reason.message : '보고서를 불러오지 못했습니다.'
        if (loaded) setMaterialError(message)
        else setError(message)
      }
    }
    void read()
    return () => controller.abort()
  }, [runId, reload])
  const comparison = run?.status === 'COMPLETED' ? run.comparison : null
  const detailPath = `/ops/evaluations/${runId}`
  return <>
    <WorkspacePageHeader title="Evidently 평가 보고서" parent={{ to: detailPath, label: '평가 상세' }}
      actions={<button className={styles.secondaryButton} onClick={() => setReload((value) => value + 1)}>보고서 새로고침</button>} />
    <div className={styles.content}>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {!run && !error && <p role="status">저장된 평가 결과를 불러오고 있습니다.</p>}
      {run && <>
        <section className={styles.card} aria-label="평가 대상">
          <p className="text-xs font-bold text-brand-primary">저장 결과 조회 · 새 모델 호출 없음</p>
          <h2 className="text-xl font-bold break-words">{run.dataset_label}</h2>
          <p className="text-sm leading-6">{comparison?.schema_version === 3
            ? '고정해 둔 공고 원문·청크에서 근거를 검색하고 답변한 결과입니다. 실시간 공고 검색 전체나 운영 색인의 성능을 측정한 자료는 아닙니다.'
            : comparison?.schema_version === 2 ? '고정된 근거를 제공했을 때의 답변 평가입니다. 검색·임베딩 성능은 이 보고서에 포함되지 않습니다.' : '저장된 평가 실행의 보고서입니다.'}</p>
          <p className="text-sm text-ink-muted">평가 사례 {comparison ? `${comparison.case_ids.length}건 · ${comparison.case_ids.join(', ')}` : '확인 불가'} · 실행 상태 {run.status_label}</p>
          <p className="text-xs text-ink-muted">완료 시각 {run.finished_at ? new Date(run.finished_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' (서울)' : '기록 없음'} · 원문 자료 {dataType === 'official-html-snapshot' ? '공식 공고 HTML 스냅샷' : dataType === 'synthetic' ? '합성 자료' : materialError || !comparison ? '확인 불가' : material ? '유형 미기록' : '확인 중'}</p>
          <p className="text-xs break-all text-ink-muted">실행 ID: {run.id}</p>
        </section>
        {comparison ? <>
          <section aria-label="비교 데이터 안내" className={styles.card}>
            <h2 className={styles.cardTitle}>무엇을 비교하나요?</h2>
            <p className="text-sm">후보(Current)는 이번에 확인할 답변 기록, 비교 대상(Reference)은 함께 선택한 기록입니다. 비교 대상이라는 이유만으로 사람이 승인한 정답이나 운영 기준이 되지는 않습니다.</p>
            <div className="grid gap-3 md:grid-cols-2">
              {(['candidate', 'reference'] as const).map((side) => {
                const rag = comparison.schema_version === 3 ? (side === 'candidate' ? comparison.current : comparison.reference) : null
                const fixed = comparison.schema_version === 2 ? (side === 'candidate' ? comparison.candidate_execution : comparison.reference_execution) : null
                return <div key={side} className={`rounded-xl border p-4 ${side === 'candidate' ? 'border-brand-primary/20 bg-brand-soft' : 'border-line bg-surface-muted'}`}>
                  <h3 className="text-sm font-bold">{side === 'candidate' ? '후보 · Current' : '비교 대상 · Reference'}</h3>
                  <p className="mt-2 text-sm break-words">{side === 'candidate' ? run.candidate_label : run.reference_label}</p>
                  {rag && <p className="mt-1 text-xs">{origins[rag.measurementKind]}</p>}
                  <p className="mt-3 text-sm">답변 모델: {rag?.execution.model ?? fixed?.model ?? '기록 없음'}</p>
                  {rag && <p className="text-xs text-ink-muted">임베딩 모델: {rag.execution.embeddingModel ?? '기록 없음'}</p>}
                  {fixed?.started_at && <p className="text-xs text-ink-muted">응답 생성: {new Date(fixed.started_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (서울)</p>}
                </div>
              })}
            </div>
            {comparison.comparison === 'self-replay' && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">동일한 저장 기록끼리의 재현 확인입니다. 모델 개선 전후의 비교가 아닙니다.</p>}
            {comparison.schema_version === 3 && [comparison.current, comparison.reference].some((value) => ['synthetic-contract-check', 'integration-stub-replay'].includes(value.measurementKind)) && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">합성 데이터 또는 테스트 대역이 포함되어 있습니다. 실패율이나 점수 차이를 실제 모델의 성능 개선으로 해석할 수 없습니다.</p>}
          </section>
          <section aria-label="지표 해설" className={styles.card}>
            <h2 className={styles.cardTitle}>점수는 무엇을 뜻하나요?</h2>
            <p className="text-sm text-ink-muted">미측정은 0점이 아닙니다. 점수는 측정된 사례의 평균이므로 측정 건수와 실행 실패를 함께 확인하세요. 품질 합격과 사람 검토는 평가 상세에서 별도로 확인합니다.</p>
            <div className="grid gap-4 md:grid-cols-3">{metrics(comparison).map((item) => <MetricCard key={item.label} metric={item} />)}</div>
            {comparison.schema_version === 3 ? <RagExecution comparison={comparison} /> : <p className="text-xs text-ink-muted">이 형식의 기록에는 지표별 측정 건수가 없습니다. 전체 사례 수를 모든 지표의 표본 수로 해석하지 마세요.</p>}
          </section>
          <section aria-label="평가 질문과 답변" className={styles.card}>
            <h2 className={styles.cardTitle}>어떤 질문으로 평가했나요?</h2>
            <p className="text-sm text-ink-muted">사례를 펼치면 저장된 답변을 볼 수 있습니다. 참조 조건과의 일치가 사실성에 대한 사람의 승인을 뜻하지는 않습니다.</p>
            {materialError && <p role="alert" className="text-sm text-red-700">질문·답변 조회 실패: {materialError} 위 지표는 별도로 조회된 기록입니다. 보고서 새로고침으로 다시 확인할 수 있습니다.</p>}
            {!material && !materialError && <p role="status">질문·답변을 불러오고 있습니다.</p>}
            {comparison.case_ids.map((id) => {
              const source = material?.find((item) => item.id === id)
              const rag = comparison.schema_version === 3 ? comparison.current.cases.find((item) => item.caseId === id) : null
              const fixed = comparison.schema_version === 2 ? comparison.cases.find((item) => item.case_id === id)?.candidate : null
              return <details key={id} className="rounded-xl border border-line p-4">
                <summary className="cursor-pointer text-sm font-semibold leading-6"><span className="mr-2 text-brand-primary">{id}</span>{source?.question ?? '질문 자료 확인 필요'}</summary>
                <div className="mt-3 space-y-3 text-sm leading-6">
                  {source && <p className="text-ink-muted">공고: {source.document} · 예상 판단: {statusLabel(source.expected)}</p>}
                  {rag && <p>후보 검색 재현율 {percent(rag.retrievalRecallAtK)} · 인용 재현율 {percent(rag.answerCitationRecall)} · 상태 판단 {rag.answerStatusMatches === null ? '미측정' : rag.answerStatusMatches ? '참조와 일치' : '참조와 불일치'}<br />실행: {rag.failure ? `실패 (${rag.failure.stage} · ${rag.failure.code})` : '실패 기록 없음'}</p>}
                  {fixed && <p>후보 실행: {({ success: '응답 기록 있음', error: '실행 오류', missing: '응답 누락' })[fixed.outcome]} · 상태 일치 {percent(fixed.status_match)} · 인용 재현율 {percent(fixed.citation_recall)}</p>}
                  {source && <div className="grid gap-3 xl:grid-cols-2">{([['후보 답변', source.candidate], ['비교 대상 답변', source.reference]] as const).map(([label, answer]) => <div key={label} className="rounded-lg bg-surface-muted p-3"><h3 className="mb-2 font-bold">{label}</h3><p className="whitespace-pre-wrap break-words">{answer || '저장된 답변 없음'}</p></div>)}</div>}
                </div>
              </details>
            })}
            <Link className={styles.quietLink} to={detailPath}>평가 상세에서 원문·검토 상태 확인 →</Link>
          </section>
        </> : <p role="status">{run.status !== 'COMPLETED' ? '아직 완료된 평가 보고서가 없습니다.' : '이 실행에는 지표 해설에 필요한 비교 기록이 없습니다. 제공되는 원본 보고서에서 확인해 주세요.'}</p>}
        {run.status === 'COMPLETED' && run.report_url && <section className={styles.card} aria-label="Evidently 원본 차트">
          <h2 className={styles.cardTitle}>Evidently 원본 차트</h2>
          <p className="text-sm">Current는 후보, Reference는 비교 대상이며 Row count는 평가 사례 수입니다. Mean은 해당 지표의 평균입니다.</p>
          {comparison?.schema_version === 3 && <p className="text-sm">failed의 0은 실패 없음, 1은 실행 실패입니다. Mean이 0이면 실패율 0%이며 답변 정확도 100%를 뜻하지 않습니다. 양쪽 모두 측정값이 있는 지표만 담긴 원본에는 일부 점수 차트가 없을 수 있습니다. 위 해설에서는 후보만 측정된 점수도 표시합니다.</p>}
          <div><a className={styles.secondaryButton} href={run.report_url} target="_blank" rel="noopener noreferrer">원본 차트 새 탭에서 보기 ↗</a></div>
        </section>}
      </>}
    </div>
  </>
}

function MetricCard({ metric }: { metric: Metric }) {
  const format = (value: number | null) => value === null ? '미측정' : metric.unit ? `${value.toLocaleString('ko-KR', { maximumFractionDigits: 1 })} ${metric.unit === 'tokens' ? '토큰' : 'ms'}` : percent(value)
  return <article aria-label={metric.label} className="flex flex-col gap-3 rounded-xl border border-line p-4">
    <h3 className="font-bold">{metric.label}</h3>
    <p className="min-h-16 text-sm leading-6 text-ink-muted">{metric.description}</p>
    <div className="mt-auto rounded-lg bg-brand-soft p-3"><span className="text-xs font-semibold">후보</span><p className="mt-1 text-3xl font-bold tabular-nums text-brand-primary">{format(metric.candidate)}</p>{metric.candidateCoverage && <p className="mt-1 text-xs">{metric.candidateCoverage}</p>}</div>
    <p className="text-sm text-ink-muted">비교 대상 <strong className="ml-1 text-ink">{format(metric.reference)}</strong>{metric.referenceCoverage && <span className="mt-1 block text-xs">{metric.referenceCoverage}</span>}</p>
  </article>
}

function RagExecution({ comparison }: { comparison: RagComparison }) {
  return <div className="rounded-xl bg-surface-muted p-4 text-sm">
    <h3 className="mb-2 font-bold">실행 도달 범위 · 점수와 별도로 확인</h3>
    {([['후보', comparison.current], ['비교 대상', comparison.reference]] as const).map(([label, report]) => <p key={label} className="leading-7">{label}: 전체 {report.caseCount}건 중 검색 도달 {report.coverage.retrievalCaseCount}건 · 답변 도달 {report.coverage.answerCaseCount}건 · 실패 {report.coverage.failedCaseCount}건</p>)}
    <p className="mt-2 text-xs text-ink-muted">실패가 없어도 답변이 정확하거나 모든 근거를 찾았다는 뜻은 아닙니다.</p>
  </div>
}
