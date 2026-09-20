import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import { type AssistantCard as AssistantCardModel, type AssistantCardButton, type AssistantMessage } from './assistantConversation'
import { assistantMessages } from './assistantMessages'
import { assistantCardTagClassName, assistantStyles as styles } from './Assistant.styles'
import { useFloatingPopover } from '../workspace/useFloatingPopover'
import type { AssistantViewModel } from './useAssistantViewModel'

/**
 * 도우미 패널입니다. 머리(아바타·이름·상태·메뉴·닫기), 대화 영역, 빠른 답변, 입력창 순서이고 머리와 입력창은 고정,
 * 대화 영역만 스크롤합니다. 비모달이라 배경은 그대로 조작할 수 있고 Esc로 닫습니다.
 */
export function AssistantPanel({ vm, launcherRef }: { vm: AssistantViewModel; launcherRef: React.RefObject<HTMLButtonElement | null> }) {
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  // 패널이 overflow-hidden이라 메뉴는 fixed로 띄우고, 오른쪽 끝에서 잘리면 안쪽으로 옮깁니다.
  const menuFloating = useFloatingPopover({ open: isMenuOpen, placement: 'bottom-end', gap: 4 })
  const lastMessageId = vm.messages[vm.messages.length - 1]?.id

  // 열면 입력창에 포커스, 닫으면 런처로 돌아갑니다.
  useEffect(() => {
    inputRef.current?.focus()
    const launcher = launcherRef.current
    return () => { launcher?.focus() }
  }, [launcherRef])

  // 새 말풍선이 붙으면 바닥으로 내립니다.
  useLayoutEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [lastMessageId, vm.isTyping, vm.quickReplies])

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (isMenuOpen) { setIsMenuOpen(false); return }
      vm.close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isMenuOpen, vm])

  function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (draft.trim() === '') return
    vm.submitText(draft)
    setDraft('')
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return
    // 한글 조합 중 Enter는 글자 확정이므로 보내지 않습니다.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    event.preventDefault()
    submit()
  }

  function onNavigate(button: AssistantCardButton) {
    vm.prepareNavigation(button)
    setIsMenuOpen(false)
    vm.close()
  }

  return (
    <section
      className={`${styles.panel} ${vm.isLifted ? styles.panelLifted : styles.panelDefault}`}
      role="dialog"
      aria-modal="false"
      aria-label={assistantMessages.name}
    >
      <header className={styles.header}>
        <button className={styles.headerBack} type="button" aria-label={assistantMessages.back} onClick={vm.close}>‹</button>
        <span className={styles.avatar} aria-hidden="true">G</span>
        <div className={styles.headerText}>
          <p className={styles.headerName}>{assistantMessages.name}</p>
        </div>
        <div className={styles.headerActions}>
          <button
            ref={menuFloating.reference}
            className={styles.headerButton}
            type="button"
            aria-label={assistantMessages.menu}
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            onClick={() => setIsMenuOpen((value) => !value)}
          >
            ⋯
          </button>
          <button className={styles.headerButton} type="button" aria-label={assistantMessages.close} onClick={vm.close}>✕</button>
          {isMenuOpen ? (
            <div ref={menuFloating.floating} style={menuFloating.floatingStyles} className={styles.menu} role="menu" aria-label={assistantMessages.menu}>
              <button className={styles.menuItem} type="button" role="menuitem" onClick={() => { setIsMenuOpen(false); vm.startNewConversation() }}>
                {assistantMessages.newConversation}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className={styles.log} ref={logRef} role="log" aria-live="polite" aria-label="대화">
        <p className={styles.dateSeparator}>{assistantMessages.today}</p>
        {groupMessages(vm.messages).map((group) => (
          group.role === 'user' ? (
            <div className={`${styles.group} ${styles.groupMe}`} key={group.key}>
              <div className={styles.column}>
                {group.items.map((message) => (
                  <p className={`${styles.bubble} ${styles.bubbleMe}`} key={message.id}>{message.role === 'user' ? message.text : null}</p>
                ))}
              </div>
            </div>
          ) : (
            <div className={styles.group} key={group.key}>
              <span className={styles.avatarSmall} aria-hidden="true">G</span>
              <div className={`${styles.column} ${group.items.some((item) => item.role === 'assistant' && item.card !== null && item.card.rows.length > 0) ? styles.columnWide : ''}`}>
                {group.items.map((message) => message.role === 'assistant' ? (
                  <AssistantBubble
                    key={message.id}
                    message={message}
                    onNavigate={onNavigate}
                  />
                ) : null)}
              </div>
            </div>
          )
        ))}
        {vm.isTyping ? (
          <div className={styles.group}>
            <span className={styles.avatarSmall} aria-hidden="true">G</span>
            <span className={styles.typing} role="status" aria-label={assistantMessages.typing}>
              <i className={styles.typingDot} /><i className={styles.typingDot} /><i className={styles.typingDot} />
            </span>
          </div>
        ) : null}
        {vm.quickReplies.length > 0 && !vm.isTyping ? (
          <div className={styles.quickReplies} role="group" aria-label="빠른 답변">
            {vm.quickReplies.map((reply) => (
              <button className={styles.quickReply} type="button" key={reply.id} onClick={() => vm.pickQuickReply(reply)}>
                {reply.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <form className={styles.composer} onSubmit={submit} aria-label="메시지 입력">
        <textarea
          ref={inputRef}
          className={styles.input}
          rows={1}
          aria-label={assistantMessages.placeholder}
          placeholder={assistantMessages.placeholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onInputKeyDown}
        />
        <button className={styles.send} type="submit" aria-label={assistantMessages.send} disabled={draft.trim() === '' || vm.isTyping}>↑</button>
      </form>
    </section>
  )
}

function AssistantBubble({ message, onNavigate }: {
  message: Extract<AssistantMessage, { role: 'assistant' }>
  onNavigate: (button: AssistantCardButton) => void
}) {
  return (
    <>
      <div className={`${styles.bubble} ${message.tone === 'warn' ? styles.bubbleWarn : styles.bubbleBot}`}>
        {message.paragraphs.map((paragraph, index) => (
          <p className={styles.paragraph} key={`${message.id}-${index}`}>{index === 0 ? <strong>{paragraph}</strong> : paragraph}</p>
        ))}
      </div>
      {message.card !== null ? <AssistantCard card={message.card} onNavigate={onNavigate} /> : null}
      {message.source !== null ? <span className={styles.source}>{message.source}</span> : null}
    </>
  )
}

function AssistantCard({ card, onNavigate }: { card: AssistantCardModel; onNavigate: (button: AssistantCardButton) => void }) {
  return (
    <div className={styles.card}>
      {card.rows.map((row, index) => (
        <div className={styles.cardRow} key={`${row.title}-${index}`}>
          {row.to === undefined ? (
            <span className={styles.cardRowTitle}>
              {row.tag !== null ? <span className={assistantCardTagClassName(row.tag.tone)}>{row.tag.label}</span> : null}
              {row.title}
            </span>
          ) : (
            <Link className={styles.cardRowLink} to={row.to} onClick={() => onNavigate({ label: row.title, to: row.to ?? '' })}>
              {row.tag !== null ? <span className={assistantCardTagClassName(row.tag.tone)}>{row.tag.label}</span> : null}
              {row.title}
            </Link>
          )}
          {row.detail !== null ? <span className={styles.cardRowDetail}>{row.detail}</span> : null}
        </div>
      ))}
      {card.buttons.map((button) => button.external ? (
        <a className={styles.cardButton} key={`${button.label}-${button.to}`} href={button.to} target="_blank" rel="noopener noreferrer">{button.label}</a>
      ) : (
        <Link className={styles.cardButton} key={`${button.label}-${button.to}`} to={button.to} onClick={() => onNavigate(button)}>{button.label}</Link>
      ))}
    </div>
  )
}

/** 같은 쪽 말풍선이 이어지면 아바타 하나에 묶습니다. */
function groupMessages(messages: AssistantMessage[]): { key: string; role: AssistantMessage['role']; items: AssistantMessage[] }[] {
  const groups: { key: string; role: AssistantMessage['role']; items: AssistantMessage[] }[] = []
  for (const message of messages) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.role === message.role) last.items.push(message)
    else groups.push({ key: message.id, role: message.role, items: [message] })
  }
  return groups
}
