package ai.govbiz.core.account.helper

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** 메일 링크에 싣는 일회용 토큰입니다. 원문은 43자 URL-safe Base64이고 DB에는 SHA-256 해시만 둡니다. */
object OneTimeTokenHelper {
    val PATTERN: Regex = Regex("[A-Za-z0-9_-]{43}")
    private val random = SecureRandom()

    fun newToken(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also(random::nextBytes))

    fun hash(token: String): String =
        MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
