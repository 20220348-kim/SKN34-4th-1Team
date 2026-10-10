import { useEffect, useRef, useState } from 'react'

import type { SupportProgramIdentity } from '../../../../domain/repositories/SupportProgramRepository'
import { type SupportProgramEvidenceQuestionState, useSupportProgramEvidenceQuestionViewModel } from './useSupportProgramEvidenceQuestionViewModel'

export type EvidenceQuestionTurn = { id: number; question: string; state: SupportProgramEvidenceQuestionState }

/**
 * 질문 패널의 빈 상태에 두는 예시 키워드입니다. 누르면 입력에 질문 문장이 채워지고, 전송은 사용자가 합니다.
 * 지금 근거는 기업마당·K-Startup 상세 페이지 본문뿐이라(첨부 공고문은 읽지 않음) 두 제공처 본문에 보통 있는 항목만 둡니다.
 * 제출 서류·지원 규모처럼 기업마당에서는 첨부에만 있는 경우가 많은 것은 넣지 않습니다.
 */
export const evidenceQuestionSuggestions = [
  { label: '지원 대상', question: '지원 대상이 어떻게 되나요?' },
  { label: '신청 방법', question: '신청 방법과 접수처를 알려 주세요.' },
  { label: '신청 기간', question: '신청 기간은 언제까지인가요?' },
  { label: '문의처', question: '문의처와 연락처를 알려 주세요.' },
] as const

/**
 * 공고 상세 안 질문 패널의 대화 상태입니다. 질문 한 건의 요청·응답은 [useSupportProgramEvidenceQuestionViewModel]이 맡고,
 * 여기서는 답이 온 질문을 목록으로 쌓아 상세를 보는 동안 앞선 질문·답을 다시 볼 수 있게 합니다.
 * 답을 받은 질문(근거 있음·근거 부족)만 목록에 남기고, 오류·취소는 입력을 지우지 않고 아래에 그대로 두어 다시 보낼 수 있게 합니다.
 * 다른 공고로 옮기면 목록을 비웁니다. 서버에 저장하지 않습니다.
 */
export function useEvidenceQuestionThread(identity: SupportProgramIdentity) {
  const single = useSupportProgramEvidenceQuestionViewModel(identity)
  const [turns, setTurns] = useState<EvidenceQuestionTurn[]>([])
  const pendingQuestion = useRef<string | null>(null)
  const nextId = useRef(1)
  const { sourceCode, sourceProgramId } = identity

  useEffect(() => {
    setTurns([])
    pendingQuestion.current = null
  }, [sourceCode, sourceProgramId])

  const { state, updateQuestion } = single
  useEffect(() => {
    const asked = pendingQuestion.current
    if (asked === null) return
    if (state.status === 'answered' || state.status === 'insufficient-evidence') {
      pendingQuestion.current = null
      const id = nextId.current++
      setTurns((current) => [...current, { id, question: asked, state }])
      // 답을 목록에 올렸으니 입력을 비워 다음 질문을 받습니다.
      updateQuestion('')
    } else if (state.status !== 'loading') {
      pendingQuestion.current = null
    }
    // updateQuestion은 렌더마다 새 함수라 상태만 봅니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  async function submitQuestion() {
    const asked = single.question.trim()
    if (asked.length === 0) {
      await single.submitQuestion()
      return
    }
    pendingQuestion.current = asked
    await single.submitQuestion()
  }

  return {
    ...single,
    submitQuestion,
    /** 답을 받은 질문·답 목록입니다. 먼저 물은 것이 앞에 옵니다. */
    turns,
    /** 아직 질문한 적이 없고 입력도 비어 있을 때만 자주 묻는 질문을 보여 줍니다. 오늘 질문을 다 썼으면 두지 않습니다. */
    showSuggestions: turns.length === 0 && single.question.length === 0 && state.status === 'idle' && !single.isLimitReached,
    suggestions: evidenceQuestionSuggestions,
    /** 목록에 올라간 답은 아래 안내에서 뺍니다. 오류·취소·검증 실패만 입력 아래에 남깁니다. */
    inlineState: state.status === 'answered' || state.status === 'insufficient-evidence' ? ({ status: 'idle' } as const) : state,
  }
}
