import type { ExpoConfig } from 'expo/config'

const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim()

// EAS preview는 개발 서버 없이 실행하는 발표용 APK다. 미설정 주소로 빌드하지 않는다.
if (process.env.EAS_BUILD_PROFILE === 'preview') {
  if (!projectId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new Error('발표용 빌드에는 EXPO_PUBLIC_EAS_PROJECT_ID에 실제 Expo 프로젝트 UUID를 설정해야 합니다.')
  }
  for (const name of ['EXPO_PUBLIC_API_BASE_URL', 'EXPO_PUBLIC_WEB_BASE_URL']) {
    const value = process.env[name]?.trim()
    if (name === 'EXPO_PUBLIC_WEB_BASE_URL' && !value) continue
    let url: URL
    try { url = new URL(value ?? '') } catch {
      throw new Error(`발표용 빌드의 ${name}에 HTTPS origin을 설정해야 합니다.`)
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error(`발표용 빌드의 ${name}는 경로·인증정보·쿼리가 없는 HTTPS origin이어야 합니다.`)
    }
  }
}

const config: ExpoConfig = {
  name: 'GovBiz',
  slug: 'govbiz',
  owner: 'seop1026',
  version: '0.1.0',
  icon: './assets/icon.png',
  scheme: 'govbiz',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  ios: { supportsTablet: true, bundleIdentifier: 'ai.govbiz.mobile' },
  android: { package: 'ai.govbiz.mobile', versionCode: 2,
    adaptiveIcon: { foregroundImage: './assets/icon.png', backgroundColor: '#E7F6ED' },
    ...(process.env.GOOGLE_SERVICES_JSON ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON } : {}) },
  extra: { eas: { projectId } },
  plugins: ['expo-router', 'expo-secure-store', 'expo-web-browser', 'expo-notifications'],
}

export default config
