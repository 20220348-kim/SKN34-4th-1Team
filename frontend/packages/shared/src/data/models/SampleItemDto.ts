import { z } from 'zod'

export const sampleCategoryDtoSchema = z.enum(['BASIC', 'EXTENDED'])

export const sampleItemDtoSchema = z.object({
  name: z.string(),
  category: sampleCategoryDtoSchema.nullable(),
  note: z.string().nullable(),
})

export const sampleItemPreparationDtoSchema = z.object({
  phase: z.literal('READY_FOR_PROCESSING'),
  item: sampleItemDtoSchema,
  processing: z.object({
    status: z.literal('NOT_STARTED'),
  }),
})

export type SampleItemPreparationDto = z.infer<typeof sampleItemPreparationDtoSchema>
