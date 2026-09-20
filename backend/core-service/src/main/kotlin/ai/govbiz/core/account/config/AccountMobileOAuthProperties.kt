package ai.govbiz.core.account.config

import java.net.URI
import org.springframework.boot.context.properties.ConfigurationProperties

/** 앱 콜백은 운영자가 등록한 정확한 URI만 허용합니다. 기본값은 비어 있어 모바일 OAuth가 닫혀 있습니다. */
@ConfigurationProperties(prefix = "app.account.mobile-oauth")
class AccountMobileOAuthProperties(redirectUris: List<String> = emptyList()) {
    val redirectUris: Set<String> = redirectUris.filter(String::isNotBlank).toSet()

    init {
        this.redirectUris.forEach { value ->
            val uri = runCatching { URI(value) }.getOrNull()
            require(value.length <= 512 && uri != null && uri.isAbsolute && uri.host != null &&
                uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
                (uri.scheme == "https" || uri.scheme == "govbiz") && uri.rawPath.isNotEmpty()
            ) { "app.account.mobile-oauth.redirect-uris must contain exact HTTPS or govbiz app callback URIs" }
        }
    }
}
