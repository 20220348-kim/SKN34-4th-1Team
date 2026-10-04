import { useEffect, useState } from 'react'
import { AppState } from 'react-native'

/** 반복 조회는 화면 포커스와 별도로 앱의 전경 상태도 확인한다. */
export function useAppForeground() {
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive')
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'))
    return () => subscription.remove()
  }, [])
  return foreground
}
