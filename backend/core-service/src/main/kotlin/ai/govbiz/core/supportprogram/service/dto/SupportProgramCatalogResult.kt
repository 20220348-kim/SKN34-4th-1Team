package ai.govbiz.core.supportprogram.service.dto

import ai.govbiz.core.supportprogram.domain.SupportProgram

data class SupportProgramCatalogResult(
    val programs: List<SupportProgram>,
    val total: Int,
    val page: Int,
    val pageSize: Int,
    val totalPages: Int,
    val regions: List<String>,
    val categories: List<String>,
    val startupStages: List<String> = emptyList(),
    val applicantTypes: List<String> = emptyList(),
    val founderAges: List<String> = emptyList(),
)
