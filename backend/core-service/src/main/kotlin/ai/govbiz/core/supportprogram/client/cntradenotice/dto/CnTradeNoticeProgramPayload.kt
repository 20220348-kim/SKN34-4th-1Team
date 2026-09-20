package ai.govbiz.core.supportprogram.client.cntradenotice.dto

/** 충청남도 수출입공지 API의 원본 필드이며 게시일은 접수일이 아닙니다. */
data class CnTradeNoticeProgramPayload(
    val id: String?,
    val title: String?,
    val organization: String?,
    val contentHtml: String?,
    val registeredDate: String?,
    val modifiedDate: String?,
)
