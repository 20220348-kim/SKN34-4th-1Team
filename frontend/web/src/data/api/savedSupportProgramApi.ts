import type { SupportProgramIdentity } from '../../domain/repositories/SupportProgramRepository'
import { AccountApiError } from './accountApi'
import { getCoreApiBaseUrl } from './coreApiConfig'
import {
  savedSupportProgramDtoSchema,
  savedSupportProgramListDtoSchema,
  savedSupportProgramStatusDtoSchema,
  type SavedSupportProgramDto,
} from '../models/SavedSupportProgramDto'

const SAVED_PROGRAMS_PATH = '/api/v1/me/saved-programs'

/** 관심 공고함은 회원 것이라 모든 요청이 세션 쿠키를 보냅니다. */
const withSessionCookie: RequestCredentials = 'include'

export async function listSavedSupportProgramsApi(signal?: AbortSignal): Promise<SavedSupportProgramDto[]> {
  const response = await fetch(`${getCoreApiBaseUrl()}${SAVED_PROGRAMS_PATH}`, {
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    cache: 'no-store',
    signal,
  })
  await rejectFailedResponse(response)
  return savedSupportProgramListDtoSchema.parse(await response.json()).programs
}

export async function getSavedSupportProgramStatusApi(identity: SupportProgramIdentity, signal?: AbortSignal): Promise<boolean> {
  const response = await fetch(`${getCoreApiBaseUrl()}${SAVED_PROGRAMS_PATH}/status?${identityParams(identity)}`, {
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    cache: 'no-store',
    signal,
  })
  await rejectFailedResponse(response)
  return savedSupportProgramStatusDtoSchema.parse(await response.json()).saved
}

/** 원본 ID에 `/`가 올 수 있어 경로가 아니라 본문으로 보냅니다. */
export async function saveSupportProgramApi(identity: SupportProgramIdentity, signal?: AbortSignal): Promise<SavedSupportProgramDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${SAVED_PROGRAMS_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(identity),
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)
  return savedSupportProgramDtoSchema.parse(await response.json())
}

export async function removeSavedSupportProgramApi(identity: SupportProgramIdentity, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${getCoreApiBaseUrl()}${SAVED_PROGRAMS_PATH}?${identityParams(identity)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)
}

function identityParams(identity: SupportProgramIdentity): URLSearchParams {
  return new URLSearchParams({ sourceCode: identity.sourceCode, sourceProgramId: identity.sourceProgramId })
}

/** 실패는 계정 API와 같은 ProblemDetail이라 같은 오류 타입으로 던집니다. */
async function rejectFailedResponse(response: Response): Promise<void> {
  if (response.ok) return
  let code: string | null = null
  try {
    const payload: unknown = await response.json()
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as { code?: unknown }
      code = typeof record.code === 'string' ? record.code : null
    }
  } catch {
    code = null
  }
  throw new AccountApiError(response.status, code)
}
