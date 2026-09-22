// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appContainer } from '../../../../app/appContainer'
import { createAppStore } from '../../../../app/store'
import { supportProgramDetails, supportPrograms } from '../../../../data/fixtures/supportPrograms'
import type { Account } from '../../../../domain/entities/Account'
import { SupportProgramDetailPage } from './SupportProgramDetailPage'
import { SupportProgramEvidenceQuestionPage } from './SupportProgramEvidenceQuestionPage'
import { sessionRestored } from '../../../shared/auth/state/authSlice'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('상세 오류 복구와 검색 화면 복귀', () => {
  it('일시 실패 후 같은 화면에서 수동 재시도하고 근거 질문은 자동 호출하지 않는다', async () => {
    const detail = vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute')
      .mockRejectedValueOnce(new Error('private failure')).mockResolvedValueOnce(supportProgramDetails[0])
    const question = vi.spyOn(appContainer.resolve('askSupportProgramEvidenceQuestionUseCase'), 'execute')
      .mockResolvedValue({ outcome: 'unavailable' })
    renderDetail()
    fireEvent.click(await screen.findByRole('button', { name: '상세 정보 다시 불러오기' }))
    await screen.findByRole('heading', { name: supportPrograms[0].title })
    expect(detail).toHaveBeenCalledTimes(2)
    expect(question).not.toHaveBeenCalled()
    // 비로그인은 로그인 뒤 신청 문서 작성으로 이어지고, 관심 공고 저장도 로그인 뒤 이 공고로 돌아옵니다.
    const preparationPath = `/app/application-preparations/new?${new URLSearchParams({ sourceCode: supportPrograms[0].sourceCode, sourceProgramId: supportPrograms[0].id })}`
    expect(screen.getByRole('link', { name: '로그인하고 신청 양식 상태 확인' }).getAttribute('href')).toBe(`/login?next=${encodeURIComponent(preparationPath)}`)
    expect(screen.queryByRole('link', { name: '이 공고의 신청 양식 상태 확인' })).toBeNull()
    const detailPath = `/support-programs/detail?${new URLSearchParams({ sourceCode: supportPrograms[0].sourceCode, sourceProgramId: supportPrograms[0].id })}`
    expect(screen.getByRole('link', { name: '로그인하고 관심 공고 저장' }).getAttribute('href')).toBe(`/login?next=${encodeURIComponent(detailPath)}`)
    expect(screen.queryByRole('button', { name: /관심 공고 저장/ })).toBeNull()
    expect(screen.queryByText('지원사업 상세')).toBeNull()
    expect(screen.queryByText('private failure')).toBeNull()
  })

  it('상세·질문을 왕복해도 원래 작업 채팅으로 복귀한다', async () => {
    vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(supportProgramDetails[0])
    // 원문 질문은 회원 기능이라 로그인한 상태로 왕복합니다.
    vi.spyOn(appContainer.resolve('checkSavedSupportProgramUseCase'), 'execute').mockResolvedValue(false)
    renderDetail({ searchReturnTo: '/app/chat' }, undefined, memberAccount)
    expect(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }).getAttribute('href')).toBe('/app/chat')
    fireEvent.click(await screen.findByRole('link', { name: '이 공고에 질문하기' }))
    fireEvent.click(screen.getByRole('link', { name: '← 공고 상세로 돌아가기' }))
    await screen.findByRole('heading', { name: supportPrograms[0].title })
    expect(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }).getAttribute('href')).toBe('/app/chat')
  })

  it('과기정통부 공고는 근거 질문 없이 신청 문서 작성 도우미로 연결한다', async () => {
    const program = { ...supportProgramDetails[0], sourceCode: 'MSIT', id: '3186573', sourceName: '과학기술정보통신부', evidenceQuestionSupported: false }
    vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(program)
    renderDetail(null, `?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.id })}`)

    await screen.findByRole('heading', { name: program.title })
    expect(screen.queryByRole('link', { name: '이 공고에 질문하기' })).toBeNull()
    expect(screen.getByRole('link', { name: '로그인하고 신청 양식 상태 확인' }).getAttribute('href')).toBe(
      `/login?next=${encodeURIComponent(`/app/application-preparations/new?${new URLSearchParams({ sourceCode: program.sourceCode, sourceProgramId: program.id })}`)}`,
    )
  })

  it.each([
    ['KSTARTUP', '177911'],
    ['CNTRADE_NOTICE', '3862'],
  ])('%s 공고도 신청 문서 작성 도우미로 연결한다', async (sourceCode, id) => {
    const program = { ...supportProgramDetails[0], sourceCode, id, evidenceQuestionSupported: false }
    vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(program)
    renderDetail(null, `?${new URLSearchParams({ sourceCode, sourceProgramId: id })}`)

    await screen.findByRole('heading', { name: program.title })
    const preparationPath = `/app/application-preparations/new?${new URLSearchParams({ sourceCode, sourceProgramId: id })}`
    expect(screen.getByRole('link', { name: '로그인하고 신청 양식 상태 확인' }).getAttribute('href')).toBe(
      `/login?next=${encodeURIComponent(preparationPath)}`,
    )
  })

  it.each([null, {}, { searchReturnTo: 'https://example.com' }, { searchReturnTo: '//example.com' }, { searchReturnTo: '/admin' }])(
    '직접 진입 또는 허용하지 않는 복귀 상태 %j는 첫 검색 화면으로 돌아간다', async (state) => {
      vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(null)
      renderDetail(state)
      await screen.findByRole('heading', { name: '공고 정보를 찾을 수 없습니다' })
      expect(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }).getAttribute('href')).toBe('/')
      expect(screen.queryByRole('button', { name: '상세 정보 다시 불러오기' })).toBeNull()
    },
  )

  it('이동 상태가 없으면 주소의 back으로 필터 검색 화면에 돌아가고, 허용하지 않는 back은 무시한다', async () => {
    vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(supportProgramDetails[0])
    const identity = new URLSearchParams({ sourceCode: supportPrograms[0].sourceCode, sourceProgramId: supportPrograms[0].id })
    renderDetail(null, `?${identity}&back=${encodeURIComponent('/?mode=filter&keyword=AI')}`)
    await screen.findByRole('heading', { name: supportPrograms[0].title })
    expect(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }).getAttribute('href')).toBe('/?mode=filter&keyword=AI')

    cleanup()
    renderDetail(null, `?${identity}&back=${encodeURIComponent('https://example.com')}`)
    await screen.findByRole('heading', { name: supportPrograms[0].title })
    expect(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }).getAttribute('href')).toBe('/')
  })

  it('잘못된 식별자는 조회하지 않고 원래 검색 화면의 복귀 링크를 유지한다', () => {
    const detail = vi.spyOn(appContainer.resolve('getSupportProgramDetailUseCase'), 'execute').mockResolvedValue(null)
    renderDetail({ searchReturnTo: '/app/chat' }, '?sourceCode=BIZINFO')
    expect(screen.getByRole('heading', { name: '공고 정보를 찾을 수 없습니다' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '← 검색 결과로 돌아가기' }).getAttribute('href')).toBe('/app/chat')
    expect(detail).not.toHaveBeenCalled()
  })
})

const memberAccount: Account = { email: 'member@govbiz.local', role: 'USER', tier: 'MEMBER', emailVerified: true, hasPassword: true, company: null }

function renderDetail(
  state: unknown = null,
  search = `?${new URLSearchParams({ sourceCode: supportPrograms[0].sourceCode, sourceProgramId: supportPrograms[0].id })}`,
  account: Account | null = null,
) {
  // 기본은 비로그인 공개 화면입니다. 로그인한 상세의 저장 흐름은 App 테스트(App.savedPrograms)가 확인합니다.
  const store = createAppStore()
  store.dispatch(sessionRestored(account))
  render(<Provider store={store}><MemoryRouter initialEntries={[{ pathname: '/support-programs/detail', search, state }]}><Routes>
    <Route path="/support-programs/detail" element={<SupportProgramDetailPage />} />
    <Route path="/support-programs/detail/question" element={<SupportProgramEvidenceQuestionPage />} />
  </Routes></MemoryRouter></Provider>)
}
