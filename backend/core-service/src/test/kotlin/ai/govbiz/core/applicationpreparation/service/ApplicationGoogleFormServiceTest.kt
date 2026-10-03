package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.applicationpreparation.client.ai.ApplicationOnlineFormMcpClient
import ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationOnlineFormMcpException
import ai.govbiz.core.applicationpreparation.domain.ApplicationGoogleForm
import ai.govbiz.core.applicationpreparation.domain.ApplicationGoogleFormQuestion
import ai.govbiz.core.applicationpreparation.domain.ApplicationGoogleFormQuestionKind
import ai.govbiz.core.supportprogram.domain.SupportProgramApplicationRoute
import ai.govbiz.core.supportprogram.domain.SupportProgramApplicationRouteType
import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.detail.exception.SupportProgramNotFoundException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.Mockito.`when`

class ApplicationGoogleFormServiceTest {
    private val programs = mock(SupportProgramRepository::class.java)
    private val client = mock(ApplicationOnlineFormMcpClient::class.java)
    private val service = ApplicationGoogleFormService(programs, client)
    private val account = AccountTestHelper.account()
    private val url = "https://forms.gle/abc123"

    private fun route(type: SupportProgramApplicationRouteType, address: String? = url) {
        val catalog = SupportProgramTestHelper.catalogProgram("179183")
        `when`(programs.findPresentBySourceAndProgramId("KSTARTUP", "179183"))
            .thenReturn(catalog.copy(program = catalog.program.copy(applicationRoute = SupportProgramApplicationRoute("온라인 접수", address, type))))
    }

    @Test fun readsOnlyTheProgramsOfficialGoogleForm() {
        route(SupportProgramApplicationRouteType.GOOGLE_FORMS)
        val form = ApplicationGoogleForm("https://docs.google.com/forms/d/e/public-id/viewform", "특강 신청", listOf(
            ApplicationGoogleFormQuestion("101", "성명", "", true, ApplicationGoogleFormQuestionKind.SHORT_TEXT, emptyList(), false)))
        `when`(client.readGoogleForm(url)).thenReturn(form)
        assertSame(form, service.read(account, "KSTARTUP", "179183"))
    }

    @Test fun otherRoutesAndMissingProgramsDoNotReachTheReader() {
        route(SupportProgramApplicationRouteType.OTHER_ONLINE_FORM)
        assertEquals("APPLICATION_ONLINE_FORM_UNSUPPORTED",
            assertThrows(ApplicationOnlineFormMcpException::class.java) { service.read(account, "KSTARTUP", "179183") }.code)
        route(SupportProgramApplicationRouteType.GOOGLE_FORMS, address = null)
        assertThrows(ApplicationOnlineFormMcpException::class.java) { service.read(account, "KSTARTUP", "179183") }
        assertThrows(SupportProgramNotFoundException::class.java) { service.read(account, "BIZINFO", "missing") }
        verifyNoInteractions(client)
    }
}
