package ai.govbiz.core.applicationpreparation.controller.dto

import jakarta.validation.constraints.Min

data class GenerateApplicationDocumentsRequest(@field:Min(1) val expectedRevision: Long)
data class ApplicationDocumentUnfilledAnswerResponse(val fieldId: String, val fieldLabel: String, val value: String, val reason: String)
data class ApplicationDocumentResponse(
    val id: Long,
    val inputRevision: Long,
    val fileName: String,
    val mediaType: String,
    val size: Int,
    val filledAnswerCount: Int?,
    val unfilledAnswerCount: Int?,
    val unfilledAnswers: List<ApplicationDocumentUnfilledAnswerResponse>,
)
