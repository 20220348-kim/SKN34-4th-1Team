import { useState, type ReactNode } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'

import { loginPathFor } from '../../../shared/auth/returnPath'
import { appPaths, isAppPath, supportProgramQuestionPath } from '../../../shared/routes/appPaths'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'

import type { SupportProgramDetail, SupportProgramStatus } from '../../../../domain/entities/SupportProgram'
import type { SupportProgramIdentity } from '../../../../domain/repositories/SupportProgramRepository'
import { useSupportProgramDetailViewModel } from '../viewmodel/useSupportProgramDetailViewModel'
import { useSupportProgramSaveViewModel } from '../../../shared/support-program/useSupportProgramSaveViewModel'
import { supportProgramDetailStyles } from './SupportProgramDetailPage.styles'
import { getSupportProgramFromPipeline, getSupportProgramSearchReturnTo, supportProgramBackLabel, type SupportProgramSearchReturnTo } from './supportProgramNavigation'

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
      <section className={supportProgramDetailStyles.unavailableCard}>
        <h1 className={supportProgramDetailStyles.title}>공고 정보를 불러오는 중입니다</h1>
        <p className={supportProgramDetailStyles.unavailableDescription}>
          최신 공고 조건을 확인하고 있습니다.
        </p>
      </section>
    </DetailShell>
  )
}

/**
 * 불러오는 중·없음·실패 화면의 껍데기입니다. 작업 화면은 다른 화면과 같은 머리글("지원사업 찾기 > 공고 상세")을,
 * 공개 화면은 공용 헤더 아래 돌아가기 링크를 둡니다.
 */
function DetailShell({ children, live = false, searchReturnTo }: {
  children: ReactNode
  live?: boolean
  searchReturnTo: SupportProgramSearchReturnTo
}) {
  return (
    <main className={supportProgramDetailStyles.unavailablePage} aria-live={live ? 'polite' : undefined}>
      <Link className={supportProgramDetailStyles.backLink} to={searchReturnTo}>
        {supportProgramBackLabel(searchReturnTo)}
      </Link>
      {children}
    </main>
  )
}

function SupportProgramDetail({ program, searchReturnTo, fromPipeline }: {
  program: SupportProgramDetail
  searchReturnTo: SupportProgramSearchReturnTo
  fromPipeline: boolean
}) {
  // 작업 채팅에서 연 상세는 질문 화면도 사이드바 안(/app)에서 열리도록 현재 경로로 판단합니다.
  const inApp = isAppPath(useLocation().pathname)
  const save = useSupportProgramSaveViewModel({ sourceCode: program.sourceCode, sourceProgramId: program.id })
  // 진행 관리에서 들어온 공고는 신청 준비 중인 사업이라, 관심 공고함에서 빼면 진행 관리 보드에서도 사라집니다.
  // 책갈피 한 번에 실수로 빠지지 않도록 이때만 확인을 받습니다. 담기는 되돌리기 쉬우므로 바로 처리합니다.
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const needsRemoveConfirm = fromPipeline && save.isSaved === true
  const applicationPreparationPath = `${appPaths.applicationPreparationNew}?${new URLSearchParams({
    sourceCode: program.sourceCode,
    sourceProgramId: program.id,
  })}`
  const questionPath = supportProgramQuestionPath({ sourceCode: program.sourceCode, sourceProgramId: program.id }, inApp, searchReturnTo)
  // 관심 공고 저장은 책갈피 아이콘 하나입니다. 로그인한 회원은 담기·빼기를 오가고, 비로그인은 로그인 뒤 이 공고로 돌아옵니다.
  const saveLabel = save.isSaved ? '관심 공고 저장됨' : '관심 공고 저장'
  const saveControl = save.isAuthenticated ? (
    <button
      className={supportProgramDetailStyles.saveIconButton}
      type="button"
      aria-label={saveLabel}
      title={saveLabel}
      aria-pressed={save.isSaved === true}
      disabled={save.isBusy}
      onClick={() => { if (needsRemoveConfirm) setConfirmingRemove(true); else void save.toggle() }}
    >
      <BookmarkIcon filled={save.isSaved === true} />
    </button>
  ) : (
    <Link
      className={supportProgramDetailStyles.saveIconButton}
      to={save.loginPath}
      aria-label="로그인하고 관심 공고 저장"
      title="로그인하고 관심 공고 저장"
    >
      <BookmarkIcon filled={false} />
    </Link>
  )
  return (
    <>
    {/* 로그인 여부와 관계없이 위에는 돌아가기 링크와 출처·관심 공고 저장만 둡니다. 작업 화면도 별도 머리글을 쓰지 않습니다. */}
    <main className={supportProgramDetailStyles.page}>
      <header className={supportProgramDetailStyles.header}>
        <Link className={supportProgramDetailStyles.backLink} to={searchReturnTo}>
          {supportProgramBackLabel(searchReturnTo)}
        </Link>
        <div className={supportProgramDetailStyles.headerActions}>
          {saveControl}
          <span className={supportProgramDetailStyles.sourceBadge}>{program.sourceName}</span>
        </div>
      </header>

      {confirmingRemove ? (
        <div className={supportProgramDetailStyles.removeConfirm} role="alertdialog" aria-label="관심 공고 빼기 확인">
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

      {save.notice ? (
        <p className={supportProgramDetailStyles.saveNotice} role="status" key={save.notice.id}>
          <span>{save.notice.text}</span>
          <button className={workspacePageStyles.quietLink} type="button" onClick={save.dismissNotice}>닫기</button>
        </p>
      ) : null}

      <section className={supportProgramDetailStyles.hero} aria-labelledby="support-program-title">
        <div>
          <h1 id="support-program-title" className={supportProgramDetailStyles.title}>
            {program.title}
          </h1>
          <p className={supportProgramDetailStyles.organization}>{program.organization}</p>
          <p className={supportProgramDetailStyles.summary}>{program.summary}</p>
        </div>
        <div className={supportProgramDetailStyles.statusCard}>
          <span className={supportProgramDetailStyles.statusLabel}>접수 상태</span>
          <strong className={supportProgramDetailStyles.statusValue}>
            {formatStatus(program.status)}
          </strong>
          <span className={supportProgramDetailStyles.score}>
            자격 미평가 · 공고 상세 정보
          </span>
        </div>
      </section>

      <p className={supportProgramDetailStyles.qualificationNotice}>
        상세 조회는 검색 당시 기업 조건으로 자격을 다시 평가하지 않습니다.
        검색 결과의 조건 확인 상태와 인용은 검색 화면에서 확인하세요.
        지역·분야 태그만으로 신청 자격을 판단하지 마세요.
      </p>

      <section className={supportProgramDetailStyles.details} aria-label="공고 조건">
        <DetailItem label="신청 기간">
          {program.applicationPeriod}
        </DetailItem>
        <DetailItem label="접수 시작일">
          {program.applicationStartDate ?? '별도 안내'}
        </DetailItem>
        <DetailItem label="접수 마감일">
          {program.applicationEndDate ?? '별도 안내'}
        </DetailItem>
        <DetailItem label="지원 대상">
          {program.targetDescription}
        </DetailItem>
        <DetailItem label="분야">
          <TagList values={program.categories} emptyLabel="분야 정보 없음" />
        </DetailItem>
        <DetailItem label="지역">
          <TagList values={program.regions} emptyLabel="지역 정보 없음" />
        </DetailItem>
      </section>

      <section className={supportProgramDetailStyles.questionSection} aria-labelledby="evidence-question-title">
        <h2 id="evidence-question-title" className={supportProgramDetailStyles.sectionTitle}>
          공고 원문 기반 질문
        </h2>
        {program.evidenceQuestionSupported ? (
          <p className={supportProgramDetailStyles.questionDescription}>
            궁금한 신청 조건을 질문하고 공고 원문에서 답변 근거를 확인하세요.
          </p>
        ) : (
          <p className={supportProgramDetailStyles.questionDescription}>
            이 제공처 공고는 아직 원문 근거 답변을 지원하지 않습니다. 원문 공고에서 확인해 주세요.
          </p>
        )}
        <div className={supportProgramDetailStyles.questionActions}>
          {program.evidenceQuestionSupported ? (
            save.isAuthenticated ? (
              <Link className={supportProgramDetailStyles.questionLink} state={{ searchReturnTo }} to={questionPath}>
                이 공고에 질문하기
              </Link>
            ) : (
              // 원문 질문도 회원 기능이라 비로그인에는 로그인 뒤 작업 화면의 질문 화면으로 이어지는 링크를 둡니다.
              <Link
                className={supportProgramDetailStyles.questionLink}
                to={loginPathFor(supportProgramQuestionPath({ sourceCode: program.sourceCode, sourceProgramId: program.id }, true))}
              >
                로그인하고 이 공고에 질문하기
              </Link>
            )
          ) : null}
          {save.isAuthenticated ? (
              <Link className={supportProgramDetailStyles.questionLink} to={applicationPreparationPath}>
                이 공고의 신청 양식 상태 확인
              </Link>
            ) : (
              // 신청 문서 작성은 로그인 화면이라 비로그인에는 로그인 뒤 그 화면으로 이어지는 링크를 둡니다.
              <Link className={supportProgramDetailStyles.questionLink} to={loginPathFor(applicationPreparationPath)}>
                로그인하고 신청 양식 상태 확인
              </Link>
          )}
        </div>
      </section>

      <section className={supportProgramDetailStyles.sourceSection} aria-labelledby="source-information">
        <div>
          <p className={supportProgramDetailStyles.sourceEyebrow}>신청 전 확인</p>
          <h2 id="source-information" className={supportProgramDetailStyles.sourceTitle}>
            {program.sourceCode === 'CNTRADE_NOTICE' ? '공식 공지 목록에서 해당 공고를 확인하세요' : '원문 공고에서 최종 조건을 확인하세요'}
          </h2>
          <p className={supportProgramDetailStyles.sourceDescription}>
            지원 자격, 제출 서류, 신청 방법은 공고 원문을 기준으로 합니다.
          </p>
          {program.sourceCode === 'CNTRADE_NOTICE' ? (
            <p className={supportProgramDetailStyles.sourceDescription}>제목으로 해당 공지를 확인해 주세요.</p>
          ) : null}
        </div>
        <a
          className={supportProgramDetailStyles.sourceLink}
          href={program.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          {program.sourceCode === 'CNTRADE_NOTICE' ? '공식 공지 목록' : `${program.sourceName} 원문 보기`} ↗
        </a>
      </section>
    </main>
    </>
  )
}

function UnavailableSupportProgramDetail({
  description,
  retry,
  searchReturnTo,
  title,
}: {
  description: string
  retry?: () => void
  searchReturnTo: SupportProgramSearchReturnTo
  title: string
}) {
  return (
    <DetailShell searchReturnTo={searchReturnTo}>
      <section className={supportProgramDetailStyles.unavailableCard}>
        <h1 className={supportProgramDetailStyles.title}>{title}</h1>
        <p className={supportProgramDetailStyles.unavailableDescription}>{description}</p>
        {retry ? (
          <button type="button" className={supportProgramDetailStyles.retryButton} onClick={retry}>
            상세 정보 다시 불러오기
          </button>
        ) : null}
      </section>
    </DetailShell>
  )
}

/** 관심 공고 저장 버튼의 책갈피입니다. 사이드바 관심 공고함 메뉴와 같은 모양이고 담긴 상태는 채웁니다. */
function BookmarkIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function DetailItem({ children, label }: { children: ReactNode; label: string }) {
  return (
    <article className={supportProgramDetailStyles.detailItem}>
      <h2 className={supportProgramDetailStyles.detailLabel}>{label}</h2>
      <div className={supportProgramDetailStyles.detailValue}>{children}</div>
    </article>
  )
}

function TagList({ emptyLabel, values }: { emptyLabel: string; values: string[] }) {
  if (values.length === 0) {
    return <span className={supportProgramDetailStyles.emptyValue}>{emptyLabel}</span>
  }

  return (
    <ul className={supportProgramDetailStyles.tagList}>
      {values.map((value) => (
        <li key={value} className={supportProgramDetailStyles.tag}>
          {value}
        </li>
      ))}
    </ul>
  )
}

function formatStatus(status: SupportProgramStatus) {
  const labels: Record<SupportProgramStatus, string> = {
    OPEN: '접수 중',
    UPCOMING: '접수 예정',
    CLOSED: '접수 마감',
    UNKNOWN: '상태 확인 필요',
  }
  return labels[status]
}

function getSupportProgramIdentity(
  sourceCode: string | undefined,
  sourceProgramId: string | undefined,
): SupportProgramIdentity | null {
  if (!sourceCode?.trim() || !sourceProgramId?.trim()) return null

  return { sourceCode, sourceProgramId }
}
