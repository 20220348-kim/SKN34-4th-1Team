// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAppStore } from '../../../../app/store'
import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import type { SupportProgram } from '../../../../domain/entities/SupportProgram'
import { usePartnerRecruitmentCreateViewModel } from './usePartnerRecruitmentCreateViewModel'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const openProgram: SupportProgram = { ...supportPrograms[0]!, id: 'P-1', status: 'OPEN', applicationEndDate: '2099-12-31' }

function renderAt(entry: string, saved: SupportProgram[]) {
  const browseSavedPrograms = { execute: vi.fn().mockResolvedValue(saved.map((program) => ({ savedAt: '2026-10-01T09:00:00', program }))) }
  const store = createAppStore()
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}><MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter></Provider>
  const hook = renderHook(() => usePartnerRecruitmentCreateViewModel({ browseSavedPrograms }), { wrapper })
  return { ...hook, browseSavedPrograms }
}

describe('모집글 작성 공고 미리 고르기', () => {
  it('주소로 받은 관심 공고를 관심 공고함에서 찾아 처음 한 번 고른다', async () => {
    const { result, browseSavedPrograms } = renderAt(`/app/partners/new?${new URLSearchParams({ sourceCode: 'BIZINFO', sourceProgramId: 'P-1' })}`, [openProgram])
    await waitFor(() => expect(result.current.selectedProgram?.id).toBe('P-1'))
    expect(browseSavedPrograms.execute).toHaveBeenCalledOnce()
  })

  it('관심 공고함에 없거나 접수 중이 아닌 공고는 고르지 않고, 주소에 공고가 없으면 관심 공고함을 미리 읽지 않는다', async () => {
    const closed = renderAt(`/app/partners/new?${new URLSearchParams({ sourceCode: 'BIZINFO', sourceProgramId: 'P-1' })}`, [{ ...openProgram, status: 'CLOSED' }])
    await waitFor(() => expect(closed.browseSavedPrograms.execute).toHaveBeenCalledOnce())
    expect(closed.result.current.selectedProgram).toBeNull()
    cleanup()

    const none = renderAt('/app/partners/new', [openProgram])
    expect(none.browseSavedPrograms.execute).not.toHaveBeenCalled()
    expect(none.result.current.selectedProgram).toBeNull()
  })
})
