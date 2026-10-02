import type { RagComparison } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

const origins = {
  'synthetic-contract-check': '합성 결과 재계산 · 실제 모델 품질 측정 아님',
  'integration-stub-replay': '무료 모델 대역의 실행 기록 재계산',
  'recorded-live-evaluation': '새 임베딩·검색·답변 실행 · 고정 원문·청크',
  'recorded-capture-replay': '저장된 실행 기록 재계산 · 새 모델 호출 없음',
}
const stages = { not_started: '미실행', source: '원문', chunk: '청킹', index: '색인', search: '검색', answer: '답변' }
const metricLabels = { retrievalRecallAtK: '검색 재현율', answerCitationRecall: '답변 인용 재현율', answerStatusAccuracy: '답변 상태 일치율' }
const measure = (value: number | null) => value === null ? '미측정' : value.toFixed(2)

export function RagComparisonResult({ comparison }: { comparison: RagComparison }) {
  const current = comparison.current
  return <section className={styles.card} aria-label="RAG 기준·후보 비교">
    <h2 className={styles.cardTitle}>RAG 검색·답변 결과 비교</h2>
    <p>{origins[current.measurementKind]}</p>
    <p className="text-sm">{comparison.comparison === 'self-replay' ? '같은 저장 캡처의 재현 검증입니다.' : '기준과 후보의 저장 캡처를 비교합니다.'} {current.liveExecutionPerformed ? '새 모델 실행 결과입니다. 호출 수와 예산 정산은 실행 상세에서 확인하세요. 원문 재수집·재청킹 및 운영 색인 성능은 측정하지 않습니다.' : '이번 재계산의 모델 API 호출은 0회입니다.'}</p>
    <p className="text-sm">원본 답변 도달 {current.coverage.answerCaseCount} / {current.caseCount}건 · 검색 도달 {current.coverage.retrievalCaseCount} / {current.caseCount}건 · 원본 실패 {current.coverage.failedCaseCount}건</p>
    <p className="text-sm">원본 실행 상태: {current.completed ? '모든 사례 답변 도달' : '실패 또는 미실행 사례 포함'}. 재계산 완료는 원본 실행 성공이나 품질 합격을 뜻하지 않습니다.</p>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['지표', '기준 (측정 / 대상)', '후보 (측정 / 대상)', '변화량'].map((label) => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>
      {(Object.keys(metricLabels) as Array<keyof typeof metricLabels>).map((key) => {
        const before = comparison.reference.metrics[key], after = current.metrics[key]
        return <tr key={key}><th className="p-2">{metricLabels[key]}</th><td>{measure(before.value)} ({before.measuredCaseCount} / {before.eligibleCaseCount})</td><td>{measure(after.value)} ({after.measuredCaseCount} / {after.eligibleCaseCount})</td><td>{before.value === null || after.value === null ? '비교 불가' : measure(after.value - before.value)}</td></tr>
      })}
    </tbody></table></div>
    <p className="text-xs">평균은 측정된 사례 기준입니다. 실패 수와 대상 수를 함께 확인하세요. 인용 재현율만으로 의미 정확성이나 과잉 인용을 판단할 수 없습니다. 비교 기준 지정에는 실제 모델 기록과 별도의 사람 검토·품질 합격이 필요합니다.</p>
    <div className="grid gap-3 md:grid-cols-2">{([['기준', comparison.reference], ['후보', current]] as const).map(([label, report]) => <div key={label} className="rounded-xl bg-[#f3f7f5] p-3 text-xs break-all">
      <strong>{label} 기록</strong><p>{origins[report.measurementKind]}</p>
      <p>답변 모델: {report.execution.model ?? '실행 없음'}</p><p>임베딩 모델: {report.execution.embeddingModel ?? '실행 없음'}</p>
      <p>자료: {report.fixtureSha256}</p><p>캡처: {report.captureSha256}</p><p>프롬프트: {report.execution.promptSha256 ?? '실행 없음'}</p>
    </div>)}</div>
    <details><summary className="cursor-pointer font-semibold">사례별 검색·인용·실패</summary>
      {current.cases.map((item) => <article key={item.caseId} className="border-b border-sample-border py-3 text-sm break-all">
        <strong>{item.caseId}</strong><p>검색 재현율 {measure(item.retrievalRecallAtK)} · 답변 인용 재현율 {measure(item.answerCitationRecall)}</p>
        <p>{item.failure ? `${stages[item.failure.stage]} 실패 · ${item.failure.code}` : '답변 도달'}</p>
        <p>검색 근거: {item.retrievedChunkIds?.join(', ') ?? '미측정'}</p><p>인용 근거: {item.citedChunkIds?.join(', ') ?? '미측정'}</p>
      </article>)}
    </details>
  </section>
}
