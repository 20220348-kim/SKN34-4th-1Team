import { regionNames } from '../../../../domain/entities/Region'
import { supportProgramCategories } from '../../../../domain/entities/SupportProgramCategory'

// Core의 지역 정규값(domain/entities/Region)과 현재 제공처의 분야명을 사용합니다. 공고 유무와 무관하게 먼저 표시합니다.
export const defaultCatalogRegions: readonly string[] = regionNames

export const defaultCatalogCategories: readonly string[] = supportProgramCategories

export const defaultCatalogStartupStages: readonly string[] = [
  '예비창업자', '1년미만', '2년미만', '3년미만', '5년미만', '7년미만', '10년미만',
]

export const defaultCatalogApplicantTypes: readonly string[] = [
  '청소년', '대학생', '일반인', '대학', '연구기관', '일반기업', '1인 창조기업',
]

export const defaultCatalogFounderAges: readonly string[] = [
  '만 20세 미만', '만 20세 이상 ~ 만 39세 이하', '만 40세 이상',
]

/** 기본 버튼의 순서를 유지하고 서버의 추가 분류만 덧붙입니다. 정확일치 값은 변환하지 않습니다. */
export function mergeCatalogFilterOptions(defaults: readonly string[], available: readonly string[] = []): string[] {
  return [...new Set([...defaults, ...available].filter((value) => value.trim().length > 0))]
}
