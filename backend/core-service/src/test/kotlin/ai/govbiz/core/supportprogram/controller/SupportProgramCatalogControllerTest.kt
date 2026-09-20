package ai.govbiz.core.supportprogram.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramCatalogSort
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.service.catalog.SupportProgramCatalogService
import ai.govbiz.core.supportprogram.service.catalog.exception.SupportProgramCatalogFilterException
import ai.govbiz.core.supportprogram.service.dto.SupportProgramCatalogResult
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test
import org.mockito.Mockito
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.validation.beanvalidation.LocalValidatorFactoryBean

class SupportProgramCatalogControllerTest {
    private val service = Mockito.mock(SupportProgramCatalogService::class.java)
    private val validator = LocalValidatorFactoryBean().apply { afterPropertiesSet() }
    private val mvc = MockMvcBuilders.standaloneSetup(SupportProgramCatalogController(service))
        .setControllerAdvice(ApiExceptionHandler())
        .setValidator(validator)
        .build()

    @AfterEach
    fun closeValidator() = validator.close()

    @Test
    fun omittedParametersUseOpenRecentFirstPageAndPreserveExistingProgramResponse() {
        Mockito.`when`(service.browse()).thenReturn(result())

        mvc.perform(get(URL)).andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
            .andExpect(jsonPath("$.programs[0].id").value("공고-1"))
            .andExpect(jsonPath("$.programs[0].sourceCode").value("BIZINFO"))
            .andExpect(jsonPath("$.programs[0].status").value("OPEN"))
            .andExpect(jsonPath("$.programs[0].matchedReasons").isEmpty())
            .andExpect(jsonPath("$.programs[0].recommendationScore").isEmpty())
            .andExpect(jsonPath("$.programs[0].eligibilityReview").isEmpty())
            .andExpect(jsonPath("$.total").value(1))
            .andExpect(jsonPath("$.page").value(1))
            .andExpect(jsonPath("$.pageSize").value(12))
            .andExpect(jsonPath("$.totalPages").value(1))
            .andExpect(jsonPath("$.regions[0]").value("서울"))
            .andExpect(jsonPath("$.categories[0]").value("수출"))
        Mockito.verify(service).browse()
        Mockito.verifyNoMoreInteractions(service)
    }

    @Test
    fun explicitFiltersMapAllStatusToUnrestrictedAndDeadlineToTheDomainSort() {
        Mockito.`when`(service.browse("  AI %_  ", " 서울 ", "수출", null, SupportProgramCatalogSort.DEADLINE, 2, 6))
            .thenReturn(result().copy(programs = emptyList(), page = 2, pageSize = 6))

        mvc.perform(get(URL).param("keyword", "  AI %_  ").param("region", " 서울 ").param("category", "수출")
            .param("status", "ALL").param("sort", "DEADLINE").param("page", "2").param("pageSize", "6"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.page").value(2))
        Mockito.verify(service).browse("  AI %_  ", " 서울 ", "수출", null, SupportProgramCatalogSort.DEADLINE, 2, 6)
        Mockito.verifyNoMoreInteractions(service)
    }

    @Test
    fun supportsEachConcreteStatusWithoutAiOrCompanyConditions() {
        for (selected in SupportProgramStatus.entries) {
            Mockito.`when`(service.browse(status = selected)).thenReturn(result())
            mvc.perform(get(URL).param("status", selected.name)).andExpect(status().isOk())
            Mockito.verify(service).browse(status = selected)
        }
        Mockito.verifyNoMoreInteractions(service)
    }

    @Test
    fun rejectsUnknownEnumValuesBeforeCallingService() {
        for ((field, value) in listOf("status" to "open", "status" to "INVALID", "sort" to "oldest", "sort" to "RECENT,DEADLINE", "sourceCode" to "kstartup", "sourceCode" to "UNKNOWN", "sourceCode" to "BIZINFO,KSTARTUP")) {
            mvc.perform(get(URL).param(field, value)).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
                .andExpect(jsonPath("$.errors[0].field").value(field))
        }
        Mockito.verifyNoInteractions(service)
    }

    @Test
    fun rejectsPaginationBoundsAndMalformedNumbersWithoutEchoingInputOrInternalErrors() {
        for (field in listOf("page", "pageSize")) {
            val values = listOf("0", "-1", "1.5", "invalid-secret-value", "2147483648") +
                if (field == "page") listOf("1000001") else listOf("51")
            for (value in values) {
                val body = mvc.perform(get(URL).param(field, value)).andExpect(status().isBadRequest())
                    .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                    .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
                    .andExpect(jsonPath("$.errors[0].field").value(field))
                    .andReturn().response.contentAsString
                assertFalse(body.contains("invalid-secret-value"))
                assertFalse(body.contains("NumberFormatException"))
            }
        }
        Mockito.verifyNoInteractions(service)
    }

    @Test
    fun validatesRawTextLengthsAndControlCharactersBeforeCallingService() {
        for ((field, limit) in listOf("keyword" to 100, "region" to 50, "category" to 100, "startupStage" to 100, "applicantType" to 100, "founderAge" to 100)) {
            for (value in listOf("가".repeat(limit + 1), "😀".repeat(limit / 2 + 1), "가\u0000", "가\u200b", "가\n")) {
                mvc.perform(get(URL).param(field, value)).andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
                    .andExpect(jsonPath("$.errors[0].field").value(field))
            }
        }
        Mockito.verifyNoInteractions(service)
    }

    @Test
    fun acceptsMaximumTextAndPaginationBoundaries() {
        val keyword = "가".repeat(100)
        val region = "나".repeat(50)
        val category = "다".repeat(100)
        Mockito.`when`(service.browse(keyword, region, category, SupportProgramStatus.OPEN, SupportProgramCatalogSort.RECENT, 1_000_000, 50))
            .thenReturn(result().copy(programs = emptyList(), page = 1_000_000, pageSize = 50))

        mvc.perform(get(URL).param("keyword", keyword).param("region", region).param("category", category)
            .param("page", "1000000").param("pageSize", "50"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.programs").isEmpty())
        Mockito.verify(service).browse(keyword, region, category, SupportProgramStatus.OPEN, SupportProgramCatalogSort.RECENT, 1_000_000, 50)
        Mockito.verifyNoMoreInteractions(service)
    }

    private fun result() = SupportProgramCatalogResult(
        programs = listOf(SupportProgram(
            id = "공고-1", sourceCode = "BIZINFO", title = "수출 지원사업", organization = "서울시",
            summary = "공식 API 본문", categories = listOf("수출"), regions = listOf("서울"),
            targetDescription = "중소기업", applicationPeriod = "상시 접수", applicationStartDate = null,
            applicationEndDate = null, status = SupportProgramStatus.OPEN, sourceName = "기업마당",
            sourceUrl = "https://www.bizinfo.go.kr/", matchedReasons = emptyList(),
        )),
        total = 1, page = 1, pageSize = 12, totalPages = 1,
        regions = listOf("서울"), categories = listOf("수출"),
    )

    @Test
    fun startupFiltersAndFacetsCrossTheHttpBoundaryWithoutChangingProgramCards() {
        Mockito.`when`(service.browse(sourceCode = "KSTARTUP", rawStartupStage = "3년미만", rawApplicantType = "일반기업", rawFounderAge = "만 40세 이상"))
            .thenReturn(result().copy(startupStages = listOf("3년미만"), applicantTypes = listOf("일반기업"), founderAges = listOf("만 40세 이상")))

        mvc.perform(get(URL).param("sourceCode", "KSTARTUP").param("startupStage", "3년미만")
            .param("applicantType", "일반기업").param("founderAge", "만 40세 이상"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.startupStages[0]").value("3년미만"))
            .andExpect(jsonPath("$.applicantTypes[0]").value("일반기업"))
            .andExpect(jsonPath("$.founderAges[0]").value("만 40세 이상"))
    }

    @Test
    fun invalidSourceCombinationReturnsAStableValidationError() {
        Mockito.`when`(service.browse(rawStartupStage = "3년미만")).thenThrow(SupportProgramCatalogFilterException())

        mvc.perform(get(URL).param("startupStage", "3년미만"))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
            .andExpect(jsonPath("$.errors[0].field").value("sourceCode"))
    }

    private companion object {
        // Source values are explicit API contracts, not arbitrary upstream URLs.
        const val URL = "/api/v1/support-programs/catalog"
    }

    @Test
    fun acceptsBothNewNoticeSourcesWithoutChangingTheRequestedStatus() {
        for (source in listOf("MSIT", "CNTRADE_NOTICE")) {
            Mockito.`when`(service.browse(sourceCode = source, status = SupportProgramStatus.UNKNOWN))
                .thenReturn(result().copy(programs = emptyList(), total = 0, totalPages = 0))
            mvc.perform(get(URL).param("sourceCode", source).param("status", "UNKNOWN"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(0))
            Mockito.verify(service).browse(sourceCode = source, status = SupportProgramStatus.UNKNOWN)
        }
    }
}
