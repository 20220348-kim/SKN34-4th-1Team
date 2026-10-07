import { expect, it } from 'vitest'
import type { ApplicationDocument } from './ApplicationPreparation'
import { applicationDocumentFileGroups } from './ApplicationDocumentFiles'

const file = (id: number, inputRevision: number): ApplicationDocument => ({
  id, inputRevision, fileName: `문서-${id}.hwpx`, mediaType: 'application/hwp+zip', size: 4,
  filledAnswerCount: null, unfilledAnswerCount: null, unfilledAnswers: [],
})

it('selects one latest answer version from an unordered response and keeps older groups separate', () => {
  const files = Object.freeze([file(50, 1), file(90, 3), file(80, 2), file(91, 3), file(81, 2)])
  const groups = applicationDocumentFileGroups(files)
  expect(groups.latestRevision).toBe(3)
  expect(groups.latestFiles.map(item => item.id)).toEqual([90, 91])
  expect(groups.previousFiles.map(item => item.id)).toEqual([50, 80, 81])
  expect(groups.previousRevisions).toEqual([2, 1])
  expect(files.map(item => item.id)).toEqual([50, 90, 80, 91, 81])
})

it('keeps a single latest file as a direct download even when older files also exist', () => {
  const groups = applicationDocumentFileGroups([file(11, 1), file(12, 2), file(13, 1)])
  expect(groups.latestRevision).toBe(2)
  expect(groups.latestFiles.map(item => item.id)).toEqual([12])
  expect(groups.previousRevisions).toEqual([1])
})

it('has no download target before any document has been generated', () => {
  expect(applicationDocumentFileGroups([])).toEqual({
    latestRevision: null, latestFiles: [], previousFiles: [], previousRevisions: [],
  })
})
