import { describe, expect, it, vi } from 'vitest'

import { supportPrograms } from '../../data/fixtures/supportPrograms'
import {
  BrowseSavedSupportProgramsUseCase,
  CheckSavedSupportProgramUseCase,
  RemoveSavedSupportProgramUseCase,
  SaveSupportProgramUseCase,
} from './SavedSupportProgramUseCases'

const identity = { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN-1' }

describe('saved support program use cases', () => {
  it('browse passes the signal through and returns the list as is', async () => {
    const saved = [{ savedAt: '2026-09-12T10:00:00', program: supportPrograms[0]! }]
    const list = vi.fn().mockResolvedValue(saved)
    const controller = new AbortController()

    await expect(new BrowseSavedSupportProgramsUseCase({ list }).execute(controller.signal)).resolves.toBe(saved)
    expect(list).toHaveBeenCalledWith(controller.signal)
  })

  it('check, save and remove refuse blank identities before calling the repository', async () => {
    const isSaved = vi.fn().mockResolvedValue(true)
    const save = vi.fn().mockResolvedValue({ outcome: 'saved', saved: { savedAt: '2026-09-12T10:00:00', program: supportPrograms[0]! } })
    const remove = vi.fn().mockResolvedValue(undefined)

    await expect(new CheckSavedSupportProgramUseCase({ isSaved }).execute(identity)).resolves.toBe(true)
    await expect(new SaveSupportProgramUseCase({ save }).execute(identity)).resolves.toEqual(expect.objectContaining({ outcome: 'saved' }))
    await expect(new RemoveSavedSupportProgramUseCase({ remove }).execute(identity)).resolves.toBeUndefined()
    expect(isSaved).toHaveBeenCalledWith(identity, undefined)
    expect(save).toHaveBeenCalledWith(identity, undefined)
    expect(remove).toHaveBeenCalledWith(identity, undefined)

    expect(() => new CheckSavedSupportProgramUseCase({ isSaved }).execute({ sourceCode: ' ', sourceProgramId: 'x' })).toThrow(RangeError)
    expect(() => new SaveSupportProgramUseCase({ save }).execute({ sourceCode: 'BIZINFO', sourceProgramId: '' })).toThrow(RangeError)
    expect(() => new RemoveSavedSupportProgramUseCase({ remove }).execute({ sourceCode: '', sourceProgramId: '' })).toThrow(RangeError)
    expect(isSaved).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
  })
})
