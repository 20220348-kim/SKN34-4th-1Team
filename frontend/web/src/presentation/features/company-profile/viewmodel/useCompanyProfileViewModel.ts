import { type FormEvent, useEffect, useRef, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch } from '../../../../app/hooks'
import type { Account } from '../../../../domain/entities/Account'
import {
  type BusinessLookup,
  type Company,
  type CompanyProfileInput,
  companyIndustries,
  companyProfileLimits,
  companyRegions,
  formatBusinessNumber,
  formatBusinessNumberInput,
  isValidBusinessNumber,
  isValidHomepageUrl,
  normalizeHomepageUrl,
} from '../../../../domain/entities/Company'
import type {
  GetMyCompanyUseCase,
  LookupBusinessUseCase,
  RegisterCompanyUseCase,
  UpdateCompanyUseCase,
} from '../../../../domain/usecases/CompanyUseCases'
import { useAuthSession } from '../../../shared/auth/hooks/useAuthSession'
import { signedIn } from '../../../shared/auth/state/authSlice'
import { useCompanyPartnerProfileViewModel } from './useCompanyPartnerProfileViewModel'

export const companyProfileMessages = {
  businessNumberInvalid: '사업자등록번호는 숫자 10자리로 입력해 주세요.',
  businessNumberHint: '숫자만 입력해도 하이픈이 자동으로 붙습니다. 10자리를 채우면 조회할 수 있습니다.',
  businessNotFound: '등록되지 않은 사업자등록번호입니다.',
  businessNotActive: (status: string | null) =>
    status === null ? '휴업·폐업 사업자는 등록할 수 없습니다.' : `${status} 상태의 사업자는 등록할 수 없습니다.`,
  lookupUnavailable: '사업자등록번호 조회가 지금은 되지 않습니다. 잠시 후 다시 시도해 주세요.',
  lookupRequired: '사업자등록번호를 먼저 조회해 주세요.',
  businessNumberTaken: '다른 계정이 이미 등록한 사업자등록번호입니다.',
  alreadyRegistered: '이 계정에는 이미 기업이 등록되어 있습니다. 화면을 새로고침해 주세요.',
  regionRequired: '소재지를 선택해 주세요.',
  industryRequired: '업종을 선택해 주세요.',
  foundedYearRequired: '설립연도를 선택해 주세요.',
  foundedYearInvalid: (maxYear: number) =>
    `설립연도는 ${companyProfileLimits.foundedYearMin}년부터 ${maxYear}년까지 고를 수 있습니다.`,
  homepageInvalid: 'https://로 시작하는 주소를 입력해 주세요. 예: https://company.co.kr',
  homepageTooLong: `홈페이지 주소는 ${companyProfileLimits.homepageMaxLength}자 이하로 입력해 주세요.`,
  homepagePreview: (url: string) => `${url} 로 저장됩니다.`,
  saveFailed: '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  registered: '기업을 등록했습니다. 이제 파트너 모집글을 작성할 수 있습니다.',
} as const

/** 프로필을 얼마나 채웠는지 보여주는 항목입니다. 완성도는 이 목록에서 끝난 항목의 비율입니다. */
type ChecklistItem = { label: string; isDone: boolean }

type CompanyState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'unregistered' }
  | { status: 'registered'; company: Company }

type LookupState =
  | { status: 'idle' }
  | { status: 'looking' }
  | { status: 'found'; business: BusinessLookup }
  | { status: 'failed'; message: string }

export type ProfileFormValues = {
  region: string
  industry: string
  foundedYear: string
  homepageUrl: string
}

export type ProfileFormField = keyof ProfileFormValues | 'businessNumber'

/** 필드마다 문구를 두고, 특정 필드에 묶이지 않는 저장 실패는 `form`에 둡니다. */
export type ProfileFormErrors = Partial<Record<ProfileFormField | 'form', string>>

type CompanyUseCases = {
  getMyCompany: Pick<GetMyCompanyUseCase, 'execute'>
  lookupBusiness: Pick<LookupBusinessUseCase, 'execute'>
  registerCompany: Pick<RegisterCompanyUseCase, 'execute'>
  updateCompany: Pick<UpdateCompanyUseCase, 'execute'>
}

const emptyForm: ProfileFormValues = {
  region: '',
  industry: '',
  foundedYear: '',
  homepageUrl: '',
}

/** 프로필 화면의 알림 설정입니다. 서버 저장 API가 생기면 그 응답으로 초기화합니다. */
export type NotificationSettings = {
  savedProgramDeadline: boolean
  partnerProposal: boolean
  newMatchingProgram: boolean
}

export type NotificationKey = keyof NotificationSettings

export const defaultNotificationSettings: NotificationSettings = {
  savedProgramDeadline: true,
  partnerProposal: true,
  newMatchingProgram: false,
}

/**
 * 기업 프로필의 대표 ViewModel입니다. 기업 기본정보는 API에서 읽어 등록·수정 폼과 완성도를 계산하고,
 * 협업·파트너 설정은 [useCompanyPartnerProfileViewModel]이 맡으며 완성도에는 저장 여부만 씁니다.
 * 알림 설정은 발송 기능이 없어 화면 상태로만 유지합니다.
 */
export function useCompanyProfileViewModel(useCases: Partial<CompanyUseCases> = {}) {
  const resolved: CompanyUseCases = {
    getMyCompany: useCases.getMyCompany ?? appContainer.resolve('getMyCompanyUseCase'),
    lookupBusiness: useCases.lookupBusiness ?? appContainer.resolve('lookupBusinessUseCase'),
    registerCompany: useCases.registerCompany ?? appContainer.resolve('registerCompanyUseCase'),
    updateCompany: useCases.updateCompany ?? appContainer.resolve('updateCompanyUseCase'),
  }
  const { account } = useAuthSession()
  const dispatchToStore = useAppDispatch()
  const isMounted = useRef(true)
  const currentYear = new Date().getFullYear()

  const [companyState, setCompanyState] = useState<CompanyState>({ status: 'loading' })
  const [businessNumber, setBusinessNumber] = useState('')
  const [lookup, setLookup] = useState<LookupState>({ status: 'idle' })
  const [form, setForm] = useState<ProfileFormValues>(emptyForm)
  const [formErrors, setFormErrors] = useState<ProfileFormErrors>({})
  /** 검증에 실패했을 때 포커스를 옮길 첫 필드입니다. View가 옮긴 뒤 비웁니다. */
  const [focusField, setFocusField] = useState<ProfileFormField | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // 알림 발송 기능이 아직 없어 설정은 화면 상태로만 두고, 화면을 나가면 초기값으로 돌아갑니다.
  const [notifications, setNotifications] = useState<NotificationSettings>(defaultNotificationSettings)

  // 협업·파트너 설정은 기업이 등록된 뒤에만 읽고, 완성도 계산에 저장 여부만 씁니다.
  const partnerProfile = useCompanyPartnerProfileViewModel(companyState.status === 'registered')

  useEffect(() => {
    isMounted.current = true
    const controller = new AbortController()
    resolved.getMyCompany.execute(controller.signal)
      .then((company) => {
        if (!isMounted.current) return
        if (company === null) {
          setCompanyState({ status: 'unregistered' })
        } else {
          setCompanyState({ status: 'registered', company })
          setForm(toFormValues(company))
        }
      })
      .catch(() => {
        if (isMounted.current) setCompanyState({ status: 'error' })
      })
    return () => {
      isMounted.current = false
      controller.abort()
    }
    // 화면에 들어올 때 한 번만 불러오고, 이후 변경은 저장 응답으로 반영합니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function lookupBusiness() {
    if (lookup.status === 'looking') return
    if (!isValidBusinessNumber(businessNumber)) {
      setFormErrors({ businessNumber: companyProfileMessages.businessNumberInvalid })
      setFocusField('businessNumber')
      return
    }
    setFormErrors({})
    setLookup({ status: 'looking' })
    try {
      const result = await resolved.lookupBusiness.execute(businessNumber)
      if (!isMounted.current) return
      if (result.outcome === 'found') {
        setLookup({ status: 'found', business: result.business })
        return
      }
      setLookup({
        status: 'failed',
        message: result.outcome === 'not-found'
          ? companyProfileMessages.businessNotFound
          : companyProfileMessages.lookupUnavailable,
      })
    } catch {
      if (isMounted.current) setLookup({ status: 'failed', message: companyProfileMessages.lookupUnavailable })
    }
  }

  /** 모든 필드를 한 번에 검사해 문구를 모으고, 첫 오류 필드로 포커스를 보냅니다. */
  function validateForm(): CompanyProfileInput | null {
    const errors: ProfileFormErrors = {}
    if (!form.region) errors.region = companyProfileMessages.regionRequired
    if (!form.industry) errors.industry = companyProfileMessages.industryRequired
    const foundedYear = Number(form.foundedYear)
    if (form.foundedYear === '') {
      errors.foundedYear = companyProfileMessages.foundedYearRequired
    } else if (!/^\d{4}$/.test(form.foundedYear) || foundedYear < companyProfileLimits.foundedYearMin || foundedYear > currentYear) {
      errors.foundedYear = companyProfileMessages.foundedYearInvalid(currentYear)
    }
    const homepageUrl = normalizeHomepageUrl(form.homepageUrl)
    if (homepageUrl !== '') {
      if (homepageUrl.length > companyProfileLimits.homepageMaxLength) errors.homepageUrl = companyProfileMessages.homepageTooLong
      else if (!isValidHomepageUrl(homepageUrl)) errors.homepageUrl = companyProfileMessages.homepageInvalid
    }

    setFormErrors(errors)
    const firstError = (['region', 'industry', 'foundedYear', 'homepageUrl'] as const).find((field) => errors[field] !== undefined)
    if (firstError !== undefined) {
      setFocusField(firstError)
      return null
    }
    return {
      region: form.region,
      industry: form.industry,
      foundedYear,
      homepageUrl: homepageUrl === '' ? null : homepageUrl,
    }
  }

  async function submitRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSaving || account === null) return
    if (lookup.status !== 'found') {
      setFormErrors({ businessNumber: companyProfileMessages.lookupRequired })
      setFocusField('businessNumber')
      return
    }
    const input = validateForm()
    if (input === null) return

    setIsSaving(true)
    setNotice(null)
    try {
      const result = await resolved.registerCompany.execute(lookup.business.businessNumber, input)
      if (!isMounted.current) return
      if (result.outcome === 'registered') {
        setCompanyState({ status: 'registered', company: result.company })
        setForm(toFormValues(result.company))
        setNotice(companyProfileMessages.registered)
        dispatchToStore(signedIn(withCompany(account, result.company)))
        return
      }
      const isBusinessProblem = result.outcome === 'business-not-found' || result.outcome === 'business-not-active'
      setFormErrors({ [isBusinessProblem ? 'businessNumber' : 'form']: registerFailureMessage(result) })
    } catch {
      if (isMounted.current) setFormErrors({ form: companyProfileMessages.saveFailed })
    } finally {
      if (isMounted.current) setIsSaving(false)
    }
  }

  async function submitUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSaving) return
    const input = validateForm()
    if (input === null) return

    setIsSaving(true)
    setNotice(null)
    try {
      const company = await resolved.updateCompany.execute(input)
      if (!isMounted.current) return
      setCompanyState({ status: 'registered', company })
      setForm(toFormValues(company))
      setIsEditing(false)
    } catch {
      if (isMounted.current) setFormErrors({ form: companyProfileMessages.saveFailed })
    } finally {
      if (isMounted.current) setIsSaving(false)
    }
  }

  function startEditing() {
    if (companyState.status === 'registered') setForm(toFormValues(companyState.company))
    setFormErrors({})
    setNotice(null)
    setIsEditing(true)
  }

  function cancelEditing() {
    if (companyState.status === 'registered') setForm(toFormValues(companyState.company))
    setFormErrors({})
    setIsEditing(false)
  }

  const company = companyState.status === 'registered' ? companyState.company : null
  const checklist: ChecklistItem[] = [
    { label: '사업자등록번호 확인과 기업 기본정보', isDone: company !== null },
    { label: '이메일 인증', isDone: account?.emailVerified ?? false },
    { label: '협업·파트너 설정', isDone: partnerProfile.isSet },
  ]
  const completionPercent = Math.round(
    (checklist.filter((item) => item.isDone).length / checklist.length) * 100,
  )

  function toggleNotification(key: NotificationKey) {
    setNotifications({ ...notifications, [key]: !notifications[key] })
  }

  return {
    account,
    companyState,
    company,
    partnerProfile,
    notice,
    notifications,
    toggleNotification,
    summaryTags: company === null ? [] : [company.region, company.industry, company.businessStatus],
    completionPercent,
    checklist,
    /** 조회로 채워져 수정 폼에서 바꿀 수 없는 항목입니다. 수정 폼이 입력란 위에 그대로 보여 줍니다. */
    readOnlyFields: company === null ? [] : [
      { label: '기업명', value: company.companyName, tag: '사업자 확인' },
      { label: '사업자등록번호', value: formatBusinessNumber(company.businessNumber) },
      { label: '사업자 상태', value: company.businessStatus },
    ],
    basicFields: company === null ? [] : [
      { label: '기업명', value: company.companyName, tag: '사업자 확인' },
      { label: '사업자등록번호', value: formatBusinessNumber(company.businessNumber) },
      { label: '사업자 상태', value: company.businessStatus },
      { label: '소재지', value: company.region },
      { label: '업종', value: company.industry },
      { label: '설립연도', value: String(company.foundedYear) },
      { label: '홈페이지', value: company.homepageUrl, isOptional: true },
    ],
    regions: companyRegions,
    industries: companyIndustries,
    currentYear,
    foundedYearMin: companyProfileLimits.foundedYearMin,
    businessNumber,
    /** 입력 중 하이픈을 붙이고, 번호가 바뀌면 이전 조회 결과는 버립니다. */
    updateBusinessNumber: (value: string) => {
      setBusinessNumber(formatBusinessNumberInput(value))
      setLookup({ status: 'idle' })
      setFormErrors({})
    },
    canLookup: isValidBusinessNumber(businessNumber) && lookup.status !== 'looking',
    businessNumberHint: companyProfileMessages.businessNumberHint,
    lookup,
    lookupBusiness,
    form,
    updateForm: (field: keyof ProfileFormValues, value: string) => {
      setForm((current) => ({ ...current, [field]: value }))
      setFormErrors((current) => {
        const { [field]: _removed, form: _form, ...rest } = current
        return rest
      })
    },
    formErrors,
    focusField,
    clearFocusField: () => setFocusField(null),
    /** 스킴 없이 적은 주소는 저장 시 https://가 붙는다는 것을 미리 보여 줍니다. */
    homepagePreview: (() => {
      const normalized = normalizeHomepageUrl(form.homepageUrl)
      return normalized !== '' && normalized !== form.homepageUrl.trim() && isValidHomepageUrl(normalized)
        ? companyProfileMessages.homepagePreview(normalized)
        : null
    })(),
    isEditing,
    isSaving,
    startEditing,
    cancelEditing,
    submitRegistration,
    submitUpdate,
    // 이 정보가 어디에 쓰이는지 화면에서 밝혀 두면 무엇을 채울지 판단하기 쉬워집니다.
    usageNotes: [
      {
        icon: 'target' as const,
        title: '맞춤 추천',
        description: '지역·업종·업력이 추천 점수의 대상 적합도와 지역 적합도 근거가 됩니다.',
      },
      {
        icon: 'users' as const,
        title: '파트너 매칭',
        description:
          '역할·관심 분야·보유 역량을 모집 조건과 비교해 일치와 확인 필요를 나눠 보여줍니다.',
      },
      {
        icon: 'shield' as const,
        title: '신뢰 표시',
        description: '사업자등록번호 조회로 확인한 기업명과 사업자 상태, 이메일 인증 여부가 모집글에 표시됩니다.',
      },
    ],
    // 담당자 정보는 제안을 수락한 뒤에만 상대에게 보입니다.
    publicityRows: [
      { label: '기업명·지역·업종', beforeAccept: true, afterAccept: true },
      { label: '역할·관심 분야·보유 역량·소개', beforeAccept: true, afterAccept: true },
      { label: '담당자 이메일', beforeAccept: false, afterAccept: true },
    ],
  }
}

function toFormValues(company: Company): ProfileFormValues {
  return {
    region: company.region,
    industry: company.industry,
    foundedYear: String(company.foundedYear),
    homepageUrl: company.homepageUrl ?? '',
  }
}

function withCompany(account: Account, company: Company): Account {
  return {
    ...account,
    tier: account.tier === 'ADMIN' ? 'ADMIN' : 'COMPANY',
    company: { companyName: company.companyName, businessNumber: company.businessNumber },
  }
}

function registerFailureMessage(
  result: Exclude<Awaited<ReturnType<RegisterCompanyUseCase['execute']>>, { outcome: 'registered' }>,
): string {
  switch (result.outcome) {
    case 'business-not-found':
      return companyProfileMessages.businessNotFound
    case 'business-not-active':
      return companyProfileMessages.businessNotActive(result.businessStatus)
    case 'business-number-taken':
      return companyProfileMessages.businessNumberTaken
    case 'already-registered':
      return companyProfileMessages.alreadyRegistered
    case 'lookup-unavailable':
      return companyProfileMessages.lookupUnavailable
  }
}
