import type { NewAdminAiModelPrice } from '../../domain/entities/AdminAiCost'
import {
  adminAiCostSummaryDtoSchema,
  adminAiCostSyncDtoSchema,
  adminAiModelPriceDtoSchema,
  type AdminAiCostSummaryDto,
  type AdminAiCostSyncDto,
  type AdminAiModelPriceDto,
} from '../models/AdminAiCostDto'
import { rejectFailedResponse } from './adminAccountApi'
import { getCoreApiBaseUrl } from './coreApiConfig'
import { coreFetch } from './coreFetch'

const ADMIN_AI_COSTS_PATH = '/api/v1/admin/ai-costs'

/** 관리자 API는 세션 쿠키로 관리자인지 확인합니다. */
const withSessionCookie: RequestCredentials = 'include'

export async function getAdminAiCostSummaryApi(from: string, to: string, signal?: AbortSignal): Promise<AdminAiCostSummaryDto> {
  const params = new URLSearchParams({ from, to })
  const response = await coreFetch(`${getCoreApiBaseUrl()}${ADMIN_AI_COSTS_PATH}?${params}`, {
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    cache: 'no-store',
    signal,
  })
  await rejectFailedResponse(response)
  return adminAiCostSummaryDtoSchema.parse(await response.json())
}

export async function syncAdminAiCostsApi(signal?: AbortSignal): Promise<AdminAiCostSyncDto> {
  const response = await coreFetch(`${getCoreApiBaseUrl()}${ADMIN_AI_COSTS_PATH}/sync`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)
  return adminAiCostSyncDtoSchema.parse(await response.json())
}

export async function getAdminAiModelPricesApi(signal?: AbortSignal): Promise<AdminAiModelPriceDto[]> {
  const response = await coreFetch(`${getCoreApiBaseUrl()}${ADMIN_AI_COSTS_PATH}/prices`, {
    headers: { Accept: 'application/json' },
    credentials: withSessionCookie,
    cache: 'no-store',
    signal,
  })
  await rejectFailedResponse(response)
  return adminAiModelPriceDtoSchema.array().parse(await response.json())
}

export async function addAdminAiModelPriceApi(price: NewAdminAiModelPrice, signal?: AbortSignal): Promise<AdminAiModelPriceDto> {
  const response = await coreFetch(`${getCoreApiBaseUrl()}${ADMIN_AI_COSTS_PATH}/prices`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(price),
    credentials: withSessionCookie,
    signal,
  })
  await rejectFailedResponse(response)
  return adminAiModelPriceDtoSchema.parse(await response.json())
}
