import { createSupportProgramClient } from '@govbiz/shared/data/api/supportProgramClient'
import { getCoreApiBaseUrl } from './coreApiConfig'
import { coreFetch } from './coreFetch'

/** 웹의 기존 쿠키 세션과 환경변수 해석을 유지하고, 401이면 세션 감시에 알립니다. */
export const supportProgramClient = createSupportProgramClient({
  baseUrl: getCoreApiBaseUrl,
  credentials: 'include',
  fetch: coreFetch,
})
