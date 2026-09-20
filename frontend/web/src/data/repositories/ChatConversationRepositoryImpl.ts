import { z } from 'zod'
import type { ChatConversationSnapshot } from '../../domain/entities/ChatConversation'
import type { ChatConversationRepository } from '../../domain/repositories/ChatConversationRepository'
import { chatConversationRequest } from '../api/chatConversationApi'
import { chatConversationDetailSchema, chatConversationPageSchema, chatConversationSummarySchema, chatConversationSnapshotSchema } from '../models/ChatConversationDto'

export class ChatConversationRepositoryImpl implements ChatConversationRepository {
  delete(accountEmail: string, id: string, signal?: AbortSignal) {
    return chatConversationRequest(accountEmail, `/${encodeURIComponent(id)}`, z.void(), signal, undefined, 'DELETE')
  }
  list(accountEmail: string, before: number | null, signal?: AbortSignal) { return chatConversationRequest(accountEmail, before === null ? '' : `?before=${before}`, chatConversationPageSchema, signal) }
  async get(accountEmail: string, id: string, signal?: AbortSignal) {
    const detail = await chatConversationRequest(accountEmail, `/${encodeURIComponent(id)}`, chatConversationDetailSchema, signal)
    if (detail.conversation.id !== id) throw new Error('다른 대화 기록이 반환되었습니다.')
    return detail
  }
  async save(accountEmail: string, id: string, expectedVersion: number, snapshot: ChatConversationSnapshot, signal?: AbortSignal) {
    const summary = await chatConversationRequest(accountEmail, `/${encodeURIComponent(id)}`, chatConversationSummarySchema, signal,
      { expectedVersion, snapshot: chatConversationSnapshotSchema.parse(snapshot) })
    if (summary.id !== id) throw new Error('다른 대화 저장 결과가 반환되었습니다.')
    return summary
  }
}
