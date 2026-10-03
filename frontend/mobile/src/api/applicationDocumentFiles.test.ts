import { Directory, File } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { clearApplicationFiles, shareApplicationFile } from './applicationDocumentFiles'
jest.mock('expo-file-system', () => ({ Directory: jest.fn(), File: jest.fn(), Paths: { cache: 'file:///app/cache' } }))
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }))
jest.mock('expo-crypto', () => ({ randomUUID: () => '11111111-1111-4111-8111-111111111111' }))
const reader = globalThis.FileReader
const cache = { uri: 'file:///app/cache/application-documents/file.hwpx', exists: false, create: jest.fn(), write: jest.fn(), delete: jest.fn(), copy: jest.fn() }
const destination = { uri: 'content://user-selected-folder' }
beforeEach(() => {
  clearApplicationFiles('owner'); Object.values(cache).forEach(value => { if (typeof value === 'function') value.mockClear() }); cache.exists = false
  cache.create.mockImplementation(() => { cache.exists = true })
  jest.mocked(Directory).mockImplementation(() => ({ create: jest.fn() }) as unknown as Directory)
  Directory.pickDirectoryAsync = jest.fn().mockResolvedValue(destination)
  jest.mocked(File).mockImplementation(() => cache as unknown as File)
  jest.mocked(Sharing.isAvailableAsync).mockResolvedValue(true); jest.mocked(Sharing.shareAsync).mockReset().mockResolvedValue(undefined)
  globalThis.FileReader = class {
    result = new Uint8Array([100, 97, 116, 97]).buffer; onload?: () => void; onerror?: () => void
    readAsArrayBuffer() { this.onload?.() } abort() {}
  } as unknown as typeof FileReader
})
afterEach(() => { clearApplicationFiles('owner'); globalThis.FileReader = reader })
const blob = { size: 4, type: 'application/hwp+zip' } as Blob
test('writes bytes only inside app cache and opens user-initiated sharing', async () => {
  await shareApplicationFile('owner', blob, '사업계획서.hwpx', () => true)
  expect(cache.write).toHaveBeenCalledWith(new Uint8Array([100, 97, 116, 97]))
  expect(Sharing.shareAsync).toHaveBeenCalledWith(cache.uri, expect.objectContaining({ mimeType: 'application/hwp+zip' }))
  clearApplicationFiles('owner'); expect(cache.delete).toHaveBeenCalled()
})
test('account change before bytes are written stops file creation and sharing', async () => {
  await shareApplicationFile('owner', blob, '사업계획서.hwpx', () => false)
  expect(cache.create).not.toHaveBeenCalled(); expect(Sharing.shareAsync).not.toHaveBeenCalled()
})
test('save requires the OS-selected directory and never silently overwrites its existing file', async () => {
  await expect(shareApplicationFile('owner', blob, '사업계획서.hwpx', () => true, undefined, 'save')).rejects.toThrow('같은 이름의 파일')
  expect(Directory.pickDirectoryAsync).toHaveBeenCalled()
  expect(cache.copy).not.toHaveBeenCalled()
})
