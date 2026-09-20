// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

function renderQuestion() {
  render(<MemoryRouter initialEntries={['/support-programs/detail/question?sourceCode=BIZINFO&sourceProgramId=test-program']}>
    <SupportProgramEvidenceQuestionPage />
  </MemoryRouter>)
}
