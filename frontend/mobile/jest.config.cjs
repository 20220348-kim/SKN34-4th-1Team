const expoPreset = require('jest-expo/jest-preset')
const [babelJest, babelOptions] = expoPreset.transform['\\.[jt]sx?$']

module.exports = {
  preset: 'jest-expo',
  transform: {
    // Jest's CommonJS VM cannot execute the device helper's native import() callback.
    // Keep production loading lazy and scope the test transform to that helper.
    '[/\\\\]src[/\\\\]notifications[/\\\\]device\\.ts$': [babelJest, {
      ...babelOptions, plugins: [require.resolve('./src/test/transformDeviceImport.cjs')],
    }],
    ...expoPreset.transform,
  },
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.cjs'],
  testMatch: ['<rootDir>/src/**/*.test.[jt]s?(x)'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|expo-.*|@react-navigation/.*|standard-navigation|@govbiz/.*|\\.pnpm/))',
  ],
  clearMocks: true,
}
