import { getCoreApiBaseUrl } from './coreApiConfig'
import { coreApiHealthSchema, type CoreApiHealth } from './coreApiHealth'

export class CoreApiRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoreApiRequestError'
  }
}

/**
 * HTTP 세부 사항은 data 계층에만 둡니다.
 * Health는 업무 도메인 기능이 아니라 애플리케이션 연결 상태이므로,
 * 예제 기능의 UseCase나 Repository를 억지로 거치지 않습니다.
 */
export async function fetchCoreApiHealth(signal?: AbortSignal): Promise<CoreApiHealth> {
  const response = await fetch(`${getCoreApiBaseUrl()}/api/v1/health`, { signal })

  if (!response.ok) {
    throw new CoreApiRequestError(`Core API가 HTTP ${response.status} 응답을 반환했습니다.`)
  }

  return coreApiHealthSchema.parse(await response.json())
}
