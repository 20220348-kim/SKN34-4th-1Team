import { z } from 'zod'

import type { SampleItem } from '../../../../domain/entities/SampleItem'

export const sampleItemFormSchema = z.object({
  name: z.string().trim().min(1, '이름을 입력하세요.').max(100, '이름은 100자 이하여야 합니다.'),
  category: z.union([z.literal(''), z.enum(['BASIC', 'EXTENDED'])]),
  note: z.string().max(500, '메모는 500자 이하여야 합니다.'),
})

export type SampleItemFormValues = z.infer<typeof sampleItemFormSchema>

/** Hook·Redux 예제가 동일한 입력 정규화 규칙을 사용하도록 Domain 입력으로 변환합니다. */
export function toSampleItem(values: SampleItemFormValues): SampleItem {
  const note = values.note.trim()

  return {
    name: values.name.trim(),
    category: values.category || null,
    note: note === '' ? null : note,
  }
}
