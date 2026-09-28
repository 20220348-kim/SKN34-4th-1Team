import { type FormEvent, useEffect, useRef, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch } from '../../../../app/hooks'
import {
  type Company,
  companyIndustries,
  companyProfileLimits,
  companyRegions,
  formatBusinessNumber,
} from '../../../../domain/entities/Company'
import type {
  GetMyCompanyUseCase,
  LookupBusinessUseCase,
  RegisterCompanyUseCase,
  UpdateCompanyUseCase,
} from '../../../../domain/usecases/CompanyUseCases'
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
  toCompanyFormValues,
  validateCompanyForm,
} from '../../../shared/company/companyRegistrationForm'
import { useBusinessLookup } from '../../../shared/company/useBusinessLookup'
import { useCompanyPartnerProfileViewModel } from './useCompanyPartnerProfileViewModel'

export const companyProfileMessages = {
  ...companyFormMessages,
  registered: '기업을 등록했습니다. 이제 파트너 모집글을 작성할 수 있습니다.',
  registeredSuspended: '기업을 등록했습니다. 파트너 모집글과 제안은 사업을 다시 시작한 뒤 쓸 수 있습니다.',
} as const

/** 프로필을 얼마나 채웠는지 보여주는 항목입니다. 완성도는 이 목록에서 끝난 항목의 비율입니다. */
type ChecklistItem = { label: string; isDone: boolean }

type CompanyState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'unregistered' }
  | { status: 'registered'; company: Company }

type CompanyUseCases = {
  getMyCompany: Pick<GetMyCompanyUseCase, 'execute'>
  lookupBusiness: Pick<LookupBusinessUseCase, 'execute'>
  registerCompany: Pick<RegisterCompanyUseCase, 'execute'>
  updateCompany: Pick<UpdateCompanyUseCase, 'execute'>
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
 * 사업자번호 조회와 폼 검증은 온보딩 2단계와 같은 shared/company 부품을 씁니다. 알림 설정은 발송 기능이 없어 화면 상태로만 유지합니다.
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
  const businessLookup = useBusinessLookup(resolved.lookupBusiness)
  const [form, setForm] = useState<CompanyFormValues>(emptyCompanyForm)
  const [formErrors, setFormErrors] = useState<CompanyFormErrors>({})
  /** 검증에 실패했을 때 포커스를 옮길 첫 필드입니다. View가 옮긴 뒤 비웁니다. */
  const [focusField, setFocusField] = useState<CompanyFormField | null>(null)
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
          setForm(toCompanyFormValues(company))
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
    setFormErrors({})
    const result = await businessLookup.lookupBusiness()
    if (result.outcome === 'invalid') {
      setFormErrors({ businessNumber: companyProfileMessages.businessNumberInvalid })
      setFocusField('businessNumber')
    }
  }

  /** 모든 필드를 한 번에 검사해 문구를 모으고, 첫 오류 필드로 포커스를 보냅니다. */
  function validateForm() {
    const result = validateCompanyForm(form, currentYear)
    setFormErrors(result.errors)
    if (result.firstError !== null) setFocusField(result.firstError)
    return result.input
  }

  async function submitRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSaving || account === null) return
    const { lookup } = businessLookup
    if (lookup.status !== 'found') {
      setFormErrors({ businessNumber: companyProfileMessages.lookupRequired })
      setFocusField('businessNumber')
      return
    }
    if (!canRegisterBusiness(lookup.business)) {
      setFormErrors({ businessNumber: companyProfileMessages.businessClosed(lookup.business.businessStatus) })
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
        setForm(toCompanyFormValues(result.company))
        setNotice(result.company.businessStatusCode === '01' ? companyProfileMessages.registered : companyProfileMessages.registeredSuspended)
        dispatchToStore(signedIn(accountWithCompany(account, result.company)))
        return
      }
      const failure = registerFailure(result)
      setFormErrors({ [failure.field]: failure.message })
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
      setForm(toCompanyFormValues(company))
      setIsEditing(false)
    } catch {
      if (isMounted.current) setFormErrors({ form: companyProfileMessages.saveFailed })
    } finally {
      if (isMounted.current) setIsSaving(false)
    }
  }

  function startEditing() {
    if (companyState.status === 'registered') setForm(toCompanyFormValues(companyState.company))
    setFormErrors({})
    setNotice(null)
    setIsEditing(true)
  }

  function cancelEditing() {
    if (companyState.status === 'registered') setForm(toCompanyFormValues(companyState.company))
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

  const { lookup } = businessLookup
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
    businessNumber: businessLookup.businessNumber,
    /** 입력 중 하이픈을 붙이고, 번호가 바뀌면 이전 조회 결과와 오류는 버립니다. */
    updateBusinessNumber: (value: string) => {
      businessLookup.updateBusinessNumber(value)
      setFormErrors({})
    },
    canLookup: businessLookup.canLookup,
    isLooking: businessLookup.isLooking,
    businessNumberHint: companyProfileMessages.businessNumberHint,
    lookup,
    lookupBusiness,
    /** 조회한 사업자를 등록할 수 있을 때만 [기업 등록]을 누를 수 있습니다. 폐업은 조회 결과 카드가 이유를 말합니다. */
    canRegister: lookup.status === 'found' && canRegisterBusiness(lookup.business),
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
