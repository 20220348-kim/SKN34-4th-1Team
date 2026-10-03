import { expect, test } from 'vitest'
import { applicationDocumentsSchema, applicationDocumentMigrationConfirmationSchema } from './ApplicationDocumentDto'
import { applicationFormAvailabilitySchema } from './ApplicationPreparationDto'
const file = { id: 1, inputRevision: 1, fileName: '사업계획서.hwpx', mediaType: 'application/hwp+zip', size: 120,
  filledAnswerCount: 1, unfilledAnswerCount: 1, unfilledAnswers: [{ fieldId: 'company:goal', fieldLabel: '추진 목표', value: '생산 개선', reason: 'AUTO_FILL_UNSUPPORTED' }] }
test('shared document contract keeps unfilled snapshot counts consistent and rejects path traversal', () => {
  expect(applicationDocumentsSchema.parse([file])[0].unfilledAnswers[0].value).toBe('생산 개선')
  expect(applicationDocumentsSchema.safeParse([{ ...file, unfilledAnswerCount: 0 }]).success).toBe(false)
  expect(applicationDocumentsSchema.safeParse([{ ...file, fileName: '../secret.hwpx' }]).success).toBe(false)
})
test('migration and availability remain explicit producer contracts', () => {
  expect(applicationDocumentMigrationConfirmationSchema.safeParse({ status: 'SUCCESS', preparationId: 1, inputRevision: 1 }).success).toBe(false)
  expect(applicationFormAvailabilitySchema.parse({ state: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', status: 'NO_FORM', reasonCode: 'NO_FORM', attemptCount: 1, nextRetryAt: null }, forms: { items: [] } }).state.status).toBe('NO_FORM')
})

test('preserves current producer overflow, slot mismatch and remaining example metadata', () => {
  for (const reason of ['OVERFLOW', 'AMBIGUOUS_SLOT', 'SLOT_MISMATCH']) {
    const updated = { ...file, remainingExampleCount: 2, unfilledAnswers: [{ ...file.unfilledAnswers[0], reason, capacity: 12 }] }
    expect(applicationDocumentsSchema.parse([updated])[0]).toEqual(updated)
  }
  expect(applicationDocumentsSchema.safeParse([{ ...file, remainingExampleCount: -1 }]).success).toBe(false)
  expect(applicationDocumentsSchema.safeParse([{ ...file, unfilledAnswers: [{ ...file.unfilledAnswers[0], capacity: -1 }] }]).success).toBe(false)
})
