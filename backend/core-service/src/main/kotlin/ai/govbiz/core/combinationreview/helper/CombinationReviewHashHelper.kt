package ai.govbiz.core.combinationreview.helper

import java.security.MessageDigest

object CombinationReviewHashHelper {
    fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun sha256(text: String): String = sha256(text.toByteArray(Charsets.UTF_8))
}
