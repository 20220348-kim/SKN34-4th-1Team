package ai.govbiz.core.applicationpreparation.facade

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.applicationpreparation.client.ai.AiApplicationPreparationClient
import ai.govbiz.core.applicationpreparation.client.ai.dto.AI_APPLICATION_PREPARATION_CONTRACT_VERSION
import ai.govbiz.core.applicationpreparation.client.ai.dto.AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationFormDiscoveryPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationFormDiscoveryRequest
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDiscoveredApplicationFormFieldPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDiscoveredApplicationFormPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDiscoveredApplicationFormSectionPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationPreparationConfigurationPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationPreparationInterpretPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationPreparationInterpretRequest
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationPreparationSuggestionPayload
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormFieldDefinition
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryBlock
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryConfiguration
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryDocument
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryInput
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormSectionDefinition
import ai.govbiz.core.applicationpreparation.domain.ApplicationInterpretationInputSnapshot
import ai.govbiz.core.applicationpreparation.domain.ApplicationServiceField
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.mock
import org.mockito.Mockito.`when`
import org.slf4j.LoggerFactory

class AiApplicationPreparationFacadeTest {
    private val client = mock(AiApplicationPreparationClient::class.java)
    private val facade = AiApplicationPreparationFacade(client)
    private val configuration = AiApplicationPreparationConfigurationPayload(
        AI_APPLICATION_PREPARATION_CONTRACT_VERSION,
        "test-model",
        "sha256:${"a".repeat(64)}",
    )
    private val snapshot = ApplicationInterpretationInputSnapshot(
        1,
        "verified-form-v1",
        "company-overview",
        ApplicationServiceField.TECHNICAL_SUPPORT,
        "업체명은 새봄테크입니다.",
        emptyList(),
    )

    @BeforeEach
    fun prepare() {
        `when`(client.configuration()).thenReturn(configuration)
    }

    @Test
    fun acceptsOnlyAllowedSuggestionsBackedByAnExactUserQuote() {
        `when`(client.interpret(any(AiApplicationPreparationInterpretRequest::class.java) ?: fallback())).thenReturn(payload())
        val result = facade.interpret(3, form(), snapshot)
        assertEquals("company-name", result.suggestions.single().fieldKey)
        assertEquals("새봄테크", result.suggestions.single().value)
    }

    @Test
    fun rejectsInventedEvidenceAsAnInvalidAiResponse() {
        `when`(client.interpret(any(AiApplicationPreparationInterpretRequest::class.java) ?: fallback())).thenReturn(
            payload().copy(suggestions = listOf(AiApplicationPreparationSuggestionPayload(
                "company-name", "PROVIDED", "다른 회사", "사용자가 말하지 않은 문장",
            ))),
        )
        val error = assertThrows(AiServiceCallException::class.java) { facade.interpret(3, form(), snapshot) }
        assertEquals(AiServiceFailure.INVALID_RESPONSE, error.failure)
    }

    @Test
    fun trimsSafeDiscoveryTextAndKeepsTheExactCanonicalSourceQuote() {
        val discoveryConfiguration = AiApplicationPreparationConfigurationPayload(
            AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION,
            "test-model",
            "sha256:${"b".repeat(64)}",
        )
        `when`(client.discoveryConfiguration()).thenReturn(discoveryConfiguration)
        `when`(client.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: fallbackDiscovery())).thenReturn(
            AiApplicationFormDiscoveryPayload(
                AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION,
                "test-model",
                discoveryConfiguration.promptVersion,
                listOf(AiDiscoveredApplicationFormPayload(0, listOf(
                    AiDiscoveredApplicationFormSectionPayload(
                        "business-plan", "  사업\n계획  ", "  사업 개요를\r\n작성합니다.  ",
                        listOf(AiDiscoveredApplicationFormFieldPayload(
                            "business-overview", "  사업\t개요  ", "  목적과\n내용을 입력합니다.  ", false,
                            "D0-B0", "사업\n개요",
                        )),
                    ),
                ))),
            ),
        )
        val input = ApplicationFormDiscoveryInput(
            "BIZINFO", "PBLN_1", "지원사업", "https://www.bizinfo.go.kr/form",
            listOf(ApplicationFormDiscoveryDocument(
                0, "https://www.bizinfo.go.kr/file", "사업계획서.hwpx", "HWPX", 10, "a".repeat(64),
                listOf(ApplicationFormDiscoveryBlock("D0-B0", "문단 1", "사업\n개요를 작성합니다.")),
            )),
        )

        val configuration = facade.discoveryConfiguration()
        val result = facade.discover(input, configuration).single().sections.single()

        assertEquals("사업 계획", result.title)
        assertEquals("사업 개요를 작성합니다.", result.description)
        assertEquals("사업 개요", result.fields.single().label)
        assertEquals("목적과 내용을 입력합니다.", result.fields.single().guidance)
        assertEquals("사업\n개요", result.fields.single().evidenceQuote)
    }

    @Test
    fun countsDiscoveryEvidenceLengthByUnicodeCodePointLikeTheAiContract() {
        val quote = "😀".repeat(300)
        val configuration = ApplicationFormDiscoveryConfiguration(
            AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION,
            "test-model",
            "sha256:${"b".repeat(64)}",
        )
        `when`(client.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: fallbackDiscovery())).thenReturn(
            discoveryPayload(guidance = "내용을 입력합니다.", quote = quote),
        )

        val result = facade.discover(discoveryInput(quote), configuration)

        assertEquals(300, result.single().sections.single().fields.single().evidenceQuote.codePointCount(0, quote.length))
    }

    @Test
    fun logsOnlySafePathAndLengthsForARejectedDiscoveryField() {
        val privateGuidance = "외부에 남기면 안 되는\u200b문장"
        val configuration = ApplicationFormDiscoveryConfiguration(
            AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION,
            "test-model",
            "sha256:${"b".repeat(64)}",
        )
        `when`(client.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: fallbackDiscovery())).thenReturn(
            discoveryPayload(guidance = privateGuidance, quote = "사업 개요"),
        )
        val logger = LoggerFactory.getLogger(AiApplicationPreparationFacade::class.java) as Logger
        val appender = ListAppender<ILoggingEvent>().apply { start() }
        logger.addAppender(appender)

        val failure = try {
            assertThrows(AiServiceCallException::class.java) { facade.discover(discoveryInput("사업 개요"), configuration) }
        } finally {
            logger.detachAppender(appender)
            appender.stop()
        }

        assertEquals(AiServiceFailure.INVALID_RESPONSE, failure.failure)
        val diagnostic = appender.list.joinToString("\n") { it.formattedMessage }
        assertTrue(diagnostic.contains("path=forms[0].sections[0].fields[0].guidance"))
        assertTrue(diagnostic.contains("reason=FORBIDDEN_DISPLAY_CHARACTER"))
        assertTrue(diagnostic.contains("forbiddenCharacterCount=1"))
        assertTrue(!diagnostic.contains(privateGuidance))
    }

    private fun payload() = AiApplicationPreparationInterpretPayload(
        AI_APPLICATION_PREPARATION_CONTRACT_VERSION,
        "test-model",
        configuration.promptVersion,
        3,
        1,
        "verified-form-v1",
        "company-overview",
        listOf(AiApplicationPreparationSuggestionPayload("company-name", "PROVIDED", "새봄테크", "업체명은 새봄테크")),
        emptyList(),
        null,
    )

    private fun form() = ApplicationFormManifest(
        1,
        "verified-form-v1",
        "BIZINFO",
        "PBLN_1",
        "지원사업",
        "사업계획서",
        "https://www.bizinfo.go.kr/form",
        "form.hwpx",
        1,
        "a".repeat(64),
        "SOURCE_HASH_AND_LOCATORS_VERIFIED",
        false,
        listOf(ApplicationServiceField.TECHNICAL_SUPPORT),
        listOf(ApplicationFormSectionDefinition(
            "company-overview",
            "기업 개요",
            "문단 1",
            "기업을 설명합니다.",
            listOf(ApplicationFormFieldDefinition("company-name", "업체명", "업체명을 입력합니다.", true)),
        )),
    )

    private fun fallback() = AiApplicationPreparationInterpretRequest(
        AI_APPLICATION_PREPARATION_CONTRACT_VERSION,
        3,
        1,
        "verified-form-v1",
        "company-overview",
        "TECHNICAL_SUPPORT",
        "답변",
        emptyList(),
        emptyList(),
    )

    @Test
    fun preservesOfficialChoicesAndRejectsInventedChoices() {
        val quote = "분야 택1: 기술, 생활"
        val configuration = ApplicationFormDiscoveryConfiguration(AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION, "test-model", "sha256:${"b".repeat(64)}")
        `when`(client.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: fallbackDiscovery())).thenReturn(
            discoveryPayload("하나 선택", quote, listOf("기술", "생활")),
        )
        assertEquals(listOf("기술", "생활"), facade.discover(discoveryInput(quote), configuration).single().sections.single().fields.single().options)
        `when`(client.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: fallbackDiscovery())).thenReturn(
            discoveryPayload("하나 선택", quote, listOf("기술", "없는 분야")),
        )
        assertThrows(AiServiceCallException::class.java) { facade.discover(discoveryInput(quote), configuration) }
    }

    private fun discoveryPayload(guidance: String, quote: String, options: List<String> = emptyList()) = AiApplicationFormDiscoveryPayload(
        AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION,
        "test-model",
        "sha256:${"b".repeat(64)}",
        listOf(AiDiscoveredApplicationFormPayload(0, listOf(
            AiDiscoveredApplicationFormSectionPayload(
                "business-plan",
                "사업 계획",
                "사업 개요를 작성합니다.",
                listOf(AiDiscoveredApplicationFormFieldPayload(
                    "business-overview",
                    "사업 개요",
                    guidance,
                    false,
                    "D0-B0",
                    quote,
                    options,
                )),
            ),
        ))),
    )

    private fun discoveryInput(sourceText: String) = ApplicationFormDiscoveryInput(
        "BIZINFO",
        "PBLN_1",
        "지원사업",
        "https://www.bizinfo.go.kr/form",
        listOf(ApplicationFormDiscoveryDocument(
            0,
            "https://www.bizinfo.go.kr/file",
            "사업계획서.hwpx",
            "HWPX",
            10,
            "a".repeat(64),
            listOf(ApplicationFormDiscoveryBlock("D0-B0", "문단 1", sourceText)),
        )),
    )

    private fun fallbackDiscovery() = AiApplicationFormDiscoveryRequest(
        AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION,
        "BIZINFO",
        "PBLN_1",
        "지원사업",
        emptyList(),
    )
}
