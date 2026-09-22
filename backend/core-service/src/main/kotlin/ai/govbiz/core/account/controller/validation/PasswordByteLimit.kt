package ai.govbiz.core.account.controller.validation

import ai.govbiz.core.account.helper.PasswordValidationHelper
import jakarta.validation.Constraint
import jakarta.validation.ConstraintValidator
import jakarta.validation.ConstraintValidatorContext
import jakarta.validation.Payload
import kotlin.reflect.KClass

/** 새 비밀번호 전용입니다. 기존 해시를 확인하는 로그인·탈퇴 입력에는 적용하지 않습니다. */
@Target(AnnotationTarget.FIELD)
@Retention(AnnotationRetention.RUNTIME)
@Constraint(validatedBy = [PasswordByteLimitValidator::class])
annotation class PasswordByteLimit(
    val message: String = "must be at most 72 UTF-8 bytes",
    val groups: Array<KClass<*>> = [],
    val payload: Array<KClass<out Payload>> = [],
)

class PasswordByteLimitValidator : ConstraintValidator<PasswordByteLimit, String> {
    override fun isValid(value: String?, context: ConstraintValidatorContext): Boolean =
        value == null || PasswordValidationHelper.fitsBcryptLimit(value)
}
