package ai.govbiz.core.account.controller.validation

import ai.govbiz.core.account.controller.dto.ChangePasswordRequest
import ai.govbiz.core.account.controller.dto.DeleteAccountRequest
import ai.govbiz.core.account.controller.dto.LoginRequest
import ai.govbiz.core.account.controller.dto.PasswordResetConfirmRequest
import ai.govbiz.core.account.controller.dto.SignupRequest
import ai.govbiz.core.account.helper.PasswordValidationHelper
import jakarta.validation.Validation
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder

/** 문자 규칙과 별개로 BCrypt의 UTF-8 72바이트 상한이 그대로 남아 있는지 확인합니다. */
class PasswordByteLimitTest {
    @Test
    fun byteLimitTracksTheBcryptBoundaryIndependentlyOfTheCharacterRule() {
        for (password in listOf("a".repeat(72), "한".repeat(24), "😀".repeat(18))) {
            assertTrue(PasswordValidationHelper.fitsBcryptLimit(password))
            assertTrue(BCryptPasswordEncoder(4).matches(password, BCryptPasswordEncoder(4).encode(password)))
        }
        for (password in listOf("a".repeat(73), "한".repeat(25), "😀".repeat(19), "a".repeat(70) + "한")) {
            assertFalse(PasswordValidationHelper.fitsBcryptLimit(password))
            assertThrows(IllegalArgumentException::class.java) { PasswordValidationHelper.requireNewPassword(password) }
        }
        assertThrows(IllegalArgumentException::class.java) { BCryptPasswordEncoder(4).encode("한".repeat(25)) }
    }

    @Test
    fun newPasswordRequestsReportByteOverflowAndCharacterViolationsSeparately() {
        Validation.buildDefaultValidatorFactory().use { factory ->
            val validator = factory.validator
            // 72바이트 안이지만 한글이라 문자 규칙만 어깁니다.
            newPasswordRequests("한".repeat(24)).forEach { request ->
                assertEquals(setOf(PasswordCharacters::class.java), violations(validator.validate(request)))
            }
            // 72바이트를 넘으면 두 검사가 모두 잡습니다.
            for (password in listOf("한".repeat(25), "😀".repeat(19))) {
                newPasswordRequests(password).forEach { request ->
                    assertEquals(setOf(PasswordByteLimit::class.java, PasswordCharacters::class.java), violations(validator.validate(request)))
                }
            }
        }
    }

    @Test
    fun existingPasswordVerificationStillAcceptsLegacyMultibyteInputs() {
        val legacyPassword = "한".repeat(25)
        Validation.buildDefaultValidatorFactory().use { factory ->
            assertTrue(factory.validator.validate(LoginRequest("member@example.com", legacyPassword)).isEmpty())
            assertTrue(factory.validator.validate(DeleteAccountRequest(legacyPassword)).isEmpty())
        }
        // Legacy BCrypt hashes may reflect only the first 72 bytes; matches must retain that compatibility.
        val encoder = BCryptPasswordEncoder(4)
        assertTrue(encoder.matches(legacyPassword, encoder.encode("한".repeat(24))))
    }

    private fun violations(result: Set<jakarta.validation.ConstraintViolation<*>>): Set<Class<out Annotation>> =
        result.map { it.constraintDescriptor.annotation.annotationClass.java }.toSet()

    private fun newPasswordRequests(password: String): List<Any> = listOf(
        SignupRequest("member@example.com", password, "a".repeat(43)),
        ChangePasswordRequest(password),
        PasswordResetConfirmRequest("a".repeat(43), password),
    )
}
