import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'

import { useAppSelector } from '../../../app/hooks'
import { selectChatActivity } from '../../features/chat/state/chatSlice'
import { selectAuthStatus } from '../auth/state/authSlice'
import { appPaths, publicPaths } from '../routes/appPaths'
import { chatActivityMessages, chatOutcomeMessage, silentToastOutcomes } from './chatActivityMessages'
import { chatActivityToastStyles as styles } from './ChatActivityToast.styles'

/** 알림이 스스로 접히기까지의 시간입니다. 사이드바·헤더 배지는 결과를 볼 때까지 남습니다. */
export const chatActivityToastMs = 12_000

const chatPaths: readonly string[] = [
  publicPaths.landing, publicPaths.supportProgramDetail, publicPaths.supportProgramQuestion,
  appPaths.chat, appPaths.supportProgramDetail, appPaths.supportProgramQuestion,
]

/**
 * 검색 화면을 떠나 있는 동안 검색·조건 해석 결과가 도착하면 한 줄 알림을 띄웁니다.
 * 결과를 보러 가는 링크 하나와 닫기뿐이며, 닫아도 배지는 결과를 볼 때까지 남습니다.
 */
export function ChatActivityToast() {
  const activity = useAppSelector(selectChatActivity)
  const authStatus = useAppSelector(selectAuthStatus)
  const { pathname } = useLocation()
  const path = pathname.replace(/\/+$/, '') || publicPaths.landing
  const onChatScreen = chatPaths.includes(path)
  const outcomeKey = activity?.kind === 'unseen' && !silentToastOutcomes.has(activity.outcome)
    ? `${activity.outcome}:${activity.resultCount ?? ''}` : null
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  useEffect(() => {
    // 결과를 보거나 새 요청이 시작되면 닫힘 기억을 지워, 다음에 같은 종류의 결과가 와도 다시 알립니다.
    if (outcomeKey === null) { setDismissedKey(null); return }
    if (onChatScreen) return
    const timer = setTimeout(() => setDismissedKey(outcomeKey), chatActivityToastMs)
    return () => clearTimeout(timer)
  }, [onChatScreen, outcomeKey])

  if (activity?.kind !== 'unseen' || outcomeKey === null || onChatScreen || outcomeKey === dismissedKey) return null
  const chatPath = authStatus === 'authenticated' ? appPaths.chat : publicPaths.landing

  return (
    <div className={styles.toast} role="status" aria-live="polite" aria-label={chatActivityMessages.toastLabel}>
      <p className={styles.text}>{chatOutcomeMessage(activity.outcome, activity.resultCount)}</p>
      <Link className={styles.open} to={chatPath}>{chatActivityMessages.open}</Link>
      <button type="button" className={styles.close} aria-label={chatActivityMessages.close} onClick={() => setDismissedKey(outcomeKey)}>✕</button>
    </div>
  )
}
