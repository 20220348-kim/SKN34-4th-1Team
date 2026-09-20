package ai.govbiz.core.supportprogram.domain

/** K-Startup 공고의 분류값입니다. 기업의 실제 신청 자격을 판정한 결과가 아닙니다. */
data class SupportProgramStartupDetails(
    val startupStages: List<String>,
    val applicantTypes: List<String>,
    val founderAges: List<String>,
)
