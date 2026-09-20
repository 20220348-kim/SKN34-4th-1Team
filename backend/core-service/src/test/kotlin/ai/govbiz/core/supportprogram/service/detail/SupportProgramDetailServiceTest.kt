package ai.govbiz.core.supportprogram.service.detail

import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper
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
