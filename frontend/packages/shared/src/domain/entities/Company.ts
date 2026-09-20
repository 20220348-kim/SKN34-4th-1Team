/**
 * 계정에 등록한 기업입니다. 상호·사업자 상태는 조회 결과라 화면에서 고칠 수 없고,
 * 소재지·업종·설립연도와 홈페이지(선택)만 담당자가 입력합니다. GovBiz는 자격을 판정하지 않습니다.
 */
export type Company = {
  businessNumber: string
  companyName: string
  businessStatus: string
  region: string
  industry: string
  foundedYear: number
  homepageUrl: string | null
  businessVerifiedAt: string
  updatedAt: string
}

/** 등록 전 미리보기입니다. 조회로 받은 상호·상태만 있고 소재지·업종은 없습니다. */
export type BusinessLookup = {
  businessNumber: string
  companyName: string
  businessStatus: string
  isActive: boolean
}

/** 담당자가 입력하는 항목입니다. 등록과 수정이 같은 규칙을 씁니다. */
export type CompanyProfileInput = {
  region: string
  industry: string
  foundedYear: number
  homepageUrl: string | null
}

/** 사업자등록번호는 하이픈을 빼고 숫자 10자리로 다룹니다. */
export function normalizeBusinessNumber(value: string): string {
  return value.replace(/\D/g, '')
}

export function isValidBusinessNumber(value: string): boolean {
  return /^\d{10}$/.test(normalizeBusinessNumber(value))
}

/** 화면 표시용 `000-00-00000` 표기입니다. */
export function formatBusinessNumber(businessNumber: string): string {
  const digits = normalizeBusinessNumber(businessNumber)
  if (digits.length !== 10) return businessNumber
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
}

/** 입력 중인 사업자등록번호에 `000-00-00000` 하이픈을 붙입니다. 숫자만 남기고 10자리에서 자릅니다. */
export function formatBusinessNumberInput(value: string): string {
  const digits = normalizeBusinessNumber(value).slice(0, 10)
  if (digits.length <= 3) return digits
  if (digits.length <= 5) return `${digits.slice(0, 3)}-${digits.slice(3)}`
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
}

/** 앞뒤 공백을 지우고 스킴이 없으면 `https://`를 붙입니다. 빈 값은 빈 문자열입니다. */
export function normalizeHomepageUrl(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** 서버와 같은 규칙입니다. `http(s)://`로 시작하고 공백이 없으며 500자 이하이고 URL로 해석돼야 합니다. */
export function isValidHomepageUrl(value: string): boolean {
  if (value.length > companyProfileLimits.homepageMaxLength || !/^https?:\/\/\S+$/i.test(value)) return false
  try {
    return new URL(value).hostname.length > 0
  } catch {
    return false
  }
}

export const companyProfileLimits = {
  homepageMaxLength: 500,
  foundedYearMin: 1900,
} as const

/** 소재지 선택지입니다. 지원사업 공고의 지역 표기와 같은 17개 시·도 이름을 씁니다. */
export const companyRegions = [
  '서울특별시',
  '부산광역시',
  '대구광역시',
  '인천광역시',
  '광주광역시',
  '대전광역시',
  '울산광역시',
  '세종특별자치시',
  '경기도',
  '강원특별자치도',
  '충청북도',
  '충청남도',
  '전북특별자치도',
  '전라남도',
  '경상북도',
  '경상남도',
  '제주특별자치도',
] as const

/** 업종 선택지입니다. 한국표준산업분류 대분류 이름을 씁니다. */
export const companyIndustries = [
  '농업, 임업 및 어업',
  '광업',
  '제조업',
  '전기, 가스, 증기 및 공기 조절 공급업',
  '수도, 하수 및 폐기물 처리, 원료 재생업',
  '건설업',
  '도매 및 소매업',
  '운수 및 창고업',
  '숙박 및 음식점업',
  '정보통신업',
  '금융 및 보험업',
  '부동산업',
  '전문, 과학 및 기술 서비스업',
  '사업시설 관리, 사업 지원 및 임대 서비스업',
  '교육 서비스업',
  '보건업 및 사회복지 서비스업',
  '예술, 스포츠 및 여가관련 서비스업',
  '협회 및 단체, 수리 및 기타 개인 서비스업',
] as const
