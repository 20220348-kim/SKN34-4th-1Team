jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default)

beforeEach(() => {
  jest.spyOn(require('react-native').AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
})
