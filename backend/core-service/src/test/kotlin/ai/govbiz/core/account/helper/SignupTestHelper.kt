package ai.govbiz.core.account.helper

import java.sql.Timestamp
import java.time.LocalDateTime
import java.time.ZoneId
import org.springframework.jdbc.core.JdbcTemplate

/**
 * 통합 테스트가 인증번호 메일 없이 가입할 수 있게, 이미 인증을 마친 통행 토큰 행을 직접 넣어 줍니다.
 * 시각은 서비스와 같은 서울 기준이라 MySQL 컨테이너의 UTC `NOW()`와 섞이지 않습니다.
 */
object SignupTestHelper {
    private val SEOUL: ZoneId = ZoneId.of("Asia/Seoul")

    /** 이 이메일로 한 시간 동안 유효한 가입 통행 토큰을 만들어 원문을 돌려줍니다. */
    fun issueSignupPass(jdbcTemplate: JdbcTemplate, email: String): String {
        val passToken = OneTimeTokenHelper.newToken()
        val now = LocalDateTime.now(SEOUL)
        jdbcTemplate.update(
            """
            INSERT INTO signup_email_verification
                (email, code_hash, expires_at, attempt_count, verified_at, pass_token_hash, pass_expires_at, created_at)
            VALUES (?, ?, ?, 0, ?, ?, ?, ?)
            """.trimIndent(),
            normalizeEmail(email),
            OneTimeTokenHelper.hash("test-code-never-used"),
            Timestamp.valueOf(now.plusHours(1)),
            Timestamp.valueOf(now),
            OneTimeTokenHelper.hash(passToken),
            Timestamp.valueOf(now.plusHours(1)),
            Timestamp.valueOf(now),
        )
        return passToken
    }

    /** 통행 토큰까지 갖춘 가입 요청 본문입니다. */
    fun signupJson(jdbcTemplate: JdbcTemplate, email: String, password: String): String =
        """{"email":"$email","password":"$password","emailPassToken":"${issueSignupPass(jdbcTemplate, email)}"}"""
}
