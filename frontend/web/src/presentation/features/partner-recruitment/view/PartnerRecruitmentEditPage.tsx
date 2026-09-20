import { Link } from 'react-router'

import {
  workspacePageStyles,
  workspaceTagClassName,
} from '../../../shared/workspace/WorkspacePage.styles'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { appPaths } from '../../../shared/routes/appPaths'
import { programDeadlineLabel } from '../../../shared/partner-recruitment/partnerRecruitmentLabels'
import { usePartnerRecruitmentEditViewModel } from '../viewmodel/usePartnerRecruitmentEditViewModel'
import { partnerRecruitmentStyles } from './PartnerRecruitment.styles'
import { PartnerRecruitmentFormFields } from './PartnerRecruitmentFormFields'

/**
 * 모집글 수정 화면입니다. 작성 화면과 같은 2·3단계 폼을 쓰되 1단계의 공고는 바꿀 수 없어 묶인 공고를 보여 주기만 합니다.
 * 저장하면 그 모집글 상세로 돌아갑니다.
 */
export function PartnerRecruitmentEditPage() {
  const { phase, recruitment, canEdit, form, maximumRecruitmentDeadline, isSubmitting, submit, detailPath, listPath } =
    usePartnerRecruitmentEditViewModel()
  const header = <WorkspacePageHeader parent={{ to: appPaths.partners, label: '파트너 관리' }} title="모집글 수정" />

  if (phase === 'loading') {
    return (
      <>
        {header}
        <div className={workspacePageStyles.content} aria-label="모집글 불러오는 중">
          <p className={workspacePageStyles.emptyNote}>모집글을 불러오는 중입니다.</p>
        </div>
      </>
    )
  }

  if (phase === 'failed' || recruitment === null) {
    return (
      <>
        {header}
        <div className={workspacePageStyles.content}>
          <section className={workspacePageStyles.card} aria-label="모집글 없음">
            <h2 className={workspacePageStyles.cardTitle}>
              {phase === 'failed' ? '모집글을 불러오지 못했습니다' : '모집글을 찾을 수 없습니다'}
            </h2>
            <p className={workspacePageStyles.emptyNote}>
              {phase === 'failed' ? '잠시 후 다시 시도해 주세요.' : '요청한 모집글이 없거나 내려갔습니다.'}
            </p>
            <div className={partnerRecruitmentStyles.linkRow}>
              <Link className={workspacePageStyles.secondaryButton} to={listPath}>파트너 관리</Link>
            </div>
          </section>
        </div>
      </>
    )
  }

  if (!canEdit) {
    return (
      <>
        {header}
        <div className={workspacePageStyles.content}>
          <section className={workspacePageStyles.card} aria-label="수정할 수 없는 모집글">
            <h2 className={workspacePageStyles.cardTitle}>
              {recruitment.isMine ? '마감된 모집글은 고칠 수 없습니다' : '내가 쓴 모집글만 고칠 수 있습니다'}
            </h2>
            <div className={partnerRecruitmentStyles.linkRow}>
              <Link className={workspacePageStyles.secondaryButton} to={detailPath}>모집글 상세</Link>
            </div>
          </section>
        </div>
      </>
    )
  }

  const { error } = form

  return (
    <>
      {header}

      <div className={workspacePageStyles.content}>
        <div className={workspacePageStyles.column}>
          <form className={partnerRecruitmentStyles.form} onSubmit={(event) => void submit(event)} aria-label="모집글 수정" noValidate>
            <section className={partnerRecruitmentStyles.formSection}>
              <div className={partnerRecruitmentStyles.formSectionHeader}>
                <div className={partnerRecruitmentStyles.formSectionTitleGroup}>
                  <span className={partnerRecruitmentStyles.formStepBadge} aria-hidden="true">1</span>
                  <h2 className={partnerRecruitmentStyles.formSectionTitle}>연결된 공고</h2>
                  <span className={partnerRecruitmentStyles.formSectionHint}>공고는 바꿀 수 없습니다.</span>
                </div>
              </div>
              {/* 공고는 작성 때 정해지고 바꾸지 않으므로 선택 화면 대신 묶인 공고만 보여 줍니다. */}
              <div className={partnerRecruitmentStyles.selectedProgram} aria-label="연결된 공고">
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-[0.4rem]">
                    <span className={workspaceTagClassName('ok')}>기업마당</span>
                    <span className={partnerRecruitmentStyles.cardDeadline}>
                      {programDeadlineLabel(recruitment.program.applicationEndDate)}
                    </span>
                  </span>
                  <strong className={partnerRecruitmentStyles.selectedProgramTitle}>{recruitment.program.title}</strong>
                  <span className={partnerRecruitmentStyles.selectedProgramMeta}>
                    {recruitment.program.organization} · {recruitment.program.applicationPeriod}
                  </span>
                </span>
              </div>
            </section>

            <span className={partnerRecruitmentStyles.formDivider} aria-hidden="true" />

            <PartnerRecruitmentFormFields
              form={form}
              maximumRecruitmentDeadline={maximumRecruitmentDeadline}
              programTargetDescription={recruitment.program.targetDescription}
            />

            {error ? <p id="recruitment-error" className={workspacePageStyles.emptyNote} role="alert">{error.message}</p> : null}
            <div className={partnerRecruitmentStyles.formActions}>
              <div className={partnerRecruitmentStyles.formActionButtons}>
                <Link className={partnerRecruitmentStyles.formCancelButton} to={detailPath}>
                  취소
                </Link>
                <button className={partnerRecruitmentStyles.formSubmitButton} type="submit" disabled={isSubmitting}>
                  {isSubmitting ? '저장 중…' : '수정 저장'}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
