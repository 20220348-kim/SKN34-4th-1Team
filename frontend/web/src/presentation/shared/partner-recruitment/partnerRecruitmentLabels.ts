import { daysUntil, ddayTone, formatDate, formatDday, type DdayTone } from '@govbiz/shared/domain/labels'

import {
  partnerRoleLabels,
  type PartnerRecruitmentCompany,
  type PartnerRecruitmentSummary,
} from '../../../domain/entities/PartnerRecruitment'
import { toRegionName } from '../../../domain/entities/Region'

/**
 * 모집 중인 글의 마감 D-day 배지입니다(서울 기준, shared D-day 글자와 `ddayTone` 색 단계). 예: "D-5", 당일 "오늘 마감".
 * 마감됐거나 마감일이 지났거나 읽을 수 없으면 배지를 그리지 않도록 null입니다.
 */
export function recruitmentDday(deadline: string, closed: boolean, today: Date = new Date()): { label: string; tone: DdayTone } | null {
  if (closed) return null
  const days = daysUntil(deadline, today)
  return days === null || days < 0 ? null : { label: formatDday(days), tone: ddayTone(days) }
}

/**
 * 카드 오른쪽의 모집 마감일입니다. 예: "모집 마감일 2026.10.11". 남은 날은 왼쪽 D-day 배지가, 마감 여부는 왼쪽 상태 태그가 알립니다.
 * 읽을 수 없는 날짜는 "모집 마감일 확인 필요"입니다(모바일과 같은 문구).
 */
export function recruitmentDeadlineText(deadline: string): string {
  return daysUntil(deadline) === null ? '모집 마감일 확인 필요' : `모집 마감일 ${formatDate(deadline)}`
}

/** 공고 접수 마감일을 shared 날짜 형식으로 씁니다. 예: "공고 마감 2026.10.07". */
export function programDeadlineLabel(applicationEndDate: string | null): string {
  return applicationEndDate === null ? '공고 마감일 미정' : `공고 마감 ${formatDate(applicationEndDate)}`
}


/**
 * 법인 형태 표기입니다. 상호 앞뒤에 붙는 "(주)"·"주식회사"·"㈜" 같은 말은 회사를 구분해 주지 않으므로 아바타 글자에서 뺍니다.
 * 괄호 안 표기와 풀어 쓴 이름을 모두 다루고, 긴 것부터 지워 "유한책임회사"가 "유한회사"로 잘못 남지 않게 합니다.
 */
const legalFormMarkers = [
  '유한책임회사', '농업회사법인', '어업회사법인', '사회적협동조합', '주식회사', '유한회사', '합자회사', '합명회사', '사단법인', '재단법인', '협동조합',
  '(주)', '(유)', '(합)', '(사)', '(재)', '（주）', '㈜',
]
const legalFormPattern = new RegExp(
  `(?:${legalFormMarkers.map((marker) => marker.replace(/[()]/g, '\\$&')).join('|')})`,
  'g',
)

/** 기업명 첫 글자를 아바타로 씁니다. "(주) 미래중앙"은 "미", "주식회사 한빛"은 "한"이고, 이름이 비면 "?"입니다. */
export function companyInitial(companyName: string): string {
  const stripped = companyName.replace(legalFormPattern, ' ')
  // 남은 것 중 글자·숫자로 시작하는 첫 자를 고릅니다. 괄호·점·공백 같은 기호는 건너뜁니다.
  const match = stripped.match(/[\p{L}\p{N}]/u) ?? companyName.match(/[\p{L}\p{N}]/u)
  return match?.[0] ?? '?'
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
