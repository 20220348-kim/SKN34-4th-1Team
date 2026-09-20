import { z } from 'zod'

import type { SavedSupportProgram } from '../../domain/entities/SavedSupportProgram'
import { supportProgramDtoSchema, toSupportProgram } from './SupportProgramDto'

export const savedSupportProgramDtoSchema = z.object({
  savedAt: z.string().min(1),
  program: supportProgramDtoSchema,
})

export const savedSupportProgramListDtoSchema = z.object({
  programs: z.array(savedSupportProgramDtoSchema),
})

export const savedSupportProgramStatusDtoSchema = z.object({
  saved: z.boolean(),
})

export type SavedSupportProgramDto = z.infer<typeof savedSupportProgramDtoSchema>

export function toSavedSupportProgram(dto: SavedSupportProgramDto): SavedSupportProgram {
  return { savedAt: dto.savedAt, program: toSupportProgram(dto.program) }
}
