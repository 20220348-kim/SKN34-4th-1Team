import { describe, expect, it, vi } from 'vitest'

import {
  BrowsePartnerProposalsUseCase,
  RespondPartnerProposalUseCase,
  SendPartnerProposalUseCase,
} from './PartnerProposalUseCases'

describe('PartnerProposalUseCases', () => {
  it('send trims the message and rejects empty, too long, or badly addressed proposals', async () => {
    const send = vi.fn().mockResolvedValue({ outcome: 'sent' })
    const useCase = new SendPartnerProposalUseCase({ send })

    await useCase.execute(101, { message: '  라벨링을 맡겠습니다.  ', shareProfile: false })
    expect(send).toHaveBeenCalledWith(101, { message: '라벨링을 맡겠습니다.', shareProfile: false }, undefined)

    expect(() => useCase.execute(101, { message: '   ', shareProfile: true })).toThrow('message')
    expect(() => useCase.execute(101, { message: 'x'.repeat(501), shareProfile: true })).toThrow('message')
    expect(() => useCase.execute(0, { message: '제안', shareProfile: true })).toThrow(RangeError)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('respond rejects ids that cannot exist before calling the repository', async () => {
    const respond = vi.fn().mockResolvedValue({ outcome: 'not-found' })
    expect(() => new RespondPartnerProposalUseCase({ respond }).execute(1.5, 'accept')).toThrow(RangeError)
    expect(() => new RespondPartnerProposalUseCase({ respond }).execute(0, 'accept')).toThrow(RangeError)
    await new RespondPartnerProposalUseCase({ respond }).execute(7, 'decline')
    expect(respond).toHaveBeenCalledWith(7, 'decline', undefined)
  })

  it('browse passes the box through', async () => {
    const browseBox = vi.fn().mockResolvedValue({ box: 'sent', proposals: [], pendingCount: 0 })
    await new BrowsePartnerProposalsUseCase({ browseBox }).execute('sent')
    expect(browseBox).toHaveBeenCalledWith('sent', undefined)
  })
})
