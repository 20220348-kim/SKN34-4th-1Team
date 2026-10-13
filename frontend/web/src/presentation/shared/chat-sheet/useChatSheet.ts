import { createContext, useContext, useState } from 'react'
import { type Location, matchPath, type NavigationType, useLocation, useNavigate, useNavigationType } from 'react-router'

import { appPaths, isAppPath } from '../routes/appPaths'

/**
 * 대화에서 열면 대화 위 시트로 띄우는 화면과 시트 머리의 이름입니다. 목록 화면은 넣지 않아, 시트 안에서 목록으로 가면
 * 시트를 닫고 그 화면을 엽니다.
 */
const sheetScreens: readonly { path: string; kind: string }[] = [
  { path: appPaths.supportProgramDetail, kind: '공고 상세' },
  { path: appPaths.supportProgramQuestion, kind: '원문 질문' },
  { path: appPaths.applicationPreparationNew, kind: '신청 문서' },
  { path: appPaths.applicationPreparationDetail, kind: '신청 문서' },
  { path: appPaths.applicationPreparationDocuments, kind: '신청 문서' },
  { path: appPaths.combinationReviewNew, kind: '중복 검토' },
  { path: appPaths.combinationReviewDetail, kind: '중복 검토' },
  { path: appPaths.combinationReviewRunResult, kind: '중복 검토' },
  { path: appPaths.partnerDetail, kind: '파트너 모집글' },
]

export function chatSheetKind(pathname: string): string | null {
  return sheetScreens.find((screen) => matchPath(screen.path, pathname))?.kind ?? null
}

/** 시트 안에 그린 화면인지입니다. 작업 화면 머리글은 시트 안에서 상위 화면 경로를 숨깁니다. */
export const InChatSheetContext = createContext(false)

export function useInChatSheet(): boolean {
  return useContext(InChatSheetContext)
}

/** 시트로 띄운 화면의 주소입니다. 시트가 없으면 null입니다. 뒤의 대화가 시트에서 저장한 검토를 작업 카드에 붙일 때 씁니다. */
export const ChatSheetLocationContext = createContext<Location | null>(null)

export function useChatSheetLocation(): Location | null {
  return useContext(ChatSheetLocationContext)
}

/** 대화 위 시트를 닫은 횟수입니다. 뒤에 남아 있던 대화의 작업 카드는 이 값이 바뀌면 상태를 다시 읽습니다. */
export const ChatSheetClosedContext = createContext(0)

export function useChatSheetClosedCount(): number {
  return useContext(ChatSheetClosedContext)
}

type SheetState = {
  location: Location
  /** 시트 뒤에 그대로 그리는 대화 화면입니다. 없으면 시트가 아닌 전체 화면으로 엽니다. */
  background: Location | null
  /** 대화 화면의 브라우저 기록 위치입니다. 닫기는 그 위치까지 뒤로 가서 시트 안에서 옮긴 화면들도 함께 닫습니다. */
  chatIndex: number | null
  closed: number
}

function historyIndex(): number | null {
  const index = (window.history.state as { idx?: unknown } | null)?.idx
  return typeof index === 'number' ? index : null
}

/**
 * 대화가 아닌 작업 화면(신청 문서 작성 · 관심 공고함 · 중복 검토 · 파트너 · 리포트 등)에서 열어도 그 화면 위 시트로 띄우는 화면입니다.
 * 공고 상세 · 원문 질문은 어디서 열든 같은 모양으로 보고 닫으면 보던 목록으로 돌아갑니다. 신청 문서 · 검토처럼 그 자체가 목적지인
 * 화면은 대화에서 열 때만 시트이고, 목록에서 열면 지금처럼 전체 화면입니다.
 */
const peekPaths = [appPaths.supportProgramDetail, appPaths.supportProgramQuestion]

function isPeekPath(pathname: string): boolean {
  return peekPaths.some((path) => matchPath(path, pathname))
}

/** [from] 화면 위에 [to]를 시트로 띄울지입니다. 대화는 모든 시트 화면을, 다른 작업 화면은 공고 상세 · 원문 질문만 띄웁니다. */
function opensOver(from: string, to: string): boolean {
  const path = from.replace(/\/+$/, '')
  if (path === appPaths.chat) return true
  return isAppPath(path) && !isPeekPath(path) && isPeekPath(to)
}

function advance(state: SheetState, location: Location, navigationType: NavigationType): SheetState {
  if (chatSheetKind(location.pathname) === null) {
    return { location, background: null, chatIndex: null, closed: state.background ? state.closed + 1 : state.closed }
  }
  if (state.background) return { ...state, location }
  // 화면에서 누른 링크(또는 앞으로 가기)일 때만 시트로 엽니다. 주소를 바꿔 치우는 이동·새로고침·공유 링크는 전체 화면입니다.
  if (!opensOver(state.location.pathname, location.pathname) || navigationType === 'REPLACE') return { ...state, location }
  const index = historyIndex()
  return { location, background: state.location, chatIndex: index === null ? null : index - 1, closed: state.closed }
}

/**
 * 대화에서 공고 상세·신청 문서·중복 검토·파트너 모집글로 가면 대화를 뒤에 그대로 두고 그 화면을 시트로 띄웁니다.
 * 다른 작업 화면에서 연 공고 상세·원문 질문도 그 화면을 뒤에 둔 같은 시트로 띄웁니다(목록 필터 · 스크롤 유지).
 * 주소는 그 화면의 주소로 바뀌므로 새로고침·공유 링크는 지금처럼 전체 화면으로 열리고, 뒤로 가기는 시트를 닫습니다.
 * 시트 안에서 다른 시트 화면으로 옮겨도(새 문서 → 답변 입력 → 초안) 시트를 유지하고, 그 밖의 화면으로 가면 시트를 닫고 그 화면을 엽니다.
 * 대화가 뒤에 남아 있으므로 닫으면 스크롤 위치와 쓰던 글이 그대로입니다.
 */
export function useChatSheetRouting() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const navigate = useNavigate()
  const [state, setState] = useState<SheetState>({ location, background: null, chatIndex: null, closed: 0 })
  // 주소가 바뀐 그 렌더에서 바로 정해야 대화가 한 번이라도 내려갔다 올라오지 않습니다(이전 렌더 값으로 상태 고치기).
  const current = state.location === location ? state : advance(state, location, navigationType)
  if (current !== state) setState(current)

  function close() {
    const { background, chatIndex } = current
    if (!background) return
    const index = historyIndex()
    if (chatIndex !== null && index !== null && index > chatIndex) navigate(chatIndex - index)
    else navigate(`${background.pathname}${background.search}`, { state: background.state })
  }

  /**
   * 시트를 접고 지금 화면을 전체 화면으로 엽니다. 뒤에 있던 대화는 내려가며 [대화로 돌아가기]가 남습니다.
   * 시트의 [전체 화면으로 열기] 버튼을 주석 처리해 두어 지금은 부르는 곳이 없습니다.
   */
  function expand() {
    setState({ ...current, background: null, chatIndex: null })
  }

  return {
    /**
     * 바깥 화면을 그릴 위치입니다. 시트가 열리면 대화, 아니면 지금 주소입니다. `Routes`는 위치를 받을 때만 한 겹을 더 감싸므로
     * 시트가 열리고 닫힐 때 대화가 내려갔다 올라오지 않게 늘 위치를 넘깁니다.
     */
    routesLocation: current.background ?? location,
    background: current.background,
    sheetLocation: current.background ? location : null,
    kind: current.background ? chatSheetKind(location.pathname) : null,
    closedCount: current.closed,
    close,
    expand,
  }
}
