package ai.govbiz.core.supportprogram.controller.validation

import jakarta.validation.ConstraintValidator
import jakarta.validation.ConstraintValidatorContext

class CodePointMaxValidator : ConstraintValidator<CodePointMax, CharSequence> {

    private var max = 0

    override fun initialize(constraintAnnotation: CodePointMax) {
        max = constraintAnnotation.max
    }

    override fun isValid(value: CharSequence?, context: ConstraintValidatorContext): Boolean {
        if (value == null) {
            return true
        }

        val text = value.toString()
        return text.codePointCount(0, text.length) <= max
    }
}
