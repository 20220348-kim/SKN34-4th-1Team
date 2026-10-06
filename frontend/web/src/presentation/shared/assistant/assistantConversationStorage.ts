import {
  assistantConversationStorageKey, type AssistantConversation,
} from './state/assistantSlice'

type StoredConversation = AssistantConversation & { accountEmail: string | null }

/** 인증으로 확인한 소유자의 캐시만 읽습니다. 소유자 없는 구버전 자료는 복원하지 않습니다. */
export function readAssistantConversation(accountEmail: string | null): StoredConversation | null {
  try {
    const raw = window.sessionStorage.getItem(assistantConversationStorageKey)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Partial<StoredConversation>
    if (!Object.hasOwn(record, 'accountEmail') || record.accountEmail !== accountEmail) return null
    if (!Array.isArray(record.messages) || !Array.isArray(record.quickReplies)) return null
    return { accountEmail, messages: record.messages, quickReplies: record.quickReplies }
  } catch {
    return null
  }
}

/** 저장소 사용이 차단된 환경에서도 Redux의 세션 초기화와 늦은 응답 차단은 유지합니다. */
export function writeAssistantConversation(value: StoredConversation | null) {
  try {
    if (value === null) window.sessionStorage.removeItem(assistantConversationStorageKey)
    else window.sessionStorage.setItem(assistantConversationStorageKey, JSON.stringify(value))
  } catch {
    // 브라우저 저장소를 사용할 수 없으면 같은 계정의 새로고침 복원만 제공하지 못합니다.
  }
}
