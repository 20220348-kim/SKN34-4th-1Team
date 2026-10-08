import { useEffect, useRef, useState } from 'react'

import type { PlanUsageUseCase } from '@govbiz/shared/domain/usecases/PlanUsageUseCase'
import { appContainer } from '../../../../app/appContainer'
import type { SupportProgramEvidenceAnswer } from '../../../../domain/entities/SupportProgramEvidenceAnswer'
import type { SupportProgramIdentity } from '../../../../domain/repositories/SupportProgramRepository'
import type { AskSupportProgramEvidenceQuestionUseCase } from '../../../../domain/usecases/AskSupportProgramEvidenceQuestionUseCase'
import { SupportProgramRequestError } from '../../../../domain/errors/SupportProgramRequestError'
import { planQuotaFailureMessage, planUsageView } from '../../../shared/plan-usage/planUsageView'
import { usePlanUsage } from '../../../shared/plan-usage/usePlanUsage'
import { supportProgramRequestFailureMessage } from '../../../shared/support-program/supportProgramRequestFailureMessage'

export const maximumSupportProgramEvidenceQuestionLength = 500

/** 원문 근거 답변은 기업마당 공고만 지원합니다. */
export function supportsEvidenceQuestion(sourceCode: string) {
  return sourceCode === 'BIZINFO'
}

/** 원문 수집(10초)과 AI 답변(35초)에 여유를 두고 질문 요청 시간을 제한합니다. */
export const supportProgramEvidenceQuestionTimeoutMilliseconds = 70_000

type SupportProgramEvidenceQuestionUseCase = Pick<
  AskSupportProgramEvidenceQuestionUseCase,
  'execute'
>

export type SupportProgramEvidenceQuestionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'answered'; answer: SupportProgramEvidenceAnswer }
  | { status: 'insufficient-evidence' }
  | { status: 'not-supported' }
  | { status: 'unavailable' }
  | { status: 'failed' }
  | { status: 'rate-limited' | 'busy'; message: string }
  /** 요금제의 하루 질문 횟수를 다 썼거나 이용량을 확인하지 못해 서버가 답하지 않았습니다. */
  | { status: 'quota'; message: string }
  | { status: 'cancelled' }
  | { status: 'timed-out' }
  | { status: 'validation-failed'; message: string }

/** 원문 질문 페이지의 입력·응답 상태와 사용자가 요청한 질문의 수명을 관리합니다. */
export function useSupportProgramEvidenceQuestionViewModel(
  identity: SupportProgramIdentity,
  askSupportProgramEvidenceQuestionUseCase: SupportProgramEvidenceQuestionUseCase = appContainer.resolve(
    'askSupportProgramEvidenceQuestionUseCase',
  ),
  planUsageUseCase: Pick<PlanUsageUseCase, 'usage'> = appContainer.resolve('planUsageUseCase'),
) {
  const { sourceCode, sourceProgramId } = identity
  const previousIdentity = useRef({ sourceCode, sourceProgramId })
  const [question, setQuestion] = useState('')
  const [state, setState] = useState<SupportProgramEvidenceQuestionState>({ status: 'idle' })
  const activeRequest = useRef<{
    controller: AbortController
    requestId: number
    timeoutId: ReturnType<typeof setTimeout>
  } | null>(null)
  const latestRequestId = useRef(0)
  const questionLength = question.length
  const isSupported = supportsEvidenceQuestion(sourceCode)
  // 하루 질문 이용량입니다. 질문할 수 없는 공고는 읽지 않고, 로그인 전에는 항목이 없어 그리지 않습니다.
  const planUsage = usePlanUsage(isSupported, planUsageUseCase)
  const usage = planUsageView(planUsage.usage, 'EVIDENCE_QUESTION')
  const isLimitReached = usage?.isLimitReached ?? false
  const isAnswering = state.status === 'loading'
  const canSubmit = isSupported && !isAnswering && !isLimitReached
    && question.trim().length > 0
    && questionLength <= maximumSupportProgramEvidenceQuestionLength

  useEffect(() => {
    // 최초 표시 뒤 늦게 실행된 effect가 이미 입력한 질문을 지우지 않도록 합니다.
    if (previousIdentity.current.sourceCode !== sourceCode
      || previousIdentity.current.sourceProgramId !== sourceProgramId) {
      previousIdentity.current = { sourceCode, sourceProgramId }
      setQuestion('')
      setState({ status: 'idle' })
    }

    return () => {
      const currentRequest = activeRequest.current
      activeRequest.current = null
      if (currentRequest) clearTimeout(currentRequest.timeoutId)
      currentRequest?.controller.abort()
    }
  }, [sourceCode, sourceProgramId])

  function updateQuestion(value: string) {
    if (isAnswering) return

    setQuestion(value)
    setState({ status: 'idle' })
  }

  function cancelQuestion() {
    const currentRequest = activeRequest.current
    activeRequest.current = null
    if (!currentRequest) return

    clearTimeout(currentRequest.timeoutId)
    currentRequest.controller.abort()
    setState({ status: 'cancelled' })
  }

  async function submitQuestion(): Promise<void> {
    if (!isSupported) {
      setState({ status: 'not-supported' })
      return
    }
    const normalizedQuestion = question.trim()
    if (normalizedQuestion.length === 0) {
      setState({
        status: 'validation-failed',
        message: '질문을 입력해 주세요.',
      })
      return
    }
    if (questionLength > maximumSupportProgramEvidenceQuestionLength) {
      setState({
        status: 'validation-failed',
        message: `질문은 ${maximumSupportProgramEvidenceQuestionLength}자 이하로 입력해 주세요. 현재 ${questionLength}자입니다.`,
      })
      return
    }
    if (activeRequest.current) return
    // 오늘 질문을 다 썼으면 보내지 않습니다. 입력 아래 이용량 줄이 다시 채워지는 때를 알립니다.
    if (isLimitReached) return

    const controller = new AbortController()
    const requestId = latestRequestId.current + 1
    latestRequestId.current = requestId
    const timeoutId = setTimeout(() => {
      if (activeRequest.current?.requestId !== requestId) return

      activeRequest.current = null
      controller.abort()
      setState({ status: 'timed-out' })
    }, supportProgramEvidenceQuestionTimeoutMilliseconds)
    activeRequest.current = { controller, requestId, timeoutId }
    setState({ status: 'loading' })

    try {
      const result = await askSupportProgramEvidenceQuestionUseCase.execute(
        { sourceCode, sourceProgramId, question: normalizedQuestion },
        controller.signal,
      )
      if (controller.signal.aborted || activeRequest.current?.requestId !== requestId) return

      if (result.outcome === 'answer') {
        setState(result.answer.answerStatus === 'ANSWERED'
          ? { status: 'answered', answer: result.answer }
          : { status: 'insufficient-evidence' })
        return
      }

      setState(result.outcome === 'not-supported'
        ? { status: 'not-supported' }
        : { status: 'unavailable' })
    } catch (error) {
      if (controller.signal.aborted || activeRequest.current?.requestId !== requestId) return
      const quotaMessage = planQuotaFailureMessage(error)
      setState(quotaMessage !== null
        ? { status: 'quota', message: quotaMessage }
        : error instanceof SupportProgramRequestError
          ? { status: error.reason, message: supportProgramRequestFailureMessage(error) }
          : { status: 'failed' })
    } finally {
      clearTimeout(timeoutId)
      if (activeRequest.current?.requestId === requestId) {
        activeRequest.current = null
      }
      // 답을 받았든 거절됐든 질문을 보냈으니 남은 횟수를 다시 읽습니다.
      planUsage.reload()
    }
  }

  return {
    canSubmit,
    cancelQuestion,
    isAnswering,
    isSupported,
    /** 오늘 질문 이용량 한 줄입니다. 읽지 못했거나 로그인 전이면 null입니다. */
    usage,
    /** 오늘 질문을 다 써서 입력과 보내기를 막습니다. */
    isLimitReached,
    question,
    questionLength,
    state,
    submitQuestion,
    updateQuestion,
  }
}
