import { Link } from 'react-router'

import { partnerProposalStatusLabels, partnerProposalStatusTones } from '../../../../domain/entities/PartnerProposal'
import { partnerRoleLabels } from '../../../../domain/entities/PartnerRecruitment'
import {
  workspacePageStyles,
  workspaceTagClassName,
} from '../../../shared/workspace/WorkspacePage.styles'
import { HelpTip } from '../../../shared/workspace/HelpTip'
import { WorkspaceModal } from '../../../shared/workspace/WorkspaceModal'
import { workspaceModalStyles } from '../../../shared/workspace/WorkspaceModal.styles'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import {
  companyAgeLabel,
  companyInitial,
  companySummaryLine,
  programDeadlineLabel,
  recruitmentDeadlineLabel,
} from '../../../shared/partner-recruitment/partnerRecruitmentLabels'
import { appPaths } from '../../../shared/routes/appPaths'
import { useSupportProgramSaveViewModel } from '../../../shared/support-program/useSupportProgramSaveViewModel'
import { usePartnerRecruitmentDetailViewModel } from '../viewmodel/usePartnerRecruitmentDetailViewModel'
import { partnerRecruitmentStyles } from './PartnerRecruitment.styles'

/**
 * 모집글 상세와 참여 제안 화면입니다. 공고 원문은 그대로 보여 줍니다.
 * 남의 글은 오른쪽 칸에 참여 제안 폼(또는 내 제안 상태)을 두고, 내 글은 한 칸으로 받은 제안 카드를 모집 조건 아래에 둡니다.
 * 제안 상태 흐름은 카드 제목 옆 `?` 도움말입니다.
 */
export function PartnerRecruitmentDetailPage() {
  const {
    phase,
    recruitment,
    hasCompany,
    profilePath,
    proposalsPath,
    proposalRequirement,
    proposalMessage,
    proposalMessageMaxLength,
    updateProposalMessage,
    shareProfile,
    toggleShareProfile,
    submitProposal,
    isSendingProposal,
    proposalError,
    myProposal,
    myProposalLabel,
    canSendProposal,
    receivedProposals,
    receivedProposalsPhase,
    canManage,
    editPath,
    isCloseConfirmOpen,
    isClosing,
    closeError,
    openCloseConfirm,
    cancelClose,
    confirmClose,
    linkCopyState,
    copyLink,
    linkCopyLabel,
    proposalFlowSteps,
  } = usePartnerRecruitmentDetailViewModel()

  if (phase === 'loading') {
    return <div className={workspacePageStyles.content} aria-label="모집글 불러오는 중">
      <p className={workspacePageStyles.emptyNote}>모집글을 불러오는 중입니다.</p>
    </div>
  }

  if (phase === 'failed') {
    return <div className={workspacePageStyles.content}>
      <h1 className={workspacePageStyles.title}>모집글을 불러오지 못했습니다</h1>
      <p className={workspacePageStyles.emptyNote}>잠시 후 다시 시도해 주세요.</p>
      <Link className={workspacePageStyles.secondaryButton} to={appPaths.partners}>파트너 모집 목록</Link>
    </div>
  }

  if (!recruitment) {
    return <div className={workspacePageStyles.content}>
      <h1 className={workspacePageStyles.title}>모집글을 찾을 수 없습니다</h1>
      <p className={workspacePageStyles.emptyNote}>요청한 모집글이 없거나 내려갔습니다. 다른 모집글로 대신 표시하지 않습니다.</p>
      <Link className={workspacePageStyles.secondaryButton} to={appPaths.partners}>파트너 모집 목록</Link>
    </div>
  }

  const isClosed = recruitment.status === 'CLOSED'
  // 제안 상태 흐름은 카드 옆에 늘 펼쳐 두지 않고 ? 도움말로 필요할 때만 봅니다.
  const flowHelp = (
    <HelpTip label="제안 상태 흐름 도움말" title="제안 상태 흐름">
      <div className={partnerRecruitmentStyles.flowRow}>
        {proposalFlowSteps.map((step, index) => (
          <span className="flex items-center gap-[0.35rem]" key={step}>
            {index > 0 ? <span aria-hidden="true">›</span> : null}
            <span className={partnerRecruitmentStyles.flowStep}>{step}</span>
          </span>
        ))}
      </div>
      <p className="m-0">거절되거나 7일간 응답이 없으면 제안은 만료되고, 같은 모집글에는 다시 제안할 수 없습니다.</p>
    </HelpTip>
  )
  const conditions = [
    { label: '우리 역할', value: partnerRoleLabels[recruitment.ownRole] },
    { label: '찾는 역할', value: `${partnerRoleLabels[recruitment.seekingRole]} ${recruitment.seekingCount}곳` },
    { label: '희망 지역', value: recruitment.region },
    { label: '희망 업력', value: companyAgeLabel(recruitment.minimumCompanyAgeYears) },
    { label: '필요 역량', value: recruitment.capabilities.length > 0 ? recruitment.capabilities.join(', ') : '없음' },
    { label: '제안 현황', value: `${recruitment.proposalCount}건` },
  ]

  return (
    <>
      <WorkspacePageHeader
        parent={{ to: appPaths.partners, label: '파트너 관리' }}
        title="모집글 상세"
        actions={
          <>
            {/* 내 글이면서 모집 중일 때만 수정·마감이 열립니다. 남의 글에는 관심 저장 자리를 남겨 둡니다. */}
            {canManage ? (
              <>
                <Link className={workspacePageStyles.secondaryButton} to={editPath}>수정</Link>
                <button className={workspacePageStyles.dangerButton} type="button" onClick={openCloseConfirm}>마감</button>
              </>
            ) : recruitment.isMine ? null : (
              <button className={workspacePageStyles.secondaryButton} type="button" disabled>
                모집글 저장 · 준비 중
              </button>
            )}
            <button
            className={workspacePageStyles.secondaryButton}
            type="button"
            aria-live="polite"
            aria-disabled={linkCopyState === 'failed'}
            onClick={() => void copyLink()}
            >
            {linkCopyLabel}
            </button>
          </>
        }
      />

      <div className={workspacePageStyles.content}>
        <div className={recruitment.isMine ? workspacePageStyles.column : workspacePageStyles.columns}>
          <div className={workspacePageStyles.column}>
            <section className={workspacePageStyles.card} aria-label="모집 조건">
              <div className={partnerRecruitmentStyles.cardTop}>
                <span className={partnerRecruitmentStyles.tagRow}>
                  <span className={workspaceTagClassName(recruitment.isMine ? 'warn' : 'ok')}>
                    {recruitment.isMine ? '내가 쓴 모집글' : '기업마당 공고'}
                  </span>
                  <span className={workspaceTagClassName('muted')}>{isClosed ? '모집 마감' : '모집 중'}</span>
                </span>
                <span className={isClosed ? partnerRecruitmentStyles.mineDeadline : partnerRecruitmentStyles.cardDeadline}>
                  {isClosed ? '모집 마감' : recruitmentDeadlineLabel(recruitment.recruitmentDeadline)} · {recruitment.recruitmentDeadline}
                </span>
              </div>

              <h2 className={partnerRecruitmentStyles.detailTitle}>{recruitment.title}</h2>

              <div className={partnerRecruitmentStyles.detailAuthorCard}>
                <span className="flex min-w-0 items-center gap-[0.65rem]">
                  <span className={partnerRecruitmentStyles.detailAuthorAvatar} aria-hidden="true">
                    {companyInitial(recruitment.company.companyName)}
                  </span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-[0.4rem]">
                      <span className={partnerRecruitmentStyles.detailAuthorName}>
                        {recruitment.company.companyName}
                      </span>
                      {recruitment.company.isBusinessVerified ? (
                        <span className={workspaceTagClassName('ok')}>사업자 확인</span>
                      ) : null}
                    </span>
                    <span className={partnerRecruitmentStyles.detailAuthorSummary}>
                      {companySummaryLine(recruitment.company)}
                    </span>
                  </span>
                </span>
                {/* 다른 기업의 프로필 화면은 아직 없으므로 링크로 만들지 않습니다. */}
                <span className={workspacePageStyles.pendingLink} aria-disabled="true">
                  기업 프로필 보기 · 준비 중
                </span>
              </div>

              <div className={partnerRecruitmentStyles.conditionGrid}>
                {conditions.map((condition) => (
                  <div className={partnerRecruitmentStyles.conditionCell} key={condition.label}>
                    <span className={partnerRecruitmentStyles.conditionLabel}>{condition.label}</span>
                    <span className={partnerRecruitmentStyles.conditionValue}>{condition.value}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* 내 글을 여는 이유는 대개 받은 제안 확인이므로 조건 바로 아래 본문 칸에 둡니다. 수락·거절은 제안함이 맡습니다. */}
            {recruitment.isMine ? (
              <section className={workspacePageStyles.card} aria-label="받은 제안">
                <div className={workspacePageStyles.cardHeader}>
                  <div className={partnerRecruitmentStyles.titleRow}>
                    <h2 className={workspacePageStyles.cardTitle}>받은 제안</h2>
                    {flowHelp}
                  </div>
                  <span className={workspaceTagClassName('muted')}>{recruitment.proposalCount}건</span>
                </div>
                {receivedProposalsPhase === 'failed' ? (
                  <p className={workspacePageStyles.emptyNote}>받은 제안을 불러오지 못했습니다. 제안함에서 다시 확인해 주세요.</p>
                ) : receivedProposals.length === 0 ? (
                  <p className={workspacePageStyles.emptyNote}>
                    {receivedProposalsPhase === 'loading' ? '받은 제안을 불러오는 중입니다.' : '아직 이 모집글로 온 제안이 없습니다.'}
                  </p>
                ) : (
                  <div className={partnerRecruitmentStyles.sideList}>
                    {receivedProposals.map((proposal) => (
                      <div className={partnerRecruitmentStyles.matchRow} key={proposal.id}>
                        <span>{proposal.counterpart.companyName}</span>
                        <span className={workspaceTagClassName(partnerProposalStatusTones[proposal.status])}>
                          {partnerProposalStatusLabels[proposal.status]}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className={partnerRecruitmentStyles.linkRow}>
                  <Link className={workspacePageStyles.secondaryButton} to={proposalsPath}>제안함에서 수락·거절</Link>
                </div>
              </section>
            ) : null}

            <section className={workspacePageStyles.card} aria-label="연결된 공고">
              <p className={workspacePageStyles.sectionEyebrow}>연결된 공고</p>
              <div className={partnerRecruitmentStyles.cardTop}>
                <span className={workspaceTagClassName('ok')}>기업마당</span>
                <span className={partnerRecruitmentStyles.cardDeadline}>
                  {programDeadlineLabel(recruitment.program.applicationEndDate)}
                </span>
              </div>
              <div className="flex flex-col gap-[0.15rem]">
                <strong className={workspacePageStyles.cardTitle}>{recruitment.program.title}</strong>
                <span className={partnerRecruitmentStyles.cardProgram}>
                  {recruitment.program.organization}
                </span>
              </div>
              <p className="m-0 text-[0.82rem] leading-[1.55] text-sample-muted">
                {recruitment.program.summary}
              </p>
              <div className={partnerRecruitmentStyles.rawBox}>
                <span>
                  <strong className={partnerRecruitmentStyles.rawBoxLabel}>신청기간 원문</strong> ·{' '}
                  {recruitment.program.applicationPeriod}
                </span>
                <span>
                  <strong className={partnerRecruitmentStyles.rawBoxLabel}>지원대상 원문</strong> ·{' '}
                  {recruitment.program.targetDescription}
                </span>
              </div>
              <div className={partnerRecruitmentStyles.linkRow}>
                <a
                  className={partnerRecruitmentStyles.pillLink}
                  href={recruitment.program.sourceUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  공식 원문 보기
                </a>
                <RecruitmentProgramSaveButton
                  sourceCode={recruitment.program.sourceCode}
                  sourceProgramId={recruitment.program.sourceProgramId}
                />
              </div>
            </section>

            <section className={workspacePageStyles.card} aria-label="모집 소개">
              <h2 className={workspacePageStyles.cardTitle}>모집 소개</h2>
              {recruitment.body.split(/\n{2,}/).map((paragraph, index) => (
                <p className={partnerRecruitmentStyles.bodyParagraph} key={`${index}-${paragraph.slice(0, 12)}`}>
                  {paragraph}
                </p>
              ))}

              <div className={partnerRecruitmentStyles.linkRow}>
                <button className={workspacePageStyles.mutedLink} type="button" disabled>
                  이 모집글 숨기기 · 준비 중
                </button>
                <button className={workspacePageStyles.dangerLink} type="button" disabled>
                  신고 · 준비 중
                </button>
              </div>
            </section>
          </div>

          {recruitment.isMine ? null : (
          <aside className={workspacePageStyles.column} aria-label="참여 제안">
            {myProposal !== null ? (
              <section className={partnerRecruitmentStyles.proposalCard} aria-label="내 제안 상태">
                <div className={partnerRecruitmentStyles.titleRow}>
                  <p className={workspacePageStyles.sectionEyebrow}>참여 제안</p>
                  {flowHelp}
                </div>
                <strong className={workspacePageStyles.cardTitle}>제안을 보냈습니다 · {myProposalLabel}</strong>
                <p className={partnerRecruitmentStyles.disclaimer}>
                  {myProposal.status === 'PENDING'
                    ? '상대가 7일 안에 응답하지 않으면 만료됩니다. 철회는 제안함에서 할 수 있습니다.'
                    : myProposal.status === 'ACCEPTED'
                      ? '수락됐습니다. 제안함에서 상대 담당자 연락처를 확인하세요.'
                      : '이 모집글에는 다시 제안할 수 없습니다.'}
                </p>
                <Link className={workspacePageStyles.secondaryButton} to={proposalsPath}>제안함 열기</Link>
              </section>
            ) : (
              <form
                className={partnerRecruitmentStyles.proposalCard}
                onSubmit={(event) => void submitProposal(event)}
                aria-label="참여 제안"
              >
                <div className="flex flex-col gap-1">
                  <div className={partnerRecruitmentStyles.titleRow}>
                    <p className={workspacePageStyles.sectionEyebrow}>참여 제안</p>
                    {flowHelp}
                  </div>
                  <strong className={workspacePageStyles.cardTitle}>
                    {recruitment.company.companyName}에 제안 보내기
                  </strong>
                </div>

                {hasCompany ? null : (
                  <p className={workspacePageStyles.emptyNote}>
                    제안은 기업을 등록한 회원만 보낼 수 있습니다. <Link className={workspacePageStyles.quietLink} to={profilePath}>프로필에서 기업 등록</Link>
                  </p>
                )}

                <div className={partnerRecruitmentStyles.field}>
                  <label htmlFor="proposal-message">제안 메시지</label>
                  <textarea
                    className={partnerRecruitmentStyles.proposalTextarea}
                    id="proposal-message"
                    maxLength={proposalMessageMaxLength}
                    aria-invalid={proposalError !== null}
                    aria-describedby={proposalError !== null ? 'proposal-error' : undefined}
                    placeholder="우리 기업이 맡을 역할과 확인하고 싶은 점을 적어 주세요."
                    value={proposalMessage}
                    onChange={(event) => updateProposalMessage(event.target.value)}
                  />
                  <span className={partnerRecruitmentStyles.proposalCounter}>
                    {proposalMessage.length} / {proposalMessageMaxLength}
                  </span>
                </div>

                <label className={partnerRecruitmentStyles.checkboxLabel}>
                  <input
                    className={partnerRecruitmentStyles.checkbox}
                    type="checkbox"
                    name="shareProfile"
                    checked={shareProfile}
                    onChange={toggleShareProfile}
                  />
                  기업 기본정보 함께 보내기 (소재지·업종·설립연도)
                </label>

                {proposalError ? <p id="proposal-error" className={workspacePageStyles.emptyNote} role="alert">{proposalError}</p> : null}
                <button
                  className={partnerRecruitmentStyles.proposalSubmit}
                  type="submit"
                  disabled={!canSendProposal || !hasCompany || isSendingProposal}
                >
                  {isSendingProposal ? '보내는 중…' : recruitment.status === 'CLOSED' ? '모집이 마감됐습니다' : '참여 제안 보내기'}
                </button>
                <p className={partnerRecruitmentStyles.disclaimer}>{proposalRequirement}</p>
              </form>
            )}

          </aside>
          )}
        </div>
      </div>

      <WorkspaceModal
        isOpen={isCloseConfirmOpen}
        title="모집을 마감할까요?"
        description="마감하면 새 제안을 받지 않고 대기 중인 제안은 만료됩니다. 되돌릴 수 없습니다."
        tone="danger"
        onClose={cancelClose}
      >
        {closeError ? <p className={workspaceModalStyles.error} role="alert">{closeError}</p> : null}
        <div className={workspaceModalStyles.actions}>
          <button className={workspaceModalStyles.ghostButton} type="button" onClick={cancelClose}>취소</button>
          <button className={workspacePageStyles.dangerButton} type="button" disabled={isClosing} onClick={() => void confirmClose()}>
            {isClosing ? '마감 중…' : '마감'}
          </button>
        </div>
      </WorkspaceModal>
    </>
  )
}

/**
 * 모집글에 묶인 공고를 관심 공고함에 담거나 빼는 버튼입니다. 공고 상세의 책갈피와 같은 ViewModel을 쓰며,
 * 담기·빼기 결과는 버튼 옆 한 줄 안내로 잠시 보여 줍니다. 모집글 상세는 로그인 화면이라 로그인 링크는 두지 않습니다.
 */
function RecruitmentProgramSaveButton({ sourceCode, sourceProgramId }: { sourceCode: string; sourceProgramId: string }) {
  const save = useSupportProgramSaveViewModel({ sourceCode, sourceProgramId })
  const label = save.isSaved ? '관심 공고에서 빼기' : '관심 공고에 추가'
  return (
    <>
      <button
        className={partnerRecruitmentStyles.pillLink}
        type="button"
        aria-pressed={save.isSaved === true}
        disabled={!save.isAuthenticated || save.isBusy}
        onClick={() => void save.toggle()}
      >
        {label}
      </button>
      {save.notice ? (
        <span className={partnerRecruitmentStyles.saveNotice} role="status" key={save.notice.id}>
          {save.notice.text}
        </span>
      ) : null}
    </>
  )
}
