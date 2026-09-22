package ai.govbiz.core.account.helper

/** BCrypt에 새 비밀번호를 저장하기 전에 실제 UTF-8 바이트 한도를 검사합니다. */
object PasswordValidationHelper {
    const val MAX_UTF8_BYTES = 72
    val CHARACTER_LENGTH = 8..72

    fun fitsBcryptLimit(password: String): Boolean = password.toByteArray(Charsets.UTF_8).size <= MAX_UTF8_BYTES

    fun requireNewPassword(password: String) {
        require(password.length in CHARACTER_LENGTH && fitsBcryptLimit(password)) {
            "password must be 8..72 characters and at most $MAX_UTF8_BYTES UTF-8 bytes"
        }
    }
}
