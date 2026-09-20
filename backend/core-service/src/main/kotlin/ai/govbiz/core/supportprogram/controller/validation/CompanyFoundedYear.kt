package ai.govbiz.core.supportprogram.controller.validation

import jakarta.validation.Constraint
import jakarta.validation.ConstraintValidator
import jakarta.validation.ConstraintValidatorContext
import jakarta.validation.Payload
import java.time.LocalDate
import java.time.ZoneId
import kotlin.reflect.KClass

/** 설립연도만 아는 회사의 정보 정밀도를 유지하며 미래 연도는 거부합니다. */
@MustBeDocumented
@Target(AnnotationTarget.FIELD, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.PROPERTY_GETTER)
@Retention(AnnotationRetention.RUNTIME)
@Constraint(validatedBy = [CompanyFoundedYearValidator::class])
annotation class CompanyFoundedYear(
    val message: String = "must be between 1900 and the current year in Asia/Seoul",
    val groups: Array<KClass<*>> = [],
    val payload: Array<KClass<out Payload>> = [],
)

class CompanyFoundedYearValidator : ConstraintValidator<CompanyFoundedYear, Int> {
    override fun isValid(value: Int?, context: ConstraintValidatorContext): Boolean =
        value == null || value in 1900..LocalDate.now(context.clockProvider.clock.withZone(ZoneId.of("Asia/Seoul"))).year
}
