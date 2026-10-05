import type { File } from 'expo-file-system'
import * as Crypto from 'expo-crypto'

const createdFiles = new Map<string, File[]>()
export type ApplicationFileResult = { status: 'saved'; fileName: string; renamed: boolean }
  | { status: 'shareClosed' } | { status: 'cancelled' }

function nativeErrorCode(cause: unknown): string | undefined {
  return cause !== null && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined
}
function bytes(blob: Blob, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const abort = () => { signal?.removeEventListener('abort', abort); reader.abort(); reject(new Error('파일 저장을 취소했어요.')) }
    reader.onerror = () => { signal?.removeEventListener('abort', abort); reject(new Error('내려받은 파일을 읽지 못했어요.')) }
    reader.onload = () => {
      signal?.removeEventListener('abort', abort)
      if (!(reader.result instanceof ArrayBuffer)) { reject(new Error('내려받은 파일 형식을 확인하지 못했어요.')); return }
      resolve(new Uint8Array(reader.result))
    }
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    reader.readAsArrayBuffer(blob)
  })
}

/** 비공개 임시 파일을 준비하고 OS 폴더 저장·공유 화면 종료·취소 결과를 반환합니다. */
export async function shareApplicationFile(owner: string, blob: Blob, fileName: string, isCurrent: () => boolean, signal?: AbortSignal, mode: 'save' | 'share' = 'share'): Promise<ApplicationFileResult> {
  const current = () => !signal?.aborted && isCurrent()
  if (!current()) return { status: 'cancelled' }
  if (!/^[^\\/]+\.(hwp|hwpx|pdf|docx|xlsx|zip|txt)$/i.test(fileName) || Array.from(fileName).some(character => character.charCodeAt(0) < 32)
    || !blob.size || blob.size > 32 * 1024 * 1024) throw new Error('내려받을 파일을 확인하지 못했어요.')
  // Metro의 지연 require로 실제 저장 동작에서만 기기 모듈을 읽는다.
  const { Directory, File, Paths } = require('expo-file-system') as typeof import('expo-file-system')
  const Sharing = require('expo-sharing') as typeof import('expo-sharing')
  if (mode === 'share') {
    const available = await Sharing.isAvailableAsync()
    if (!current()) return { status: 'cancelled' }
    if (!available) throw new Error('이 환경에서는 파일 공유를 사용할 수 없어요. 설치된 앱에서 다시 시도해 주세요.')
  }
  let content: Uint8Array
  try { content = await bytes(blob, signal) }
  catch (cause) { if (!current()) return { status: 'cancelled' }; throw cause }
  if (!current()) return { status: 'cancelled' }
  if (content.byteLength !== blob.size) throw new Error('내려받은 파일 크기를 확인하지 못했어요. 다시 시도해 주세요.')
  const directory = new Directory(Paths.cache, 'application-documents', Crypto.randomUUID())
  const suffix = fileName.slice(fileName.lastIndexOf('.'))
  const stem = fileName.slice(0, fileName.lastIndexOf('.')).slice(0, 120)
  const name = stem + suffix
  const file = new File(directory, name)
  try { directory.create({ intermediates: true }); file.create(); file.write(content) }
  catch { throw new Error('내려받은 파일을 준비하지 못했어요. 기기 저장 공간을 확인하고 다시 시도해 주세요.') }
  createdFiles.set(owner, [...(createdFiles.get(owner) ?? []), file])
  if (!current()) { file.delete(); return { status: 'cancelled' } }
  if (mode === 'share') {
    try { await Sharing.shareAsync(file.uri, { dialogTitle: fileName, mimeType: blob.type, UTI: 'public.data' }) }
    catch { if (!current()) return { status: 'cancelled' }; throw new Error('파일 공유 화면을 열지 못했어요. 다시 시도해 주세요.') }
    return { status: current() ? 'shareClosed' : 'cancelled' }
  }
  let destination: InstanceType<typeof Directory>
  try { destination = await Directory.pickDirectoryAsync() }
  catch (cause) {
    const code = nativeErrorCode(cause)
    if (!current() || code === 'ERR_PICKER_CANCELLED' || code === 'ERR_FILE_PICKING_CANCELLED') return { status: 'cancelled' }
    throw new Error('저장할 폴더를 열지 못했어요. 폴더 접근 권한을 확인하고 다시 시도해 주세요.')
  }
  for (let index = 0; index < 1000; index++) {
    if (!current()) return { status: 'cancelled' }
    const tag = index ? ` (${index})` : ''
    const savedName = stem.slice(0, 120 - tag.length) + tag + suffix
    const saved = new File(destination, savedName)
    if (saved.exists) continue
    try { await file.copy(saved, { overwrite: false }) }
    catch (cause) {
      if (!current()) return { status: 'cancelled' }
      // 존재 확인 뒤 다른 저장이 먼저 완료돼도 기존 파일을 보존합니다.
      if (nativeErrorCode(cause) === 'ERR_DESTINATION_ALREADY_EXISTS') continue
      throw new Error('파일을 저장하지 못했어요. 선택한 폴더의 접근 권한과 저장 공간을 확인해 주세요.')
    }
    if (!current()) return { status: 'cancelled' }
    return { status: 'saved', fileName: savedName, renamed: index > 0 }
  }
  throw new Error('사용할 수 있는 파일 이름을 찾지 못했어요. 다른 폴더를 선택해 주세요.')
}
export function clearApplicationFiles(owner: string) {
  for (const file of createdFiles.get(owner) ?? []) if (file.exists) file.delete()
  createdFiles.delete(owner)
}
