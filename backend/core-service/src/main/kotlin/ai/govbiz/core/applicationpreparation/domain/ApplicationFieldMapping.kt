package ai.govbiz.core.applicationpreparation.domain

/** 업무 문항과 확인된 입력 위치의 읽기 전용 projection. 파일 편집 권한이나 native 주소를 소유하지 않는다. */
data class ApplicationFieldMapping(
    val fieldId: String,
    val label: String,
    val required: Boolean,
    val status: ApplicationFieldMappingStatus,
    val bindings: List<ApplicationFieldBinding>,
) {
    val mapped: Boolean get() = status == ApplicationFieldMappingStatus.MAPPED && bindings.isNotEmpty()
    /** 현재 FILE 편집 경로만 실행 가능하다. 매핑 확인은 작성·검토·제출 완료가 아니다. */
    val autoFillSupported: Boolean get() = bindings.isNotEmpty() && bindings.all { it.sourceType == ApplicationFieldBindingSourceType.FILE }
    val writable: Boolean get() = mapped && autoFillSupported
}

/** 입력 위치의 참조만 보존한다. 실제 위치 검증은 기존 DocumentMap/binding/WritePlan 경계가 담당한다. */
data class ApplicationFieldBinding(
    val targetId: String,
    val box: ApplicationDocumentBox?,
    val sourceType: ApplicationFieldBindingSourceType = ApplicationFieldBindingSourceType.FILE,
) {
    /** FILE은 native target ID, ONLINE_FORM은 확인된 control ID. 기존 FILE 이름은 호환 유지한다. */
    val referenceId: String get() = targetId

    init {
        require(targetId.isNotBlank()) { "blank application field binding reference" }
        require(sourceType != ApplicationFieldBindingSourceType.ONLINE_FORM || box == null) { "online form binding cannot have a document box" }
    }
}

enum class ApplicationFieldBindingSourceType { FILE, ONLINE_FORM }

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
