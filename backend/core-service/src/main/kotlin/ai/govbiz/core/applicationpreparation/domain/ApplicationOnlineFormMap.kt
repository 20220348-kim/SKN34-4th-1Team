package ai.govbiz.core.applicationpreparation.domain

/** 확인된 온라인 control과 공식 문항의 관계. DOM 주소·provider·작성 권한·저장 계약을 담지 않는다. */
data class ApplicationOnlineFormMap(
    val schemaVersion: Int,
    val formId: String,
    val controls: List<ApplicationOnlineFormControl>,
) {
    init {
        require(schemaVersion == 1) { "unsupported online form map schema" }
        require(formId.isNotBlank()) { "blank online form ID" }
        require(controls.map { it.controlId }.distinct().size == controls.size) { "duplicate online form control ID" }
        // 복수 control의 선택·분할·반복 의미는 아직 확인하지 않았으므로 성공 매핑으로 처리하지 않는다.
        require(controls.map { it.fieldId }.distinct().size == controls.size) { "multiple online controls for one field require review" }
    }
}

data class ApplicationOnlineFormControl(
    val fieldId: String,
    val controlId: String,
    val label: String,
    val required: Boolean,
) {
    init {
        require(fieldId.isNotBlank()) { "blank application field ID" }
        require(controlId.isNotBlank()) { "blank online form control ID" }
        require(label.isNotBlank()) { "blank online form control label" }
    }
}

/** 공식 identity와 required 의미를 검증한 후 공식 문항 순서로 읽기 전용 projection을 만든다. */
fun ApplicationFormManifest.fieldMappings(formMap: ApplicationOnlineFormMap): List<ApplicationFieldMapping> {
    val fields = sections.flatMap { section -> section.fields.map { "${section.key}:${it.key}" to it } }.toMap()
    require(formMap.controls.all { it.fieldId in fields }) { "unknown application field ID in online form map" }
    require(formMap.controls.all { it.required == fields.getValue(it.fieldId).required }) { "online form required flag conflicts with manifest" }
    val byField = formMap.controls.associateBy { it.fieldId }
    return fields.map { (fieldId, field) ->
        val control = byField[fieldId]
        val bindings = control?.let {
            listOf(ApplicationFieldBinding(it.controlId, null, ApplicationFieldBindingSourceType.ONLINE_FORM))
        }.orEmpty()
        val status = when {
            control != null -> ApplicationFieldMappingStatus.MAPPED
            field.required -> ApplicationFieldMappingStatus.REQUIRED_MAPPING_MISSING
            else -> ApplicationFieldMappingStatus.UNMAPPED
        }
        ApplicationFieldMapping(fieldId, field.label, field.required, status, bindings)
    }
}
