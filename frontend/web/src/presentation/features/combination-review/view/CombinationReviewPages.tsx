import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { useAppDispatch, useAppSelector } from '../../../../app/hooks'
import { selectCurrentAccount, signedOut } from '../../../shared/auth/state/authSlice'
import { appPaths, combinationReviewRunResultPath, supportProgramDetailPath } from '../../../shared/routes/appPaths'
import { reviewProgramKey, supportsAutomaticReview, validateReviewDraft } from '../../../../domain/entities/CombinationReview'
import { useReviewListViewModel } from '../viewmodel/useReviewListViewModel'
import { useReviewEditorViewModel } from '../viewmodel/useReviewEditorViewModel'
import { ReviewParticipation } from './ReviewParticipation'
import { ReviewRunResult } from './ReviewRunResult'
import { SavedSupportProgramPickerDialog } from '../../../shared/support-program/SavedSupportProgramPickerDialog'
import { SupportProgramSearchFilters } from '../../../shared/support-program/SupportProgramSearchFilters'
import { formatReviewDateTime, runLabels } from './reviewLabels'
import { reviewStyles as s } from './CombinationReview.styles'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'
import { SelectField } from '../../../shared/workspace/SelectField'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'

const listTitle = '중복 지원·수혜 검토'

const sessionKeys = new WeakMap<object, number>()
let nextSessionKey = 0
function sessionKey(account: object) {
  if (!sessionKeys.has(account)) sessionKeys.set(account, ++nextSessionKey)
  return sessionKeys.get(account)!
}

function ReviewError({ error }: { error: { message: string; status?: number; runId?: number | null } | null }) {
  const dispatch = useAppDispatch()
  const alertRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (error) alertRef.current?.focus() }, [error])
  if (!error) return null
  return <div ref={alertRef} tabIndex={-1} role="alert" className={s.warning}>{error.message}
    {error.runId && <p>저장된 실패 실행: #{error.runId}</p>}
    {error.status === 401 && <button className={`${s.button} ml-3`} onClick={() => dispatch(signedOut())}>다시 로그인</button>}
  </div>
}

export function CombinationReviewListPage() {
  const account = useAppSelector(selectCurrentAccount)
  return account ? <ReviewList key={sessionKey(account)} account={account.email} /> : null
}
function ReviewList({ account }: { account: string }) {
  const vm = useReviewListViewModel(account)
  const [confirmingId, setConfirmingId] = useState<number | null>(null)
  const header = <WorkspacePageHeader title={listTitle} actions={<Link className={workspacePageStyles.primaryButton} to={appPaths.combinationReviewNew}>새 검토</Link>} />
  if (vm.error?.status === 401) return <>{header}<main className={workspacePageStyles.content}><ReviewError error={vm.error} /></main></>
  return <>{header}<main className={workspacePageStyles.content}>
    <p className={s.muted}>저장한 검토와 실행 이력은 본인만 조회할 수 있습니다.</p>
    <ReviewError error={vm.error} />
    {vm.busy.length > 0 && <p role="status">검토 목록을 불러오는 중입니다.</p>}
    {vm.page?.items.length === 0 && <div className={s.card}><h2 className="font-semibold">아직 저장한 검토가 없습니다.</h2><p className={s.muted}>새 검토에서 공고 2개와 참여 상태를 입력하면 분석을 시작할 수 있습니다.</p></div>}
    <ul className="space-y-3">{vm.page?.items.map((item) => <li className={`${s.card} flex flex-wrap items-center justify-between gap-3`} key={item.id}>
      <Link className="min-w-0 flex-1 hover:text-brand-primary" to={`${appPaths.combinationReviews}/${item.id}`}><strong>{item.title}</strong><p className={s.muted}>입력 버전 {item.inputRevision} · 수정 {formatReviewDateTime(item.updatedAt)}</p></Link>
      {confirmingId === item.id ? <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`${item.title} 삭제 확인`}><span className="text-sm text-red-800">검토와 분석 이력을 삭제할까요?</span><button type="button" className={s.danger} disabled={vm.busy.includes('delete')} onClick={() => void vm.deleteReview(item.id)}>정말 삭제</button><button type="button" className={s.button} disabled={vm.busy.includes('delete')} onClick={() => setConfirmingId(null)}>취소</button></div>
        : <div className="flex items-center gap-2"><Link className={s.primary} to={`${appPaths.combinationReviews}/${item.id}?step=analysis`}>결과 보기</Link><button type="button" className={s.button} disabled={vm.busy.includes('delete')} onClick={() => setConfirmingId(item.id)}>삭제</button></div>}
    </li>)}</ul>
    {vm.error && <button className={s.button} disabled={vm.busy.length > 0} onClick={() => void vm.load()}>목록 다시 불러오기</button>}
    {vm.page?.nextBeforeId && <button className={s.button} disabled={vm.busy.length > 0} onClick={() => void vm.load(vm.page!.nextBeforeId!)}>이전 검토 더 보기</button>}
  </main></>
}

export function CombinationReviewEditorPage({ create = false }: { create?: boolean }) {
  const account = useAppSelector(selectCurrentAccount)
  const { reviewId } = useParams()
  const id = create ? null : Number(reviewId)
  if (!account) return null
  if (!create && (!Number.isSafeInteger(id) || id! <= 0)) return <><WorkspacePageHeader parent={{ to: appPaths.combinationReviews, label: listTitle }} title="검토" /><main className={workspacePageStyles.content}><p role="alert">올바른 검토 주소가 아닙니다.</p><Link className={workspacePageStyles.quietLink} to={appPaths.combinationReviews}>목록으로</Link></main></>
  return <ReviewEditor key={`${sessionKey(account)}:${id ?? 'new'}`} id={id} account={account.email} />
}

export function CombinationReviewRunResultPage() {
  const account = useAppSelector(selectCurrentAccount)
  const { reviewId: reviewIdParam, runId: runIdParam } = useParams()
  const reviewId = Number(reviewIdParam)
  const runId = Number(runIdParam)
  const valid = Number.isSafeInteger(reviewId) && reviewId > 0 && Number.isSafeInteger(runId) && runId > 0
  if (!account) return null
  if (!valid) return <><WorkspacePageHeader parent={{ to: appPaths.combinationReviews, label: listTitle }} title="실행 결과" /><main className={workspacePageStyles.content}><p role="alert">올바른 실행 결과 주소가 아닙니다.</p><Link className={workspacePageStyles.quietLink} to={appPaths.combinationReviews}>목록으로</Link></main></>
  return <RunResultPage key={`${sessionKey(account)}:${reviewId}:${runId}`} reviewId={reviewId} runId={runId} account={account.email} />
}

function RunResultPage({ reviewId, runId, account }: { reviewId: number; runId: number; account: string }) {
  const vm = useReviewEditorViewModel(reviewId, account, false, false, runId)
  const navigate = useNavigate()
  const contentRef = useRef<HTMLElement>(null)
  const analysisPath = `${appPaths.combinationReviews}/${reviewId}?step=analysis`
  const header = <WorkspacePageHeader parent={[{ to: appPaths.combinationReviews, label: '중복 지원 수혜 검토' }, { to: analysisPath, label: '공고 분석' }]} title={vm.review ? `${vm.review.title} 결과` : '분석 결과'} />
  useEffect(() => {
    const scrollArea = contentRef.current?.parentElement
    if (scrollArea && typeof scrollArea.scrollTo === 'function') scrollArea.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [])
  if (vm.error?.status === 401) return <>{header}<main className={workspacePageStyles.content}><ReviewError error={vm.error} /></main></>
  const selectedRun = vm.run?.id === runId ? vm.run : null
  const runOptions = vm.runs?.items ?? []
  const currentRunInOptions = runOptions.some((run) => run.id === runId)
  return <>{header}<main ref={contentRef} className={workspacePageStyles.content}>
    <Link className={workspacePageStyles.quietLink} to={analysisPath}>← 공고 분석으로</Link>
    {vm.review && <section className={`${s.card} space-y-1`}><h2 className="font-bold">{vm.review.title}</h2><p className={s.muted}>저장 입력 버전 {vm.review.inputRevision}의 실행 이력입니다.</p></section>}
    <section className={`${s.card} space-y-3`} aria-label="다른 실행 이력">
      <label className="block text-sm font-semibold">실행 결과 선택
        <SelectField label="실행 결과 선택" className={s.input} value={String(runId)}
          options={[
            ...(currentRunInOptions ? [] : [{ value: String(runId), label: `실행 #${runId} · 현재 결과` }]),
            ...runOptions.map((run) => ({ value: String(run.id), label: `실행 #${run.id} · ${runLabels[run.status]} · ${formatReviewDateTime(run.startedAt)}` })),
          ]}
          onChange={(value) => navigate(combinationReviewRunResultPath(reviewId, Number(value)))} />
      </label>
      {vm.runs?.nextBeforeId && <button className={s.button} type="button" disabled={vm.busy.includes('history')} onClick={() => vm.history(vm.runs!.nextBeforeId!)}>이전 실행 더 보기</button>}
    </section>
    <ReviewError error={vm.error} />
    {!selectedRun && vm.busy.some((value) => value === 'load' || value === 'run') && <p role="status">실행 결과를 불러오는 중입니다.</p>}
    {!selectedRun && vm.review && vm.error && !vm.busy.includes('run') && <button className={s.button} type="button" onClick={() => vm.selectRun(runId)}>실행 결과 다시 불러오기</button>}
    {selectedRun && <>
      <div className="flex justify-end"><button className={s.button} type="button" disabled={vm.busy.includes('run')} onClick={() => vm.selectRun(runId)}>결과 새로고침</button></div>
      <ReviewRunResult run={selectedRun} currentRevision={vm.review?.inputRevision ?? selectedRun.inputRevision} download={vm.download} downloading={vm.busy.includes('download')} />
    </>}
  </main></>
}

function ReviewEditor({ id, account }: { id: number | null; account: string }) {
  const location = useLocation()
  const autoStart = new URLSearchParams(location.search).get('start') === '1'
  const [savedProgramsOpen, setSavedProgramsOpen] = useState(false)
  const vm = useReviewEditorViewModel(id, account, autoStart, savedProgramsOpen)
  const [step, setStep] = useState<'selection' | 'participation' | 'analysis'>(() => id && new URLSearchParams(location.search).get('step') === 'analysis' ? 'analysis' : 'selection')
  const contentRef = useRef<HTMLElement>(null)
  const savedProgramsButtonRef = useRef<HTMLButtonElement>(null)
  const closeSavedPrograms = () => { setSavedProgramsOpen(false); savedProgramsButtonRef.current?.focus() }
  useEffect(() => {
    setSavedProgramsOpen(false)
    const scrollArea = contentRef.current?.parentElement
    if (scrollArea && typeof scrollArea.scrollTo === 'function') scrollArea.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [step])
  const inputBusy = vm.busy.includes('save') || vm.busy.includes('load')
  const analysisBusy = vm.busy.includes('analysis')
  const invalidProgramCount = vm.draft.programs.length !== 2
  const unsupported = vm.draft.programs.some((p) => !supportsAutomaticReview(p))
  const running = vm.runs?.items.some((run) => ['QUEUED', 'RUNNING', 'UNKNOWN'].includes(run.status))
  const changeStep = (next: 'selection' | 'participation' | 'analysis') => { vm.setError(null); setStep(next) }
  const goToParticipation = () => {
    try { validateReviewDraft(vm.draft); changeStep('participation') }
    catch (error) { vm.setError({ message: (error as Error).message }) }
  }
  const title = step === 'selection' ? (id ? '검토 제목과 공고 선택' : '새 검토') : step === 'participation' ? '공고별 참여 상태' : '공고 분석'
  // 상위 화면 이름(중복 지원·수혜 검토)을 누르면 검토 목록으로 돌아갑니다.
  const header = <WorkspacePageHeader parent={{ to: appPaths.combinationReviews, label: listTitle }} title={title} />
  if (vm.error?.status === 401) return <>{header}<main className={workspacePageStyles.content}><ReviewError error={vm.error} /></main></>
  return <>{header}<main ref={contentRef} className={workspacePageStyles.content}>
    {vm.review && <p className={s.muted}>검토 #{id} · 저장 입력 버전 {vm.review.inputRevision}</p>}
    <ol className="grid gap-2 sm:grid-cols-3" aria-label="검토 진행 단계">
      {([['selection', '1. 제목·공고 선택'], ['participation', '2. 참여 상태 설정'], ['analysis', '3. 공고 분석']] as const).map(([value, label]) => <li key={value} className={`rounded-xl border px-4 py-3 text-sm font-semibold ${step === value ? 'border-brand-primary bg-brand-accent text-brand-primary' : 'border-slate-200 bg-white text-slate-500'}`} aria-current={step === value ? 'step' : undefined}>{label}</li>)}
    </ol>
    <ReviewError error={vm.error} />
    {id && vm.error?.runId && <Link className={s.button} to={combinationReviewRunResultPath(id, vm.error.runId)}>실패 실행 #{vm.error.runId} 확인</Link>}
    {vm.rejectedRevision && vm.pending && <button className={s.button} onClick={vm.clearRejectedRequest}>버전 충돌로 거절된 실행 요청 정리</button>}
    {vm.notice && <p role="status" className={s.muted}>{vm.notice}</p>}
    {id && !vm.review ? <div className={s.card}>{vm.busy.includes('load') ? <p role="status">저장 입력과 실행 이력을 불러오는 중입니다.</p> : <button className={s.button} onClick={vm.load}>검토 다시 불러오기</button>}</div> : <>
      {step === 'selection' && <fieldset disabled={inputBusy} className="space-y-4">
          <div className={s.card}><label className="font-semibold">검토 제목<input className={s.input} value={vm.draft.title} onChange={(e) => vm.setDraft({ ...vm.draft, title: e.target.value })} required placeholder="예: 창업 지원사업 참여 검토" /></label><p className={s.muted}>제목은 200자 이내입니다. 참여 상태는 제목과 별도로 입력합니다.</p></div>
          <section className={s.card} aria-label="공고 선택">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold">비교할 공고 선택</h2><strong className="rounded-full bg-brand-accent px-3 py-1 text-sm text-brand-primary">{vm.draft.programs.length}/2 선택</strong></div>
            <p className={s.muted}>관심 공고함이나 전체 공고 검색에서 서로 비교할 공고를 정확히 2개 선택하세요. 접수 종료 공고도 참여 이력 검토에 사용할 수 있습니다.</p>
            <div className="mt-3 flex min-h-12 flex-col items-stretch gap-2 rounded-xl bg-slate-50 px-3 py-2" aria-label="현재 선택한 공고">
              {vm.draft.programs.length === 0 && <span className="text-sm text-slate-500">선택한 공고가 없습니다.</span>}
              {vm.draft.programs.map((program, index) => {
                const name = vm.names[reviewProgramKey(program)] ?? '공고 정보 확인 중'
                return <span className="inline-flex w-full min-w-0 items-center gap-2 rounded-xl border border-brand-primary/30 bg-brand-accent py-1 pr-1 pl-3 text-sm font-semibold text-brand-primary" key={reviewProgramKey(program)}><span className="min-w-0 flex-1 break-words">사업 {index + 1} · {name}</span><button type="button" className="grid size-7 shrink-0 place-items-center rounded-full hover:bg-brand-accent focus-visible:outline-2 focus-visible:outline-brand-primary" aria-label={`${name} 선택 해제`} onClick={() => vm.setDraft({ ...vm.draft, programs: vm.draft.programs.filter((_, selectedIndex) => selectedIndex !== index) })}>×</button></span>
              })}
            </div>
            <button ref={savedProgramsButtonRef} type="button" className="mt-4 flex w-full cursor-pointer items-center justify-between rounded-xl border border-slate-300 bg-white px-4 py-3 text-left text-sm font-semibold hover:border-brand-primary hover:bg-brand-accent focus-visible:outline-2 focus-visible:outline-brand-primary" aria-label="관심 공고함에서 선택" aria-haspopup="dialog" aria-expanded={savedProgramsOpen} onClick={() => setSavedProgramsOpen(true)}><span>관심 공고함에서 선택</span><span className="text-brand-primary">열기 ›</span></button>
            <SavedSupportProgramPickerDialog open={savedProgramsOpen} phase={vm.savedProgramChoices.phase} programs={vm.savedProgramChoices.programs} selectedProgramKeys={vm.draft.programs.map((program) => `${program.sourceCode}:${program.sourceProgramId}`)} selectionLimit={2} description="비교할 공고를 최대 2개까지 선택할 수 있습니다." listLabel="중복 지원 검토 관심 공고 목록" onToggle={vm.toggle} onRetry={vm.savedProgramChoices.retry} onClose={closeSavedPrograms} />
            <h3 className="mt-5 font-semibold">전체 공고 검색</h3>
            <div className="mt-3"><SupportProgramSearchFilters filters={vm.catalogFilters} appliedFilters={vm.appliedCatalogFilters} catalog={vm.catalog}
              disabled={inputBusy} loading={vm.busy.includes('catalog')} onChange={vm.setCatalogFilters}
              onSearch={(filters) => { void vm.search(1, filters) }} /></div>
            {vm.busy.includes('catalog') && <p className="mt-3" role="status">공고를 불러오는 중입니다.</p>}
            {vm.catalog?.programs.length === 0 && <p className="mt-3">검색 결과가 없습니다. 검색어나 필터를 바꿔 다시 검색해 주세요.</p>}
            <ul className="mt-4 divide-y divide-slate-200">{vm.catalog?.programs.map((program) => {
              const identity = { sourceCode: program.sourceCode, sourceProgramId: program.id, subProgramId: null }
              const selected = vm.draft.programs.some((p) => reviewProgramKey(p) === reviewProgramKey(identity))
              return <li className={`my-2 rounded-xl border px-3 py-3 transition-colors ${selected ? 'border-brand-primary bg-brand-accent ring-1 ring-brand-primary/20' : 'border-transparent'}`} key={reviewProgramKey(identity)}><div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0 flex-1"><strong>{program.title}</strong><p className={s.muted}>{program.organization} · {({ OPEN: '접수 중', CLOSED: '접수 종료', UPCOMING: '접수 예정', UNKNOWN: '접수 상태 미확인' })[program.status]}</p><p className={s.muted}>{program.applicationPeriod}</p></div><button type="button" className={selected ? s.primary : s.button} aria-pressed={selected} disabled={!selected && vm.draft.programs.length >= 2} onClick={() => vm.toggle(program)}>{selected ? '선택 해제' : '선택'}</button></div>
                {!supportsAutomaticReview(identity) && <p className="text-sm text-amber-800">현재 자동 분석을 지원하지 않는 공고입니다.</p>}
                <Link className="text-sm text-brand-primary underline" to={supportProgramDetailPath({ sourceCode: identity.sourceCode, sourceProgramId: identity.sourceProgramId }, true)} target="_blank">공고 상세 확인</Link>
              </li>
            })}</ul>
            {vm.catalog && <div className="mt-3 flex items-center gap-3"><button type="button" className={s.button} disabled={vm.catalog.page <= 1 || vm.busy.includes('catalog')} onClick={() => void vm.search(vm.catalog!.page - 1, vm.appliedCatalogFilters)}>이전 공고</button><span className="text-sm">{vm.catalog.page} / {Math.max(1, vm.catalog.totalPages)}</span><button type="button" className={s.button} disabled={vm.catalog.page >= vm.catalog.totalPages || vm.busy.includes('catalog')} onClick={() => void vm.search(vm.catalog!.page + 1, vm.appliedCatalogFilters)}>다음 공고</button></div>}
          </section>
          {unsupported && <p className={s.warning}>선택한 공고는 현재 자동 분석을 지원하지 않습니다. 기업마당의 숫자형 PBLN_ 공고와 K-Startup·과기정통부·충남 수출지원의 숫자형 공고를 지원하며, 세부사업은 지정하지 않아야 합니다.</p>}
          <div className="flex justify-end"><button className={s.primary} type="button" onClick={goToParticipation} disabled={vm.draft.programs.length !== 2}>다음: 참여 상태 설정</button></div>
        </fieldset>}
      {step === 'participation' && <>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); vm.saveAndStart(() => changeStep('analysis')) }}>
          <fieldset disabled={inputBusy} className="space-y-4">
            {vm.draft.programs.map((program, index) => <ReviewParticipation key={reviewProgramKey(program)} program={program} index={index} name={vm.names[reviewProgramKey(program)]} onChange={(participation) => vm.setDraft({ ...vm.draft, programs: vm.draft.programs.map((p, i) => i === index ? { ...p, participation } : p) })} />)}
            <div className={s.card}><label className="block text-sm font-semibold">분석에 참고할 추가 설명 <span className="font-normal text-slate-500">(선택)</span><textarea className={s.input} rows={4} maxLength={8000} value={vm.facts} onChange={(e) => vm.setFacts(e.target.value)} /></label><p className={s.muted}>{vm.facts.length}/8000 · 이 실행에만 저장됩니다.</p></div>
            {unsupported && <p className={s.warning}>선택한 공고는 현재 자동 분석을 지원하지 않습니다. 기업마당의 숫자형 PBLN_ 공고와 K-Startup·과기정통부·충남 수출지원의 숫자형 공고를 지원하며, 세부사업은 지정하지 않아야 합니다.</p>}
            <div className="flex flex-wrap justify-between gap-3"><button className={s.button} type="button" onClick={() => changeStep('selection')}>이전: 제목·공고 선택</button><button className={s.primary} type="submit" disabled={unsupported}>{inputBusy ? '입력 저장 중…' : '입력 저장 후 분석 시작'}</button></div>
          </fieldset>
        </form>
      </>}
      {step === 'analysis' && id && <>
        <button className={s.button} type="button" onClick={() => changeStep('participation')}>← 참여 상태 수정</button>
        <section className={`${s.card} space-y-3`} aria-label="분석 대상 공고"><h2 className="font-bold">분석 대상 공고</h2><ul className="space-y-2">{vm.draft.programs.map((program, index) => <li key={reviewProgramKey(program)} className="rounded-lg bg-slate-50 p-3"><strong>사업 {index + 1} · {vm.names[reviewProgramKey(program)] ?? '공고 정보 확인 중'}</strong></li>)}</ul></section>
        <section className={`${s.card} space-y-3`} aria-label="분석 실행"><h2 className="text-lg font-bold">공식 근거 분석</h2>
          <p className={s.muted}>PDF·HWP·HWPX 공식 첨부를 자동 수집하여 OpenAI로 분석합니다. 유료 API 호출이 발생할 수 있습니다. 원문 미확보·미지원 형식은 오류로 표시합니다.</p>
          {vm.dirty && <p className={s.warning}>저장하지 않은 입력이 있습니다. 저장한 뒤 분석해 주세요.</p>}
          {invalidProgramCount && <p className={s.warning}>기존에 저장한 3개 공고의 결과는 조회할 수 있지만 새 분석은 공고를 2개로 줄인 뒤 실행할 수 있습니다.</p>}
          {analysisBusy && <div role="status" className="rounded-xl border border-brand-primary/20 bg-brand-accent p-4 text-sm text-emerald-950"><div className="flex items-center gap-3"><span className="size-3 animate-pulse rounded-full bg-brand-primary" aria-hidden="true" /><strong>분석 요청을 안전하게 접수하고 있습니다.</strong></div><ol className="mt-3 grid gap-2 text-xs sm:grid-cols-3"><li className="rounded-lg bg-white px-3 py-2 font-semibold text-brand-primary">✓ 입력 저장 완료</li><li className="rounded-lg border border-brand-primary/30 bg-white px-3 py-2 font-semibold">● 분석 대기열 등록 중</li><li className="rounded-lg bg-white/60 px-3 py-2 text-slate-500">상태·결과 자동 표시</li></ol><p className="mt-3">창을 닫아도 접수된 서버 작업은 취소되지 않습니다.</p></div>}
          {running && <p className={s.warning}>대기·분석 중이거나 결과 확인이 필요한 실행이 있습니다. 상태를 자동으로 확인하며 중복 분석은 시작하지 않습니다.</p>}
          {vm.pollingPaused && <p className={s.warning}>상태 자동 조회가 중단되었습니다. 실행 이력에서 항목을 눌러 다시 확인해 주세요. 서버 작업은 취소되지 않습니다.</p>}
          {vm.pending ? <div className={s.warning}><p>미확인 요청을 보관하고 있습니다. 같은 키·버전·추가 설명으로만 다시 확인합니다.</p><p>요청 입력 버전 {vm.pending.expectedRevision}</p><p className="whitespace-pre-wrap">추가 설명: {vm.pending.additionalFacts || '없음'}</p><button className={`${s.button} mt-2`} disabled={analysisBusy} onClick={() => vm.start(true)}>같은 요청 확인</button></div>
            : <button className={s.primary} disabled={analysisBusy || inputBusy || vm.dirty || !!running || invalidProgramCount || unsupported} onClick={() => vm.start(false)}>새 분석 실행</button>}
        </section>
        <section className={`${s.card} space-y-3`}><h2 className="text-lg font-bold">실행 이력</h2><button className={s.button} disabled={vm.busy.includes('history')} onClick={() => vm.history()}>실행 이력 새로고침</button>
          {vm.runs?.items.length === 0 && <p className={s.muted}>아직 분석을 실행하지 않았습니다.</p>}
          <ul className="space-y-2">{vm.runs?.items.map((run) => <li key={run.id}><Link className={`${s.button} w-full justify-start text-left`} to={combinationReviewRunResultPath(id, run.id)}>#{run.id} · 입력 버전 {run.inputRevision} · {runLabels[run.status]} · {formatReviewDateTime(run.startedAt)}</Link></li>)}</ul>
          {vm.runs?.nextBeforeId && <button className={s.button} disabled={vm.busy.includes('history')} onClick={() => vm.history(vm.runs!.nextBeforeId!)}>이전 실행 더 보기</button>}
        </section>
      </>}
    </>}
  </main></>
}
