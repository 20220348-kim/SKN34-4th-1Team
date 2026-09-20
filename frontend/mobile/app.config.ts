import type { ExpoConfig } from 'expo/config'

const config: ExpoConfig = {
  name: 'GovBiz',
  slug: 'govbiz-mobile',
  version: '0.1.0',
  scheme: 'govbiz',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  ios: { supportsTablet: true, bundleIdentifier: 'ai.govbiz.mobile' },
  android: { package: 'ai.govbiz.mobile' },
  plugins: ['expo-router', 'expo-secure-store', 'expo-web-browser'],
}

export default config
