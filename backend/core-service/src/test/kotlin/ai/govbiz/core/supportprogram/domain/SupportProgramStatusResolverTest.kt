package ai.govbiz.core.supportprogram.domain

import java.time.LocalDate
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class SupportProgramStatusResolverTest {

    @Test
    fun givesExplicitClosureLanguagePriorityOverRollingLanguageWhenDatesDoNotDecideStatus() {
        listOf(
            "예산 소진으로 접수 종료",
            "상시 접수 (접수 종료)",
        ).forEach { applicationPeriod ->
            assertEquals(
                SupportProgramStatus.CLOSED,
                resolve(applicationPeriod),
                applicationPeriod,
            )
        }
    }

    @Test
    fun keepsRollingPeriodsOpenWhenTheyDoNotContainExplicitClosureLanguage() {
        listOf(
            "예산 소진 시까지",
            "상시 접수",
            "선착순 모집",
        ).forEach { applicationPeriod ->
            assertEquals(
                SupportProgramStatus.OPEN,
                resolve(applicationPeriod),
                applicationPeriod,
            )
        }
    }

    @Test
    fun keepsParsedDatesAheadOfApplicationPeriodText() {
        assertEquals(
            SupportProgramStatus.UPCOMING,
            resolve(
                applicationPeriod = "상시 접수",
                applicationStartDate = LocalDate.of(2026, 9, 10),
                applicationEndDate = null,
            ),
        )
        assertEquals(
            SupportProgramStatus.CLOSED,
            resolve(
                applicationPeriod = "예산 소진 시까지",
                applicationStartDate = null,
                applicationEndDate = LocalDate.of(2026, 8, 31),
            ),
        )
        assertEquals(
            SupportProgramStatus.OPEN,
            resolve(
                applicationPeriod = "상시 접수 (접수 종료)",
                applicationStartDate = LocalDate.of(2026, 9, 1),
                applicationEndDate = LocalDate.of(2026, 9, 30),
            ),
        )
    }

    private fun resolve(
        applicationPeriod: String,
        applicationStartDate: LocalDate? = null,
        applicationEndDate: LocalDate? = null,
    ): SupportProgramStatus =
        SupportProgramStatusResolver.resolve(
            applicationPeriod = applicationPeriod,
            applicationStartDate = applicationStartDate,
            applicationEndDate = applicationEndDate,
            today = TODAY,
        )

    private companion object {
        val TODAY: LocalDate = LocalDate.of(2026, 9, 5)
    }
}
