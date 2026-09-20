package ai.govbiz.core.account.config

import ai.govbiz.core._common.helper.validatePositiveDuration
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "app.account")
class AccountSessionProperties(
    sessionTtl: Duration?,
    jwtSecret: String?,
    cookieSecure: Boolean? = null,
    sessionShortTtl: Duration? = null,
    sessionIdleTtl: Duration? = null,
) {

    /** "로그인 상태 유지"를 켠 세션의 절대 만료 기간입니다. 세션 쿠키의 Max-Age로도 씁니다. */
    val sessionTtl: Duration = sessionTtl
        ?: throw NullPointerException("app.account.session-ttl must be configured")

    /** "로그인 상태 유지"를 끈 세션의 절대 만료 기간입니다. 쿠키는 브라우저 세션 쿠키로 내려줍니다. */
    val sessionShortTtl: Duration = sessionShortTtl ?: DEFAULT_SHORT_TTL

    /** 마지막 사용 뒤 이 기간이 지나면 절대 만료 전이라도 세션을 끝냅니다. */
    val sessionIdleTtl: Duration = sessionIdleTtl ?: DEFAULT_IDLE_TTL

    /** 세션 JWT의 HS256 서명 비밀키입니다. 운영 환경에서는 반드시 별도 값으로 덮어써야 합니다. */
    val jwtSecret: String = jwtSecret?.trim().orEmpty()

    /** 세션 쿠키에 `Secure`를 붙일지입니다. HTTPS가 없는 로컬 개발에서만 끕니다. */
    val cookieSecure: Boolean = cookieSecure ?: true

    init {
        validatePositiveDuration(this.sessionTtl, "app.account.session-ttl")
        validatePositiveDuration(this.sessionShortTtl, "app.account.session-short-ttl")
        validatePositiveDuration(this.sessionIdleTtl, "app.account.session-idle-ttl")
        require(this.jwtSecret.length >= MIN_JWT_SECRET_LENGTH) {
            "app.account.jwt-secret must be at least $MIN_JWT_SECRET_LENGTH characters"
        }
    }

    companion object {
        const val MIN_JWT_SECRET_LENGTH = 32
        val DEFAULT_SHORT_TTL: Duration = Duration.ofHours(12)
        val DEFAULT_IDLE_TTL: Duration = Duration.ofDays(7)
    }
}
