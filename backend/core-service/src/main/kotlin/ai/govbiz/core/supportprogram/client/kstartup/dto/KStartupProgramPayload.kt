package ai.govbiz.core.supportprogram.client.kstartup.dto

/** K-Startup 공고 API의 한 행입니다. id 순번이 아니라 pbanc_sn을 원본 식별자로 읽습니다. */
data class KStartupProgramPayload(
    val id: String?,
    val title: String?,
    val organization: String?,
    val summaryHtml: String?,
    val target: String?,
    val excludedTarget: String?,
    val applicantTypes: String?,
    val startupStages: String?,
    val founderAges: String?,
    val category: String?,
    val region: String?,
    val applicationStartDate: String?,
    val applicationEndDate: String?,
    val sourceUrl: String?,
)
