import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Link } from 'react-router'
import { sendHourLabel } from '@govbiz/shared/domain/entities/DailyReport'
import type { DailyReport, DailyReportItem } from '../../../../domain/entities/DailyReport'
import { appPaths, supportProgramDetailPath } from '../../../shared/routes/appPaths'
import { supportProgramSaveMessages, supportProgramSaveNoticeDurationMs, useSupportProgramSaveViewModel } from '../../../shared/support-program/useSupportProgramSaveViewModel'
import { workspacePageStyles as styles, workspaceTagClassName } from '../../../shared/workspace/WorkspacePage.styles'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { WorkspaceToast } from '../../../shared/workspace/WorkspaceToast'
import { workspaceToastActionClassName } from '../../../shared/workspace/WorkspaceToast.styles'
import { WorkspaceToggle } from '../../../shared/workspace/WorkspaceToggle'
import { useDelayedFlag } from '../../../shared/workspace/useDelayedFlag'
import { readReportPeriod } from '../viewmodel/dailyReportPeriod'
import { useDailyReportViewModel } from '../viewmodel/useDailyReportViewModel'
import { dailyReportStyles as s } from './DailyReportPage.styles'

type ViewModel = ReturnType<typeof useDailyReportViewModel>

function reportDateLabel(date: string): string {
  const [, month, day] = date.split('-')
  return `${Number(month)}월 ${Number(day)}일`
}

/**
 * 기업 맞춤 리포트 화면입니다. 리포트를 맨 위에, 추천 공고 카드를 그 아래에, 수신 설정은 접어서 맨 아래에 둡니다.
 * 리포트는 계정당 하루 한 건이라 오늘 것이 없을 때만 [오늘의 리포트 만들기]를 보여 주고, 이전 리포트가 있으면 그 아래에 그대로 둡니다.
 */
export function DailyReportPage() {
  const vm = useDailyReportViewModel()
  const settings = vm.settings
  // 조회는 보통 금방 끝나므로 300ms까지는 아무것도 그리지 않고, 그보다 길어지면 리포트 자리의 스켈레톤을 보여 줍니다.
  const isLoading = !vm.loaded && !vm.error
  const showSkeleton = useDelayedFlag(isLoading)
  return (
    <>
      <WorkspacePageHeader
        title="기업 맞춤 리포트"
        actions={vm.company ? <Link className={styles.secondaryButton} to={appPaths.profile}>기업 정보 수정</Link> : undefined}
      />
      <main className={styles.content}>
        <div className={s.column}>
          {vm.company && <p className={s.basis}>{vm.company.companyName} · {vm.company.region} · {vm.company.industry} 기준</p>}
          {isLoading && <p role="status" className="sr-only">리포트를 불러오는 중입니다.</p>}
          {showSkeleton && <ReportSkeleton />}
          {!vm.loaded && vm.error && <StateCard tone="danger" title="리포트를 불러오지 못했어요" text={vm.error.text}>
            <button className={s.smallPrimaryButton} type="button" onClick={() => void vm.load()}>다시 시도</button>
          </StateCard>}
          {vm.loaded && settings && <>
            <ReportArea vm={vm} />
            <ReportSettings vm={vm} />
            <p className={s.note}>서류 안내는 공식 HTML 본문 근거에 한정돼요. PDF·HWP 첨부파일 전체 검토와 뉴스 브리핑은 하지 않아요. 신청 전 최신 공고와 담당 기관에서 확인해 주세요.</p>
          </>}
        </div>
      </main>
      <WorkspaceToast notice={vm.notice} onClose={vm.dismissNotice} />
    </>
  )
}

/** 오늘 리포트의 상태(없음 · 만드는 중 · 실패 · 완성)와, 보여 줄 완성본(오늘 것 또는 가장 최근 것)을 그립니다. */
function ReportArea({ vm }: { vm: ViewModel }) {
  const report = vm.report
  const isTodays = report !== null && report.reportDate === vm.today
  const creating = vm.busy === 'preview' || (isTodays && report.status === 'GENERATING')
  const failedToday = isTodays && report.status === 'FAILED'
  const shown = report?.status === 'READY' ? report : null
  const createButton = (label: string, className: string) => (
    <button className={className} type="button" disabled={vm.busy !== null || vm.dirty} onClick={() => void vm.preview()}>{label}</button>
  )
  return <>
    {vm.company === null ? (
      <StateCard title="기업 정보를 등록하면 리포트를 받을 수 있어요" text="등록한 지역과 업종을 기준으로 접수 중인 공고를 골라 드려요.">
        <Link className={s.smallButton} to={appPaths.profile}>기업 등록</Link>
      </StateCard>
    ) : creating ? (
      <section className={s.stateCard} role="status" aria-label="리포트 만드는 중">
        <span className={s.spinner} aria-hidden="true" />
        <h2 className={s.stateTitle}>오늘의 리포트를 만들고 있어요</h2>
        <p className={s.stateText}>공고 검색과 원문 확인에 시간이 걸려요. 화면을 나가도 서버에서 계속 만들고, 끝나면 여기에 보여요.</p>
      </section>
    ) : failedToday ? (
      <StateCard tone="danger" title="오늘의 리포트를 만들지 못했어요"
        text={`${report?.errorMessage ? `${report.errorMessage} ` : ''}추천할 공고가 없다는 뜻은 아니에요. 같은 조건으로 한 번만 다시 만들 수 있고, AI 분석 비용이 더 들 수 있어요.`}>
        {createButton('다시 시도', s.smallPrimaryButton)}
      </StateCard>
    ) : !isTodays && shown ? (
      <section className={s.todayRow} aria-label="오늘의 리포트 없음">
        <p className={s.todayRowText}>오늘 리포트는 아직 없어요. 아래는 {reportDateLabel(shown.reportDate)} 리포트예요.</p>
        {createButton('오늘의 리포트 만들기', s.smallButton)}
      </section>
    ) : !isTodays ? (
      <StateCard title="오늘의 리포트가 아직 없어요" text="만들 때 AI 분석 비용이 들 수 있어요. 하루에 한 번 만들고, 정기 이메일도 같은 리포트를 보내요.">
        {createButton('오늘의 리포트 만들기', s.smallButton)}
      </StateCard>
    ) : null}
    {vm.company !== null && vm.dirty && !creating && (!isTodays || failedToday) && <p className={s.note}>바꾼 수신 설정을 먼저 저장하거나 취소해 주세요.</p>}
    {vm.error?.at === 'preview' && <p role="alert" className={s.alert}>{vm.error.text}</p>}
    {shown && <ReportContent report={shown} today={vm.today} />}
  </>
}

function StateCard({ tone = 'neutral', title, text, children }: { tone?: 'neutral' | 'danger'; title: string; text: string; children?: ReactNode }) {
  return <section className={s.stateCard} aria-label={title} role={tone === 'danger' ? 'alert' : undefined}>
    <span className={tone === 'danger' ? s.stateGlyphDanger : s.stateGlyph} aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        {tone === 'danger' ? <><circle cx="12" cy="12" r="9" /><path d="M12 8v5m0 3v.01" /></> : <><path d="M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7" /><path d="M4 13h4l1.5 3h5L16 13h4v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></>}
      </svg>
    </span>
    <h2 className={s.stateTitle}>{title}</h2>
    <p className={s.stateText}>{text}</p>
    {children}
  </section>
}

/** 리포트 머리 카드와 추천 카드의 자리를 잡아 두는 스켈레톤입니다. */
function ReportSkeleton() {
  return <div className="flex flex-col gap-4" aria-hidden="true">
    <section className={s.headCard}>
      <span className={`${s.skeletonBar} h-5 w-40`} />
      <span className={`${s.skeletonBar} h-4 w-full`} />
      <span className={`${s.skeletonBar} h-4 w-3/5`} />
    </section>
    {[0, 1].map((index) => <section key={index} className={s.programCard}>
      <span className={`${s.skeletonBar} h-4 w-32`} />
      <span className={`${s.skeletonBar} h-5 w-4/5`} />
      <span className={`${s.skeletonBar} h-4 w-2/5`} />
      <span className={`${s.skeletonBar} h-11 w-full rounded-xl`} />
    </section>)}
  </div>
}

// SENT는 메일 서버가 접수했다는 뜻이고, UNKNOWN은 중복을 막으려고 자동으로 다시 보내지 않는 상태입니다.
const deliveryLabels: Record<DailyReport['deliveryStatus'], string> = {
  NOT_REQUESTED: '이메일 보내기 전', SENDING: '이메일 보내는 중', SENT: '이메일 보냄',
  UNKNOWN: '이메일 발송 결과 확인 필요', SKIPPED: '이메일 보내지 않음',
}

function generatedLabel(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return `${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit', hour12: true }).format(date)} 생성`
}

/** 화면이 이미 말하는 안내(관련도 뜻 · 추천 0건)는 빼고, 제공처 준비 상태나 근거 분석 실패 같은 나머지 경고는 그대로 보여 줍니다. */
function reportNotices(warnings: string[]): string[] {
  return [...new Set(warnings)].filter((warning) => !warning.startsWith('관련도 점수는 ') && !warning.startsWith('현재 조건에 추천할 접수 중 공고를 찾지 못했습니다.'))
}

function ReportContent({ report, today }: { report: DailyReport; today: string }) {
  const count = report.programs.length
  const answered = report.programs.filter((item) => item.evidenceStatus === 'ANSWERED').length
  const basis = `${report.region} · ${report.industry}${report.supportPurpose ? ` · 지원 목적 “${report.supportPurpose}”` : ''} 기준으로`
  const notices = reportNotices(report.warnings)
  const title = `${reportDateLabel(report.reportDate)} 리포트`
  return <>
    <section className={s.headCard} aria-label={title}>
      <div className={s.headRow}>
        <h2 className={s.headTitle}>{title}</h2>
        <span className={workspaceTagClassName(count > 0 ? 'ok' : 'muted')}>추천 {count}건</span>
        <span className={s.headMeta}>{[generatedLabel(report.generatedAt), deliveryLabels[report.deliveryStatus]].filter(Boolean).join(' · ')}</span>
      </div>
      {count > 0
        ? <p className={s.headSummary}>{basis} <strong>접수 중 공고 {count}건</strong>을 골랐어요.{answered > 0 ? ` ${answered}건은 원문에서 조건·서류 근거까지 찾았어요.` : ''}</p>
        : <p className={s.headSummary}>{basis} 찾았지만 이번에는 추천할 접수 중 공고가 없어요. 전체 지원사업 중 신청할 공고가 전혀 없다는 뜻은 아니에요.</p>}
      <p className={s.note}>관련도는 검색 순위를 위한 점수예요. 선정 확률이나 신청 자격을 보장하지 않아요.</p>
      {notices.length > 0 && <ul className={s.notices} aria-label="리포트 참고 사항">{notices.map((notice) => <li key={notice}>{notice}</li>)}</ul>}
      {count === 0 && <Link className={`${s.smallButton} self-start`} to={appPaths.chat}>지원사업 검색</Link>}
    </section>
    {count > 0 && <div className={s.programList}>
      {report.programs.map((item) => <ReportItem key={JSON.stringify([item.sourceCode, item.sourceProgramId])} item={item} today={today} />)}
    </div>}
  </>
}

const periodStatus = {
  OPEN: ['접수 중', 'bg-brand-soft text-brand-primary'],
  UPCOMING: ['접수 예정', 'bg-info-soft text-info'],
  CLOSED: ['접수 마감', 'bg-surface-muted text-ink-muted'],
} as const

// 자격 배지는 검색 결과와 같은 한 벌입니다. 대상·지역 판정 근거는 "매칭 근거" 줄 맨 앞에 둡니다.
function eligibility(status: string): { label: string; tone: string; basis: string } {
  if (status === 'MATCH') return { label: '조건 확인', tone: 'border-brand-line text-brand-primary', basis: '대상·지역 본문 일치' }
  if (status === 'UNKNOWN') return { label: '자격 미평가', tone: 'border-line text-ink-muted', basis: '대상·지역 판정 전' }
  return { label: '확인 필요', tone: 'border-warning-line text-warning', basis: '대상·지역 본문에서 확인 필요' }
}

const evidenceBadges: Record<DailyReportItem['evidenceStatus'], [string, string]> = {
  ANSWERED: ['원문 근거 확인', 'bg-brand-soft text-brand-primary'],
  INSUFFICIENT_EVIDENCE: ['원문만으로 확인 어려움', 'bg-warning-soft text-warning'],
  UNSUPPORTED: ['원문 분석 미지원', 'bg-surface-muted text-ink-muted'],
  FAILED: ['원문 분석 실패', 'bg-danger-soft text-danger'],
}

function ExternalIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
  </svg>
}

function Chevron({ className }: { className: string }) {
  return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
}

/** 추천 카드입니다. 리포트 항목에는 기관·지역·지원 금액이 없어 접수 기간만 적고, 나머지는 상세에서 봅니다. */
function ReportItem({ item, today }: { item: DailyReportItem; today: string }) {
  const identity = { sourceCode: item.sourceCode, sourceProgramId: item.sourceProgramId }
  const save = useSupportProgramSaveViewModel(identity)
  const period = readReportPeriod(item.applicationPeriod, today)
  const judged = eligibility(item.eligibilityStatus)
  const [evidenceLabel, evidenceTone] = evidenceBadges[item.evidenceStatus]
  const detailPath = supportProgramDetailPath(identity, true)
  // 상세는 연 곳을 이어받아 "기업 맞춤 리포트"로 돌아옵니다.
  const detailState = { searchReturnTo: appPaths.reports }
  const saveLabel = save.isSaved ? '관심 공고에서 빼기' : '관심 공고에 담기'
  return <article className={s.programCard} aria-label={item.title}>
    <div className={s.programTop}>
      {period && <span className={`${s.status} ${periodStatus[period.status][1]}`}><span className={s.statusDot} aria-hidden="true" />{periodStatus[period.status][0]}</span>}
      {period?.daysLeft != null && <span className={`${s.dday} ${period.daysLeft === 0 ? s.ddayToday : period.daysLeft <= 3 ? s.ddaySoon : s.ddayCalm}`}>{period.daysLeft === 0 ? '오늘 마감' : `D-${period.daysLeft}`}</span>}
      <span className={`${s.eligibility} ${judged.tone}`}>{judged.label}</span>
      {item.relevanceScore !== null && <span className={s.relevance}>관련도 {item.relevanceScore}</span>}
    </div>
    <h3 className={s.programTitle}><Link className={s.programTitleLink} to={detailPath} state={detailState}>{item.title}</Link></h3>
    <p className={s.programMeta}>접수 기간 {item.applicationPeriod || '원문 확인 필요'}</p>
    <ul className={s.reasons} aria-label="매칭 근거">
      <li className={s.reasonsLabel} aria-hidden="true">매칭 근거</li>
      {[judged.basis, ...item.matchedReasons].map((reason, index) => <li key={index}>· {reason}</li>)}
    </ul>
    {/* 조건·서류 근거는 모든 카드에서 접어 두고, 눌러야 펼칩니다. */}
    <details className={s.evidence}>
      <summary className={s.evidenceSummary}>
        <span className="min-w-0 flex-1">신청 전 확인할 조건 · 필요서류</span>
        <span className={`${s.evidenceBadge} ${evidenceTone}`}>{evidenceLabel}</span>
        <Chevron className={s.evidenceChevron} />
      </summary>
      <div className={s.evidenceBody}>
        <p className={s.evidenceNote}>{item.eligibilityNote}</p>
        {item.evidenceAnswer && <p className={s.evidenceAnswer}>{item.evidenceAnswer}</p>}
        {item.citations.length > 0 && <ul className={s.citations}>{item.citations.map((citation, index) => <li key={index} className={s.citation}>
          <blockquote className={s.citationQuote}>{citation.excerpt}</blockquote>
          <a className={s.citationLink} href={citation.sourceUrl} target="_blank" rel="noopener noreferrer">근거 {index + 1} 원문 보기 ↗</a>
        </li>)}</ul>}
      </div>
    </details>
    <div className={s.programFoot}>
      <a className={s.sourceLink} href={item.sourceUrl} target="_blank" rel="noopener noreferrer">원문 보기<ExternalIcon /></a>
      <button type="button" className={s.bookmark} aria-label={saveLabel} title={saveLabel} aria-pressed={save.isSaved === true}
        disabled={save.isBusy} onClick={() => void save.toggle()}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill={save.isSaved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      </button>
      <Link className={s.smallButton} to={detailPath} state={detailState}>상세 보기</Link>
    </div>
    {/* 담기·빼기 결과는 공고 상세와 같은 토스트로 알립니다. 담으면 [관심 공고함 보기], 빼면 [되돌리기]. */}
    <WorkspaceToast notice={save.notice} onClose={save.dismissNotice} durationMs={supportProgramSaveNoticeDurationMs}
      tone={save.notice?.text === supportProgramSaveMessages.saved || save.notice?.text === supportProgramSaveMessages.removed ? 'success' : 'danger'}
      action={save.notice?.text === supportProgramSaveMessages.saved
        ? <Link className={workspaceToastActionClassName} to={save.savedProgramsPath}>관심 공고함 보기</Link>
        : save.notice?.text === supportProgramSaveMessages.removed
          ? <button type="button" className={workspaceToastActionClassName} disabled={save.isBusy} onClick={() => void save.toggle()}>되돌리기</button>
          : null} />
  </article>
}

/**
 * 접어 둔 수신 설정입니다. 머리에는 지금 상태를 한 줄로 요약하고, 펼치면 받는 방법(이메일 · 앱 푸시)과 추천 기준(지원 목적)을 두 칸으로 보여 줍니다.
 * 프로필 화면과 같이 보기에서 [수정]을 눌러야 고칠 수 있고, 고치는 중에는 [취소][저장]이 같은 자리에 옵니다.
 * 주소에 `?settings=open`이 있으면 펼쳐서 바로 고칠 수 있게 엽니다(리포트 메일 화면의 [수신 설정 열기]).
 */
function ReportSettings({ vm }: { vm: ViewModel }) {
  const open = vm.settingsOpen
  const sectionRef = useRef<HTMLElement>(null)
  // 설정은 화면 맨 아래에 있으므로, 펼친 채로 열라는 주소로 왔으면 그 자리까지 내려 줍니다.
  useEffect(() => {
    if (vm.settingsOpenByLink) sectionRef.current?.scrollIntoView?.({ block: 'start' })
    // 처음 열 때 한 번만 내립니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const bodyId = useId()
  const purposeId = useId()
  const settings = vm.settings!
  const busy = vm.busy !== null
  const editing = vm.editing
  const schedule = `매일 ${sendHourLabel(settings.sendHour)} 이후`
  // 끄는 것은 언제든 되고, 켜는 것은 주소 확인 · 이메일 발송 준비 · 기업 정보가 모두 있어야 합니다.
  const enableBlocker = !settings.emailDeliveryAvailable ? null
    : !settings.emailConfirmed ? '수신 주소를 확인하면 켤 수 있어요.'
      : vm.company === null ? '기업 정보를 등록하면 켤 수 있어요.' : null
  const canEnable = settings.emailDeliveryAvailable && settings.emailConfirmed && vm.company !== null
  const summary = [
    `정기 이메일 ${settings.enabled ? '켜짐' : '꺼짐'}`,
    settings.emailDeliveryAvailable ? schedule : '이메일 발송 준비 안 됨',
    `${vm.account?.email ?? ''} ${settings.emailConfirmed ? '확인됨' : '확인 필요'}`.trim(),
  ].join(' · ')
  const fieldError = (at: 'purpose' | 'consent') => vm.error?.at === at ? <p role="alert" className={s.fieldError}>{vm.error.text}</p> : null

  const groups = <div className={s.settingsGrid}>
    <section className={s.settingsGroup} aria-label="받는 방법">
      <h3 className={s.groupTitle}>받는 방법</h3>
      <div className={s.channel}>
        <div className={s.channelHead}>
          <span className={s.channelText}>
            <span className={s.channelTitle}>이메일</span>
            <span className={s.channelDescription}>{schedule} · 한국 시간</span>
          </span>
          {editing
            ? <WorkspaceToggle label="정기 이메일 받기" isOn={vm.enabled} disabled={busy || (!vm.enabled && !canEnable)}
              onToggle={() => vm.updateForm({ enabled: !vm.enabled, consent: false })} />
            : <span className={workspaceTagClassName(settings.enabled ? 'ok' : 'muted')}>{settings.enabled ? '켜짐' : '꺼짐'}</span>}
        </div>
        <div className={s.channelAddress}>
          <span className={s.addressValue}>{vm.account?.email}</span>
          <span className={workspaceTagClassName(settings.emailConfirmed ? 'ok' : 'warn')}>{settings.emailConfirmed ? '확인됨' : '확인 필요'}</span>
          {!settings.emailConfirmed && <button className={`${s.smallButton} ml-auto`} type="button" disabled={busy || !settings.emailDeliveryAvailable} onClick={() => void vm.verifyEmail()}>{vm.busy === 'verify' ? '보내는 중…' : '확인 메일 보내기'}</button>}
        </div>
        {!settings.emailConfirmed && <p className={s.note}>주소를 확인한 뒤 수신 동의를 저장해야 정기 이메일이 켜져요. 계정의 이메일 인증과는 별개예요.</p>}
        {vm.error?.at === 'verify' && <p role="alert" className={s.alert}>{vm.error.text}</p>}
        {editing && !vm.enabled && enableBlocker && <p className={s.note}>{enableBlocker}</p>}
        {editing && vm.enabled && <label className={s.consent}>
          <input type="checkbox" checked={vm.consent} disabled={busy} onChange={(event) => vm.updateForm({ consent: event.target.checked })} />
          <span>기업 맞춤 지원사업 리포트의 정기 이메일 수신에 동의합니다. 언제든 이 화면이나 이메일의 수신 해지 링크에서 중지할 수 있습니다.</span>
        </label>}
        {editing && fieldError('consent')}
      </div>
      {/* 앱 푸시는 기기마다 모바일 앱에서 켜고 끕니다. 웹은 기기별 상태를 알 수 없어 켜는 곳만 안내합니다. */}
      <div className={s.channel}>
        <div className={s.channelHead}>
          <span className={s.channelText}>
            <span className={s.channelTitle}>앱 푸시</span>
            <span className={s.channelDescription}>모바일 앱의 전체 › 알림 설정에서 기기마다 켜요.</span>
          </span>
          <span className={workspaceTagClassName('muted')}>앱에서 설정</span>
        </div>
      </div>
    </section>
    <section className={s.settingsGroup} aria-label="추천 기준">
      <h3 className={s.groupTitle}>추천 기준</h3>
      {editing ? <div className={s.field}>
        <label className={s.fieldLabel} htmlFor={purposeId}>지원 목적 (선택, 최대 100자)</label>
        <input id={purposeId} className={s.input} value={vm.supportPurpose} maxLength={100} disabled={busy} placeholder="예: AI 제품 개발, 해외 전시회 참가"
          onChange={(event) => vm.updateForm({ supportPurpose: event.target.value })} />
        {fieldError('purpose')}
      </div> : <div className={settings.supportPurpose ? s.valueBox : s.emptyValueBox}>
        <span className={s.valueLabel}>지원 목적<span className={s.optionalMark}>선택</span></span>
        {settings.supportPurpose ? <span className={s.value}>{settings.supportPurpose}</span> : <span className={s.emptyValue}>미입력</span>}
      </div>}
      <p className={s.note}>지역 · 업종과 함께 추천에 써요. 저장하면 다음 리포트부터 반영되고, 이미 만든 오늘 리포트는 바뀌지 않아요.</p>
    </section>
  </div>

  return <section className={s.settingsCard} aria-label="수신 설정" ref={sectionRef}>
    <h2 className={s.settingsHeading}>
      <button type="button" className={s.settingsToggle} aria-expanded={open} aria-controls={bodyId} onClick={vm.toggleSettings}>
        <span className={s.settingsIcon} aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
        </span>
        <span className={s.settingsText}>
          <span className={s.settingsTitle}>수신 설정</span>
          <span className={s.settingsSummary}>{summary}</span>
        </span>
        <Chevron className={`${s.settingsChevron} ${open ? 'rotate-180' : ''}`} />
      </button>
    </h2>
    {open && <div id={bodyId} className={s.settingsBody}>
      {!settings.emailDeliveryAvailable && <p className={s.warning}>현재 서버의 이메일 발송이 꺼져 있어요. 웹에서 리포트를 만들어 볼 수는 있지만, 확인 메일과 정기 이메일은 운영자가 발송을 설정한 뒤에 쓸 수 있어요.</p>}
      {settings.emailDeliveryAvailable && !settings.schedulerEnabled && <p className={s.warning}>서버의 새 정기 발송 예약이 꺼져 있어요. 이미 예약된 메일은 처리될 수 있어요. 주소 확인과 수신 설정은 미리 저장해 둘 수 있어요.</p>}
      {editing ? <form aria-label="수신 설정 수정" className={s.form} onSubmit={(event) => { event.preventDefault(); vm.save() }}>
        {groups}
        {vm.error?.at === 'save' && <p role="alert" className={s.alert}>{vm.error.text}</p>}
        <div className={s.formActions}>
          <button className={styles.secondaryButton} type="button" disabled={busy} onClick={vm.cancelEditing}>취소</button>
          <button className={styles.primaryButton} type="submit" disabled={busy}>{vm.busy === 'save' ? '저장 중…' : '저장'}</button>
        </div>
      </form> : <>
        {groups}
        <div className={s.formActions}>
          <button className={styles.secondaryButton} type="button" disabled={busy} onClick={vm.startEditing}>수정</button>
        </div>
      </>}
    </div>}
  </section>
}
