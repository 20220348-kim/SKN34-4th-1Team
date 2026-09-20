import type { ChatActivity } from '../../features/chat/state/chatSlice'
import { chatActivityTone } from './chatActivityMessages'
import { chatActivityDotStyles as styles } from './ChatActivityDot.styles'

/** 진행 중이면 깜박이고 결과가 오면 멈추는 점입니다. 글자가 없어 좁은 곳에서도 잘리지 않고, 버튼 이름도 바꾸지 않습니다. */
export function ChatActivityDot({ activity, className = '' }: { activity: ChatActivity; className?: string }) {
  const tone = chatActivityTone(activity)
  const toneClass = tone === 'pending' ? styles.dotPending : tone === 'failed' ? styles.dotFailed : styles.dotDone
  return <span className={`${styles.dot} ${toneClass} ${className}`} data-activity={tone} aria-hidden="true" />
}
