import { useEffect, useRef, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import type { SupportProgramEvidenceAnswer } from '../../../../domain/entities/SupportProgramEvidenceAnswer'
import type { SupportProgramIdentity } from '../../../../domain/repositories/SupportProgramRepository'
import type { AskSupportProgramEvidenceQuestionUseCase } from '../../../../domain/usecases/AskSupportProgramEvidenceQuestionUseCase'
import { SupportProgramRequestError } from '../../../../domain/errors/SupportProgramRequestError'
import { supportProgramRequestFailureMessage } from '../../../shared/support-program/supportProgramRequestFailureMessage'

export const maximumSupportProgramEvidenceQuestionLength = 500

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
  | { status: 'cancelled' }
  | { status: 'timed-out' }
  | { status: 'validation-failed'; message: string }

/** 원문 질문 페이지의 입력·응답 상태와 사용자가 요청한 질문의 수명을 관리합니다. */
export function useSupportProgramEvidenceQuestionViewModel(
  identity: SupportProgramIdentity,
  askSupportProgramEvidenceQuestionUseCase: SupportProgramEvidenceQuestionUseCase = appContainer.resolve(
    'askSupportProgramEvidenceQuestionUseCase',
  ),
) {
  const { sourceCode, sourceProgramId } = identity
  const [question, setQuestion] = useState('')
  const [state, setState] = useState<SupportProgramEvidenceQuestionState>({ status: 'idle' })
  const activeRequest = useRef<{
    controller: AbortController
    requestId: number
    timeoutId: ReturnType<typeof setTimeout>
  } | null>(null)
  const latestRequestId = useRef(0)
  const questionLength = question.length
  const isSupported = sourceCode === 'BIZINFO'
  const isAnswering = state.status === 'loading'
  const canSubmit = isSupported && !isAnswering
    && question.trim().length > 0
    && questionLength <= maximumSupportProgramEvidenceQuestionLength

  useEffect(() => {
    setQuestion('')
    setState({ status: 'idle' })

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
      setState(error instanceof SupportProgramRequestError
        ? { status: error.reason, message: supportProgramRequestFailureMessage(error) }
        : { status: 'failed' })
    } finally {
      clearTimeout(timeoutId)
      if (activeRequest.current?.requestId === requestId) {
        activeRequest.current = null
      }
    }
  }

  return {
    canSubmit,
    cancelQuestion,
    isAnswering,
    isSupported,
    question,
    questionLength,
    state,
    submitQuestion,
    updateQuestion,
  }
}
