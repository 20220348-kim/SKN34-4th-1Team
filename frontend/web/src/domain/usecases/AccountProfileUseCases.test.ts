import { describe, expect, it, vi } from 'vitest'

import { ChangePasswordUseCase, DeleteAccountUseCase, GetAccountDeletionPreviewUseCase } from './AccountProfileUseCases'

describe('account profile use cases', () => {
  it('checks the new password rule before calling the repository', async () => {
    const changePassword = vi.fn().mockResolvedValue({ outcome: 'changed' })
    const useCase = new ChangePasswordUseCase({ changePassword })

    expect(() => useCase.execute('short')).toThrow(RangeError)
    await expect(useCase.execute('new-password-2')).resolves.toEqual({ outcome: 'changed' })
    expect(changePassword).toHaveBeenCalledWith('new-password-2', undefined)
  })

  it('reads the deletion preview and refuses an empty password for deletion', async () => {
    const preview = { hasCompany: true, openRecruitmentCount: 2, receivedPendingProposalCount: 3, sentPendingProposalCount: 1 }
    await expect(new GetAccountDeletionPreviewUseCase({ getDeletionPreview: vi.fn().mockResolvedValue(preview) }).execute()).resolves.toEqual(preview)

    const deleteAccount = vi.fn().mockResolvedValue({ outcome: 'deleted' })
    const useCase = new DeleteAccountUseCase({ deleteAccount })
    expect(() => useCase.execute('')).toThrow(RangeError)
    await expect(useCase.execute('password1')).resolves.toEqual({ outcome: 'deleted' })
    expect(deleteAccount).toHaveBeenCalledWith('password1', undefined)
    // 비밀번호가 없는 소셜 가입 계정은 null로 부릅니다.
    await expect(useCase.execute(null)).resolves.toEqual({ outcome: 'deleted' })
    expect(deleteAccount).toHaveBeenLastCalledWith(null, undefined)
  })
})
