package ai.govbiz.core.applicationpreparation.domain

/** 좌표는 회전된 PDF 페이지의 왼쪽 위를 기준으로 0..1로 정규화한다. */
data class ApplicationDocumentBox(val x: Float, val y: Float, val width: Float, val height: Float)
data class ApplicationDocumentTarget(val id: String, val text: String, val context: String, val exampleText: String = "", val kind: String = "TEXT", val groupId: String = "", val editable: Boolean = true, val unsupportedReason: String? = null)

/** [literal]은 답 대신 쓰는 파생 문구(빈칸 앞뒤 띄어쓰기, 선택 표시 ■·√·○, 나눠 쓴 날짜)이며 AI 서비스의 고정 규칙만 만듭니다. */
data class ApplicationDocumentEditOperation(
    val targetId: String, val operation: String, val expectedText: String, val start: Int, val end: Int,
    val valueRef: String?, val box: ApplicationDocumentBox? = null, val reason: String, val stylePolicy: String = "preserve",
    val literal: String? = null,
)

/** 원본에 넣지 않고 남긴 답과 이유입니다. 나머지 답은 그대로 기입하고 사용자에게 미기입 목록으로 보여 줍니다. */
data class ApplicationDocumentSkippedFact(val factId: String, val targetId: String = "", val reason: String, val capacity: Int? = null) {
    companion object { val REASONS = setOf("OVERFLOW", "AMBIGUOUS_SLOT", "SLOT_MISMATCH", "UNRESOLVED") }
}

data class ApplicationDocumentWritePlan(
    val sourceSha256: String, val mapVersion: String, val answerRevision: Long, val planHash: String,
    val operations: List<ApplicationDocumentEditOperation>, val unresolvedTargets: List<String>, val scopeTargetIds: List<String>,
    val skippedFacts: List<ApplicationDocumentSkippedFact> = emptyList(),
)
data class ApplicationDocumentFact(val id: String, val label: String, val value: String)
/** [capacity]는 칸 넘침(OVERFLOW)일 때 그 칸에 들어가는 대략의 글자 수입니다. */
data class ApplicationDocumentUnfilledAnswer(val fieldId: String, val fieldLabel: String, val value: String, val reason: String, val capacity: Int? = null)
data class ApplicationDocumentPlacement(val factId: String, val targetId: String, val box: ApplicationDocumentBox? = null)
data class ApplicationDocumentInspection(val targets: List<ApplicationDocumentTarget>, val pageImages: List<String> = emptyList(), val pdfFields: List<Map<String, Any?>> = emptyList())
data class ApplicationDocumentFile(
    val id: Long,
    val inputRevision: Long,
    val fileName: String,
    val mediaType: String,
    val bytes: ByteArray,
    val filledAnswerCount: Int? = null,
    val unfilledAnswers: List<ApplicationDocumentUnfilledAnswer> = emptyList(),
    val remainingExampleCount: Int = 0,
)

/** Shared official-form address binding; contains no user answers. */
data class ApplicationDocumentMapSnapshot(
    val contractVersion: String,
    val pipelineVersion: String,
    val sourceSha256: String,
    val mapVersion: String,
    val engineVersion: String,
    val bindings: List<ApplicationDocumentPlacement>,
    val scopeTargetIds: List<String>,
    val documentMap: Map<String, Any?>,
)
