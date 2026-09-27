package ai.govbiz.core.applicationpreparation.domain

/** 업무 문항과 확인된 입력 위치의 읽기 전용 projection. 파일 편집 권한이나 native 주소를 소유하지 않는다. */
data class ApplicationFieldMapping(
    val fieldId: String,
    val label: String,
    val required: Boolean,
    val status: ApplicationFieldMappingStatus,
    val bindings: List<ApplicationFieldBinding>,
) {
    val writable: Boolean get() = status == ApplicationFieldMappingStatus.MAPPED && bindings.isNotEmpty()
}

/** FILE binding의 참조만 보존한다. 실제 위치 검증은 기존 DocumentMap/binding/WritePlan 경계가 담당한다. */
data class ApplicationFieldBinding(val targetId: String, val box: ApplicationDocumentBox?)

enum class ApplicationFieldMappingStatus { MAPPED, UNMAPPED, REQUIRED_MAPPING_MISSING }

/** 검증된 FILE snapshot의 binding 결과를 공식 문항 순서로 투영한다. raw DocumentMap은 복제하지 않는다. */
fun ApplicationFormManifest.fieldMappings(snapshot: ApplicationDocumentMapSnapshot): List<ApplicationFieldMapping> {
    val byField = snapshot.bindings.groupBy { it.factId }
    return sections.flatMap { section -> section.fields.map { field ->
        val fieldId = "${section.key}:${field.key}"
        val bindings = byField[fieldId].orEmpty().map { ApplicationFieldBinding(it.targetId, it.box) }
        val status = when {
            bindings.isNotEmpty() -> ApplicationFieldMappingStatus.MAPPED
            field.required -> ApplicationFieldMappingStatus.REQUIRED_MAPPING_MISSING
            else -> ApplicationFieldMappingStatus.UNMAPPED
        }
        ApplicationFieldMapping(fieldId, field.label, field.required, status, bindings)
    } }
}
