import type { ApplicationDocument } from './ApplicationPreparation'

const formatLabels: Record<string, string> = {
  'application/x-hwp': 'HWP',
  'application/hwp+zip': 'HWPX',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/pdf': 'PDF',
}

export function applicationDocumentFileFormat(file: ApplicationDocument): string {
  return formatLabels[file.mediaType] ?? file.fileName.split('.').pop()?.toUpperCase() ?? ''
}

/** 최신 생성 문서와 이전 답변 버전의 파일을 분리합니다. */
export function applicationDocumentFileGroups(files: readonly ApplicationDocument[]) {
  const latestRevision = files.length > 0 ? Math.max(...files.map(file => file.inputRevision)) : null
  const latestFiles = files.filter(file => file.inputRevision === latestRevision)
  const previousFiles = files.filter(file => file.inputRevision !== latestRevision)
  const previousRevisions = [...new Set(previousFiles.map(file => file.inputRevision))].sort((a, b) => b - a)
  return { latestRevision, latestFiles, previousFiles, previousRevisions }
}
