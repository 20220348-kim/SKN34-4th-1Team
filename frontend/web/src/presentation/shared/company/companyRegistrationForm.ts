import type { Account } from '../../../domain/entities/Account'
import {
  type BusinessLookup,
  type BusinessStatusCode,
  type Company,
  type CompanyProfileInput,
  companyProfileLimits,
  isValidHomepageUrl,
  normalizeHomepageUrl,
} from '../../../domain/entities/Company'
import type { RegisterCompanyUseCase } from '../../../domain/usecases/CompanyUseCases'

/**
 * 기업 등록 폼의 값·검증·문구입니다. 프로필의 등록·수정 폼과 온보딩 2단계가 같은 규칙을 씁니다.
 * 상호·사업자 상태는 조회 결과라 여기 없고, 담당자가 적는 네 항목만 다룹니다.
 */
export type CompanyFormValues = {
  region: string
  industry: string
  foundedYear: string
  homepageUrl: string
}

export type CompanyFormField = keyof CompanyFormValues | 'businessNumber'

/** 필드마다 문구를 두고, 특정 필드에 묶이지 않는 저장 실패는 `form`에 둡니다. */
export type CompanyFormErrors = Partial<Record<CompanyFormField | 'form', string>>

export const emptyCompanyForm: CompanyFormValues = { region: '', industry: '', foundedYear: '', homepageUrl: '' }

export const companyFormMessages = {
  businessNumberInvalid: '사업자등록번호는 숫자 10자리로 입력해 주세요.',
  businessNumberHint: '숫자만 입력해도 하이픈이 자동으로 붙습니다. 10자리를 채우면 조회할 수 있습니다.',
  businessNotFound: '국세청에 등록되지 않은 번호예요. 숫자 10자리를 다시 확인해 주세요.',
  businessClosed: (status: string | null) =>
    status === null ? '폐업한 사업자는 등록할 수 없어요.' : `${status} 상태의 사업자는 등록할 수 없어요.`,
  lookupUnavailable: '지금은 조회가 되지 않아요. 잠시 후 다시 시도해 주세요.',
  lookupRequired: '사업자등록번호를 먼저 조회해 주세요.',
  businessNumberTaken: '이 사업자는 다른 계정에 등록돼 있어요. 담당자가 바뀌었다면 알려 주세요.',
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
} as const

/** 조회 결과 카드에 붙는 상태별 안내입니다. 내부 코드 대신 무엇을 할 수 있는지로 말합니다. */
export const businessStatusNotes: Record<BusinessStatusCode, string> = {
  '01': '국세청 등록 정보로 확인했어요. 상호는 바꿀 수 없고, 아래 정보만 적어 주세요.',
  '02': '등록은 할 수 있어요. 파트너 모집글과 제안은 사업을 다시 시작한 뒤 쓸 수 있어요.',
  '03': '폐업한 사업자는 등록할 수 없어요. 다른 번호를 조회하거나 개인 회원으로 이용해 주세요.',
}

/** 상태 배지 색입니다. 계속은 녹색, 휴업은 주의, 폐업은 위험. */
export function businessStatusTone(code: BusinessStatusCode): 'ok' | 'warn' | 'danger' {
  return code === '01' ? 'ok' : code === '02' ? 'warn' : 'danger'
}

export function toCompanyFormValues(company: Company): CompanyFormValues {
  return {
    region: company.region,
    industry: company.industry,
    foundedYear: String(company.foundedYear),
    homepageUrl: company.homepageUrl ?? '',
  }
}

/** 네 항목을 한 번에 검사합니다. 오류가 있으면 문구와 첫 오류 필드를, 없으면 서버에 보낼 입력을 돌려줍니다. */
export function validateCompanyForm(form: CompanyFormValues, currentYear: number):
  | { errors: CompanyFormErrors; firstError: keyof CompanyFormValues; input: null }
  | { errors: CompanyFormErrors; firstError: null; input: CompanyProfileInput } {
  const errors: CompanyFormErrors = {}
  if (!form.region) errors.region = companyFormMessages.regionRequired
  if (!form.industry) errors.industry = companyFormMessages.industryRequired
  const foundedYear = Number(form.foundedYear)
  if (form.foundedYear === '') {
    errors.foundedYear = companyFormMessages.foundedYearRequired
  } else if (!/^\d{4}$/.test(form.foundedYear) || foundedYear < companyProfileLimits.foundedYearMin || foundedYear > currentYear) {
    errors.foundedYear = companyFormMessages.foundedYearInvalid(currentYear)
  }
  const homepageUrl = normalizeHomepageUrl(form.homepageUrl)
  if (homepageUrl !== '') {
    if (homepageUrl.length > companyProfileLimits.homepageMaxLength) errors.homepageUrl = companyFormMessages.homepageTooLong
    else if (!isValidHomepageUrl(homepageUrl)) errors.homepageUrl = companyFormMessages.homepageInvalid
  }
  const firstError = (['region', 'industry', 'foundedYear', 'homepageUrl'] as const).find((field) => errors[field] !== undefined)
  if (firstError !== undefined) return { errors, firstError, input: null }
  return {
    errors,
    firstError: null,
    input: { region: form.region, industry: form.industry, foundedYear, homepageUrl: homepageUrl === '' ? null : homepageUrl },
  }
}

/** 스킴 없이 적은 주소는 저장 시 https://가 붙는다는 것을 미리 보여 줍니다. */
export function homepagePreviewFor(form: CompanyFormValues): string | null {
  const normalized = normalizeHomepageUrl(form.homepageUrl)
  return normalized !== '' && normalized !== form.homepageUrl.trim() && isValidHomepageUrl(normalized)
    ? companyFormMessages.homepagePreview(normalized)
    : null
}

export type RegisterCompanyFailure = Exclude<Awaited<ReturnType<RegisterCompanyUseCase['execute']>>, { outcome: 'registered' }>

/** 등록 실패를 어느 칸에 어떤 문구로 보여 줄지입니다. 번호 문제는 번호 칸, 나머지는 폼 아래. */
export function registerFailure(result: RegisterCompanyFailure): { field: 'businessNumber' | 'form'; message: string } {
  switch (result.outcome) {
    case 'business-not-found':
      return { field: 'businessNumber', message: companyFormMessages.businessNotFound }
    case 'business-not-active':
      return { field: 'businessNumber', message: companyFormMessages.businessClosed(result.businessStatus) }
    case 'business-number-taken':
      return { field: 'businessNumber', message: companyFormMessages.businessNumberTaken }
    case 'already-registered':
      return { field: 'form', message: companyFormMessages.alreadyRegistered }
    case 'lookup-unavailable':
      return { field: 'form', message: companyFormMessages.lookupUnavailable }
  }
}

/** 등록에 성공한 뒤 세션 계정을 기업 회원으로 갱신합니다. 사이드바·파트너 화면이 이 요약으로 상호와 잠금 이유를 정합니다. */
export function accountWithCompany(account: Account, company: Company): Account {
  return {
    ...account,
    tier: account.tier === 'ADMIN' ? 'ADMIN' : 'COMPANY',
    company: { companyName: company.companyName, businessNumber: company.businessNumber, businessStatusCode: company.businessStatusCode },
  }
}

/** 조회한 사업자를 등록할 수 있는지입니다. 계속·휴업은 되고 폐업은 안 됩니다. */
export function canRegisterBusiness(business: BusinessLookup): boolean {
  return business.canRegister
}
