import { partnerRecruitmentStyles } from './PartnerRecruitment.styles'

const bar = 'rounded-md bg-surface-muted motion-safe:animate-pulse'

/**
 * 모집글 목록을 불러오는 동안 카드 자리를 잡아 두는 스켈레톤입니다. 완성 카드와 같은 격자·높이라 데이터가 오면 자리가 튀지 않습니다.
 * 읽기 전용 안내는 화면 낭독용으로만 남깁니다.
 */
export function RecruitmentCardSkeleton({ label, text, count = 3 }: { label: string; text: string; count?: number }) {
  return (
    <section className={partnerRecruitmentStyles.cardGrid} aria-label={label} aria-busy="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex min-h-[13rem] flex-col gap-3 rounded-[1.4rem] border border-line bg-white p-[1.35rem]" aria-hidden="true">
          <div className="flex items-center justify-between gap-3"><span className={`${bar} h-5 w-16 rounded-full`} /><span className={`${bar} h-4 w-12`} /></div>
          <span className={`${bar} h-5 w-4/5`} />
          <span className={`${bar} h-3.5 w-3/5`} />
          <span className={`${bar} h-3.5 w-full`} />
          <div className="mt-auto flex gap-1.5"><span className={`${bar} h-5 w-14 rounded-full`} /><span className={`${bar} h-5 w-12 rounded-full`} /><span className={`${bar} h-5 w-16 rounded-full`} /></div>
        </div>
      ))}
      <p className="sr-only" role="status">{text}</p>
    </section>
  )
}
