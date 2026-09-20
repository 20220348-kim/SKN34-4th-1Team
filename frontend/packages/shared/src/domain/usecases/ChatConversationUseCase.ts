import type { ChatConversationSnapshot } from '../entities/ChatConversation'
import type { ChatConversationRepository } from '../repositories/ChatConversationRepository'

export class ChatConversationUseCase {
  private readonly repository: ChatConversationRepository
  constructor(repository: ChatConversationRepository) { this.repository = repository }
  list(accountEmail: string, before: number | null = null, signal?: AbortSignal) { return this.repository.list(accountEmail, before, signal) }
  get(accountEmail: string, id: string, signal?: AbortSignal) { return this.repository.get(accountEmail, id, signal) }
  delete(accountEmail: string, id: string, signal?: AbortSignal) { return this.repository.delete(accountEmail, id, signal) }
  save(accountEmail: string, id: string, version: number, snapshot: ChatConversationSnapshot, signal?: AbortSignal) { return this.repository.save(accountEmail, id, version, snapshot, signal) }
}
