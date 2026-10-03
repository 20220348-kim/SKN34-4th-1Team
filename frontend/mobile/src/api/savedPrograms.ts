import { savedSupportProgramDtoSchema, savedSupportProgramListDtoSchema, savedSupportProgramStatusDtoSchema, toSavedSupportProgram } from '@govbiz/shared/data/models/SavedSupportProgramDto'
import type { SavedSupportProgram } from '@govbiz/shared/domain/entities/SavedSupportProgram'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { apiRequest } from './client'

const savedProgramsPath = '/api/v1/me/saved-programs'

export async function listSavedPrograms(token: string, signal?: AbortSignal): Promise<SavedSupportProgram[]> {
  const payload = await apiRequest(savedProgramsPath, { accessToken: token, signal })
  return savedSupportProgramListDtoSchema.parse(payload).programs.map(toSavedSupportProgram)
}

export async function getSavedProgramStatus(token: string, identity: SupportProgramIdentity, signal?: AbortSignal): Promise<boolean> {
  const payload = await apiRequest(`${savedProgramsPath}/status?${new URLSearchParams(identity)}`, { accessToken: token, signal })
  return savedSupportProgramStatusDtoSchema.parse(payload).saved
}

export async function saveProgram(token: string, identity: SupportProgramIdentity, signal?: AbortSignal): Promise<SavedSupportProgram> {
  const payload = await apiRequest(savedProgramsPath, { method: 'POST', accessToken: token, body: identity, signal })
  const saved = toSavedSupportProgram(savedSupportProgramDtoSchema.parse(payload))
  if (saved.program.sourceCode !== identity.sourceCode || saved.program.id !== identity.sourceProgramId) throw new Error('저장한 공고와 응답이 다릅니다.')
  return saved
}

export async function removeSavedProgram(token: string, identity: SupportProgramIdentity, signal?: AbortSignal): Promise<void> {
  await apiRequest(`${savedProgramsPath}?${new URLSearchParams(identity)}`, { method: 'DELETE', accessToken: token, signal })
}
