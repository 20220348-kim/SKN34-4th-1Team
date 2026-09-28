package ai.govbiz.core.account.helper

/**
 * 새 비밀번호 규칙입니다. 영문 대·소문자, 숫자, 특수문자(공백을 뺀 ASCII)만 8~72자로 받습니다.
 * 국내 서비스 관례대로 한글·이모지·공백은 거부합니다. BCrypt의 UTF-8 72바이트 한도는 문자 규칙과 별개로
 * 따로 검사해, 나중에 허용 문자를 넓혀도 해시 생성이 서버 오류로 끝나지 않게 합니다.
 */
object PasswordValidationHelper {
    const val MAX_UTF8_BYTES = 72
    val CHARACTER_LENGTH = 8..72
    private val ALLOWED_CHARACTERS = Regex("[\\x21-\\x7E]+")

    fun fitsBcryptLimit(password: String): Boolean = password.toByteArray(Charsets.UTF_8).size <= MAX_UTF8_BYTES

    fun hasAllowedCharacters(password: String): Boolean = ALLOWED_CHARACTERS.matches(password)

    fun requireNewPassword(password: String) {
        require(password.length in CHARACTER_LENGTH && fitsBcryptLimit(password) && hasAllowedCharacters(password)) {
            "password must be 8..72 ASCII letters, digits or symbols without spaces and at most $MAX_UTF8_BYTES UTF-8 bytes"
        }
    }
}
