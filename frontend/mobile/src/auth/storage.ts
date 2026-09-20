import * as SecureStore from 'expo-secure-store'
import { z } from 'zod'

const storedSessionSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
})
export type StoredSession = z.infer<typeof storedSessionSchema>

/** SecureStore keys only allow letters, digits, dots, dashes, and underscores. */
export function sessionStorageKey(apiBaseUrl: string): string {
  return `govbiz.session.${Array.from(apiBaseUrl.replace(/\/$/, '')).map((char) => char.charCodeAt(0).toString(16).padStart(4, '0')).join('')}`
}

export function parseStoredSession(value: string, now = Date.now()): StoredSession | null {
  try {
    const session = storedSessionSchema.parse(JSON.parse(value))
    return Date.parse(session.expiresAt) > now ? session : null
  } catch {
    return null
  }
}

// Serialize writes so an in-flight sign-in cannot restore storage after sign-out.
let storageWork: Promise<void> = Promise.resolve()

export async function readStoredSession(apiBaseUrl: string): Promise<StoredSession | null> {
  await storageWork.catch(() => undefined)
  const value = await SecureStore.getItemAsync(sessionStorageKey(apiBaseUrl))
  if (value === null) return null
  const session = parseStoredSession(value)
  if (session === null) await clearStoredSession(apiBaseUrl)
  return session
}

export function saveStoredSession(apiBaseUrl: string, session: StoredSession): Promise<void> {
  storageWork = storageWork.catch(() => undefined).then(() => SecureStore.setItemAsync(
    sessionStorageKey(apiBaseUrl),
    JSON.stringify({ accessToken: session.accessToken, expiresAt: session.expiresAt }),
    { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
  ))
  return storageWork
}

export function clearStoredSession(apiBaseUrl: string): Promise<void> {
  storageWork = storageWork.catch(() => undefined).then(() => SecureStore.deleteItemAsync(sessionStorageKey(apiBaseUrl)))
  return storageWork
}
