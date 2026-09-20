package ai.govbiz.core.supportprogram.client.bizinfo.dto

data class BizInfoProgramPayload(
    val title: String?,
    val sourceUrl: String?,
    val id: String?,
    val jurisdictionOrganization: String?,
    val executingOrganization: String?,
    val summaryHtml: String?,
    val category: String?,
    val createdAt: String?,
    val applicationPeriod: String?,
    val updatedAt: String?,
    val target: String?,
    val hashtags: String?,
)
