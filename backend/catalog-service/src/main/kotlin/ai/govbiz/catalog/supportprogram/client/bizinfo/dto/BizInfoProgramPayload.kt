package ai.govbiz.catalog.supportprogram.client.bizinfo.dto

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
    val applicationMethod: String? = null,
    val applicationUrl: String? = null,
    /** 문의처(`refrncNm`) 원문입니다. 기관·부서·전화번호·이메일이 한 줄에 섞여 옵니다. */
    val contact: String? = null,
)
