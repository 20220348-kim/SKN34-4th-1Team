import { afterEach, expect, it, vi } from 'vitest'
import { createSupportProgramClient } from './supportProgramClient'
import { GovAgentApiError } from './govAgentApi'

afterEach(() => vi.restoreAllMocks())
const command = { conversation: { message: '이 공고 지원 대상은?', context: { query: null, acceptingOnly: true,
  companyConditions: { region: null, industry: null, establishedOn: null, supportPurpose: null } } }, selectedProgram: null }

it('uses the configured session, path and abort signal without sending a client role', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ outcome: 'NEEDS_PROGRAM', message: '공고를 선택해 주세요.' }))
  const signal = new AbortController().signal
  const client = createSupportProgramClient({ baseUrl: 'https://core.example.test/', credentials: 'include', fetch })
  expect(await client.sendGovAgentMessage(command, signal)).toEqual({ outcome: 'NEEDS_PROGRAM', message: '공고를 선택해 주세요.' })
  expect(fetch).toHaveBeenCalledWith('https://core.example.test/api/v1/gov-agent/messages', expect.objectContaining({
    method: 'POST', credentials: 'include', signal, body: JSON.stringify(command),
  }))
})

it.each([401, 403, 429, 503, 504])('returns an explicit safe error for HTTP %s without trying the search endpoint', async (status) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ detail: 'private upstream content' }, { status }))
  const client = createSupportProgramClient({ baseUrl: '', credentials: 'include', fetch })
  const error = await client.sendGovAgentMessage(command).catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(GovAgentApiError)
  expect(error).toMatchObject({ status })
  expect(fetch).toHaveBeenCalledOnce()
})
