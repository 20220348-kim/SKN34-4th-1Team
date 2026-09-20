import { useState } from 'react'
import { useStore } from 'react-redux'

import { useAppDispatch } from '../../../app/hooks'
import type { RootState } from '../../../app/store'
import type { ChatHistoryViewModel } from '../../features/chat/hooks/useChatHistory'
import { cancelActiveChatRequests, hasActiveChatRequest } from '../../features/chat/state/chatRequestThunks'

/** 확인 대화상자를 거쳐야 하는 동작입니다. 새 검색·대화 열기는 진행 중 검색을 끊고, 삭제는 되돌릴 수 없습니다. */
export type PendingChatAction = { kind: 'new' } | { kind: 'open'; id: string } | { kind: 'delete'; id: string; title: string }

export type WorkspaceChatActionsDeps = {
  history: ChatHistoryViewModel
  /** 지금 검색 화면(AI 대화·필터 검색 탭)에 있는지입니다. */
  isOnChatPage: boolean
  /** 모바일 메뉴 <dialog>는 최상위 레이어라 확인 대화상자를 가리므로, 대화상자를 띄우기 전에 닫습니다. */
  closeMenu: () => void
  /** 대화를 비우고 검색 화면으로 갑니다. */
  startNewChat: () => void
  /** 대화를 비우지 않고 검색 화면으로만 갑니다. 진행 중인 대화가 그대로 보입니다. */
  goToChat: () => void
  openChatHistory: (id: string) => Promise<void>
  /** 삭제된 항목의 버튼은 사라지므로 포커스를 옮길 곳을 정합니다. */
  focusAfterDelete: () => void
}

/**
 * 사이드바의 새검색·대화 열기·대화 삭제를 확인 대화상자와 연결하는 ViewModel Hook입니다.
 * 진행 중 검색을 끊는 동작과 되돌릴 수 없는 삭제만 묻고, 화면 이동 자체는 묻지 않습니다.
 * 레이아웃 View는 여기서 받은 `pendingAction`으로 대화상자를 그리고 handler만 연결합니다.
 */
export function useWorkspaceChatActions(deps: WorkspaceChatActionsDeps) {
  const dispatch = useAppDispatch()
  const store = useStore<RootState>()
  // 확인을 기다리는 동작입니다. 확인 대화상자가 떠 있는 동안만 값이 있습니다.
  const [pendingAction, setPendingAction] = useState<PendingChatAction | null>(null)

  /** 비밀번호 변경창과 같은 대화상자로 먼저 확인을 받습니다. */
  function askBeforeActing(action: PendingChatAction) {
    deps.closeMenu()
    setPendingAction(action)
  }

  /**
   * 새검색은 검색 화면으로 가는 입구이기도 합니다. 검색이 진행 중이면 화면으로 가는 것까지는 그대로 두고,
   * 이미 검색 화면에서 다시 누를 때만 새 대화 시작으로 보고 확인을 받습니다.
   */
  function requestNewChat() {
    if (!hasActiveChatRequest(store.getState())) { deps.startNewChat(); return }
    if (!deps.isOnChatPage) { deps.goToChat(); return }
    askBeforeActing({ kind: 'new' })
  }

  function requestOpenChatHistory(id: string) {
    if (!deps.history.needsCancelToOpen(id)) { void deps.openChatHistory(id); return }
    askBeforeActing({ kind: 'open', id })
  }

  function requestDeleteChatHistory(id: string, title: string) {
    askBeforeActing({ kind: 'delete', id, title })
  }

  async function deleteChatHistory(id: string) {
    if (!await deps.history.remove(id)) return
    deps.focusAfterDelete()
  }

  function confirmPendingAction() {
    const action = pendingAction
    setPendingAction(null)
    if (action === null) return
    if (action.kind === 'delete') { void deleteChatHistory(action.id); return }
    dispatch(cancelActiveChatRequests())
    if (action.kind === 'new') deps.startNewChat()
    else void deps.openChatHistory(action.id)
  }

  function cancelPendingAction() {
    setPendingAction(null)
  }

  return { pendingAction, requestNewChat, requestOpenChatHistory, requestDeleteChatHistory, confirmPendingAction, cancelPendingAction }
}

export type WorkspaceChatActions = ReturnType<typeof useWorkspaceChatActions>
