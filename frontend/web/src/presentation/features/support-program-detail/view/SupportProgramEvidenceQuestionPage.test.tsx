// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanQuotaExceededError } from '@govbiz/shared/domain/errors/PlanQuotaError'
import { appContainer } from '../../../../app/appContainer'
import { SupportProgramEvidenceQuestionPage } from './SupportProgramEvidenceQuestionPage'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('원문 질문 입력 안내', () => {
  it('길이 초과 이유를 즉시 안내하고 입력의 오류 상태와 설명을 연결한다', () => {
    const execute = vi.spyOn(appContainer.resolve('askSupportProgramEvidenceQuestionUseCase'), 'execute').mockResolvedValue({ outcome: 'unavailable' })
    renderQuestion()
    const input = screen.getByRole('textbox', { name: '공고 원문에 질문하기' })
    const submit = screen.getByRole('button', { name: '질문하고 근거 받기' }) as HTMLButtonElement
    fireEvent.change(input, { target: { value: '가'.repeat(501) } })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('질문은 500자 이하로 입력해 주세요.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id)
    expect(submit.disabled).toBe(true)
    expect(execute).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '가'.repeat(500) } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(submit.disabled).toBe(false)
    for (const id of input.getAttribute('aria-describedby')!.split(' ')) expect(document.getElementById(id)).not.toBeNull()
  })

  it('IME·줄바꿈으로 자동 전송하지 않고 명시적 중복 제출도 한 번만 호출한다', async () => {
    let resolve!: (value: { outcome: 'unavailable' }) => void
    const execute = vi.spyOn(appContainer.resolve('askSupportProgramEvidenceQuestionUseCase'), 'execute')
      .mockReturnValue(new Promise((complete) => { resolve = complete }))
    renderQuestion()
    const input = screen.getByRole('textbox', { name: '공고 원문에 질문하기' })
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '신청 조건' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(execute).not.toHaveBeenCalled()
    fireEvent.submit(input.closest('form')!)
    fireEvent.submit(input.closest('form')!)
    expect(execute).toHaveBeenCalledOnce()
    await act(async () => resolve({ outcome: 'unavailable' }))
    expect(screen.getByRole('alert').textContent).toBe('원문 근거 답변을 지금 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.')
    expect((screen.getByRole('button', { name: '질문하고 근거 받기' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('로그인 전 공개 주소', () => {
  it('질문 입력 대신 로그인 뒤 같은 공고의 질문 화면으로 돌아오는 안내를 보이고 질문을 보내지 않는다', () => {
    const execute = vi.spyOn(appContainer.resolve('askSupportProgramEvidenceQuestionUseCase'), 'execute')
    renderQuestion('/support-programs/detail/question?sourceCode=BIZINFO&sourceProgramId=test-program')
    expect(screen.getByRole('heading', { name: '로그인하고 원문에 질문하기' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '공고 원문에 질문하기' })).toBeNull()
    const login = screen.getByRole('link', { name: '로그인하고 질문하기' })
    const next = new URLSearchParams(login.getAttribute('href')!.split('?')[1]).get('next')!
    expect(next.startsWith('/app/support-programs/detail/question?')).toBe(true)
    expect(new URLSearchParams(next.split('?')[1]).get('sourceProgramId')).toBe('test-program')
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('하루 원문 질문 이용량', () => {
  const resetsAt = '2026-10-09T00:00:00+09:00'
  const usage = (used: number) => ({ plan: 'FREE' as const, items: [{ feature: 'EVIDENCE_QUESTION' as const, period: 'DAY' as const, limit: 10, used, resetsAt }] })

  it('입력 아래에 오늘 질문 수를 보이고, 다 쓰면 입력과 보내기를 막고 다시 채워지는 때를 알린다', async () => {
    const execute = vi.spyOn(appContainer.resolve('askSupportProgramEvidenceQuestionUseCase'), 'execute')
    const planUsage = vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage').mockResolvedValueOnce(usage(3))
    renderQuestion('/app/support-programs/detail/question?sourceCode=BIZINFO&sourceProgramId=test-program')
    const line = (await screen.findByText('오늘 3/10회')).closest('p')!
    expect(line.textContent).toBe('공고 원문 질문·오늘 3/10회')
    const input = screen.getByRole('textbox', { name: '공고 원문에 질문하기' }) as HTMLTextAreaElement
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(line.id)
    expect(input.disabled).toBe(false)

    cleanup()
    planUsage.mockResolvedValue(usage(10))
    renderQuestion('/app/support-programs/detail/question?sourceCode=BIZINFO&sourceProgramId=test-program')
    const limit = (await screen.findByText('오늘 공고 원문 질문 10회를 모두 썼어요. 자정(서울 시간)에 다시 채워져요.')).closest('p')!
    expect(limit.querySelector('a')).toBeNull()
    const blocked = screen.getByRole('textbox', { name: '공고 원문에 질문하기' }) as HTMLTextAreaElement
    expect(blocked.disabled).toBe(true)
    expect((screen.getByRole('button', { name: '질문하고 근거 받기' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(blocked.closest('form')!)
    expect(execute).not.toHaveBeenCalled()
  })

  it('서버가 한도로 거절하면 일반 실패 대신 shared 안내를 보여 준다', async () => {
    vi.spyOn(appContainer.resolve('planUsageUseCase'), 'usage').mockReturnValue(new Promise(() => {}))
    vi.spyOn(appContainer.resolve('askSupportProgramEvidenceQuestionUseCase'), 'execute')
      .mockRejectedValue(new PlanQuotaExceededError({ feature: 'EVIDENCE_QUESTION', period: 'DAY', plan: 'FREE', limit: 10, resetsAt }))
    renderQuestion()
    const input = screen.getByRole('textbox', { name: '공고 원문에 질문하기' })
    fireEvent.change(input, { target: { value: '신청 대상은 누구인가요?' } })
    await act(async () => fireEvent.submit(input.closest('form')!))
    expect(screen.getByRole('alert').textContent).toBe('오늘 공고 원문 질문 10회를 모두 썼어요. 자정(서울 시간)에 다시 채워져요.')
    expect((input as HTMLTextAreaElement).value).toBe('신청 대상은 누구인가요?')
  })
})

function renderQuestion(path = '/app/support-programs/detail/question?sourceCode=BIZINFO&sourceProgramId=test-program') {
  render(<MemoryRouter initialEntries={[path]}>
    <SupportProgramEvidenceQuestionPage />
  </MemoryRouter>)
}
