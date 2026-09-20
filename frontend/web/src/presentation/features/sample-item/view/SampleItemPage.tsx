import { Link } from 'react-router'

import { CoreApiConnectionStatus } from '../../../shared/core-api-status/CoreApiConnectionStatus'
import { useSampleItemViewModel } from '../viewmodel/useSampleItemViewModel'
import { SampleItemComparisonSummary, SampleItemVersionSwitch } from './SampleItemComparison'
import { sampleItemStyles } from './SampleItem.styles'

export function SampleItemPage() {
  const {
    actionMessage,
    errors,
    isReady,
    preparation,
    preparationError,
    prepare,
    registerField,
    submitButtonLabel,
  } = useSampleItemViewModel()

  return (
    <main className={sampleItemStyles.page}>
      <Link
        className={sampleItemStyles.backButton}
        to="/"
      >
        <span>←</span> 지원사업 채팅으로 돌아가기
      </Link>

      <SampleItemVersionSwitch activeVersion="hook" />

      <section className={sampleItemStyles.hero}>
        <div>
          <p className={sampleItemStyles.eyebrow}>React Hook Architecture Example</p>
          <h1 className={sampleItemStyles.heroTitle}>
            재사용 가능한 수직 슬라이스
          </h1>
          <p className={sampleItemStyles.heroDescription}>
            이 예제는 React의 View·ViewModel·UseCase·Repository와 Spring Boot의
            Controller·Service·Domain을 실제 HTTP 계약으로 연결합니다.
            폼과 요청 상태는 이 화면의 Hook이 직접 소유합니다.
          </p>
        </div>
        <CoreApiConnectionStatus />
      </section>

      <SampleItemComparisonSummary activeVersion="hook" />

      <form
        className={sampleItemStyles.form}
        onSubmit={prepare}
      >
        <div>
          <p className={sampleItemStyles.formEyebrow}>
            Sample feature
          </p>
          <h2 className={sampleItemStyles.formTitle}>
            Sample item 준비
          </h2>
          <p className={sampleItemStyles.formDescription}>
            필수 이름과 선택 항목을 Core API로 보내고, 처리 전 준비 상태를 확인합니다.
          </p>
        </div>

        <label className={sampleItemStyles.field} htmlFor="sample-name">
          <span>이름</span>
          <input
            id="sample-name"
            className={sampleItemStyles.formControl}
            placeholder="예: 첫 번째 예제"
            {...registerField('name')}
          />
          {errors.name ? (
            <small className={sampleItemStyles.fieldError}>{errors.name.message}</small>
          ) : null}
        </label>

        <label className={sampleItemStyles.field} htmlFor="sample-category">
          <span>
            카테고리{' '}
            <em className={sampleItemStyles.optionalLabel}>선택</em>
          </span>
          <select
            id="sample-category"
            className={sampleItemStyles.formControl}
            {...registerField('category')}
          >
            <option value="">선택하지 않음</option>
            <option value="BASIC">Basic</option>
            <option value="EXTENDED">Extended</option>
          </select>
        </label>

        <label className={sampleItemStyles.field} htmlFor="sample-note">
          <span>
            메모{' '}
            <em className={sampleItemStyles.optionalLabel}>선택</em>
          </span>
          <textarea
            id="sample-note"
            className={sampleItemStyles.textareaControl}
            rows={4}
            placeholder="예제 기능의 목적이나 다음 처리 단계를 적어 보세요."
            {...registerField('note')}
          />
          {errors.note ? (
            <small className={sampleItemStyles.fieldError}>{errors.note.message}</small>
          ) : null}
        </label>

        <div className={sampleItemStyles.formActions}>
          <div>
            <strong>{actionMessage}</strong>
            <p className={sampleItemStyles.actionDescription}>
              이 예제는 요청 계약만 확인하므로 실제 후속 작업은 시작하지 않습니다.
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
            <strong className={sampleItemStyles.resultTitle}>✓ Core API 요청 성공</strong>
            <span>
              <strong>{preparation.item.name}</strong> 입력을 서버가 정상적으로 받았습니다.
            </span>
            <small className={sampleItemStyles.resultDetail}>
              phase: {preparation.phase} · processing.status: {preparation.processing.status}
              {' '}— 실제 처리는 아직 시작하지 않은 정상 상태입니다.
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
