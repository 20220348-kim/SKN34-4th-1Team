import { useEffect, useRef, useState } from 'react'
import { getRagReviews, OpsApiError, type RagMaterial, type RagReviewState } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'
import { RagCaseReviewForm } from './RagCaseReviewForm'
import { RagQualityPanel } from './RagQualityPanel'
import { RagReferenceReviewPanel } from './RagReferenceReviewPanel'

const origins = {
  'synthetic-contract-check': '합성 결과 · 실제 모델 측정 아님',
  'integration-stub-replay': '무료 모델 대역의 실행 기록',
  'recorded-live-evaluation': '새 임베딩·검색·답변 실행 기록',
  'recorded-capture-replay': '저장된 모델 실행 기록',
}
const stages = { not_started: '미실행', source: '원문', chunk: '청킹', index: '색인', search: '검색', answer: '답변' }
const statuses = { ANSWERED: '답변 있음', INSUFFICIENT_EVIDENCE: '근거 부족' }
type Case = RagMaterial['cases'][number]
type Props = { runId: string; onExpired: () => void; onReviewChanged?: () => void }

function Observation({ label, value, item }: { label: string; value: Case['candidate']; item: Case }) {
  const chunkLabel = (id: string) => {
    const chunk = item.chunks.find((chunk) => chunk.id === id)
    return chunk ? `청크 ${chunk.order + 1}` : id
  }
  return <article className="min-w-0 rounded-xl border border-line p-4" aria-label={`${label} 답변과 근거`}>
    <h3 className="font-semibold">{label}</h3>
    <p className="text-sm">{value.failure?.stage === 'not_started' ? '아직 실행하지 않은 기록 · 품질 비교 기준 아님' : value.failure ? `${stages[value.failure.stage]} 실패 · ${value.failure.code}` : '답변 도달'}</p>
    <p className="text-sm">답변 상태: {value.answer_status ? statuses[value.answer_status] : '미실행 또는 미확인'}</p>
    <p className="my-3 whitespace-pre-wrap break-words">{value.answer ?? '저장된 답변 없음'}</p>
    {([
      ['검색 순서', value.retrieved_chunk_ids], ['답변 입력 순서', value.context_chunk_ids], ['인용 근거', value.cited_chunk_ids],
    ] as const).map(([title, ids]) => <p key={title} className="text-sm break-words"><strong>{title}:</strong> {ids === null ? '미실행 또는 미확인' : ids.length ? ids.map(chunkLabel).join(' → ') : '없음'}</p>)}
    <p className="mt-2 break-all text-xs">원본 trace: {value.trace_id ?? '없음'}</p>
  </article>
}

function Material({ runId, onExpired, onReviewChanged }: Props) {
  const [state, setState] = useState<RagReviewState | null>(null)
  const [locked, setLocked] = useState(false)
  const [qualityBusy, setQualityBusy] = useState(false)
  const [referenceDirty, setReferenceDirty] = useState(false)
  const [referenceBusy, setReferenceBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const material = state?.material
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const read = async () => {
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    setBusy(true); setError(''); setState(null); setSaved(false); setLocked(false)
    try {
      const value = await getRagReviews(runId, request.signal)
      if (!request.signal.aborted) { setState(value); setSelected(0) }
    } catch (cause) {
      if (request.signal.aborted) return
      if (cause instanceof OpsApiError && [401, 403].includes(cause.status)) { onExpired(); return }
      setError(cause instanceof Error ? cause.message : '검토 자료를 불러올 수 없습니다.')
    } finally {
      if (!request.signal.aborted) setBusy(false)
    }
  }
  const item = material?.cases[selected]
  const currentReview = (caseId: string) => state?.case_reviews.find((row) => row.case_id === caseId && row.is_current
    && row.material_sha256 === material?.material_sha256 && row.rubric_version === state.rubric.version)
  const reviewedCount = material?.cases.filter((item) => currentReview(item.case_id)).length ?? 0
  const suitableCount = material?.cases.filter((item) => {
    const review = currentReview(item.case_id)
    return review?.retrieval_decision === 'SUITABLE' && review.answer_decision === 'SUITABLE' && review.citation_decision === 'SUITABLE'
  }).length ?? 0
  const selectCase = (index: number) => { setSelected(index); setSaved(false) }

  return <section className={styles.card} aria-label="RAG 사례 검토 자료" aria-busy={busy}>
    <h2 className={styles.cardTitle}>RAG 사례 검토 자료</h2>
    <p className="text-sm">접수 당시 고정한 원문·청크와 저장된 답변을 대조합니다. 조회 시 모델 호출은 없습니다.</p>
    <p className="text-sm">AI 작성 참조 조건과 사람의 사례 검토는 별도로 관리합니다. 실제 기록은 전체 자료 승인과 사례별 적합 검토 후 품질 합격·비교 기준 지정을 진행할 수 있습니다.</p>
    <button type="button" className={styles.secondaryButton} disabled={busy || locked || qualityBusy || referenceDirty || referenceBusy} onClick={() => void read()}>{busy ? '불러오는 중…' : material ? '검토 자료 새로고침' : '검토 자료 보기'}</button>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {state && material && item && <div className="space-y-4">
      <section aria-label="RAG 검토 진행 안내" className="grid gap-3 rounded-xl border border-brand-primary/20 bg-[#f3f7f5] p-5 text-sm">
        <h3 className="font-bold">검토 진행 안내</h3>
        <p className="font-semibold">사례 검토 저장 {reviewedCount} / {material.cases.length}건 · 검색·답변·인용 모두 적합 {suitableCount}건</p>
        <progress className="h-2 w-full accent-brand-primary" aria-label="RAG 사례 검토 진행률" value={reviewedCount} max={material.cases.length} />
        <p>자료 승인: {state.reference_review.approved ? '완료' : '필요'} · 품질 판정: {state.quality.is_current ? { NOT_EVALUATED: '미판정', NEEDS_REVIEW: '검토 필요', FAIL: '부적합', PASS: '합격' }[state.quality.status] : '현재 검토로 재판정 필요'} · 비교 기준: {state.baseline.selected ? '지정됨' : '미지정'}</p>
        <p>{!state.reference_review.approved ? '다음 할 일: 각 사례의 원문과 참조 조건을 확인하고 자료 검토를 저장하세요.' : reviewedCount < material.cases.length ? '다음 할 일: 미검토 사례의 검색·답변·인용을 판단하고 사유를 저장하세요.' : suitableCount < material.cases.length ? '부적합·보류 사례가 있습니다. 품질 점검에서 사유를 확인하세요. 합격을 위해 판단을 바꿀 필요는 없습니다.' : !state.baseline.selected ? '다음 할 일: 품질 점검 결과를 확인하고 조건이 충족되면 비교 기준을 지정하세요.' : '현재 자료의 비교 기준 지정까지 완료했습니다.'}</p>
        <nav aria-label="RAG 검토 위치" className="flex flex-wrap gap-2">
          <a href="#rag-case-review" className={styles.secondaryButton}>사례 확인</a>
          <a href="#rag-reference-review" className={styles.secondaryButton}>자료 검토</a>
          <a href="#rag-quality-review" className={styles.secondaryButton}>품질·기준 확인</a>
        </nav>
      </section>
      {material.data_type === 'official-html-snapshot' && <p className="text-sm">실제 공고의 저장된 HTML 본문입니다. 첨부파일은 포함하지 않습니다. 문단 단위로 나눈 평가용 청크이며, 기존 고정 근거 답변의 검토 승인은 이 RAG 결과에 적용되지 않습니다.</p>}
      <p className="text-sm">후보: {origins[material.candidate_measurement_kind]} · 비교: {origins[material.reference_measurement_kind]}</p>
      <label id="rag-case-review" className="block scroll-mt-28 text-sm font-semibold">검토 사례
        <select className="mt-1 w-full rounded-lg border border-line p-2" value={selected} disabled={locked || qualityBusy || referenceBusy} onChange={(event) => selectCase(Number(event.target.value))}>
          {material.cases.map((value, index) => <option key={value.case_id} value={index}>{value.case_id} · {currentReview(value.case_id) ? '검토 저장됨' : '미검토'} · {value.question}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={styles.secondaryButton} disabled={locked || qualityBusy || referenceBusy || selected === 0} onClick={() => selectCase(selected - 1)}>이전 사례</button>
        <span className="text-sm tabular-nums">{selected + 1} / {material.cases.length}번째 사례</span>
        <button type="button" className={styles.secondaryButton} disabled={locked || qualityBusy || referenceBusy || selected === material.cases.length - 1} onClick={() => selectCase(selected + 1)}>다음 사례</button>
      </div>
      <p className="font-semibold whitespace-pre-wrap">{item.question}</p>
      <div className="grid gap-3 lg:grid-cols-2"><Observation label="후보" value={item.candidate} item={item} /><Observation label="비교" value={item.reference} item={item} /></div>
      <details><summary className="cursor-pointer font-semibold">고정 원문 · {item.document_id}</summary>
        {item.source_collected_at && <p className="text-sm">원문 수집 시각: {item.source_collected_at}</p>}
        <p className="break-all text-xs">원본 주소: {item.source_url}</p>
        <p className="break-all text-xs">원문 SHA-256: {item.content_sha256}</p>
        <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words p-3 text-sm">{item.content}</pre>
      </details>
      <div><h3 className="font-semibold">고정 청크 · {item.chunk_version}</h3>
        {item.chunks.map((chunk) => <details key={chunk.id} className="border-b border-line py-2">
          <summary className="cursor-pointer text-sm">청크 {chunk.order + 1} · {([
            ['후보', item.candidate], ['비교', item.reference],
          ] as const).map(([label, value]) => `${label}: ${value.retrieved_chunk_ids === null ? '검색 미확인' : value.retrieved_chunk_ids.includes(chunk.id) ? '검색됨' : '검색되지 않음'} / ${value.cited_chunk_ids === null ? '인용 미확인' : value.cited_chunk_ids.includes(chunk.id) ? '인용됨' : '인용되지 않음'}`).join(' · ')}</summary>
          <p className="break-all text-xs">{chunk.id}</p><p className="whitespace-pre-wrap break-words text-sm">{chunk.text}</p>
        </details>)}
      </div>
      <details><summary className="cursor-pointer font-semibold">AI 작성 참조 조건</summary>
        <p className="text-sm">예상 상태: {statuses[item.expected_status]}</p>
        {item.expected_evidence.length ? item.expected_evidence.map((expected, index) => <blockquote key={index} className="my-2 border-l-2 pl-3 text-sm">
          <p className="break-all text-xs">참조 청크: {expected.chunk_id}</p><p className="whitespace-pre-wrap">{expected.quote}</p>
        </blockquote>) : <p className="text-sm">지정된 참조 인용 없음</p>}
      </details>
      {saved && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-brand-primary">사례 검토가 저장되었습니다. 품질 점검은 새 검토를 반영해 별도로 저장하세요.</p>}
      <RagCaseReviewForm key={`${item.case_id}:${state.review_version}:${material.material_sha256}`} runId={runId} item={item} state={state} disabled={qualityBusy || referenceDirty || referenceBusy} onExpired={onExpired} onLock={(value) => { setLocked(value); if (value) setSaved(false) }} onSaved={(value) => { setState(value); setSaved(true); onReviewChanged?.() }} />
      <div id="rag-reference-review" className="scroll-mt-28"><RagReferenceReviewPanel key={`${runId}:${state.review_version}:${material.fixture_sha256}`} runId={runId} state={state} disabled={locked || qualityBusy} onDirty={setReferenceDirty} onBusy={setReferenceBusy} onSaved={(value) => { setState(value); setReferenceDirty(false); setReferenceBusy(false); setSaved(false); onReviewChanged?.() }} onExpired={onExpired} /></div>
      <div id="rag-quality-review" className="scroll-mt-28"><RagQualityPanel key={`${runId}:${state.quality.input_sha256}`} runId={runId} state={state} disabled={locked || busy || referenceDirty || referenceBusy} onBusy={setQualityBusy} onSaved={(value) => { setState(value); setQualityBusy(false); setSaved(false); onReviewChanged?.() }} onExpired={onExpired} /></div>
      <details className="break-all text-xs"><summary className="cursor-pointer">자료 무결성 정보</summary>
        <p>검토 자료: {material.material_sha256}</p><p>평가 자료: {material.fixture_sha256}</p>
        <p>후보 캡처: {material.candidate_capture_sha256}</p><p>비교 캡처: {material.reference_capture_sha256}</p>
      </details>
    </div>}
  </section>
}

export function RagMaterialPanel(props: Props) {
  return <Material key={props.runId} {...props} />
}
