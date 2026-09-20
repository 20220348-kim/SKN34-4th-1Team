package ai.govbiz.core.supportprogram.client.bizinfo.dto

internal data class BizInfoPage(
    val items: List<BizInfoProgramPayload>,
    val totalCount: Int,
    val pageNumber: Int,
    val pageSize: Int,
)
