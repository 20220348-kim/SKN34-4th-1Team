import type { SubmitEvent } from 'react'
import { Link } from 'react-router'

import { CoreApiConnectionStatus } from '../../../shared/core-api-status/CoreApiConnectionStatus'
import { useReduxSampleItemViewModel } from '../viewmodel/useReduxSampleItemViewModel'
import { SampleItemComparisonSummary, SampleItemVersionSwitch } from './SampleItemComparison'
import { sampleItemStyles } from './SampleItem.styles'

export function ReduxSampleItemPage() {
  const {
    actionMessage,
    errors,
    isReady,
    preparation,
    preparationError,
    prepare,
    reset,
    submitButtonLabel,
    updateCategory,
    updateName,
    updateNote,
    values,
  } = useReduxSampleItemViewModel()

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    void prepare()
  }

  return (
    <main className={sampleItemStyles.page}>
      <Link
        className={sampleItemStyles.backButton}
        to="/"
      >
        <span>←</span> 지원사업 채팅으로 돌아가기
      </Link>

      <SampleItemVersionSwitch activeVersion="redux" />

      <section className={sampleItemStyles.hero}>
        <div>
          <p className={sampleItemStyles.eyebrow}>Redux Toolkit Architecture Example</p>
          <h1 className={sampleItemStyles.heroTitle}>
            Redux 기반 수직 슬라이스
          </h1>
          <p className={sampleItemStyles.heroDescription}>
            폼 값과 요청 결과를 Redux Store에 저장하고, ViewModel이 같은 UseCase·Repository·HTTP
            계약을 실행합니다. 화면을 나갔다 돌아와도 완료 상태가 유지됩니다.
          </p>
        </div>
        <CoreApiConnectionStatus />
      </section>

      <SampleItemComparisonSummary activeVersion="redux" />

      <form
        className={sampleItemStyles.form}
        onSubmit={handleSubmit}
      >
        <div className={sampleItemStyles.formHeader}>
          <div>
            <p className={sampleItemStyles.formEyebrow}>
              Redux sample feature
            </p>
            <h2 className={sampleItemStyles.formTitle}>
              Sample item 준비
            </h2>
            <p className={sampleItemStyles.formDescription}>
              입력·요청 상태·결과는 <code>state.sampleItem</code>이 소유합니다.
            </p>
          </div>
          <button
            className={sampleItemStyles.resetButton}
            type="button"
            onClick={reset}
          >
            Redux 상태 초기화
          </button>
        </div>

        <label className={sampleItemStyles.field} htmlFor="redux-sample-name">
          <span>이름</span>
          <input
            id="redux-sample-name"
            className={sampleItemStyles.formControl}
            value={values.name}
            placeholder="예: Redux 예제"
            onChange={(event) => updateName(event.target.value)}
          />
          {errors.name ? <small className={sampleItemStyles.fieldError}>{errors.name}</small> : null}
        </label>

        <label className={sampleItemStyles.field} htmlFor="redux-sample-category">
          <span>
            카테고리{' '}
            <em className={sampleItemStyles.optionalLabel}>선택</em>
          </span>
          <select
            id="redux-sample-category"
            className={sampleItemStyles.formControl}
            value={values.category}
            onChange={(event) => updateCategory(event.target.value)}
          >
            <option value="">선택하지 않음</option>
            <option value="BASIC">Basic</option>
            <option value="EXTENDED">Extended</option>
          </select>
        </label>

        <label className={sampleItemStyles.field} htmlFor="redux-sample-note">
          <span>
            메모{' '}
            <em className={sampleItemStyles.optionalLabel}>선택</em>
          </span>
          <textarea
            id="redux-sample-note"
            className={sampleItemStyles.textareaControl}
            rows={4}
            value={values.note}
            placeholder="Redux Store에 유지할 메모를 적어 보세요."
            onChange={(event) => updateNote(event.target.value)}
          />
          {errors.note ? <small className={sampleItemStyles.fieldError}>{errors.note}</small> : null}
        </label>

        <div className={sampleItemStyles.formActions}>
          <div>
            <strong>{actionMessage}</strong>
            <p className={sampleItemStyles.actionDescription}>
              AbortController는 직렬화할 수 없으므로 Redux가 아니라 ViewModel ref가 관리합니다.
            </p>
          </div>
          <button
            type="submit"
            className={sampleItemStyles.submitButton}
            disabled={!isReady}
          >
            {submitButtonLabel}
          </button>
        </div>

        {preparation ? (
          <output className={sampleItemStyles.result}>
            <strong className={sampleItemStyles.resultTitle}>✓ Redux Store에 요청 성공 저장</strong>
            <span>
              <strong>{preparation.item.name}</strong> 입력을 서버가 정상적으로 받았습니다.
            </span>
            <small className={sampleItemStyles.resultDetail}>
              phase: {preparation.phase} · processing.status: {preparation.processing.status}
              {' '}— 이 결과는 다른 화면으로 이동해도 Store에 남습니다.
            </small>
          </output>
        ) : null}

        {preparationError ? (
          <p className={sampleItemStyles.preparationError}>{preparationError}</p>
        ) : null}
      </form>
    </main>
  )
}
