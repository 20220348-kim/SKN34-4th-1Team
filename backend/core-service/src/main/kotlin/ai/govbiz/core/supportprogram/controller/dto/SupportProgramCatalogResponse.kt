package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.service.dto.SupportProgramCatalogResult

data class SupportProgramCatalogResponse(
    val programs: List<SupportProgramResponse>,
    val total: Int,
    val page: Int,
    val pageSize: Int,
    val totalPages: Int,
    val regions: List<String>,
    val categories: List<String>,
    val startupStages: List<String>,
    val applicantTypes: List<String>,
    val founderAges: List<String>,
) {
    companion object {
        fun from(result: SupportProgramCatalogResult): SupportProgramCatalogResponse =
            SupportProgramCatalogResponse(
                programs = result.programs.map(SupportProgramResponse::from),
                total = result.total,
                page = result.page,
                pageSize = result.pageSize,
                totalPages = result.totalPages,
                regions = result.regions,
                categories = result.categories,
                startupStages = result.startupStages,
                applicantTypes = result.applicantTypes,
                founderAges = result.founderAges,
            )
    }
}
