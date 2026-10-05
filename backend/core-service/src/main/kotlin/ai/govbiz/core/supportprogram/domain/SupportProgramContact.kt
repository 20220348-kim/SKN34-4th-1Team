package ai.govbiz.core.supportprogram.domain

/**
 * Catalog snapshot에 포함된 공식 문의처입니다. K-Startup은 담당 부서와 전화번호를, 기업마당은 문의처 원문 한 줄을 줍니다.
 * 전화번호는 제공처 값을 그대로 보관하고, 표시 형식과 전화 연결 여부는 화면이 정합니다.
 */
data class SupportProgramContact(
    val department: String? = null,
    val phoneNumber: String? = null,
    val text: String? = null,
) {
    init {
        val values = listOf(department, phoneNumber, text)
        require(values.any { it != null }) { "contact must contain at least one value" }
        require(values.all { it == null || it.isNotBlank() }) { "contact values must not be blank" }
    }

    companion object {
        /** 빈 값은 없는 값으로 보고, 세 값이 모두 비면 문의처가 없다는 뜻으로 null을 돌려줍니다. */
        fun of(department: String?, phoneNumber: String?, text: String?): SupportProgramContact? {
            val values = listOf(department, phoneNumber, text).map { it?.trim()?.takeIf(String::isNotEmpty) }
            return if (values.all { it == null }) null else SupportProgramContact(values[0], values[1], values[2])
        }
    }
}
