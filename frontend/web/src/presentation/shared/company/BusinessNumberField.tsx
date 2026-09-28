import { workspacePageStyles } from '../workspace/WorkspacePage.styles'
import { companyFormStyles } from './CompanyForm.styles'

/**
 * 사업자등록번호 입력 칸과 [조회] 버튼입니다. 숫자만 받아 `000-00-00000`로 붙이는 것은 `useBusinessLookup`이 하고,
 * 여기서는 10자리가 될 때까지 버튼을 잠그고 오류·안내 한 줄만 보여 줍니다. 프로필 등록 폼과 온보딩 2단계가 함께 씁니다.
 * 조회를 마친 뒤에는 부르는 쪽이 버튼 글자를 "다시 조회"로 바꿉니다.
 */
export function BusinessNumberField({ id, value, hint, error, required = false, lookup, onChange }: {
  id: string
  value: string
  hint: string
  error?: string
  /** 참이면 이름 옆에 필수 표시(*)를 붙입니다. */
  required?: boolean
  lookup: { canLookup: boolean; isLooking: boolean; onLookup: () => void; label?: string }
  onChange: (value: string) => void
}) {
  return (
    <>
      <div className={companyFormStyles.lookupRow}>
        <label className={companyFormStyles.formField} htmlFor={id}>
          {/* 필수 표시(*)는 CSS로 붙여 접근 가능한 이름은 "사업자등록번호" 그대로 둡니다. 필수 여부는 input의 required가 알립니다. */}
          <span className={`${companyFormStyles.formLabel} ${required ? companyFormStyles.formLabelRequired : ''}`}>사업자등록번호</span>
          <input
            className={companyFormStyles.input}
            id={id}
            type="text"
            name="businessNumber"
            inputMode="numeric"
            autoComplete="off"
            maxLength={12}
            placeholder="000-00-00000"
            required={required}
            aria-invalid={error !== undefined}
            aria-describedby={error ? `${id}-error` : `${id}-hint`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        <button className={workspacePageStyles.secondaryButton} type="button" onClick={lookup.onLookup} disabled={lookup.isLooking || !lookup.canLookup}>
          {lookup.isLooking ? '조회 중…' : (lookup.label ?? '조회')}
        </button>
      </div>
      {error
        ? <p id={`${id}-error`} className={companyFormStyles.formError} role="alert">{error}</p>
        : <span id={`${id}-hint`} className={companyFormStyles.formHint}>{hint}</span>}
    </>
  )
}
