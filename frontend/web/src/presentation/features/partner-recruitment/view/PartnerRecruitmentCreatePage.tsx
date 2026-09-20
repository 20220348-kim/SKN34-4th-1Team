import { useRef } from 'react'
import { Link } from 'react-router'

import {
  workspacePageStyles,
  workspaceTagClassName,
} from '../../../shared/workspace/WorkspacePage.styles'
import { HelpTip } from '../../../shared/workspace/HelpTip'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { appPaths } from '../../../shared/routes/appPaths'
import { SavedSupportProgramPickerDialog } from '../../../shared/support-program/SavedSupportProgramPickerDialog'
import { usePartnerRecruitmentCreateViewModel } from '../viewmodel/usePartnerRecruitmentCreateViewModel'
import { partnerRecruitmentStyles } from './PartnerRecruitment.styles'
import { PartnerRecruitmentFormFields } from './PartnerRecruitmentFormFields'

/**
 * 모집글 작성 화면입니다. 모집글은 공식 공고 하나에 반드시 묶이고, 공고는 관심 공고함 팝업에서 고릅니다.
 * 모집 마감일은 공고 접수 마감일 이전만 허용합니다. 등록에 성공하면 새 모집글 상세로 이동합니다.
 */
export function PartnerRecruitmentCreatePage() {
  const {
    form,
    error,
    maximumRecruitmentDeadline,
    isSubmitting,
    submit,
    canCreate,
    profilePath,
    savedProgramsPath,
    ownCompany,
    isPickerOpen,
    openPicker,
    closePicker,
    savedProgramChoices,
    recruitmentProgramBlocker,
    selectedProgram,
    selectedProgramKeys,
    toggleProgram,
    clearProgram,
  } = usePartnerRecruitmentCreateViewModel()
  const pickerButtonRef = useRef<HTMLButtonElement>(null)

  function closePickerAndFocus() {
    closePicker()
    pickerButtonRef.current?.focus()
  }

  function changeProgram() {
    clearProgram()
    openPicker()
  }

  if (!canCreate || ownCompany === null) {
    return (
      <>
        <WorkspacePageHeader parent={{ to: appPaths.partners, label: '파트너 관리' }} title="모집글 작성" />
        <div className={workspacePageStyles.content}>
          <section className={workspacePageStyles.card} aria-label="기업 등록 필요">
            <h2 className={workspacePageStyles.cardTitle}>기업을 등록한 뒤 모집글을 쓸 수 있습니다</h2>
            <p className={workspacePageStyles.emptyNote}>
              모집글에는 사업자등록번호 조회로 확인한 기업명이 표시됩니다. 프로필에서 사업자등록번호를 조회하고 기업을 등록해 주세요.
            </p>
            <div className={partnerRecruitmentStyles.linkRow}>
              <Link className={workspacePageStyles.primaryButton} to={profilePath}>프로필에서 기업 등록</Link>
            </div>
          </section>
        </div>
      </>
    )
  }

  return (
    <>
      <WorkspacePageHeader parent={{ to: appPaths.partners, label: '파트너 관리' }} title="모집글 작성" />

      <div className={workspacePageStyles.content}>
        <div className={workspacePageStyles.column}>
          <form className={partnerRecruitmentStyles.form} onSubmit={(event) => void submit(event)} aria-label="모집글 작성" noValidate>
            <section className={partnerRecruitmentStyles.formSection}>
              <div className={partnerRecruitmentStyles.formSectionHeader}>
                <div className={partnerRecruitmentStyles.formSectionTitleGroup}>
                  <span className={partnerRecruitmentStyles.formStepBadge} aria-hidden="true">1</span>
                  <h2 className={partnerRecruitmentStyles.formSectionTitle}>연결할 공고</h2>
                  <HelpTip label="모집글에 표시되는 우리 기업 도움말" title="모집글에 표시되는 우리 기업">
                    <div className={partnerRecruitmentStyles.authorRow}>
                      <span className={`${partnerRecruitmentStyles.authorAvatar} ${partnerRecruitmentStyles.authorAvatarMine}`}>
                        {ownCompany.initial}
                      </span>
                      <span className="min-w-0">
                        <span className={partnerRecruitmentStyles.authorName}>{ownCompany.name}</span>
                        <span className={partnerRecruitmentStyles.authorSummary}>사업자등록번호 조회로 확인한 등록 기업</span>
                      </span>
                    </div>
                    <div className={partnerRecruitmentStyles.tagRow}>
                      <span className={workspaceTagClassName('ok')}>사업자 확인</span>
                    </div>
                    <p className="m-0">
                      프로필의 소재지·업종·설립연도가 함께 보입니다. 담당자 이메일은 제안을 수락한 뒤에만 상대에게 공개되고, 참여
                      제안은 기업을 등록한 회원끼리 주고받습니다.
                    </p>
                  </HelpTip>
                </div>
              </div>

              {selectedProgram ? (
                <div className={partnerRecruitmentStyles.selectedProgram} aria-label="선택한 공고">
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-[0.4rem]">
                      <span className={workspaceTagClassName('ok')}>{selectedProgram.sourceName}</span>
                      <span className={partnerRecruitmentStyles.cardDeadline}>
                        {selectedProgram.applicationEndDate === null ? '공고 마감일 미정' : `공고 마감 ${selectedProgram.applicationEndDate}`}
                      </span>
                    </span>
                    <strong className={partnerRecruitmentStyles.selectedProgramTitle}>
                      {selectedProgram.title}
                    </strong>
                    <span className={partnerRecruitmentStyles.selectedProgramMeta}>
                      {selectedProgram.organization} · {selectedProgram.applicationPeriod}
                    </span>
                  </span>
                  <button ref={pickerButtonRef} className={workspacePageStyles.secondaryButton} type="button" onClick={changeProgram}>
                    공고 변경
                  </button>
                </div>
              ) : (
                <div className={partnerRecruitmentStyles.field}>
                  <button
                    ref={pickerButtonRef}
                    type="button"
                    className={partnerRecruitmentStyles.pickerButton}
                    aria-label="관심 공고함에서 선택"
                    aria-haspopup="dialog"
                    aria-expanded={isPickerOpen}
                    aria-invalid={error?.field === 'program'}
                    aria-describedby={error?.field === 'program' ? 'recruitment-error' : undefined}
                    onClick={openPicker}
                  >
                    <span>관심 공고함에서 선택</span>
                    <span className="text-brand-primary">열기 ›</span>
                  </button>
                  <span className={partnerRecruitmentStyles.fieldHint}>
                    관심 공고함에 담은 공고 중 접수 중인 공고만 고를 수 있습니다. 담은 공고가 없으면{' '}
                    <Link className={partnerRecruitmentStyles.fieldHintLink} to={savedProgramsPath}>관심 공고함</Link>
                    에서 먼저 담아 주세요.
                  </span>
                </div>
              )}
              <SavedSupportProgramPickerDialog
                open={isPickerOpen}
                phase={savedProgramChoices.phase}
                programs={savedProgramChoices.programs}
                selectedProgramKeys={selectedProgramKeys}
                selectionLimit={1}
                description="모집글을 묶을 공고를 1개 선택하세요. 접수 중인 공고만 고를 수 있습니다."
                listLabel="모집글 관심 공고 목록"
                isSupported={(program) => recruitmentProgramBlocker(program) === null}
                unsupportedLabel={(program) => recruitmentProgramBlocker(program) ?? '선택할 수 없음'}
                onToggle={toggleProgram}
                onRetry={savedProgramChoices.retry}
                onClose={closePickerAndFocus}
              />
            </section>

            <span className={partnerRecruitmentStyles.formDivider} aria-hidden="true" />

            <PartnerRecruitmentFormFields
              form={form}
              maximumRecruitmentDeadline={maximumRecruitmentDeadline}
              programTargetDescription={selectedProgram?.targetDescription ?? null}
            />

            {error ? <p id="recruitment-error" className={workspacePageStyles.emptyNote} role="alert">{error.message}</p> : null}
            <div className={partnerRecruitmentStyles.formActions}>
              <div className={partnerRecruitmentStyles.formActionButtons}>
                <Link className={partnerRecruitmentStyles.formCancelButton} to={appPaths.partners}>
                  취소
                </Link>
                <button className={partnerRecruitmentStyles.formSubmitButton} type="submit" disabled={isSubmitting}>
                  {isSubmitting ? '등록 중…' : '모집글 등록'}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
