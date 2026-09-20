package ai.govbiz.core.supportprogram.controller.validation

import jakarta.validation.Constraint
import jakarta.validation.ConstraintValidator
import jakarta.validation.ConstraintValidatorContext
import jakarta.validation.Payload
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeParseException
import kotlin.reflect.KClass

@MustBeDocumented
@Target(AnnotationTarget.FIELD, AnnotationTarget.VALUE_PARAMETER, AnnotationTarget.PROPERTY_GETTER)
@Retention(AnnotationRetention.RUNTIME)
@Constraint(validatedBy = [CompanyEstablishedOnValidator::class])
annotation class CompanyEstablishedOn(
    val message: String = "must be an ISO date between 1900-01-01 and today in Asia/Seoul",
    val groups: Array<KClass<*>> = [],
    val payload: Array<KClass<out Payload>> = [],
)

class CompanyEstablishedOnValidator : ConstraintValidator<CompanyEstablishedOn, String> {
    override fun isValid(value: String?, context: ConstraintValidatorContext): Boolean {
        if (value == null || value.all { it == ' ' }) return true
        if (!ISO_DATE.matches(value)) return false
        val date = try {
            LocalDate.parse(value)
        } catch (_: DateTimeParseException) {
            return false
        }
        val today = LocalDate.now(context.clockProvider.clock.withZone(SEOUL_ZONE))
        return date >= EARLIEST_DATE && date <= today
    }

    private companion object {
        val ISO_DATE = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")
        val EARLIEST_DATE = LocalDate.of(1900, 1, 1)
        val SEOUL_ZONE = ZoneId.of("Asia/Seoul")
    }
}
