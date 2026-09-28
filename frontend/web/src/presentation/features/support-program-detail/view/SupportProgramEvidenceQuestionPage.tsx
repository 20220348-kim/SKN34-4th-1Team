import type { FormEvent } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'

import { isAppPath, supportProgramDetailPath } from '../../../shared/routes/appPaths'

import type { SupportProgramIdentity } from '../../../../domain/repositories/SupportProgramRepository'
import {
  maximumSupportProgramEvidenceQuestionLength,
  useSupportProgramEvidenceQuestionViewModel,
} from '../viewmodel/useSupportProgramEvidenceQuestionViewModel'
import { EvidenceQuestionFeedback } from './EvidenceQuestionFeedback'
import { supportProgramEvidenceQuestionStyles } from './SupportProgramEvidenceQuestionPage.styles'
import { getSupportProgramSearchReturnTo } from './supportProgramNavigation'

/** URL로 지정한 공고의 원문 근거 질문을 담당하는 페이지입니다. */
export function SupportProgramEvidenceQuestionPage() {
  const location = useLocation()
  const searchReturnTo = getSupportProgramSearchReturnTo(location.state, location.search)
  const [searchParams] = useSearchParams()
  const sourceCode = searchParams.get('sourceCode')
  const sourceProgramId = searchParams.get('sourceProgramId')

  if (!sourceCode?.trim() || !sourceProgramId?.trim()) {
    return (
      <main className={supportProgramEvidenceQuestionStyles.page}>
        <Link className={supportProgramEvidenceQuestionStyles.backLink} to={searchReturnTo}>
          검색 결과로 돌아가기
        </Link>
        <section className={supportProgramEvidenceQuestionStyles.evidenceSection}>
          <h1 className={supportProgramEvidenceQuestionStyles.title}>공고 정보를 찾을 수 없습니다</h1>
          <p className={supportProgramEvidenceQuestionStyles.evidenceDescription}>
            공고 주소가 올바르지 않습니다. 검색 결과에서 공고를 다시 선택해 주세요.
          </p>
        </section>
      </main>
    )
  }

  const identity = { sourceCode, sourceProgramId }
  const detailUrl = supportProgramDetailPath(identity, isAppPath(location.pathname), searchReturnTo)

  return (
    <main className={supportProgramEvidenceQuestionStyles.page}>
      <Link className={supportProgramEvidenceQuestionStyles.backLink} to={detailUrl} state={{ searchReturnTo }}>
        ← 공고 상세로 돌아가기
      </Link>
      <SupportProgramEvidenceQuestionContent
        key={JSON.stringify([sourceCode, sourceProgramId])}
        identity={identity}
      />
    </main>
  )
}

function SupportProgramEvidenceQuestionContent({
  identity,
}: {
  identity: SupportProgramIdentity
}) {
  const {
    canSubmit,
    cancelQuestion,
    isAnswering,
    isSupported,
    question,
    questionLength,
    state,
    submitQuestion,
    updateQuestion,
  } = useSupportProgramEvidenceQuestionViewModel(identity)
  const isValidationFailed = state.status === 'validation-failed'
  const isTooLong = questionLength > maximumSupportProgramEvidenceQuestionLength

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void submitQuestion()
  }

  if (!isSupported) {
    return (
      <section className={supportProgramEvidenceQuestionStyles.evidenceSection} aria-labelledby="evidence-question-title">
        <h1 id="evidence-question-title" className={supportProgramEvidenceQuestionStyles.title}>
          공고 원문 기반 질문
        </h1>
        <p className={supportProgramEvidenceQuestionStyles.evidenceDescription}>
          이 제공처 공고는 아직 원문 근거 답변을 지원하지 않습니다. 원문 공고에서 확인해 주세요.
        </p>
      </section>
    )
  }

  return (
    <section className={supportProgramEvidenceQuestionStyles.evidenceSection} aria-labelledby="evidence-question-title">
      <div className={supportProgramEvidenceQuestionStyles.evidenceHeader}>
        <div>
          <p className={supportProgramEvidenceQuestionStyles.sectionEyebrow}>공고 원문 기반</p>
          <h1 id="evidence-question-title" className={supportProgramEvidenceQuestionStyles.title}>
            이 공고에 질문하기
          </h1>
        </div>
        <span className={supportProgramEvidenceQuestionStyles.evidenceBadge}>근거 답변</span>
      </div>
      <p className={supportProgramEvidenceQuestionStyles.evidenceDescription}>
        공고 원문에 있는 내용만 근거로 답합니다. 최종 신청 조건은 원문 공고에서 다시 확인해 주세요.
      </p>

      <form className={supportProgramEvidenceQuestionStyles.evidenceForm} onSubmit={handleSubmit}>
        <label className={supportProgramEvidenceQuestionStyles.evidenceLabel} htmlFor="support-program-evidence-question">
          공고 원문에 질문하기
        </label>
        <textarea
          id="support-program-evidence-question"
          className={supportProgramEvidenceQuestionStyles.evidenceInput}
          aria-describedby={`support-program-evidence-question-hint support-program-evidence-question-count${isTooLong ? ' support-program-evidence-question-length-error' : ''}`}
          aria-invalid={isValidationFailed || isTooLong}
          disabled={isAnswering}
          value={question}
          onChange={(event) => updateQuestion(event.target.value)}
          placeholder="예: 신청 대상과 제출해야 하는 서류를 알려줘"
          rows={3}
        />
        <div className={supportProgramEvidenceQuestionStyles.evidenceControls}>
          <span id="support-program-evidence-question-count" className={supportProgramEvidenceQuestionStyles.evidenceCount}>
            {questionLength} / {maximumSupportProgramEvidenceQuestionLength}자
          </span>
          {isAnswering ? (
            <button
              type="button"
              className={supportProgramEvidenceQuestionStyles.evidenceCancelButton}
              onClick={cancelQuestion}
            >
              질문 취소
            </button>
          ) : (
            <button
              type="submit"
              className={supportProgramEvidenceQuestionStyles.evidenceSubmitButton}
              disabled={!canSubmit}
            >
              질문하고 근거 받기
            </button>
          )}
        </div>
        <small id="support-program-evidence-question-hint" className={supportProgramEvidenceQuestionStyles.evidenceHint}>
          질문은 최대 {maximumSupportProgramEvidenceQuestionLength}자이며, 자동으로 전송되지 않습니다.
        </small>
        {isTooLong ? (
          <p id="support-program-evidence-question-length-error" className={supportProgramEvidenceQuestionStyles.evidenceError} role="alert">
            질문은 {maximumSupportProgramEvidenceQuestionLength}자 이하로 입력해 주세요.
          </p>
        ) : null}
      </form>

      <EvidenceQuestionFeedback state={state} />
    </section>
  )
}
