import { useState, type ReactNode } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'

import { loginPathFor } from '../../../shared/auth/returnPath'
import { appPaths, isAppPath, supportProgramQuestionPath } from '../../../shared/routes/appPaths'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'

import type { SupportProgramDetail } from '../../../../domain/entities/SupportProgram'
import type { SupportProgramIdentity } from '../../../../domain/repositories/SupportProgramRepository'
import { useSupportProgramDetailViewModel } from '../viewmodel/useSupportProgramDetailViewModel'
import { useSupportProgramSaveViewModel } from '../../../shared/support-program/useSupportProgramSaveViewModel'
import { EvidenceQuestionPanel } from './EvidenceQuestionPanel'
import { supportProgramDetailStyles as s } from './SupportProgramDetailPage.styles'
import { getSupportProgramFromPipeline, getSupportProgramSearchReturnTo, isSavedProgramsReturnTo, supportProgramBackLabel, type SupportProgramSearchReturnTo } from './supportProgramNavigation'
import { supportProgramDeadlineChip, supportProgramStatusLabel } from './supportProgramStatus'

/** URL의 제공처·원본 공고 ID로 최신 상세 정보를 조회하는 화면입니다. */
export function SupportProgramDetailPage() {
  const location = useLocation()
  const locationState = location.state
  // 새로고침·공유 URL로 들어와 이동 상태가 없으면 비로그인 링크가 실어 둔 `back`으로 검색 화면을 복원합니다.
  const searchReturnTo = getSupportProgramSearchReturnTo(locationState, location.search)
  const fromPipeline = getSupportProgramFromPipeline(locationState)
  const [searchParams] = useSearchParams()
  const identity = getSupportProgramIdentity(
    searchParams.get('sourceCode') ?? undefined,
    searchParams.get('sourceProgramId') ?? undefined,
  )

  if (!identity) {
    return (
      <UnavailableSupportProgramDetail
        searchReturnTo={searchReturnTo}
        description="공고 주소가 올바르지 않습니다. 검색 결과에서 공고를 다시 선택해 주세요."
        title="공고 정보를 찾을 수 없습니다"
      />
    )
  }

  return (
    <SupportProgramDetailContent
      key={JSON.stringify([identity.sourceCode, identity.sourceProgramId])}
      identity={identity}
      searchReturnTo={searchReturnTo}
      fromPipeline={fromPipeline}
    />
  )
}

function SupportProgramDetailContent({ identity, searchReturnTo, fromPipeline }: {
  identity: SupportProgramIdentity
  searchReturnTo: SupportProgramSearchReturnTo
  fromPipeline: boolean
}) {
  const detail = useSupportProgramDetailViewModel(identity)

  if (detail.status === 'loading') {
    return <LoadingSupportProgramDetail searchReturnTo={searchReturnTo} />
  }

  if (detail.status === 'not-found') {
    return (
      <UnavailableSupportProgramDetail
        searchReturnTo={searchReturnTo}
        description="존재하지 않거나 더 이상 제공되지 않는 공고입니다. 검색 결과에서 다른 공고를 확인해 주세요."
        title="공고 정보를 찾을 수 없습니다"
      />
    )
  }

  if (detail.status === 'failed') {
    return <UnavailableSupportProgramDetail
      searchReturnTo={searchReturnTo}
      retry={detail.retry}
      description="공고 상세 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."
      title="공고 정보를 불러오지 못했습니다"
    />
  }

  return <SupportProgramDetail program={detail.program} searchReturnTo={searchReturnTo} fromPipeline={fromPipeline} />
}

function LoadingSupportProgramDetail({ searchReturnTo }: { searchReturnTo: SupportProgramSearchReturnTo }) {
  return (
    <DetailShell searchReturnTo={searchReturnTo} live>
      <section className={s.unavailableCard}>
        <h1 className={s.unavailableTitle}>공고 정보를 불러오는 중입니다</h1>
        <p className={s.unavailableDescription}>최신 공고 조건을 확인하고 있습니다.</p>
      </section>
    </DetailShell>
  )
}

/**
 * 맨 위 줄입니다. 넓은 화면은 돌아가기 알약 하나이고, 좁은 화면은 뒤로 화살표와 "공고 상세"가 있는 앱 바가 됩니다.
 * 돌아가기 링크는 하나뿐이라 화면 폭이 바뀌어도 같은 요소가 모양만 바꿉니다. 작업 화면에서 관심 공고함으로부터 열린 상세는
 * `WorkspaceSearchDetailLayout`이 머리글 높이의 줄에 같은 알약을 두므로 여기서는 그리지 않습니다.
 */
function TopBar({ searchReturnTo }: { searchReturnTo: SupportProgramSearchReturnTo }) {
  const inApp = isAppPath(useLocation().pathname)
  if (inApp && isSavedProgramsReturnTo(searchReturnTo)) return null
  return (
    <div className={s.topBar}>
      <Link className={s.backLink} to={searchReturnTo}>
        <Icon name="chevronLeft" size={20} />
        <span className={s.backLabel}>{supportProgramBackLabel(searchReturnTo)}</span>
      </Link>
      <span className={s.mobileTitle} aria-hidden="true">공고 상세</span>
    </div>
  )
}

/** 불러오는 중·없음·실패 화면의 껍데기입니다. 상세와 같은 맨 위 줄 아래에 카드 하나를 둡니다. */
function DetailShell({ children, live = false, searchReturnTo }: {
  children: ReactNode
  live?: boolean
  searchReturnTo: SupportProgramSearchReturnTo
}) {
  return (
    <main className={s.unavailablePage} aria-live={live ? 'polite' : undefined}>
      <TopBar searchReturnTo={searchReturnTo} />
      {children}
    </main>
  )
}

/**
 * 공고 상세 본문입니다. 웹 화면 v2의 공고 상세 보드를 따릅니다. 왼쪽은 접수 상태·D-day·출처, 제목, 요약, "한눈에 보기",
 * 자격 미평가 안내이고 오른쪽은 이 공고로 할 일(원문에 질문하기, 관심 공고, 신청 문서 작성, 중복 검토, 원문 보기)입니다.
 * 좁은 화면은 할 일 카드가 아래 고정 동작 바가 되고 나머지 줄은 [더 보기]로 펼칩니다.
 */
function SupportProgramDetail({ program, searchReturnTo, fromPipeline }: {
  program: SupportProgramDetail
  searchReturnTo: SupportProgramSearchReturnTo
  fromPipeline: boolean
}) {
  // 작업 채팅에서 연 상세는 질문 화면도 사이드바 안(/app)에서 열리도록 현재 경로로 판단합니다.
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const save = useSupportProgramSaveViewModel({ sourceCode: program.sourceCode, sourceProgramId: program.id })
  // 진행 관리에서 들어온 공고는 신청 준비 중인 사업이라, 관심 공고함에서 빼면 진행 관리 보드에서도 사라집니다.
  // 책갈피 한 번에 실수로 빠지지 않도록 이때만 확인을 받습니다. 담기는 되돌리기 쉬우므로 바로 처리합니다.
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const needsRemoveConfirm = fromPipeline && save.isSaved === true
  const identity = { sourceCode: program.sourceCode, sourceProgramId: program.id }
  const applicationPreparationPath = `${appPaths.applicationPreparationNew}?${new URLSearchParams(identity)}`
  // 원문 질문은 상세를 떠나지 않고 오른쪽(좁은 화면은 아래 시트) 패널로 엽니다. 열림은 `?ask=1`로 주소에 남겨 뒤로가기·새로고침이 그대로 됩니다.
  const isAsking = searchParams.get('ask') === '1' && save.isAuthenticated && program.evidenceQuestionSupported
  const openAsk = () => {
    const next = new URLSearchParams(searchParams)
    next.set('ask', '1')
    setSearchParams(next, { state: location.state })
  }
  const closeAsk = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('ask')
    setSearchParams(next, { replace: true, state: location.state })
  }
  const status = supportProgramStatusLabel(program.status)
  const deadline = supportProgramDeadlineChip(program.status, program.applicationEndDate)
  const isOfficialNoticeList = program.sourceCode === 'CNTRADE_NOTICE'
  const statusTone = { open: s.statusOpen, upcoming: s.statusUpcoming, closed: s.statusClosed, unknown: s.statusUnknown }[status.tone]
  const dotTone = { open: s.statusDotOpen, upcoming: s.statusDotUpcoming, closed: s.statusDotClosed, unknown: s.statusDotUnknown }[status.tone]

  // 관심 공고는 [원문에 질문하기] 바로 아래에서 담기·빼기를 오가는 버튼 하나입니다. 비로그인은 로그인 뒤 이 공고로 돌아옵니다.
  const saveLabel = save.isSaved ? '관심 공고에서 빼기' : '관심 공고에 담기'
  const saveControl = save.isAuthenticated ? (
    <button
      className={s.saveButton}
      type="button"
      aria-label={saveLabel}
      title={saveLabel}
      aria-pressed={save.isSaved === true}
      disabled={save.isBusy}
      onClick={() => { if (needsRemoveConfirm) setConfirmingRemove(true); else void save.toggle() }}
    >
      <span className={s.saveIcon}><Icon name="bookmark" size={18} filled={save.isSaved === true} /></span>
      <span className={s.saveLabel} aria-hidden="true">{saveLabel}</span>
    </button>
  ) : (
    <Link className={s.saveButton} to={save.loginPath} aria-label="로그인하고 관심 공고에 담기" title="로그인하고 관심 공고에 담기">
      <span className={s.saveIcon}><Icon name="bookmark" size={18} filled={false} /></span>
      <span className={s.saveLabel} aria-hidden="true">로그인하고 관심 공고에 담기</span>
    </Link>
  )

  // 원문 질문은 회원 기능입니다. 회원은 패널을 열고, 비로그인은 로그인 뒤 작업 화면의 질문 화면으로 이어집니다.
  const questionControl = !program.evidenceQuestionSupported ? null : save.isAuthenticated ? (
    <button type="button" className={s.primaryAction} onClick={openAsk} aria-expanded={isAsking} aria-controls="support-program-ask">
      <Icon name="chat" />원문에 질문하기
    </button>
  ) : (
    <Link className={s.primaryAction} to={loginPathFor(supportProgramQuestionPath(identity, true))}>
      <Icon name="chat" />로그인하고 원문에 질문하기
    </Link>
  )

  return (
    <main className={s.page}>
      <TopBar searchReturnTo={searchReturnTo} />

      {confirmingRemove ? (
        <div className={s.removeConfirm} role="alertdialog" aria-label="관심 공고 빼기 확인">
          <span>
            신청 준비 중인 공고입니다. 관심 공고함에서 빼면 진행 관리에서도 보이지 않습니다.
            작성한 신청 문서는 지워지지 않고 신청 준비 화면에 그대로 남습니다.
          </span>
          <span className="flex items-center gap-3">
            <button className={workspacePageStyles.dangerButton} type="button" disabled={save.isBusy}
              onClick={() => { setConfirmingRemove(false); void save.toggle() }}>정말 빼기</button>
            <button className={workspacePageStyles.quietLink} type="button" onClick={() => setConfirmingRemove(false)}>취소</button>
          </span>
        </div>
      ) : null}

      {/* 담기·빼기 결과 알림은 버튼의 눌림 상태로 충분해 잠시 접어 둡니다. 다시 쓰려면 아래 블록을 살립니다.
      {save.notice ? (
        <p className={s.saveNotice} role="status" key={save.notice.id}>
          <span>{save.notice.text}</span>
          <button className={workspacePageStyles.quietLink} type="button" onClick={save.dismissNotice}>닫기</button>
        </p>
      ) : null}
      */}

      <div className={`${s.layout} ${isAsking ? s.layoutAsking : ''}`}>
        <article className={s.article} aria-labelledby="support-program-title">
          <header className={s.heading}>
            <div className={s.meta}>
              <span className={`${s.status} ${statusTone}`}>
                <span className={`${s.statusDot} ${dotTone}`} aria-hidden="true" />
                {status.label}
              </span>
              {deadline ? <span className={`${s.deadline} ${deadline.urgent ? s.deadlineUrgent : s.deadlineCalm}`}>{deadline.label}</span> : null}
              <span className={s.source}>{program.sourceName}</span>
            </div>
            <h1 id="support-program-title" className={s.title}>{program.title}</h1>
            <p className={s.organization}>{program.organization}</p>
          </header>

          <p className={s.summary}>{program.summary}</p>

          <section className={s.glance} aria-labelledby="support-program-glance">
            <h2 id="support-program-glance" className={s.glanceTitle}>한눈에 보기</h2>
            <dl className={s.glanceList}>
              <GlanceRow label="신청 기간"><span className={s.glanceValueStrong}>{program.applicationPeriod}</span></GlanceRow>
              <GlanceRow label="지원 대상">{program.targetDescription}</GlanceRow>
              <GlanceRow label="분야" tight><TagList values={program.categories} emptyLabel="분야 정보 없음" /></GlanceRow>
              <GlanceRow label="지역" tight><TagList values={program.regions} emptyLabel="지역 정보 없음" /></GlanceRow>
              <GlanceRow label="지원 규모"><span className={s.glanceValueMuted}>공고문에서 확인해 주세요</span></GlanceRow>
            </dl>
          </section>

          <p className={s.note} role="note">
            <span className={s.notePill}>자격 미평가</span>
            <span>상세 화면은 기업 조건으로 자격을 다시 평가하지 않아요. 지역·분야 태그만으로 신청 자격을 판단하지 마세요.</span>
          </p>
        </article>

        {isAsking ? <button type="button" className={s.sheetBackdrop} aria-label="닫기" onClick={closeAsk} /> : null}
        <aside className={`${s.aside} ${isAsking ? s.asideAsking : ''}`} aria-label={isAsking ? '원문 질문' : '이 공고로 할 일'}>
          {isAsking ? <EvidenceQuestionPanel identity={identity} onClose={closeAsk} /> : (<>
          {/* 넓은 화면은 관심 공고 → 질문 → 설명 순서로 세로로, 좁은 화면은 동작 바 한 줄(관심 공고 · 더 보기 · 질문)로 다시 정렬됩니다. */}
          <div className={s.asideBar}>
            {saveControl}
            {questionControl}
            <p className={s.primaryHint}>
              {program.evidenceQuestionSupported
                ? '궁금한 신청 조건을 물으면 원문에서 근거를 찾아 답해요.'
                : '이 제공처 공고는 아직 원문 근거 답변을 지원하지 않습니다. 원문 공고에서 확인해 주세요.'}
            </p>
            <button
              type="button"
              className={s.moreButton}
              aria-expanded={moreOpen}
              aria-controls="support-program-more"
              onClick={() => setMoreOpen((open) => !open)}
            >
              {moreOpen ? '접기' : '더 보기'}
            </button>
          </div>
          <div className={s.divider} />
          <div id="support-program-more" className={`${s.more} ${moreOpen ? '' : s.moreHidden}`}>
            <nav aria-label="관련 작업" className="contents">
              {save.isAuthenticated ? (
                <Link className={s.row} to={applicationPreparationPath}>
                  <span className={s.rowIcon}><Icon name="document" /></span><span className={s.rowLabel}>이 공고로 신청 문서 작성</span>
                </Link>
              ) : (
                // 신청 문서 작성은 로그인 화면이라 비로그인에는 로그인 뒤 그 화면으로 이어지는 링크를 둡니다.
                <Link className={s.row} to={loginPathFor(applicationPreparationPath)}>
                  <span className={s.rowIcon}><Icon name="document" /></span><span className={s.rowLabel}>로그인하고 이 공고로 신청 문서 작성</span>
                </Link>
              )}
              <Link className={s.row} to={save.isAuthenticated ? appPaths.combinationReviewNew : loginPathFor(appPaths.combinationReviewNew)}>
                <span className={s.rowIcon}><Icon name="shield" /></span><span className={s.rowLabel}>중복 지원·수혜 검토</span>
              </Link>
            </nav>
            <div className={s.divider} />
            <div className={s.sourceBlock}>
              <p className={s.sourceNote}>
                <b className={s.sourceNoteLead}>신청 전 확인</b> · 지원 자격, 제출 서류, 신청 방법은 공고 원문을 기준으로 해요.
              </p>
              {isOfficialNoticeList ? <p className={s.sourceNote}>제목으로 해당 공지를 확인해 주세요.</p> : null}
              <a className={s.sourceLink} href={program.sourceUrl} target="_blank" rel="noreferrer">
                {isOfficialNoticeList ? '공식 공지 목록' : `${program.sourceName} 원문 보기`} ↗
              </a>
            </div>
          </div>
          </>)}
        </aside>
      </div>
    </main>
  )
}

function UnavailableSupportProgramDetail({ description, retry, searchReturnTo, title }: {
  description: string
  retry?: () => void
  searchReturnTo: SupportProgramSearchReturnTo
  title: string
}) {
  return (
    <DetailShell searchReturnTo={searchReturnTo}>
      <section className={s.unavailableCard}>
        <h1 className={s.unavailableTitle}>{title}</h1>
        <p className={s.unavailableDescription}>{description}</p>
        {retry ? (
          <button type="button" className={s.retryButton} onClick={retry}>상세 정보 다시 불러오기</button>
        ) : null}
      </section>
    </DetailShell>
  )
}

/** "한눈에 보기" 한 줄입니다. 넓은 화면은 이름 112px과 값 두 열, 좁은 화면은 위아래로 쌓입니다. */
function GlanceRow({ label, tight = false, children }: { label: string; tight?: boolean; children: ReactNode }) {
  return (
    <div className={`${s.glanceRow} ${tight ? s.glanceRowTight : ''}`}>
      <dt className={s.glanceLabel}>{label}</dt>
      <dd className={s.glanceValue}>{children}</dd>
    </div>
  )
}

function TagList({ emptyLabel, values }: { emptyLabel: string; values: string[] }) {
  if (values.length === 0) return <span className={s.emptyValue}>{emptyLabel}</span>
  return (
    <ul className={s.tagList}>
      {values.map((value) => <li key={value} className={s.tag}>{value}</li>)}
    </ul>
  )
}

const iconPaths = {
  chevronLeft: 'm15 18-6-6 6-6',
  bookmark: 'M6 4h12v16l-6-4-6 4z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  document: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
  shield: 'M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6zM9 12l2 2 4-4',
} as const

function Icon({ name, size = 20, filled = false }: { name: keyof typeof iconPaths; size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={iconPaths[name]} />
    </svg>
  )
}

function getSupportProgramIdentity(sourceCode: string | undefined, sourceProgramId: string | undefined): SupportProgramIdentity | null {
  if (!sourceCode?.trim() || !sourceProgramId?.trim()) return null
  return { sourceCode, sourceProgramId }
}
