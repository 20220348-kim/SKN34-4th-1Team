import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch } from '../../../../app/hooks'
import { companyIndustries, companyProfileLimits, companyRegions } from '../../../../domain/entities/Company'
import type { LookupBusinessUseCase, RegisterCompanyUseCase } from '../../../../domain/usecases/CompanyUseCases'
import { useAuthSession } from '../../../shared/auth/hooks/useAuthSession'
import { signedIn } from '../../../shared/auth/state/authSlice'
import {
  type CompanyFormErrors,
  type CompanyFormField,
  type CompanyFormValues,
  accountWithCompany,
  canRegisterBusiness,
  companyFormMessages,
  emptyCompanyForm,
  homepagePreviewFor,
  registerFailure,
  validateCompanyForm,
} from '../../../shared/company/companyRegistrationForm'
import { useBusinessLookup } from '../../../shared/company/useBusinessLookup'
import { appPaths } from '../../../shared/routes/appPaths'

export const companyOnboardingMessages = {
  ...companyFormMessages,
  lookupUnavailableTitle: '지금은 조회가 되지 않아요',
  lookupUnavailableBody: '잠시 후 다시 시도하거나, 건너뛰고 프로필에서 나중에 등록할 수 있어요.',
  registerFailed: '기업을 등록하지 못했습니다. 입력한 내용은 그대로 있어요. 잠시 후 다시 시도해 주세요.',
} as const

type CompanyUseCases = {
  lookupBusiness: Pick<LookupBusinessUseCase, 'execute'>
  registerCompany: Pick<RegisterCompanyUseCase, 'execute'>
}

/**
 * 온보딩 2단계(기업 등록)입니다. 1단계에서 기업 회원을 고른 뒤 사업자등록번호를 조회하고 소재지·업종·설립연도를 적어
 * 등록합니다. 건너뛸 수 있고([나중에 하기]), 그러면 프로필의 "기업 등록" 카드가 이어받습니다.
 * 조회·검증·문구는 프로필과 같은 shared/company 부품을 쓰고, 이 화면만의 판단은 언제 폼을 여는지와 어디로 갈지입니다.
 * 개인 회원이거나 이미 기업이 있는 계정에는 의미가 없어 `redirectTo`로 검색·프로필로 보냅니다.
 */
export function useCompanyOnboardingViewModel(useCases: Partial<CompanyUseCases> = {}) {
  const resolved: CompanyUseCases = {
    lookupBusiness: useCases.lookupBusiness ?? appContainer.resolve('lookupBusinessUseCase'),
    registerCompany: useCases.registerCompany ?? appContainer.resolve('registerCompanyUseCase'),
  }
  const { account } = useAuthSession()
  const navigate = useNavigate()
  const dispatchToStore = useAppDispatch()
  const isMounted = useRef(true)
  // 등록에 성공해 세션 계정에 기업이 생기는 순간, 아래 redirectTo가 프로필로 보내지 않도록 떠나는 중임을 기억합니다.
  const isLeaving = useRef(false)
  const currentYear = new Date().getFullYear()

  const businessLookup = useBusinessLookup(resolved.lookupBusiness)
  const [form, setForm] = useState<CompanyFormValues>(emptyCompanyForm)
  const [formErrors, setFormErrors] = useState<CompanyFormErrors>({})
  const [focusField, setFocusField] = useState<CompanyFormField | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  const { lookup } = businessLookup
  const canRegister = lookup.status === 'found' && canRegisterBusiness(lookup.business)

  async function lookupBusiness() {
    setFormErrors({})
    const result = await businessLookup.lookupBusiness()
    if (!isMounted.current) return
    if (result.outcome === 'invalid') {
      setFormErrors({ businessNumber: companyOnboardingMessages.businessNumberInvalid })
      setFocusField('businessNumber')
    } else if (result.outcome === 'failed' && result.reason === 'not-found') {
      // 미등록 번호는 입력 칸 오류로 보여 줍니다. 조회 불가는 카드로 안내합니다.
      setFormErrors({ businessNumber: result.message })
      setFocusField('businessNumber')
    }
  }

  async function register() {
    if (account === null || lookup.status !== 'found' || !canRegister) return
    const validation = validateCompanyForm(form, currentYear)
    setFormErrors(validation.errors)
    if (validation.firstError !== null) {
      setFocusField(validation.firstError)
      return
    }
    setIsSaving(true)
    try {
      const result = await resolved.registerCompany.execute(lookup.business.businessNumber, validation.input)
      if (!isMounted.current) return
      if (result.outcome === 'registered') {
        isLeaving.current = true
        dispatchToStore(signedIn(accountWithCompany(account, result.company)))
        navigate(appPaths.chat, { replace: true })
        return
      }
      const failure = registerFailure(result)
      setFormErrors({ [failure.field]: failure.message })
      if (failure.field === 'businessNumber') setFocusField('businessNumber')
    } catch {
      if (isMounted.current) setFormErrors({ form: companyOnboardingMessages.registerFailed })
    } finally {
      if (isMounted.current) setIsSaving(false)
    }
  }

  /** Enter는 조회 전엔 조회, 폼이 열린 뒤엔 등록입니다. */
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSaving) return
    if (lookup.status !== 'found') {
      void lookupBusiness()
      return
    }
    void register()
  }

  return {
    /** 이 화면이 맞지 않는 계정이 갈 곳입니다. 개인 회원은 검색, 기업이 이미 있으면 프로필. */
    redirectTo: account === null || isLeaving.current ? null : account.company !== null ? appPaths.profile : account.accountType !== 'BUSINESS' ? appPaths.chat : null,
    businessNumber: businessLookup.businessNumber,
    updateBusinessNumber: (value: string) => {
      businessLookup.updateBusinessNumber(value)
      setFormErrors({})
    },
    businessNumberHint: companyOnboardingMessages.businessNumberHint,
    canLookup: businessLookup.canLookup,
    isLooking: businessLookup.isLooking,
    lookup,
    lookupBusiness: () => void lookupBusiness(),
    /** 조회 결과가 계속·휴업일 때만 정보 입력 폼이 열리고 [등록하고 시작]을 누를 수 있습니다. */
    canRegister,
    form,
    updateForm: (field: keyof CompanyFormValues, value: string) => {
      setForm((current) => ({ ...current, [field]: value }))
      setFormErrors((current) => {
        const { [field]: _removed, form: _form, ...rest } = current
        return rest
      })
    },
    formErrors,
    focusField,
    clearFocusField: () => setFocusField(null),
    homepagePreview: homepagePreviewFor(form),
    regions: companyRegions,
    industries: companyIndustries,
    currentYear,
    foundedYearMin: companyProfileLimits.foundedYearMin,
    isSaving,
    submit,
    /** 확인 없이 검색 화면으로 갑니다. 저장되는 것은 없고, 프로필의 기업 등록 카드가 이어받습니다. */
    skip: () => navigate(appPaths.chat, { replace: true }),
  }
}
