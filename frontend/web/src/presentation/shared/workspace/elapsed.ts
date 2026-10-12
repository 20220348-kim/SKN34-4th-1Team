import { useEffect, useState } from 'react'

/** "42초 지남", "1분 12초 지남"처럼 돌아가는 작업의 경과 시간을 적습니다. 예상 시간은 맞지 않을 수 있어 적지 않습니다. */
export function elapsedLabel(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safe / 60)
  return minutes > 0 ? `${minutes}분 ${safe % 60}초 지남` : `${safe}초 지남`
}

/** [since]부터 지난 초입니다. [active]인 동안 1초마다 다시 세고, 시각을 읽지 못하면 null입니다. */
export function useElapsedSeconds(since: string | null | undefined, active: boolean): number | null {
  const start = since ? Date.parse(since) : Number.NaN
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || Number.isNaN(start)) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, start])
  return Number.isNaN(start) ? null : Math.max(0, Math.floor((now - start) / 1000))
}
