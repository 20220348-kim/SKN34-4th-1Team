package ai.govbiz.core.applicationpreparation.repository.mapper

/** 목록 요약용 사실 키 한 행입니다. 값은 읽지 않는다. */
data class ApplicationPreparationFactKeyDbRow(
    var preparationId: Long = 0,
    var sectionKey: String = "",
    var fieldKey: String = "",
    var factStatus: String = "",
)
