import type { GovAgentApplication, GovAgentReview } from '@govbiz/shared/domain/entities/GovAgent'
import { reviewAnswerHeadline, reviewAnswersOf } from '@govbiz/shared/domain/entities/CombinationReviewResult'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import type { ApplicationDocumentGenerationJob } from '../../../../domain/entities/ApplicationPreparation'
import type { ReviewAnswer } from '../../../../domain/entities/CombinationReview'
import { partnerRoleLabels } from '../../../../domain/entities/PartnerRecruitment'
import {
  emptyPartnerRecruitmentConditions,
  type PartnerMatchCaution,
  type PartnerMatchReason,
  type PartnerRecruitmentConditions,
  type PartnerRecruitmentRecommendations,
} from '@govbiz/shared/domain/entities/PartnerRecruitmentRecommendation'
import { saveBlob } from '../../../shared/download/saveBlob'
import { RecruitmentCard } from '../../../shared/partner-recruitment/RecruitmentCard'
import { appPaths, combinationReviewRunResultPath } from '../../../shared/routes/appPaths'
import { ReviewAnswerChips } from '../../combination-review/view/ReviewAnswerResult'
import { preparationOf, preparationPath, type ProgramPreparations } from '../hooks/useProgramPreparations'
import { partnerRecruitmentStyles } from '../../partner-recruitment/view/PartnerRecruitment.styles'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'
import { WorkSteps, type WorkStepState } from '../../../shared/workspace/WorkSteps'
import { elapsedLabel, useElapsedSeconds } from '../../../shared/workspace/elapsed'

/**
 * 대화에는 작업 카드만 두고, 입력이 필요한 일(양식 고르기 · 답변 작성 · 초안, 검토 입력 · 결과)은 카드 버튼이 대화 위 시트로 엽니다.
 * 카드는 이름 · 상태 배지 · 3단계 띠 · 한 줄 · 버튼이고, 상태는 기존 목록 · 실행 API로 다시 읽습니다(AI 호출 없음).
 * 분석 · 초안 생성처럼 돌아가는 일이 있으면 최근 카드만 5초마다 상태를 다시 읽어 단계를 옮기고, 끝나면 멈춥니다.
 * 화면에서 끝낸 일은 지난 카드도 끝난 상태(초안 완료 · 검토 결과)로 보여 줍니다.
 */

type CardTone = 'neutral' | 'info' | 'warn' | 'ok'
const toneClass: Record<CardTone, string> = {
  neutral: 'bg-surface-muted text-ink-muted',
  info: 'bg-info-soft text-info',
  warn: 'bg-warning-soft text-warning',
  ok: 'bg-brand-soft text-brand-hover',
}

const applicationSteps = ['양식 확인', '답변 작성', '초안'] as const
const reviewSteps = ['공고 선택', '분석 입력', '분석·결과'] as const
const statusPollMs = 5000

function WorkCard({ kind, title, badge, tone, steps, line, children, action }: {
  kind: string; title: string; badge: string; tone: CardTone; steps: ReactNode; line?: string; children?: ReactNode; action: ReactNode
}) {
  return <section className="mt-3 grid min-w-0 gap-2 rounded-xl border border-line bg-white p-3" aria-label={`${kind} · ${title}`}>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <b className="shrink-0 text-sm">{kind}</b>
      <span className={`shrink-0 rounded px-1.5 py-px text-[0.7rem] font-bold ${toneClass[tone]}`}>{badge}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-ink-muted" title={title}>{title}</span>
    </div>
    {steps}
    {line ? <p className="m-0 text-xs text-ink-muted">{line}</p> : null}
    {children}
    <div className="flex flex-wrap items-center gap-2">{action}</div>
  </section>
}

const openButton = 'cursor-pointer rounded-full bg-brand-primary px-3.5 py-1.5 text-[0.8rem] font-bold text-white no-underline hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-default disabled:opacity-60'
const secondaryButton = 'rounded-full border border-line px-3.5 py-1.5 text-[0.8rem] font-bold text-ink no-underline hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary'
const pageLink = 'text-[0.8rem] text-brand-primary underline'

/** 기존 API를 읽어 카드 상태를 정합니다. 읽지 못하면 앞의 상태를 그대로 둡니다. [refresh]가 바뀌면 다시 읽습니다. */
function useLoaded<T>(load: ((signal: AbortSignal) => Promise<T>) | null, refresh: number): T | null {
  const [value, setValue] = useState<T | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  const enabled = load !== null
  useEffect(() => {
    if (!enabled || !loadRef.current) { setValue(null); return }
    const controller = new AbortController()
    loadRef.current(controller.signal).then((next) => { if (!controller.signal.aborted) setValue(next) }, () => undefined)
    return () => controller.abort()
  }, [enabled, refresh])
  return value
}

/** 돌아가는 일이 있는 동안만 [statusPollMs]마다 늘어나는 값입니다. 카드가 이 값으로 상태를 다시 읽습니다. */
function usePollTick(active: boolean): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setTick((value) => value + 1), statusPollMs)
    return () => clearInterval(timer)
  }, [active])
  return tick
}

type FormStartStatus = { running: boolean; since: string | null; status: string; forms: number }
type StepView = { badge: string; tone: CardTone; line: string; action: string; step: number; state: WorkStepState }

/** 돌아가는 일의 한 줄 끝에 경과 시간과 나가도 계속된다는 안내를 붙입니다. 예상 시간은 맞지 않을 수 있어 적지 않습니다. */
function runningLine(text: string, elapsed: number | null): string {
  return [text, elapsed === null ? null : elapsedLabel(elapsed), '나가도 계속돼요'].filter(Boolean).join(' · ')
}

/** 아직 쓰기 전인 신청 문서의 상태입니다. 양식을 찾으면 2단계(답변 작성)로 넘어갑니다. */
function startView(start: FormStartStatus | null, elapsed: number | null): StepView {
  if (!start) return { badge: '확인 중', tone: 'neutral', line: '저장된 신청 양식을 확인하고 있어요', action: '신청 문서 화면 열기', step: 0, state: 'current' }
  if (start.running) return { badge: '입력칸 분석 중', tone: 'info', line: runningLine('공식 첨부에서 양식을 찾는 중', elapsed), action: '진행 보기', step: 0, state: 'running' }
  switch (start.status) {
    case 'AVAILABLE': return { badge: `양식 ${start.forms}개`, tone: 'ok', line: '양식을 찾았어요. 양식과 신청 분야를 고르고 답변을 써요', action: '답변 쓰기 시작', step: 1, state: 'current' }
    case 'PENDING': case 'STALE': return { badge: '분석 전', tone: 'neutral', line: '공식 첨부에서 입력칸을 분석해야 해요(유료 AI)', action: '입력칸 분석하기', step: 0, state: 'current' }
    case 'NO_FORM': return { badge: '양식 없음', tone: 'warn', line: '공식 첨부에서 작성할 신청 양식을 찾지 못했어요', action: '자세히 보기', step: 0, state: 'warn' }
    case 'DOCUMENT_UNAVAILABLE': case 'TOO_LARGE': return { badge: '원문 확인 필요', tone: 'warn', line: '첨부를 읽지 못해 원문에서 확인해야 해요', action: '자세히 보기', step: 0, state: 'warn' }
    default: return { badge: '확인 필요', tone: 'warn', line: '양식 상태를 확인해 주세요', action: '자세히 보기', step: 0, state: 'warn' }
  }
}

const documentStageLabels: Record<NonNullable<ApplicationDocumentGenerationJob['stage']>, string> = {
  PREPARING: '준비하는 중', MAPPING: '입력 위치를 맞추는 중', WRITING: '답변을 쓰는 중', SAVING: '파일을 저장하는 중',
}

function isRunning(status: string | undefined): boolean {
  return status === 'QUEUED' || status === 'RUNNING'
}

/**
 * 신청 문서 작업 카드입니다. 1 양식 확인 → 2 답변 작성 → 3 초안 단계 띠와 지금 상태를 보여 주고, 버튼은 신청 문서 화면을 시트로 엽니다.
 * 공고로 찾은 내 신청 준비가 있으면 지난 카드도 지금 상태(필수 답변 n/m · 초안 완료)를 보여 주고, 초안이 있으면 [초안 받기]를 둡니다.
 * 아직 쓰기 전이면 최근 카드만 입력칸 분석 상태를 읽고, 분석 · 초안 생성이 돌고 있으면 끝날 때까지 상태를 다시 읽습니다.
 */
export function GovApplicationCard({ application, live, refresh, preparations, onChanged }: {
  application: GovAgentApplication; live: boolean; refresh: number; preparations: ProgramPreparations | null; onChanged: () => void
}) {
  const { preparationId, program } = application
  const summary = preparationOf(application, preparations)
  const known = preparations?.phase === 'ready'
  const [running, setRunning] = useState(false)
  const tick = usePollTick(live && running)
  const start = useLoaded<FormStartStatus>(!live || !known || summary || preparationId !== undefined ? null : async (signal) => {
    const useCase = appContainer.resolve('applicationPreparationUseCase')
    const [availability, jobs] = await Promise.all([
      useCase.availability(program.sourceCode, program.sourceProgramId, signal),
      useCase.discoveryJobs(signal).catch(() => []),
    ])
    const analyzing = jobs.find((job) => job.sourceCode === program.sourceCode && job.sourceProgramId === program.sourceProgramId && isRunning(job.status))
    return { running: analyzing !== undefined, since: analyzing?.createdAt ?? null, status: availability.state.status, forms: availability.forms.items.length }
  }, refresh + tick)
  const writingId = live && summary && summary.hasCurrentDocument !== true ? summary.id : null
  const job = useLoaded<ApplicationDocumentGenerationJob | null>(writingId === null ? null : async (signal) => {
    const jobs = await appContainer.resolve('applicationPreparationUseCase').documentJobs(writingId, signal)
    return jobs.reduce<ApplicationDocumentGenerationJob | null>((latest, item) => !latest || item.id > latest.id ? item : latest, null)
  }, refresh + tick)
  const generating = writingId !== null && isRunning(job?.status)
  const nowRunning = Boolean(start?.running) || generating
  const elapsed = useElapsedSeconds(generating ? job?.createdAt : start?.running ? start.since : null, live && nowRunning)
  // 돌아가는 일이 끝나면 다시 읽기를 멈추고, 초안 생성이 끝났으면 내 신청 준비를 다시 읽어 초안 완료로 바꿉니다.
  const wasGenerating = useRef(false)
  useEffect(() => {
    setRunning(nowRunning)
    if (wasGenerating.current && !generating) onChanged()
    wasGenerating.current = generating
  }, [nowRunning, generating, onChanged])

  const newPath = `${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId })}`
  const steps = (step: number, state: WorkStepState) => <WorkSteps label="신청 문서 단계" steps={applicationSteps} current={step} state={state} />
  if (summary) {
    const done = summary.hasCurrentDocument === true
    const required = summary.requiredTotal ? `필수 답변 ${summary.answeredRequired ?? 0}/${summary.requiredTotal}` : null
    const path = preparationPath(summary)
    if (generating) {
      return <WorkCard kind="신청 문서" title={program.title} badge="초안 만드는 중" tone="info" steps={steps(2, 'running')}
        line={runningLine(`${summary.formTitle} · ${job?.stage ? documentStageLabels[job.stage] : '차례를 기다리는 중'}`, elapsed)}
        action={<Link className={secondaryButton} to={`${appPaths.applicationPreparations}/${summary.id}/documents`}>진행 보기</Link>} />
    }
    return <WorkCard kind="신청 문서" title={program.title} tone={done ? 'ok' : 'warn'} badge={done ? '초안 완료' : required ?? '작성 중'}
      steps={done ? steps(2, 'done') : steps(1, 'current')} line={[summary.formTitle, done ? required : null].filter(Boolean).join(' · ')}
      action={done ? <>
        {live ? <DraftDownload preparationId={summary.id} inputRevision={summary.inputRevision} /> : null}
        <Link className={live ? secondaryButton : pageLink} to={path}>초안 보기</Link>
      </> : <Link className={live ? openButton : pageLink} to={path}>이어서 쓰기</Link>} />
  }
  // 예전 대화에서 붙인 신청 준비가 최근 목록에 없으면 상태를 모르므로 그 건의 화면으로만 보냅니다.
  if (preparationId !== undefined) {
    return <WorkCard kind="신청 문서" title={program.title} badge="작성 기록" tone="neutral" steps={steps(1, 'current')}
      action={<Link className={pageLink} to={`${appPaths.applicationPreparations}/${preparationId}`}>신청 문서 화면에서 보기</Link>} />
  }
  if (!known) {
    const failed = preparations?.phase === 'failed'
    return <WorkCard kind="신청 문서" title={program.title} badge={failed ? '상태를 읽지 못함' : '불러오는 중'} tone={failed ? 'warn' : 'neutral'}
      steps={steps(0, 'current')} action={<Link className={pageLink} to={appPaths.applicationPreparations}>신청 문서 화면에서 확인하기</Link>} />
  }
  if (!live) {
    return <WorkCard kind="신청 문서" title={program.title} badge="시작 전" tone="neutral" steps={steps(0, 'current')}
      action={<Link className={pageLink} to={newPath}>신청 문서 화면에서 시작하기</Link>} />
  }
  const view = startView(start, elapsed)
  return <WorkCard kind="신청 문서" title={program.title} badge={view.badge} tone={view.tone} steps={steps(view.step, view.state)} line={view.line}
    action={<Link className={view.state === 'running' ? secondaryButton : openButton} to={newPath}>{view.action}</Link>} />
}

/** 지금 답변 버전으로 만든 초안 파일을 받습니다. 파일 목록은 누를 때 읽고, 그 버전 파일이 없으면 가장 최근 파일을 받습니다. */
function DraftDownload({ preparationId, inputRevision }: { preparationId: number; inputRevision: number }) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  const running = useRef<AbortController | null>(null)
  useEffect(() => () => running.current?.abort(), [])
  async function download() {
    if (running.current) return
    const controller = new AbortController()
    running.current = controller
    setState('busy')
    try {
      const useCase = appContainer.resolve('applicationPreparationUseCase')
      const files = await useCase.documents(preparationId, controller.signal)
      const file = files.find((item) => item.inputRevision === inputRevision)
        ?? files.reduce<(typeof files)[number] | null>((latest, item) => !latest || item.inputRevision > latest.inputRevision ? item : latest, null)
      if (!file) throw new Error('받을 초안이 없어요.')
      const blob = await useCase.downloadDocument(preparationId, file.id, controller.signal)
      if (controller.signal.aborted) return
      saveBlob(blob, file.fileName)
      setState('idle')
    } catch {
      if (!controller.signal.aborted) setState('failed')
    } finally {
      if (running.current === controller) running.current = null
    }
  }
  return <>
    <button type="button" className={openButton} disabled={state === 'busy'} onClick={() => { void download() }}>
      {state === 'busy' ? '받는 중…' : '초안 받기'}
    </button>
    {state === 'failed' ? <span className="text-xs text-warning" role="alert">초안을 받지 못했어요. 다시 눌러 주세요.</span> : null}
  </>
}

type ReviewStatus = StepView & { answers: ReviewAnswer[] | null; path: string; running: boolean; since: string | null }

/**
 * 중복 검토 작업 카드입니다. 1 공고 선택 → 2 분석 입력 → 3 분석·결과 단계 띠와 지금 상태를 보여 주고, 버튼은 검토 화면을 시트로 엽니다.
 * 아직 검토를 만들지 않았으면 [검토 시작하기]가 고른 공고를 미리 넣은 새 검토를 열고, 시트에서 저장한 검토는 대화가 이 카드에 붙입니다.
 * 분석이 돌고 있으면 최근 카드만 끝날 때까지 상태를 다시 읽고, 결과가 있으면 질문별 판정 칩과 결론 한 줄을 카드에 바로 보여 줍니다.
 */
export function GovReviewCard({ review, live, refresh, onOpenSheet }: {
  review: GovAgentReview; live: boolean; refresh: number; onOpenSheet: () => void
}) {
  const { reviewId, program } = review
  const [running, setRunning] = useState(false)
  const tick = usePollTick(live && running)
  const status = useLoaded<ReviewStatus>(reviewId === undefined ? null : async (signal) => {
    const useCase = appContainer.resolve('combinationReviewUseCase')
    const runs = await useCase.runs(reviewId, undefined, signal)
    const latest = runs?.items?.[0]
    const editPath = `${appPaths.combinationReviews}/${reviewId}?step=analysis`
    if (!latest) return { badge: '실행 전', tone: 'neutral', line: '내 상황을 확인하고 [검토 실행]을 누르면 분석해요', action: '이어서 하기',
      step: 1, state: 'current', answers: null, path: editPath, running: false, since: null }
    const resultPath = combinationReviewRunResultPath(reviewId, latest.id)
    if (isRunning(latest.status)) return { badge: latest.status === 'QUEUED' ? '분석 대기' : '분석 중', tone: 'info',
      line: '공식 문서를 읽고 판단하는 중', action: '진행 보기', step: 2, state: 'running', answers: null, path: resultPath, running: true, since: latest.startedAt }
    if (latest.status !== 'SUCCEEDED') return { badge: '확인 필요', tone: 'warn', line: '분석을 끝내지 못했어요. 결과 화면에서 확인해 주세요', action: '결과 확인하기',
      step: 2, state: 'warn', answers: null, path: resultPath, running: false, since: null }
    const run = await useCase.run(reviewId, latest.id, signal)
    return { badge: '결과', tone: 'ok', line: '', action: '결과 보기', step: 2, state: 'done', answers: reviewAnswersOf(run.analysis), path: resultPath, running: false, since: null }
  }, refresh + tick)
  useEffect(() => { setRunning(status?.running === true) }, [status?.running])
  const elapsed = useElapsedSeconds(status?.since, live && status?.running === true)
  const headline = status?.answers ? reviewAnswerHeadline(status.answers) : null
  const title = program?.title ?? '공고 두 개 고르기'
  const steps = (step: number, state: WorkStepState) => <WorkSteps label="중복 검토 단계" steps={reviewSteps} current={step} state={state} />
  if (reviewId === undefined) {
    const newPath = `${appPaths.combinationReviewNew}${program ? `?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId })}` : ''}`
    return <WorkCard kind="중복 검토" title={title} badge="시작 전" tone="neutral" steps={steps(0, 'current')}
      line={program ? '함께 볼 공고를 하나 더 고르면 검토를 시작해요' : '함께 지원할 공고 두 개를 고르면 검토를 시작해요'}
      action={<Link className={live ? openButton : pageLink} to={newPath} onClick={onOpenSheet}>{live ? '검토 시작하기' : '중복 검토 화면에서 시작하기'}</Link>} />
  }
  if (!status) {
    return <WorkCard kind="중복 검토" title={title} badge="불러오는 중" tone="neutral" steps={steps(1, 'current')}
      action={<Link className={pageLink} to={`${appPaths.combinationReviews}/${reviewId}`}>중복 검토 화면에서 보기</Link>} />
  }
  return <WorkCard kind="중복 검토" title={title} badge={status.badge} tone={status.tone} steps={steps(status.step, status.state)}
    line={status.running ? runningLine(status.line, elapsed) : status.line || undefined}
    action={<Link className={live ? (status.state === 'running' ? secondaryButton : openButton) : pageLink} to={status.path}>{status.action}</Link>}>
    {status.answers && headline && <div className="grid gap-1">
      <div className="flex flex-wrap gap-1.5"><ReviewAnswerChips answers={status.answers} /></div>
      <p className="text-sm font-bold text-ink">{headline.title}</p>
    </div>}
  </WorkCard>
}

/** 이유·확인할 점 칩 문장입니다. 공고 이름은 칩이 한 줄에 들어가게 줄입니다. */
function shortTitle(title: string): string {
  return title.length > 16 ? `${title.slice(0, 16)}…` : title
}

function reasonText(reason: PartnerMatchReason): string {
  switch (reason.type) {
    case 'MY_PROGRAM': return `${reason.programSource === 'PREPARATION' ? '신청 준비 중인 공고' : '관심 공고'} 「${shortTitle(reason.values[0] ?? '')}」`
    case 'KEYWORD': return `${reason.values.map((value) => `'${value}'`).join('·')} 관련`
    case 'CAPABILITY': return `필요 역량 ${reason.values.length}개 일치`
    case 'SAME_REGION': return `같은 지역(${reason.values[0] ?? ''})`
    case 'ROLE': return '찾는 역할이 우리 역할과 맞아요'
  }
}

function cautionText(caution: PartnerMatchCaution, myRegion: string | null): string {
  return caution.type === 'OTHER_REGION'
    ? `희망 지역 ${caution.value}${myRegion ? ` · 우리 ${myRegion}` : ''}`
    : `업력 ${caution.value}년 이상`
}

const relaxLabels: Record<'ROLE' | 'REGION' | 'PROGRAM', string> = { ROLE: '찾는 역할', REGION: '지역', PROGRAM: '선택한 공고' }

/** 파트너 관리 목록에 같은 조건을 넘깁니다. 목록은 분야 말 하나를 검색어로 받습니다. */
function partnersPath(conditions: PartnerRecruitmentConditions): string {
  const params = new URLSearchParams()
  for (const role of conditions.seekingRoles) params.append('seekingRole', role)
  for (const region of conditions.regions) params.append('region', region)
  if (conditions.keywords[0]) params.set('keyword', conditions.keywords[0])
  const query = params.toString()
  return query ? `${appPaths.partners}?${query}` : appPaths.partners
}

type RecommendationLoad =
  | { phase: 'loading' }
  | { phase: 'failed' }
  | { phase: 'ready'; result: PartnerRecruitmentRecommendations }

/**
 * 파트너 맞춤 추천입니다. 회사 정보·협업 설정(역할·역량)·관심 공고로 모집 중인 글을 골라 세 건까지 보여 줍니다(AI 호출 없음).
 * 대화의 검색 결과처럼 메시지 폭을 다 쓰고, 모집글은 파트너 관리 목록과 같은 카드에 추천 이유·확인할 점을 덧붙입니다.
 * 대화에서 읽은 조건은 칩으로 보여 줍니다. 찾는 역할·지역·공고는 거르는 조건(실선), 분야 말은 순서만 올리는 조건(점선)이고
 * ✕로 빼면 다시 조회합니다. 맞는 글이 없으면 조건 하나를 뺐을 때의 건수를 알려 줍니다. 희망 지역이 달라도 거르지 않습니다.
 */
export function GovPartnerBrief({ conditions = emptyPartnerRecruitmentConditions }: { conditions?: PartnerRecruitmentConditions }) {
  const [active, setActive] = useState(conditions)
  const [attempt, setAttempt] = useState(0)
  const [load, setLoad] = useState<RecommendationLoad>({ phase: 'loading' })
  const activeKey = JSON.stringify(active)
  useEffect(() => {
    const controller = new AbortController()
    setLoad({ phase: 'loading' })
    appContainer.resolve('recommendPartnerRecruitmentsUseCase').execute(JSON.parse(activeKey) as PartnerRecruitmentConditions, 3, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setLoad({ phase: 'ready', result }) },
        () => { if (!controller.signal.aborted) setLoad({ phase: 'failed' }) })
    return () => controller.abort()
  }, [activeKey, attempt])
  const result = load.phase === 'ready' ? load.result : null
  const spoken = active.seekingRoles.length > 0 || active.regions.length > 0 || active.keywords.length > 0 || active.program !== null
  const drop = (type: 'ROLE' | 'REGION' | 'PROGRAM') => setActive((current) => ({
    ...current,
    seekingRoles: type === 'ROLE' ? [] : current.seekingRoles,
    regions: type === 'REGION' ? [] : current.regions,
    program: type === 'PROGRAM' ? null : current.program,
  }))
  const basis = result?.basis
  const relax = result?.relax.filter((item) => item.count > 0) ?? []
  return <section className="mt-3 flex w-[700px] max-w-full min-w-0 flex-col gap-3" aria-label="파트너 모집글 · 우리 회사에 맞는 순">
    <div className="flex flex-col gap-1.5">
      <div className={partnerRecruitmentStyles.resultHead}>
        <h3 className={partnerRecruitmentStyles.resultTitle}>
          파트너 모집글 {result ? (result.total > 0 ? `맞춤 ${result.total}건` : '0건') : ''}
        </h3>
        <span className="text-xs text-ink-muted">우리 회사에 맞는 순</span>
      </div>
      {basis?.profileSet ? <p className="m-0 text-xs text-ink-muted">
        기준: 역할 {basis.roles.map((role) => partnerRoleLabels[role]).join('·')} · 역량 {basis.capabilityCount}개 · 관심 공고 {basis.myProgramCount}건{' '}
        <Link className="text-brand-primary underline" to={appPaths.profile}>기준 바꾸기</Link>
      </p> : null}
      {spoken ? <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="대화에서 읽은 조건">
        <span className="text-xs text-ink-muted">대화에서 읽은 조건</span>
        {active.seekingRoles.length > 0 ? <ConditionChip label={active.seekingRoles.map((role) => partnerRoleLabels[role]).join('·')} onRemove={() => drop('ROLE')} /> : null}
        {active.regions.length > 0 ? <ConditionChip label={`${active.regions.join('·')}·전국`} onRemove={() => drop('REGION')} /> : null}
        {active.program ? <ConditionChip label="선택한 공고" onRemove={() => drop('PROGRAM')} /> : null}
        {active.keywords.map((keyword) => <ConditionChip key={keyword} label={`${keyword} (순서만)`} soft
          onRemove={() => setActive((current) => ({ ...current, keywords: current.keywords.filter((value) => value !== keyword) }))} />)}
      </div> : null}
    </div>

    {basis && !basis.profileSet ? <div className={partnerRecruitmentStyles.noticeCard}>
      <p className="m-0 text-sm text-ink">{basis.hasCompany ? '참여 가능 역할·역량을 채우면 더 맞춰 드려요.' : '기업을 등록하고 역할·역량을 채우면 더 맞춰 드려요.'}</p>
      <Link className={`${workspacePageStyles.secondaryButton} self-start`} to={appPaths.profile}>{basis.hasCompany ? '협업·파트너 설정' : '기업 등록하기'}</Link>
    </div> : null}

    {load.phase === 'loading' ? <p className="m-0 text-sm text-ink-muted" role="status">맞는 모집글을 고르고 있어요.</p> : null}
    {load.phase === 'failed' ? <div className={partnerRecruitmentStyles.noticeCard} role="alert">
      <p className="m-0 text-sm text-ink">모집글을 불러오지 못했어요.</p>
      <button type="button" className={`${workspacePageStyles.secondaryButton} self-start`} onClick={() => setAttempt((value) => value + 1)}>다시 시도</button>
    </div> : null}

    {result && result.items.length > 0 ? <div className="grid gap-3" role="list" aria-label="맞춤 모집글">
      {result.items.map(({ recruitment, reasons, cautions }) => <div role="listitem" key={recruitment.id} className="flex min-w-0 flex-col [&>article]:flex-1">
        <RecruitmentCard recruitment={recruitment}>
          {reasons.length > 0 || cautions.length > 0 ? <div className="flex flex-wrap gap-[0.35rem]" aria-label="추천 이유">
            {reasons.slice(0, 2).map((reason) => <span key={reason.type} title={reason.values.join(', ')}
              className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[0.72rem] font-bold text-brand-hover">{reasonText(reason)}</span>)}
            {cautions.slice(0, 1).map((caution) => <span key={caution.type}
              className="rounded-full border border-line px-2.5 py-0.5 text-[0.72rem] text-ink-muted">{cautionText(caution, basis?.region ?? null)}</span>)}
          </div> : null}
        </RecruitmentCard>
      </div>)}
    </div> : null}

    {result && result.items.length === 0 ? <div className={partnerRecruitmentStyles.noticeCard}>
      <p className="m-0 text-sm text-ink">{spoken ? '조건에 맞는 열린 모집글이 없어요.' : '지금 우리 회사에 맞는 열린 모집글이 없어요.'}</p>
      {/* 빼도 0건인 조건은 눌러도 소용이 없어 두지 않습니다. */}
      {relax.length > 0 ? <div className="flex flex-wrap gap-2" role="group" aria-label="조건 빼고 보기">
        {relax.map((item) => <button key={item.type} type="button" onClick={() => drop(item.type)} className={workspacePageStyles.secondaryButton}>
          {relaxLabels[item.type]} 빼고 보기 ({item.count}건)
        </button>)}
      </div> : null}
    </div> : null}

    {result?.suggestedProgram ? <div className={partnerRecruitmentStyles.noticeCard}>
      <p className="m-0 text-sm text-ink">관심 공고 「{shortTitle(result.suggestedProgram.title)}」에는 아직 모집글이 없어요.</p>
      <Link className={`${workspacePageStyles.secondaryButton} self-start`} to={`${appPaths.partnerNew}?${new URLSearchParams({
        sourceCode: result.suggestedProgram.sourceCode, sourceProgramId: result.suggestedProgram.sourceProgramId })}`}>이 공고로 모집글 쓰기</Link>
    </div> : null}

    <Link className={`${workspacePageStyles.primaryButton} self-start`} to={partnersPath(active)}>
      {spoken ? '같은 조건으로 파트너 관리에서 보기' : '파트너 관리에서 전체 보기'}
    </Link>
  </section>
}

/** 대화에서 읽은 조건 칩입니다. 거르는 조건은 실선, 순서만 올리는 분야 말은 점선이고 ✕로 뺍니다. */
function ConditionChip({ label, soft = false, onRemove }: { label: string; soft?: boolean; onRemove: () => void }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-px text-xs ${soft
    ? 'border border-dashed border-line text-ink-muted' : 'border border-brand-line bg-white text-brand-hover'}`}>
    {label}
    <button type="button" aria-label={`${label} 조건 빼기`} onClick={onRemove}
      className="cursor-pointer rounded-full px-0.5 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-brand-primary">✕</button>
  </span>
}
