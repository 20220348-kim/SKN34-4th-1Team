import { businessStatusNotes } from '@govbiz/shared/domain/entities/CompanyRegistration'
import { type BusinessLookup, formatBusinessNumber } from '../../../domain/entities/Company'
import { workspaceTagClassName } from '../workspace/WorkspacePage.styles'
import { companyFormStyles } from './CompanyForm.styles'
import { businessStatusTone } from './companyRegistrationForm'

const iconPaths = {
  ok: 'm5 12 5 5L20 7',
  warn: 'M12 8v5M12 16.5h.01',
  danger: 'M7 7l10 10M17 7 7 17',
} as const

/**
 * 사업자 조회 결과 카드입니다. 왼쪽 동그라미 아이콘, 상호·상태 배지, 번호와 상태별 안내 한 줄을 보여 줍니다.
 * 계속은 초록 바탕에 체크, 휴업은 주의(등록은 되지만 파트너 기능 잠김), 폐업은 위험(등록 불가)입니다. 살아 있는 영역이라 스크린 리더가 읽습니다.
 */
export function BusinessLookupResult({ business }: { business: BusinessLookup }) {
  const tone = businessStatusTone(business.businessStatusCode)
  const surface = tone === 'ok' ? companyFormStyles.lookupResultOk : tone === 'warn' ? companyFormStyles.lookupResultWarn : companyFormStyles.lookupResultDanger
  const iconTone = tone === 'ok' ? companyFormStyles.lookupIconOk : tone === 'warn' ? companyFormStyles.lookupIconWarn : companyFormStyles.lookupIconDanger
  return (
    <div className={`${companyFormStyles.lookupResult} ${surface}`} role="status" aria-label="조회 결과">
      <span className={`${companyFormStyles.lookupIcon} ${iconTone}`} aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d={iconPaths[tone]} />
        </svg>
      </span>
      <div className={companyFormStyles.lookupBody}>
        <div className={companyFormStyles.lookupHeadline}>
          <strong className={companyFormStyles.lookupName}>{business.companyName}</strong>
          <span className={workspaceTagClassName(tone)}>{business.businessStatus}</span>
        </div>
        <span className={companyFormStyles.lookupDetail}>국세청 조회 · {formatBusinessNumber(business.businessNumber)}</span>
        <span className={companyFormStyles.lookupNote}>{businessStatusNotes[business.businessStatusCode]}</span>
      </div>
    </div>
  )
}
