package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core._common.helper.buildRestClient
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.applicationpreparation.client.ai.ApplicationOnlineFormMcpClient
import ai.govbiz.core.applicationpreparation.client.ai.mapper.ApplicationOnlineFormMcpMapper
import ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationOnlineFormMcpException
import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.facade.AiApplicationPreparationFacade
import ai.govbiz.core.applicationpreparation.repository.*
import ai.govbiz.core.supportprogram.repository.SavedSupportProgramRepository
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.domain.SupportProgramApplicationRoute
import ai.govbiz.core.supportprogram.domain.SupportProgramApplicationRouteType
import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper
import java.net.URI
import java.time.Duration
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.http.converter.json.JacksonJsonHttpMessageConverter
import org.springframework.web.client.RestClient
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule
import tools.jackson.module.kotlin.jacksonObjectMapper

/** Explicit manual smoke: Core Service -> real HTTP AI -> real stdio MCP -> public responder. */
class ApplicationOnlineFormVerticalSmokeTest {
    @Test
    fun realPublicResponderReachesExistingReviewWithoutWritesOrOpenAi() {
        val url = System.getenv("GOOGLE_PUBLIC_FORM_SMOKE_URL")
        val aiUrl = System.getenv("GOOGLE_PUBLIC_FORM_SMOKE_AI_URL")
        val token = System.getenv("GOOGLE_PUBLIC_FORM_SMOKE_TOKEN")
        assumeTrue(!url.isNullOrBlank() && !aiUrl.isNullOrBlank() && !token.isNullOrBlank(), "manual live smoke only")
        val json = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
        val rest = buildRestClient(
            RestClient.builder().messageConverters { it.clear(); it.add(JacksonJsonHttpMessageConverter(json)) },
            URI(aiUrl!!), Duration.ofSeconds(5), Duration.ofSeconds(35),
        )
        val client = ApplicationOnlineFormMcpClient(rest, token!!, json, ApplicationOnlineFormMcpMapper())
        val repository = mock(ApplicationPreparationRepository::class.java)
        val forms = mock(ApplicationFormService::class.java)
        val inputs = mock(ApplicationPreparationInputRepository::class.java)
        val ai = mock(AiApplicationPreparationFacade::class.java)
        val contents = mock(ApplicationPreparationContentRepository::class.java)
        val saved = mock(SavedSupportProgramRepository::class.java)
        val supportPrograms = mock(SupportProgramRepository::class.java)
        val service = ApplicationPreparationService(repository, forms, inputs, ai, contents, saved, client, supportPrograms)
        val manifest = javaClass.getResourceAsStream("/application-preparation/innovation-voucher-2026-v1.json")!!.use {
            jacksonObjectMapper().readValue(it, ApplicationFormManifest::class.java)
        }
        val now = LocalDateTime.of(2026, 9, 28, 10, 0)
        val account = Account(90001, "synthetic@example.test", AccountRole.USER, null, null, now)
        val draft = NewApplicationPreparation(manifest.sourceCode, manifest.sourceProgramId,
            manifest.formVersionId, manifest.supportedServiceFields.first())
        `when`(repository.findOwned(account.id, 90001)).thenReturn(
            StoredApplicationPreparation(90001, account.id, 1, ApplicationProgressStage.PREPARING, 1, now, draft, now, now))
        `when`(forms.requireVersion(manifest.formVersionId)).thenReturn(manifest)
        val catalog = SupportProgramTestHelper.catalogProgram(manifest.sourceProgramId)
        `when`(supportPrograms.findPresentBySourceAndProgramId(manifest.sourceCode, manifest.sourceProgramId))
            .thenReturn(catalog.copy(program = catalog.program.copy(applicationRoute =
                SupportProgramApplicationRoute("온라인", url, SupportProgramApplicationRouteType.GOOGLE_FORMS))))
        `when`(inputs.listOwnedFacts(account.id, 90001)).thenReturn(emptyList())
        val result = try {
            service.inspectPublicOnlineForm(account, 90001,
                ApplicationOnlineFormSourceReference(url!!, "GOOGLE_FORMS"))
        } catch (error: ApplicationOnlineFormMcpException) {
            println("ONLINE_FORM_VERTICAL_SMOKE_ERROR code=${error.code}")
            throw error
        }
        assertTrue(result.formId.isNotBlank())
        assertTrue(result.formTitle.isNotBlank())
        assertTrue(result.fieldMappings.isNotEmpty())
        assertEquals(result.fieldMappings.size, result.mappedCount + result.unmappedCount)
        assertTrue(result.requiredMissingCount >= 0)
        assertTrue(result.reviewRequiredCount >= 0)
        assertTrue(result.fieldMappings.none { it.writable })
        println("ONLINE_FORM_VERTICAL_SMOKE formId=${result.formId} fields=${result.fieldMappings.size} " +
            "mapped=${result.mappedCount} unmapped=${result.unmappedCount} " +
            "requiredMissing=${result.requiredMissingCount} reviewRequired=${result.reviewRequiredCount}")
        val guide = service.onlineInputGuide(account, 90001)
        assertEquals(url, guide.officialApplicationUrl)
        assertTrue(guide.totalCount > 0)
        assertEquals(guide.totalCount, guide.items.size)
        assertTrue(guide.items.all { it.sourceControlId != null && it.inputMode != "UNKNOWN" })
        println("ONLINE_FORM_VERTICAL_GUIDE questions=${guide.totalCount} " +
            "inputModes=${guide.items.map { it.inputMode }} " +
            "options=${guide.items.map { it.options.size }} " +
            "statuses=${guide.items.map { it.status }}")
        assertEquals("APPLICATION_ONLINE_FORM_INVALID_URL",
            assertThrows(ApplicationOnlineFormMcpException::class.java) {
                client.inspect("https://example.com/form")
            }.code)
        val wrongToken = ApplicationOnlineFormMcpClient(rest, "w".repeat(32), json, ApplicationOnlineFormMcpMapper())
        assertEquals("APPLICATION_ONLINE_FORM_MCP_FAILED",
            assertThrows(ApplicationOnlineFormMcpException::class.java) { wrongToken.inspect(url) }.code)
        verify(repository, times(2)).findOwned(account.id, 90001)
        verify(forms, times(2)).requireVersion(manifest.formVersionId)
        verify(inputs).listOwnedFacts(account.id, 90001)
        verify(supportPrograms).findPresentBySourceAndProgramId(manifest.sourceCode, manifest.sourceProgramId)
        verifyNoInteractions(ai, contents, saved)
    }
}
