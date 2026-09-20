package ai.govbiz.core.account.domain

/** 소셜 로그인 공급자입니다. [pathName]은 URL과 프런트가, enum 이름은 DB가 씁니다. */
enum class OAuthProvider(val pathName: String) {
    KAKAO("kakao"),
    GOOGLE("google"),
    ;

    companion object {
        fun fromPathName(value: String): OAuthProvider? =
            entries.firstOrNull { provider -> provider.pathName == value }
    }
}

/**
 * 공급자가 확인해 준 사용자입니다. 계정 식별자는 공급자 안에서 바뀌지도 재사용되지도 않는 [subject](OIDC `sub`)이고,
 * 이메일은 바뀔 수 있어 처음 가입할 때만 씁니다. [verifiedEmail]은 공급자가 인증했다고 알린 이메일만 담습니다.
 */
data class OAuthProfile(
    val provider: OAuthProvider,
    val subject: String,
    val verifiedEmail: String?,
) {
    init {
        requireSubject(subject)
    }
}

/** 계정에 연결된 공급자 계정 하나입니다. 탈퇴 때 공급자 연결 끊기에 씁니다. */
data class OAuthLink(
    val provider: OAuthProvider,
    val subject: String,
) {
    init {
        requireSubject(subject)
    }
}

/** OIDC `sub`는 공백 없는 ASCII 255자 이하입니다. */
private fun requireSubject(subject: String) {
    require(subject.isNotEmpty() && subject.length <= MAX_SUBJECT_LENGTH && subject.all { it.code in VISIBLE_ASCII }) {
        "subject must be 1..$MAX_SUBJECT_LENGTH visible ASCII characters"
    }
}

private const val MAX_SUBJECT_LENGTH = 255
private val VISIBLE_ASCII = 0x21..0x7e
