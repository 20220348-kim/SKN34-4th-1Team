package ai.govbiz.core.applicationpreparation.domain

/** 외부 수집 경계에서 확인된 의미 정보만 담는다. 실행 주소나 인증 정보는 포함하지 않는다. */
data class ApplicationOnlineFormSource(
    val schemaVersion: Int,
    val formId: String,
    val formTitle: String,
    val controls: List<ApplicationOnlineFormSourceControl>,
) {
    init {
        require(schemaVersion == 1) { "unsupported online form source schema" }
        require(formId.isNotBlank() && formTitle.isNotBlank()) { "blank online form identity" }
        require(controls.map { it.controlId }.distinct().size == controls.size) { "duplicate online form source control ID" }
    }
}

data class ApplicationOnlineFormSourceControl(val controlId: String, val label: String, val required: Boolean) {
    init {
        require(controlId.isNotBlank()) { "blank online form source control ID" }
        require(label.isNotBlank()) { "blank online form source label" }
    }
}

enum class ApplicationOnlineFormReviewIssueCode {
    AMBIGUOUS_CONTROL, REQUIRED_FLAG_MISMATCH, REQUIRED_CONTROL_NOT_FOUND, UNMATCHED_SOURCE_CONTROL,
}

data class ApplicationOnlineFormReviewIssue(
    val code: ApplicationOnlineFormReviewIssueCode,
    val fieldId: String?,
    val fieldLabel: String?,
    val candidateControlIds: List<String>,
)

/** 확정된 FormMap과 검토 사유만 보존하며 source 전체를 복제하지 않는다. */
data class ApplicationOnlineFormReview(
    val formMap: ApplicationOnlineFormMap,
    val issues: List<ApplicationOnlineFormReviewIssue>,
)

/** 공백 정규화 후 양쪽 label이 유일하고 required 의미가 같은 경우에만 확인한다. */
fun ApplicationFormManifest.reviewOnlineForm(source: ApplicationOnlineFormSource): ApplicationOnlineFormReview {
    val whitespace = Regex("[\\p{javaWhitespace}\\p{Z}]+")
    fun normalized(label: String) = label.replace(whitespace, " ").trim()
    val fields = sections.flatMap { section -> section.fields.map { "${section.key}:${it.key}" to it } }
    val fieldsByLabel = fields.groupBy { normalized(it.second.label) }
    val controlsByLabel = source.controls.groupBy { normalized(it.label) }
    val confirmed = mutableListOf<ApplicationOnlineFormControl>()
    val issues = mutableListOf<ApplicationOnlineFormReviewIssue>()
    fields.forEach { (fieldId, field) ->
        val label = normalized(field.label)
        val candidates = controlsByLabel[label].orEmpty()
        val code = when {
            candidates.isEmpty() -> if (field.required) ApplicationOnlineFormReviewIssueCode.REQUIRED_CONTROL_NOT_FOUND else null
            candidates.size != 1 || fieldsByLabel.getValue(label).size != 1 -> ApplicationOnlineFormReviewIssueCode.AMBIGUOUS_CONTROL
            candidates.single().required != field.required -> ApplicationOnlineFormReviewIssueCode.REQUIRED_FLAG_MISMATCH
            else -> null
        }
        if (code != null) {
            issues += ApplicationOnlineFormReviewIssue(code, fieldId, field.label, candidates.map { it.controlId })
        } else if (candidates.isNotEmpty()) {
            val control = candidates.single()
            confirmed += ApplicationOnlineFormControl(fieldId, control.controlId, control.label, control.required)
        }
    }
    // 충돌 후보는 위 사유로 이미 표시된다. Manifest에 label 자체가 없는 source만 별도로 표시한다.
    source.controls.filter { normalized(it.label) !in fieldsByLabel }.forEach {
        issues += ApplicationOnlineFormReviewIssue(ApplicationOnlineFormReviewIssueCode.UNMATCHED_SOURCE_CONTROL, null, null, listOf(it.controlId))
    }
    return ApplicationOnlineFormReview(ApplicationOnlineFormMap(1, source.formId, confirmed), issues)
}
