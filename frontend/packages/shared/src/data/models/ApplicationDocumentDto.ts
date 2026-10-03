import { z } from 'zod'

export const applicationDocumentsSchema = z.array(z.object({
  id: z.number().int().positive(), inputRevision: z.number().int().positive(),
  fileName: z.string().min(1).max(500).regex(/^[^\\/]+\.(hwp|hwpx|pdf|docx|xlsx)$/i).refine((name) => [...name].every((character) => character.charCodeAt(0) >= 32)),
  mediaType: z.enum(['application/pdf', 'application/x-hwp', 'application/hwp+zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
  size: z.number().int().positive().max(32 * 1024 * 1024),
  filledAnswerCount: z.number().int().nonnegative().max(200).nullable(),
  unfilledAnswerCount: z.number().int().nonnegative().max(200).nullable(),
  unfilledAnswers: z.array(z.object({
    fieldId: z.string().min(1).max(129), fieldLabel: z.string().min(1).max(210), value: z.string().min(1).max(2000),
    reason: z.enum(['INPUT_LOCATION_NOT_FOUND', 'AUTO_FILL_UNSUPPORTED', 'OVERFLOW', 'AMBIGUOUS_SLOT', 'SLOT_MISMATCH']),
    capacity: z.number().int().nonnegative().max(100000).nullable().optional(),
  })).max(200),
  remainingExampleCount: z.number().int().nonnegative().max(3000).optional(),
}).superRefine((file, context) => {
  if ((file.filledAnswerCount === null) !== (file.unfilledAnswerCount === null)
    || (file.unfilledAnswerCount !== null && file.unfilledAnswerCount !== file.unfilledAnswers.length)
    || (file.filledAnswerCount === null && file.unfilledAnswers.length > 0)
    || new Set(file.unfilledAnswers.map((answer) => answer.fieldId)).size !== file.unfilledAnswers.length) {
    context.addIssue({ code: 'custom', message: '문서 답변 집계가 일치하지 않습니다.' })
  }
})).max(20)
export const applicationDocumentMigrationConfirmationSchema = z.object({
  status: z.literal('REGENERATION_REQUIRED'),
  preparationId: z.number().int().positive(),
  inputRevision: z.number().int().positive(),
  formVersionId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/),
})
