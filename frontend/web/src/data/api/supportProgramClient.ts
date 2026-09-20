import { createSupportProgramClient } from '@govbiz/shared/data/api/supportProgramClient'
import { getCoreApiBaseUrl } from './coreApiConfig'

/** 웹의 기존 쿠키 세션과 환경변수 해석을 유지합니다. */
export const supportProgramClient = createSupportProgramClient({
  baseUrl: getCoreApiBaseUrl,
  credentials: 'include',
})
