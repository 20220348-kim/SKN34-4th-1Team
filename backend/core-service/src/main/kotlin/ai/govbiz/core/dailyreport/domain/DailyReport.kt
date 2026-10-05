package ai.govbiz.core.dailyreport.domain

import java.time.LocalDate
import java.time.LocalDateTime

enum class DailyReportStatus { GENERATING, READY, FAILED }
enum class DailyReportDeliveryStatus { NOT_REQUESTED, SENDING, SENT, UNKNOWN, SKIPPED }
enum class DailyReportEvidenceStatus { ANSWERED, INSUFFICIENT_EVIDENCE, UNSUPPORTED, FAILED }

/** 생성 당시 기업 조건을 고정한다. 설립연도를 임의의 설립일로 바꾸지 않는다. */
data class DailyReportInput(val companyName: String, val region: String, val industry: String, val supportPurpose: String)
data class DailyReportCitation(val excerpt: String, val sourceUrl: String)
data class DailyReportItem(
    val sourceCode: String, val sourceProgramId: String, val title: String, val sourceUrl: String,
    val applicationPeriod: String, val relevanceScore: Int?, val matchedReasons: List<String>,
    val eligibilityStatus: String, val eligibilityNote: String,
    val evidenceStatus: DailyReportEvidenceStatus, val evidenceAnswer: String?, val citations: List<DailyReportCitation>,
)
data class DailyReportContent(val programs: List<DailyReportItem>, val warnings: List<String>)
data class DailyReport(
    val id: Long, val accountId: Long, val reportDate: LocalDate,
    val status: DailyReportStatus, val deliveryStatus: DailyReportDeliveryStatus,
    val input: DailyReportInput, val content: DailyReportContent?, val generatedAt: LocalDateTime?,
    val errorMessage: String?, val generationAttempts: Int, val generationKey: String,
    val startedAt: LocalDateTime,
)
data class DailyReportReservation(val report: DailyReport, val acquired: Boolean)
data class DailyReportSubscription(
    val accountId: Long, val supportPurpose: String, val enabled: Boolean,
    val confirmedEmail: String?, val confirmedAt: LocalDateTime?, val consentAt: LocalDateTime?,
) {
    /** 리포트 화면에서 확인을 마친 주소가 지금 계정 이메일과 같은지입니다. 관심 공고 마감 알림 이메일도 이 확인을 씁니다. */
    fun isEmailConfirmedFor(email: String): Boolean = confirmedAt != null && confirmedEmail == email
}
