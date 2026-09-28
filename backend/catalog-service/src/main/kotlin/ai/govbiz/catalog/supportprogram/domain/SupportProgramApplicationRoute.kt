package ai.govbiz.catalog.supportprogram.domain

import java.net.URI
import java.net.URISyntaxException
import java.nio.charset.StandardCharsets
import java.util.Locale

enum class SupportProgramApplicationRouteType {
    GOOGLE_FORMS, OTHER_ONLINE_FORM, FILE, UNKNOWN,
}

/** 공식 제공처의 신청 필드만 사용하며 신청 URL로 네트워크 요청을 보내지 않습니다. */
data class SupportProgramApplicationRoute(
    val method: String? = null,
    val url: String? = null,
    val type: SupportProgramApplicationRouteType = SupportProgramApplicationRouteType.UNKNOWN,
) {
    override fun toString(): String = "SupportProgramApplicationRoute(type=$type, method=$method, url=[redacted])"

    companion object {
        fun fromOfficialFields(method: String?, url: String?): SupportProgramApplicationRoute {
            val normalizedMethod = method?.trim()?.takeIf(String::isNotEmpty)
            require(normalizedMethod == null || normalizedMethod.toByteArray(StandardCharsets.UTF_8).size <= 8192) {
                "application method exceeds the supported length"
            }
            val normalizedUrl = validUrl(url)
            val suppliedInvalidUrl = !url.isNullOrBlank() && normalizedUrl == null
            val uri = normalizedUrl?.let(::URI)
            val host = uri?.host?.lowercase(Locale.ROOT)
            val path = uri?.rawPath.orEmpty()
            val unsupportedGoogleFormUrl = host == "docs.google.com" && path.startsWith("/forms/") &&
                !Regex("/forms/(?:u/[0-9]+/)?d/(?:e/)?[A-Za-z0-9_-]+/viewform/?").matches(path)
            val type = when {
                host == "forms.gle" && Regex("/[A-Za-z0-9_-]+/?").matches(path) ->
                    SupportProgramApplicationRouteType.GOOGLE_FORMS
                host == "docs.google.com" &&
                    Regex("/forms/(?:u/[0-9]+/)?d/(?:e/)?[A-Za-z0-9_-]+/viewform/?").matches(path) ->
                    SupportProgramApplicationRouteType.GOOGLE_FORMS
                unsupportedGoogleFormUrl ->
                    SupportProgramApplicationRouteType.UNKNOWN
                suppliedInvalidUrl -> SupportProgramApplicationRouteType.UNKNOWN
                normalizedUrl != null -> SupportProgramApplicationRouteType.OTHER_ONLINE_FORM
                normalizedMethod != null && FILE_METHOD.containsMatchIn(normalizedMethod) ->
                    SupportProgramApplicationRouteType.FILE
                else -> SupportProgramApplicationRouteType.UNKNOWN
            }
            return SupportProgramApplicationRoute(
                normalizedMethod, normalizedUrl.takeUnless { unsupportedGoogleFormUrl }, type)
        }

        private fun validUrl(raw: String?): String? {
            if (raw?.any(Char::isISOControl) == true) return null
            val value = raw?.trim()?.takeIf(String::isNotEmpty) ?: return null
            if (value.length > 2048) return null
            return try {
                val uri = URI(value)
                if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.rawUserInfo != null ||
                    uri.port != -1 || uri.rawFragment != null) null
                else uri.toString()
            } catch (_: URISyntaxException) {
                null
            } catch (_: IllegalArgumentException) {
                null
            }
        }

        private val FILE_METHOD = Regex("이메일.{0,20}(제출|접수)|우편.{0,20}(제출|접수)|방문.{0,20}(제출|접수)")
    }
}
