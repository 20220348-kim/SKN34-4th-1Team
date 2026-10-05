import { z } from 'zod'

import type { AdminAuditLogPage } from '../../domain/entities/AdminAuditLog'

const positiveIdSchema = z.number().int().positive()

export const adminAuditLogRecordDtoSchema = z.object({
  id: positiveIdSchema,
  action: z.enum([
    'ACCOUNT_LIST',
    'ACCOUNT_DETAIL',
    'ACCOUNT_SUSPEND',
    'ACCOUNT_UNSUSPEND',
    'ACCOUNT_SESSIONS_REVOKE',
    'ACCOUNT_ADMIN_GRANT',
    'ACCOUNT_ADMIN_REVOKE',
    'AUDIT_LOG_LIST',
  ]),
  actorAccountId: positiveIdSchema,
  actorEmail: z.string().min(1).nullable(),
  targetAccountId: positiveIdSchema.nullable(),
  requestSummary: z.string().min(1).nullable(),
  clientIp: z.string().min(1),
  userAgent: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
})

export const adminAuditLogListDtoSchema = z.object({
  records: z.array(adminAuditLogRecordDtoSchema),
  nextCursor: positiveIdSchema.nullable(),
})

export type AdminAuditLogRecordDto = z.infer<typeof adminAuditLogRecordDtoSchema>
export type AdminAuditLogListDto = z.infer<typeof adminAuditLogListDtoSchema>

/** DTO를 복사해 View가 외부 HTTP 응답 객체를 직접 보유하지 않게 합니다. */
export function toAdminAuditLogPage(dto: AdminAuditLogListDto): AdminAuditLogPage {
  return {
    records: dto.records.map((record) => ({ ...record })),
    nextCursor: dto.nextCursor,
  }
}
