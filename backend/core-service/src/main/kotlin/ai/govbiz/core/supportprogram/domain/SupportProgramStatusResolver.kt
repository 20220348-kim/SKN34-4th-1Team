package ai.govbiz.core.supportprogram.domain

import java.text.Normalizer
import java.time.LocalDate
import java.util.Locale
import java.util.regex.Pattern

/**
 * 신청 기간과 서울 기준 날짜로 공고의 현재 접수 상태를 계산합니다.
 *
 * 파싱된 날짜가 상태를 결정할 수 있으면 날짜를 우선합니다. 날짜만으로 결정할 수 없을 때는
 * 명시적인 종료 표현이 상시 접수·예산 소진 같은 수시 접수 표현보다 우선합니다.
 */
object SupportProgramStatusResolver {
    private val WHITESPACE: Pattern = Pattern.compile("\\s+")

    fun resolve(
        applicationPeriod: String,
        applicationStartDate: LocalDate?,
        applicationEndDate: LocalDate?,
        today: LocalDate,
    ): SupportProgramStatus {
        if (applicationStartDate != null && today.isBefore(applicationStartDate)) {
            return SupportProgramStatus.UPCOMING
        }
        if (applicationEndDate != null && today.isAfter(applicationEndDate)) {
            return SupportProgramStatus.CLOSED
        }
        if (applicationStartDate != null && applicationEndDate != null) {
            return SupportProgramStatus.OPEN
        }

        val normalized = normalize(applicationPeriod)
        if (containsAny(normalized, "추후 공지", "추후공지", "접수 예정", "접수예정")) {
            return SupportProgramStatus.UPCOMING
        }
        if (applicationEndDate != null) return SupportProgramStatus.OPEN
        if (containsAny(normalized, "접수 종료", "접수종료", "모집 종료", "모집종료", "마감 완료")) {
            return SupportProgramStatus.CLOSED
        }
        if (isRollingPeriod(normalized)) return SupportProgramStatus.OPEN
        return SupportProgramStatus.UNKNOWN
    }

    fun isRollingPeriod(applicationPeriod: String): Boolean =
        containsAny(
            normalize(applicationPeriod),
            "예산 소진", "예산소진", "상시", "선착순", "모집 완료시", "모집완료시",
            "모집 마감시", "모집마감시", "수시", "정원 마감", "정원마감",
            "규모 마감", "규모마감", "소진시", "완료시",
        )

    private fun containsAny(value: String, vararg candidates: String): Boolean =
        candidates.any(value::contains)

    private fun normalize(value: String): String {
        val normalized = Normalizer.normalize(value, Normalizer.Form.NFKC)
            .lowercase(Locale.ROOT)
        return WHITESPACE.matcher(normalized).replaceAll(" ").trim()
    }
}
