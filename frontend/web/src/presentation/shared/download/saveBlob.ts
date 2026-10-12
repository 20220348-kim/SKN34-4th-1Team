/** 받은 파일을 브라우저 다운로드로 저장합니다. 임시 주소는 다운로드가 시작된 뒤 지웁니다. */
export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = fileName
  document.body.appendChild(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
