package ai.govbiz.core.supportprogram.domain

import java.time.LocalDate
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
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
    fun recognizesRollingPhrasesRegardlessOfSpacingBetweenWords() {
        listOf(
            "모집 완료 시까지",
            "모집 완료시",
            "모집완료 시",
            "모집 마감 시까지",
            "모집마감시",
            "접수 마감 시까지",
            "신청 마감 시까지",
            "예산 소진 시까지",
            "예산소진시 까지",
            "예산 조기 소진 시 마감",
            "물량 소진 시까지",
            "정원 마감 시까지",
            "인원 초과 시 마감",
            "선착순 마감",
            "연중 상시 모집",
            "수시모집",
        ).forEach { applicationPeriod ->
            assertEquals(SupportProgramStatus.OPEN, resolve(applicationPeriod), applicationPeriod)
            assertTrue(SupportProgramStatusResolver.isRollingPeriod(applicationPeriod), applicationPeriod)
        }
    }

    @Test
    fun doesNotReadOtherWordsAsRollingPhrasesWhenSpacingIsIgnored() {
        listOf(
            // "이상 시"의 공백을 지우면 "상시"가 되지만 상시 접수가 아닙니다.
            "참가 기업 100개사 이상 시 조기 마감",
            "70점 이상시 선정",
            "비상시 연락처 별도 안내",
            "온라인 접수시 유의사항 참고",
            "상시근로자 5인 이상 기업",
            "상시 고용 인원 10명 미만",
            "접수 마감 시간 18:00",
            // 접수·신청 마감 "시"는 "까지"가 붙을 때만 수시 접수로 봅니다. 마감 때의 안내·종료는 기간이 아닙니다.
            "접수 마감 시 별도 안내",
            "접수 마감 시 종료",
            "선정 완료 시 개별 통보",
            "신청 완료 시 문자 안내",
            // 정원이 찼다는 상태일 수도 있어 조건("시까지")이 없으면 접수 중으로 보지 않습니다.
            "정원 마감",
        ).forEach { applicationPeriod ->
            assertEquals(SupportProgramStatus.UNKNOWN, resolve(applicationPeriod), applicationPeriod)
            assertFalse(SupportProgramStatusResolver.isRollingPeriod(applicationPeriod), applicationPeriod)
        }
    }

    @Test
    fun keepsClosureLanguageAheadOfNewlyRecognizedRollingPhrases() {
        listOf(
            "모집 완료 시까지 (모집 종료)",
            "선착순 접수 (조기 마감되었습니다)",
            "예산 소진 시까지 - 접수종료",
            "모집 마감 시까지 · 마감완료",
            "상시 접수였으나 사업이 종료됨",
        ).forEach { applicationPeriod ->
            assertEquals(SupportProgramStatus.CLOSED, resolve(applicationPeriod), applicationPeriod)
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
