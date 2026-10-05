import { Directory, File } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { clearApplicationFiles, shareApplicationFile } from './applicationDocumentFiles'
jest.mock('expo-file-system', () => ({ Directory: jest.fn(), File: jest.fn(), Paths: { cache: 'file:///app/cache' } }))
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }))
jest.mock('expo-crypto', () => ({ randomUUID: () => '11111111-1111-4111-8111-111111111111' }))
const reader = globalThis.FileReader
const cache = { uri: 'file:///app/cache/application-documents/file.hwpx', exists: false, create: jest.fn(), write: jest.fn(), delete: jest.fn(), copy: jest.fn() }
const destination = { uri: 'content://user-selected-folder' }
const occupied = new Set<string>()
beforeEach(() => {
  clearApplicationFiles('owner'); occupied.clear()
  Object.values(cache).forEach(value => { if (typeof value === 'function') value.mockReset() }); cache.exists = false
  cache.create.mockImplementation(() => { cache.exists = true })
  cache.copy.mockResolvedValue(undefined)
  jest.mocked(Directory).mockReset().mockImplementation(() => ({ create: jest.fn() }) as unknown as Directory)
  Directory.pickDirectoryAsync = jest.fn().mockResolvedValue(destination)
  jest.mocked(File).mockReset().mockImplementation((base, name) => base === destination ? {
    uri: `${destination.uri}/${name}`, get exists() { return occupied.has(String(name)) },
  } as unknown as File : cache as unknown as File)
  jest.mocked(Sharing.isAvailableAsync).mockReset().mockResolvedValue(true)
  jest.mocked(Sharing.shareAsync).mockReset().mockResolvedValue(undefined)
  globalThis.FileReader = class {
    result = new Uint8Array([100, 97, 116, 97]).buffer; onload?: () => void; onerror?: () => void
    readAsArrayBuffer() { this.onload?.() } abort() {}
  } as unknown as typeof FileReader
})
afterEach(() => { clearApplicationFiles('owner'); globalThis.FileReader = reader })
const blob = { size: 4, type: 'application/hwp+zip' } as Blob

test('writes private cache bytes and reports share sheet closure without claiming the file was saved', async () => {
  await expect(shareApplicationFile('owner', blob, '사업계획서.hwpx', () => true)).resolves.toEqual({ status: 'shareClosed' })
  expect(cache.write).toHaveBeenCalledWith(new Uint8Array([100, 97, 116, 97]))
  expect(Sharing.shareAsync).toHaveBeenCalledWith(cache.uri, expect.objectContaining({ mimeType: 'application/hwp+zip' }))
  clearApplicationFiles('owner'); expect(cache.delete).toHaveBeenCalled()
})

test('account change before bytes are written stops file creation and returns cancellation', async () => {
  await expect(shareApplicationFile('owner', blob, '사업계획서.hwpx', () => false)).resolves.toEqual({ status: 'cancelled' })
  expect(cache.create).not.toHaveBeenCalled(); expect(Sharing.shareAsync).not.toHaveBeenCalled()
})

test('save uses the OS-selected folder, preserves the original extension and explicitly disables overwrite', async () => {
  await expect(shareApplicationFile('owner', blob, '사업계획서.HWPX', () => true, undefined, 'save')).resolves.toEqual({
    status: 'saved', fileName: '사업계획서.HWPX', renamed: false,
  })
  expect(Directory.pickDirectoryAsync).toHaveBeenCalledTimes(1)
  expect(cache.copy).toHaveBeenCalledWith(expect.objectContaining({ uri: `${destination.uri}/사업계획서.HWPX` }), { overwrite: false })
  expect(Sharing.shareAsync).not.toHaveBeenCalled()
})

test('existing original and numbered filenames are skipped without copying over them', async () => {
  occupied.add('사업계획서.hwpx'); occupied.add('사업계획서 (1).hwpx')
  await expect(shareApplicationFile('owner', blob, '사업계획서.hwpx', () => true, undefined, 'save')).resolves.toEqual({
    status: 'saved', fileName: '사업계획서 (2).hwpx', renamed: true,
  })
  expect(cache.copy).toHaveBeenCalledTimes(1)
  expect(cache.copy).toHaveBeenCalledWith(expect.objectContaining({ uri: `${destination.uri}/사업계획서 (2).hwpx` }), { overwrite: false })
  expect(occupied.has('사업계획서.hwpx')).toBe(true)
})

test('only a native destination collision during copy retries another filename', async () => {
  cache.copy.mockRejectedValueOnce(Object.assign(new Error('Destination already exists'), { code: 'ERR_DESTINATION_ALREADY_EXISTS' }))
  await expect(shareApplicationFile('owner', blob, '사업계획서.hwpx', () => true, undefined, 'save')).resolves.toEqual({
    status: 'saved', fileName: '사업계획서 (1).hwpx', renamed: true,
  })
  expect(cache.copy).toHaveBeenCalledTimes(2)
  expect(cache.copy).toHaveBeenLastCalledWith(expect.objectContaining({ uri: `${destination.uri}/사업계획서 (1).hwpx` }), { overwrite: false })
})

test.each(['ERR_PICKER_CANCELLED', 'ERR_FILE_PICKING_CANCELLED'])('known folder picker cancellation %s returns without copying', async code => {
  Directory.pickDirectoryAsync = jest.fn().mockRejectedValue(Object.assign(new Error('Cancelled'), { code }))
  await expect(shareApplicationFile('owner', blob, '사업계획서.hwpx', () => true, undefined, 'save')).resolves.toEqual({ status: 'cancelled' })
  expect(cache.copy).not.toHaveBeenCalled()
})

test('unrecognized folder picker failures stay errors instead of becoming cancellation', async () => {
  Directory.pickDirectoryAsync = jest.fn().mockRejectedValue(Object.assign(new Error('Permission denied'), { code: 'ERR_INVALID_PERMISSION' }))
  await expect(shareApplicationFile('owner', blob, '사업계획서.hwpx', () => true, undefined, 'save')).rejects.toThrow('저장할 폴더를 열지 못했어요')
  expect(cache.copy).not.toHaveBeenCalled()
})

test('leaving the screen while the folder picker is open prevents the later copy', async () => {
  let finish!: (directory: typeof destination) => void
  Directory.pickDirectoryAsync = jest.fn().mockReturnValue(new Promise(resolve => { finish = resolve }))
  let current = true
  const controller = new AbortController()
  const saving = shareApplicationFile('owner', blob, '사업계획서.hwpx', () => current, controller.signal, 'save')
  await new Promise(resolve => setTimeout(resolve, 0))
  current = false; controller.abort(); finish(destination)
  await expect(saving).resolves.toEqual({ status: 'cancelled' })
  expect(cache.copy).not.toHaveBeenCalled(); expect(Sharing.shareAsync).not.toHaveBeenCalled()
})

test('saving waits for native copying and real copy failures never retry as a successful rename', async () => {
  let finish!: () => void
  cache.copy.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
  let settled = false
  const saving = shareApplicationFile('owner', blob, '사업계획서.hwpx', () => true, undefined, 'save').then(result => { settled = true; return result })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(settled).toBe(false)
  finish(); await expect(saving).resolves.toEqual({ status: 'saved', fileName: '사업계획서.hwpx', renamed: false })
  cache.copy.mockClear().mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'ERR_INVALID_PERMISSION' }))
  await expect(shareApplicationFile('owner', blob, '사업계획서.hwpx', () => true, undefined, 'save')).rejects.toThrow('파일을 저장하지 못했어요')
  expect(cache.copy).toHaveBeenCalledTimes(1)
})

test('account change while copying suppresses its later success result', async () => {
  let finish!: () => void
  cache.copy.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
  let current = true
  const saving = shareApplicationFile('owner', blob, '사업계획서.hwpx', () => current, undefined, 'save')
  await new Promise(resolve => setTimeout(resolve, 0))
  current = false; finish()
  await expect(saving).resolves.toEqual({ status: 'cancelled' })
})

test('temporary file preparation failures do not open the destination picker', async () => {
  cache.write.mockImplementationOnce(() => { throw new Error('No space') })
  await expect(shareApplicationFile('owner', blob, '사업계획서.hwpx', () => true, undefined, 'save')).rejects.toThrow('내려받은 파일을 준비하지 못했어요')
  expect(Directory.pickDirectoryAsync).not.toHaveBeenCalled()
})
