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
  clearApplicationFiles('owner'); Object.values(cache).forEach(value => { if (typeof value === 'function') value.mockReset() }); cache.exists = false
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

test('leaving the screen while the folder picker is open prevents the later copy', async () => {
  let finish!: (directory: typeof destination) => void
  Directory.pickDirectoryAsync = jest.fn().mockReturnValue(new Promise(resolve => { finish = resolve }))
  let current = true
  const controller = new AbortController()
  const saving = shareApplicationFile('owner', blob, '사업계획서.hwpx', () => current, controller.signal, 'save')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(Directory.pickDirectoryAsync).toHaveBeenCalled()
  current = false; controller.abort(); finish(destination)
  await saving
  expect(cache.copy).not.toHaveBeenCalled()
  expect(Sharing.shareAsync).not.toHaveBeenCalled()
})

test('saving waits for the native copy and reports an asynchronous copy failure', async () => {
  const target = { exists: false }
  jest.mocked(File).mockReturnValueOnce(cache as unknown as File).mockReturnValueOnce(target as File)
  let finish!: () => void
  cache.copy.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
  let settled = false
  const saving = shareApplicationFile('owner', blob, '사업계획서.hwpx', () => true, undefined, 'save').then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(cache.copy).toHaveBeenCalledWith(target)
  expect(settled).toBe(false)
  finish(); await saving
  expect(settled).toBe(true)
  jest.mocked(File).mockReturnValueOnce(cache as unknown as File).mockReturnValueOnce(target as File)
  cache.copy.mockRejectedValueOnce(new Error('Permission denied'))
  await expect(shareApplicationFile('owner', blob, '사업계획서.hwpx', () => true, undefined, 'save')).rejects.toThrow('파일 저장·공유 화면을 열지 못했어요')
})
