package ai.govbiz.core.supportprogram.client.cntradenotice.mapper

import ai.govbiz.core.supportprogram.client.cntradenotice.dto.CnTradeNoticeProgramPayload
import ai.govbiz.core.supportprogram.client.cntradenotice.exception.CnTradeNoticeClientException
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CnTradeNoticeProgramMapperTest {
    @Test
    fun preservesOriginalEligibilityButNeverInfersChungnamOrApplicationDatesFromThePublisher() {
        val catalog = CnTradeNoticeProgramMapper.mapValidated(listOf(payload())).single()
        val program = catalog.program
        assertEquals("CNTRADE_NOTICE:3862", program.sourceQualifiedId)
        assertEquals("충청남도 온라인수출지원시스템", program.sourceName)
        assertEquals(emptyList<String>(), program.regions)
        assertEquals(emptyList<String>(), program.categories)
        assertEquals("경기 소재 기업 대상 제외 대상: 체납 기업", program.targetDescription)
        assertNull(program.applicationStartDate)
        assertNull(program.applicationEndDate)
        assertEquals("정보 없음", program.applicationPeriod)
        assertEquals(SupportProgramStatus.UNKNOWN, program.status)
        assertEquals("2021-10-22", catalog.sortTimestamp)
        assertNull(catalog.startupDetails)
    }

    @Test
    fun usesOnlyTheObservedOfficialListUrlBecauseEncryptedDetailIdsCannotBeDerivedFromLbbNo() {
        val program = CnTradeNoticeProgramMapper.mapValidated(listOf(payload().copy(
            contentHtml = "<p>본문</p><a href='javascript:alert(1)'>원문</a><script>secret()</script><style>secret</style>",
        ))).single().program
        assertEquals("https://cntrade.chungnam.go.kr/home/kor/M102638244/board.do", program.sourceUrl)
        assertFalse(program.sourceUrl.contains("3862"))
        assertFalse(program.summary.contains("javascript:"))
        assertFalse(program.summary.contains("secret"))
        assertEquals("본문 원문", program.targetDescription)
        assertTrue(program.summary.endsWith("개별 원문은 공식 공지 목록에서 공고 제목으로 찾아 주세요."))
    }

    @Test
    fun retainsGeneralNoticesWithoutInventingSupportCategoriesOrOpenStatus() {
        val program = CnTradeNoticeProgramMapper.mapValidated(listOf(payload().copy(
            title = "시스템 점검 안내", contentHtml = null, organization = null,
        ))).single().program
        assertEquals("정보 없음", program.targetDescription)
        assertEquals("정보 없음", program.organization)
        assertEquals(SupportProgramStatus.UNKNOWN, program.status)
        assertTrue(program.categories.isEmpty())
    }

    @Test
    fun validatesEveryNoticeBeforeReturningASnapshot() {
        for (invalid in listOf(payload().copy(id = "0"), payload().copy(id = "01"),
            payload().copy(id = "1".repeat(256)), payload().copy(title = "<br>"),
            payload().copy(title = "가".repeat(501)), payload().copy(organization = "가".repeat(256)),
            payload().copy(contentHtml = "가".repeat(22_000)))) {
            assertThrows(CnTradeNoticeClientException::class.java) {
                CnTradeNoticeProgramMapper.mapValidated(listOf(payload().copy(id = "2"), invalid))
            }
        }
        assertThrows(CnTradeNoticeClientException::class.java) {
            CnTradeNoticeProgramMapper.mapValidated(listOf(payload(), payload()))
        }
    }

    @Test
    fun invalidOrMissingPublicationDatesDoNotBecomeApplicationDates() {
        for (date in listOf(null, "2021-02-30", "20211022", "<b>2021-10-22</b>")) {
            val item = CnTradeNoticeProgramMapper.mapValidated(listOf(payload().copy(registeredDate = date))).single()
            assertEquals("", item.sortTimestamp)
            assertNull(item.program.applicationStartDate)
            assertNull(item.program.applicationEndDate)
        }
    }

    private fun payload() = CnTradeNoticeProgramPayload(
        id = "3862", title = "<b>경기 수출 지원 공고</b>", organization = "국제통상과",
        contentHtml = "<p>경기 소재 기업 대상</p><p>제외 대상: 체납 기업</p>",
        registeredDate = "2021-10-22", modifiedDate = "2026-09-09",
    )
}
