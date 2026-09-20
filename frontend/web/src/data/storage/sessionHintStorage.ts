/**
 * "이 브라우저에 로그인 세션이 있을 수 있다"는 힌트만 보관하는 경계입니다. 세션 토큰 자체는 HttpOnly 쿠키에
 * 있어 스크립트가 읽을 수 없으므로, 앱 시작 시 `/me`를 호출할지 결정하는 데만 씁니다. 힌트가 틀려도 서버가
 * 401로 바로잡습니다. 테스트는 메모리 구현으로 대체합니다.
 */
export type SessionHintStorage = {
  hasSession(): boolean
  markSignedIn(): void
  clear(): void
}

export const sessionHintStorageKey = 'govbiz.hasSession'

/** localStorage 기반입니다. 비공개 창·차단 설정에서는 접근이 예외를 던지므로 모든 호출을 감쌉니다. */
export function createLocalSessionHintStorage(): SessionHintStorage {
  return {
    hasSession() {
      try {
        return window.localStorage.getItem(sessionHintStorageKey) === '1'
      } catch {
        return false
      }
    },
    markSignedIn() {
      try {
        window.localStorage.setItem(sessionHintStorageKey, '1')
      } catch {
        // 힌트를 못 남기면 새로고침 뒤 세션 복원을 시도하지 않을 뿐, 쿠키는 그대로입니다.
      }
    },
    clear() {
      try {
        window.localStorage.removeItem(sessionHintStorageKey)
      } catch {
        // 지울 수 없는 저장소는 읽기도 실패하므로 남는 힌트가 없습니다.
      }
    },
  }
}

export function createMemorySessionHintStorage(initiallySignedIn = false): SessionHintStorage {
  let signedIn = initiallySignedIn
  return {
    hasSession: () => signedIn,
    markSignedIn() {
      signedIn = true
    },
    clear() {
      signedIn = false
    },
  }
}
