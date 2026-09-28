import { useEffect, useState } from 'react'

import { SelectField } from '../workspace/SelectField'
import { YearPicker } from '../workspace/YearPicker'
import { companyFormStyles } from './CompanyForm.styles'
import type { CompanyFormErrors, CompanyFormField, CompanyFormValues } from './companyRegistrationForm'

/**
 * 담당자가 적는 기업 기본정보 네 칸(소재지·업종·설립연도·홈페이지)입니다. 프로필의 등록·수정 폼과 온보딩 2단계가 같은 칸을 씁니다.
 * `idPrefix`로 한 화면에 두 폼이 있어도 label·input 연결이 겹치지 않고, 오류는 칸 아래에 각각 보여 주며
 * 검증에 실패하면 첫 오류 칸으로 포커스를 옮깁니다. `foldOptionalOnCompact`면 좁은 화면에서 홈페이지 칸을 "선택 항목 더 보기" 아래에 접습니다.
 */
export function CompanyProfileFields({ idPrefix, values, errors, regions, industries, foundedYearMin, currentYear, homepagePreview, focusField, onFocused, onChange, foldOptionalOnCompact = false }: {
  idPrefix: string
  values: CompanyFormValues
  errors: CompanyFormErrors
  regions: readonly string[]
  industries: readonly string[]
  foundedYearMin: number
  currentYear: number
  homepagePreview: string | null
  /** 검증에 실패했을 때 포커스를 옮길 첫 칸입니다. 옮긴 뒤 `onFocused`로 비웁니다. */
  focusField: CompanyFormField | null
  onFocused: () => void
  onChange: (field: keyof CompanyFormValues, value: string) => void
  foldOptionalOnCompact?: boolean
}) {
  // 접힌 칸에 값이나 오류가 있으면 펼친 채로 둡니다.
  const [showOptional, setShowOptional] = useState(false)
  const optionalOpen = !foldOptionalOnCompact || showOptional || values.homepageUrl !== '' || errors.homepageUrl !== undefined

  useEffect(() => {
    if (focusField === null) return
    if (focusField === 'homepageUrl') setShowOptional(true)
    document.getElementById(`${idPrefix}-${focusField}`)?.focus()
    onFocused()
  }, [focusField, onFocused, idPrefix])

  const selectField = (name: 'region' | 'industry') => ({
    id: `${idPrefix}-${name}`,
    name,
    invalid: errors[name] !== undefined,
    describedBy: errors[name] ? `${idPrefix}-${name}-error` : undefined,
    value: values[name],
  })
  const errorOf = (name: keyof CompanyFormValues) =>
    errors[name] ? <p id={`${idPrefix}-${name}-error`} className={companyFormStyles.formError} role="alert">{errors[name]}</p> : null
  const foundedYear = /^\d{4}$/.test(values.foundedYear) ? Number(values.foundedYear) : null

  return (
    <div className={companyFormStyles.formGrid}>
      <div className={companyFormStyles.formField}>
        <label className={companyFormStyles.formLabel} htmlFor={`${idPrefix}-region`}>소재지</label>
        <SelectField className={companyFormStyles.input} {...selectField('region')}
          options={[{ value: '', label: '선택' }, ...regions.map((region) => ({ value: region, label: region }))]}
          onChange={(value) => onChange('region', value)} />
        {errorOf('region')}
      </div>
      <div className={companyFormStyles.formField}>
        <label className={companyFormStyles.formLabel} htmlFor={`${idPrefix}-industry`}>업종</label>
        <SelectField className={companyFormStyles.input} {...selectField('industry')}
          options={[{ value: '', label: '선택' }, ...industries.map((industry) => ({ value: industry, label: industry }))]}
          onChange={(value) => onChange('industry', value)} />
        {errorOf('industry')}
      </div>
      <div className={companyFormStyles.formField}>
        <label className={companyFormStyles.formLabel} htmlFor={`${idPrefix}-foundedYear`}>설립연도</label>
        <YearPicker
          id={`${idPrefix}-foundedYear`}
          label="설립연도"
          value={foundedYear}
          min={foundedYearMin}
          max={currentYear}
          invalid={errors.foundedYear !== undefined}
          onChange={(year) => onChange('foundedYear', String(year))}
        />
        {errorOf('foundedYear')}
      </div>
      {foldOptionalOnCompact && !optionalOpen ? (
        <button type="button" className={companyFormStyles.optionalToggle} onClick={() => setShowOptional(true)} aria-expanded={false} aria-controls={`${idPrefix}-homepageUrl-field`}>
          선택 항목 더 보기
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </button>
      ) : null}
      <div id={`${idPrefix}-homepageUrl-field`} className={`${companyFormStyles.formField} ${foldOptionalOnCompact && !optionalOpen ? companyFormStyles.optionalHiddenOnCompact : ''}`}>
        <label className={companyFormStyles.formLabel} htmlFor={`${idPrefix}-homepageUrl`}>홈페이지 <span className={companyFormStyles.optionalMark}>(선택)</span></label>
        <input
          className={companyFormStyles.input}
          id={`${idPrefix}-homepageUrl`}
          name="homepageUrl"
          type="text"
          inputMode="url"
          autoComplete="url"
          placeholder="https://company.co.kr"
          aria-invalid={errors.homepageUrl !== undefined}
          aria-describedby={errors.homepageUrl ? `${idPrefix}-homepageUrl-error` : undefined}
          value={values.homepageUrl}
          onChange={(event) => onChange('homepageUrl', event.target.value)}
        />
        {errorOf('homepageUrl') ?? (homepagePreview ? <span className={companyFormStyles.formHint}>{homepagePreview}</span> : null)}
      </div>
    </div>
  )
}
