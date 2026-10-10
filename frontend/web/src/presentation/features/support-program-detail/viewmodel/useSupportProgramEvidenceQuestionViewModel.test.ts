// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useLayoutEffect, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlanUsage } from '@govbiz/shared/domain/entities/PlanUsage'
import { PlanQuotaExceededError, QuotaUnavailableError } from '@govbiz/shared/domain/errors/PlanQuotaError'

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
  it('preserves a question selected immediately after the panel mounts without sending it', () => {
    const execute = vi.fn()
    const useCase = createEvidenceQuestionUseCase(execute)
    const { result } = renderHook(() => {
      const model = useSupportProgramEvidenceQuestionViewModel(getIdentity(), useCase)
      const selectInitialQuestion = useRef(model.updateQuestion)
      // 첫 화면의 입력이 반영된 뒤 늦은 mount effect가 실행되는 순서를 재현합니다.
      useLayoutEffect(() => { selectInitialQuestion.current('지원 대상이 어떻게 되나요?') }, [])
      return model
    })

    expect(result.current.question).toBe('지원 대상이 어떻게 되나요?')
    expect(result.current.canSubmit).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })

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

  it.each([
    { sourceCode: supportPrograms[0].sourceCode, sourceProgramId: 'another-program' },
    { sourceCode: 'KSTARTUP', sourceProgramId: supportPrograms[0].id },
  ])('aborts when the program changes to %j and ignores the stale response', async (nextIdentity) => {
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

    rerender({ identity: { ...getIdentity() } })
    expect(requestSignal?.aborted).toBe(false)
    expect(result.current.question).toBe('신청 대상은 누구인가요?')

    rerender({ identity: nextIdentity })
    expect(requestSignal?.aborted).toBe(true)

    pending.resolve(answerResult())
    await act(async () => request)
    expect(result.current.question).toBe('')
    expect(result.current.state).toEqual({ status: 'idle' })
  })
})

describe('하루 원문 질문 이용량', () => {
  const resetsAt = '2026-10-09T00:00:00+09:00'
  const questionUsage = (used: number): PlanUsage => ({
    plan: 'FREE', items: [{ feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: 10, used, resetsAt }],
  })

  it('질문할 때마다 이용량을 다시 읽고, 다 쓰면 더 보내지 않는다', async () => {
    const execute = vi.fn().mockResolvedValue(answerResult())
    const planUsage = { usage: vi.fn().mockResolvedValueOnce(questionUsage(9)).mockResolvedValue(questionUsage(10)) }
    const { result } = renderHook(() => useSupportProgramEvidenceQuestionViewModel(getIdentity(), createEvidenceQuestionUseCase(execute), planUsage))
    await waitFor(() => expect(result.current.usage).toMatchObject({ countText: '오늘 9/10회', isNearLimit: true, isLimitReached: false }))

    act(() => result.current.updateQuestion('신청 대상은 누구인가요?'))
    expect(result.current.canSubmit).toBe(true)
    await act(async () => result.current.submitQuestion())
    expect(execute).toHaveBeenCalledOnce()
    await waitFor(() => expect(result.current.isLimitReached).toBe(true))
    expect(planUsage.usage).toHaveBeenCalledTimes(2)
    expect(result.current.usage?.limitMessage).toBe('오늘 공고 원문 질문 10회를 모두 썼어요. 자정(서울 시간)에 다시 채워져요.')

    act(() => result.current.updateQuestion('하나 더 물어볼게요'))
    expect(result.current.canSubmit).toBe(false)
    await act(async () => result.current.submitQuestion())
    expect(execute).toHaveBeenCalledOnce()
  })

  it('서버가 한도나 이용량 확인 실패로 답하지 않으면 shared 안내를 보이고 입력은 남긴다', async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new PlanQuotaExceededError({ feature: 'EVIDENCE_QUESTION', period: 'DAY', plan: 'FREE', limit: 10, resetsAt }))
      .mockRejectedValueOnce(new QuotaUnavailableError())
    const planUsage = { usage: vi.fn(() => new Promise<PlanUsage>(() => {})) }
    const { result } = renderHook(() => useSupportProgramEvidenceQuestionViewModel(getIdentity(), createEvidenceQuestionUseCase(execute), planUsage))
    act(() => result.current.updateQuestion('신청 대상은 누구인가요?'))

    await act(async () => result.current.submitQuestion())
    expect(result.current.state).toEqual({ status: 'quota', message: '오늘 공고 원문 질문 10회를 모두 썼어요. 자정(서울 시간)에 다시 채워져요.' })
    expect(result.current.question).toBe('신청 대상은 누구인가요?')

    await act(async () => result.current.submitQuestion())
    expect(result.current.state).toEqual({ status: 'quota', message: '지금은 이용량을 확인할 수 없어 실행하지 않았어요. 잠시 후 다시 시도해 주세요.' })
    // 이용량을 읽지 못한 동안에는 막지 않고 서버 판단을 그대로 보여 줍니다.
    expect(result.current.usage).toBeNull()
    expect(result.current.canSubmit).toBe(true)
  })

  it('원문 질문을 지원하지 않는 공고는 이용량을 읽지 않는다', () => {
    const planUsage = { usage: vi.fn(() => new Promise<PlanUsage>(() => {})) }
    renderHook(() => useSupportProgramEvidenceQuestionViewModel({ sourceCode: 'KSTARTUP', sourceProgramId: 'K-1' },
      createEvidenceQuestionUseCase(vi.fn()), planUsage))
    expect(planUsage.usage).not.toHaveBeenCalled()
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
      sourceLabel: '기업마당 상세 본문',
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
