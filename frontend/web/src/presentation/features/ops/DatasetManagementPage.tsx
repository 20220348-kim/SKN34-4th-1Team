import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { archiveManagedDataset, createManagedDataset, getManagedDatasets, OpsApiError, publishManagedDataset, saveManagedDataset, type ManagedDataset, type ManagedDatasetContent } from '../../../data/ops/opsApi'
import { WorkspacePageHeader } from '../../shared/workspace/WorkspacePageHeader'
import { workspacePageStyles as styles, workspaceTagClassName } from '../../shared/workspace/WorkspacePage.styles'

const field = 'min-h-11 w-full min-w-0 rounded-xl border border-line bg-white px-3 py-2 text-sm font-normal focus:outline-2 focus:outline-brand-primary'
const freshCase = (id: string, documentId: string): ManagedDatasetContent['cases'][number] => ({ id, document_id: documentId, question: '', expected_status: 'ANSWERED', expected_citation_orders: [], reference_facts: [], forbidden_claims: [], answer: null })
const emptyContent = (): ManagedDatasetContent => ({ title: '', description: '', documents: [{ id: 'doc-1', title: '', source_url: '', chunks: [''] }], cases: [freshCase('Q01', 'doc-1')] })
const lines = (value: string) => value.split('\n')
const changed = (a: ManagedDatasetContent, b: ManagedDatasetContent) => JSON.stringify(a) !== JSON.stringify(b)
const toggle = (values: number[], order: number, checked: boolean) => checked ? [...new Set([...values, order])].sort((a, b) => a - b) : values.filter((value) => value !== order)
const nextId = (prefix: string, ids: string[], padded = false) => { let n = 1; while (ids.includes(`${prefix}${padded ? String(n).padStart(2, '0') : n}`)) n += 1; return `${prefix}${padded ? String(n).padStart(2, '0') : n}` }
const date = (value: string) => new Date(value).toLocaleString('ko-KR')
type Operation = { kind: 'save' | 'publish' | 'archive'; request_id: string; expected_version: number; content: ManagedDatasetContent; archived: boolean }

export function DatasetManagementPage({ owner, onExpired }: { owner: string; onExpired: () => void }) {
  const [datasets, setDatasets] = useState<ManagedDataset[]>([])
  const [builtinCount, setBuiltinCount] = useState(0)
  const [selected, setSelected] = useState<ManagedDataset | null>(null)
  const [draft, setDraft] = useState(emptyContent)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const [pending, setPending] = useState<Operation | null>(null)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [navigation, setNavigation] = useState<ManagedDataset | 'new' | 'reload' | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const expiry = useRef(onExpired); expiry.current = onExpired
  const selectedId = useRef<string | null>(null)
  const submitting = useRef(false)
  const original = selected?.content ?? emptyContent()
  const dirty = changed(draft, original)
  const locked = busy || pending !== null || conflict || loading
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    getManagedDatasets(controller.signal).then((data) => {
      if (controller.signal.aborted) return
      setDatasets(data.datasets); setBuiltinCount(data.builtin_count)
      if (selectedId.current) {
        const current = data.datasets.find((item) => item.id === selectedId.current) ?? null
        setSelected(current); setDraft(current?.content ?? emptyContent())
      }
      setConflict(false); setError(''); setPending(null)
    }).catch((reason) => {
      if (controller.signal.aborted) return
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expiry.current()
      else setError(reason instanceof Error ? reason.message : '평가 자료를 불러오지 못했습니다.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reloadKey])
  const choose = (target: ManagedDataset | 'new' | 'reload') => {
    if (busy) return
    if (dirty || pending) { setNavigation(target); return }
    navigate(target)
  }
  const navigate = (target: ManagedDataset | 'new' | 'reload') => {
    setNavigation(null); setError(''); setNotice(''); setPending(null); setConfirmPublish(false); setConflict(false)
    if (target === 'reload') { if (!selectedId.current) setDraft(emptyContent()); setReloadKey((value) => value + 1); return }
    const value = target === 'new' ? null : target
    selectedId.current = value?.id ?? null; setSelected(value); setDraft(value?.content ?? emptyContent())
  }
  const update = (value: ManagedDatasetContent) => { setDraft(value); setConfirmPublish(false); setNotice('') }
  const docChange = (id: string, patch: Partial<ManagedDatasetContent['documents'][number]>) => update({ ...draft, documents: draft.documents.map((doc) => doc.id === id ? { ...doc, ...patch } : doc) })
  const caseChange = (id: string, patch: Partial<ManagedDatasetContent['cases'][number]>) => update({ ...draft, cases: draft.cases.map((item) => item.id === id ? { ...item, ...patch } : item) })
  const save = async (kind: Operation['kind']) => {
    if (submitting.current || conflict || loading) return
    const operation = pending ?? { kind, request_id: crypto.randomUUID(), expected_version: selected?.version ?? 0, content: structuredClone(draft), archived: !selected?.archived }
    submitting.current = true; setBusy(true); setError(''); setNotice(''); setPending(operation)
    try {
      const input = { request_id: operation.request_id, expected_version: operation.expected_version }
      const result = operation.kind === 'save'
        ? selected ? await saveManagedDataset(selected.id, { ...input, content: operation.content }, owner) : await createManagedDataset({ ...input, content: operation.content }, owner)
        : operation.kind === 'publish' ? await publishManagedDataset(selected!.id, input, owner)
          : await archiveManagedDataset(selected!.id, { ...input, archived: operation.archived }, owner)
      selectedId.current = result.id; setSelected(result); setDraft(result.content); setDatasets((values) => [result, ...values.filter((item) => item.id !== result.id)])
      setPending(null); setConfirmPublish(false)
      setNotice(operation.kind === 'save' ? '초안을 저장했습니다. 평가에 사용하려면 내용을 확인한 뒤 버전을 게시하세요.' : operation.kind === 'publish' ? '새 평가에서 선택할 자료 버전을 게시했습니다. 평가 실행이나 검토 승인은 하지 않았습니다.' : result.archived ? '자료를 보관했습니다. 기존 평가 이력은 유지됩니다.' : '자료를 복원했습니다. 게시된 버전을 새 평가에서 다시 선택할 수 있습니다.')
    } catch (reason) {
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expiry.current()
      else {
        setError(reason instanceof Error ? reason.message : '자료를 저장하지 못했습니다.')
        if (reason instanceof OpsApiError && [400, 404, 409].includes(reason.status)) { setPending(null); setConflict(reason.status !== 400) }
      }
    } finally { submitting.current = false; setBusy(false) }
  }
  const answersReady = draft.cases.length > 0 && draft.cases.every((item) => item.answer?.text.trim())
  return <><WorkspacePageHeader title="평가 자료 관리" actions={<Link className={styles.secondaryButton} to="/ops/evaluations/new">새 평가로 이동</Link>} />
    <div className={styles.content}>
      <p className="text-sm leading-6 text-ink-muted">공고 근거와 질문·채점 조건을 직접 등록합니다. 저장·게시·보관은 모델을 호출하지 않으며, 유료 실행 설정이나 예산을 바꾸지 않습니다.</p>
      {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="rounded-xl bg-green-50 p-4 text-sm text-brand-primary">{notice}</p>}
      {conflict && <p className="text-sm text-amber-800">다른 관리자가 자료를 변경했거나 자료 상태가 바뀌었습니다. 입력은 보존했습니다. 목록 새로고침으로 최신 버전을 확인하세요.</p>}
      {pending && !busy && <section className="grid gap-3 rounded-xl bg-amber-50 p-4" aria-label="자료 저장 결과 확인"><p className="text-sm">저장이 반영되었을 수 있습니다. 같은 요청으로 재확인하거나 목록을 새로고침하세요. 중복 등록을 피하도록 입력을 잠시 잠갔습니다.</p><button className={styles.secondaryButton} onClick={() => void save(pending.kind)}>같은 저장 요청으로 재확인</button></section>}
      {navigation && <section aria-label="작성 내용 이동 확인" className="grid gap-3 rounded-xl bg-amber-50 p-4 text-sm"><p>저장하지 않은 입력과 확인 중인 요청을 이 화면에서 지우고 이동할까요? 서버에 저장된 자료는 유지됩니다.</p><div className="flex flex-wrap gap-2"><button className={styles.secondaryButton} onClick={() => setNavigation(null)}>계속 작성</button><button className={styles.secondaryButton} onClick={() => navigate(navigation)}>입력 버리고 이동</button></div></section>}
      <section className={styles.card} aria-label="등록한 평가 자료 목록">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className={styles.cardTitle}>직접 등록한 자료 · {datasets.length}개</h2><div className="flex flex-wrap gap-2"><button className={styles.secondaryButton} disabled={busy || loading} onClick={() => choose('reload')}>목록 새로고침</button><button className={styles.primaryButton} disabled={busy || loading} onClick={() => choose('new')}>새 자료 작성</button></div></div>
        <p className="text-sm text-ink-muted">기본 제공 자료 {builtinCount}개는 새 평가에서 선택합니다. 이 화면은 관리자가 직접 등록한 자료를 관리합니다.</p>
        {loading ? <p role="status">자료 목록을 불러오고 있습니다.</p> : !datasets.length ? <p className="text-sm">아직 직접 등록한 자료가 없습니다. 아래에서 첫 자료의 초안을 작성하세요.</p> : <ul className="grid gap-2">{datasets.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3"><div><button className="text-left font-semibold text-brand-primary underline" disabled={busy} onClick={() => choose(item)}>{item.content.title || '이름 없는 초안'}</button><p className="mt-1 text-xs text-ink-muted">초안 버전 {item.version} · 질문 {item.content.cases.length}개 · 게시 {item.revisions.length}개 · 수정 {date(item.updated_at)}</p></div><span className={workspaceTagClassName(item.archived ? 'info' : item.revisions.length ? 'ok' : 'info')}>{item.archived ? '보관됨' : item.revisions.length ? '게시 버전 있음' : '초안'}</span></li>)}</ul>}
      </section>
      <section className={styles.card} aria-label="평가 자료 작성">
        <h2 className={styles.cardTitle}>{selected ? `${selected.content.title || '이름 없는 초안'} 수정` : '새 자료 작성'}</h2>
        <p className="text-sm leading-6 text-ink-muted">1. 자료 이름 → 2. 원문 근거 → 3. 질문·채점 조건 → 4. 초안 저장 → 5. 버전 게시 순서입니다. 현재는 근거를 미리 제공하는 답변 평가만 등록합니다. 검색 품질을 평가하는 RAG 자료는 아닙니다.</p>
        {selected?.archived && <p className="rounded-lg bg-amber-50 p-3 text-sm">보관한 자료입니다. 복원한 뒤 초안 수정과 게시를 할 수 있습니다.</p>}
        <form onSubmit={(event) => { event.preventDefault(); void save('save') }}>
          <fieldset disabled={locked || selected?.archived} className="grid min-w-0 gap-5 border-0 p-0">
            <div className="grid gap-3"><h3 className="font-bold">1. 자료 이름과 목적</h3><label className="grid gap-1 text-sm font-semibold">자료 이름<input className={field} required maxLength={150} value={draft.title} onChange={(event) => update({ ...draft, title: event.target.value })} placeholder="예: 우리 지역 창업 지원사업 신청 조건" /></label><label className="grid gap-1 text-sm font-semibold">자료 설명<textarea className={field} rows={2} maxLength={2000} value={draft.description} onChange={(event) => update({ ...draft, description: event.target.value })} placeholder="어떤 답변을 확인하려는지 적어 주세요." /></label></div>
            <section className="grid gap-3" aria-label="원문 근거 입력"><h3 className="font-bold">2. 원문 근거 · 최대 3개 공고</h3><p className="text-sm leading-6 text-ink-muted">출처 주소는 기록만 합니다. 본문·첨부파일을 자동으로 읽지 않으므로, 질문에 필요한 원문을 근거 문단에 붙여넣으세요. 모델에는 여기 입력한 문단이 제공됩니다.</p>
              {draft.documents.map((doc, docIndex) => <article key={doc.id} className="grid min-w-0 gap-3 rounded-xl border border-line p-4" aria-label={`공고 ${docIndex + 1} 입력`}><h4 className="font-semibold">공고 {docIndex + 1}</h4><label className="grid gap-1 text-sm">공고 {docIndex + 1} 제목<input className={field} value={doc.title} maxLength={300} onChange={(event) => docChange(doc.id, { title: event.target.value })} /></label><label className="grid gap-1 text-sm">공고 {docIndex + 1} 출처 URL · 선택<input className={field} type="url" value={doc.source_url} maxLength={2000} onChange={(event) => docChange(doc.id, { source_url: event.target.value })} placeholder="https://공식-공고-주소" /></label>
                {doc.chunks.map((chunk, chunkIndex) => <div key={chunkIndex} className="grid gap-2"><label className="grid gap-1 text-sm">공고 {docIndex + 1} 근거 {chunkIndex + 1}<textarea className={field} rows={4} maxLength={12000} value={chunk} onChange={(event) => docChange(doc.id, { chunks: doc.chunks.map((text, index) => index === chunkIndex ? event.target.value : text) })} /></label></div>)}
                <div className="flex flex-wrap gap-2"><button type="button" className={styles.secondaryButton} disabled={doc.chunks.length >= 5} onClick={() => docChange(doc.id, { chunks: [...doc.chunks, ''] })}>공고 {docIndex + 1} 근거 추가</button><button type="button" className={styles.secondaryButton} disabled={doc.chunks.length <= 1 || draft.cases.some((item) => item.document_id === doc.id && (item.expected_citation_orders.includes(doc.chunks.length - 1) || item.answer?.citation_orders.includes(doc.chunks.length - 1)))} onClick={() => docChange(doc.id, { chunks: doc.chunks.slice(0, -1) })}>마지막 근거 삭제</button><button type="button" className={styles.secondaryButton} disabled={draft.documents.length <= 1 || draft.cases.some((item) => item.document_id === doc.id)} onClick={() => update({ ...draft, documents: draft.documents.filter((item) => item.id !== doc.id) })}>공고 {docIndex + 1} 삭제</button></div><p className="text-xs text-ink-muted">공고당 근거는 최대 5개이며 문단당 12,000자까지 입력합니다. 질문이 사용하는 공고나 인용한 근거는 해당 질문의 선택을 바꾼 후 삭제하세요.</p>
              </article>)}<button type="button" className={`${styles.secondaryButton} justify-self-start`} disabled={draft.documents.length >= 3} onClick={() => update({ ...draft, documents: [...draft.documents, { id: nextId('doc-', draft.documents.map((doc) => doc.id)), title: '', source_url: '', chunks: [''] }] })}>공고 추가</button>
            </section>
            <section className="grid gap-3" aria-label="질문과 채점 조건 입력"><h3 className="font-bold">3. 질문과 채점 조건 · 최대 12개</h3><p className="text-sm leading-6 text-ink-muted">질문마다 제공할 공고와 기대하는 답변을 적습니다. 관리자가 작성했다는 이유로 정답이나 검토 승인이 보장되지는 않습니다. 등록 후 실제 답변과 원문을 대조해 검토하세요. 질문은 500자, 사실·금지 주장은 각각 최대 30줄(줄마다 1,200자), 저장 답변은 1,200자 이내입니다. 게시할 때는 사실과 금지 주장도 각각 한 줄 이상 필요합니다.</p>
              {draft.cases.map((item, index) => { const doc = draft.documents.find((value) => value.id === item.document_id); return <details key={item.id} open={index === 0 || undefined} className="min-w-0 rounded-xl border border-line p-4"><summary className="cursor-pointer font-semibold">{item.id} · {item.question || '새 질문'}</summary><div className="mt-4 grid gap-3">
                <label className="grid gap-1 text-sm">{item.id} 질문<textarea className={field} rows={2} maxLength={500} value={item.question} onChange={(event) => caseChange(item.id, { question: event.target.value })} /></label>
                <label className="grid gap-1 text-sm">{item.id} 제공할 공고<select className={field} value={item.document_id} onChange={(event) => caseChange(item.id, { document_id: event.target.value, expected_citation_orders: [], answer: item.answer ? { ...item.answer, citation_orders: [] } : null })}>{draft.documents.map((value, docIndex) => <option key={value.id} value={value.id}>공고 {docIndex + 1} · {value.title || '제목 미입력'}</option>)}</select></label><p className="text-xs text-ink-muted">선택한 공고의 모든 근거 문단을 제공합니다. 공고를 바꾸면 기존 인용 선택은 비워집니다.</p>
                <label className="grid gap-1 text-sm">{item.id} 예상 답변 상태<select className={field} value={item.expected_status} onChange={(event) => caseChange(item.id, { expected_status: event.target.value as typeof item.expected_status, expected_citation_orders: event.target.value === 'INSUFFICIENT_EVIDENCE' ? [] : item.expected_citation_orders })}><option value="ANSWERED">근거로 답변 가능</option><option value="INSUFFICIENT_EVIDENCE">근거 부족으로 답변 보류</option></select></label>
                <fieldset className="rounded-lg border border-line p-3" disabled={item.expected_status === 'INSUFFICIENT_EVIDENCE'}><legend className="px-1 text-sm">{item.id} 답변에 인용해야 할 근거</legend>{doc?.chunks.map((chunk, order) => <label key={order} className="mt-2 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={item.expected_citation_orders.includes(order)} onChange={(event) => caseChange(item.id, { expected_citation_orders: toggle(item.expected_citation_orders, order, event.target.checked) })} /><span>근거 {order + 1} · {chunk.slice(0, 80) || '본문 미입력'}</span></label>)}</fieldset><p className="text-xs text-ink-muted">근거 부족으로 답변 보류를 선택하면 기대 인용은 없습니다. 근거 1은 평가 결과에서 청크 0으로 표시됩니다.</p>
                <label className="grid gap-1 text-sm">{item.id} 반드시 포함할 사실 · 한 줄에 하나<textarea className={field} rows={3} maxLength={36029} value={item.reference_facts.join('\n')} onChange={(event) => caseChange(item.id, { reference_facts: lines(event.target.value) })} placeholder="예: 지원 대상은 창업 3년 이내 기업" /></label>
                <label className="grid gap-1 text-sm">{item.id} 하면 안 되는 주장 · 한 줄에 하나<textarea className={field} rows={2} maxLength={36029} value={item.forbidden_claims.join('\n')} onChange={(event) => caseChange(item.id, { forbidden_claims: lines(event.target.value) })} placeholder="예: 모든 기업이 조건 없이 신청할 수 있다" /></label>
                <details className="rounded-lg bg-surface-muted p-3"><summary className="cursor-pointer text-sm font-semibold">{item.id} 저장 답변 입력 · 초안에서는 선택</summary><p className="my-3 text-sm leading-6">무료 재평가에 사용할 답변입니다. 이 화면에서 등록한 답변은 ‘관리자 입력 답변 · 실제 모델 호출 기록 아님’으로 구분됩니다. 모든 질문에 답변을 입력해야 새 평가용 버전을 게시할 수 있습니다.</p><label className="grid gap-1 text-sm">{item.id} 저장 답변<textarea className={field} rows={4} maxLength={1200} value={item.answer?.text ?? ''} onChange={(event) => caseChange(item.id, { answer: event.target.value ? { text: event.target.value, status: item.answer?.status ?? 'ANSWERED', citation_orders: item.answer?.citation_orders ?? [] } : null })} /></label>
                  {item.answer && <div className="mt-3 grid gap-3"><label className="grid gap-1 text-sm">{item.id} 저장 답변 상태<select className={field} value={item.answer.status} onChange={(event) => caseChange(item.id, { answer: { ...item.answer!, status: event.target.value as typeof item.answer.status, citation_orders: event.target.value === 'INSUFFICIENT_EVIDENCE' ? [] : item.answer!.citation_orders } })}><option value="ANSWERED">답변함</option><option value="INSUFFICIENT_EVIDENCE">근거 부족으로 답변 보류함</option></select></label><fieldset className="rounded-lg border border-line p-3" disabled={item.answer.status === 'INSUFFICIENT_EVIDENCE'}><legend className="px-1 text-sm">{item.id} 저장 답변이 인용한 근거</legend>{doc?.chunks.map((_, order) => <label key={order} className="mr-4 inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={item.answer!.citation_orders.includes(order)} onChange={(event) => caseChange(item.id, { answer: { ...item.answer!, citation_orders: toggle(item.answer!.citation_orders, order, event.target.checked) } })} />근거 {order + 1}</label>)}</fieldset></div>}
                </details><button type="button" className={`${styles.secondaryButton} justify-self-start`} disabled={draft.cases.length <= 1} onClick={() => update({ ...draft, cases: draft.cases.filter((value) => value.id !== item.id) })}>{item.id} 질문 삭제</button>
              </div></details> })}
              <button type="button" className={`${styles.secondaryButton} justify-self-start`} disabled={draft.cases.length >= 12 || !draft.documents.length} onClick={() => update({ ...draft, cases: [...draft.cases, freshCase(nextId('Q', draft.cases.map((item) => item.id), true), draft.documents[0].id)] })}>질문 추가</button>
            </section>
            <div className="grid gap-2 border-t border-line pt-4"><h3 className="font-bold">4. 초안 저장</h3><p className="text-sm text-ink-muted">저장 답변 없이도 초안을 보관할 수 있습니다. 저장만으로 새 평가 목록에 추가되거나 모델이 실행되지는 않습니다.</p><button className={`${styles.primaryButton} justify-self-start`} disabled={!dirty}>{busy ? '저장 중…' : '초안 저장'}</button></div>
          </fieldset>
        </form>
        {selected && <section className="mt-5 grid gap-3 border-t border-line pt-4" aria-label="자료 버전 게시와 보관"><h3 className="font-bold">5. 버전 게시</h3><p className="text-sm leading-6">게시한 버전은 바꾸지 않고 보존합니다. 초안을 고치고 다시 게시하면 새 버전이 생기며, 이전 버전의 평가 이력·검토·비교 기준은 유지됩니다. 새 버전에 검토 승인이 자동으로 이어지지는 않습니다.</p>
          {!answersReady && <p className="text-sm text-amber-800">게시하려면 모든 질문에 저장 답변을 입력하세요. 답변이 없는 자료는 초안으로만 저장할 수 있습니다.</p>}{dirty && <p className="text-sm text-amber-800">변경한 내용을 먼저 초안으로 저장하세요.</p>}
          <div className="flex flex-wrap gap-2"><button className={styles.primaryButton} disabled={locked || selected.archived || dirty || !answersReady} onClick={() => setConfirmPublish(true)}>게시 내용 확인</button><button className={styles.secondaryButton} disabled={locked || dirty} onClick={() => void save('archive')}>{selected.archived ? '자료 복원' : '자료 보관'}</button></div>
          <p className="text-xs leading-5 text-ink-muted">보관하면 새 평가에서 선택할 수 없습니다. 이미 접수된 실행과 과거 기록은 유지되며, 복원하면 게시 버전을 다시 사용할 수 있습니다.</p>
          {confirmPublish && <section className="grid gap-3 rounded-xl bg-amber-50 p-4 text-sm" aria-label="게시 최종 확인"><p><strong>{selected.content.title}</strong> · 공고 {draft.documents.length}개 · 질문 {draft.cases.length}개를 새 평가용 버전으로 게시합니다. 관리자 입력 답변을 등록하는 것이며 실제 모델 호출·검토 승인·품질 합격은 아닙니다.</p><div className="flex flex-wrap gap-2"><button className={styles.primaryButton} disabled={locked} onClick={() => void save('publish')}>확인한 버전 게시</button><button className={styles.secondaryButton} disabled={busy} onClick={() => setConfirmPublish(false)}>계속 수정</button></div></section>}
          <details><summary className="cursor-pointer text-sm font-semibold">게시 버전 이력 · {selected.revisions.length}개</summary><ul className="mt-3 grid gap-2 text-sm">{selected.revisions.map((revision) => <li key={revision.id} className="rounded-lg bg-surface-muted p-3">{revision.label} · 버전 {revision.number} · {date(revision.created_at)}</li>)}</ul></details>
        </section>}
      </section>
    </div>
  </>
}
