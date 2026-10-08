import { useCallback, useState } from 'react'
import { Platform, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'

/** iOS의 위쪽 새로고침 당기기는 허용하고, 본문을 내려간 뒤의 끝 탄성은 막습니다. */
export function useScrollBoundary(refreshable = false) {
  const [refreshBounce, setRefreshBounce] = useState(refreshable)
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (event.nativeEvent.contentOffset.y > 0) setRefreshBounce(false)
  }, [])
  const onScrollBeginDrag = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setRefreshBounce(refreshable && event.nativeEvent.contentOffset.y <= 0)
  }, [refreshable])
  const iosRefresh = Platform.OS === 'ios' && refreshable
  return {
    // 헤더·탭·Page가 안전 영역을 소유하므로 ScrollView에 자동 여백을 더하지 않습니다.
    contentInsetAdjustmentBehavior: 'never' as const,
    automaticallyAdjustContentInsets: false,
    bounces: iosRefresh && refreshBounce,
    alwaysBounceVertical: iosRefresh,
    overScrollMode: 'never' as const,
    scrollEventThrottle: 16,
    onScroll: iosRefresh ? onScroll : undefined,
    onScrollBeginDrag: iosRefresh ? onScrollBeginDrag : undefined,
  }
}
