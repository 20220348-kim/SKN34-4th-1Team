import { forwardRef, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, Pressable, type PressableProps, type View } from 'react-native'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/** 메뉴와 하단 탭에 짧은 눌림·복귀 움직임을 적용합니다. */
export const MenuPressable = forwardRef<View, PressableProps>(function MenuPressable({ style, onPressIn, onPressOut, disabled, ...props }, ref) {
  const progress = useRef(new Animated.Value(0)).current
  const reduceMotion = useRef(true)
  const [pressed, setPressed] = useState(false)
  useEffect(() => {
    let active = true
    let preferenceChanged = false
    const update = (enabled: boolean) => {
      if (!active) return
      reduceMotion.current = enabled
      if (enabled) { progress.stopAnimation(); progress.setValue(0) }
    }
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', enabled => { preferenceChanged = true; update(enabled) })
    void AccessibilityInfo.isReduceMotionEnabled().then(enabled => { if (!preferenceChanged) update(enabled) }).catch(() => update(true))
    return () => { active = false; subscription.remove(); progress.stopAnimation() }
  }, [progress])
  function animate(down: boolean) {
    progress.stopAnimation()
    if (disabled || reduceMotion.current) { progress.setValue(0); return }
    Animated.timing(progress, { toValue: down ? 1 : 0, duration: down ? 90 : 170,
      easing: Easing.out(Easing.quad), useNativeDriver: true }).start()
  }
  return <AnimatedPressable {...props} ref={ref} disabled={disabled}
    onPressIn={event => { setPressed(true); animate(true); onPressIn?.(event) }}
    onPressOut={event => { setPressed(false); animate(false); onPressOut?.(event) }}
    style={[typeof style === 'function' ? style({ pressed }) : style, {
      transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.98] }) },
        { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) }],
    }]} />
})
