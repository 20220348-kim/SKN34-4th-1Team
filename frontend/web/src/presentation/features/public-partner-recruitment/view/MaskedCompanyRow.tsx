import { publicPartnerRecruitmentStyles as styles } from './PublicPartnerRecruitment.styles'
import { maskedCompanyLabel } from './publicPartnerMessages'

/**
 * 비로그인 화면에서 작성 기업 정보 자리를 대신하는 가림 행입니다. 지원사업 검색의 잠긴 결과처럼 실제 값 대신
 * 흐린 자리표시자를 그려 상호·소재지·업종이 DOM에도 남지 않게 합니다.
 */
export function MaskedCompanyRow() {
  return (
    <div className={styles.maskedRow} role="img" aria-label={maskedCompanyLabel}>
      <div aria-hidden="true" className={styles.maskedSkeleton}>
        <span className={styles.maskedAvatar} />
        <span className="flex min-w-0 flex-col gap-[0.3rem]">
          <span className={styles.maskedLine} />
          <span className={styles.maskedLineShort} />
        </span>
        <span className={styles.maskedTag} />
      </div>
      <div aria-hidden="true" className={styles.maskedOverlay}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><path d="M12 14v3" />
        </svg>
        {maskedCompanyLabel}
      </div>
    </div>
  )
}
