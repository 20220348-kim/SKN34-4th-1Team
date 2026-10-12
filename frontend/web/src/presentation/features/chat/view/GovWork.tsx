import type { GovAgentApplication, GovAgentReview } from '@govbiz/shared/domain/entities/GovAgent'
import { reviewAnswerHeadline, reviewAnswersOf } from '@govbiz/shared/domain/entities/CombinationReviewResult'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
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

/**
 * 대화에는 작업 카드 한 장만 둡니다. 대화 안에서는 신청 문서의 입력칸 분석과 중복 검토의 [검토 실행]까지만 펼쳐서 하고,
 * 그다음(양식 고르기 · 답변 작성 · 초안, 검토 진행과 결과)은 카드 버튼이 신청 문서 · 중복 검토 화면으로 옮깁니다.
 * 카드는 신청 문서 · 중복 검토 목록 카드와 같은 틀(이름 · 상태 배지 · 한 줄 · 버튼)이고, 상태는 기존 목록 · 실행 API로 다시 읽습니다(AI 호출 없음).
 * 화면에서 끝낸 일은 지난 카드도 끝난 상태(초안 완료 · 검토 결과)로 보여 줍니다.
 */

type CardTone = 'neutral' | 'info' | 'warn' | 'ok'
const toneClass: Record<CardTone, string> = {
  neutral: 'bg-surface-muted text-ink-muted',
  info: 'bg-info-soft text-info',
  warn: 'bg-warning-soft text-warning',
  ok: 'bg-brand-soft text-brand-hover',
}

function WorkCard({ kind, title, badge, tone, children, action }: {
  kind: string; title: string; badge: string; tone: CardTone; children?: ReactNode; action: ReactNode
}) {
  return <section className="mt-3 grid min-w-0 gap-2 rounded-xl border border-line bg-white p-3" aria-label={`${kind} · ${title}`}>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <b className="shrink-0 text-sm">{kind}</b>
      <span className={`shrink-0 rounded px-1.5 py-px text-[0.7rem] font-bold ${toneClass[tone]}`}>{badge}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-ink-muted" title={title}>{title}</span>
    </div>
    {children}
    <div className="flex flex-wrap items-center gap-2">{action}</div>
  </section>
}

const openButton = 'cursor-pointer rounded-full bg-brand-primary px-3.5 py-1.5 text-[0.8rem] font-bold text-white hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-default disabled:opacity-60'
const secondaryButton = 'rounded-full border border-line px-3.5 py-1.5 text-[0.8rem] font-bold text-ink no-underline hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary'
const pageLink = 'text-[0.8rem] text-brand-primary underline'

/** 기존 API를 한 번 읽어 카드 상태를 정합니다. 읽지 못하면 기본 상태로 둡니다. refresh가 바뀌면(펼친 작업을 접으면) 다시 읽습니다. */
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

type FormStartStatus = { running: boolean; status: string; forms: number }

/**
 * 아직 작성을 시작하지 않은 카드의 상태입니다. 입력칸 분석 중이면 그것을, 아니면 저장된 양식 조회 상태를 보여 줍니다.
 * 양식이 있으면(분석이 끝남) 버튼은 신청 문서 화면으로 옮기고(route), 그 밖에는 대화 안에 분석을 펼칩니다.
 */
function startBadge(start: FormStartStatus | null): { label: string; tone: CardTone; action: string; route: boolean } {
  if (!start) return { label: '시작 전', tone: 'neutral', action: '입력칸 분석하기', route: false }
  if (start.running) return { label: '입력칸 분석 중', tone: 'info', action: '진행 보기', route: false }
  switch (start.status) {
    case 'AVAILABLE': return { label: `양식 ${start.forms}개`, tone: 'ok', action: '신청 문서 화면에서 작성하기', route: true }
    case 'PENDING': case 'STALE': return { label: '분석 전', tone: 'neutral', action: '입력칸 분석하기', route: false }
    case 'NO_FORM': return { label: '양식 없음', tone: 'warn', action: '자세히 보기', route: false }
    case 'DOCUMENT_UNAVAILABLE': case 'TOO_LARGE': return { label: '원문 확인 필요', tone: 'warn', action: '자세히 보기', route: false }
    default: return { label: '확인 필요', tone: 'warn', action: '자세히 보기', route: false }
  }
}

/**
 * 신청 문서 작업 카드입니다. 공고로 찾은 내 신청 준비가 있으면 지난 카드도 지금 상태를 보여 줍니다. 초안이 있으면 초안 완료와
 * [초안 받기] · [초안 보기]를, 쓰는 중이면 필수 답변 n/m과 [이어서 쓰기]를 둡니다. 아직 시작하지 않았으면 최근 업무 카드만
 * 입력칸 분석 중 · 양식 n개 · 분석 전 · 양식 없음을 읽어 분석을 대화 안에 펼치거나 신청 문서 화면으로 옮기고, 지난 카드는 화면 링크만 둡니다.
 * 상태는 기존 조회 API로만 읽습니다(AI 호출 없음).
 */
export function GovApplicationCard({ application, live, refresh, preparations, onOpen }: {
  application: GovAgentApplication; live: boolean; refresh: number; preparations: ProgramPreparations | null; onOpen: () => void
}) {
  const { preparationId, program } = application
  const summary = preparationOf(application, preparations)
  const known = preparations?.phase === 'ready'
  const start = useLoaded<FormStartStatus>(!live || !known || summary || preparationId !== undefined ? null : async (signal) => {
    const useCase = appContainer.resolve('applicationPreparationUseCase')
    const [availability, jobs] = await Promise.all([
      useCase.availability(program.sourceCode, program.sourceProgramId, signal),
      useCase.discoveryJobs(signal).catch(() => []),
    ])
    const running = jobs.some((job) => job.sourceCode === program.sourceCode && job.sourceProgramId === program.sourceProgramId
      && (job.status === 'QUEUED' || job.status === 'RUNNING'))
    return { running, status: availability.state.status, forms: availability.forms.items.length }
  }, refresh)
  const newPath = `${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId })}`
  if (summary) {
    const done = summary.hasCurrentDocument === true
    const required = summary.requiredTotal ? `필수 답변 ${summary.answeredRequired ?? 0}/${summary.requiredTotal}` : null
    const path = preparationPath(summary)
    return <WorkCard kind="신청 문서" title={program.title} tone={done ? 'ok' : 'warn'}
      badge={done ? '초안 완료' : required ?? '작성 중'}
      action={done ? <>
        {live ? <DraftDownload preparationId={summary.id} inputRevision={summary.inputRevision} /> : null}
        <Link className={live ? secondaryButton : pageLink} to={path}>초안 보기</Link>
      </> : <Link className={live ? openButton : pageLink} to={path}>이어서 쓰기</Link>}>
      <p className="m-0 text-xs text-ink-muted">{[summary.formTitle, done ? required : null].filter(Boolean).join(' · ')}</p>
    </WorkCard>
  }
  // 예전 대화에서 붙인 신청 준비가 최근 목록에 없으면 상태를 모르므로 그 건의 화면으로만 보냅니다.
  if (preparationId !== undefined) {
    return <WorkCard kind="신청 문서" title={program.title} badge="작성 기록" tone="neutral"
      action={<Link className={pageLink} to={`${appPaths.applicationPreparations}/${preparationId}`}>신청 문서 화면에서 보기</Link>} />
  }
  if (!known) {
    const failed = preparations?.phase === 'failed'
    return <WorkCard kind="신청 문서" title={program.title} badge={failed ? '상태를 읽지 못함' : '불러오는 중'} tone={failed ? 'warn' : 'neutral'}
      action={<Link className={pageLink} to={appPaths.applicationPreparations}>신청 문서 화면에서 확인하기</Link>} />
  }
  if (!live) {
    return <WorkCard kind="신청 문서" title={program.title} badge="시작 전" tone="neutral"
      action={<Link className={pageLink} to={newPath}>신청 문서 화면에서 시작하기</Link>} />
  }
  const notStarted = startBadge(start)
  return <WorkCard kind="신청 문서" title={program.title} badge={notStarted.label} tone={notStarted.tone}
    action={notStarted.route ? <Link className={openButton} to={newPath}>{notStarted.action}</Link>
      : <button type="button" className={openButton} onClick={onOpen}>{notStarted.action}</button>} />
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

type ReviewStatus = { badge: string; tone: CardTone; answers: ReviewAnswer[] | null; runId: number | null; action: string }

/**
 * 중복 검토 작업 카드입니다. 결과가 있으면 사용자가 궁금한 답(질문별 판정 칩과 결론 한 줄)을 카드에 바로 보여 줍니다.
 * 아직 실행하지 않았으면 버튼이 검토 입력을 대화 안에 펼치고, 실행이 있으면(분석 중 · 결과 · 실패) 검토 결과 화면으로 옮깁니다.
 */
export function GovReviewCard({ review, live, refresh, onOpen }: {
  review: GovAgentReview; live: boolean; refresh: number; onOpen: () => void
}) {
  const { reviewId, program } = review
  const status = useLoaded<ReviewStatus>(reviewId === undefined ? null : async (signal) => {
    const useCase = appContainer.resolve('combinationReviewUseCase')
    const runs = await useCase.runs(reviewId, undefined, signal)
    const latest = runs?.items?.[0]
    if (!latest) return { badge: '실행 전', tone: 'neutral', answers: null, runId: null, action: '이어서 하기' }
    if (latest.status === 'QUEUED' || latest.status === 'RUNNING') return { badge: '분석 중', tone: 'info', answers: null, runId: latest.id, action: '진행 보기' }
    if (latest.status !== 'SUCCEEDED') return { badge: '확인 필요', tone: 'warn', answers: null, runId: latest.id, action: '결과 확인하기' }
    const run = await useCase.run(reviewId, latest.id, signal)
    return { badge: '결과', tone: 'ok', answers: reviewAnswersOf(run.analysis), runId: latest.id, action: '결과 보기' }
  }, refresh)
  const badge = reviewId === undefined ? { badge: '실행 전', tone: 'neutral' as const } : status ?? { badge: '불러오는 중', tone: 'neutral' as const }
  const headline = status?.answers ? reviewAnswerHeadline(status.answers) : null
  const pagePath = reviewId !== undefined ? `${appPaths.combinationReviews}/${reviewId}`
    : `${appPaths.combinationReviewNew}${program ? `?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId })}` : ''}`
  return <WorkCard kind="중복 검토" title={program?.title ?? '공고 두 개 고르기'} badge={badge.badge} tone={badge.tone}
    action={!live ? (reviewId !== undefined && status?.runId
      ? <Link className={pageLink} to={combinationReviewRunResultPath(reviewId, status.runId)}>{status.action}</Link>
      : <Link className={pageLink} to={pagePath}>중복 검토 화면에서 이어서 보기</Link>)
      : reviewId !== undefined && status?.runId ? <Link className={openButton} to={combinationReviewRunResultPath(reviewId, status.runId)}>{status.action}</Link>
        : <button type="button" className={openButton} onClick={onOpen}>{reviewId === undefined ? '검토 시작하기' : '이어서 하기'}</button>}>
    {status?.answers && headline && <div className="grid gap-1">
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

/**
 * 카드 자리에서 대화 안에 펼친 작업입니다. 머리에 작업 이름 · 공고 이름 · [접기]를 두고, 안의 편집기는 대화용 판을 그대로 씁니다.
 * 펼치면 [접기]로 초점을 옮기고, 접으면 카드로 돌아가 상태를 다시 읽습니다.
 */
export function GovWorkInline({ kind, title, onClose, children }: { kind: string; title: string; onClose: () => void; children: ReactNode }) {
  const headingId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }) }, [])
  return <section aria-labelledby={headingId} className="mt-3 grid min-w-0 rounded-xl border border-line bg-white">
    <div className="flex min-w-0 items-center gap-2 border-b border-line px-4 py-2.5">
      <h2 className="shrink-0 text-sm font-bold" id={headingId}>{kind}</h2>
      <span className="min-w-0 flex-1 truncate text-xs text-ink-muted" title={title}>{title}</span>
      <button ref={closeRef} type="button" onClick={onClose}
        className="shrink-0 cursor-pointer rounded-full border border-line px-3 py-1 text-[0.78rem] font-semibold text-ink-muted hover:bg-surface-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary">
        접기
      </button>
    </div>
    <div className="min-w-0 px-4 pb-4">{children}</div>
  </section>
}
