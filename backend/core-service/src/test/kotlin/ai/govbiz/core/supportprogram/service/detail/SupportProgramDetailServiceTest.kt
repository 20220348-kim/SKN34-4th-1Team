package ai.govbiz.core.supportprogram.service.detail

import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramDetailResponse
import ai.govbiz.core.supportprogram.domain.SupportProgramApplicationRoute
import ai.govbiz.core.supportprogram.domain.SupportProgramApplicationRouteType
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.detail.exception.SupportProgramNotFoundException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.verify
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class SupportProgramDetailServiceTest {

    @Mock
    private lateinit var supportProgramRepository: SupportProgramRepository

    private lateinit var service: SupportProgramDetailService

    @BeforeEach
    fun setUp() {
        service = SupportProgramDetailService(supportProgramRepository)
    }

    @Test
    fun findsTheCurrentProgramUsingTheExactSourceIdentityValues() {
        val catalogProgram = SupportProgramTestHelper.catalogProgram("PBLN_TEST")
        doReturn(catalogProgram).`when`(supportProgramRepository)
            .findPresentBySourceAndProgramId("BIZINFO", "PBLN_TEST")

        val result = service.get("BIZINFO", "PBLN_TEST")

        assertEquals(catalogProgram.program, result)
    }

    @Test
    fun detailResponseKeepsTheAnnouncementAndApplicationUrlsSeparate() {
        val program = SupportProgramTestHelper.catalogProgram("PBLN_TEST").program.copy(
            applicationRoute = SupportProgramApplicationRoute(
                "온라인 접수", "https://forms.gle/abc123", SupportProgramApplicationRouteType.GOOGLE_FORMS),
        )
        val response = SupportProgramDetailResponse.from(program)
        assertEquals(program.sourceUrl, response.sourceUrl)
        assertEquals(program.applicationRoute.method, response.applicationRoute.method)
        assertEquals(program.applicationRoute.url, response.applicationRoute.url)
        assertEquals(program.applicationRoute.type.name, response.applicationRoute.type)
    }

    @Test
    fun doesNotSilentlyChangeSourceIdentityValuesBeforeLookingThemUp() {
        assertThrows(SupportProgramNotFoundException::class.java) {
            service.get(" BIZINFO ", " PBLN_TEST ")
        }

        verify(supportProgramRepository)
            .findPresentBySourceAndProgramId(" BIZINFO ", " PBLN_TEST ")
    }

    @Test
    fun throwsNotFoundWhenTheCurrentProgramDoesNotExist() {
        assertThrows(SupportProgramNotFoundException::class.java) {
            service.get("BIZINFO", "PBLN_MISSING")
        }
    }
}
