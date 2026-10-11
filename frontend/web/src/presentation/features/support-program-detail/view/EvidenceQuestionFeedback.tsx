import { useId, useState } from 'react'

import type { SupportProgramEvidenceAnswer, SupportProgramEvidenceCitation } from '../../../../domain/entities/SupportProgramEvidenceAnswer'
import type { SupportProgramEvidenceQuestionState } from '../viewmodel/useSupportProgramEvidenceQuestionViewModel'
import { supportProgramEvidenceQuestionStyles as s } from './SupportProgramEvidenceQuestionPage.styles'

/** 펼친 근거 원문이 이보다 길면 앞부분만 보이고 [전체 보기]로 다 봅니다. */
const excerptPreviewCharacters = 240
const excerptPreviewLines = 5

/**
 * 원문 질문 한 건의 결과입니다. 답이 오면 답변과 근거 인용을, 아니면 상태에 맞는 안내를 보여 줍니다.
 * 원문 질문 화면과 공고 상세의 질문 패널, Gov 에이전트 대화가 같은 부품을 씁니다.
 */
export function EvidenceQuestionFeedback({ state, compact = false }: { state: SupportProgramEvidenceQuestionState; compact?: boolean }) {
  if (state.status === 'idle') return null

  if (state.status === 'loading') {
    return (
      <p className={compact ? s.evidenceFeedbackCompact : s.evidenceFeedback} role="status" aria-live="polite">
        공고 원문에서 답변 근거를 찾고 있습니다.
      </p>
    )
  }

  if (state.status === 'answered') return <EvidenceAnswer answer={state.answer} compact={compact} />

  if (state.status === 'validation-failed' || state.status === 'rate-limited' || state.status === 'busy' || state.status === 'quota') {
    return <p className={compact ? s.evidenceErrorCompact : s.evidenceError} role="alert">{state.message}</p>
  }

  const message = evidenceFeedbackMessage(state.status)
  const isFailure = state.status === 'failed' || state.status === 'unavailable' || state.status === 'timed-out'
  const className = isFailure
    ? (compact ? s.evidenceErrorCompact : s.evidenceError)
    : (compact ? s.evidenceFeedbackCompact : s.evidenceFeedback)
  return (
    <p className={className} role={isFailure ? 'alert' : 'status'} aria-live="polite">
      {message}
    </p>
  )
}

/**
 * 답을 먼저 보여 주고, 근거로 쓴 원문 덩어리는 접어 둡니다. 원문 덩어리는 길어서(최대 1,500자) 펼쳐도 답과 겹치는 줄부터
 * 다섯 줄만 보이고 [전체 보기]로 다 봅니다. 출처 링크는 같은 주소를 한 번만 두어 접어 둔 채로도 원문을 열 수 있습니다.
 */
function EvidenceAnswer({ answer, compact }: { answer: SupportProgramEvidenceAnswer; compact: boolean }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const sources = answer.citations.filter((citation, index, all) => all.findIndex((other) => other.sourceUrl === citation.sourceUrl) === index)
  return (
    <article className={compact ? s.evidenceAnswerCompact : s.evidenceAnswer} aria-live="polite">
      {compact ? null : <p className={s.evidenceAnswerEyebrow}>원문 근거 답변</p>}
      <p className={s.evidenceAnswerText}>{answer.answer}</p>
      <div className={s.evidenceFooter}>
        <button type="button" className={s.evidenceToggle} aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
          {open ? '근거 원문 접기' : `근거 원문 ${answer.citations.length}건 보기`}
        </button>
        {sources.map((source) => (
          <a key={source.sourceUrl} className={s.evidenceSourceLink} href={source.sourceUrl} target="_blank" rel="noreferrer">
            {source.sourceLabel} ↗
          </a>
        ))}
      </div>
      <ol id={listId} className={open ? s.evidenceCitationList : 'hidden'} hidden={!open}>
        {answer.citations.map((citation) => (
          <EvidenceCitation key={`${citation.chunkOrder}:${citation.sourceUrl}:${citation.excerpt}`} citation={citation} answer={answer.answer} />
        ))}
      </ol>
    </article>
  )
}

function EvidenceCitation({ citation, answer }: { citation: SupportProgramEvidenceCitation; answer: string }) {
  const [expanded, setExpanded] = useState(false)
  const text = readableExcerpt(citation.excerpt)
  const isLong = text.length > excerptPreviewCharacters || text.split('\n').length > excerptPreviewLines
  const preview = isLong && !expanded ? previewFromAnswerLine(text, answer) : text
  return (
    <li className={s.evidenceCitation}>
      {/* 여백은 바깥에, 줄 자르기는 안쪽 글에 두어 잘린 다음 줄이 여백에 비치지 않게 합니다. */}
      <blockquote className={s.evidenceExcerpt}><p className={isLong && !expanded ? s.evidenceExcerptPreview : s.evidenceExcerptText}>{preview}</p></blockquote>
      {isLong ? (
        <button type="button" className={s.evidenceMoreButton} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? '접기' : '전체 보기'}
        </button>
      ) : null}
    </li>
  )
}

/**
 * 원문 덩어리 첫머리의 "공고명:"·"공식 원문:" 줄은 Core가 붙인 머리라 위 제목·출처 링크와 겹쳐 빼고, 빈 줄은 한 줄로 줄입니다.
 * 원문 글자 자체는 바꾸지 않습니다.
 */
function readableExcerpt(excerpt: string): string {
  const lines = excerpt.split('\n')
  // 원문 덩어리는 줄 사이마다 빈 줄이 있어 머리 줄 사이의 빈 줄도 함께 건너뜁니다.
  while (lines.length > 0 && (lines[0]!.trim() === '' || /^(공고명|공식 원문): /.test(lines[0]!))) lines.shift()
  return lines.join('\n').replace(/\n[ \t]*\n+/g, '\n').trim() || excerpt.trim()
}

/** 두 글자 이상인 낱말입니다. 한국어 조사가 붙은 낱말("스타트업이")도 앞부분이 같으면 같은 낱말로 봅니다. */
const wordPattern = /[\p{L}\p{N}]{2,}/gu

/**
 * 접은 미리보기를 답과 낱말이 가장 많이 겹치는 원문 줄 한 줄 앞에서 시작합니다. 원문 덩어리 첫머리는 소관 부처·기관 같은
 * 머리 정보라 답을 받친 줄이 [전체 보기] 뒤에 숨기 쉽기 때문입니다. AI를 부르지 않는 화면 표시 규칙이며,
 * 두 낱말 이상 겹치는 줄이 없으면 처음부터 보여 줍니다. 앞을 건너뛰면 "…" 줄로 알리고, [전체 보기]는 늘 처음부터 다 보여 줍니다.
 */
function previewFromAnswerLine(text: string, answer: string): string {
  const answerWords = answer.match(wordPattern) ?? []
  const lines = text.split('\n')
  let best = -1
  let bestScore = 1
  lines.forEach((line, index) => {
    const words = new Set(line.match(wordPattern) ?? [])
    const score = [...words].filter((word) => answerWords.some((other) => other.startsWith(word) || word.startsWith(other))).length
    if (score > bestScore) {
      best = index
      bestScore = score
    }
  })
  const start = Math.max(0, best - 1)
  return start === 0 ? text : `…\n${lines.slice(start).join('\n')}`
}

function evidenceFeedbackMessage(
  status: Exclude<SupportProgramEvidenceQuestionState['status'], 'idle' | 'loading' | 'answered' | 'validation-failed' | 'rate-limited' | 'busy' | 'quota'>,
) {
  const messages = {
    cancelled: '질문 요청을 취소했습니다.',
    'timed-out': '답변 시간이 초과되었습니다. 입력한 질문을 다시 전송해 주세요.',
    'insufficient-evidence': '공고 원문에서 이 질문에 답할 만큼 충분한 근거를 찾지 못했습니다. 원문 공고를 확인해 주세요.',
    'not-supported': '이 제공처 공고는 아직 원문 근거 답변을 지원하지 않습니다. 원문 공고에서 확인해 주세요.',
    unavailable: '원문 근거 답변을 지금 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    failed: '질문에 답하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  } as const
  return messages[status]
}
