import type { SupportProgramSearchRelaxation } from '@govbiz/shared/domain/entities/SupportProgramSearchRelaxation'

import { chatPageStyles } from './ChatPage.styles'

/**
 * 추천 결과가 없을 때 마지막 결과 아래에 두는 다시 찾기 도움입니다. 서버가 센 제외 사유를 그대로 알리고, 조건 빼기는
 * 누르면 확인 카드만 만들며 검색은 사용자가 확인한 뒤에 합니다. 버튼의 수는 그 조건 때문에 뺀 공고 수이지 다시 찾은 결과 수가 아닙니다.
 */
export function ZeroResultHelp({ explanation, relaxations, disabled, onRelax, onRephrase }: {
  explanation: string | null
  relaxations: SupportProgramSearchRelaxation[]
  disabled: boolean
  onRelax: (relaxation: SupportProgramSearchRelaxation) => void
  onRephrase: () => void
}) {
  return (
    <section aria-label="결과가 없을 때 다시 찾기" className={chatPageStyles.zeroResultHelp}>
      {explanation ? <p className={chatPageStyles.zeroResultExplanation}>{explanation}</p> : null}
      <div className={chatPageStyles.zeroResultActions} role="group" aria-label="조건을 바꿔 다시 찾기">
        {relaxations.map((relaxation) => (
          <button key={relaxation.kind} type="button" className={chatPageStyles.suggestedQuestionButton}
            disabled={disabled} onClick={() => onRelax(relaxation)}>
            {relaxation.label}
            {relaxation.excludedCount !== null ? <span className={chatPageStyles.zeroResultCount}> · 뺀 공고 {relaxation.excludedCount}건</span> : null}
          </button>
        ))}
        <button type="button" className={chatPageStyles.suggestedQuestionButton} disabled={disabled} onClick={onRephrase}>
          다른 표현으로 다시 말하기
        </button>
      </div>
      {relaxations.length ? <p className={chatPageStyles.proposalHint}>고른 조건은 확인 카드에서 한 번 더 확인한 뒤 검색해요.</p> : null}
    </section>
  )
}
