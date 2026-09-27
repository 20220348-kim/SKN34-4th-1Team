package ai.govbiz.core.applicationpreparation.domain

import java.net.URI

/** 위치만 표현한다. URL validation은 네트워크 접근 허가나 provider 권한 확인이 아니다. */
data class ApplicationOnlineFormSourceReference(
    val sourceUrl: String,
    val provider: String,
) {
    init {
        require(provider.matches(Regex("[A-Z][A-Z0-9_]{0,63}"))) { "invalid online form provider" }
        require(sourceUrl.length in 1..2048 && sourceUrl == sourceUrl.trim()) { "invalid online form source URL" }
        val uri = try {
            URI(sourceUrl)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("invalid online form source URL")
        } catch (_: java.net.URISyntaxException) {
            throw IllegalArgumentException("invalid online form source URL")
        }
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null &&
            uri.port == -1 && uri.rawFragment == null) { "invalid online form source URL" }
    }

    /** Query와 경로에 개인정보가 있을 수 있어 자동 문자열 출력에서 위치를 숨긴다. */
    override fun toString(): String = "ApplicationOnlineFormSourceReference(provider=$provider)"
}