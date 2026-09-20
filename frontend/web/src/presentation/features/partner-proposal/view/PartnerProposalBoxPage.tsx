import { Link } from 'react-router'

import { partnerProposalStatusTones } from '../../../../domain/entities/PartnerProposal'
import { toRegionName } from '../../../../domain/entities/Region'
import { companyInitial } from '../../../shared/partner-recruitment/partnerRecruitmentLabels'
import {
  workspaceChipClassName,
  workspacePageStyles,
  workspaceTagClassName,
} from '../../../shared/workspace/WorkspacePage.styles'
import { HelpTip } from '../../../shared/workspace/HelpTip'
import { PartnerManagementHeader } from '../../../shared/partner-recruitment/PartnerManagementHeader'
import {
  proposalActionConfirmations,
  proposalActionLabels,
  usePartnerProposalBoxViewModel,
} from '../viewmodel/usePartnerProposalBoxViewModel'
import { partnerProposalStyles } from './PartnerProposal.styles'

function formatDateTime(value: string): string {
  return value.replace('T', ' ').slice(0, 16)
}

/**
 * 제안함입니다. 받은 제안은 수락·거절, 보낸 제안은 철회할 수 있고, 수락된 제안에만 상대 담당자 연락처가 보입니다.
 * 담당자 연락처 공개는 서버가 정하므로 화면은 응답에 있는 값만 그립니다.
 */
export function PartnerProposalBoxPage() {
  const {
    hasCompany,
    profilePath,
    partnersPath,
    box,
    selectBox,
    boxes,
    phase,
    proposals,
    receivedPendingCount,
    reload,
    confirmation,
    requestAction,
    cancelAction,
    confirmAction,
    busyProposalId,
    notice,
    statusLabel,
    availableActions,
    recruitmentPath,
  } = usePartnerProposalBoxViewModel()

  return (
    <>
      <PartnerManagementHeader active="proposals" />

      <div className={workspacePageStyles.content}>
        {hasCompany ? null : (
          <section className={workspacePageStyles.card} aria-label="기업 등록 필요">
            <p className={workspacePageStyles.emptyNote}>제안은 기업을 등록한 회원끼리 주고받습니다. 프로필에서 기업을 등록해 주세요.</p>
            <Link className={workspacePageStyles.quietLink} to={profilePath}>프로필에서 기업 등록</Link>
          </section>
        )}

        <div className={partnerProposalStyles.boxTabs} role="tablist" aria-label="제안함 종류">
          {boxes.map((item) => (
            <button
              className={workspaceChipClassName(box === item.key)}
              key={item.key}
              type="button"
              role="tab"
              aria-selected={box === item.key}
              onClick={() => selectBox(item.key)}
            >
              {item.label}
              {item.key === 'received' && receivedPendingCount > 0 ? ` · 대기 ${receivedPendingCount}` : ''}
            </button>
          ))}
          {/* 제안 원칙은 카드로 늘 펼쳐 두지 않고 탭 옆 ? 도움말로 봅니다. */}
          <HelpTip label="제안 원칙 도움말" title="제안 원칙">
            <p className="m-0">
              제안은 모집글 하나에 한 번만 보낼 수 있고 7일 안에 응답이 없으면 만료됩니다. 담당자 이메일은 수락된 뒤에만 서로에게
              공개되며, 거절·만료·철회된 제안은 같은 모집글에 다시 보낼 수 없습니다.
            </p>
          </HelpTip>
        </div>

        {notice ? <p className={workspacePageStyles.emptyNote} role="alert">{notice}</p> : null}

        {phase === 'failed' ? (
          <section className={workspacePageStyles.card} aria-label="제안 불러오기 실패">
            <p className={workspacePageStyles.emptyNote}>제안을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
            <button className={workspacePageStyles.quietLink} type="button" onClick={reload}>다시 시도</button>
          </section>
        ) : phase === 'loading' && proposals.length === 0 ? (
          <section className={workspacePageStyles.card} aria-label="제안 불러오는 중">
            <p className={workspacePageStyles.emptyNote}>제안을 불러오는 중입니다.</p>
          </section>
        ) : proposals.length === 0 ? (
          <section className={workspacePageStyles.card} aria-label="제안 없음">
            <p className={workspacePageStyles.emptyNote}>
              {box === 'received'
                ? '아직 받은 제안이 없습니다. 모집글을 올리면 다른 기업의 제안이 여기에 모입니다.'
                : '아직 보낸 제안이 없습니다. 모집글 상세에서 참여 제안을 보낼 수 있습니다.'}
            </p>
            <Link className={workspacePageStyles.quietLink} to={partnersPath}>파트너 모집 보기</Link>
          </section>
        ) : (
          <div className={partnerProposalStyles.list} role="tabpanel" aria-label={box === 'received' ? '받은 제안' : '보낸 제안'}>
            {proposals.map((proposal) => {
              const actions = availableActions(proposal)
              const isConfirming = confirmation?.proposalId === proposal.id
              const isBusy = busyProposalId === proposal.id
              return (
                <article className={workspacePageStyles.card} key={proposal.id} aria-label={`${proposal.counterpart.companyName} 제안`}>
                  <div className={partnerProposalStyles.cardHeader}>
                    <div className="flex min-w-0 flex-col gap-1">
                      <Link className={partnerProposalStyles.recruitmentLink} to={recruitmentPath(proposal)}>
                        {proposal.recruitment.title}
                      </Link>
                      <span className={partnerProposalStyles.meta}>
                        <span>{proposal.isSent ? '보낸 날짜' : '받은 날짜'} {formatDateTime(proposal.createdAt)}</span>
                        {proposal.status === 'PENDING' ? <span>응답 기한 {formatDateTime(proposal.expiresAt)}</span> : null}
                        {proposal.respondedAt ? <span>응답 {formatDateTime(proposal.respondedAt)}</span> : null}
                      </span>
                    </div>
                    <span className={workspaceTagClassName(partnerProposalStatusTones[proposal.status])}>{statusLabel(proposal)}</span>
                  </div>

                  <div className={partnerProposalStyles.counterpartRow}>
                    <span className={partnerProposalStyles.counterpartAvatar} aria-hidden="true">
                      {companyInitial(proposal.counterpart.companyName)}
                    </span>
                    <span className="min-w-0">
                      <span className={partnerProposalStyles.counterpartName}>{proposal.counterpart.companyName}</span>
                      <span className={partnerProposalStyles.counterpartSummary}>
                        {proposal.counterpart.profile
                          ? `${toRegionName(proposal.counterpart.profile.region)} · ${proposal.counterpart.profile.industry} · 설립 ${proposal.counterpart.profile.foundedYear}`
                          : '기업 기본정보는 수락 뒤에 공개됩니다'}
                      </span>
                    </span>
                    <span className={`ml-auto ${partnerProposalStyles.tagRow}`}>
                      {proposal.counterpart.isBusinessVerified ? <span className={workspaceTagClassName('ok')}>사업자 확인</span> : null}
                      <span className={workspaceTagClassName(proposal.counterpart.isEmailVerified ? 'ok' : 'muted')}>
                        {proposal.counterpart.isEmailVerified ? '이메일 인증' : '인증 전'}
                      </span>
                    </span>
                  </div>

                  <p className={partnerProposalStyles.message}>{proposal.message}</p>

                  {proposal.counterpart.contact ? (
                    <div className={partnerProposalStyles.contactCard} aria-label="상대 담당자 연락처">
                      <span className={partnerProposalStyles.contactLabel}>수락됨 · 담당자 연락처</span>
                      <span>
                        이메일{' '}
                        <a className={partnerProposalStyles.contactLink} href={`mailto:${proposal.counterpart.contact.email}`}>
                          {proposal.counterpart.contact.email}
                        </a>
                      </span>
                      <span>사업자등록번호 {proposal.counterpart.contact.businessNumber}</span>
                      {proposal.counterpart.profile?.homepageUrl ? (
                        <span>
                          홈페이지{' '}
                          <a className={partnerProposalStyles.contactLink} href={proposal.counterpart.profile.homepageUrl} rel="noreferrer" target="_blank">
                            {proposal.counterpart.profile.homepageUrl}
                          </a>
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {isConfirming && confirmation ? (
                    <div className={partnerProposalStyles.confirmBox} role="group" aria-label={`${proposalActionLabels[confirmation.action]} 확인`}>
                      <span>{proposalActionConfirmations[confirmation.action]}</span>
                      <span className={partnerProposalStyles.actions}>
                        <button className={workspacePageStyles.primaryButton} type="button" disabled={isBusy} onClick={() => void confirmAction()}>
                          {isBusy ? '처리 중…' : `${proposalActionLabels[confirmation.action]} 확정`}
                        </button>
                        <button className={workspacePageStyles.secondaryButton} type="button" disabled={isBusy} onClick={cancelAction}>
                          취소
                        </button>
                      </span>
                    </div>
                  ) : actions.length > 0 ? (
                    <div className={partnerProposalStyles.actions}>
                      {actions.map((action) => (
                        <button
                          className={action === 'accept' ? workspacePageStyles.primaryButton : workspacePageStyles.secondaryButton}
                          key={action}
                          type="button"
                          onClick={() => requestAction(proposal.id, action)}
                        >
                          {proposalActionLabels[action]}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>
        )}

      </div>
    </>
  )
}
