import { describe, expect, it, vi } from 'vitest'

import { supportPrograms } from '../../data/fixtures/supportPrograms'
import { GetSupportProgramDetailUseCase } from './GetSupportProgramDetailUseCase'

describe('GetSupportProgramDetailUseCase', () => {
  it('forwards the complete source identity and cancellation signal to the repository', async () => {
    const getDetail = vi.fn().mockResolvedValue(supportPrograms[0])
    const useCase = new GetSupportProgramDetailUseCase({ getDetail })
    const controller = new AbortController()
    const identity = {
      sourceCode: supportPrograms[0].sourceCode,
      sourceProgramId: supportPrograms[0].id,
    }

    await expect(useCase.execute(identity, controller.signal)).resolves.toEqual(supportPrograms[0])
    expect(getDetail).toHaveBeenCalledWith(identity, controller.signal)
  })
})
