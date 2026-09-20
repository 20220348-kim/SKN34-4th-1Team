package ai.govbiz.core.dailyreport.service

import ai.govbiz.core.account.domain.Company
import ai.govbiz.core.account.domain.CompanyProfileInput
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.anyValue
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.dailyreport.client.DailyReportMailClient
import ai.govbiz.core.dailyreport.client.exception.DailyReportMailException
import ai.govbiz.core.dailyreport.config.DailyReportProperties
import ai.govbiz.core.dailyreport.domain.*
import ai.govbiz.core.dailyreport.domain.exception.DailyReportErrorCode
import ai.govbiz.core.dailyreport.domain.exception.DailyReportException
import ai.govbiz.core.dailyreport.repository.DailyReportRepository
import ai.govbiz.core.supportprogram.domain.*
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.config.SupportProgramRequestAdmissionProperties
import ai.govbiz.core.supportprogram.service.dto.*
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import ai.govbiz.core.supportprogram.service.readiness.SupportProgramSearchReadinessService
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchService
import java.time.LocalDate
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.anyLong
import org.mockito.ArgumentMatchers.anyString
import org.mockito.ArgumentMatchers.eq
import org.mockito.Mockito.*

class DailyReportServiceTest {
    private val repository = mock(DailyReportRepository::class.java)
    private val companies = mock(CompanyRepository::class.java)
    private val accounts = mock(AccountRepository::class.java)
    private val search = mock(SupportProgramSearchService::class.java)
    private val readiness = mock(SupportProgramSearchReadinessService::class.java)
    private val evidence = mock(SupportProgramEvidenceService::class.java)
    private val mail = mock(DailyReportMailClient::class.java)
    private val account = AccountTestHelper.account()
    private val now = AccountTestHelper.NOW
    private val date = LocalDate.of(2026, 9, 6)
    private val input = DailyReportInput("서울 AI", "서울", "정보통신업", "수출")
    private val report = DailyReport(1, account.id, date, DailyReportStatus.GENERATING, DailyReportDeliveryStatus.NOT_REQUESTED,
        input, null, null, null, 1, "generation-key", now)
    private val company = Company(1, account.id, "1234567890", input.companyName, "계속사업자", "01",
        CompanyProfileInput(input.region, input.industry, 2020, null), now, now, now)
    private lateinit var service: DailyReportService

    @BeforeEach
    fun setUp() {
        service = DailyReportService(repository, companies, accounts, search, readiness, evidence, mail,
            DailyReportProperties(), SupportProgramRequestAdmissionService(SupportProgramRequestAdmissionProperties()), AccountTestHelper.FIXED_CLOCK)
        doReturn(company).`when`(companies).findByAccountId(account.id)
    }

    @Test
    fun reusesSavedReportWithoutAiOrAnotherGenerationBudget() {
        val saved = report.copy(status = DailyReportStatus.READY, content = DailyReportContent(emptyList(), emptyList()), generatedAt = now)
        doReturn(saved).`when`(repository).forDay(account.id, date)
        assertEquals(saved, service.preview(account))
        verifyNoInteractions(search, evidence, readiness, mail)
        verify(repository, never()).reserve(anyLong(), anyValue(), anyValue(), eq(20))
    }

    @Test
    fun preparingCatalogIsAnErrorAndDoesNotConsumeBudgetOrCallAi() {
        doReturn(SupportProgramSearchReadinessResult(SupportProgramSearchState.PREPARING, 0, false, null, null, emptyList()))
            .`when`(readiness).get()
        assertEquals(DailyReportErrorCode.SEARCH_NOT_READY, assertThrows(DailyReportException::class.java) { service.preview(account) }.code)
        verifyNoInteractions(search, evidence, mail)
        verify(repository, never()).reserve(anyLong(), anyValue(), anyValue(), eq(20))
    }

    @Test
    fun sendsSavedProfileWithoutInventingEstablishedDateAndPersistsPartialEvidenceFailures() {
        prepareGeneration()
        val programs = listOf(program("BIZINFO", "1"), program("KSTARTUP", "1"), program("BIZINFO", "2"), program("BIZINFO", "ignored"))
        doReturn(SupportProgramSearchResult("q", programs)).`when`(search).search(anyString(), eq(true), anyValue())
        doReturn(SupportProgramEvidenceAnswerResult("사업계획서를 제출합니다.", SupportProgramEvidenceAnswerStatus.ANSWERED,
            listOf(SupportProgramEvidenceCitationResult("사업계획서", "https://www.bizinfo.go.kr/detail?id=1", 0))))
            .`when`(evidence).answer(equalValue("BIZINFO"), equalValue("1"), anyString())
        doThrow(IllegalStateException("private upstream failure")).`when`(evidence).answer(equalValue("BIZINFO"), equalValue("2"), anyString())
        var content: DailyReportContent? = null
        doAnswer { call -> content = call.getArgument(1); true }.`when`(repository).succeed(equalValue(report), anyValue())

        service.preview(account)

        verify(search).search("서울 정보통신업 수출 지원사업", true, SupportProgramCompanyConditions("서울", "정보통신업", null, "수출"))
        val saved = requireNotNull(content)
        assertEquals(listOf(DailyReportEvidenceStatus.ANSWERED, DailyReportEvidenceStatus.UNSUPPORTED, DailyReportEvidenceStatus.FAILED), saved.programs.map { it.evidenceStatus })
        assertEquals(3, saved.programs.size)
        assertTrue(saved.warnings.any { it.contains("실패") })
        assertTrue(saved.warnings.any { it.contains("선정확률") })
        assertFalse(saved.toString().contains("private upstream"))
        verify(evidence, never()).answer(equalValue("KSTARTUP"), anyString(), anyString())
        verify(evidence, never()).answer(equalValue("BIZINFO"), equalValue("ignored"), anyString())
        verifyNoInteractions(mail)
    }

    @Test
    fun searchFailureIsStoredAsFailedNotAnEmptySuccessfulReport() {
        prepareGeneration()
        doThrow(IllegalStateException("private upstream failure")).`when`(search).search(anyString(), eq(true), anyValue())
        service.preview(account)
        verify(repository).fail(report)
        verify(repository, never()).succeed(anyValue(), anyValue())
        verifyNoInteractions(evidence, mail)
    }

    @Test
    fun unsubscribeBetweenClaimAndSmtpSkipsDelivery() {
        val saved = ready()
        doReturn(true).`when`(mail).isAvailable()
        doReturn(account).`when`(accounts).findById(account.id)
        doReturn(true).`when`(repository).claimDelivery(eq(saved.id), equalValue(account.email), anyString())
        doReturn(DailyReportSubscription(account.id, "", false, account.email, now, now)).`when`(repository).subscription(account.id)
        doReturn(true).`when`(repository).finishDelivery(saved.id, DailyReportDeliveryStatus.SKIPPED)
        service.deliver(saved)
        verify(repository).finishDelivery(saved.id, DailyReportDeliveryStatus.SKIPPED)
        verify(mail, never()).sendReport(anyString(), anyString(), anyValue(), anyString(), anyString())
    }

    @Test
    fun smtpFailureIsUnknownAndAlreadyClaimedReportIsNeverSentTwice() {
        val saved = ready()
        doReturn(true).`when`(mail).isAvailable()
        doReturn(account).`when`(accounts).findById(account.id)
        doReturn(true, false).`when`(repository).claimDelivery(eq(saved.id), equalValue(account.email), anyString())
        doReturn(DailyReportSubscription(account.id, "", true, account.email, now, now)).`when`(repository).subscription(account.id)
        doThrow(DailyReportMailException()).`when`(mail).sendReport(anyString(), anyString(), anyValue(), anyString(), anyString())
        doReturn(true).`when`(repository).finishDelivery(saved.id, DailyReportDeliveryStatus.UNKNOWN)
        service.deliver(saved)
        service.deliver(saved)
        verify(repository).finishDelivery(saved.id, DailyReportDeliveryStatus.UNKNOWN)
        verify(mail, times(1)).sendReport(anyString(), anyString(), anyValue(), anyString(), anyString())
    }

    private fun <T> equalValue(value: T): T { eq(value); return value }

    @Test
    fun queuedDeliveryBeforeSeoulSendHourDoesNotClaimOrSend() {
        doReturn(true).`when`(mail).isAvailable()
        val earlyClock = java.time.Clock.fixed(java.time.Instant.parse("2026-09-08T22:59:00Z"), java.time.ZoneId.of("Asia/Seoul"))
        DailyReportService(repository, companies, accounts, search, readiness, evidence, mail,
            DailyReportProperties(), SupportProgramRequestAdmissionService(SupportProgramRequestAdmissionProperties()), earlyClock)
            .deliverQueued(report.id)
        verifyNoInteractions(repository, accounts, search, evidence)
        verify(mail, never()).sendReport(anyString(), anyString(), anyValue(), anyString(), anyString())
    }

    private fun prepareGeneration() {
        doReturn(SupportProgramSearchReadinessResult(SupportProgramSearchState.SEARCHABLE_WITH_PARTIAL_SOURCES, 1, true, null, null, emptyList()))
            .`when`(readiness).get()
        doReturn(DailyReportSubscription(account.id, "수출", false, null, null, null)).`when`(repository).subscription(account.id)
        doReturn(DailyReportReservation(report, true)).`when`(repository).reserve(account.id, date, input, 20)
        doReturn(null, ready()).`when`(repository).forDay(account.id, date)
    }
    private fun ready() = report.copy(status = DailyReportStatus.READY, content = DailyReportContent(emptyList(), listOf("선정확률이 아닙니다.")), generatedAt = now)
    private fun program(source: String, id: String) = SupportProgram(id, source, "AI 지원", "기관", "AI 지원사업", listOf("AI"),
        listOf("서울"), "중소기업", "상시 접수", null, null, SupportProgramStatus.OPEN, "기관", "https://www.bizinfo.go.kr/detail?id=$id", listOf("AI 관련"), 86)
}
