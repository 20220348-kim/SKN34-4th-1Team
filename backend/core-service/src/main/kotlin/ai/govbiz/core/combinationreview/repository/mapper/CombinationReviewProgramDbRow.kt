package ai.govbiz.core.combinationreview.repository.mapper

/** 선택 사업 한 행. enum 문자열과 nullable 세부사업 ID는 Repository에서 Domain으로 변환한다. */
data class CombinationReviewProgramDbRow(
    var reviewId: Long = 0,
    var position: Int = 0,
    var sourceCode: String = "",
    var sourceProgramId: String = "",
    var subProgramId: String? = null,
    var applicationSubmitted: String = "UNKNOWN",
    var selected: String = "UNKNOWN",
    var commitmentSubmitted: String = "UNKNOWN",
    var agreementSigned: String = "UNKNOWN",
    var executionStatus: String = "UNKNOWN",
    var fundingReceived: String = "UNKNOWN",
)
