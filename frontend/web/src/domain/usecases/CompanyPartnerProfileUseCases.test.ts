import { describe, expect, it, vi } from 'vitest'

import { findCompanyPartnerProfileProblem } from '../entities/CompanyPartnerProfile'
import { GetCompanyPartnerProfileUseCase, UpdateCompanyPartnerProfileUseCase } from './CompanyPartnerProfileUseCases'

describe('company partner profile use cases', () => {
  it('reports the first invalid field with the server rules', () => {
    expect(findCompanyPartnerProfileProblem({ roles: [], interestAreas: [], introduction: '', capabilities: [] })).toBe('roles')
    expect(findCompanyPartnerProfileProblem({ roles: ['LEAD'], interestAreas: ['a', 'b', 'c', 'd'], introduction: '', capabilities: [] })).toBe('interestAreas')
    expect(findCompanyPartnerProfileProblem({ roles: ['LEAD'], interestAreas: [], introduction: 'x'.repeat(201), capabilities: [] })).toBe('introduction')
    expect(findCompanyPartnerProfileProblem({ roles: ['LEAD'], interestAreas: [], introduction: '', capabilities: ['a', 'a'] })).toBe('capabilities')
    expect(findCompanyPartnerProfileProblem({ roles: ['LEAD'], interestAreas: [], introduction: '', capabilities: ['x'.repeat(31)] })).toBe('capabilities')
    expect(findCompanyPartnerProfileProblem({ roles: ['LEAD', 'PARTICIPANT'], interestAreas: ['기술'], introduction: ' 소개 ', capabilities: ['AI'] })).toBeNull()
  })

  it('trims and de-duplicates before saving and refuses an invalid input before calling the repository', async () => {
    const updatePartnerProfile = vi.fn().mockResolvedValue({ isSet: true })
    const useCase = new UpdateCompanyPartnerProfileUseCase({ updatePartnerProfile })

    expect(() => useCase.execute({ roles: [], interestAreas: [], introduction: '', capabilities: [] })).toThrow(RangeError)
    await useCase.execute({ roles: ['LEAD', 'LEAD'], interestAreas: [' 기술 ', ''], introduction: ' 소개 ', capabilities: [' AI '] })
    expect(updatePartnerProfile).toHaveBeenCalledWith(
      { roles: ['LEAD'], interestAreas: ['기술'], introduction: '소개', capabilities: ['AI'] },
      undefined,
    )

    const getPartnerProfile = vi.fn().mockResolvedValue(null)
    await expect(new GetCompanyPartnerProfileUseCase({ getPartnerProfile }).execute()).resolves.toBeNull()
  })
})
