// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import { SupportProgramRequestError } from '../../../../domain/errors/SupportProgramRequestError'
import type { SupportProgramEvidenceAnswer } from '../../../../domain/entities/SupportProgramEvidenceAnswer'
import type {
  SupportProgramEvidenceQuestionResult,
  SupportProgramIdentity,
} from '../../../../domain/repositories/SupportProgramRepository'
import type { AskSupportProgramEvidenceQuestionUseCase } from '../../../../domain/usecases/AskSupportProgramEvidenceQuestionUseCase'
import {
  maximumSupportProgramEvidenceQuestionLength,
  supportProgramEvidenceQuestionTimeoutMilliseconds,
  useSupportProgramEvidenceQuestionViewModel,
} from './useSupportProgramEvidenceQuestionViewModel'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useSupportProgramEvidenceQuestionViewModel', () => {
  it('times out a stalled question, preserves its input, and ignores the old answer after a manual retry', async () => {
    vi.useFakeTimers()
    const pending = deferredEvidenceResult()
    let requestSignal: AbortSignal | undefined
    const execute = vi.fn()
      .mockImplementationOnce((_command: unknown, signal?: AbortSignal) => {
        requestSignal = signal
        return pending.promise
      })
      .mockResolvedValueOnce(answerResult())
    const useCase = createEvidenceQuestionUseCase(execute)
    const { result } = renderHook(() => useSupportProgramEvidenceQuestionViewModel(getIdentity(), useCase))
    act(() => result.current.updateQuestion('신청 대상은 누구인가요?'))
    let firstRequest!: Promise<void>
    act(() => { firstRequest = result.current.submitQuestion() })

    await act(async () => vi.advanceTimersByTimeAsync(supportProgramEvidenceQuestionTimeoutMilliseconds - 1))
    expect(result.current.isAnswering).toBe(true)
    expect(requestSignal?.aborted).toBe(false)

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(requestSignal?.aborted).toBe(true)
    expect(result.current.state).toEqual({ status: 'timed-out' })
    expect(result.current.question).toBe('신청 대상은 누구인가요?')
    expect(result.current.canSubmit).toBe(true)
    expect(execute).toHaveBeenCalledOnce()

    await act(async () => result.current.submitQuestion())
    expect(result.current.state).toEqual({ status: 'answered', answer: evidenceAnswer() })
    await act(async () => {
      pending.resolve({ outcome: 'unavailable' })
      await firstRequest
    })
    expect(result.current.state).toEqual({ status: 'answered', answer: evidenceAnswer() })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears question request timers on cancellation and unmount', () => {
    vi.useFakeTimers()
    const pending = deferredEvidenceResult()
    const useCase = createEvidenceQuestionUseCase(vi.fn().mockReturnValue(pending.promise))
    const { result, unmount } = renderHook(() => useSupportProgramEvidenceQuestionViewModel(getIdentity(), useCase))
    act(() => result.current.updateQuestion('신청 대상은 누구인가요?'))
    act(() => { void result.current.submitQuestion() })
    expect(vi.getTimerCount()).toBe(1)
    act(() => result.current.cancelQuestion())
    expect(vi.getTimerCount()).toBe(0)

    act(() => { void result.current.submitQuestion() })
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['KSTARTUP', 'OTHERSOURCE'])('blocks %s questions before executing the use case', async (sourceCode) => {
    const execute = vi.fn()
    const { result } = renderHook(() => useSupportProgramEvidenceQuestionViewModel(
      { ...getIdentity(), sourceCode },
      createEvidenceQuestionUseCase(execute),
    ))

    act(() => result.current.updateQuestion('신청 대상은 누구인가요?'))
    expect(result.current.isSupported).toBe(false)
    expect(result.current.canSubmit).toBe(false)
    await act(async () => result.current.submitQuestion())

    expect(execute).not.toHaveBeenCalled()
    expect(result.current.state.status).toBe('not-supported')
  })

  it('does not fetch automatically and sends a trimmed question only after explicit submission', async () => {
    const execute = vi.fn().mockResolvedValue(answerResult())
    const identity = getIdentity()
    const { result } = renderHook(() => useSupportProgramEvidenceQuestionViewModel(
      identity,
      createEvidenceQuestionUseCase(execute),
    ))

    expect(execute).not.toHaveBeenCalled()
    act(() => result.current.updateQuestion('  신청 대상은 누구인가요?  '))
    await act(async () => result.current.submitQuestion())

    expect(execute).toHaveBeenCalledWith({
      ...identity,
      question: '신청 대상은 누구인가요?',
    }, expect.any(AbortSignal))
    expect(result.current.state).toEqual({
      status: 'answered',
      answer: evidenceAnswer(),
    })
  })

  it('does not send an empty or overlong question and keeps a safe validation message', async () => {
    const execute = vi.fn()
    const { result } = renderHook(() => useSupportProgramEvidenceQuestionViewModel(
      getIdentity(),
      createEvidenceQuestionUseCase(execute),
    ))

    await act(async () => result.current.submitQuestion())
    expect(result.current.state).toEqual({
      status: 'validation-failed',
      message: '질문을 입력해 주세요.',
    })

    const overlongQuestion = '가'.repeat(maximumSupportProgramEvidenceQuestionLength + 1)
    act(() => result.current.updateQuestion(overlongQuestion))
    await act(async () => result.current.submitQuestion())

    expect(execute).not.toHaveBeenCalled()
    expect(result.current.question).toBe(overlongQuestion)
    expect(result.current.state).toEqual({
      status: 'validation-failed',
      message: '질문은 500자 이하로 입력해 주세요. 현재 501자입니다.',
    })
  })

  it.each([
    [{ outcome: 'answer', answer: insufficientEvidenceAnswer() }, 'insufficient-evidence'],
    [{ outcome: 'not-supported' }, 'not-supported'],
    [{ outcome: 'unavailable' }, 'unavailable'],
  ] as const)('maps the %o result to the %s user state', async (outcome, expectedStatus) => {
    const execute = vi.fn().mockResolvedValue(outcome)
    const { result } = renderHook(() => useSupportProgramEvidenceQuestionViewModel(
      getIdentity(),
      createEvidenceQuestionUseCase(execute),
    ))

    act(() => result.current.updateQuestion('질문'))
    await act(async () => result.current.submitQuestion())

    expect(result.current.state.status).toBe(expectedStatus)
  })

  it('cancels an in-flight request and ignores its late answer', async () => {
    const pending = deferredEvidenceResult()
    let requestSignal: AbortSignal | undefined
    const execute = vi.fn((_command: unknown, signal?: AbortSignal) => {
      requestSignal = signal
      return pending.promise
    })
    const { result } = renderHook(() => useSupportProgramEvidenceQuestionViewModel(
      getIdentity(),
      createEvidenceQuestionUseCase(execute),
    ))

    act(() => result.current.updateQuestion('신청 대상은 누구인가요?'))
    let request!: Promise<void>
    act(() => {
      request = result.current.submitQuestion()
    })
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())

    act(() => result.current.cancelQuestion())
    expect(requestSignal?.aborted).toBe(true)
    expect(result.current.state).toEqual({ status: 'cancelled' })

    pending.resolve(answerResult())
    await act(async () => request)
    expect(result.current.state).toEqual({ status: 'cancelled' })
  })

  it.each([
    ['rate-limited', 12, '짧은 시간에 요청이 많아 잠시 제한되었습니다. 약 12초 후 직접 다시 시도해 주세요.'],
    ['busy', 3, '현재 다른 요청을 처리하고 있어 새 요청을 시작할 수 없습니다. 약 3초 후 직접 다시 시도해 주세요.'],
    ['busy', null, '현재 다른 요청을 처리하고 있어 새 요청을 시작할 수 없습니다. 잠시 후 직접 다시 시도해 주세요.'],
  ] as const)('shows %s feedback and keeps the evidence question for manual retry only', async (reason, seconds, message) => {
    vi.useFakeTimers()
    const execute = vi.fn()
      .mockRejectedValueOnce(new SupportProgramRequestError(reason, seconds))
      .mockResolvedValueOnce(answerResult())
    const { result } = renderHook(() => useSupportProgramEvidenceQuestionViewModel(getIdentity(), createEvidenceQuestionUseCase(execute)))
    act(() => result.current.updateQuestion('신청 대상은 누구인가요?'))
    await act(async () => result.current.submitQuestion())
    expect(result.current.state).toEqual({ status: reason, message })
    expect(result.current.question).toBe('신청 대상은 누구인가요?')
    expect(result.current.canSubmit).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(execute).toHaveBeenCalledOnce()

    await act(async () => result.current.submitQuestion())
    expect(execute).toHaveBeenCalledTimes(2)
    expect(result.current.state.status).toBe('answered')
  })

  it('aborts a question when the selected program changes and ignores the stale response', async () => {
    const pending = deferredEvidenceResult()
    let requestSignal: AbortSignal | undefined
    const execute = vi.fn((_command: unknown, signal?: AbortSignal) => {
      requestSignal = signal
      return pending.promise
    })
    const { result, rerender } = renderHook(
      ({ identity }: { identity: SupportProgramIdentity }) => useSupportProgramEvidenceQuestionViewModel(
        identity,
        createEvidenceQuestionUseCase(execute),
      ),
      { initialProps: { identity: getIdentity() } },
    )

    act(() => result.current.updateQuestion('신청 대상은 누구인가요?'))
    let request!: Promise<void>
    act(() => {
      request = result.current.submitQuestion()
    })
    await waitFor(() => expect(execute).toHaveBeenCalledOnce())

    rerender({
      identity: {
        sourceCode: supportPrograms[1].sourceCode,
        sourceProgramId: supportPrograms[1].id,
      },
    })
    expect(requestSignal?.aborted).toBe(true)

    pending.resolve(answerResult())
    await act(async () => request)
    expect(result.current.question).toBe('')
    expect(result.current.state).toEqual({ status: 'idle' })
  })
})

function getIdentity(): SupportProgramIdentity {
  return {
    sourceCode: supportPrograms[0].sourceCode,
    sourceProgramId: supportPrograms[0].id,
  }
}

function createEvidenceQuestionUseCase(
  execute: AskSupportProgramEvidenceQuestionUseCase['execute'],
): Pick<AskSupportProgramEvidenceQuestionUseCase, 'execute'> {
  return { execute }
}

function evidenceAnswer(): SupportProgramEvidenceAnswer {
  return {
    answer: '서울 소재 창업 7년 이내 중소기업이 신청 대상입니다.',
    answerStatus: 'ANSWERED',
    citations: [{
      excerpt: '지원 대상은 서울 소재 창업 7년 이내 중소기업입니다.',
      sourceUrl: supportPrograms[0].sourceUrl,
      chunkOrder: 0,
    }],
  }
}

function insufficientEvidenceAnswer(): SupportProgramEvidenceAnswer {
  return {
    answer: '원문 근거가 충분하지 않습니다.',
    answerStatus: 'INSUFFICIENT_EVIDENCE',
    citations: [],
  }
}

function answerResult(): SupportProgramEvidenceQuestionResult {
  return { outcome: 'answer', answer: evidenceAnswer() }
}

function deferredEvidenceResult() {
  let resolve!: (result: SupportProgramEvidenceQuestionResult) => void
  const promise = new Promise<SupportProgramEvidenceQuestionResult>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
