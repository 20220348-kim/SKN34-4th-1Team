package ai.govbiz.core.account.config

import org.springframework.boot.context.properties.ConfigurationProperties

/** 개발용 자동 로그인 설정입니다. 기본값은 꺼짐이며 운영 환경에서는 켜지 않습니다. */
@ConfigurationProperties(prefix = "app.account.dev-login")
class AccountDevLoginProperties(
    enabled: Boolean?,
    email: String?,
    password: String?,
    memberEmail: String? = null,
) {

    val enabled: Boolean = enabled ?: false

    /** 관리자(T3)로 로그인할 때 쓰는 계정 이메일입니다. 없으면 ADMIN 역할로 만듭니다. */
    val email: String = email?.trim()?.takeIf(String::isNotEmpty) ?: DEFAULT_EMAIL

    /** 기업 정보가 없는 일반 회원(T1)으로 로그인할 때 쓰는 계정 이메일입니다. 없으면 USER 역할로 만듭니다. */
    val memberEmail: String = memberEmail?.trim()?.takeIf(String::isNotEmpty) ?: DEFAULT_MEMBER_EMAIL

    /** 만든 시드 계정에 저장하는 비밀번호입니다. 일반 로그인 화면에서도 이 값으로 로그인할 수 있습니다. */
    val password: String = password?.takeIf(String::isNotEmpty) ?: DEFAULT_PASSWORD

    init {
        require(this.password.length in MIN_PASSWORD_LENGTH..MAX_PASSWORD_LENGTH) {
            "app.account.dev-login.password must be $MIN_PASSWORD_LENGTH to $MAX_PASSWORD_LENGTH characters"
        }
        require(this.email.lowercase() != this.memberEmail.lowercase()) {
            "app.account.dev-login.email and member-email must be different accounts"
        }
    }

    companion object {
        const val DEFAULT_EMAIL = "admin@govbiz.local"
        const val DEFAULT_MEMBER_EMAIL = "member@govbiz.local"
        const val DEFAULT_PASSWORD = "govbiz-admin1"
        const val MIN_PASSWORD_LENGTH = 8
        const val MAX_PASSWORD_LENGTH = 72
    }
}
