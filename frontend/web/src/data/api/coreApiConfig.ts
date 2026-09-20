function removeTrailingSlash(url: string) {
  return url.replace(/\/+$/, '')
}

/**
 * Vite는 VITE_로 시작하는 값만 브라우저 코드에 제공합니다.
 * 이 값은 API의 공개 주소일 뿐, 토큰이나 비밀값을 넣는 장소가 아닙니다.
 */
export function getCoreApiBaseUrl() {
  const configuredUrl = import.meta.env.VITE_CORE_API_BASE_URL?.trim()
  const localDevelopmentDefault = import.meta.env.DEV ? 'http://localhost:8080' : undefined
  const coreApiBaseUrl = configuredUrl || localDevelopmentDefault

  if (!coreApiBaseUrl) {
    throw new Error('배포 환경에서는 VITE_CORE_API_BASE_URL 환경변수를 설정해야 합니다.')
  }

  return removeTrailingSlash(coreApiBaseUrl)
}
