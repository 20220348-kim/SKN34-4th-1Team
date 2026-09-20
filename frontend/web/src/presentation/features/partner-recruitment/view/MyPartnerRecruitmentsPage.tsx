import { Link } from 'react-router'

import type { PartnerRecruitmentSummary } from '../../../../domain/entities/PartnerRecruitment'
import {
  workspacePageStyles,
  workspaceTagClassName,
} from '../../../shared/workspace/WorkspacePage.styles'
import { WorkspaceModal } from '../../../shared/workspace/WorkspaceModal'
import { workspaceModalStyles } from '../../../shared/workspace/WorkspaceModal.styles'
import { PartnerManagementHeader } from '../../../shared/partner-recruitment/PartnerManagementHeader'
import {
  programDeadlineLabel,
  recruitmentConditionTags,
  recruitmentDeadlineLabel,
} from '../../../shared/partner-recruitment/partnerRecruitmentLabels'
import { useMyPartnerRecruitmentsViewModel } from '../viewmodel/useMyPartnerRecruitmentsViewModel'
import { partnerRecruitmentStyles } from './PartnerRecruitment.styles'

/**
 * 파트너 관리의 "내 모집글" 탭입니다. 내가 쓴 글을 최근 등록순으로 모아 상태·받은 제안 수를 보여 주고,
 * 모집 중인 글은 카드에서 바로 수정·마감합니다. 마감된 글은 뒤로 보내되 지우지 않습니다.
 */
export function MyPartnerRecruitmentsPage() {
  const {
    hasCompany,
    phase,
    recruitments,
    totalPages,
    page,
    goToPage,
    retry,
    createPath,
    detailPathFor,
    editPathFor,
    closingRecruitment,
    isClosing,
    closeError,
    openCloseConfirm,
    cancelClose,
    confirmClose,
  } = useMyPartnerRecruitmentsViewModel()

  return (
    <>
      <PartnerManagementHeader active="mine" />

      <div className={workspacePageStyles.content}>
        <div className={workspacePageStyles.column}>
          {phase === 'failed' ? (
            <section className={workspacePageStyles.card} aria-label="모집글 불러오기 실패">
              <p className={workspacePageStyles.emptyNote}>내 모집글을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
              <button className={workspacePageStyles.quietLink} type="button" onClick={retry}>다시 시도</button>
            </section>
          ) : phase === 'loading' && recruitments.length === 0 ? (
            <section className={workspacePageStyles.card} aria-label="모집글 불러오는 중">
              <p className={workspacePageStyles.emptyNote}>내 모집글을 불러오는 중입니다.</p>
            </section>
          ) : recruitments.length === 0 ? (
            <section className={workspacePageStyles.card} aria-label="내 모집글 없음">
              <p className={workspacePageStyles.emptyNote}>
                {hasCompany ? '아직 올린 모집글이 없습니다. 첫 모집글을 올려 보세요.' : '프로필에서 기업을 등록하면 모집글을 올릴 수 있습니다.'}
              </p>
              <div className={partnerRecruitmentStyles.linkRow}>
                <Link className={workspacePageStyles.primaryButton} to={createPath}>{hasCompany ? '모집글 작성' : '기업 등록 후 작성'}</Link>
              </div>
            </section>
          ) : (
            <>
              <div className={partnerRecruitmentStyles.cardGrid}>
                {recruitments.map((recruitment) => (
                  <MyRecruitmentCard
                    key={recruitment.id}
                    recruitment={recruitment}
                    detailPath={detailPathFor(recruitment.id)}
                    editPath={editPathFor(recruitment.id)}
                    onClose={() => openCloseConfirm(recruitment)}
                  />
                ))}
              </div>
              {totalPages > 1 ? (
                <nav className={partnerRecruitmentStyles.pagination} aria-label="내 모집글 페이지">
                  <button className={workspacePageStyles.secondaryButton} type="button" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                    이전
                  </button>
                  <span className={partnerRecruitmentStyles.resultCount}>{page} / {totalPages}</span>
                  <button className={workspacePageStyles.secondaryButton} type="button" disabled={page >= totalPages} onClick={() => goToPage(page + 1)}>
                    다음
                  </button>
                </nav>
              ) : null}
            </>
          )}
        </div>
      </div>

      <WorkspaceModal
        isOpen={closingRecruitment !== null}
        title="모집을 마감할까요?"
        description={`${closingRecruitment?.title ?? ''} · 마감하면 새 제안을 받지 않고 대기 중인 제안은 만료됩니다. 되돌릴 수 없습니다.`}
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

/** 내 모집글 카드입니다. 상태·마감일·받은 제안 수를 보여 주고 모집 중이면 수정·마감 버튼을 둡니다. */
function MyRecruitmentCard({
  recruitment,
  detailPath,
  editPath,
  onClose,
}: {
  recruitment: PartnerRecruitmentSummary
  detailPath: string
  editPath: string
  onClose: () => void
}) {
  const isClosed = recruitment.status === 'CLOSED'

  return (
    <article className={isClosed ? workspacePageStyles.outlinedCard : workspacePageStyles.card} aria-label={recruitment.title}>
      <div className={partnerRecruitmentStyles.cardTop}>
        <span className={workspaceTagClassName(isClosed ? 'muted' : 'ok')}>{isClosed ? '모집 마감' : '모집 중'}</span>
        <span className={isClosed ? partnerRecruitmentStyles.mineDeadline : partnerRecruitmentStyles.cardDeadline}>
          {isClosed ? '마감' : recruitmentDeadlineLabel(recruitment.recruitmentDeadline)} · {recruitment.recruitmentDeadline}
        </span>
      </div>

      <div className="flex flex-col gap-[0.2rem]">
        <h3 className={partnerRecruitmentStyles.cardTitle}>{recruitment.title}</h3>
        <p className={partnerRecruitmentStyles.cardProgram}>
          {recruitment.program.title} · {recruitment.program.organization} ·{' '}
          {programDeadlineLabel(recruitment.program.applicationEndDate)}
        </p>
      </div>

      <div className={partnerRecruitmentStyles.tagRow}>
        {recruitmentConditionTags(recruitment).map((tag) => (
          <span className={workspaceTagClassName('muted')} key={tag} title={tag}>
            {tag}
          </span>
        ))}
      </div>

      <div className={partnerRecruitmentStyles.cardFooter}>
        <Link className={partnerRecruitmentStyles.cardFooterNote} to={detailPath}>
          받은 제안 {recruitment.proposalCount}건
        </Link>
        <span className="flex flex-wrap items-center gap-2">
          <Link className={workspacePageStyles.secondaryButton} to={detailPath}>상세</Link>
          {isClosed ? null : (
            <>
              <Link className={workspacePageStyles.secondaryButton} to={editPath}>수정</Link>
              <button className={workspacePageStyles.dangerButton} type="button" onClick={onClose}>마감</button>
            </>
          )}
        </span>
      </div>
    </article>
  )
}
