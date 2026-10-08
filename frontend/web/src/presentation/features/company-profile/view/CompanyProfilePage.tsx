import type { ReactNode } from 'react'

import {
  workspacePageStyles,
  workspaceTagClassName,
} from '../../../shared/workspace/WorkspacePage.styles'
import { HelpTip } from '../../../shared/workspace/HelpTip'
import { companyInitial } from '../../../shared/partner-recruitment/partnerRecruitmentLabels'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { useDelayedFlag } from '../../../shared/workspace/useDelayedFlag'
import { BusinessLookupResult } from '../../../shared/company/BusinessLookupResult'
import { BusinessNumberField } from '../../../shared/company/BusinessNumberField'
import { CompanyProfileFields } from '../../../shared/company/CompanyProfileFields'
import { usePlanUsage } from '../../../shared/plan-usage/usePlanUsage'
import { useAccountSecurityViewModel } from '../viewmodel/useAccountSecurityViewModel'
import { useCompanyProfileViewModel } from '../viewmodel/useCompanyProfileViewModel'
import { useNotificationSettingsViewModel } from '../viewmodel/useNotificationSettingsViewModel'
import { ChangePasswordModal, DeleteAccountModal } from './AccountSecurityModals'
import { CompanyPartnerProfileSection } from './CompanyPartnerProfileSection'
import { companyProfileStyles } from './CompanyProfilePage.styles'
import { NotificationSettingsRows } from './NotificationSettingsRows'
import { PlanUsageSection } from './PlanUsageSection'

const usageIcons: Record<'target' | 'users' | 'shield', ReactNode> = {
  target: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  users: (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
}

/** 글자 한 줄 자리입니다. `box`는 실제 줄 높이, `bar`는 그 안 가운데에 놓이는 막대의 크기입니다. */
function SkeletonLine({ box, bar }: { box: string; bar: string }) {
  return <span className={`flex items-center ${box}`}><span className={`${companyProfileStyles.skeletonBar} ${bar}`} /></span>
}

/** 회색 칸 한 개(라벨 + 값) 자리입니다. */
function SkeletonField({ tall = false }: { tall?: boolean }) {
  return <div className={companyProfileStyles.field}>
    <SkeletonLine box="h-4" bar="h-2.5 w-12" />
    <SkeletonLine box={tall ? 'h-6' : 'h-5'} bar="h-3.5 w-3/5" />
  </div>
}

/**
 * 기업 정보와 협업 설정을 읽는 동안의 자리입니다. 읽기 전에 "기업 미등록 · 완성도 33%" 같은 틀린 값을 먼저 보여 주지 않도록
 * 요약 · 기업 기본정보 · 협업·파트너 설정 카드를 같은 틀의 막대로 채웁니다. 300ms 안에 끝나면 막대는 보이지 않고 자리만 잡습니다.
 */
function ProfileSkeleton({ part, visible }: { part: 'summary' | 'company' | 'partner'; visible: boolean }) {
  const bar = companyProfileStyles.skeletonBar
  return <section className={`${workspacePageStyles.card} ${visible ? '' : 'invisible'}`} aria-hidden="true">
    {part === 'summary' ? <>
      <div className={companyProfileStyles.summaryTop}>
        <div className={companyProfileStyles.summaryIdentity}>
          <span className={`${bar} size-[3.25rem] shrink-0 rounded-[0.9rem]`} />
          <div className="flex flex-col">
            <SkeletonLine box="h-[29px]" bar="h-5 w-44" />
            <span className={companyProfileStyles.summaryTags}><span className={`${bar} h-6 w-16 rounded-full`} /><span className={`${bar} h-6 w-20 rounded-full`} /><span className={`${bar} h-6 w-16 rounded-full`} /></span>
          </div>
        </div>
      </div>
      <div className={companyProfileStyles.completion}>
        <span className="flex items-center justify-between"><SkeletonLine box="h-[17px]" bar="h-3 w-20" /><SkeletonLine box="h-[17px]" bar="h-3 w-8" /></span>
        <span className={`${bar} h-2 w-full rounded-full`} />
        <SkeletonLine box="h-[18px]" bar="h-3 w-3/5" />
        <span className={companyProfileStyles.checklist}><SkeletonLine box="h-[18px]" bar="h-3 w-40" /><SkeletonLine box="h-[18px]" bar="h-3 w-24" /><SkeletonLine box="h-[18px]" bar="h-3 w-28" /></span>
      </div>
    </> : <>
      <div className={workspacePageStyles.cardHeader}>
        <SkeletonLine box="h-10" bar="h-4 w-32" />
        <span className={`${bar} h-10 w-14 rounded-full`} />
      </div>
      <div className={companyProfileStyles.fieldGrid}>
        {/* 기업 기본정보의 첫 줄은 값 옆에 태그가 붙어 한 줄이 조금 높습니다. */}
        {Array.from({ length: part === 'company' ? 7 : 4 }, (_, index) => <SkeletonField key={index} tall={part === 'company' && index < 2} />)}
      </div>
    </>}
  </section>
}

/**
 * 기업 프로필 화면입니다. 기업 기본정보는 사업자등록번호 조회로 등록·수정하고, 협업·파트너 설정은 모집글 상세와
 * 기업 프로필 보기에 나갑니다. 담당자 연락처는 제안을 수락한 뒤에만 공개되며 GovBiz는 역량·실적을 검증하지 않습니다.
 * 알림은 관심 공고 마감 알림만 서버에 저장해 실제로 보내고, 파트너 제안·새 공고 알림은 준비 중으로 표시합니다.
 * 완성도와 체크리스트는 맨 위 요약 카드에, "이 정보가 쓰이는 곳"·"공개 범위"는 해당 카드 제목 옆 `?` 도움말에 둡니다.
 */
export function CompanyProfilePage() {
  const vm = useCompanyProfileViewModel()
  const security = useAccountSecurityViewModel()
  const notifications = useNotificationSettingsViewModel()
  const planUsage = usePlanUsage()
  const {
    companyState,
    company,
    notice,
    summaryTags,
    completionPercent,
    checklist,
    basicFields,
    readOnlyFields,
    usageNotes,
    publicityRows,
  } = vm

  const showSkeleton = useDelayedFlag(vm.isLoading)

  // 옆 칸에 있던 안내는 관련 카드 제목 옆 ? 도움말로 옮겼습니다. 열어야 보이므로 본문 폭을 차지하지 않습니다.
  const usageHelp = (
    <HelpTip label="이 정보가 쓰이는 곳 도움말" title="이 정보가 쓰이는 곳">
      <div className={companyProfileStyles.usageList}>
        {usageNotes.map((note) => (
          <div className={companyProfileStyles.usageItem} key={note.title}>
            <span className={companyProfileStyles.usageIcon}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {usageIcons[note.icon]}
              </svg>
            </span>
            <span>
              <strong className={companyProfileStyles.usageTitle}>{note.title}</strong>
              <span className={companyProfileStyles.usageDescription}>{note.description}</span>
            </span>
          </div>
        ))}
      </div>
    </HelpTip>
  )
  const publicityHelp = (
    <HelpTip label="공개 범위 도움말" title="공개 범위">
      <table className={companyProfileStyles.publicityTable}>
        <thead>
          <tr>
            <th className={companyProfileStyles.publicityHeadCell}>항목</th>
            <th className={companyProfileStyles.publicityHeadCell}>모집·찾기</th>
            <th className={companyProfileStyles.publicityHeadCell}>제안 수락 후</th>
          </tr>
        </thead>
        <tbody>
          {publicityRows.map((row) => (
            <tr key={row.label}>
              <td className={companyProfileStyles.publicityCell}>{row.label}</td>
              <td className={row.beforeAccept ? companyProfileStyles.publicOpen : companyProfileStyles.publicClosed}>
                {row.beforeAccept ? '공개' : '비공개'}
              </td>
              <td className={row.afterAccept ? companyProfileStyles.publicOpen : companyProfileStyles.publicClosed}>
                {row.afterAccept ? '공개' : '비공개'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </HelpTip>
  )

  return (
    <>
      <WorkspacePageHeader
        title="내 프로필"
        actions={<span className={workspaceTagClassName('muted')}>프로필 완성도 {vm.isLoading ? '—' : `${completionPercent}%`}</span>}
      />

      <div className={workspacePageStyles.content}>
        {notice ? <p className={companyProfileStyles.notice} role="status">{notice}</p> : null}
        <div className={workspacePageStyles.column}>
            {vm.isLoading ? <>
              <p className="sr-only" role="status">기업 정보를 불러오는 중입니다.</p>
              <ProfileSkeleton part="summary" visible={showSkeleton} />
            </> : <section className={workspacePageStyles.card} aria-label="프로필 요약">
              <div className={companyProfileStyles.summaryTop}>
                <div className={companyProfileStyles.summaryIdentity}>
                  <span className={companyProfileStyles.summaryAvatar} aria-hidden="true">
                    {company === null ? '?' : companyInitial(company.companyName)}
                  </span>
                  <div>
                    <strong className={companyProfileStyles.summaryName}>
                      {company === null ? '기업 미등록' : company.companyName}
                    </strong>
                    <div className={companyProfileStyles.summaryTags}>
                      {summaryTags.map((tag) => (
                        <span className={workspaceTagClassName('ok')} key={tag}>
                          {tag}
                        </span>
                      ))}
                      {company === null ? (
                        <span className={workspaceTagClassName('muted')}>사업자등록번호 확인 전</span>
                      ) : (
                        <span className={workspaceTagClassName('muted')}>설립 {company.foundedYear}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className={companyProfileStyles.completion}>
                <div className={companyProfileStyles.completionRow}>
                  <span className={companyProfileStyles.completionLabel}>프로필 완성도</span>
                  <span className={companyProfileStyles.completionValue}>{completionPercent}%</span>
                </div>
                <div
                  className={companyProfileStyles.completionTrack}
                  role="progressbar"
                  aria-label="프로필 완성도"
                  aria-valuenow={completionPercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className={companyProfileStyles.completionBar}
                    style={{ width: `${completionPercent}%` }}
                  />
                </div>
                <span className={companyProfileStyles.completionHint}>
                  {company === null
                    ? '사업자등록번호를 조회해 등록하면 기업 회원이 되어 파트너 모집글을 작성할 수 있습니다.'
                    : '보유 역량과 우대 자격을 채우면 파트너 매칭 근거가 더 정확해집니다.'}
                </span>
                {/* 완성도를 이루는 네 항목입니다. 진행 막대 바로 아래에 두어 무엇이 남았는지 한눈에 보이게 합니다. */}
                <div className={companyProfileStyles.checklist} aria-label="완성도 체크리스트">
                  {checklist.map((item) => (
                    <div className={companyProfileStyles.checklistItem} key={item.label}>
                      {item.isDone ? (
                        <span className={companyProfileStyles.doneMark} aria-hidden="true">
                          <svg
                            width="11"
                            height="11"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        </span>
                      ) : (
                        <span className={companyProfileStyles.todoMark} aria-hidden="true" />
                      )}
                      <span className={item.isDone ? companyProfileStyles.doneLabel : companyProfileStyles.todoLabel}>
                        {item.label}
                        <span className="sr-only"> · {item.isDone ? '완료' : '미완료'}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </section>}

            {companyState.status === 'loading' ? <ProfileSkeleton part="company" visible={showSkeleton} /> : null}
            {companyState.status === 'error' ? (
              <section className={workspacePageStyles.card} aria-label="기업 정보 불러오기">
                <p className={workspacePageStyles.emptyNote} role="alert">기업 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
              </section>
            ) : null}
            {companyState.status === 'unregistered' ? <RegistrationCard vm={vm} titleHelp={usageHelp} /> : null}
            {company !== null && vm.isEditing ? (
              <section className={workspacePageStyles.card} aria-label="기업 기본정보 수정">
                <div className={workspacePageStyles.cardHeader}>
                  <div>
                    <div className={companyProfileStyles.titleRow}>
                      <h2 className={workspacePageStyles.cardTitle}>기업 기본정보 수정</h2>
                      {usageHelp}
                    </div>
                  </div>
                </div>
                <form className={companyProfileStyles.form} aria-label="기업 기본정보 수정" onSubmit={vm.submitUpdate} noValidate>
                  {/* 조회 값이라 바꿀 수 없는 항목은 보기 화면과 같은 모양으로 그대로 보여 줍니다. */}
                  <div className={companyProfileStyles.fieldGrid} role="group" aria-label="조회 값">
                    {readOnlyFields.map((field) => (
                      <div className={companyProfileStyles.field} key={field.label}>
                        <span className={companyProfileStyles.fieldLabel}>{field.label}</span>
                        <span className={companyProfileStyles.fieldValue}>
                          {field.value}
                          {field.tag ? <span className={workspaceTagClassName('ok')}>{field.tag}</span> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                  <ProfileFields vm={vm} idPrefix="edit" />
                  {vm.formErrors.form ? <p className={companyProfileStyles.formError} role="alert">{vm.formErrors.form}</p> : null}
                  <div className={companyProfileStyles.formActions}>
                    <button className={workspacePageStyles.secondaryButton} type="button" onClick={vm.cancelEditing} disabled={vm.isSaving}>
                      취소
                    </button>
                    <button className={workspacePageStyles.primaryButton} type="submit" disabled={vm.isSaving}>
                      {vm.isSaving ? '저장 중…' : '저장'}
                    </button>
                  </div>
                </form>
              </section>
            ) : null}
            {company !== null && !vm.isEditing ? (
              <section className={workspacePageStyles.card} aria-label="기업 기본정보">
                <div className={workspacePageStyles.cardHeader}>
                  <div className={companyProfileStyles.titleRow}>
                    <h2 className={workspacePageStyles.cardTitle}>기업 기본정보</h2>
                    {usageHelp}
                  </div>
                  <button className={workspacePageStyles.secondaryButton} type="button" onClick={vm.startEditing}>
                    수정
                  </button>
                </div>
                <div className={companyProfileStyles.fieldGrid}>
                  {basicFields.map((field) => (
                    <div
                      className={
                        field.value === null
                          ? companyProfileStyles.emptyField
                          : companyProfileStyles.field
                      }
                      key={field.label}
                    >
                      <span className={companyProfileStyles.fieldLabel}>
                        {field.label}
                        {field.isOptional ? (
                          <span className={companyProfileStyles.optionalMark}>선택</span>
                        ) : null}
                      </span>
                      {field.value === null ? (
                        <span className={companyProfileStyles.emptyValue}>미입력</span>
                      ) : (
                        <span className={companyProfileStyles.fieldValue}>
                          {field.value}
                          {field.tag ? (
                            <span className={workspaceTagClassName('ok')}>{field.tag}</span>
                          ) : null}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {vm.isLoading
              ? <ProfileSkeleton part="partner" visible={showSkeleton} />
              : <CompanyPartnerProfileSection vm={vm.partnerProfile} titleHelp={publicityHelp} />}

            <PlanUsageSection load={planUsage.load} onRetry={planUsage.reload} />

            <section className={workspacePageStyles.card} aria-label="계정과 알림">
              <h2 className={workspacePageStyles.cardTitle}>계정과 알림</h2>
              <div className="flex flex-col gap-2">
                <div className={companyProfileStyles.accountRow}>
                  <span className="min-w-0">
                    <span className={companyProfileStyles.accountLabel}>담당자</span>
                    <span className={companyProfileStyles.accountValue}>
                      {vm.account?.email ?? ''}
                    </span>
                  </span>
                  <span className={workspaceTagClassName(vm.account?.emailVerified ? 'ok' : 'warn')}>
                    {vm.account?.emailVerified ? '이메일 인증됨' : '이메일 미인증'}
                  </span>
                </div>

                {/* 소셜 로그인으로만 가입한 계정은 비밀번호가 없으므로 비밀번호 항목을 숨깁니다. */}
                {vm.account?.hasPassword === false ? null : (
                  <div className={companyProfileStyles.accountRow}>
                    <span className={companyProfileStyles.accountValue}>비밀번호</span>
                    <button className={workspacePageStyles.secondaryButton} type="button" onClick={security.password.open}>
                      변경
                    </button>
                  </div>
                )}
                {security.password.notice ? (
                  <p className={companyProfileStyles.notice} role="status">{security.password.notice}</p>
                ) : null}

                <NotificationSettingsRows vm={notifications} />
              </div>
              <div className={companyProfileStyles.dangerRow}>
                <button className={workspacePageStyles.dangerLink} type="button" onClick={security.deletion.open}>
                  계정 삭제
                </button>
              </div>
            </section>
            <ChangePasswordModal vm={security.password} />
            <DeleteAccountModal vm={security.deletion} email={vm.account?.email ?? ''} />
        </div>
      </div>
    </>
  )
}

type ViewModel = ReturnType<typeof useCompanyProfileViewModel>

/**
 * 기업이 없을 때 기본정보 카드 자리에 나오는 등록 폼입니다. 사업자등록번호 조회·결과 카드·입력 칸은 온보딩 2단계와 같은
 * shared/company 부품이고, 여기서는 카드 머리와 [기업 등록] 버튼만 둡니다. 폐업 사업자는 결과 카드가 이유를 말하고 버튼이 잠깁니다.
 */
function RegistrationCard({ vm, titleHelp }: { vm: ViewModel; titleHelp: ReactNode }) {
  return (
    <section className={workspacePageStyles.card} aria-label="기업 등록">
      <div className={workspacePageStyles.cardHeader}>
        <div>
          <div className={companyProfileStyles.titleRow}>
            <h2 className={workspacePageStyles.cardTitle}>기업 등록</h2>
            {titleHelp}
          </div>
          <p className={workspacePageStyles.cardDescription}>
            사업자등록번호를 조회하면 기업명과 사업자 상태가 채워집니다. 소재지·업종·설립연도는 직접 입력하고 홈페이지는 선택입니다.
          </p>
        </div>
      </div>
      <form className={companyProfileStyles.form} aria-label="기업 등록" onSubmit={vm.submitRegistration} noValidate>
        <BusinessNumberField
          id="register-businessNumber"
          value={vm.businessNumber}
          hint={vm.businessNumberHint}
          error={vm.formErrors.businessNumber}
          lookup={{ canLookup: vm.canLookup, isLooking: vm.isLooking, onLookup: () => void vm.lookupBusiness() }}
          onChange={vm.updateBusinessNumber}
        />
        {vm.lookup.status === 'found' ? <BusinessLookupResult business={vm.lookup.business} /> : null}
        {vm.lookup.status === 'failed' ? <p className={companyProfileStyles.formError} role="alert">{vm.lookup.message}</p> : null}

        <ProfileFields vm={vm} idPrefix="register" />
        {vm.formErrors.form ? <p className={companyProfileStyles.formError} role="alert">{vm.formErrors.form}</p> : null}
        <div className={companyProfileStyles.formActions}>
          <button className={workspacePageStyles.primaryButton} type="submit" disabled={vm.isSaving || !vm.canRegister}>
            {vm.isSaving ? '등록 중…' : '기업 등록'}
          </button>
        </div>
      </form>
    </section>
  )
}

/** 등록과 수정이 같은 입력 항목을 씁니다. 공용 칸에 ViewModel 값을 이어 주기만 합니다. */
function ProfileFields({ vm, idPrefix }: { vm: ViewModel; idPrefix: string }) {
  return (
    <CompanyProfileFields
      idPrefix={idPrefix}
      values={vm.form}
      errors={vm.formErrors}
      regions={vm.regions}
      industries={vm.industries}
      foundedYearMin={vm.foundedYearMin}
      currentYear={vm.currentYear}
      homepagePreview={vm.homepagePreview}
      focusField={vm.focusField}
      onFocused={vm.clearFocusField}
      onChange={vm.updateForm}
    />
  )
}
