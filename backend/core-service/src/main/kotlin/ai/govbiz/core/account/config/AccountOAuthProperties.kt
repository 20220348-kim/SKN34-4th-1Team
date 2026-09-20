package ai.govbiz.core.account.config

import ai.govbiz.core._common.helper.validatePositiveDuration
import ai.govbiz.core.account.domain.OAuthProvider
import java.net.URI
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * 소셜 로그인(카카오·Google) 설정입니다. 공급자별로 클라이언트 ID와 시크릿이 둘 다 있어야 그 공급자가 켜집니다.
 *
 * [callbackBaseUrl]은 브라우저가 Core API의 `/api`에 닿는 origin입니다. 공급자 콘솔에는
 * `<callbackBaseUrl>/api/v1/auth/oauth/{provider}/callback`을 등록하고, 로그인 상태 쿠키와 세션 쿠키가 이 호스트에 붙습니다.
 * 로컬 Compose는 Vite(5173)가 `/api`를 Core로 넘기므로 프런트와 같은 origin입니다.
 */
@ConfigurationProperties(prefix = "app.account.oauth")
class AccountOAuthProperties(
    callbackBaseUrl: String = DEFAULT_ORIGIN,
    frontendBaseUrl: String = DEFAULT_ORIGIN,
    val connectTimeout: Duration = Duration.ofSeconds(2),
    val readTimeout: Duration = Duration.ofSeconds(10),
    val google: ClientCredentials = ClientCredentials(),
    val kakao: KakaoCredentials = KakaoCredentials(),
) {

    val callbackBaseUrl: String = callbackBaseUrl.trim().trimEnd('/')

    /** 로그인을 마친 뒤 브라우저를 돌려보낼 프런트 origin입니다. */
    val frontendBaseUrl: String = frontendBaseUrl.trim().trimEnd('/')

    init {
        requireOrigin(this.callbackBaseUrl, "app.account.oauth.callback-base-url")
        requireOrigin(this.frontendBaseUrl, "app.account.oauth.frontend-base-url")
        validatePositiveDuration(connectTimeout, "app.account.oauth.connect-timeout")
        validatePositiveDuration(readTimeout, "app.account.oauth.read-timeout")
    }

    /** 공급자 콘솔에 등록하는 Redirect URI입니다. 인가 요청과 토큰 요청에 같은 값을 보냅니다. */
    fun callbackUri(provider: OAuthProvider): String =
        "$callbackBaseUrl$PATH_PREFIX/${provider.pathName}/callback"

    /** 로그인 버튼이 여는 시작 주소입니다. 콜백과 같은 호스트여야 로그인 상태 쿠키가 콜백 요청에 붙습니다. */
    fun startUri(provider: OAuthProvider): String =
        "$callbackBaseUrl$PATH_PREFIX/${provider.pathName}/authorize"

    /** 공급자 콘솔에서 발급한 웹 애플리케이션 클라이언트 값입니다. */
    class ClientCredentials(
        clientId: String = "",
        clientSecret: String = "",
    ) {
        val clientId: String = clientId.trim()
        val clientSecret: String = clientSecret.trim()

        val isConfigured: Boolean
            get() = clientId.isNotEmpty() && clientSecret.isNotEmpty()
    }

    /** 카카오는 REST API 키가 클라이언트 ID이고, 탈퇴 때 연결 끊기에 쓰는 어드민 키가 따로 있습니다. */
    class KakaoCredentials(
        clientId: String = "",
        clientSecret: String = "",
        adminKey: String = "",
    ) {
        val clientId: String = clientId.trim()
        val clientSecret: String = clientSecret.trim()
        val adminKey: String = adminKey.trim()

        val isConfigured: Boolean
            get() = clientId.isNotEmpty() && clientSecret.isNotEmpty()
    }

    companion object {
        const val PATH_PREFIX = "/api/v1/auth/oauth"
        private const val DEFAULT_ORIGIN = "http://127.0.0.1:5173"
        private val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "[::1]")

        /** HTTPS origin만 받고 HTTP는 로컬 개발(loopback)에서만 허용합니다. 경로·쿼리가 있으면 안 됩니다. */
        private fun requireOrigin(value: String, propertyName: String) {
            val uri = runCatching { URI(value) }.getOrNull()
            require(
                uri != null && uri.host != null && uri.rawUserInfo == null && uri.rawQuery == null &&
                    uri.rawFragment == null && uri.rawPath.isNullOrEmpty() &&
                    (uri.scheme == "https" || (uri.scheme == "http" && uri.host in LOOPBACK_HOSTS)),
            ) { "$propertyName must be an HTTPS origin (HTTP allowed only for loopback development)" }
        }
    }
}
