package ai.govbiz.core.supportprogram.domain

enum class SupportProgramApplicationRouteType {
    GOOGLE_FORMS, OTHER_ONLINE_FORM, FILE, UNKNOWN,
}

/** Catalog snapshot에 포함된 공식 신청 경로입니다. */
data class SupportProgramApplicationRoute(
    val method: String? = null,
    val url: String? = null,
    val type: SupportProgramApplicationRouteType = SupportProgramApplicationRouteType.UNKNOWN,
) {
    override fun toString(): String = "SupportProgramApplicationRoute(type=$type, method=$method, url=[redacted])"
}
