/**
 * 공고 분류·모집글 희망 지역·목록 필터가 함께 쓰는 지역 정규값입니다.
 * 기업마당 공고의 광역 시·도 16개에 전국을 더한 Core의 정규값과 같으며, 순서는 가나다순입니다.
 */
export const regionNames = [
  '강원', '경기', '경남', '경북', '광주', '대구', '대전', '부산', '서울',
  '세종', '울산', '인천', '전국', '전남', '전북', '제주', '충남', '충북',
] as const

export type RegionName = (typeof regionNames)[number]

/** 지역 제한이 없는 공고·모집글이 쓰는 값입니다. 지역을 골라 거를 때도 함께 포함됩니다. */
export const nationwideRegion: RegionName = '전국'

/** 파트너 모집처럼 지역 제한 없음이 기본인 화면은 전국을 맨 앞에 둡니다. 공고 검색은 가나다순 그대로 씁니다. */
export const regionNamesNationwideFirst: readonly RegionName[] = [
  nationwideRegion,
  ...regionNames.filter((region) => region !== nationwideRegion),
]

/** 파트너 모집 목록 필터처럼 "전체"가 전국까지 뜻하는 화면은 전국을 선택지에서 뺍니다. */
export const regionNamesWithoutNationwide: readonly RegionName[] = regionNames.filter((region) => region !== nationwideRegion)

const regionNameByFullName: Record<string, RegionName> = {
  서울특별시: '서울',
  부산광역시: '부산',
  대구광역시: '대구',
  인천광역시: '인천',
  광주광역시: '광주',
  대전광역시: '대전',
  울산광역시: '울산',
  세종특별자치시: '세종',
  경기도: '경기',
  강원특별자치도: '강원',
  충청북도: '충북',
  충청남도: '충남',
  전북특별자치도: '전북',
  전라남도: '전남',
  경상북도: '경북',
  경상남도: '경남',
  제주특별자치도: '제주',
}

/** 프로필 소재지의 정식 명칭(서울특별시)을 공고 분류의 짧은 이름(서울)으로 바꿉니다. 모르는 값은 그대로 돌려줍니다. */
export function toRegionName(fullName: string): string {
  return regionNameByFullName[fullName] ?? fullName
}
