// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appContainer } from '../../../../app/appContainer'
import { createAppStore } from '../../../../app/store'
import { supportProgramDetails, supportPrograms } from '../../../../data/fixtures/supportPrograms'
import { sessionRestored } from '../../../shared/auth/state/authSlice'
import { SupportProgramDetailPage } from './SupportProgramDetailPage'

// 공통 테스트 설정이 막아 둔 첨부 목록 훅을 이 파일에서만 실제로 씁니다.
vi.unmock('../viewmodel/useSupportProgramAttachmentsViewModel')

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('공고 상세의 공식 첨부파일', () => {
  it('원문 첨부를 파일 이름·형식과 Core 받기 링크로 보여 준다', async () => {
    vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(supportProgramDetails[0])
    const attachments = vi.spyOn(appContainer.resolve('getSupportProgramAttachmentsUseCase'), 'execute').mockResolvedValue([
      { fileName: '신청서 양식.hwp', extension: 'hwp', downloadUrl: 'http://localhost:8080/api/v1/support-programs/detail/attachments/download?index=0' },
      { fileName: '서식 묶음.zip', extension: 'zip', downloadUrl: 'http://localhost:8080/api/v1/support-programs/detail/attachments/download?index=1' },
    ])

    renderDetail()

    const section = await screen.findByRole('region', { name: '첨부파일' })
    expect(await within(section).findByText('신청서 양식.hwp')).toBeTruthy()
    expect(within(section).getByText('ZIP')).toBeTruthy()
    const link = within(section).getByRole('link', { name: '신청서 양식.hwp 받기' })
    expect(link.getAttribute('href')).toBe('http://localhost:8080/api/v1/support-programs/detail/attachments/download?index=0')
    expect(link.hasAttribute('download')).toBe(true)
    expect(attachments).toHaveBeenCalledWith(
      { sourceCode: supportPrograms[0].sourceCode, sourceProgramId: supportPrograms[0].id },
      expect.any(AbortSignal),
    )
  })

  it('원문을 읽지 못하면 상세는 그대로 두고 원문 링크로 안내한다', async () => {
    vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(supportProgramDetails[0])
    vi.spyOn(appContainer.resolve('getSupportProgramAttachmentsUseCase'), 'execute').mockRejectedValue(new Error('private failure'))

    renderDetail()

    const section = await screen.findByRole('region', { name: '첨부파일' })
    expect(await within(section).findByText(/첨부파일을 불러오지 못했어요/)).toBeTruthy()
    expect(within(section).getByRole('link', { name: `${supportProgramDetails[0].sourceName} 원문에서 확인` }).getAttribute('href'))
      .toBe(supportProgramDetails[0].sourceUrl)
    expect(screen.getByRole('heading', { name: supportPrograms[0].title })).toBeTruthy()
    expect(screen.queryByText('private failure')).toBeNull()
  })

  it('첨부가 없는 공고에는 첨부파일 구역을 그리지 않는다', async () => {
    vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(supportProgramDetails[0])
    const attachments = vi.spyOn(appContainer.resolve('getSupportProgramAttachmentsUseCase'), 'execute').mockResolvedValue([])

    renderDetail()

    await screen.findByRole('heading', { name: supportPrograms[0].title })
    await vi.waitFor(() => expect(attachments).toHaveBeenCalled())
    await vi.waitFor(() => expect(screen.queryByRole('region', { name: '첨부파일' })).toBeNull())
  })
})

function renderDetail() {
  const store = createAppStore()
  store.dispatch(sessionRestored(null))
  const search = `?${new URLSearchParams({ sourceCode: supportPrograms[0].sourceCode, sourceProgramId: supportPrograms[0].id })}`
  render(<Provider store={store}><MemoryRouter initialEntries={[{ pathname: '/support-programs/detail', search }]}><Routes>
    <Route path="/support-programs/detail" element={<SupportProgramDetailPage />} />
  </Routes></MemoryRouter></Provider>)
}
