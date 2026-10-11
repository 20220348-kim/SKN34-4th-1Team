import type { GovAgentApplication, GovAgentReview } from '@govbiz/shared/domain/entities/GovAgent'
import { reviewAnswerHeadline, reviewAnswersOf } from '@govbiz/shared/domain/entities/CombinationReviewResult'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import type { ReviewAnswer } from '../../../../domain/entities/CombinationReview'
import { partnerRoleLabels } from '../../../../domain/entities/PartnerRecruitment'
import { defaultPartnerRecruitmentQuery } from '../../../../domain/entities/PartnerRecruitmentQuery'
import { RecruitmentDdayTag } from '../../../shared/partner-recruitment/RecruitmentDdayTag'
import { usePartnerRecruitmentBrowse } from '../../../shared/partner-recruitment/usePartnerRecruitmentBrowse'
import { appPaths, combinationReviewRunResultPath } from '../../../shared/routes/appPaths'
import { ReviewAnswerChips } from '../../combination-review/view/ReviewAnswerResult'

/**
 * 대화에는 작업 카드 한 장만 둡니다. 대화 안에서는 신청 문서의 입력칸 분석과 중복 검토의 [검토 실행]까지만 펼쳐서 하고,
 * 그다음(양식 고르기 · 답변 작성 · 초안, 검토 진행과 결과)은 카드 버튼이 신청 문서 · 중복 검토 화면으로 옮깁니다.
 * 카드는 신청 문서 · 중복 검토 목록 카드와 같은 틀(이름 · 상태 배지 · 한 줄 · 버튼)이고, 상태는 기존 목록 · 실행 API로 다시 읽습니다(AI 호출 없음).
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

const openButton = 'cursor-pointer rounded-full bg-brand-primary px-3.5 py-1.5 text-[0.8rem] font-bold text-white hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary'
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
 * 신청 문서 작업 카드입니다. 시작 전에는 입력칸 분석 중 · 양식 n개 · 분석 전 · 양식 없음을, 시작한 뒤에는 작성 중(필수 답변 n/m) ·
 * 초안 있음을 보여 줍니다. 입력칸 분석이 남았으면 버튼이 분석을 대화 안에 펼치고, 양식이 있거나 이미 쓰기 시작했으면
 * 신청 문서 화면으로 옮깁니다. 상태는 기존 조회 API로만 읽습니다(AI 호출 없음).
 */
export function GovApplicationCard({ application, live, refresh, onOpen }: {
  application: GovAgentApplication; live: boolean; refresh: number; onOpen: () => void
}) {
  const { preparationId, program } = application
  const summary = useLoaded(preparationId === undefined ? null : async (signal) => {
    const page = await appContainer.resolve('applicationPreparationUseCase').list({}, signal)
    return page?.items?.find((item) => item.id === preparationId) ?? null
  }, refresh)
  const start = useLoaded<FormStartStatus>(preparationId !== undefined || !live ? null : async (signal) => {
    const useCase = appContainer.resolve('applicationPreparationUseCase')
    const [availability, jobs] = await Promise.all([
      useCase.availability(program.sourceCode, program.sourceProgramId, signal),
      useCase.discoveryJobs(signal).catch(() => []),
    ])
    const running = jobs.some((job) => job.sourceCode === program.sourceCode && job.sourceProgramId === program.sourceProgramId
      && (job.status === 'QUEUED' || job.status === 'RUNNING'))
    return { running, status: availability.state.status, forms: availability.forms.items.length }
  }, refresh)
  const notStarted = startBadge(start)
  const badge = preparationId === undefined ? notStarted
    : summary?.hasCurrentDocument ? { label: '초안 완료', tone: 'ok' as const }
      : summary?.requiredTotal ? { label: `필수 답변 ${summary.answeredRequired ?? 0}/${summary.requiredTotal}`, tone: 'warn' as const }
        : { label: '작성 중', tone: 'warn' as const }
  const pagePath = preparationId !== undefined ? `${appPaths.applicationPreparations}/${preparationId}`
    : `${appPaths.applicationPreparationNew}?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.sourceProgramId })}`
  return <WorkCard kind="신청 문서" title={program.title} badge={badge.label} tone={badge.tone}
    action={!live ? <Link className={pageLink} to={pagePath}>신청 준비 화면에서 이어서 보기</Link>
      : preparationId !== undefined ? <Link className={openButton} to={pagePath}>{summary?.hasCurrentDocument ? '초안 보기' : '이어서 쓰기'}</Link>
        : notStarted.route ? <Link className={openButton} to={pagePath}>{notStarted.action}</Link>
          : <button type="button" className={openButton} onClick={onOpen}>{notStarted.action}</button>} />
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
    action={!live ? <Link className={pageLink} to={pagePath}>중복 검토 화면에서 이어서 보기</Link>
      : reviewId !== undefined && status?.runId ? <Link className={openButton} to={combinationReviewRunResultPath(reviewId, status.runId)}>{status.action}</Link>
        : <button type="button" className={openButton} onClick={onOpen}>{reviewId === undefined ? '검토 시작하기' : '이어서 하기'}</button>}>
    {status?.answers && headline && <div className="grid gap-1">
      <div className="flex flex-wrap gap-1.5"><ReviewAnswerChips answers={status.answers} /></div>
      <p className="text-sm font-bold text-ink">{headline.title}</p>
    </div>}
  </WorkCard>
}

/**
 * 파트너 조회 카드입니다. 말로 적은 조건 적용·맞춤 연결은 아직 없으므로 모집 중인 글을 마감이 가까운 순으로 세 개만 간단히 보여 주고,
 * 검색어·역할·지역으로 직접 좁혀 보는 일은 파트너 관리 화면으로 넘깁니다. 기존 모집글 목록 API를 그대로 읽습니다(AI 호출 없음).
 */
export function GovPartnerBrief() {
  const { phase, page, retry } = usePartnerRecruitmentBrowse(defaultPartnerRecruitmentQuery)
  const items = page?.recruitments.slice(0, 3) ?? []
  const badge = phase === 'failed' ? { label: '불러오지 못함', tone: 'warn' as const }
    : page && phase === 'ready' ? { label: `모집 중 ${page.total.toLocaleString()}건`, tone: 'ok' as const }
      : { label: '불러오는 중', tone: 'neutral' as const }
  return <WorkCard kind="파트너 모집글" title="마감이 가까운 순" badge={badge.label} tone={badge.tone}
    action={<>
      <Link className={openButton} to={appPaths.partners}>파트너 관리에서 전체 보기</Link>
      {phase === 'failed' ? <button type="button" className={pageLink} onClick={retry}>다시 시도</button> : null}
    </>}>
    {items.length > 0 ? <ul className="grid gap-1">
      {items.map((recruitment) => <li key={recruitment.id}>
        <Link className="grid min-w-0 gap-0.5 rounded-lg px-2 py-1.5 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-brand-primary"
          to={`${appPaths.partnerDetail}?${new URLSearchParams({ recruitmentId: String(recruitment.id) })}`}>
          <span className="flex min-w-0 items-center gap-1.5">
            <RecruitmentDdayTag deadline={recruitment.recruitmentDeadline} closed={recruitment.status === 'CLOSED'} />
            <span className="min-w-0 truncate text-sm font-semibold text-ink">{recruitment.title}</span>
          </span>
          <span className="truncate text-xs text-ink-muted">
            {partnerRoleLabels[recruitment.seekingRole]} {recruitment.seekingCount}곳 찾음 · {recruitment.region} · {recruitment.company.companyName}
          </span>
        </Link>
      </li>)}
    </ul> : phase === 'ready' ? <p className="text-sm text-ink-muted">지금 모집 중인 글이 없어요.</p> : null}
    <p className="text-xs text-ink-muted">대화로 적은 지역·분야 조건은 아직 자동으로 적용하지 않아요. 직접 좁혀 보려면 파트너 관리에서 검색어·역할·지역을 고르세요.</p>
  </WorkCard>
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
