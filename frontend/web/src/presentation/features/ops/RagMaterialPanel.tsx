import { useEffect, useRef, useState } from 'react'
import { getRagMaterial, OpsApiError, type RagMaterial } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'

const origins = {
  'synthetic-contract-check': '합성 결과 · 실제 모델 측정 아님',
  'integration-stub-replay': '무료 모델 대역의 실행 기록',
  'recorded-capture-replay': '저장된 모델 실행 기록',
}
const stages = { not_started: '미실행', source: '원문', chunk: '청킹', index: '색인', search: '검색', answer: '답변' }
const statuses = { ANSWERED: '답변 있음', INSUFFICIENT_EVIDENCE: '근거 부족' }
type Case = RagMaterial['cases'][number]
type Props = { runId: string; onExpired: () => void }

function Observation({ label, value, item }: { label: string; value: Case['candidate']; item: Case }) {
  const chunkLabel = (id: string) => {
    const chunk = item.chunks.find((chunk) => chunk.id === id)
    return chunk ? `청크 ${chunk.order + 1}` : id
  }
  return <article className="min-w-0 rounded-xl border border-sample-border p-4" aria-label={`${label} 답변과 근거`}>
    <h3 className="font-semibold">{label}</h3>
    <p className="text-sm">{value.failure ? `${stages[value.failure.stage]} 실패 · ${value.failure.code}` : '답변 도달'}</p>
    <p className="text-sm">답변 상태: {value.answer_status ? statuses[value.answer_status] : '미실행 또는 미확인'}</p>
    <p className="my-3 whitespace-pre-wrap break-words">{value.answer ?? '저장된 답변 없음'}</p>
    {([
      ['검색 순서', value.retrieved_chunk_ids], ['답변 입력 순서', value.context_chunk_ids], ['인용 근거', value.cited_chunk_ids],
    ] as const).map(([title, ids]) => <p key={title} className="text-sm break-words"><strong>{title}:</strong> {ids === null ? '미실행 또는 미확인' : ids.length ? ids.map(chunkLabel).join(' → ') : '없음'}</p>)}
    <p className="mt-2 break-all text-xs">원본 trace: {value.trace_id ?? '없음'}</p>
  </article>
}

function Material({ runId, onExpired }: Props) {
  const [material, setMaterial] = useState<RagMaterial | null>(null)
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const read = async () => {
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    setBusy(true); setError(''); setMaterial(null)
    try {
      const value = await getRagMaterial(runId, request.signal)
      if (!request.signal.aborted) { setMaterial(value); setSelected(0) }
    } catch (cause) {
      if (request.signal.aborted) return
      if (cause instanceof OpsApiError && [401, 403].includes(cause.status)) { onExpired(); return }
      setError(cause instanceof Error ? cause.message : '검토 자료를 불러올 수 없습니다.')
    } finally {
      if (!request.signal.aborted) setBusy(false)
    }
  }
  const item = material?.cases[selected]
  return <section className={styles.card} aria-label="RAG 사례 검토 자료" aria-busy={busy}>
    <h2 className={styles.cardTitle}>RAG 사례 검토 자료</h2>
    <p className="text-sm">접수 당시 고정한 원문·청크와 저장된 답변을 대조합니다. 조회 시 모델 호출은 없습니다.</p>
    <p className="text-sm">AI 작성 참조 조건 · 미검토. 이 화면의 조회는 검토 저장이나 품질 합격이 아니며, 기준으로 지정할 수 없습니다.</p>
    <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void read()}>{busy ? '불러오는 중…' : material ? '검토 자료 새로고침' : '검토 자료 보기'}</button>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {material && item && <div className="space-y-4">
      <p className="text-sm">후보: {origins[material.candidate_measurement_kind]} · 비교: {origins[material.reference_measurement_kind]}</p>
      <label className="block text-sm font-semibold">검토 사례
        <select className="mt-1 w-full rounded-lg border border-sample-border p-2" value={selected} onChange={(event) => setSelected(Number(event.target.value))}>
          {material.cases.map((value, index) => <option key={value.case_id} value={index}>{value.case_id} · {value.question}</option>)}
        </select>
      </label>
      <p className="font-semibold whitespace-pre-wrap">{item.question}</p>
      <div className="grid gap-3 lg:grid-cols-2"><Observation label="후보" value={item.candidate} item={item} /><Observation label="비교" value={item.reference} item={item} /></div>
      <details><summary className="cursor-pointer font-semibold">고정 원문 · {item.document_id}</summary>
        <p className="break-all text-xs">원본 주소: {item.source_url}</p>
        <p className="break-all text-xs">원문 SHA-256: {item.content_sha256}</p>
        <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words p-3 text-sm">{item.content}</pre>
      </details>
      <div><h3 className="font-semibold">고정 청크 · {item.chunk_version}</h3>
        {item.chunks.map((chunk) => <details key={chunk.id} className="border-b border-sample-border py-2">
          <summary className="cursor-pointer text-sm">청크 {chunk.order + 1} · {([
            ['후보', item.candidate], ['비교', item.reference],
          ] as const).map(([label, value]) => `${label}: ${value.retrieved_chunk_ids === null ? '검색 미확인' : value.retrieved_chunk_ids.includes(chunk.id) ? '검색됨' : '검색되지 않음'} / ${value.cited_chunk_ids === null ? '인용 미확인' : value.cited_chunk_ids.includes(chunk.id) ? '인용됨' : '인용되지 않음'}`).join(' · ')}</summary>
          <p className="break-all text-xs">{chunk.id}</p><p className="whitespace-pre-wrap break-words text-sm">{chunk.text}</p>
        </details>)}
      </div>
      <details><summary className="cursor-pointer font-semibold">AI 작성 참조 조건 · 사람 검토 전</summary>
        <p className="text-sm">예상 상태: {statuses[item.expected_status]}</p>
        {item.expected_evidence.length ? item.expected_evidence.map((expected, index) => <blockquote key={index} className="my-2 border-l-2 pl-3 text-sm">
          <p className="break-all text-xs">참조 청크: {expected.chunk_id}</p><p className="whitespace-pre-wrap">{expected.quote}</p>
        </blockquote>) : <p className="text-sm">지정된 참조 인용 없음</p>}
      </details>
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
