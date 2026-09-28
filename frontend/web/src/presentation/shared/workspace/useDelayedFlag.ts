import { useEffect, useState } from 'react'

/**
 * `active`가 켜진 뒤 `delayMs`가 지나야 true가 됩니다. 짧게 끝나는 불러오기에 표시가 깜빡이지 않게 할 때 씁니다.
 * 300ms 안에 끝나는 요청은 표시 없이 지나가고, 그보다 길면 자리 잡은 스켈레톤이 보입니다.
 */
export function useDelayedFlag(active: boolean, delayMs = 300): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) { setShown(false); return }
    const timer = setTimeout(() => setShown(true), delayMs)
    return () => clearTimeout(timer)
  }, [active, delayMs])
  return active && shown
}
