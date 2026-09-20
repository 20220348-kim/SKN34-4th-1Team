package ai.govbiz.catalog.supportprogram.client.msit.dto

data class MsitPage(
    val totalCount: Int,
    val page: Int,
    val perPage: Int,
    val items: List<MsitProgramPayload>,
)
