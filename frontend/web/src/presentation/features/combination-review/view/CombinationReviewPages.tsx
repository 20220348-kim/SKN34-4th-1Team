import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { programStatusLabels } from '@govbiz/shared/domain/labels'
import { useAppDispatch, useAppSelector } from '../../../../app/hooks'
import { assistantLift } from '../../../shared/assistant/assistantPlacement'
import { selectCurrentAccount, signedOut } from '../../../shared/auth/state/authSlice'
import { appPaths, combinationReviewRunResultPath, supportProgramDetailPath } from '../../../shared/routes/appPaths'
import { reviewProgramKey, supportsAutomaticReview, type ReviewListItem, type RunSummary } from '../../../../domain/entities/CombinationReview'
import { useReviewListViewModel } from '../viewmodel/useReviewListViewModel'
import { useReviewEditorViewModel, type InitialReviewProgram } from '../viewmodel/useReviewEditorViewModel'
import { ReviewParticipation } from './ReviewParticipation'
import { ReviewRunResult } from './ReviewRunResult'
import { SavedSupportProgramPickerDialog } from '../../../shared/support-program/SavedSupportProgramPickerDialog'
import { SupportProgramSearchFilters } from '../../../shared/support-program/SupportProgramSearchFilters'
import { elapsedLabel, formatReviewClock, formatReviewDateTime, runLabels } from './reviewLabels'
import { reviewStyles as s } from './CombinationReview.styles'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'
import { SelectField } from '../../../shared/workspace/SelectField'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { WorkspaceModal } from '../../../shared/workspace/WorkspaceModal'
import { WorkspaceToast, type WorkspaceToastNotice } from '../../../shared/workspace/WorkspaceToast'
import { useDelayedFlag } from '../../../shared/workspace/useDelayedFlag'
import { useFloatingPopover } from '../../../shared/workspace/useFloatingPopover'
import { CatalogRowSkeletons, ReviewEditorSkeleton, ReviewListSkeleton, ReviewRunResultSkeleton } from './ReviewSkeletons'

const listTitle = '중복 지원·수혜 검토'
const scopeNotice = '두 공고를 함께 신청 · 선정 · 수행할 수 있는지 봐요. 과거 수혜 이력 누적 · 사업비 정산 규정은 이 검토 범위 밖이에요.'
const unsupportedNotice = '선택한 공고는 현재 자동 분석을 지원하지 않습니다. 기업마당의 숫자형 PBLN_ 공고와 K-Startup·과기정통부·충남 수출지원의 숫자형 공고를 지원하며, 세부사업은 지정하지 않아야 합니다.'
const steps = [['selection', '제목 · 공고 선택'], ['participation', '참여 상태'], ['analysis', '공고 분석']] as const
type Step = typeof steps[number][0]

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

/** 검토 행의 [⋯] 메뉴입니다. 입력 수정으로 가거나 삭제 확인을 엽니다. 바깥 클릭 · Esc로 닫힙니다. */
function ReviewMenu({ item, disabled, onDelete }: { item: ReviewListItem; disabled: boolean; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const floating = useFloatingPopover({ open, placement: 'bottom-end' })
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => { if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', onKey) }
  }, [open])
  return <div ref={ref} className="relative">
    <button ref={floating.reference} type="button" className={s.menuButton} aria-label={`검토 메뉴: ${item.title}`} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen((current) => !current)}>⋯</button>
    {open && <div ref={floating.floating} style={floating.floatingStyles} className={s.menu} role="menu" aria-label="검토 메뉴">
      <Link className={s.menuItem} role="menuitem" to={`${appPaths.combinationReviews}/${item.id}`} onClick={() => setOpen(false)}>입력 수정</Link>
      <button type="button" className={`${s.menuItem} ${s.menuItemDanger}`} role="menuitem" disabled={disabled} onClick={() => { setOpen(false); onDelete() }}>삭제</button>
    </div>}
  </div>
}

/**
 * 목록 카드의 실행 상태 표시입니다(신청 문서 목록의 분석 · 초안 카드와 같은 틀). 배지 · 한 줄 설명 · 버튼 이름과 갈 곳을 정합니다.
 * 진행 중은 분석 단계로, 끝난 실행은 그 결과 화면으로, 실행 전은 입력 화면으로 갑니다.
 */
function latestRunView(item: ReviewListItem) {
  const reviewPath = `${appPaths.combinationReviews}/${item.id}`
  const run = item.latestRun
  if (!run) return { badge: '실행 전', tone: s.badgeNeutral, note: '입력을 마치고 [검토 실행]을 누르면 분석을 시작해요', action: '이어서 입력', to: reviewPath, state: 'idle' as const }
  const analysisPath = `${reviewPath}?step=analysis`
  const resultPath = combinationReviewRunResultPath(item.id, run.id)
  if (run.status === 'QUEUED') return { badge: '분석 대기', tone: s.badgeInfo, note: '차례를 기다리고 있어요. 곧 분석을 시작해요', action: '진행 보기', to: analysisPath, state: 'working' as const }
  if (run.status === 'RUNNING') return { badge: '분석 중', tone: s.badgeInfo, note: '공식 문서를 읽고 단계별로 판단하고 있어요', action: '진행 보기', to: analysisPath, state: 'working' as const }
  if (run.status === 'UNKNOWN') return { badge: runLabels.UNKNOWN, tone: s.badgeWarn, note: '완료 여부를 확인하지 못했어요. 중복 과금을 막기 위해 새 분석을 막아 뒀어요', action: '상태 보기', to: analysisPath, state: 'checking' as const }
  if (run.status === 'SUCCEEDED') return {
    badge: runLabels.SUCCEEDED, tone: s.badgeOk, action: '결과 보기', to: resultPath, state: 'done' as const,
    note: run.inputRevision < item.inputRevision ? '입력을 바꾼 뒤에는 아직 실행하지 않았어요. 지난 입력의 결과예요' : '판단 결과와 확인할 정보를 볼 수 있어요',
  }
  return { badge: runLabels[run.status], tone: s.badgeDanger, note: '분석을 끝내지 못했어요. 이유를 확인하고 다시 실행할 수 있어요', action: '자세히 보기', to: resultPath, state: 'failed' as const }
}

/** 화면에 보이는 경과 시간을 갱신하는 현재 시각입니다. 진행 중인 작업이 있을 때만 돌아갑니다. */
function useNow(enabled: boolean, intervalMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [enabled, intervalMs])
  return now
}

function ReviewListCard({ item, now, deleteDisabled, onDelete }: { item: ReviewListItem; now: number; deleteDisabled: boolean; onDelete: () => void }) {
  const view = latestRunView(item)
  const run = item.latestRun
  const working = view.state === 'working'
  const minutes = run ? Math.max(0, Math.floor((now - Date.parse(run.startedAt)) / 60_000)) : 0
  return <li className={`${s.listCard} ${working ? s.listCardWorking : view.state === 'checking' ? s.listCardChecking : ''}`}>
    <div className="flex flex-wrap items-center gap-2">
      <span className={`${s.badge} ${view.tone}`}>{run?.status === 'RUNNING' && <span className={s.buttonSpinner} aria-hidden="true" />}{view.badge}</span>
      <span className="text-xs text-ink-muted">입력 버전 {item.inputRevision}</span>
    </div>
    <Link className="flex min-w-0 flex-col gap-0.5 no-underline hover:[&>strong]:text-brand-primary" to={view.to}>
      <strong className={s.listTitle}>{item.title}</strong>
      <span className={s.listMeta}>{view.note}</span>
    </Link>
    {working && <div className="flex flex-col gap-1">
      <span className={s.listStamp}>{Number.isNaN(minutes) || minutes < 1 ? '방금 시작했어요' : `${minutes}분 지남`} · 화면을 나가도 계속돼요</span>
      <div className={s.workTrack} aria-hidden="true"><div className={s.workSweep} /></div>
    </div>}
    <div className={s.listFooter}>
      <span className={s.listStamp}>{run && (working || view.state === 'checking') ? `${formatReviewClock(run.startedAt)} 시작` : `${formatReviewDateTime(item.updatedAt)} 수정`}</span>
      <div className="flex items-center gap-2">
        {/* 분석 중이거나 결과를 확인하는 중에는 삭제를 막습니다. 끝나면 다시 지울 수 있습니다. */}
        <ReviewMenu item={item} disabled={deleteDisabled || working || view.state === 'checking'} onDelete={onDelete} />
        <Link className={s.secondarySm} to={view.to}>{view.action}<span className="sr-only">: {item.title}</span></Link>
      </div>
    </div>
  </li>
}

function ReviewList({ account }: { account: string }) {
  const vm = useReviewListViewModel(account)
  const [confirming, setConfirming] = useState<ReviewListItem | null>(null)
  const [toast, setToast] = useState<WorkspaceToastNotice | null>(null)
  const deleting = vm.busy.includes('delete')
  const loading = vm.busy.includes('list')
  // 처음 읽을 때만 300ms가 넘으면 카드 자리를 그립니다. 더 보기는 버튼이 진행을 알립니다.
  const showSkeleton = useDelayedFlag(loading && vm.page === null)
  const items = vm.page?.items ?? []
  const now = useNow(items.some((item) => latestRunView(item).state === 'working'), 15_000)
  const header = <WorkspacePageHeader title={listTitle} actions={<Link className={workspacePageStyles.primaryButton} to={appPaths.combinationReviewNew}>새 검토</Link>} />
  if (vm.error?.status === 401) return <>{header}<main className={workspacePageStyles.content}><ReviewError error={vm.error} /></main></>
  return <>{header}<main className={workspacePageStyles.content}>
    <ReviewError error={confirming ? null : vm.error} />
    {vm.pollingPaused && <p className={s.warning}>진행 상태 자동 확인이 멈췄어요. [다시 시도]로 목록을 다시 불러와 주세요. 서버 작업은 취소되지 않아요.</p>}
    {loading && <p className="sr-only" role="status">검토 목록을 불러오는 중입니다.</p>}
    {showSkeleton && <ReviewListSkeleton />}
    {vm.page?.items.length === 0 && <div className={`${s.card} flex flex-col items-center gap-2 text-center`}>
      <h2 className="font-semibold">아직 저장한 검토가 없어요</h2>
      <p className={s.muted}>새 검토에서 공고 2개와 참여 상태를 입력하면 분석을 시작할 수 있어요.</p>
      <Link className={s.secondarySm} to={appPaths.combinationReviewNew}>새 검토</Link>
    </div>}
    {items.length > 0 && <ul className="grid gap-3" aria-label="저장한 검토">{items.map((item) =>
      <ReviewListCard key={item.id} item={item} now={now} deleteDisabled={deleting} onDelete={() => setConfirming(item)} />)}</ul>}
    {vm.error && <div className="flex justify-center"><button className={s.secondarySm} disabled={loading} onClick={() => void vm.load()}>다시 시도</button></div>}
    {vm.page?.nextBeforeId && <div className="flex justify-center"><button className={s.secondarySm} disabled={loading} aria-busy={loading} onClick={() => void vm.load(vm.page!.nextBeforeId!)}>{loading ? <><span className={s.buttonSpinner} aria-hidden="true" />불러오는 중…</> : '더 보기'}</button></div>}
  </main>
  <WorkspaceModal isOpen={confirming !== null} title="검토를 삭제할까요?" tone="danger" onClose={() => setConfirming(null)}
    description={confirming ? `${confirming.title}의 입력과 실행 기록 · 보관한 원문이 모두 지워져요. 되돌릴 수 없어요.` : undefined}>
    <ReviewError error={vm.error} />
    <div className="flex flex-wrap justify-end gap-2">
      <button className={s.button} disabled={deleting} type="button" onClick={() => setConfirming(null)}>취소</button>
      <button className={s.dangerSolid} disabled={deleting} aria-busy={deleting} type="button" onClick={() => {
        if (confirming === null) return
        void vm.deleteReview(confirming.id).then((deleted) => { if (deleted) { setConfirming(null); setToast({ id: Date.now(), text: '검토를 삭제했어요' }) } })
      }}>{deleting ? '삭제 중…' : '삭제'}</button>
    </div>
  </WorkspaceModal>
  <WorkspaceToast notice={toast} onClose={() => setToast(null)} />
  </>
}

/** 새 검토 주소의 `sourceCode`·`sourceProgramId`로 미리 고를 공고입니다. 형식이 맞지 않으면 고르지 않고, 서버가 저장할 때 다시 검증합니다. */
function addressProgram(params: URLSearchParams): InitialReviewProgram | null {
  const sourceCode = params.get('sourceCode') ?? ''
  const sourceProgramId = (params.get('sourceProgramId') ?? '').trim()
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(sourceCode) && sourceProgramId ? { sourceCode, sourceProgramId } : null
}

export function CombinationReviewEditorPage({ create = false }: { create?: boolean }) {
  const account = useAppSelector(selectCurrentAccount)
  const { reviewId } = useParams()
  const [searchParams] = useSearchParams()
  const id = create ? null : Number(reviewId)
  if (!account) return null
  if (!create && (!Number.isSafeInteger(id) || id! <= 0)) return <><WorkspacePageHeader parent={{ to: appPaths.combinationReviews, label: listTitle }} title="검토" /><main className={workspacePageStyles.content}><p role="alert">올바른 검토 주소가 아닙니다.</p><Link className={workspacePageStyles.quietLink} to={appPaths.combinationReviews}>목록으로</Link></main></>
  // 공고 상세의 [중복 지원·수혜 검토]로 열면 그 공고를 사업 1로 골라 둡니다. 고른 공고가 바뀌면 새로 시작합니다.
  const initialProgram = create ? addressProgram(searchParams) : null
  const editorKey = id ?? `new:${initialProgram ? reviewProgramKey(initialProgram) : ''}`
  return <ReviewEditor key={`${sessionKey(account)}:${editorKey}`} id={id} account={account.email} initialProgram={initialProgram} />
}

export function CombinationReviewRunResultPage() {
  const account = useAppSelector(selectCurrentAccount)
  const { reviewId: reviewIdParam, runId: runIdParam } = useParams()
  const reviewId = Number(reviewIdParam)
  const runId = Number(runIdParam)
  const valid = Number.isSafeInteger(reviewId) && reviewId > 0 && Number.isSafeInteger(runId) && runId > 0
  if (!account) return null
  if (!valid) return <><WorkspacePageHeader parent={{ to: appPaths.combinationReviews, label: listTitle }} title="검토 결과" /><main className={workspacePageStyles.content}><p role="alert">올바른 실행 결과 주소가 아닙니다.</p><Link className={workspacePageStyles.quietLink} to={appPaths.combinationReviews}>목록으로</Link></main></>
  return <RunResultPage key={`${sessionKey(account)}:${reviewId}:${runId}`} reviewId={reviewId} runId={runId} account={account.email} />
}

function RunResultPage({ reviewId, runId, account }: { reviewId: number; runId: number; account: string }) {
  const vm = useReviewEditorViewModel(reviewId, account, false, runId)
  const navigate = useNavigate()
  const contentRef = useRef<HTMLElement>(null)
  const reviewPath = `${appPaths.combinationReviews}/${reviewId}`
  const header = <WorkspacePageHeader parent={[{ to: appPaths.combinationReviews, label: listTitle }, { to: `${reviewPath}?step=analysis`, label: vm.review?.title ?? '검토' }]} title="검토 결과"
    actions={<Link className={workspacePageStyles.secondaryButton} to={`${reviewPath}?step=participation`}>입력 수정</Link>} />
  useEffect(() => {
    const scrollArea = contentRef.current?.parentElement
    if (scrollArea && typeof scrollArea.scrollTo === 'function') scrollArea.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [])
  // 첫 렌더(읽기 시작 전)도 실패하기 전까지는 읽는 중으로 봅니다.
  const loadingRun = vm.run?.id !== runId && (vm.busy.some((value) => value === 'load' || value === 'run') || vm.error === null)
  const showRunSkeleton = useDelayedFlag(loadingRun)
  const historyBusy = vm.busy.includes('history')
  if (vm.error?.status === 401) return <>{header}<main className={workspacePageStyles.content}><ReviewError error={vm.error} /></main></>
  const selectedRun = vm.run?.id === runId ? vm.run : null
  const runOptions = vm.runs?.items ?? []
  const currentRunInOptions = runOptions.some((run) => run.id === runId)
  return <>{header}<main ref={contentRef} className={workspacePageStyles.content}>
    <div className="flex flex-wrap items-end justify-between gap-3">
      <p className={s.muted}>실행 #{runId}{selectedRun && ` · ${formatReviewDateTime(selectedRun.startedAt)} · 입력 버전 ${selectedRun.inputRevision}`}</p>
      <div className="flex flex-wrap items-center gap-2">
        <SelectField label="실행 결과 선택" className={`${s.input} mt-0 w-auto min-w-56`} value={String(runId)}
          options={[
            ...(currentRunInOptions ? [] : [{ value: String(runId), label: `실행 #${runId} · 현재 결과` }]),
            ...runOptions.map((run) => ({ value: String(run.id), label: `실행 #${run.id} · ${runLabels[run.status]} · ${formatReviewDateTime(run.startedAt)}` })),
          ]}
          onChange={(value) => navigate(combinationReviewRunResultPath(reviewId, Number(value)))} />
        {vm.runs?.nextBeforeId && <button className={s.secondarySm} type="button" disabled={historyBusy} aria-busy={historyBusy} onClick={() => vm.history(vm.runs!.nextBeforeId!)}>{historyBusy ? <><span className={s.buttonSpinner} aria-hidden="true" />불러오는 중…</> : '이전 실행 더 보기'}</button>}
      </div>
    </div>
    <ReviewError error={vm.error} />
    {loadingRun && <p className="sr-only" role="status">실행 결과를 불러오는 중입니다.</p>}
    {showRunSkeleton && <ReviewRunResultSkeleton />}
    {!selectedRun && vm.review && vm.error && !vm.busy.includes('run') && <div className="flex justify-center"><button className={s.primary} type="button" onClick={() => vm.selectRun(runId)}>다시 시도</button></div>}
    {selectedRun && <ReviewRunResult run={selectedRun} currentRevision={vm.review?.inputRevision ?? selectedRun.inputRevision} names={vm.names} download={vm.download} downloading={vm.busy.includes('download')} />}
  </main></>
}

function ReviewEditor({ id, account, initialProgram = null }: { id: number | null; account: string; initialProgram?: InitialReviewProgram | null }) {
  const location = useLocation()
  const suppliedFacts = (location.state as { additionalFacts?: unknown } | null)?.additionalFacts
  const initialFacts = typeof suppliedFacts === 'string' ? suppliedFacts : ''
  const [savedProgramsOpen, setSavedProgramsOpen] = useState(false)
  const vm = useReviewEditorViewModel(id, account, savedProgramsOpen, null, initialFacts, initialProgram)
  // 단계는 주소(?step=)가 정합니다. 새로고침 · 뒤로 가기 · 링크로 들어와도 같은 단계를 봅니다. 저장 전인 새 검토는 1단계뿐입니다.
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedStep = searchParams.get('step')
  const step: Step = id && (requestedStep === 'analysis' || requestedStep === 'participation') ? requestedStep : 'selection'
  const reasonId = useId()
  const contentRef = useRef<HTMLElement>(null)
  const savedProgramsButtonRef = useRef<HTMLButtonElement>(null)
  const closeSavedPrograms = () => { setSavedProgramsOpen(false); savedProgramsButtonRef.current?.focus() }
  useEffect(() => {
    setSavedProgramsOpen(false)
    const scrollArea = contentRef.current?.parentElement
    if (scrollArea && typeof scrollArea.scrollTo === 'function') scrollArea.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [step])
  const saving = vm.busy.includes('save')
  const inputBusy = saving || vm.busy.includes('load')
  const analysisBusy = vm.busy.includes('analysis')
  const historyBusy = vm.busy.includes('history')
  // 저장한 검토를 처음 읽는 동안은 지금 단계의 카드 자리를, 공고 검색은 첫 결과 전에만 행 자리를 그리고 이후에는 이전 결과를 흐리게 둡니다.
  // 첫 렌더는 읽기를 시작하기 전이라 busy가 비어 있습니다. 실패하기 전까지는 읽는 중으로 보고 [다시 시도] 카드가 잠깐 비치지 않게 합니다.
  const loadingReview = Boolean(id) && !vm.review && (vm.busy.includes('load') || vm.error === null)
  const showReviewSkeleton = useDelayedFlag(loadingReview)
  const catalogLoading = vm.busy.includes('catalog')
  const showCatalogSkeleton = useDelayedFlag(catalogLoading && !vm.catalog)
  const invalidProgramCount = vm.draft.programs.length !== 2
  const unsupported = vm.draft.programs.some((p) => !supportsAutomaticReview(p))
  const activeRun = vm.runs?.items.find((run) => run.status === 'QUEUED' || run.status === 'RUNNING')
  const unknownRun = vm.runs?.items.some((run) => run.status === 'UNKNOWN')
  // 실행 기록은 최신순입니다. 끝난 최근 실행은 3단계 위쪽에서 결과로 바로 갈 수 있게 보여 줍니다.
  const latestRun = vm.runs?.items[0] ?? null
  const finishedRun = latestRun && !['QUEUED', 'RUNNING', 'UNKNOWN'].includes(latestRun.status) ? latestRun : null
  const currentResult = finishedRun?.status === 'SUCCEEDED' && finishedRun.inputRevision === vm.review?.inputRevision && !vm.dirty ? finishedRun : null
  const now = useNow(!!activeRun, 1000)
  const changeStep = (next: Step) => { vm.setError(null); setSearchParams(next === 'selection' ? {} : { step: next }) }
  // 단계를 넘길 때 입력을 검증 · 저장합니다(새 검토는 1단계에서 만들어 주소가 바뀜).
  const goTo = (next: Step) => vm.saveInput(() => changeStep(next))
  const stepIndex = steps.findIndex(([value]) => value === step)
  const title = id ? (vm.review?.title ?? '검토') : '새 검토'
  const header = <WorkspacePageHeader parent={{ to: appPaths.combinationReviews, label: listTitle }} title={title} />
  const saveNote = saving ? '저장 중…' : !id || vm.dirty ? '다음 단계로 넘어가면 자동 저장돼요' : '자동 저장됨'
  const nextLabel = saving ? <><span className={s.buttonSpinner} aria-hidden="true" />저장 중…</> : '다음 →'
  // 주 버튼을 누를 수 없는 이유입니다. 버튼 옆에 적고 aria-describedby로 연결합니다.
  const selectionBlocked = !vm.draft.title.trim() ? '검토 제목을 입력하면 넘어갈 수 있어요'
    : invalidProgramCount ? `공고를 2개 고르면 넘어갈 수 있어요 · 지금 ${vm.draft.programs.length}개` : null
  const runBlocked = activeRun ? '분석이 끝나면 다시 실행할 수 있어요'
    : unknownRun ? '완료 여부를 확인하지 못한 실행이 있어 새 분석을 막았어요'
      : vm.dirty ? '바뀐 입력을 이전 단계에서 저장하면 실행할 수 있어요'
        : invalidProgramCount ? '공고를 2개로 줄이면 실행할 수 있어요'
          : unsupported ? '자동 분석을 지원하지 않는 공고가 있어요' : null
  if (vm.error?.status === 401) return <>{header}<main className={workspacePageStyles.content}><ReviewError error={vm.error} /></main></>
  return <>{header}<main ref={contentRef} className={workspacePageStyles.content}>
    <ol className="grid gap-2 max-[599px]:hidden sm:grid-cols-3" aria-label="검토 진행 단계">
      {steps.map(([value, label], index) => <li key={value} className={`flex flex-col rounded-2xl border px-3 py-2 ${index === stepIndex ? 'border-brand-primary bg-brand-soft' : index < stepIndex ? 'border-brand-primary/40 bg-white' : 'border-slate-200 bg-white'}`} aria-current={index === stepIndex ? 'step' : undefined}>
        <span className={`text-xs font-bold ${index <= stepIndex ? 'text-brand-primary' : 'text-slate-500'}`}>{index + 1}단계{index < stepIndex ? ' · 완료' : index === stepIndex ? ' · 진행 중' : ''}</span>
        <b className="text-sm">{label}</b>
      </li>)}
    </ol>
    <div className="flex flex-col gap-1.5 min-[600px]:hidden" aria-hidden="true">
      <div className="flex justify-between text-sm font-extrabold"><span>{steps[stepIndex]![1]}</span><span className="text-slate-500 tabular-nums">{stepIndex + 1} / 3</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted"><i className="block h-full rounded-full bg-brand-primary" style={{ width: `${(stepIndex + 1) / 3 * 100}%` }} /></div>
      <span className="text-xs text-slate-500">{saveNote}</span>
    </div>
    <ReviewError error={vm.error} />
    {id && vm.error?.runId && <Link className={s.secondarySm} to={combinationReviewRunResultPath(id, vm.error.runId)}>실패 실행 #{vm.error.runId} 확인</Link>}
    {vm.rejectedRevision && vm.pending && <button className={s.secondarySm} onClick={vm.clearRejectedRequest}>버전 충돌로 거절된 실행 요청 정리</button>}
    {vm.notice && <p role="status" className={s.muted}>{vm.notice}</p>}
    {id && !vm.review ? (loadingReview
      ? <><p className="sr-only" role="status">저장 입력과 실행 기록을 불러오는 중입니다.</p>{showReviewSkeleton && <ReviewEditorSkeleton step={step} />}</>
      : <div className={s.card}><button className={s.secondarySm} onClick={vm.load}>다시 시도</button></div>) : <>
      {step === 'selection' && <>
        <fieldset disabled={inputBusy} className="space-y-4">
          <div className={s.card}><label className="font-semibold">검토 제목<input className={s.input} value={vm.draft.title} onChange={(e) => vm.setDraft({ ...vm.draft, title: e.target.value })} required placeholder="예: 창업 지원사업 참여 검토" /></label><p className={s.muted}>제목은 200자 이내입니다. 참여 상태는 다음 단계에서 입력합니다.</p></div>
          <section className={s.card} aria-label="공고 선택">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold">비교할 공고 선택</h2><strong className="rounded-full bg-brand-soft px-3 py-1 text-sm text-brand-primary">{vm.draft.programs.length}/2 선택</strong></div>
            <p className={s.muted}>관심 공고함이나 전체 공고 검색에서 서로 비교할 공고를 정확히 2개 선택하세요. 접수 마감 공고도 참여 이력 검토에 사용할 수 있습니다.</p>
            <div className="mt-3 flex min-h-12 flex-col items-stretch gap-2 rounded-xl bg-slate-50 px-3 py-2" aria-label="현재 선택한 공고">
              {vm.draft.programs.length === 0 && <span className="text-sm text-slate-500">선택한 공고가 없습니다.</span>}
              {vm.draft.programs.map((program, index) => {
                const name = vm.names[reviewProgramKey(program)] ?? '공고 정보 확인 중'
                return <span className="inline-flex w-full min-w-0 items-center gap-2 rounded-xl border border-brand-primary/30 bg-brand-soft py-1 pr-1 pl-3 text-sm font-semibold text-brand-primary" key={reviewProgramKey(program)}><span className="min-w-0 flex-1 break-words">사업 {index + 1} · {name}</span><button type="button" className="grid size-7 shrink-0 place-items-center rounded-full hover:bg-brand-soft focus-visible:outline-2 focus-visible:outline-brand-primary" aria-label={`${name} 선택 해제`} onClick={() => vm.setDraft({ ...vm.draft, programs: vm.draft.programs.filter((_, selectedIndex) => selectedIndex !== index) })}>×</button></span>
              })}
            </div>
            <button ref={savedProgramsButtonRef} type="button" className="mt-4 flex w-full cursor-pointer items-center justify-between rounded-xl border border-slate-300 bg-white px-4 py-3 text-left text-sm font-semibold hover:border-brand-primary hover:bg-brand-soft focus-visible:outline-2 focus-visible:outline-brand-primary" aria-label="관심 공고함에서 선택" aria-haspopup="dialog" aria-expanded={savedProgramsOpen} onClick={() => setSavedProgramsOpen(true)}><span>관심 공고함에서 선택</span><span className="text-brand-primary">열기 ›</span></button>
            <SavedSupportProgramPickerDialog open={savedProgramsOpen} phase={vm.savedProgramChoices.phase} programs={vm.savedProgramChoices.programs} selectedProgramKeys={vm.draft.programs.map((program) => `${program.sourceCode}:${program.sourceProgramId}`)} selectionLimit={2} description="비교할 공고를 최대 2개까지 선택할 수 있습니다." listLabel="중복 지원 검토 관심 공고 목록" onToggle={vm.toggle} onRetry={vm.savedProgramChoices.retry} onClose={closeSavedPrograms} />
            <h3 className="mt-5 font-semibold">전체 공고 검색</h3>
            <div className="mt-3"><SupportProgramSearchFilters filters={vm.catalogFilters} appliedFilters={vm.appliedCatalogFilters} catalog={vm.catalog}
              disabled={inputBusy} loading={catalogLoading} onChange={vm.setCatalogFilters}
              onSearch={(filters) => { void vm.search(1, filters) }} /></div>
            {catalogLoading && <p className="sr-only" role="status">공고를 불러오는 중입니다.</p>}
            {showCatalogSkeleton && <CatalogRowSkeletons />}
            {/* 다시 검색하는 동안은 0건을 먼저 보여 주지 않고 이전 결과를 흐리게 둡니다. */}
            {!catalogLoading && vm.catalog?.programs.length === 0 && <p className="mt-3">검색 결과가 없습니다. 검색어나 필터를 바꿔 다시 검색해 주세요.</p>}
            <ul className={`mt-4 divide-y divide-slate-200 ${catalogLoading && vm.catalog ? s.stale : ''}`} aria-busy={catalogLoading}>{vm.catalog?.programs.map((program) => {
              const identity = { sourceCode: program.sourceCode, sourceProgramId: program.id, subProgramId: null }
              const selected = vm.draft.programs.some((p) => reviewProgramKey(p) === reviewProgramKey(identity))
              return <li className={`my-2 rounded-xl border px-3 py-3 transition-colors ${selected ? 'border-brand-primary bg-brand-soft ring-1 ring-brand-primary/20' : 'border-transparent'}`} key={reviewProgramKey(identity)}><div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0 flex-1"><strong>{program.title}</strong><p className={s.muted}>{program.organization} · {programStatusLabels[program.status]}</p><p className={s.muted}>{program.applicationPeriod}</p></div><button type="button" className={selected ? s.primary : s.button} aria-pressed={selected} disabled={!selected && vm.draft.programs.length >= 2} onClick={() => vm.toggle(program)}>{selected ? '선택 해제' : '선택'}</button></div>
                {!supportsAutomaticReview(identity) && <p className="text-sm text-amber-800">현재 자동 분석을 지원하지 않는 공고입니다.</p>}
                <Link className="text-sm text-brand-primary underline" to={supportProgramDetailPath({ sourceCode: identity.sourceCode, sourceProgramId: identity.sourceProgramId }, true)} target="_blank">공고 상세 확인</Link>
              </li>
            })}</ul>
            {vm.catalog && <div className="mt-3 flex items-center gap-3"><button type="button" className={s.button} disabled={vm.catalog.page <= 1 || vm.busy.includes('catalog')} onClick={() => void vm.search(vm.catalog!.page - 1, vm.appliedCatalogFilters)}>이전 공고</button><span className="text-sm">{vm.catalog.page} / {Math.max(1, vm.catalog.totalPages)}</span><button type="button" className={s.button} disabled={vm.catalog.page >= vm.catalog.totalPages || vm.busy.includes('catalog')} onClick={() => void vm.search(vm.catalog!.page + 1, vm.appliedCatalogFilters)}>다음 공고</button></div>}
          </section>
          {unsupported && <p className={s.warning}>{unsupportedNotice}</p>}
        </fieldset>
        <StepBar note={saveNote} reason={selectionBlocked} reasonId={reasonId}
          next={<button className={s.primaryPill} type="button" onClick={() => goTo('participation')} disabled={!!selectionBlocked || inputBusy} aria-busy={saving} aria-describedby={selectionBlocked ? reasonId : undefined}>{nextLabel}</button>} />
      </>}
      {step === 'participation' && <>
        <fieldset disabled={inputBusy} className="space-y-4">
          <p className={s.muted}>공고마다 지금 어디까지 진행했는지 골라 주세요. 잘 모르면 "잘 모르겠음"으로 두세요.</p>
          {vm.draft.programs.map((program, index) => <ReviewParticipation key={reviewProgramKey(program)} program={program} index={index} name={vm.names[reviewProgramKey(program)]} onChange={(participation) => vm.setDraft({ ...vm.draft, programs: vm.draft.programs.map((p, i) => i === index ? { ...p, participation } : p) })} />)}
          <div className={s.card}><label className="block text-sm font-semibold">분석에 참고할 추가 설명 (선택)<textarea className={s.input} rows={4} maxLength={8000} value={vm.facts} onChange={(e) => vm.setFacts(e.target.value)} placeholder={'예: 두 사업에서 같은 인건비를 사용하려고 합니다.\n한 사업의 확약서를 철회할 예정입니다.\n두 사업의 수행 내용이 일부 같습니다.'} /></label><p className={s.muted}>{vm.facts.length}/8000 · 이번 실행에만 저장돼요.</p></div>
          {unsupported && <p className={s.warning}>{unsupportedNotice}</p>}
        </fieldset>
        <StepBar note={saveNote} back={<button className={s.secondaryPill} type="button" disabled={inputBusy} onClick={() => goTo('selection')}>← 이전</button>}
          next={<button className={s.primaryPill} type="button" disabled={inputBusy} aria-busy={saving} onClick={() => goTo('analysis')}>{nextLabel}</button>} />
      </>}
      {step === 'analysis' && id && <>
        <p className={s.info}>{scopeNotice}</p>
        {/* 진행 중이면 진행 카드를, 끝났으면 최근 결과로 가는 카드를 맨 위에 둡니다. 상태가 바뀌면 화면 읽기 프로그램이 한 번 읽습니다. */}
        <div role="status" aria-live="polite" className="contents">
          {activeRun && <RunProgress run={activeRun} now={now} />}
          {!activeRun && finishedRun && <LatestRunCard reviewId={id} run={finishedRun} stale={finishedRun.inputRevision !== vm.review?.inputRevision || vm.dirty} />}
        </div>
        <section className={`${s.card} space-y-3`} aria-label="분석 대상 공고"><h2 className="font-bold">분석 대상 공고</h2><ul className="space-y-2">{vm.draft.programs.map((program, index) => <li key={reviewProgramKey(program)} className="rounded-lg bg-slate-50 p-3"><strong>사업 {index + 1} · {vm.names[reviewProgramKey(program)] ?? '공고 정보 확인 중'}</strong></li>)}</ul></section>
        <section className={`${s.card} space-y-3`} aria-label="분석 실행"><h2 className="text-lg font-bold">공식 근거 분석</h2>
          <p className={s.muted}>PDF·HWP·HWPX 공식 첨부를 자동 수집하여 OpenAI로 분석합니다. [검토 실행]을 누르면 유료 API 호출이 발생할 수 있습니다. 원문 미확보·미지원 형식은 오류로 표시합니다.</p>
          {vm.dirty && <p className={s.warning}>저장하지 않은 입력이 있습니다. 이전 단계에서 저장한 뒤 분석해 주세요.</p>}
          {invalidProgramCount && <p className={s.warning}>기존에 저장한 3개 공고의 결과는 조회할 수 있지만 새 분석은 공고를 2개로 줄인 뒤 실행할 수 있습니다.</p>}
          {unsupported && <p className={s.warning}>{unsupportedNotice}</p>}
          {analysisBusy && <p role="status" className={s.info}>분석 요청을 접수하고 있어요. 창을 닫아도 접수된 서버 작업은 취소되지 않아요.</p>}
          {unknownRun && <p className={s.warning}>완료 여부를 확인할 수 없는 실행이 있어 같은 검토의 새 분석을 막았어요. 중복 과금을 막기 위해 자동으로 다시 실행하지 않으며 운영자 확인이 필요해요.</p>}
          {vm.pollingPaused && <p className={s.warning}>상태 자동 조회가 멈췄어요. 아래 실행 기록에서 항목을 눌러 다시 확인해 주세요. 서버 작업은 취소되지 않아요.</p>}
          {vm.pending && <div className={`${s.warning} flex flex-wrap items-center justify-between gap-3`}><div><p>응답을 확인하지 못한 분석 요청이 있어요. 같은 요청 키 · 입력 버전 · 추가 설명으로만 다시 확인해요.</p><p>요청 입력 버전 {vm.pending.expectedRevision}</p><p className="whitespace-pre-wrap">추가 설명: {vm.pending.additionalFacts || '없음'}</p></div><button className={s.secondarySm} disabled={analysisBusy} onClick={() => vm.start(true)}>다시 시도</button></div>}
        </section>
        <section className={`${s.card} space-y-3`} aria-label="실행 기록"><h2 className="text-lg font-bold">실행 기록</h2>
          {vm.runs?.items.length === 0 && <p className={s.muted}>아직 분석을 실행하지 않았습니다.</p>}
          <ul className="space-y-2">{vm.runs?.items.map((run) => <li key={run.id}><Link className={`${s.button} w-full justify-start text-left`} to={combinationReviewRunResultPath(id, run.id)}>#{run.id} · 입력 버전 {run.inputRevision} · {runLabels[run.status]} · {formatReviewDateTime(run.startedAt)}</Link></li>)}</ul>
          {vm.runs?.nextBeforeId && <div className="flex justify-center"><button className={s.secondarySm} disabled={historyBusy} aria-busy={historyBusy} onClick={() => vm.history(vm.runs!.nextBeforeId!)}>{historyBusy ? <><span className={s.buttonSpinner} aria-hidden="true" />불러오는 중…</> : '이전 실행 더 보기'}</button></div>}
        </section>
        <StepBar note={activeRun ? '화면을 나가도 분석은 계속돼요' : '검토 실행 1회마다 유료 분석이 한 번 실행돼요'} reason={vm.pending ? null : runBlocked} reasonId={reasonId}
          back={<button className={s.secondaryPill} type="button" disabled={inputBusy} onClick={() => changeStep('participation')}>← 이전</button>}
          next={vm.pending ? null : <>
            {/* 현재 입력으로 끝난 결과가 있으면 [결과 보기]가 주 동작이고, 다시 실행은 보조 동작입니다(실행마다 유료). */}
            {currentResult && <Link className={s.primaryPill} to={combinationReviewRunResultPath(id, currentResult.id)}>결과 보기 →</Link>}
            <button className={currentResult ? s.secondaryPill : s.primaryPill} type="button" aria-busy={analysisBusy || !!activeRun}
              aria-describedby={runBlocked ? reasonId : undefined}
              disabled={analysisBusy || inputBusy || !!runBlocked} onClick={() => vm.start(false)}>
              {(analysisBusy || activeRun) && <span className={s.buttonSpinner} aria-hidden="true" />}
              {analysisBusy ? '접수 중…' : activeRun ? (activeRun.status === 'QUEUED' ? '차례 기다리는 중…' : '분석 중…') : currentResult || finishedRun ? '다시 실행' : '검토 실행'}
            </button>
          </>} />
      </>}
    </>}
  </main></>
}

/**
 * 단계 화면 아래에 붙는 이동 바입니다(화면 통일안 R3 StepFlow · 신청 문서 답변 입력과 같은 배치).
 * 왼쪽 [← 이전] · 가운데 저장 상태 안내 · 오른쪽 주 동작. 주 동작을 누를 수 없으면 그 이유를 버튼 앞에 적습니다.
 */
function StepBar({ back, note, reason = null, reasonId, next }: { back?: ReactNode; note: string; reason?: string | null; reasonId?: string; next: ReactNode }) {
  // 모든 폭에서 아래에 붙는 바라 도우미 런처를 그 위로 올립니다.
  return <div className={s.stepBar} {...assistantLift.always}>
    {back}
    <span className={s.stepBarNote} role="status" aria-live="polite">{note}</span>
    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
      {reason && <p className={`${s.stepBarReason} m-0`} id={reasonId}>{reason}</p>}
      {next}
    </div>
  </div>
}

/**
 * 접수한 분석의 진행 카드입니다(신청 문서의 양식 분석 · 초안 진행 카드와 같은 틀).
 * 서버가 주는 상태(대기 · 분석 중)와 접수 뒤 지난 시간만 보여 주고, 세부 단계나 남은 시간은 지어내지 않습니다.
 */
function RunProgress({ run, now }: { run: RunSummary; now: number }) {
  const running = run.status === 'RUNNING'
  return <section className={s.progress} aria-label="분석 진행">
    <div className={s.progressHead}>
      <span className={s.spinner} aria-hidden="true" />
      <strong className={s.progressTitle}>{running ? '공식 문서를 읽고 단계별로 판단하고 있어요' : '분석 차례를 기다리고 있어요'}</strong>
      <span className={s.progressTime}>{elapsedLabel((now - Date.parse(run.startedAt)) / 1000)}</span>
    </div>
    <ol className={s.progressSteps} aria-label="진행 단계">
      <li className={running ? s.progressStepDone : s.progressStepNow} aria-current={running ? undefined : 'step'}>{running ? '✓ 접수 · 대기' : '● 접수 · 대기 중'}</li>
      <li className={running ? s.progressStepNow : s.progressStep} aria-current={running ? 'step' : undefined}>{running ? '● 원문 수집 · 분석 중' : '원문 수집 · 분석'}</li>
    </ol>
    <p className={s.progressNote}>화면을 나가도 계속돼요. 검토 목록에서도 진행 상태를 볼 수 있고, 끝나면 여기에서 바로 결과를 열 수 있어요.</p>
  </section>
}

/** 끝난 최근 실행으로 가는 카드입니다. 성공은 [결과 보기], 실패 · 중단은 [자세히 보기]로 결과 화면의 이유를 엽니다. */
function LatestRunCard({ reviewId, run, stale }: { reviewId: number; run: RunSummary; stale: boolean }) {
  const succeeded = run.status === 'SUCCEEDED'
  const when = formatReviewDateTime(run.finishedAt ?? run.startedAt)
  return <section className={`${s.resultCard} ${succeeded ? s.resultCardDone : s.resultCardFailed}`} aria-label="최근 실행">
    <div className={s.resultCardText}>
      <strong>{succeeded ? '최근 분석이 끝났어요' : run.status === 'INTERRUPTED' ? '최근 분석이 중단됐어요' : '최근 분석을 끝내지 못했어요'}</strong>
      <span className="text-xs text-ink-muted">실행 #{run.id} · 입력 버전 {run.inputRevision} · {when}</span>
      {stale && <span className="text-xs text-ink-muted">지금 입력과 다른 버전의 결과예요. 바뀐 입력으로 보려면 다시 실행해 주세요.</span>}
    </div>
    <Link className={s.secondarySm} to={combinationReviewRunResultPath(reviewId, run.id)}>{succeeded ? '결과 보기' : '자세히 보기'}<span className="sr-only">: 실행 #{run.id}</span></Link>
  </section>
}
