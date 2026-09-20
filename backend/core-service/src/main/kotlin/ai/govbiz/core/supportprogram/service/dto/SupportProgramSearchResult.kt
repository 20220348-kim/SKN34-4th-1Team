package ai.govbiz.core.supportprogram.service.dto

import ai.govbiz.core.supportprogram.domain.SupportProgram

data class SupportProgramSearchResult(
    val query: String,
    val programs: List<SupportProgram>,
)
