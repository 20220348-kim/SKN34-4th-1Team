package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core._common.config.JsonDeserializationConfig
import jakarta.validation.Validation
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

class SupportProgramSearchRequestTest {
    @Test
    fun preservesYearOnlyWithoutInventingAFoundationDate() {
        val request = SupportProgramCompanyConditionsRequest(foundedYear = 2021)
        assertTrue(violations(request).isEmpty())
        assertEquals(2021, request.toDomain()!!.foundedYear)
        assertNull(request.toDomain()!!.establishedOn)
        assertEquals(setOf("foundedYear"), violations(request.copy(foundedYear = 2027)))
        assertEquals(setOf("foundedYear"), violations(request.copy(foundedYear = 1899)))
        assertEquals(setOf("foundationPrecisionValid"), violations(request.copy(establishedOn = "2021-01-01")))
    }

    @Test
    fun trimsOptionalTextAndTreatsEmptyConditionsAsUnspecified() {
        val conditions = SupportProgramCompanyConditionsRequest(" 서울 ", " 제조업 ", "2024-02-29", " 시제품 ").toDomain()!!
        assertEquals("서울", conditions.region)
        assertEquals("제조업", conditions.industry)
        assertEquals(LocalDate.of(2024, 2, 29), conditions.establishedOn)
        assertEquals("시제품", conditions.supportPurpose)
        assertNull(SupportProgramCompanyConditionsRequest("  ", "", "", " ").toDomain())
    }

    @ParameterizedTest
    @ValueSource(strings = ["1900-01-01", "2024-02-29", "2026-09-07", "", " "])
    fun acceptsRealCalendarDatesThroughSeoulTodayIncludingTheBoundary(value: String) {
        assertEquals(emptySet<String>(), violations(SupportProgramCompanyConditionsRequest(establishedOn = value)))
    }

    @ParameterizedTest
    @ValueSource(strings = ["1899-12-31", "2026-09-08", "2025-02-29", "2026-02-30", "2026-13-01", "2026-9-01", "2026-09-07T00:00:00", " 2026-09-07", "2026-09-07 ", "\t", "\n", "           "])
    fun rejectsInvalidFutureOrNonIsoCalendarDates(value: String) {
        assertEquals(setOf("establishedOn"), violations(SupportProgramCompanyConditionsRequest(establishedOn = value)))
    }

    @Test
    fun validatesAllNestedFieldLimitsAndRejectsControlCharacters() {
        assertEquals(emptySet<String>(), violations(SupportProgramCompanyConditionsRequest("가".repeat(50), "나".repeat(100), null, "다".repeat(100))))
        assertEquals(setOf("region", "industry", "supportPurpose"), violations(SupportProgramCompanyConditionsRequest("가".repeat(51), "나".repeat(101), null, "다".repeat(101))))
        for (control in listOf("\n", "\r", "\t", "\u0000", "\u200b")) {
            assertEquals(setOf("region", "industry", "supportPurpose"), violations(SupportProgramCompanyConditionsRequest("서울$control", "제조$control", null, "수출$control")))
        }
    }

    @Test
    fun postQueryMustBeNonblankAndKeepsTheExistingFiveHundredUtf16Limit() {
        withValidator { validator ->
            assertTrue(validator.validate(SupportProgramSearchRequest("가".repeat(500))).isEmpty())
            for (query in listOf("", "  ", "가".repeat(501), "😀".repeat(251), "AI\u0000")) {
                assertTrue(validator.validate(SupportProgramSearchRequest(query)).isNotEmpty())
            }
            val request = SupportProgramSearchRequest("AI", companyConditions = SupportProgramCompanyConditionsRequest(region = "가".repeat(51)))
            assertEquals(setOf("companyConditions.region"), validator.validate(request).map { it.propertyPath.toString() }.toSet())
        }
    }

    @ParameterizedTest
    @ValueSource(strings = ["\"false\"", "0", "1", "0.0", "\"\"", "null"])
    fun acceptingOnlyRequiresAJsonBoolean(value: String) {
        val builder = JsonMapper.builder().addModule(KotlinModule.Builder().build())
        JsonDeserializationConfig().strictJsonRequestTypes().customize(builder)
        val mapper = builder.build()
        assertThrows(Exception::class.java) {
            mapper.readValue("""{"query":"AI","acceptingOnly":$value}""", SupportProgramSearchRequest::class.java)
        }
        assertEquals(false, mapper.readValue("""{"query":"AI","acceptingOnly":false}""", SupportProgramSearchRequest::class.java).acceptingOnly)
        assertEquals(true, mapper.readValue("""{"query":"AI"}""", SupportProgramSearchRequest::class.java).acceptingOnly)
    }

    private fun violations(value: SupportProgramCompanyConditionsRequest): Set<String> =
        withValidator { validator -> validator.validate(value).map { it.propertyPath.toString() }.toSet() }

    private fun <T> withValidator(action: (jakarta.validation.Validator) -> T): T =
        Validation.byDefaultProvider().configure()
            .clockProvider { Clock.fixed(Instant.parse("2026-09-06T15:00:00Z"), ZoneOffset.UTC) }
            .buildValidatorFactory().use { action(it.validator) }
}
