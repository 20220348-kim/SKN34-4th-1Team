import type { ReactNode } from 'react'

import { workspacePageStyles, workspaceTagClassName } from '../../../shared/workspace/WorkspacePage.styles'
import type { useCompanyPartnerProfileViewModel } from '../viewmodel/useCompanyPartnerProfileViewModel'
import { companyProfileChoiceClassName, companyProfileStyles } from './CompanyProfilePage.styles'

type PartnerProfileViewModel = ReturnType<typeof useCompanyPartnerProfileViewModel>

/**
 * 협업·파트너 설정 카드입니다. 기업 기본정보처럼 평소에는 저장된 값을 보여 주고 "수정"을 눌러야 폼이 열립니다.
 * 기업을 등록한 뒤에만 편집할 수 있고, 저장한 값은 모집글 상세와 기업 프로필 보기에 나갑니다.
 * [titleHelp]는 제목 옆에 붙는 공개 범위 `?` 도움말입니다.
 */
export function CompanyPartnerProfileSection({ vm, titleHelp }: { vm: PartnerProfileViewModel; titleHelp?: ReactNode }) {
  const errorId = (field: string) => (vm.error?.field === field ? `partner-profile-${field}-error` : undefined)
  const errorOf = (field: string) =>
    vm.error?.field === field ? <p id={`partner-profile-${field}-error`} className={companyProfileStyles.formError} role="alert">{vm.error.message}</p> : null
  const canEdit = vm.hasCompany && vm.loadStatus === 'ready' && !vm.isEditing
  const roleLabels = vm.roleOptions.filter((option) => vm.form.roles.includes(option.value)).map((option) => option.label)
  const fields: { label: string; value: string | null; isOptional?: boolean }[] = [
    { label: '참여 가능 역할', value: roleLabels.length ? roleLabels.join(' · ') : null },
    { label: '관심 분야', value: vm.form.interestAreas.length ? vm.form.interestAreas.join(' · ') : null },
    { label: '한 줄 소개', value: vm.form.introduction.trim() || null, isOptional: true },
    { label: '보유 역량', value: vm.form.capabilities.length ? vm.form.capabilities.join(' · ') : null, isOptional: true },
  ]

  return (
    <section className={workspacePageStyles.card} aria-label="협업·파트너 설정">
      <div className={workspacePageStyles.cardHeader}>
        <div>
          <div className={companyProfileStyles.titleRow}>
            <h2 className={workspacePageStyles.cardTitle}>{vm.isEditing ? '협업·파트너 설정 수정' : '협업·파트너 설정'}</h2>
            {titleHelp}
          </div>
        </div>
        <div className={companyProfileStyles.headerActions}>
          {vm.isSet ? <span className={workspaceTagClassName('ok')}>저장됨</span> : <span className={workspaceTagClassName('muted')}>미설정</span>}
          {canEdit ? (
            <button className={workspacePageStyles.secondaryButton} type="button" onClick={vm.startEditing}>수정</button>
          ) : null}
        </div>
      </div>

      {!vm.hasCompany ? (
        <p className={workspacePageStyles.emptyNote}>기업을 등록하면 협업 조건을 설정할 수 있습니다.</p>
      ) : vm.loadFailedMessage ? (
        <p className={companyProfileStyles.formError} role="alert">{vm.loadFailedMessage}</p>
      ) : !vm.isEditing ? (
        <>
          {vm.isSet ? (
            <div className={companyProfileStyles.fieldGrid}>
              {fields.map((field) => (
                <div className={field.value === null ? companyProfileStyles.emptyField : companyProfileStyles.field} key={field.label}>
                  <span className={companyProfileStyles.fieldLabel}>
                    {field.label}
                    {field.isOptional ? <span className={companyProfileStyles.optionalMark}>선택</span> : null}
                  </span>
                  {field.value === null
                    ? <span className={companyProfileStyles.emptyValue}>미입력</span>
                    : <span className={companyProfileStyles.fieldValue}>{field.value}</span>}
                </div>
              ))}
            </div>
          ) : (
            <p className={workspacePageStyles.emptyNote}>아직 설정하지 않았습니다. 수정을 눌러 참여 가능 역할과 관심 분야를 채우면 모집글 상세와 기업 프로필에 함께 보입니다.</p>
          )}
        </>
      ) : (
        <form className={companyProfileStyles.form} aria-label="협업·파트너 설정" onSubmit={vm.submit} noValidate>
          <div className={companyProfileStyles.choiceGroup}>
            <span className={companyProfileStyles.choiceLabel} id="partner-roles-label">참여 가능 역할</span>
            <div className={companyProfileStyles.choices} role="group" aria-labelledby="partner-roles-label" aria-describedby={errorId('roles')}>
              {vm.roleOptions.map((option) => (
                <button
                  className={companyProfileChoiceClassName(vm.form.roles.includes(option.value))}
                  key={option.value}
                  type="button"
                  aria-pressed={vm.form.roles.includes(option.value)}
                  onClick={() => vm.toggleRole(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {errorOf('roles')}
          </div>

          <div className={companyProfileStyles.choiceGroup}>
            <span className={companyProfileStyles.choiceLabel} id="partner-interest-label">관심 분야 <span className={companyProfileStyles.optionalMark}>최대 {vm.limits.interestAreaMaxCount}개</span></span>
            <div className={companyProfileStyles.choices} role="group" aria-labelledby="partner-interest-label" aria-describedby={errorId('interestAreas')}>
              {vm.interestAreaOptions.map((area) => (
                <button
                  className={companyProfileChoiceClassName(vm.form.interestAreas.includes(area))}
                  key={area}
                  type="button"
                  aria-pressed={vm.form.interestAreas.includes(area)}
                  onClick={() => vm.toggleInterestArea(area)}
                >
                  {area}
                </button>
              ))}
            </div>
            {errorOf('interestAreas')}
          </div>

          <div className={companyProfileStyles.capabilityGroup}>
            <label className={companyProfileStyles.choiceLabel} htmlFor="partner-introduction">한 줄 소개 <span className={companyProfileStyles.optionalMark}>선택 · {vm.limits.introductionMaxLength}자</span></label>
            <textarea
              className={companyProfileStyles.capabilityTextarea}
              id="partner-introduction"
              maxLength={vm.limits.introductionMaxLength}
              placeholder="어떤 일을 하는 팀인지, 어떤 협업을 찾는지 한두 문장으로"
              aria-describedby={errorId('introduction') ?? 'partner-introduction-count'}
              value={vm.form.introduction}
              onChange={(event) => vm.updateIntroduction(event.target.value)}
            />
            <span id="partner-introduction-count" className={companyProfileStyles.counter}>{vm.form.introduction.length} / {vm.limits.introductionMaxLength}</span>
            {errorOf('introduction')}
          </div>

          <div className={companyProfileStyles.capabilityGroup}>
            <label className={companyProfileStyles.choiceLabel} htmlFor="partner-capability-input">보유 역량 태그 <span className={companyProfileStyles.optionalMark}>최대 {vm.limits.capabilityMaxCount}개 · 각 {vm.limits.capabilityMaxLength}자</span></label>
            <div className={companyProfileStyles.capabilityBox}>
              {vm.form.capabilities.map((capability) => (
                <span className={companyProfileStyles.capabilityChip} key={capability}>
                  {capability}
                  <button className={companyProfileStyles.capabilityRemove} type="button" aria-label={`${capability} 삭제`} onClick={() => vm.removeCapability(capability)}>×</button>
                </span>
              ))}
              <input
                className={companyProfileStyles.capabilityInput}
                id="partner-capability-input"
                type="text"
                placeholder="입력 후 Enter"
                aria-describedby={errorId('capabilities')}
                value={vm.capabilityDraft}
                onChange={(event) => vm.updateCapabilityDraft(event.target.value)}
                onKeyDown={vm.addCapabilityOnEnter}
                onBlur={vm.addCapability}
              />
            </div>
            {errorOf('capabilities')}
          </div>

          {vm.error?.field === 'form' ? <p className={companyProfileStyles.formError} role="alert">{vm.error.message}</p> : null}
          <div className={companyProfileStyles.formActions}>
            <button className={workspacePageStyles.secondaryButton} type="button" onClick={vm.cancelEditing} disabled={vm.isSaving}>취소</button>
            <button className={workspacePageStyles.primaryButton} type="submit" disabled={vm.isSaving || vm.loadStatus !== 'ready'}>
              {vm.isSaving ? '저장 중…' : '저장'}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
