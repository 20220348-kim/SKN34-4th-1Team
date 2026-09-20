package ai.govbiz.catalog.supportprogram.client.cntradenotice.dto

internal data class CnTradeNoticePage(
    val pageNo: Int,
    val numOfRows: Int,
    val totalCount: Int,
    val items: List<CnTradeNoticeProgramPayload>,
)
