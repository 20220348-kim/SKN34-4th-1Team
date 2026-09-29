import { useEffect, useRef } from 'react'
import { Link } from 'react-router'

import { partnerProposalStatusTones, type PartnerProposal } from '../../../../domain/entities/PartnerProposal'
import { toRegionName } from '../../../../domain/entities/Region'
import { companyInitial } from '../../../shared/partner-recruitment/partnerRecruitmentLabels'
import { workspaceChipClassName, workspacePageStyles, workspaceTagClassName } from '../../../shared/workspace/WorkspacePage.styles'
import { WorkspaceModal } from '../../../shared/workspace/WorkspaceModal'
import { workspaceModalStyles } from '../../../shared/workspace/WorkspaceModal.styles'
import { PartnerManagementHeader } from '../../../shared/partner-recruitment/PartnerManagementHeader'
import {
  proposalActionConfirmations,
  proposalActionLabels,
  proposalActionTitles,
  usePartnerProposalBoxViewModel,
} from '../viewmodel/usePartnerProposalBoxViewModel'
import { partnerProposalStyles as s, proposalStatusBadgeClassName } from './PartnerProposal.styles'

/** "2026-09-23T14:20:00" → "09.23" */
function formatShortDate(value: string): string {
  const [, month = '', day = ''] = value.slice(0, 10).split('-')
  return `${month}.${day}`
}

/** "2026-09-23T14:20:00" → "2026.09.23 14:20" */
function formatDateTime(value: string): string {
  return value.slice(0, 16).replace(/-/g, '.').replace('T', ' ')
}

/** 응답 기한까지 남은 날입니다. 지났으면 null. */
function daysUntil(value: string): number | null {
  const due = new Date(value)
  if (Number.isNaN(due.getTime())) return null
  const days = Math.ceil((due.getTime() - Date.now()) / 86_400_000)
  return days < 0 ? null : days
}

/** 행의 "09.23 받음 · 09.02 수락" 같은 시점 한 마디입니다. */
function proposalMoment(proposal: PartnerProposal, statusLabel: string): string {
  if (proposal.status === 'PENDING' || proposal.respondedAt === null) {
    return `${formatShortDate(proposal.createdAt)} ${proposal.isSent ? '보냄' : '받음'}`
  }
  return `${formatShortDate(proposal.respondedAt)} ${statusLabel}`
}

/**
 * 제안함입니다(화면 통일안 34). 머리글 오른쪽 세그먼트로 받은·보낸 상자를 바꾸고, 상태 칩으로 거른 행 목록에서
 * 행을 누르면 옆 패널(좁은 화면은 아래 시트)에 제안이 열립니다. 수락·거절·철회는 패널 바닥 버튼 → 확인 모달로만 처리합니다.
 * 담당자 연락처 공개는 서버가 정하므로 화면은 응답에 있는 값만 그립니다.
 */
export function PartnerProposalBoxPage() {
  const vm = usePartnerProposalBoxViewModel()
  const { box, boxes, statusFilters, statusFilter, phase, proposals, selectedProposal, confirmation } = vm
  const rowRefs = useRef(new Map<number, HTMLButtonElement>())

  const boxLabel = box === 'received' ? '받은 제안' : '보낸 제안'

  /** 패널을 닫으면 열었던 행으로 포커스를 돌립니다. */
  function closePanel() {
    const id = selectedProposal?.id ?? null
    vm.selectProposal(null)
    if (id !== null) rowRefs.current.get(id)?.focus()
  }

  return (
    <>
      {/* 머리글은 모집글·내 모집글과 같은 "파트너 관리"이고, 제안함은 그 탭 중 하나입니다. */}
      <PartnerManagementHeader active="proposals" />

      <div className={workspacePageStyles.content}>
        <p className={s.lede}>기업 회원끼리 주고받은 참여 제안이에요 · 모집글 하나에 한 번, 7일 안에 답하지 않으면 끝나요</p>

        {/* 받은 제안 · 보낸 제안 세그먼트는 본문 첫 줄 왼쪽에 내용 폭만큼만 둡니다(세로 flex 안에서 늘어나지 않게 self-start). */}
        <div className={`${workspacePageStyles.segment} self-start`} role="tablist" aria-label="제안함 종류">
          {boxes.map((item) => (
            <button
              className={workspacePageStyles.segmentTab}
              key={item.key}
              type="button"
              role="tab"
              aria-selected={box === item.key}
              onClick={() => vm.selectBox(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {vm.hasCompany ? null : (
          <section className={s.infoAlert} aria-label="기업 등록 필요">
            <span>제안은 기업을 등록한 회원끼리 주고받아요. 프로필에서 기업을 등록해 주세요.</span>
            <Link className={workspacePageStyles.secondaryButton} to={vm.profilePath}>프로필에서 기업 등록</Link>
          </section>
        )}

        <div className={s.statusChips} role="group" aria-label="제안 상태">
          {statusFilters.map((filter) => (
            <button
              className={workspaceChipClassName(statusFilter === filter.key)}
              key={filter.key}
              type="button"
              aria-pressed={statusFilter === filter.key}
              onClick={() => vm.selectStatusFilter(filter.key)}
            >
              {filter.label}
              <span className={s.chipCount}>{filter.count}</span>
            </button>
          ))}
        </div>

        {vm.notice ? (
          <p className={s.notice} role="alert">
            <span>{vm.notice}</span>
            <button className={workspaceModalStyles.ghostButton} type="button" onClick={vm.dismissNotice}>닫기</button>
          </p>
        ) : null}

        {phase === 'failed' ? (
          <section className={s.emptyCard} aria-label="제안 불러오기 실패">
            <p className={workspacePageStyles.emptyNote}>제안을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</p>
            <button className={workspacePageStyles.primaryButton} type="button" onClick={vm.reload}>다시 시도</button>
          </section>
        ) : phase === 'loading' && proposals.length === 0 ? (
          <section className={s.list} aria-label="제안 불러오는 중" aria-busy="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className={s.skeletonRow} aria-hidden="true">
                <span className={`${s.skeletonBar} size-9 rounded-[0.6rem]`} />
                <span className="flex flex-1 flex-col gap-2"><span className={`${s.skeletonBar} w-2/5`} /><span className={`${s.skeletonBar} w-4/5`} /></span>
              </div>
            ))}
            <p className="sr-only" role="status">제안을 불러오는 중입니다.</p>
          </section>
        ) : proposals.length === 0 ? (
          <section className={s.emptyCard} aria-label="제안 없음">
            <p className={workspacePageStyles.emptyNote}>
              {statusFilter !== 'all' ? '이 상태의 제안이 없어요.'
                : box === 'received'
                  ? '아직 받은 제안이 없습니다. 모집글을 올리면 다른 기업의 제안이 여기에 모여요.'
                  : '아직 보낸 제안이 없습니다. 모집글 상세에서 참여 제안을 보낼 수 있어요.'}
            </p>
            {statusFilter !== 'all'
              ? <button className={workspacePageStyles.secondaryButton} type="button" onClick={() => vm.selectStatusFilter('all')}>전체 보기</button>
              : <Link className={workspacePageStyles.secondaryButton} to={vm.partnersPath}>파트너 모집</Link>}
          </section>
        ) : (
          <div className={s.list} role="tabpanel" aria-label={boxLabel}>
            {proposals.map((proposal) => {
              const isSelected = selectedProposal?.id === proposal.id
              const statusLabel = vm.statusLabel(proposal)
              const dueDays = proposal.status === 'PENDING' ? daysUntil(proposal.expiresAt) : null
              return (
                <article key={proposal.id} aria-label={`${proposal.counterpart.companyName} 제안`}>
                  <button
                    ref={(element) => { if (element) rowRefs.current.set(proposal.id, element); else rowRefs.current.delete(proposal.id) }}
                    type="button"
                    className={s.row}
                    aria-current={isSelected ? 'true' : undefined}
                    aria-expanded={isSelected}
                    aria-controls={isSelected ? 'partner-proposal-panel' : undefined}
                    onClick={() => vm.selectProposal(isSelected ? null : proposal.id)}
                  >
                    <span className={s.rowAvatar} aria-hidden="true">{companyInitial(proposal.counterpart.companyName)}</span>
                    <span className={s.rowBody}>
                      <span className={s.rowTitle}>
                        {proposal.counterpart.companyName}
                        <StatusBadge proposal={proposal} label={statusLabel} />
                      </span>
                      <span className={s.rowSub}>
                        <span>{proposal.recruitment.title}</span>
                        <span className="shrink-0"> · {proposalMoment(proposal, statusLabel)}</span>
                      </span>
                    </span>
                    {proposal.status === 'PENDING' ? (
                      <span className={s.rowDue}>기한 {formatShortDate(proposal.expiresAt)}{dueDays !== null ? ` · D-${dueDays}` : ''}</span>
                    ) : null}
                    <svg className={s.rowChevron} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                  </button>
                </article>
              )
            })}
          </div>
        )}
      </div>

      {selectedProposal ? (
        <>
          <button type="button" className={s.panelScrim} aria-label="닫기" onClick={closePanel} />
          <ProposalPanel
            proposal={selectedProposal}
            boxLabel={boxLabel}
            statusLabel={vm.statusLabel(selectedProposal)}
            actions={vm.availableActions(selectedProposal)}
            recruitmentPath={vm.recruitmentPath(selectedProposal)}
            onAction={(action) => vm.requestAction(selectedProposal.id, action)}
            onClose={closePanel}
          />
        </>
      ) : null}

      {confirmation ? (
        <WorkspaceModal
          isOpen
          title={proposalActionTitles[confirmation.action]}
          description={proposalActionConfirmations[confirmation.action]}
          tone={confirmation.action === 'accept' ? 'default' : 'danger'}
          onClose={vm.cancelAction}
        >
          <div className={workspaceModalStyles.actions}>
            <button className={workspaceModalStyles.ghostButton} type="button" disabled={vm.busyProposalId !== null} onClick={vm.cancelAction}>취소</button>
            <button
              className={confirmation.action === 'accept' ? workspacePageStyles.primaryButton : workspacePageStyles.dangerButton}
              type="button"
              disabled={vm.busyProposalId !== null}
              onClick={() => void vm.confirmAction()}
            >
              {vm.busyProposalId !== null ? '처리 중…' : proposalActionLabels[confirmation.action]}
            </button>
          </div>
        </WorkspaceModal>
      ) : null}
    </>
  )
}

function StatusBadge({ proposal, label }: { proposal: PartnerProposal; label: string }) {
  return (
    <span className={`${s.statusBadge} ${proposalStatusBadgeClassName[partnerProposalStatusTones[proposal.status]]}`}>
      <span className={s.statusDot} aria-hidden="true" />
      {label}
    </span>
  )
}

/** 옆 패널입니다. 상대 기업 → 배지 → 모집글 · 날짜 · 기한 → 메시지 → 안내 · 연락처 → 바닥 버튼. Esc로 닫습니다. */
function ProposalPanel({ proposal, boxLabel, statusLabel, actions, recruitmentPath, onAction, onClose }: {
  proposal: PartnerProposal
  boxLabel: string
  statusLabel: string
  actions: ('accept' | 'decline' | 'withdraw')[]
  recruitmentPath: string
  onAction: (action: 'accept' | 'decline' | 'withdraw') => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => {
    panelRef.current?.focus()
  }, [proposal.id])
  const dueDays = proposal.status === 'PENDING' ? daysUntil(proposal.expiresAt) : null
  const profile = proposal.counterpart.profile

  return (
    <section
      id="partner-proposal-panel"
      ref={panelRef}
      className={s.panel}
      role="region"
      aria-label={`${boxLabel} 상세`}
      tabIndex={-1}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
    >
      <header className={s.panelHeader}>
        <span className={s.panelGrab} aria-hidden="true" />
        <div className={s.panelHeading}>
          <h2 className={s.panelTitle}>{boxLabel}</h2>
          <p className={s.panelSubtitle}>{proposal.counterpart.companyName} · {formatShortDate(proposal.createdAt)} {proposal.isSent ? '보냄' : '받음'}</p>
        </div>
        <button type="button" className={s.panelClose} onClick={onClose} aria-label="제안 패널 닫기" title="닫기">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>

      <div className={s.panelBody}>
        <div className={s.counterpartRow}>
          <span className={s.counterpartAvatar} aria-hidden="true">{companyInitial(proposal.counterpart.companyName)}</span>
          <span className="min-w-0">
            <span className={s.counterpartName}>{proposal.counterpart.companyName}</span>
            <span className={s.counterpartSummary}>
              {profile
                ? `${toRegionName(profile.region)} · ${profile.industry} · 설립 ${profile.foundedYear}`
                : '기업 기본정보는 수락 뒤에 공개돼요'}
            </span>
          </span>
        </div>

        <div className={s.tagRow}>
          <StatusBadge proposal={proposal} label={statusLabel} />
          {proposal.counterpart.isBusinessVerified ? <span className={workspaceTagClassName('ok')}>사업자 확인됨</span> : null}
          <span className={workspaceTagClassName(proposal.counterpart.isEmailVerified ? 'ok' : 'muted')}>
            {proposal.counterpart.isEmailVerified ? '이메일 인증됨' : '이메일 인증 전'}
          </span>
        </div>

        <dl className={s.kv}>
          <div className={s.kvRow}>
            <dt className={s.kvLabel}>모집글</dt>
            <dd className={s.kvValue}><Link className={s.recruitmentLink} to={recruitmentPath}>{proposal.recruitment.title}</Link></dd>
          </div>
          <div className={s.kvRow}>
            <dt className={s.kvLabel}>{proposal.isSent ? '보낸 날' : '받은 날'}</dt>
            <dd className={s.kvValue}>{formatDateTime(proposal.createdAt)}</dd>
          </div>
          {proposal.status === 'PENDING' ? (
            <div className={s.kvRow}>
              <dt className={s.kvLabel}>응답 기한</dt>
              <dd className={s.kvValue}>{formatDateTime(proposal.expiresAt)}{dueDays !== null ? ` · D-${dueDays}` : ''}</dd>
            </div>
          ) : proposal.respondedAt ? (
            <div className={s.kvRow}>
              <dt className={s.kvLabel}>{statusLabel}</dt>
              <dd className={s.kvValue}>{formatDateTime(proposal.respondedAt)}</dd>
            </div>
          ) : null}
        </dl>

        <div>
          <span className={s.messageLabel}>제안 메시지</span>
          <blockquote className={s.message}>{proposal.message}</blockquote>
        </div>

        {proposal.counterpart.contact ? (
          <div className={s.contactCard} aria-label="상대 담당자 연락처">
            <span className={s.contactLabel}>수락됨 · 담당자 연락처</span>
            <span>
              이메일{' '}
              <a className={s.contactLink} href={`mailto:${proposal.counterpart.contact.email}`}>{proposal.counterpart.contact.email}</a>
            </span>
            <span>사업자등록번호 {proposal.counterpart.contact.businessNumber}</span>
            {profile?.homepageUrl ? (
              <span>
                홈페이지{' '}
                <a className={s.contactLink} href={profile.homepageUrl} rel="noreferrer" target="_blank">{profile.homepageUrl}</a>
              </span>
            ) : null}
          </div>
        ) : actions.includes('accept') ? (
          <div className={s.noteAlert} role="note">
            <span className={s.noteTitle}>수락하면 연락처가 서로 공개돼요</span>
            <span>양쪽 담당자 이메일과 기업 기본정보가 공개돼요. 거절하면 이 모집글에 다시 제안할 수 없어요.</span>
          </div>
        ) : null}
      </div>

      {actions.length > 0 ? (
        <footer className={s.panelFooter}>
          {actions.includes('decline') ? <button type="button" className={s.dangerOutlineButton} onClick={() => onAction('decline')}>거절</button> : null}
          {actions.includes('withdraw') ? <button type="button" className={s.dangerOutlineButton} onClick={() => onAction('withdraw')}>철회</button> : null}
          {actions.includes('accept') ? <button type="button" className={s.primaryButton} onClick={() => onAction('accept')}>수락</button> : null}
        </footer>
      ) : null}
    </section>
  )
}
