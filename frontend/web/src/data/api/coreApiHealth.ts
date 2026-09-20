import { z } from 'zod'

/** Spring Boot GET /api/v1/health 응답의 프런트엔드 계약입니다. */
export const coreApiHealthSchema = z.object({
  status: z.string(),
  service: z.string(),
})

export type CoreApiHealth = z.infer<typeof coreApiHealthSchema>
