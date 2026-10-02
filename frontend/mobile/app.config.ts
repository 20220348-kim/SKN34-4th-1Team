import type { ExpoConfig } from 'expo/config'

const config: ExpoConfig = {
  name: 'GovBiz',
  slug: 'govbiz-mobile',
  version: '0.1.0',
  scheme: 'govbiz',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  ios: { supportsTablet: true, bundleIdentifier: 'ai.govbiz.mobile' },
  android: { package: 'ai.govbiz.mobile',
    ...(process.env.GOOGLE_SERVICES_JSON ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON } : {}) },
  extra: { eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID } },
  plugins: ['expo-router', 'expo-secure-store', 'expo-web-browser', 'expo-notifications'],
}

export default config
