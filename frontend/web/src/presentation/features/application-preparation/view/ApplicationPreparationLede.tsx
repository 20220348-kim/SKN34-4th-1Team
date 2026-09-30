import { applicationServiceFieldLabels, type ApplicationPreparation } from '../../../../domain/entities/ApplicationPreparation'
import { applicationPreparationStyles as s } from './ApplicationPreparation.styles'

/**
 * 답변 입력(25)과 신청 문서 초안(26)의 본문 첫 줄 "공고명 · 양식명 · 신청 분야"입니다. 두 화면이 같은 자리에 같은 문구를 둡니다.
 * 준비 건을 아직 불러오지 못했으면 같은 높이의 스켈레톤을 둡니다.
 */
export function ApplicationPreparationLede({ preparation }: { preparation: ApplicationPreparation | null }) {
  if (!preparation) return <div className={s.ledeSkeleton} aria-hidden="true" />
  const { programTitle, formTitle } = preparation.form
  const rest = `${formTitle} · ${applicationServiceFieldLabels[preparation.serviceField]}`
  return <p className={s.lede} title={`${programTitle} · ${rest}`}>
    <strong className={s.ledeProgram}>{programTitle}</strong> · {rest}
  </p>
}
