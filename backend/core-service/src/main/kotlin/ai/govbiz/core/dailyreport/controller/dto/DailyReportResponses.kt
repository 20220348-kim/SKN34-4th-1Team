package ai.govbiz.core.dailyreport.controller.dto

import ai.govbiz.core.dailyreport.domain.DailyReport
import ai.govbiz.core.dailyreport.service.dto.DailyReportSettingsResult
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId

data class DailyReportSettingsResponse(
    val supportPurpose: String, val enabled: Boolean, val emailConfirmed: Boolean,
    val emailDeliveryAvailable: Boolean, val sendHour: Int, val schedulerEnabled: Boolean,
) {
    companion object {
        fun from(result: DailyReportSettingsResult) = DailyReportSettingsResponse(result.supportPurpose, result.enabled,
            result.emailConfirmed, result.emailDeliveryAvailable, result.sendHour, result.schedulerEnabled)
    }
}
data class DailyReportEnvelopeResponse(val report: DailyReportResponse?)
data class DailyReportResponse(
    val id: Long, val reportDate: LocalDate, val status: String, val deliveryStatus: String,
    val companyName: String, val region: String, val industry: String, val supportPurpose: String,
    val generatedAt: OffsetDateTime?, val programs: List<DailyReportItemResponse>, val warnings: List<String>, val errorMessage: String?,
) {
    companion object {
        fun from(report: DailyReport) = DailyReportResponse(report.id, report.reportDate, report.status.name,
            report.deliveryStatus.name, report.input.companyName, report.input.region, report.input.industry,
            report.input.supportPurpose, report.generatedAt?.atZone(ZoneId.of("Asia/Seoul"))?.toOffsetDateTime(),
            report.content?.programs.orEmpty().map { item ->
                DailyReportItemResponse(item.sourceCode, item.sourceProgramId, item.title, item.sourceUrl, item.applicationPeriod,
                    item.relevanceScore, item.matchedReasons, item.eligibilityStatus, item.eligibilityNote, item.evidenceStatus.name,
                    item.evidenceAnswer, item.citations.map { DailyReportCitationResponse(it.excerpt, it.sourceUrl) })
            }, report.content?.warnings.orEmpty(), report.errorMessage)
    }
}
data class DailyReportItemResponse(
    val sourceCode: String, val sourceProgramId: String, val title: String, val sourceUrl: String, val applicationPeriod: String,
    val relevanceScore: Int?, val matchedReasons: List<String>, val eligibilityStatus: String, val eligibilityNote: String,
    val evidenceStatus: String, val evidenceAnswer: String?, val citations: List<DailyReportCitationResponse>,
)
data class DailyReportCitationResponse(val excerpt: String, val sourceUrl: String)
