import {
  adminAccountPageSize,
  type AdminAccountActionKind,
  type AdminAccountQuery,
} from '../../domain/entities/AdminAccount'
import {
  adminAccountDetailDtoSchema,
  adminAccountListDtoSchema,
  adminAccountStatsDtoSchema,
  type AdminAccountDetailDto,
  type AdminAccountListDto,
  type AdminAccountStatsDto,
} from '../models/AdminAccountDto'
import { AccountApiError } from './accountApi'
import { getCoreApiBaseUrl } from './coreApiConfig'

const ADMIN_ACCOUNTS_PATH = '/api/v1/admin/accounts'

/** 조치별 서버 경로입니다. */
const actionPaths: Record<AdminAccountActionKind, string> = {
  suspend: 'suspend',
  unsuspend: 'unsuspend',
  'revoke-sessions': 'sessions/revoke',
}

/** 관리자 API는 세션 쿠키로 관리자인지 확인합니다. */
const withSessionCookie: RequestCredentials = 'include'

export async function getAdminAccountStatsApi(signal?: AbortSignal): Promise<AdminAccountStatsDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${ADMIN_ACCOUNTS_PATH}/summary`, {
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    cache: 'no-store',
    signal,
  })
  await rejectFailedResponse(response)

  return adminAccountStatsDtoSchema.parse(await response.json())
}

export async function browseAdminAccountsApi(query: AdminAccountQuery, signal?: AbortSignal): Promise<AdminAccountListDto> {
  const params = new URLSearchParams({
    keyword: query.keyword,
    sort: query.sort,
    page: String(query.page),
    pageSize: String(adminAccountPageSize),
  })
  // 상태·역할·로그인 방법은 고른 때만 보냅니다. 비어 있으면 전체입니다.
  if (query.status !== '') params.set('status', query.status)
  if (query.role !== '') params.set('role', query.role)
  if (query.loginMethod !== '') params.set('loginMethod', query.loginMethod)
  const response = await fetch(`${getCoreApiBaseUrl()}${ADMIN_ACCOUNTS_PATH}?${params}`, {
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    cache: 'no-store',
    signal,
  })
  await rejectFailedResponse(response)

  const list = adminAccountListDtoSchema.parse(await response.json())
  if (list.page !== query.page) throw new Error('요청한 페이지와 응답이 다릅니다.')
  return list
}

export async function getAdminAccountApi(id: number, signal?: AbortSignal): Promise<AdminAccountDetailDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${ADMIN_ACCOUNTS_PATH}/${id}`, {
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    cache: 'no-store',
    signal,
  })
  await rejectFailedResponse(response)

  return adminAccountDetailDtoSchema.parse(await response.json())
}

/** 정지·정지 해제·강제 로그아웃입니다. 사유를 함께 보내고 바뀐 상세를 돌려받습니다. */
export async function takeAdminAccountActionApi(
  id: number,
  kind: AdminAccountActionKind,
  reason: string,
  signal?: AbortSignal,
): Promise<AdminAccountDetailDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${ADMIN_ACCOUNTS_PATH}/${id}/${actionPaths[kind]}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)

  return adminAccountDetailDtoSchema.parse(await response.json())
}

/** 실패 응답의 HTTP 상태와 ProblemDetail `code`를 Repository가 업무 결과로 바꿀 수 있게 합니다. */
async function rejectFailedResponse(response: Response): Promise<void> {
  if (response.ok) return

  let code: string | null = null
  try {
    const payload: unknown = await response.json()
    if (typeof payload === 'object' && payload !== null && typeof (payload as { code?: unknown }).code === 'string') {
      code = (payload as { code: string }).code
    }
  } catch {
    code = null
  }
  throw new AccountApiError(response.status, code)
}
