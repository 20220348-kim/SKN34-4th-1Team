import type { SampleItem } from '../../domain/entities/SampleItem'
import { getCoreApiBaseUrl } from './coreApiConfig'
import {
  sampleItemPreparationDtoSchema,
  type SampleItemPreparationDto,
} from '../models/SampleItemDto'

const PREPARE_SAMPLE_ITEM_PATH = '/api/v1/sample-items/prepare'

export class SampleItemApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SampleItemApiError'
  }
}

/** 외부 JSON 응답을 Zod로 검증하는 Data Layer의 HTTP 경계입니다. */
export async function prepareSampleItemApi(
  item: SampleItem,
  signal?: AbortSignal,
): Promise<SampleItemPreparationDto> {
  const response = await fetch(`${getCoreApiBaseUrl()}${PREPARE_SAMPLE_ITEM_PATH}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ item }),
    signal,
  })

  if (!response.ok) {
    throw new SampleItemApiError(
      `Core API returned HTTP ${response.status} for the sample preparation request.`,
    )
  }

  return sampleItemPreparationDtoSchema.parse(await response.json())
}
