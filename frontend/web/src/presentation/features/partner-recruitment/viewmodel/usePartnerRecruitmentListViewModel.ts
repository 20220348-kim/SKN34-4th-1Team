import { useState } from 'react'

import { partnerRoleLabels, type PartnerRole } from '../../../../domain/entities/PartnerRecruitment'
import {
  defaultPartnerRecruitmentQuery,
  hasPartnerRecruitmentNarrowing,
  partnerRecruitmentSortLabels,
  type PartnerRecruitmentQuery,
  type PartnerRecruitmentSort,
} from '../../../../domain/entities/PartnerRecruitmentQuery'
import { regionNamesWithoutNationwide } from '../../../../domain/entities/Region'
import { useAuthSession } from '../../../shared/auth/hooks/useAuthSession'
import { usePartnerRecruitmentBrowse } from '../../../shared/partner-recruitment/usePartnerRecruitmentBrowse'
import { toFilterChoiceOptions, type FilterChoiceOption } from '../../../shared/workspace/filterChoiceOptions'

const roleOptions: FilterChoiceOption[] = (Object.keys(partnerRoleLabels) as PartnerRole[])
  .map((role) => ({ value: role, label: partnerRoleLabels[role] }))
// "전체"가 전국 모집글까지 뜻하므로 전국은 선택지에 두지 않습니다.
const regionOptions = toFilterChoiceOptions(regionNamesWithoutNationwide)

/** 조회 버튼을 눌러야 적용되는 조건입니다. 정렬·내 글만은 바로 적용되므로 여기 없습니다. */
type PartnerRecruitmentDraft = Pick<PartnerRecruitmentQuery, 'keyword' | 'seekingRoles' | 'regions'>
const emptyDraft: PartnerRecruitmentDraft = { keyword: '', seekingRoles: [], regions: [] }

function toggled<Value>(values: Value[], value: Value): Value[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}
const sortOptions: FilterChoiceOption[] = (Object.keys(partnerRecruitmentSortLabels) as PartnerRecruitmentSort[])
  .map((sort) => ({ value: sort, label: partnerRecruitmentSortLabels[sort] }))

/**
 * 파트너 모집 목록의 대표 ViewModel입니다. 검색어·찾는 역할·지역은 입력 중인 초안으로 두었다가 조회 버튼에서 적용하고,
 * 정렬·페이지는 바로 적용해 모집 API로 조회합니다. 내 글은 "내 모집글" 탭이 따로 보여 줍니다. 세션의 기업 등록 여부로 작성 안내 문구를 정합니다(작성 버튼은 공용 파트너 관리 머리글이 맡음).
 */
export function usePartnerRecruitmentListViewModel() {
  const { hasCompany } = useAuthSession()
  const [query, setQuery] = useState<PartnerRecruitmentQuery>(defaultPartnerRecruitmentQuery)
  const [draft, setDraft] = useState<PartnerRecruitmentDraft>(emptyDraft)
  const { phase, page, retry } = usePartnerRecruitmentBrowse(query)

  /** 조건이 바뀌면 첫 페이지부터 다시 봅니다. */
  function update(patch: Partial<PartnerRecruitmentQuery>) {
    setQuery((current) => ({ ...current, page: 1, ...patch }))
  }

  return {
    hasCompany,
    phase,
    recruitments: page?.recruitments ?? [],
    total: page?.total ?? 0,
    totalPages: page?.totalPages ?? 0,
    retry,
    query,
    draft,
    roleOptions,
    regionOptions,
    sortOptions,
    updateKeyword: (keyword: string) => setDraft((current) => ({ ...current, keyword })),
    toggleSeekingRole: (role: string) => setDraft((current) => ({ ...current, seekingRoles: toggled(current.seekingRoles, role as PartnerRole) })),
    clearSeekingRoles: () => setDraft((current) => ({ ...current, seekingRoles: [] })),
    toggleRegion: (region: string) => setDraft((current) => ({ ...current, regions: toggled(current.regions, region) })),
    clearRegions: () => setDraft((current) => ({ ...current, regions: [] })),
    /** 조회 버튼·Enter로 초안을 적용합니다. */
    submitSearch: () => update({ ...draft, keyword: draft.keyword.trim() }),
    selectSort: (sort: string) => update({ sort: sort as PartnerRecruitmentSort }),
    goToPage: (target: number) => setQuery((current) => ({ ...current, page: target })),
    hasActiveNarrowing: hasPartnerRecruitmentNarrowing(query),
    clearNarrowing: () => {
      setDraft(emptyDraft)
      setQuery({ ...defaultPartnerRecruitmentQuery, sort: query.sort })
    },
    // 처음 읽기 전에도 "0건 · 정렬"로 보여 건수 자리를 비우지 않습니다.
    resultSummary: `${page?.total ?? 0}건 · ${partnerRecruitmentSortLabels[query.sort]}`,
  }
}
