import { z } from 'zod'
import type { ChatConversationDetail, ChatConversationSnapshot } from '@govbiz/shared/domain/entities/ChatConversation'
import { chatConversationDetailSchema, chatConversationPageSchema, chatConversationSnapshotSchema, chatConversationSummarySchema } from '@govbiz/shared/data/models/ChatConversationDto'
import { toSupportProgram } from '@govbiz/shared/data/models/SupportProgramDto'
import { ApiError, createApiFetch, getApiBaseUrl } from './client'

async function request<T>(token: string, email: string, path: string, schema: z.ZodType<T>, signal?: AbortSignal, body?: unknown,
  method: 'GET' | 'PUT' | 'DELETE' = body === undefined ? 'GET' : 'PUT'): Promise<T> {
  const response = await createApiFetch(token)(`${getApiBaseUrl()}/api/v1/me/chat-conversations${path}`, {
    method, cache: 'no-store', signal,
    headers: { Accept: 'application/json', 'X-Chat-Account': encodeURIComponent(email),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new ApiError(response.status, response.status === 409
    ? '다른 화면에서 이 대화가 변경됐어요. 대화 기록에서 다시 열어 주세요.'
    : '대화 기록을 처리하지 못했어요. 다시 시도해 주세요.')
  if (method === 'DELETE') {
    if (response.status !== 204) throw new Error('올바르지 않은 대화 삭제 응답입니다.')
    return schema.parse(undefined)
  }
  return schema.parse(await response.json())
}

function conversationPath(id: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('올바르지 않은 대화 ID입니다.')
  return `/${encodeURIComponent(id)}`
}

export function listChatConversations(token: string, email: string, before: number | null = null, signal?: AbortSignal) {
  return request(token, email, before === null ? '' : `?before=${before}`, chatConversationPageSchema, signal)
}

export function deleteChatConversation(token: string, email: string, id: string, signal?: AbortSignal) {
  return request(token, email, conversationPath(id), z.void(), signal, undefined, 'DELETE')
}

export async function getChatConversation(token: string, email: string, id: string, signal?: AbortSignal): Promise<ChatConversationDetail> {
  const detail = await request(token, email, conversationPath(id), chatConversationDetailSchema, signal)
  if (detail.conversation.id !== id) throw new Error('다른 대화 기록이 반환되었습니다.')
  return { ...detail, snapshot: { ...detail.snapshot, messages: detail.snapshot.messages.map(message => ({ ...message,
    ...(message.programs === undefined ? {} : { programs: message.programs.map(toSupportProgram) }),
  })) } }
}

export async function saveChatConversation(token: string, email: string, id: string, expectedVersion: number, snapshot: ChatConversationSnapshot, signal?: AbortSignal) {
  const validated = chatConversationSnapshotSchema.parse(snapshot)
  if (validated.messages.find(message => message.role === 'user')?.id !== id) throw new Error('대화 ID와 첫 질문이 일치하지 않습니다.')
  const summary = await request(token, email, conversationPath(id), chatConversationSummarySchema, signal, { expectedVersion, snapshot: validated })
  if (summary.id !== id) throw new Error('다른 대화 저장 결과가 반환되었습니다.')
  return summary
}
