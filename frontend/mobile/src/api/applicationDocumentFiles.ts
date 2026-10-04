import type { File } from 'expo-file-system'
import * as Crypto from 'expo-crypto'

const createdFiles = new Map<string, File[]>()
function bytes(blob: Blob, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const abort = () => { reader.abort(); reject(new Error('파일 저장을 취소했어요.')) }
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

/** 기기 비공개 임시 영역에만 저장한다. 세션이 바뀌면 공유하지 않고 이번 파일을 지운다. */
export async function shareApplicationFile(owner: string, blob: Blob, fileName: string, isCurrent: () => boolean, signal?: AbortSignal, mode: 'save' | 'share' = 'share') {
  if (!/^[^\\/]+\.(hwp|hwpx|pdf|docx|xlsx|zip|txt)$/i.test(fileName) || Array.from(fileName).some(character => character.charCodeAt(0) < 32)
    || !blob.size || blob.size > 32 * 1024 * 1024) throw new Error('내려받을 파일을 확인하지 못했어요.')
  // Metro의 지연 require로 실제 저장 동작에서만 기기 모듈을 읽는다.
  const { Directory, File, Paths } = require('expo-file-system') as typeof import('expo-file-system')
  const Sharing = require('expo-sharing') as typeof import('expo-sharing')
  if (mode === 'share' && !await Sharing.isAvailableAsync()) throw new Error('이 환경에서는 파일 공유를 사용할 수 없어요. 설치된 앱에서 다시 시도해 주세요.')
  const content = await bytes(blob, signal)
  if (signal?.aborted || !isCurrent()) return
  if (content.byteLength !== blob.size) throw new Error('내려받은 파일 크기를 확인하지 못했어요. 다시 시도해 주세요.')
  const directory = new Directory(Paths.cache, 'application-documents', Crypto.randomUUID())
  directory.create({ intermediates: true })
  const suffix = fileName.slice(fileName.lastIndexOf('.'))
  const name = fileName.slice(0, fileName.lastIndexOf('.')).slice(0, 120) + suffix
  const file = new File(directory, name)
  file.create(); file.write(content)
  createdFiles.set(owner, [...(createdFiles.get(owner) ?? []), file])
  if (signal?.aborted || !isCurrent()) { file.delete(); return }
  let duplicate = false
  try {
    if (mode === 'save') {
      const destination = await Directory.pickDirectoryAsync()
      if (signal?.aborted || !isCurrent()) return
      const saved = new File(destination, name)
      if (saved.exists) { duplicate = true; throw new Error('Existing document file') }
      await file.copy(saved)
    } else await Sharing.shareAsync(file.uri, { dialogTitle: fileName, mimeType: blob.type, UTI: 'public.data' })
  }
  catch { throw new Error(duplicate ? '선택한 폴더에 같은 이름의 파일이 있어요. 다른 폴더를 선택해 주세요.' : '파일 저장·공유 화면을 열지 못했어요. 다시 시도해 주세요.') }
}
export function clearApplicationFiles(owner: string) {
  for (const file of createdFiles.get(owner) ?? []) if (file.exists) file.delete()
  createdFiles.delete(owner)
}
