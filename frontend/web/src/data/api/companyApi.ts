import type { CompanyProfileInput } from '../../domain/entities/Company'
import type { CompanyPartnerProfileInput } from '../../domain/entities/CompanyPartnerProfile'
import { AccountApiError } from './accountApi'
import { getCoreApiBaseUrl } from './coreApiConfig'
import {
  businessLookupDtoSchema,
  companyDtoSchema,
  companyPartnerProfileDtoSchema,
  type BusinessLookupDto,
  type CompanyDto,
  type CompanyPartnerProfileDto,
} from '../models/CompanyDto'

const COMPANY_PATH = '/api/v1/me/company'
const LOOKUP_PATH = '/api/v1/me/company/lookup'
const PARTNER_PROFILE_PATH = '/api/v1/me/company/partner-profile'

/** 기업 요청도 세션 쿠키로 인증하므로 모든 요청이 쿠키를 함께 보냅니다. */
const withSessionCookie: RequestCredentials = 'include'

export async function lookupBusinessApi(businessNumber: string, signal?: AbortSignal): Promise<BusinessLookupDto> {
  const query = new URLSearchParams({ businessNumber })
  const response = await fetch(`${getCoreApiBaseUrl()}${LOOKUP_PATH}?${query}`, {
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)

  return businessLookupDtoSchema.parse(await response.json())
}

export async function getMyCompanyApi(signal?: AbortSignal): Promise<CompanyDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${COMPANY_PATH}`, {
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    cache: 'no-store',
    signal,
  })
  await rejectFailedResponse(response)

  return companyDtoSchema.parse(await response.json())
}

export async function registerCompanyApi(
  businessNumber: string,
  profile: CompanyProfileInput,
  signal?: AbortSignal,
): Promise<CompanyDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${COMPANY_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessNumber, ...profile }),
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)

  return companyDtoSchema.parse(await response.json())
}

export async function updateCompanyApi(profile: CompanyProfileInput, signal?: AbortSignal): Promise<CompanyDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${COMPANY_PATH}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)

  return companyDtoSchema.parse(await response.json())
}

export async function getPartnerProfileApi(signal?: AbortSignal): Promise<CompanyPartnerProfileDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${PARTNER_PROFILE_PATH}`, {
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    cache: 'no-store',
    signal,
  })
  await rejectFailedResponse(response)

  return companyPartnerProfileDtoSchema.parse(await response.json())
}

export async function updatePartnerProfileApi(input: CompanyPartnerProfileInput, signal?: AbortSignal): Promise<CompanyPartnerProfileDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${PARTNER_PROFILE_PATH}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)

  return companyPartnerProfileDtoSchema.parse(await response.json())
}

/** 실패 응답의 `code`와 추가 속성(휴·폐업 상태 등)을 Repository가 업무 결과로 바꿀 수 있게 합니다. */
export class CompanyApiError extends AccountApiError {
  readonly businessStatus: string | null

  constructor(status: number, code: string | null, businessStatus: string | null) {
    super(status, code)
    this.name = 'CompanyApiError'
    this.businessStatus = businessStatus
  }
}

async function rejectFailedResponse(response: Response): Promise<void> {
  if (response.ok) return

  let code: string | null = null
  let businessStatus: string | null = null
  try {
    const payload: unknown = await response.json()
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as { code?: unknown; businessStatus?: unknown }
      code = typeof record.code === 'string' ? record.code : null
      businessStatus = typeof record.businessStatus === 'string' ? record.businessStatus : null
    }
  } catch {
    // 본문이 JSON이 아니면 상태 코드만으로 판단합니다.
  }
  throw new CompanyApiError(response.status, code, businessStatus)
}
