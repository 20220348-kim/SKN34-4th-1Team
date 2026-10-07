import { z } from 'zod'

/** 공고 원문이 직접 연결한 첨부 한 건입니다. 원본 주소 대신 index로 Core에서 받습니다. */
export const supportProgramAttachmentDtoSchema = z.object({
  index: z.number().int().min(0),
  fileName: z.string().trim().min(1).max(300),
  extension: z.string().max(10),
})

export const supportProgramAttachmentListDtoSchema = z.object({
  items: z.array(supportProgramAttachmentDtoSchema).max(30),
})

export type SupportProgramAttachmentDto = z.infer<typeof supportProgramAttachmentDtoSchema>
