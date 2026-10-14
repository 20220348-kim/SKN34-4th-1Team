import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { getProductionQuality, getProductionRegressionCandidate, getProductionSample, OpsApiError, productionScopes, saveProductionRegressionCandidate, saveProductionReview } from '../../../data/ops/opsApi'
import type { ProductionQuality, ProductionReviewInput, ProductionSample, ProductionScope } from '../../../data/ops/opsApi'
import { workspacePageStyles as styles } from '../../shared/workspace/WorkspacePage.styles'
import { WorkspacePageHeader } from '../../shared/workspace/WorkspacePageHeader'

const field = 'min-h-11 w-full rounded-xl border border-line bg-white px-3 py-2 text-sm focus:outline-2 focus:outline-brand-primary'
const date = (value: string) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
const verdict = (value: ProductionSample['review']) => value ? ({ acceptable: '적합', issue: '문제 있음', unassessable: '판단 보류' })[value.verdict] : '미검토'
const checkStatus = { pending: '구조 검사 대기', checked: '구조 검사 완료', error: '구조 검사 오류' }
const checkLabels: Record<string, string> = {
  CONTEXT_NOT_CAPTURED: '검토할 입력·근거가 저장되지 않음',
  CONTEXT_TRUNCATED: '저장 용량 제한으로 입력·근거 일부 생략',
  OUTPUT_TRUNCATED: '저장 용량 제한으로 결과 일부 생략',
  CITATION_NOT_IN_CONTEXT: '저장된 근거에 없는 인용 포함',
  ANSWER_WITHOUT_CITATION: '답변에 근거 인용 없음',
  INSUFFICIENT_WITH_CITATION: '근거 부족 상태에 인용이 함께 저장됨',
}
const scopeLabels: Record<ProductionScope, string> = { 'support-program-evidence-answer': '상세 공고 근거 답변', 'assistant-agent': '통합 도우미', 'support-program-search': '공고 검색', 'application-document-generation': '신청 문서 생성', 'combination-review': '중복 검토' }
const scopeDescriptions: Record<ProductionScope, string> = {
  'support-program-evidence-answer': '답변에 전달된 근거를 보관합니다. 전체 공고·검색 후보를 모두 보관한 자료가 아니므로 검색 재현율을 판단할 수 없습니다.',
  'assistant-agent': '이 실행에 저장된 도우미 입력과 결과를 검토합니다. 전체 대화나 연결된 업무의 모든 상태를 재현한 자료가 아닙니다.',
  'support-program-search': '저장된 검색 조건과 반환 결과를 대조합니다. 전체 검색 대상과 정답 목록이 없으므로 검색 재현율을 판단할 수 없습니다.',
  'application-document-generation': '저장된 작성 요청·참조 자료와 생성 결과를 대조합니다. 저장되지 않은 첨부 원문이나 실제 제출 결과까지 확인할 수 없습니다.',
  'combination-review': '저장된 공고·신청 상황과 검토 결과를 대조합니다. 실제 중복 수혜 가능 여부에 대한 기관의 최종 판단을 대신하지 않습니다.',
}
const reviewDraft = (review: ProductionSample['review']) => ({ grounded: review?.grounded ?? 'unknown', relevant: review?.relevant ?? 'unknown', complete: review?.complete ?? 'unknown', note: review?.note ?? '', reference_answer: review?.reference_answer ?? '', expected_status: review?.expected_status ?? '', expected_citation_ids: review?.expected_citation_ids ?? [] })

export function ProductionQualityPage({ owner, onExpired }: { owner: string; onExpired: () => void }) {
  const [params, setParams] = useSearchParams()
  const rawPage = Number(params.get('page') ?? 1)
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1
  const selected = params.get('sample') ?? ''
  const rawScope = params.get('scope') ?? ''
  const scope: ProductionScope | '' = productionScopes.find((value) => value === rawScope) ?? ''
  const updatePage = (nextPage: number, sample?: string) => setParams({ page: String(nextPage), ...(scope ? { scope } : {}), ...(sample ? { sample } : {}) })
  const [data, setData] = useState<ProductionQuality | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const expiry = useRef(onExpired); expiry.current = onExpired
  useEffect(() => {
    const controller = new AbortController()
    setData(null); setError('')
    getProductionQuality(page, controller.signal, scope).then((value) => { if (!controller.signal.aborted) setData(value) }).catch((reason) => {
      if (controller.signal.aborted) return
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expiry.current()
      else setError(reason instanceof Error ? reason.message : '운영 표본을 불러오지 못했습니다.')
    })
    return () => controller.abort()
  }, [page, revision, scope])
  return <>
    <WorkspacePageHeader title="운영 표본 품질" actions={<button className={styles.secondaryButton} onClick={() => setRevision((value) => value + 1)}>표본 목록 새로고침</button>} />
    <div className={styles.content}>
      <p className="text-sm leading-6 text-ink-muted">상세 공고 근거 답변·통합 도우미·공고 검색·신청 문서 생성·중복 검토의 저장 표본을 기능별 기준으로 검토합니다. 전체 서비스 정확도를 의미하지 않습니다. 구조 검사는 사실 정확성 판단과 다르며, 의미적 품질은 사람이 저장된 입력·근거·결과를 대조해 검토합니다.</p>
      <section className={styles.card} aria-label="운영 표본 기능 선택">
        <label className="block text-sm font-semibold">검토할 기능<select className={`${field} mt-2 max-w-md`} value={scope} onChange={(event) => setParams({ page: '1', ...(event.target.value ? { scope: event.target.value } : {}) })}><option value="">전체 기능</option>{productionScopes.map((value) => <option key={value} value={value}>{scopeLabels[value]}</option>)}</select></label>
        <p className="text-xs leading-6 text-ink-muted">저장·검토 건수와 일별 결과는 선택한 기능의 표본만 집계합니다. 기능별 입력과 검토 기준이 달라 전체 기능의 적합 비율을 모델 성능 점수로 해석하지 않습니다.</p>
      </section>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {!data && !error && <p role="status">운영 표본을 불러오고 있습니다.</p>}
      {data && <>
        <section className={styles.card} aria-label="운영 표본 수집 범위">
          <h2 className={styles.cardTitle}>저장·검토 범위 · {data.scope === 'all' ? '전체 기능' : scopeLabels[data.scope]}</h2>
          <p className="text-sm">Ops 표본 접수 {data.enabled ? '활성' : '비활성'} · 일별 저장 한도 {data.daily_limit.toLocaleString('ko-KR')}건 · 보존 기간 {data.retention_days}일</p>
          <p className="text-xs leading-6 text-ink-muted">접수 상태는 Ops 서버 기준이며 서비스의 표본 수집 설정은 별도입니다. 현재 보존 중인 기록만 집계합니다. 수집에서 제외되거나 저장에 실패한 요청은 포함하지 않으므로 전체 요청 대비 수집률은 계산하지 않습니다. 이 화면의 조회·검토·후보 저장은 모델을 호출하지 않습니다.</p>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3">{([['저장 표본', data.summary.stored], ['구조 검사 완료', data.summary.checked], ['구조 검사 대기', data.summary.pending], ['사람 검토', data.summary.reviewed], ['문제 있음', data.summary.issues], ['판단 보류', data.summary.unassessable]] as const).map(([label, count]) => <div key={label} className="rounded-lg bg-surface-muted p-3"><dt className="text-xs text-ink-muted">{label}</dt><dd className="mt-2 text-xl font-semibold">{count.toLocaleString('ko-KR')}건</dd></div>)}</dl>
        </section>
        <section className={styles.card} aria-label="일별 표본 검토">
          <h2 className={styles.cardTitle}>일별 표본 검토 결과</h2>
          <p className="text-xs leading-6 text-ink-muted">각 날짜에 저장된 표본의 현재 검토 결과입니다. 검토 건수에는 판단 보류도 포함합니다. 질문·근거·검토 대상이 달라질 수 있어 날짜별 차이를 모델 변경 효과로 단정하지 않습니다.</p>
          {!data.days.length ? <p className="text-sm">아직 저장된 운영 표본이 없습니다.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[550px] text-left text-sm"><thead><tr>{['저장일', '표본', '검토', '적합 / 검토', '문제 / 검토', '보류 / 검토'].map((label) => <th className="p-2" key={label} scope="col">{label}</th>)}</tr></thead><tbody>{data.days.map((day) => <tr key={day.date} className="border-t border-line"><th scope="row" className="p-2 font-normal">{day.date}</th><td className="p-2">{day.samples}건</td><td className="p-2">{day.reviewed}건</td>{[day.acceptable, day.issues, day.unassessable].map((count, index) => <td key={index} className="p-2">{day.reviewed ? `${count} / ${day.reviewed}건 (${Math.round(count / day.reviewed * 100)}%)` : '미검토'}</td>)}</tr>)}</tbody></table></div>}
        </section>
        <section className={styles.card} aria-label="운영 표본 목록">
          <h2 className={styles.cardTitle}>검토할 표본 · {data.count}건</h2>
          {!data.results.length ? <p className="text-sm">이 페이지에 표본이 없습니다.</p> : <ul className="divide-y divide-line">{data.results.map((sample) => <li key={sample.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0 text-sm"><p className="font-semibold">{scopeLabels[sample.scope]}</p><p className="mt-1">{date(sample.captured_at)}</p><p className="mt-1 break-all text-xs text-ink-muted">{sample.source_document_id}</p><p className="mt-1 text-xs">{checkStatus[sample.checks_status]} · {verdict(sample.review)}{sample.regression_candidate_id && ' · 회귀 후보 저장됨'}</p></div><button className={styles.secondaryButton} aria-label={`${sample.source_document_id} 표본 검토`} aria-pressed={selected === sample.id} onClick={() => updatePage(page, sample.id)}>표본 검토</button></li>)}</ul>}
          <nav aria-label="운영 표본 페이지" className="flex items-center justify-end gap-3 text-sm"><button className={styles.secondaryButton} disabled={page === 1} onClick={() => updatePage(page - 1)}>이전</button><span>{page}페이지</span><button className={styles.secondaryButton} disabled={!data.next} onClick={() => updatePage(page + 1)}>다음</button></nav>
        </section>
      </>}
      {selected && <SampleReview key={selected} id={selected} owner={owner} onExpired={onExpired} onChanged={() => setRevision((value) => value + 1)} />}
    </div>
  </>
}

function SampleReview({ id, owner, onExpired, onChanged }: { id: string; owner: string; onExpired: () => void; onChanged: () => void }) {
  const [data, setData] = useState<ProductionSample | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [draft, setDraft] = useState({ grounded: 'unknown', relevant: 'unknown', complete: 'unknown', note: '', reference_answer: '', expected_status: '', expected_citation_ids: [] as string[] })
  const pending = useRef<{ key: string; requestId: string } | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const expiry = useRef(onExpired); expiry.current = onExpired
  const changed = useRef(onChanged); changed.current = onChanged
  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    setData(null); setError(''); setNotice(''); setConflict(false); pending.current = null
    getProductionSample(id, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      setData(value)
      setDraft(reviewDraft(value.review))
    }).catch((reason) => {
      if (controller.signal.aborted) return
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expiry.current()
      else setError(reason instanceof Error ? reason.message : '표본 상세를 불러오지 못했습니다.')
    })
    return () => { mounted.current = false; controller.abort() }
  }, [id, revision])
  const perform = async (operation: 'review' | 'candidate' | 'download') => {
    if (!data || inFlight.current || conflict || (operation !== 'review' && !data.regression_supported)) return
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    try {
      if (operation === 'download') {
        const value = await getProductionRegressionCandidate(id)
        if (!mounted.current) return
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
        const link = document.createElement('a'); link.href = url; link.download = `production-regression-${id}.json`; link.click(); URL.revokeObjectURL(url)
        setNotice('회귀 후보 JSON을 내려받았습니다. 고정 평가 자료 편입은 별도 검토가 필요합니다.')
      } else {
        const payload = { version: data.review_version, material_sha256: data.material_sha256, ...(operation === 'review' ? { ...draft, note: draft.note.trim(), expected_status: draft.expected_status || null } : {}) }
        const key = JSON.stringify({ operation, ...payload })
        if (pending.current?.key !== key) pending.current = { key, requestId: crypto.randomUUID() }
        const input = { ...payload, request_id: pending.current.requestId }
        const value = operation === 'review' ? await saveProductionReview(id, input as ProductionReviewInput, owner) : await saveProductionRegressionCandidate(id, input, owner)
        if (!mounted.current) return
        setData(value); pending.current = null
        if (operation === 'review') setDraft(reviewDraft(value.review))
        setNotice(operation === 'review' ? '사람 검토를 저장했습니다.' : '회귀 후보를 저장했습니다. 현재 고정 평가에 자동으로 편입되지 않습니다.')
        changed.current()
      }
    } catch (reason) {
      if (!mounted.current) return
      if (reason instanceof OpsApiError && reason.status === 409) setConflict(true)
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) { setData(null); expiry.current() }
      else setError(reason instanceof Error ? reason.message : '표본 작업을 처리하지 못했습니다.')
    } finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  const acceptanceBlocked = !!data?.check_codes.length && [draft.grounded, draft.relevant, draft.complete].every((value) => value === 'yes')
  const review = data?.review
  const evidenceMaterial = data && 'chunks' in data.material ? data.material : null
  const unsaved = !!data && JSON.stringify(draft) !== JSON.stringify(reviewDraft(data.review))
  const candidateReady = !!review && review.verdict !== 'unassessable' && !!review.reference_answer.trim() && !!review.expected_status
    && (review.expected_status === 'ANSWERED' ? review.expected_citation_ids.length > 0 : review.expected_citation_ids.length === 0)
  return <section className={styles.card} aria-label="운영 표본 상세 검토">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className={styles.cardTitle}>입력·결과 검토</h2><button className={styles.secondaryButton} disabled={busy} onClick={() => setRevision((value) => value + 1)}>입력 초기화하고 상세 새로고침</button></div>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="text-sm text-brand-primary">{notice}</p>}
    {conflict && <p className="text-sm text-amber-800">검토 기록이 변경되었습니다. 상세 새로고침 후 다시 검토하세요.</p>}
    {!data && !error && <p role="status">표본 상세를 불러오고 있습니다.</p>}
    {data && <>
      <p className="font-semibold text-brand-primary">{scopeLabels[data.scope]}</p>
      <p className="text-xs text-ink-muted">{date(data.captured_at)} · 수집 당시 설정 비율 {data.sample_rate_bps / 100}% · 배포 버전 {data.release ?? '미확인'}</p>
      {data.redacted && <p className="rounded-lg bg-amber-50 p-3 text-sm">개인정보·민감정보가 마스킹된 표본입니다. 문맥이 부족해 판단하기 어렵다면 ‘판단 불가’를 선택하세요.</p>}
      <p className="text-sm">{checkStatus[data.checks_status]}</p>
      {data.check_codes.length > 0 && <div className="rounded-lg bg-amber-50 p-3 text-sm"><p className="font-semibold">검토 시 확인할 제한</p><ul className="mt-2 list-disc space-y-1 pl-5">{data.check_codes.map((code) => <li key={code}>{checkLabels[code] ?? `확인 필요 (${code})`}</li>)}</ul><p className="mt-2">구조 오류나 저장 자료의 누락·잘림이 있어 적합으로 저장할 수 없습니다. 확인할 수 없는 기준은 ‘판단 불가’로 검토하세요.</p></div>}
      {data.trace_url && <a href={data.trace_url} className={styles.mutedLink} target="_blank" rel="noopener noreferrer">Langfuse 실행 추적 열기 ↗</a>}
      <SampleMaterial sample={data} />
      {review && <p className="rounded-lg bg-brand-soft p-3 text-sm">최근 사람 검토: {verdict(review)} · {review.reviewer} · {date(review.created_at)}</p>}
      {data.review_history.length > 0 && <details className="rounded-xl border border-line p-4"><summary className="cursor-pointer text-sm font-semibold">사람 검토 이력 · {data.review_history.length}건</summary><ul className="divide-y divide-line">{data.review_history.map((entry) => <li key={entry.id} className="py-3 text-sm"><p className="font-semibold">{verdict(entry)} · {entry.reviewer} · {date(entry.created_at)}</p><p className="mt-2 whitespace-pre-wrap break-words">{entry.note}</p><p className="mt-2 text-xs text-ink-muted">{data.review_criteria.map(({ key, label }) => `${label}: ${{ yes: '예', no: '아니오', unknown: '판단 불가' }[entry[key]]}`).join(' · ')}</p></li>)}</ul></details>}
      <form aria-label="운영 표본 사람 검토" onSubmit={(event) => { event.preventDefault(); if (draft.note.trim() && !acceptanceBlocked) void perform('review') }}>
        <fieldset disabled={busy || conflict || data.checks_status !== 'checked'} className="space-y-4 disabled:opacity-60"><legend className="mb-3 font-semibold">사람 검토</legend>
          <div className="grid gap-4 lg:grid-cols-3">{data.review_criteria.map((criterion) => <label key={criterion.key} className="text-sm">{criterion.label}<span className="mt-1 block text-xs text-ink-muted">{criterion.description}</span><select className={`${field} mt-2`} value={draft[criterion.key]} onChange={(event) => setDraft({ ...draft, [criterion.key]: event.target.value })}><option value="unknown">판단 불가</option><option value="yes">예</option><option value="no">아니오</option></select></label>)}</div>
          <label className="block text-sm">검토 근거 · 필수<textarea className={`${field} mt-2`} required maxLength={1000} rows={3} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label>
          {data.regression_supported && evidenceMaterial && <details className="rounded-xl border border-line p-4"><summary className="cursor-pointer text-sm font-semibold">회귀 후보용 정답 작성 · 선택</summary><p className="mt-2 text-xs leading-6 text-ink-muted">근거를 검토한 사람이 정답과 기대 상태·인용을 입력해야 후보로 저장할 수 있습니다. AI가 작성한 정답으로 채우지 않습니다.</p><label className="mt-3 block text-sm">검토한 참조 답변<textarea className={`${field} mt-2`} rows={3} maxLength={2000} value={draft.reference_answer} onChange={(event) => setDraft({ ...draft, reference_answer: event.target.value })} /></label><label className="mt-3 block text-sm">기대 답변 상태<select className={`${field} mt-2`} value={draft.expected_status} onChange={(event) => setDraft({ ...draft, expected_status: event.target.value, expected_citation_ids: event.target.value === 'INSUFFICIENT_EVIDENCE' ? [] : draft.expected_citation_ids })}><option value="">선택하지 않음</option><option value="ANSWERED">답변 가능</option><option value="INSUFFICIENT_EVIDENCE">근거 부족</option></select></label><fieldset className="mt-3" disabled={draft.expected_status !== 'ANSWERED'}><legend className="text-sm">기대 인용 청크</legend>{evidenceMaterial.chunks.map((chunk) => <label key={chunk.id} className="mt-2 flex items-start gap-2 break-all text-xs"><input type="checkbox" checked={draft.expected_citation_ids.includes(chunk.id)} onChange={(event) => setDraft({ ...draft, expected_citation_ids: event.target.checked ? [...draft.expected_citation_ids, chunk.id] : draft.expected_citation_ids.filter((value) => value !== chunk.id) })} />{chunk.id}</label>)}</fieldset></details>}
          <button className={styles.primaryButton} type="submit" disabled={!draft.note.trim() || acceptanceBlocked}>{busy ? '처리 중…' : '사람 검토 저장'}</button>
        </fieldset>
      </form>
      {data.checks_status !== 'checked' && <p className="text-sm text-amber-800">구조 검사가 완료된 뒤 사람 검토를 저장할 수 있습니다.</p>}
      {data.regression_supported ? <section aria-label="회귀 평가 후보" className="rounded-xl border border-line p-4"><h3 className="font-semibold">회귀 평가 후보</h3><p className="mt-2 text-xs leading-6 text-ink-muted">판단 보류가 아닌 검토와 참조 답변·기대 상태·유효한 인용을 저장한 뒤 후보로 남깁니다. 고정 평가에 자동 편입하거나 모델을 호출하지 않습니다. 보존 기간 후 삭제될 수 있으므로 필요한 후보는 JSON으로 내보내세요. 저장한 후보는 당시 검토의 사본이며 이후 검토 변경이 자동 반영되지 않습니다.</p>{unsaved && <p className="mt-2 text-xs text-amber-800">변경한 검토 입력을 먼저 저장해야 회귀 후보를 만들 수 있습니다.</p>}<div className="mt-3 flex flex-wrap gap-3"><button className={styles.secondaryButton} disabled={busy || conflict || unsaved || !candidateReady || !!data.regression_candidate_id} onClick={() => void perform('candidate')}>회귀 후보 저장</button><button className={styles.secondaryButton} disabled={busy || conflict || !data.regression_candidate_id} onClick={() => void perform('download')}>회귀 후보 JSON 다운로드</button></div></section> : <p className="rounded-xl bg-surface-muted p-4 text-sm">이 기능의 검토 결과는 저장할 수 있습니다. 기능별 평가 자료 편입과 회귀 후보 내보내기는 아직 지원하지 않습니다.</p>}
    </>}
  </section>
}

function SampleMaterial({ sample }: { sample: ProductionSample }) {
  const material = sample.material
  const evidence = 'chunks' in material
  const contextTruncated = !evidence && material.context_truncated
  const outputTruncated = !evidence && material.output_truncated
  const contexts = evidence ? material.chunks.map((chunk) => ({ id: chunk.id, label: `${chunk.order} · ${chunk.id}`, text: chunk.text })) : material.contexts
  const output = evidence ? material.answer : material.output
  const status = evidence ? material.answer_status === 'ANSWERED' ? '답변 완료' : '근거 부족' : ({ COMPLETED: '처리 완료', NO_RESULTS: '결과 없음', INSUFFICIENT_EVIDENCE: '근거 부족' })[material.output_status]
  return <>
    {(contextTruncated || outputTruncated) && <p className="rounded-lg bg-amber-50 p-3 text-sm" role="note">저장 용량 제한으로 {contextTruncated && outputTruncated ? '입력·근거와 결과의' : contextTruncated ? '입력·근거의' : '결과의'} 일부가 생략된 표본입니다. 생략된 내용은 누락 오류로 단정하지 말고, 저장 자료만으로 확인할 수 없다면 ‘판단 불가’를 선택하세요.</p>}
    <div className="grid gap-4 xl:grid-cols-2">
      <section aria-label="표본 입력과 결과" className="min-w-0 rounded-xl bg-surface-muted p-4">
        <h3 className="font-semibold">{evidence ? '질문' : '사용자 요청'}</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm">{material.question}</p>
        <h3 className="mt-5 font-semibold">저장 {evidence ? '답변' : '결과'} · {status}</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm">{output || '저장된 결과 텍스트 없음'}</p>
        {evidence && <p className="mt-3 break-all text-xs text-ink-muted">인용 청크: {material.citation_chunk_ids.join(', ') || '없음'}</p>}
      </section>
      <section aria-label="표본 입력 근거" className="min-w-0 rounded-xl border border-line p-4">
        <h3 className="font-semibold">{evidence ? '답변에 전달된 근거' : '검토에 사용할 입력·근거'}</h3><p className="mt-2 text-xs leading-6 text-ink-muted">{scopeDescriptions[sample.scope]}</p>
        {!contexts.length && <p className="mt-4 text-sm text-ink-muted">저장된 입력·근거가 없습니다. 결과의 정확성을 확인할 자료가 부족하면 ‘판단 불가’를 선택하세요.</p>}
        {contexts.map((context) => <div key={context.id} className="mt-4 border-t border-line pt-3"><p className="break-words text-sm font-semibold">{context.label}</p><p className="mt-2 whitespace-pre-wrap break-words text-sm">{context.text}</p></div>)}
      </section>
    </div>
  </>
}
