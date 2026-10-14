import type { ExpoConfig } from 'expo/config'

const environmentKeys = [
  'EAS_BUILD_PROFILE', 'EXPO_PUBLIC_API_BASE_URL', 'EXPO_PUBLIC_WEB_BASE_URL',
  'EXPO_PUBLIC_EAS_PROJECT_ID', 'GOOGLE_SERVICES_JSON',
] as const
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]))
const projectId = '4a9a2a74-3122-4e8a-9b40-4d6d7810d7bb'

function readConfig(): ExpoConfig {
  let config: ExpoConfig | undefined
  jest.isolateModules(() => { config = require('../../app.config').default as ExpoConfig })
  if (!config) throw new Error('App config was not loaded')
  return config
}

beforeEach(() => {
  for (const key of environmentKeys) delete process.env[key]
})
afterEach(() => {
  for (const key of environmentKeys) {
    if (originalEnvironment[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnvironment[key]
  }
})

test('local development and CI export can load without an Expo project', () => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://192.168.1.10:8080'
  const config = readConfig()
  expect(config.android?.package).toBe('ai.govbiz.mobile')
  expect(config.extra?.eas.projectId).toBeUndefined()
})

test('native launchers use an opaque default icon and a separate transparent adaptive foreground', () => {
  const config = readConfig()
  expect(config.icon).toBe('./assets/icon.png')
  expect(config.android?.adaptiveIcon).toEqual({ foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#E7F6ED' })
  expect(config.android?.versionCode).toBe(7)
  const fs = jest.requireActual<{ readFileSync(path: string): Uint8Array }>('node:fs')
  const assets = [
    { path: config.icon!, colorType: 2 },
    { path: config.android!.adaptiveIcon!.foregroundImage!, colorType: 6 },
  ]
  for (const asset of assets) {
    const png = fs.readFileSync(asset.path)
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const header = new DataView(png.buffer, png.byteOffset, png.byteLength)
    expect(header.getUint32(16)).toBe(header.getUint32(20))
    expect(header.getUint32(16)).toBeGreaterThanOrEqual(1024)
    expect(png[25]).toBe(asset.colorType)
  }
})

describe('presentation APK configuration', () => {
  beforeEach(() => {
    process.env.EAS_BUILD_PROFILE = 'preview'
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = projectId
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'
  })

  test.each([undefined, '', 'firebase-project', '1:123:android:abc'])('rejects missing or non-Expo project ID %s', (value) => {
    if (value === undefined) delete process.env.EXPO_PUBLIC_EAS_PROJECT_ID
    else process.env.EXPO_PUBLIC_EAS_PROJECT_ID = value
    expect(readConfig).toThrow('EXPO_PUBLIC_EAS_PROJECT_ID')
  })

  test.each([
    undefined, '', 'not-a-url', 'http://192.168.1.10:8080', 'http://api.example.test',
    'https://api.example.test/api', 'https://api.example.test/?token=private',
    'https://api.example.test/#private', 'https://user:password@api.example.test',
  ])('rejects a release API origin that would fail the native boundary: %s', (value) => {
    if (value === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL
    else process.env.EXPO_PUBLIC_API_BASE_URL = value
    expect(readConfig).toThrow('EXPO_PUBLIC_API_BASE_URL')
  })

  test('allows an omitted sharing origin and passes the real project and FCM config to Expo', () => {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = ` ${projectId} `
    process.env.GOOGLE_SERVICES_JSON = '/build/credentials/google-services.json'
    const config = readConfig()
    expect(config.extra?.eas.projectId).toBe(projectId)
    expect(config.android?.googleServicesFile).toBe('/build/credentials/google-services.json')
  })

  test.each(['http://web.example.test', 'https://web.example.test/app', 'https://web.example.test/?query=x'])('rejects an unsafe sharing origin: %s', (value) => {
    process.env.EXPO_PUBLIC_WEB_BASE_URL = value
    expect(readConfig).toThrow('EXPO_PUBLIC_WEB_BASE_URL')
  })

  test('accepts separate HTTPS API and sharing origins', () => {
    process.env.EXPO_PUBLIC_WEB_BASE_URL = 'https://web.example.test'
    expect(() => readConfig()).not.toThrow()
  })
})
