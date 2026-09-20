import {
  partnerRoleLabels,
  type PartnerRecruitmentCompany,
  type PartnerRecruitmentSummary,
} from '../../../domain/entities/PartnerRecruitment'
import { toRegionName } from '../../../domain/entities/Region'

const DAY_MS = 86_400_000

/** YYYY-MM-DD를 서울 기준 오늘과 비교해 "모집 마감 D-5"처럼 표시합니다. 지난 날짜는 "모집 마감"입니다. */
export function recruitmentDeadlineLabel(deadline: string, today: Date = new Date()): string {
  const remaining = Math.round((Date.parse(`${deadline}T00:00:00+09:00`) - startOfSeoulDay(today)) / DAY_MS)
  if (Number.isNaN(remaining) || remaining < 0) return '모집 마감'
  if (remaining === 0) return '오늘 마감'
  return `모집 마감 D-${remaining}`
}

export function programDeadlineLabel(applicationEndDate: string | null): string {
  return applicationEndDate === null ? '공고 마감일 미정' : `공고 마감 ${applicationEndDate}`
}

/** 기업명 첫 글자를 아바타로 씁니다. */
export function companyInitial(companyName: string): string {
  return companyName.trim().slice(0, 1) || '?'
}

/** 목록·상세가 함께 쓰는 기업 한 줄 요약입니다. 프로필 정식 명칭은 공고 분류 이름으로 줄입니다. */
export function companySummaryLine(company: PartnerRecruitmentCompany): string {
  return `${toRegionName(company.region)} · ${company.industry} · 설립 ${company.foundedYear}`
}

/** 카드에 표시하는 조건 태그입니다. 값에서 만들며 표시 문구로 필터하지 않습니다. */
export function recruitmentConditionTags(recruitment: PartnerRecruitmentSummary): string[] {
  const tags = [
    `찾는 역할 · ${partnerRoleLabels[recruitment.seekingRole]} ${recruitment.seekingCount}곳`,
    `지역 · ${recruitment.region}`,
  ]
  if (recruitment.capabilities.length > 0) tags.push(`역량 · ${recruitment.capabilities.join(', ')}`)
  return tags
}

/** 최소 업력이 없으면 무관입니다. */
export function companyAgeLabel(minimumCompanyAgeYears: number | null): string {
  return minimumCompanyAgeYears === null ? '무관' : `${minimumCompanyAgeYears}년 이상`
}

function startOfSeoulDay(date: Date): number {
  const seoul = new Date(date.getTime() + 9 * 60 * 60 * 1000)
  const day = seoul.toISOString().slice(0, 10)
  return Date.parse(`${day}T00:00:00+09:00`)
}
