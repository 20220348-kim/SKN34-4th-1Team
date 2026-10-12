package ai.govbiz.core.supportprogram.service.dto

import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramRankingExclusions

data class SupportProgramSearchResult(
    val query: String,
    val programs: List<SupportProgram>,
    /** 검색어로 순위 매기기까지 간 검색에서 추천에서 뺀 후보 수입니다. 빈 검색어·대상 없음·수를 모르면 null입니다. */
    val exclusionCounts: SupportProgramRankingExclusions? = null,
)
