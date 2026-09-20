package ai.govbiz.core.combinationreview.repository.mapper

import java.time.LocalDateTime

data class CombinationReviewRunDbRow(
    var id: Long = 0, var reviewId: Long = 0, var inputRevision: Long = 0,
    var requestKey: String = "", var requestHash: String = "", var status: String = "QUEUED",
    var inputJson: String = "", var evidenceJson: String? = null, var configurationJson: String? = null,
    var analysisJson: String? = null, var failureCode: String? = null, var runnerInstanceId: String = "",
    var startedAt: LocalDateTime? = null, var finishedAt: LocalDateTime? = null,
)
data class CombinationReviewRunSourceDbRow(var runId: Long = 0, var documentIndex: Int = 0, var rawHash: String = "", var rawBytes: ByteArray = byteArrayOf())
