package ai.govbiz.core.supportprogram.client.msit.dto

data class MsitPage(
    val totalCount: Int,
    val page: Int,
    val perPage: Int,
    val items: List<MsitProgramPayload>,
)
