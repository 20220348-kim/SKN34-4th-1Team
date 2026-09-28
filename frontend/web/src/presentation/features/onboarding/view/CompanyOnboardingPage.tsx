import { Navigate } from 'react-router'

import { BusinessLookupResult } from '../../../shared/company/BusinessLookupResult'
import { BusinessNumberField } from '../../../shared/company/BusinessNumberField'
import { CompanyProfileFields } from '../../../shared/company/CompanyProfileFields'
import { companyOnboardingMessages, useCompanyOnboardingViewModel } from '../viewmodel/useCompanyOnboardingViewModel'
import { onboardingStyles as s } from './Onboarding.styles'
import { OnboardingShell } from './OnboardingShell'

/**
 * 온보딩 2단계 · 기업 정보를 알려 주세요. 웹 화면 v2의 온보딩 2/2 보드를 따릅니다.
 * 흰 카드 하나 안에서 위에서 아래로 열립니다. 번호를 조회하기 전에는 정보 입력 폼이 보이지 않고, 조회 결과가 계속·휴업이면
 * 폼이 열립니다. 폐업은 결과 카드가 이유를 말하고 폼은 닫힌 채입니다. [나중에 하기]는 처음부터 끝까지 항상 보이고,
 * 좁은 화면은 홈페이지 칸이 "선택 항목 더 보기" 아래에 접힙니다.
 */
export function CompanyOnboardingPage() {
  const vm = useCompanyOnboardingViewModel()
  if (vm.redirectTo !== null) return <Navigate replace to={vm.redirectTo} />

  return (
    <form className="contents" aria-label="기업 등록" onSubmit={vm.submit} noValidate>
      <OnboardingShell
        titleId="welcome-company-title"
        steps={[{ label: '회원 유형', state: 'done' }, { label: '기업 정보', state: 'on' }]}
        foot={
          <>
            {vm.formErrors.form ? <span className={s.error} role="alert">{vm.formErrors.form}</span> : null}
            <button type="button" className={s.quiet} onClick={vm.skip} disabled={vm.isSaving}>나중에 하기</button>
            <button type="submit" className={s.primary} disabled={vm.isSaving || !vm.canRegister}>{vm.isSaving ? '등록 중…' : '등록하고 시작'}</button>
          </>
        }
      >
        <div className={s.heading}>
          <span className={s.eyebrow}>2 / 2</span>
          <h1 id="welcome-company-title" className={s.title}>기업 정보를 알려 주세요</h1>
          <p className={s.lead}>사업자등록번호로 조회하면 맞춤 추천과 파트너 매칭에 쓰여요. 나중에 프로필에서 등록해도 돼요.</p>
        </div>
        <div className={s.card}>
          <BusinessNumberField
            id="welcome-businessNumber"
            value={vm.businessNumber}
            hint={vm.businessNumberHint}
            error={vm.formErrors.businessNumber}
            required
            lookup={{ canLookup: vm.canLookup, isLooking: vm.isLooking, onLookup: vm.lookupBusiness, label: vm.lookup.status === 'found' ? '다시 조회' : '조회' }}
            onChange={vm.updateBusinessNumber}
          />
          {vm.lookup.status === 'found' ? <BusinessLookupResult business={vm.lookup.business} /> : null}
          {vm.lookup.status === 'failed' && vm.lookup.reason === 'unavailable' ? (
            <div className={s.unavailable} role="status" aria-label="조회 결과">
              <strong className={s.unavailableTitle}>{companyOnboardingMessages.lookupUnavailableTitle}</strong>
              <span className={s.unavailableBody}>{companyOnboardingMessages.lookupUnavailableBody}</span>
              <div className={s.unavailableActions}>
                <button type="button" className={s.secondarySmall} onClick={vm.lookupBusiness}>다시 시도</button>
              </div>
            </div>
          ) : null}
          {vm.canRegister ? (
            <CompanyProfileFields
              idPrefix="welcome"
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
              foldOptionalOnCompact
            />
          ) : null}
        </div>
      </OnboardingShell>
    </form>
  )
}
