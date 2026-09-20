import { HelpTip } from '../../../shared/workspace/HelpTip'
import { SelectField } from '../../../shared/workspace/SelectField'
import { recruitmentWritingTips, type RecruitmentFormFields } from '../viewmodel/useRecruitmentFormFields'
import {
  partnerRecruitmentStyles,
  partnerRoleChoiceClassName,
} from './PartnerRecruitment.styles'

/**
 * 모집글 작성·수정 폼의 2단계(역할과 조건)·3단계(소개)입니다. 1단계(공고)와 제출 버튼은 각 화면이 맡습니다.
 * 오류 문구는 화면의 `recruitment-error` 요소가 보여 주고, 여기서는 해당 입력에 `aria-describedby`로 연결만 합니다.
 */
export function PartnerRecruitmentFormFields({
  form,
  maximumRecruitmentDeadline,
  programTargetDescription,
}: {
  form: RecruitmentFormFields
  maximumRecruitmentDeadline: string | null
  /** 묶인 공고의 지원대상 원문입니다. 공고를 아직 고르지 않았으면 null입니다. */
  programTargetDescription: string | null
}) {
  const { error } = form
  const describedBy = (field: NonNullable<typeof error>['field']) => (error?.field === field ? 'recruitment-error' : undefined)

  return (
    <>
      <section className={partnerRecruitmentStyles.formSection}>
        <div className={partnerRecruitmentStyles.formSectionTitleGroup}>
          <span className={partnerRecruitmentStyles.formStepBadge} aria-hidden="true">2</span>
          <h2 className={partnerRecruitmentStyles.formSectionTitle}>역할과 조건</h2>
        </div>

        <div className={partnerRecruitmentStyles.fieldRow}>
          <div className={partnerRecruitmentStyles.field}>
            <span id="own-role-label">우리 기업의 역할</span>
            <div className={partnerRecruitmentStyles.roleChoices} role="group" aria-labelledby="own-role-label">
              {form.ownRoles.map((role) => (
                <button
                  className={partnerRoleChoiceClassName(form.ownRole === role.value)}
                  key={role.value}
                  type="button"
                  aria-pressed={form.ownRole === role.value}
                  onClick={() => form.selectOwnRole(role.value)}
                >
                  {role.label}
                </button>
              ))}
            </div>
          </div>

          <div className={partnerRecruitmentStyles.field}>
            <span id="seeking-role-label">찾는 역할</span>
            <div className={partnerRecruitmentStyles.roleChoices} role="group" aria-labelledby="seeking-role-label">
              {form.seekingRoles.map((role) => (
                <button
                  className={partnerRoleChoiceClassName(form.seekingRole === role.value)}
                  key={role.value}
                  type="button"
                  aria-pressed={form.seekingRole === role.value}
                  onClick={() => form.selectSeekingRole(role.value)}
                >
                  {role.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={partnerRecruitmentStyles.fieldRow}>
          <div className={partnerRecruitmentStyles.field}>
            <label htmlFor="seeking-count">찾는 기업 수</label>
            <span className={partnerRecruitmentStyles.unitField}>
              <input
                className={partnerRecruitmentStyles.fieldControl}
                id="seeking-count"
                type="number"
                name="seekingCount"
                inputMode="numeric"
                min={form.seekingCountRange.min}
                max={form.seekingCountRange.max}
                step={1}
                aria-invalid={error?.field === 'seekingCount'}
                aria-describedby={describedBy('seekingCount')}
                value={Number.isNaN(form.seekingCount) ? '' : form.seekingCount}
                onChange={(event) => form.updateSeekingCount(event.target.value)}
              />
              <span className={partnerRecruitmentStyles.unitLabel} aria-hidden="true">곳</span>
            </span>
          </div>

          <div className={partnerRecruitmentStyles.field}>
            <label htmlFor="seeking-region">희망 지역</label>
            <SelectField
              className={partnerRecruitmentStyles.fieldControl}
              id="seeking-region"
              name="seekingRegion"
              value={form.seekingRegion}
              options={form.regionOptions.map((region) => ({ value: region, label: region }))}
              onChange={form.updateSeekingRegion}
            />
            {programTargetDescription ? (
              <span className={partnerRecruitmentStyles.fieldHint}>공고 지원대상 원문: {programTargetDescription}</span>
            ) : null}
          </div>
        </div>

        <div className={partnerRecruitmentStyles.field}>
          <label htmlFor="capability-input">필요 역량</label>
          <div className={partnerRecruitmentStyles.capabilityBox}>
            {form.capabilities.map((capability) => (
              <span className={partnerRecruitmentStyles.capabilityChip} key={capability}>
                {capability}
                <button
                  className={partnerRecruitmentStyles.capabilityRemove}
                  type="button"
                  aria-label={`${capability} 삭제`}
                  onClick={() => form.removeCapability(capability)}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              className={partnerRecruitmentStyles.capabilityInput}
              id="capability-input"
              type="text"
              placeholder="역량 입력 후 Enter"
              aria-describedby={describedBy('capabilities')}
              value={form.capabilityDraft}
              onChange={(event) => form.updateCapabilityDraft(event.target.value)}
              onKeyDown={form.addCapabilityOnEnter}
            />
          </div>
        </div>

        <div className={partnerRecruitmentStyles.fieldRow}>
          <div className={partnerRecruitmentStyles.field}>
            <label htmlFor="recruitment-deadline">모집 마감일</label>
            <input
              className={partnerRecruitmentStyles.fieldControl}
              id="recruitment-deadline"
              type="date"
              name="recruitmentDeadline"
              min={form.minimumRecruitmentDeadline}
              max={maximumRecruitmentDeadline ?? undefined}
              required
              aria-invalid={error?.field === 'recruitmentDeadline'}
              aria-describedby={describedBy('recruitmentDeadline')}
              value={form.recruitmentDeadline}
              onChange={(event) => form.updateRecruitmentDeadline(event.target.value)}
            />
            <span className={partnerRecruitmentStyles.fieldHint}>
              {maximumRecruitmentDeadline === null
                ? '오늘 이후 날짜를 고르세요. 공고가 먼저 마감되면 모집도 자동 종료됩니다.'
                : `공고 접수 마감 전날인 ${maximumRecruitmentDeadline}까지 고를 수 있으며, 공고가 먼저 마감되면 모집도 자동 종료됩니다.`}
            </span>
          </div>

          <div className={partnerRecruitmentStyles.field}>
            <label htmlFor="company-age">
              <span className={partnerRecruitmentStyles.fieldLabelRow}>
                희망 업력 <span className={partnerRecruitmentStyles.optionalMark}>선택</span>
              </span>
            </label>
            <span className={partnerRecruitmentStyles.unitField}>
              <input
                className={partnerRecruitmentStyles.fieldControl}
                id="company-age"
                type="number"
                name="minimumCompanyAgeYears"
                inputMode="numeric"
                min={form.companyAgeYearsRange.min}
                max={form.companyAgeYearsRange.max}
                step={1}
                placeholder="무관"
                aria-invalid={error?.field === 'minimumCompanyAgeYears'}
                aria-describedby={describedBy('minimumCompanyAgeYears')}
                value={form.minimumCompanyAgeYears ?? ''}
                onChange={(event) => form.updateMinimumCompanyAgeYears(event.target.value)}
              />
              <span className={partnerRecruitmentStyles.unitLabel} aria-hidden="true">년 이상</span>
            </span>
            <span className={partnerRecruitmentStyles.fieldHint}>비워 두면 업력 무관으로 표시합니다.</span>
          </div>
        </div>
      </section>

      <span className={partnerRecruitmentStyles.formDivider} aria-hidden="true" />

      <section className={partnerRecruitmentStyles.formSection}>
        <div className={partnerRecruitmentStyles.formSectionHeader}>
          <div className={partnerRecruitmentStyles.formSectionTitleGroup}>
            <span className={partnerRecruitmentStyles.formStepBadge} aria-hidden="true">3</span>
            <h2 className={partnerRecruitmentStyles.formSectionTitle}>소개</h2>
            <HelpTip label="작성 팁 도움말" title="작성 팁">
              <ul className={partnerRecruitmentStyles.plainList}>
                {recruitmentWritingTips.map((tip) => <li key={tip}>{tip}</li>)}
              </ul>
            </HelpTip>
          </div>
        </div>

        <div className={partnerRecruitmentStyles.field}>
          <label htmlFor="recruitment-title">제목</label>
          <input
            className={partnerRecruitmentStyles.fieldControl}
            id="recruitment-title"
            type="text"
            name="title"
            maxLength={form.titleMaxLength}
            required
            aria-invalid={error?.field === 'title'}
            aria-describedby={describedBy('title')}
            placeholder="어떤 과제에 어떤 파트너를 찾는지 한 줄로 적어 주세요."
            value={form.title}
            onChange={(event) => form.updateTitle(event.target.value)}
          />
          <span className={partnerRecruitmentStyles.proposalCounter}>
            {form.title.length} / {form.titleMaxLength}
          </span>
        </div>

        <div className={partnerRecruitmentStyles.field}>
          <label htmlFor="recruitment-body">본문</label>
          <textarea
            className={`${partnerRecruitmentStyles.fieldControl} ${partnerRecruitmentStyles.fieldTextarea}`}
            id="recruitment-body"
            name="body"
            maxLength={form.bodyMaxLength}
            required
            aria-invalid={error?.field === 'body'}
            aria-describedby={describedBy('body')}
            placeholder="우리 기업 소개, 맡을 역할, 상대에게 바라는 역량과 일정을 적어 주세요."
            value={form.body}
            onChange={(event) => form.updateBody(event.target.value)}
          />
          <span className={partnerRecruitmentStyles.proposalCounter}>
            {form.body.length} / {form.bodyMaxLength}
          </span>
        </div>
      </section>
    </>
  )
}
