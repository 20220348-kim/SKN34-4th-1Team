package ai.govbiz.core.supportprogram.helper

import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus

object SupportProgramTestHelper {
    fun catalogProgram(id: String, summary: String = "서울 AI 기업 기술 지원") = CatalogSupportProgram(
        SupportProgram(
            id = id,
            sourceCode = "BIZINFO",
            title = "$id 지원사업",
            organization = "수행기관",
            summary = summary,
            categories = listOf("AI", "기술"),
            regions = listOf("서울"),
            targetDescription = "중소기업",
            applicationPeriod = "상시 접수",
            applicationStartDate = null,
            applicationEndDate = null,
            status = SupportProgramStatus.OPEN,
            sourceName = "기업마당",
            sourceUrl = "https://www.bizinfo.go.kr/detail?id=$id",
            matchedReasons = emptyList(),
        ),
        "2026-08-21 10:00:00",
    )
}
