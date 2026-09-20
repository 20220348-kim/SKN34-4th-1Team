package ai.govbiz.core.supportprogram.client.kstartup.dto

data class KStartupPage(
    val currentCount: Int,
    val matchCount: Int,
    val totalCount: Int,
    val page: Int,
    val perPage: Int,
    val items: List<KStartupProgramPayload>,
)
