import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { daysUntil, ddayTone, formatDday, type DdayTone } from '@govbiz/shared/domain/labels'

import { partnerProposalStatusTones, type PartnerProposal } from '../../../../domain/entities/PartnerProposal'
import { toRegionName } from '../../../../domain/entities/Region'
import { assistantCover } from '../../../shared/assistant/assistantPlacement'
import { companyInitial } from '../../../shared/partner-recruitment/partnerRecruitmentLabels'
import { workspaceChipClassName, workspacePageStyles, workspaceTagClassName } from '../../../shared/workspace/WorkspacePage.styles'
import { EmptyState } from '../../../shared/workspace/EmptyState'
import { EnvelopeIcon, SearchIcon } from '../../../shared/workspace/EmptyStateIcons'
import { HelpTip } from '../../../shared/workspace/HelpTip'
import { WorkspaceModal } from '../../../shared/workspace/WorkspaceModal'
import { ddayToneClassNames } from '../../../shared/workspace/WorkspaceStates.styles'
import { workspaceModalStyles } from '../../../shared/workspace/WorkspaceModal.styles'
import { PartnerManagementHeader } from '../../../shared/partner-recruitment/PartnerManagementHeader'
import { appPaths } from '../../../shared/routes/appPaths'
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

/**
 * 대기 중인 제안의 응답 기한 D-day입니다. 기한은 서울 시각(`2026-09-23T14:20:00`)이라 그 날짜 부분으로 shared D-day(D-3 · 당일 D-day)와
 * 색 단계(`ddayTone`)를 씁니다. 대기 중이 아니거나 기한 날짜가 지났거나 읽을 수 없으면 null입니다.
 */
function proposalDueDday(proposal: PartnerProposal): { label: string; tone: DdayTone } | null {
  if (proposal.status !== 'PENDING') return null
  const days = daysUntil(proposal.expiresAt.slice(0, 10))
  return days === null || days < 0 ? null : { label: formatDday(days), tone: ddayTone(days) }
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
        {/* 받은 제안 · 보낸 제안 세그먼트는 본문 첫 줄 왼쪽에 내용 폭만큼만 둡니다(세로 flex 안에서 늘어나지 않게 self-start).
            제안함 규칙 안내는 본문 문장 대신 세그먼트 옆 ? 도움말에 둡니다. */}
        <div className="flex items-center gap-2 self-start">
          <div className={workspacePageStyles.segment} role="tablist" aria-label="제안함 종류">
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
          <HelpTip label="제안함 도움말" title="제안함">
            <p className="m-0">기업 회원끼리 주고받은 참여 제안이에요.</p>
            <p className="m-0">모집글 하나에 한 번 보낼 수 있고, 7일 안에 답하지 않으면 끝나요.</p>
          </HelpTip>
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
          // 다른 작업 화면과 같은 공용 빈 화면입니다. 상태 칩으로 비었으면 전체 보기, 받은 제안은 모집글 작성, 보낸 제안은 모집글 둘러보기를 권합니다.
          statusFilter !== 'all' ? (
            <EmptyState icon={<SearchIcon />} title="이 상태의 제안이 없어요"
              description="다른 상태를 고르거나 전체 제안을 볼 수 있어요."
              action={{ label: '전체 보기', onClick: () => vm.selectStatusFilter('all') }} />
          ) : box === 'received' ? (
            // 기업 미등록이면 위 안내 줄에 이미 [프로필에서 기업 등록]이 있어 버튼을 두 번 두지 않습니다.
            <EmptyState icon={<EnvelopeIcon />} title="아직 받은 제안이 없어요"
              description="모집글을 올리면 다른 기업의 참여 제안이 여기에 모여요."
              action={vm.hasCompany ? { label: '모집글 작성하기', to: appPaths.partnerNew } : undefined} />
          ) : (
            <EmptyState icon={<EnvelopeIcon />} title="아직 보낸 제안이 없어요"
              description="모집글 상세에서 함께 신청하고 싶은 기업에 참여 제안을 보낼 수 있어요."
              action={{ label: '모집글 둘러보기', to: vm.partnersPath }} />
          )
        ) : (
          <div className={s.list} role="tabpanel" aria-label={boxLabel}>
            {proposals.map((proposal) => {
              const isSelected = selectedProposal?.id === proposal.id
              const statusLabel = vm.statusLabel(proposal)
              const dueDday = proposalDueDday(proposal)
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
                        {/* 남은 응답 기한은 모집글 카드처럼 상태 배지 옆 D-day 배지로 알립니다. */}
                        {dueDday !== null && <span className={`${workspacePageStyles.tag} ${ddayToneClassNames[dueDday.tone]}`}><span className="sr-only">응답 기한 </span>{dueDday.label}</span>}
                      </span>
                      <span className={s.rowSub}>
                        <span>{proposal.recruitment.title}</span>
                        <span className="shrink-0"> · {proposalMoment(proposal, statusLabel)}</span>
                      </span>
                    </span>
                    {proposal.status === 'PENDING' ? (
                      <span className={s.rowDue}>기한 {formatShortDate(proposal.expiresAt)}</span>
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
  const dueDday = proposalDueDday(proposal)
  const profile = proposal.counterpart.profile

  return (
    <section
      id="partner-proposal-panel"
      ref={panelRef}
      className={s.panel}
      role="region"
      aria-label={`${boxLabel} 상세`}
      tabIndex={-1}
      {...assistantCover.always}
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
              <dd className={s.kvValue}>{formatDateTime(proposal.expiresAt)}{dueDday !== null ? ` · ${dueDday.label}` : ''}</dd>
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
