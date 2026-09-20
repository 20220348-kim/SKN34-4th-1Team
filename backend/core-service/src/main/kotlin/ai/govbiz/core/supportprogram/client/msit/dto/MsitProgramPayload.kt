package ai.govbiz.core.supportprogram.client.msit.dto

/** 목록 API의 게시일은 접수 기간이 아니며 본문·신청 자격을 제공하지 않습니다. */
data class MsitProgramPayload(
    val title: String?,
    val organization: String?,
    val publishedAt: String?,
    val sourceUrl: String?,
)
