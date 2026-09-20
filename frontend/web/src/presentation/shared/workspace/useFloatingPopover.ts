import { autoUpdate, offset, shift, size, useFloating, type Placement } from '@floating-ui/react-dom'
import type { CSSProperties } from 'react'

/** 목록형 드롭다운은 8줄(40px 기준)까지만 펼치고 그 이상은 안에서 스크롤합니다. */
export const popoverMaxHeightPx = 320

/**
 * 드롭다운·말풍선·메뉴의 위치를 잡는 공용 Hook입니다(Floating UI).
 * 정한 방향(기본 아래)으로만 펼치고 반대편으로 뒤집지 않습니다. 좌우로 화면을 벗어나면 안쪽으로 밀고(shift),
 * 펼치는 방향으로 남은 화면과 최대 높이(기본 8줄) 안에서만 보여 주며 넘치는 내용은 안쪽 스크롤로 감춥니다(size).
 * `position: fixed`라 `overflow: hidden` 부모에도 잘리지 않습니다.
 * 스크롤·창 크기 변화는 열려 있는 동안 자동으로 따라갑니다. CSS 앵커 포지셔닝이 모든 브라우저에 퍼지면 이 훅 안만 바꾸면 됩니다.
 */
export function useFloatingPopover({
  open,
  placement = 'bottom-start',
  maxHeight = popoverMaxHeightPx,
  gap = 6,
  matchReferenceWidth = false,
}: {
  open: boolean
  placement?: Placement
  /** 펼쳐지는 최대 높이(px). 남은 화면이 더 작으면 그만큼만 쓰고 안에서 스크롤합니다. */
  maxHeight?: number
  gap?: number
  /** 계정 메뉴처럼 기준 요소와 같은 폭으로 펼치려면 `true`, 드롭다운처럼 최소한 기준 요소 폭은 되게 하려면 `'min'`입니다. */
  matchReferenceWidth?: boolean | 'min'
}): { reference: (node: HTMLElement | null) => void; floating: (node: HTMLElement | null) => void; floatingStyles: CSSProperties } {
  const { refs, floatingStyles } = useFloating({
    open,
    placement,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(gap),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, availableWidth, rects, elements }) {
          Object.assign(elements.floating.style, {
            // 화면 밖으로 나가는 부분은 그리지 않고, 그만큼은 안쪽 스크롤로 봅니다.
            maxHeight: `${Math.max(48, Math.min(maxHeight, availableHeight))}px`,
            maxWidth: `${Math.max(160, availableWidth)}px`,
            overflowY: 'auto',
            ...(matchReferenceWidth === true ? { width: `${rects.reference.width}px` } : {}),
            ...(matchReferenceWidth === 'min' ? { minWidth: `${rects.reference.width}px` } : {}),
          })
        },
      }),
    ],
  })
  return { reference: refs.setReference, floating: refs.setFloating, floatingStyles }
}
