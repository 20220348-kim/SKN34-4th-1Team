package ai.govbiz.catalog.supportprogram.domain

import java.text.Normalizer
import java.time.LocalDate
import java.util.Locale
import java.util.regex.Pattern

/**
 * 신청 기간과 서울 기준 날짜로 공고의 현재 접수 상태를 계산합니다.
 *
 * 파싱된 날짜가 상태를 결정할 수 있으면 날짜를 우선합니다. 날짜만으로 결정할 수 없을 때는
 * 명시적인 종료 표현이 상시 접수·예산 소진 같은 수시 접수 표현보다 우선합니다.
 *
 * 낱말 사이 띄어쓰기만 다른 변형("모집 완료 시", "모집완료시")은 같은 표현으로 보지만, 공백을 모두 지운 뒤
 * 부분 일치로 찾지는 않습니다. 그러면 "100개사 이상 시"의 "이상시"가 "상시"로, "접수 시"가 "수시"로 읽혀
 * 마감된 공고를 접수 중으로 계산할 수 있기 때문입니다. 뜻이 갈리는 표현은 접수 중으로 보지 않습니다.
 */
object SupportProgramStatusResolver {
    private val WHITESPACE: Pattern = Pattern.compile("\\s+")
    private val UPCOMING_PERIOD = Regex("추후\\s*공지|접수\\s*예정")
    private val CLOSED_PERIOD = Regex("접수\\s*종료|모집\\s*종료|마감\\s*완료|(?:마감|종료)\\s*(?:되었|됐|됨)")

    // 조건이 채워지는 때를 뜻하는 "시"입니다. 시간·시각·시작·시행은 마감 시각이 있는 공고라 제외합니다.
    private const val WHEN = "\\s*(?:시(?![간각작행])|될|되면|때)"
    private val ROLLING_PERIOD = Regex(
        listOf(
            // 이상시·비상시·평상시·정상시, 상시 근로자·종업원·고용 인원은 상시 접수가 아닙니다.
            "(?<![이비평정])상시(?!\\s*(?:근로|종업|고용|인원|직원))",
            // 접수시·인수시·회수시는 수시 접수가 아닙니다.
            "(?<![접인회])수시",
            "선착순",
            "(?:예산|재원|자금|사업비)\\s*(?:조기\\s*)?소진",
            "소진$WHEN",
            "(?:모집|정원|인원|규모)\\s*마감$WHEN",
            // 접수·신청 마감 "시"는 마감 때의 안내("접수 마감 시 별도 안내")와 갈리므로 "까지"가 붙을 때만 봅니다.
            "(?:접수|신청)\\s*마감\\s*시\\s*까지",
            // 신청 완료·선정 완료 시의 안내는 접수 기간이 아니므로 모집·정원이 찰 때만 봅니다.
            "(?:모집|정원|인원)\\s*(?:완료|충족|초과)$WHEN",
        ).joinToString("|"),
    )

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
        if (UPCOMING_PERIOD.containsMatchIn(normalized)) return SupportProgramStatus.UPCOMING
        if (applicationEndDate != null) return SupportProgramStatus.OPEN
        if (CLOSED_PERIOD.containsMatchIn(normalized)) return SupportProgramStatus.CLOSED
        if (isRollingPeriod(normalized)) return SupportProgramStatus.OPEN
        return SupportProgramStatus.UNKNOWN
    }

    /** 마감일 없이 상시로, 또는 예산·정원이 찰 때까지 받는다는 표현이 있는지 봅니다. */
    fun isRollingPeriod(applicationPeriod: String): Boolean =
        ROLLING_PERIOD.containsMatchIn(normalize(applicationPeriod))

    private fun normalize(value: String): String {
        val normalized = Normalizer.normalize(value, Normalizer.Form.NFKC)
            .lowercase(Locale.ROOT)
        return WHITESPACE.matcher(normalized).replaceAll(" ").trim()
    }
}
