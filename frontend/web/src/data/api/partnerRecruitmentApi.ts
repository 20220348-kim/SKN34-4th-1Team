import type { PartnerRecruitmentContentInput, PartnerRecruitmentInput } from '../../domain/entities/PartnerRecruitment'
import { partnerRecruitmentPageSize, type PartnerRecruitmentQuery } from '../../domain/entities/PartnerRecruitmentQuery'
import { AccountApiError } from './accountApi'
import { getCoreApiBaseUrl } from './coreApiConfig'
import {
  partnerRecruitmentDtoSchema,
  partnerRecruitmentListDtoSchema,
  type PartnerRecruitmentDto,
  type PartnerRecruitmentListDto,
} from '../models/PartnerRecruitmentDto'

const RECRUITMENTS_PATH = '/api/v1/partners/recruitments'

/** 읽기도 쿠키를 보내 내 글 여부를 받고, 작성은 세션 쿠키로 인증합니다. */
const withSessionCookie: RequestCredentials = 'include'

export async function browsePartnerRecruitmentsApi(
  query: PartnerRecruitmentQuery,
  signal?: AbortSignal,
): Promise<PartnerRecruitmentListDto> {
  const params = new URLSearchParams({
    keyword: query.keyword,
    mine: String(query.mineOnly),
    sort: query.sort,
    page: String(query.page),
    pageSize: String(partnerRecruitmentPageSize),
  })
  // 역할·지역은 같은 이름을 여러 번 보내 함께 고릅니다. 비어 있으면 보내지 않습니다.
  for (const role of query.seekingRoles) params.append('seekingRole', role)
  for (const region of query.regions) params.append('region', region)
  if (query.sourceCode !== '') params.set('sourceCode', query.sourceCode)
  const response = await fetch(`${getCoreApiBaseUrl()}${RECRUITMENTS_PATH}?${params}`, {
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    cache: 'no-store',
    signal,
  })
  await rejectFailedResponse(response)

  const list = partnerRecruitmentListDtoSchema.parse(await response.json())
  if (list.page !== query.page) throw new Error('요청한 페이지와 응답이 다릅니다.')
  return list
}

export async function getPartnerRecruitmentApi(id: number, signal?: AbortSignal): Promise<PartnerRecruitmentDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${RECRUITMENTS_PATH}/${id}`, {
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    cache: 'no-store',
    signal,
  })
  await rejectFailedResponse(response)

  return partnerRecruitmentDtoSchema.parse(await response.json())
}

export async function createPartnerRecruitmentApi(
  input: PartnerRecruitmentInput,
  signal?: AbortSignal,
): Promise<PartnerRecruitmentDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${RECRUITMENTS_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)

  return partnerRecruitmentDtoSchema.parse(await response.json())
}

/** 작성자의 수정입니다. 묶인 공고는 바꾸지 않으므로 내용만 보냅니다. */
export async function updatePartnerRecruitmentApi(
  id: number,
  input: PartnerRecruitmentContentInput,
  signal?: AbortSignal,
): Promise<PartnerRecruitmentDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${RECRUITMENTS_PATH}/${id}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)

  return partnerRecruitmentDtoSchema.parse(await response.json())
}

/** 작성자의 수동 마감입니다. 본문 없이 보내고 마감된 모집글을 돌려받습니다. */
export async function closePartnerRecruitmentApi(id: number, signal?: AbortSignal): Promise<PartnerRecruitmentDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${RECRUITMENTS_PATH}/${id}/close`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)

  return partnerRecruitmentDtoSchema.parse(await response.json())
}

/** 실패 응답의 `code`와 마감일 안내(`latestAllowedDeadline`)를 Repository가 업무 결과로 바꿀 수 있게 합니다. */
export class PartnerRecruitmentApiError extends AccountApiError {
  readonly latestAllowedDeadline: string | null

  constructor(status: number, code: string | null, latestAllowedDeadline: string | null) {
    super(status, code)
    this.name = 'PartnerRecruitmentApiError'
    this.latestAllowedDeadline = latestAllowedDeadline
  }
}

async function rejectFailedResponse(response: Response): Promise<void> {
  if (response.ok) return

  let code: string | null = null
  let latestAllowedDeadline: string | null = null
  try {
    const payload: unknown = await response.json()
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as { code?: unknown; latestAllowedDeadline?: unknown }
      code = typeof record.code === 'string' ? record.code : null
      latestAllowedDeadline = typeof record.latestAllowedDeadline === 'string' ? record.latestAllowedDeadline : null
    }
  } catch {
    // 본문이 JSON이 아니면 상태 코드만으로 판단합니다.
  }
  throw new PartnerRecruitmentApiError(response.status, code, latestAllowedDeadline)
}
