package ai.govbiz.core.account.service

import ai.govbiz.core.account.client.bizno.BiznoClient
import ai.govbiz.core.account.client.bizno.dto.BiznoBusiness
import ai.govbiz.core.account.service.exception.BusinessNotFoundException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.InjectMocks
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class BusinessLookupServiceTest {

    @Mock
    private lateinit var biznoClient: BiznoClient

    @InjectMocks
    private lateinit var service: BusinessLookupService

    @Test
    fun normalizesTheNumberAndReturnsTheFirstRegisteredBusiness() {
        doReturn(listOf(activeBusiness())).`when`(biznoClient).findByBusinessNumber("1248100998")

        assertEquals(activeBusiness(), service.lookup("124-81-00998"))
    }

    @Test
    fun keepsAClosedBusinessSoTheCallerCanExplainTheStatus() {
        val closed = activeBusiness().copy(businessStatus = "폐업자", businessStatusCode = "03")
        doReturn(listOf(closed)).`when`(biznoClient).findByBusinessNumber("1248100998")

        assertEquals(closed, service.lookup("1248100998"))
        assertEquals(false, service.lookup("1248100998").isActive)
    }

    @Test
    fun reportsAnUnregisteredNumberAsNotFound() {
        doReturn(emptyList<BiznoBusiness>()).`when`(biznoClient).findByBusinessNumber("1234567890")

        assertThrows(BusinessNotFoundException::class.java) { service.lookup("123-45-67890") }
    }

    @Test
    fun rejectsANumberThatIsNotTenDigitsBeforeCallingBizno() {
        assertThrows(IllegalArgumentException::class.java) { service.lookup("12-34") }

        verifyNoInteractions(biznoClient)
    }

    private fun activeBusiness() =
        BiznoBusiness(
            businessNumber = "1248100998",
            companyName = "삼성전자(주)",
            businessStatus = "계속사업자",
            businessStatusCode = "01",
        )
}
