package ai.govbiz.core.account.controller.validation

import ai.govbiz.core.account.controller.dto.ChangePasswordRequest
import ai.govbiz.core.account.controller.dto.PasswordResetConfirmRequest
import ai.govbiz.core.account.controller.dto.SignupRequest
import ai.govbiz.core.account.helper.PasswordValidationHelper
import jakarta.validation.Validation
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder

class PasswordCharactersTest {
    @Test
    fun newPasswordRequestsAcceptAsciiLettersDigitsAndSymbolsUpToTheBcryptLimit() {
        Validation.buildDefaultValidatorFactory().use { factory ->
            val validator = factory.validator
            for (password in listOf("password", "Abc123!@#\$%^&*()_+-=[]{}|;:'\",.<>/?`~", "a".repeat(72))) {
                newPasswordRequests(password).forEach { assertTrue(validator.validate(it).isEmpty()) }
                PasswordValidationHelper.requireNewPassword(password)
                assertTrue(BCryptPasswordEncoder(4).matches(password, BCryptPasswordEncoder(4).encode(password)))
            }
        }
    }

    @Test
    fun newPasswordRequestsRejectKoreanEmojiAndSpaces() {
        Validation.buildDefaultValidatorFactory().use { factory ->
            val validator = factory.validator
            for (password in listOf("한".repeat(8), "😀".repeat(8), "pass word1", "a".repeat(7) + "한")) {
                newPasswordRequests(password).forEach { request ->
                    assertEquals(setOf(PasswordCharacters::class.java),
                        validator.validate(request).map { it.constraintDescriptor.annotation.annotationClass.java }.toSet())
                }
                assertThrows(IllegalArgumentException::class.java) { PasswordValidationHelper.requireNewPassword(password) }
            }
        }
    }

    private fun newPasswordRequests(password: String): List<Any> = listOf(
        SignupRequest("member@example.com", password, "a".repeat(43)),
        ChangePasswordRequest(password),
        PasswordResetConfirmRequest("a".repeat(43), password),
    )
}
