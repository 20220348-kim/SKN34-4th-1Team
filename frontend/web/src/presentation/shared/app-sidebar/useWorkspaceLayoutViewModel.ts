import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useLocation, useNavigate } from 'react-router'

import { useAppDispatch } from '../../../app/hooks'
import { useChatHistory } from '../../features/chat/hooks/useChatHistory'
import { conversationReset } from '../../features/chat/state/chatSlice'
import { appPaths } from '../routes/appPaths'
import { useResetScrollOnNavigate } from '../routes/useResetScrollOnNavigate'
import { useWorkspaceChatActions } from './useWorkspaceChatActions'

const mobileMediaQuery = '(max-width: 759px)'

/**
 * 로그인 작업 화면 레이아웃의 ViewModel Hook입니다. PC 사이드바 접기·모바일 메뉴·포커스 이동과
 * 새검색·대화 열기·삭제의 확인 흐름을 한곳에서 관리하고, View는 반환된 상태와 handler만 연결합니다.
 * DOM ref는 포커스 제어에만 쓰며 Redux에 두지 않습니다.
 */
export function useWorkspaceLayoutViewModel() {
  const [isMobile, setIsMobile] = useState(() => typeof window.matchMedia === 'function'
    && window.matchMedia(mobileMediaQuery).matches)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const shouldFocusComposer = useRef(false)
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const location = useLocation()
  const history = useChatHistory()
  const { cancelOpening } = history

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(mobileMediaQuery)
    const update = () => { setIsMobile(media.matches); setIsMenuOpen(false) }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => { setIsMenuOpen(false) }, [location.key])
  // 다른 화면으로 이동한 뒤 늦게 도착한 기록 조회가 채팅으로 다시 끌고 가지 않게 합니다.
  useEffect(() => { cancelOpening() }, [location.key, cancelOpening])
  // 작업 칸이 문서 대신 스크롤하므로 다른 화면으로 가면 작업 칸을 맨 위로 돌립니다.
  useResetScrollOnNavigate(workspaceRef)

  useEffect(() => {
    if (isMobile && isMenuOpen) dialogRef.current?.showModal()
    else dialogRef.current?.close()
  }, [isMobile, isMenuOpen])

  useEffect(() => {
    if (!shouldFocusComposer.current || isMenuOpen) return
    const input = workspaceRef.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="지원사업 검색어"]')
    // 라우터가 필터 탭에서 AI 탭으로 전환하고 모달이 닫힌 뒤 포커스를 줍니다.
    if (input && !input.closest('[hidden]')) {
      input.focus()
      shouldFocusComposer.current = false
    }
  }, [location.key, isMenuOpen])

  function closeMenu() {
    setIsMenuOpen(false)
  }

  function closeSidebar() {
    flushSync(() => {
      if (isMobile) setIsMenuOpen(false)
      else setIsCollapsed(true)
    })
    menuButtonRef.current?.focus()
  }

  function openSidebar() {
    flushSync(() => {
      if (isMobile) setIsMenuOpen(true)
      else setIsCollapsed(false)
    })
    if (!isMobile) sidebarRef.current?.querySelector<HTMLButtonElement>('button[aria-label="사이드바 접기"]')?.focus()
  }

  function startNewChat() {
    history.cancelOpening()
    shouldFocusComposer.current = true
    // 요청 ID까지 함께 비워 진행 중인 해석·검색을 취소하고 늦은 응답이 대화를 되살리지 않게 합니다.
    flushSync(() => {
      dispatch(conversationReset())
      setIsMenuOpen(false)
      navigate(appPaths.chat)
    })
  }

  function goToChat() {
    history.cancelOpening()
    setIsMenuOpen(false)
    navigate(appPaths.chat)
  }

  async function openChatHistory(id: string) {
    if (!await history.open(id)) return
    shouldFocusComposer.current = true
    setIsMenuOpen(false)
    navigate(appPaths.chat)
  }

  function focusAfterDelete() {
    // 새검색 버튼(모바일은 메뉴 버튼)으로 옮깁니다.
    const next = isMobile ? menuButtonRef.current
      : sidebarRef.current?.querySelector<HTMLButtonElement>('button[title="대화와 적용 조건을 초기화합니다"]')
    next?.focus()
  }

  const chatActions = useWorkspaceChatActions({
    history, isOnChatPage: location.pathname === appPaths.chat,
    closeMenu, startNewChat, goToChat, openChatHistory, focusAfterDelete,
  })

  return {
    isMobile, isCollapsed, isMenuOpen,
    dialogRef, sidebarRef, workspaceRef, menuButtonRef,
    history,
    closeLabel: isMobile ? '메뉴 닫기' : '사이드바 접기',
    openLabel: isMobile ? '메뉴 열기' : '사이드바 펼치기',
    closeMenu, closeSidebar, openSidebar,
    ...chatActions,
  }
}

export type WorkspaceLayoutViewModel = ReturnType<typeof useWorkspaceLayoutViewModel>
