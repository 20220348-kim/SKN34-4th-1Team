package ai.govbiz.core.supportprogram.service.catalog

import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.catalog.exception.SupportProgramCatalogFilterException
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.mockito.Mockito

class SupportProgramCatalogFilterValidationTest {
    @Test
    fun rejectsStartupFiltersWithoutTheirSourceBeforeReadingTheDatabase() {
        val repository = Mockito.mock(SupportProgramRepository::class.java)
        val service = SupportProgramCatalogService(repository)
        for (source in listOf("", "BIZINFO", "UNKNOWN")) {
            assertThrows(SupportProgramCatalogFilterException::class.java) { service.browse(sourceCode = source, rawStartupStage = "3년미만") }
            assertThrows(SupportProgramCatalogFilterException::class.java) { service.browse(sourceCode = source, rawApplicantType = "일반기업") }
            assertThrows(SupportProgramCatalogFilterException::class.java) { service.browse(sourceCode = source, rawFounderAge = "만 40세 이상") }
        }
        Mockito.verifyNoInteractions(repository)
    }
}
