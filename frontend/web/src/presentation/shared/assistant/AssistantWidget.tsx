import { useRef } from 'react'

import { AssistantPanel } from './AssistantPanel'
import { assistantMessages } from './assistantMessages'
import { assistantStyles as styles } from './Assistant.styles'
import { useAssistantViewModel } from './useAssistantViewModel'

/**
 * 모든 화면 오른쪽 아래에 떠 있는 GovBiz 도우미입니다. 런처(56px 원)와 열렸을 때의 패널로 이루어지며,
 * 로그인·회원가입처럼 도우미가 필요 없는 화면에서는 그리지 않습니다.
 */
export function AssistantWidget() {
  const vm = useAssistantViewModel()
  const launcherRef = useRef<HTMLButtonElement>(null)

  if (vm.isHidden) return null

  return (
    <>
      {vm.isOpen ? <AssistantPanel vm={vm} launcherRef={launcherRef} /> : null}
      <div className={`${styles.launcherWrap} ${vm.isLifted ? styles.launcherWrapLifted : styles.launcherWrapDefault}`}>
        {vm.showLabel ? <span className={styles.launcherLabel} aria-hidden="true">{assistantMessages.launcherLabel}</span> : null}
        <button
          ref={launcherRef}
          className={`${styles.launcher} ${vm.isOpen ? styles.launcherOpen : ''}`}
          type="button"
          aria-label={vm.isOpen ? assistantMessages.closeLauncher : assistantMessages.openLauncher}
          aria-expanded={vm.isOpen}
          aria-haspopup="dialog"
          onClick={vm.toggle}
        >
          {vm.isOpen ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          ) : (
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 5h16v11H8l-4 4z" />
            </svg>
          )}
          {vm.hasUnread ? <span className={styles.launcherBadge} aria-label="새 답변 1건">1</span> : null}
        </button>
      </div>
    </>
  )
}
