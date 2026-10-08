package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.planusage.PlanUsageTestHelper
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.applicationpreparation.client.ai.ApplicationOnlineFormMcpClient
import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.facade.AiApplicationPreparationFacade
import ai.govbiz.core.applicationpreparation.repository.*
import ai.govbiz.core.supportprogram.repository.SavedSupportProgramRepository
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.applicationpreparation.client.ai.mapper.ApplicationOnlineFormMcpMapper
import ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationOnlineFormMcpException
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationOnlineFormSourceCapabilityStatus
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationOnlineInputGuideStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramApplicationRoute
import ai.govbiz.core.supportprogram.domain.SupportProgramApplicationRouteType
import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.http.MediaType
import org.springframework.http.converter.json.JacksonJsonHttpMessageConverter
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient
import org.mockito.Mockito.*
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule
import tools.jackson.module.kotlin.jacksonObjectMapper

class ApplicationPreparationServiceOnlineFormTest {
    private val repository = mock(ApplicationPreparationRepository::class.java)
    private val forms = mock(ApplicationFormService::class.java)
    private val inputs = mock(ApplicationPreparationInputRepository::class.java)
    private val ai = mock(AiApplicationPreparationFacade::class.java)
    private val contents = mock(ApplicationPreparationContentRepository::class.java)
    private val saved = mock(SavedSupportProgramRepository::class.java)
    private val onlineMcp = mock(ApplicationOnlineFormMcpClient::class.java)
    private val service = ApplicationPreparationService(repository, forms, inputs, ai, contents, saved, onlineMcp, mock(SupportProgramRepository::class.java), PlanUsageTestHelper.allowAll(), PlanUsageTestHelper.noTransactions())
    private val now = LocalDateTime.of(2026, 9, 27, 12, 0)
    private val owner = Account(1, "owner@example.com", AccountRole.USER, null, null, now)
    private val source = ApplicationOnlineFormSource(1, "review-form", "검토 신청서", listOf(
        ApplicationOnlineFormSourceControl("name", "업체명", true),
        ApplicationOnlineFormSourceControl("consent", "개인정보 수집 동의", true),
    ))

    @Test
    fun inspectsOwnedPreparationThroughMcpAndExistingDeterministicReview() {
        val form = javaClass.getResourceAsStream("/application-preparation/innovation-voucher-2026-v1.json")!!.use {
            jacksonObjectMapper().readValue(it, ApplicationFormManifest::class.java)
        }
        val draft = NewApplicationPreparation(form.sourceCode, form.sourceProgramId, form.formVersionId, form.supportedServiceFields.first())
        `when`(repository.findOwned(owner.id, 10)).thenReturn(StoredApplicationPreparation(10, owner.id, 3, ApplicationProgressStage.PREPARING, 2, now, draft, now, now))
        `when`(forms.requireVersion(form.formVersionId)).thenReturn(form)
        val reference = ApplicationOnlineFormSourceReference("https://docs.google.com/forms/d/e/public-id/viewform", "GOOGLE_FORMS")
        `when`(onlineMcp.inspect(reference.sourceUrl)).thenReturn(source)
        val result = service.inspectPublicOnlineForm(owner, 10, reference)
        assertEquals(1, result.mappedCount)
        assertEquals(source.formId, result.formId)
        assertFalse(result.fieldMappings.first().writable)
        verify(onlineMcp).inspect(reference.sourceUrl)
        verify(repository).findOwned(owner.id, 10)
        verify(forms).requireVersion(form.formVersionId)
        verifyNoInteractions(inputs, ai, contents, saved)
    }

    @Test
    fun realClientHttpContractCanConfirmOneManifestMapping() {
        val json = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
        val builder = RestClient.builder().baseUrl("http://ai.test")
            .messageConverters { it.clear(); it.add(JacksonJsonHttpMessageConverter(json)) }
        val http = MockRestServiceServer.bindTo(builder).build()
        val realClient = ApplicationOnlineFormMcpClient(builder.build(), "t".repeat(32), json, ApplicationOnlineFormMcpMapper())
        val connected = ApplicationPreparationService(repository, forms, inputs, ai, contents, saved, realClient, mock(SupportProgramRepository::class.java), PlanUsageTestHelper.allowAll(), PlanUsageTestHelper.noTransactions())
        val manifest = javaClass.getResourceAsStream("/application-preparation/innovation-voucher-2026-v1.json")!!.use {
            json.readValue(it, ApplicationFormManifest::class.java)
        }
        val draft = NewApplicationPreparation(manifest.sourceCode, manifest.sourceProgramId,
            manifest.formVersionId, manifest.supportedServiceFields.first())
        `when`(repository.findOwned(owner.id, 10)).thenReturn(
            StoredApplicationPreparation(10, owner.id, 3, ApplicationProgressStage.PREPARING, 2, now, draft, now, now))
        `when`(forms.requireVersion(manifest.formVersionId)).thenReturn(manifest)
        val reference = ApplicationOnlineFormSourceReference("https://docs.google.com/forms/d/e/public-id/viewform", "GOOGLE_FORMS")
        val response = mapOf(
            "contractVersion" to "google-public-form-reader-v2", "parserVersion" to "fb-public-load-data-v1",
            "sourceUrl" to reference.sourceUrl, "finalUrl" to reference.sourceUrl,
            "formTitle" to "합성 신청서", "semanticFingerprint" to "a".repeat(64),
            "questions" to listOf(mapOf("order" to 1, "controlId" to "gpub-v1:1:abcd", "entryId" to "101",
                "label" to "업체명", "description" to "", "required" to true, "kind" to "SHORT_TEXT",
                "options" to emptyList<String>(), "allowsOther" to false, "supported" to true, "unsupportedReason" to null)),
        )
        http.expect(requestTo("http://ai.test/internal/v1/application-preparations/online-form/inspect"))
            .andRespond(withSuccess(json.writeValueAsString(response), MediaType.APPLICATION_JSON))
        val result = connected.inspectPublicOnlineForm(owner, 10, reference)
        assertEquals(1, result.mappedCount)
        assertTrue(result.fieldMappings.first().mapped)
        assertEquals("gpub-v1:1:abcd", result.fieldMappings.first().bindings.single().referenceId)
        assertFalse(result.fieldMappings.first().writable)
        http.verify()
        verifyNoInteractions(inputs, ai, contents, saved)
    }

    @Test
    fun officialRouteThroughRealClientMapperReviewAndFactBuildsGuide() {
        val json = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
        val builder = RestClient.builder().baseUrl("http://ai.test")
            .messageConverters { it.clear(); it.add(JacksonJsonHttpMessageConverter(json)) }
        val http = MockRestServiceServer.bindTo(builder).build()
        val supportPrograms = mock(SupportProgramRepository::class.java)
        val realClient = ApplicationOnlineFormMcpClient(builder.build(), "t".repeat(32), json, ApplicationOnlineFormMcpMapper())
        val connected = ApplicationPreparationService(repository, forms, inputs, ai, contents, saved, realClient, supportPrograms, PlanUsageTestHelper.allowAll(), PlanUsageTestHelper.noTransactions())
        val manifest = javaClass.getResourceAsStream("/application-preparation/innovation-voucher-2026-v1.json")!!.use {
            json.readValue(it, ApplicationFormManifest::class.java)
        }
        val field = manifest.sections.flatMap { section ->
            section.fields.map { section.key to it }
        }.first { it.second.label == "업체명" }
        val draft = NewApplicationPreparation(manifest.sourceCode, manifest.sourceProgramId,
            manifest.formVersionId, manifest.supportedServiceFields.first())
        `when`(repository.findOwned(owner.id, 10)).thenReturn(
            StoredApplicationPreparation(10, owner.id, 3, ApplicationProgressStage.PREPARING, 2, now, draft, now, now))
        `when`(forms.requireVersion(manifest.formVersionId)).thenReturn(manifest)
        val url = "https://docs.google.com/forms/d/e/public-id/viewform"
        val catalog = SupportProgramTestHelper.catalogProgram(manifest.sourceProgramId)
        `when`(supportPrograms.findPresentBySourceAndProgramId(manifest.sourceCode, manifest.sourceProgramId))
            .thenReturn(catalog.copy(program = catalog.program.copy(applicationRoute =
                SupportProgramApplicationRoute("온라인", url, SupportProgramApplicationRouteType.GOOGLE_FORMS))))
        `when`(inputs.listOwnedFacts(owner.id, 10)).thenReturn(listOf(
            ConfirmedApplicationFact(10, field.first, field.second.key, ApplicationFactStatus.PROVIDED,
                "합성기업", "synthetic user input", 1, now)))
        val response = mapOf(
            "contractVersion" to "google-public-form-reader-v2", "parserVersion" to "fb-public-load-data-v1",
            "sourceUrl" to url, "finalUrl" to url, "formTitle" to "공개 신청서",
            "semanticFingerprint" to "a".repeat(64),
            "questions" to listOf(mapOf("order" to 1, "controlId" to "gpub-v1:1:abcd", "entryId" to "101",
                "label" to "업체명", "description" to "", "required" to true, "kind" to "SHORT_TEXT",
                "options" to emptyList<String>(), "allowsOther" to false, "supported" to true, "unsupportedReason" to null)),
        )
        http.expect(requestTo("http://ai.test/internal/v1/application-preparations/online-form/inspect"))
            .andRespond(withSuccess(json.writeValueAsString(response), MediaType.APPLICATION_JSON))
        val guide = connected.onlineInputGuide(owner, 10)
        assertEquals(1, guide.totalCount)
        assertEquals(url, guide.officialApplicationUrl)
        assertEquals("gpub-v1:1:abcd", guide.items.single().sourceControlId)
        assertEquals("${field.first}:${field.second.key}", guide.items.single().fieldId)
        assertEquals(ApplicationOnlineInputGuideStatus.READY, guide.items.single().status)
        assertEquals("합성기업", guide.savedAnswers.single().answer)
        assertFalse(guide.externalMappingVerified) // 나머지 필수 Manifest 문항이 없어 review issue가 남는다.
        http.verify()
    }

    @Test
    fun googleMcpFailureIsNotReplacedByManifestGuide() {
        val manifest = javaClass.getResourceAsStream("/application-preparation/innovation-voucher-2026-v1.json")!!.use {
            jacksonObjectMapper().readValue(it, ApplicationFormManifest::class.java)
        }
        val supportPrograms = mock(SupportProgramRepository::class.java)
        val connected = ApplicationPreparationService(repository, forms, inputs, ai, contents, saved, onlineMcp, supportPrograms, PlanUsageTestHelper.allowAll(), PlanUsageTestHelper.noTransactions())
        val draft = NewApplicationPreparation(manifest.sourceCode, manifest.sourceProgramId,
            manifest.formVersionId, manifest.supportedServiceFields.first())
        `when`(repository.findOwned(owner.id, 10)).thenReturn(
            StoredApplicationPreparation(10, owner.id, 3, ApplicationProgressStage.PREPARING, 2, now, draft, now, now))
        `when`(forms.requireVersion(manifest.formVersionId)).thenReturn(manifest)
        val url = "https://docs.google.com/forms/d/e/public-id/viewform"
        val catalog = SupportProgramTestHelper.catalogProgram(manifest.sourceProgramId)
        `when`(supportPrograms.findPresentBySourceAndProgramId(manifest.sourceCode, manifest.sourceProgramId))
            .thenReturn(catalog.copy(program = catalog.program.copy(applicationRoute =
                SupportProgramApplicationRoute("온라인", url, SupportProgramApplicationRouteType.GOOGLE_FORMS))))
        `when`(inputs.listOwnedFacts(owner.id, 10)).thenReturn(emptyList())
        `when`(onlineMcp.inspect(url)).thenThrow(ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_SOURCE_UNAVAILABLE"))
        assertEquals("APPLICATION_ONLINE_FORM_SOURCE_UNAVAILABLE",
            assertThrows(ApplicationOnlineFormMcpException::class.java) { connected.onlineInputGuide(owner, 10) }.code)
        verify(onlineMcp).inspect(url)
    }

    @Test
    fun classifiesReferencesWithoutMutationOrAiCalls() {
        val form = javaClass.getResourceAsStream("/application-preparation/innovation-voucher-2026-v1.json")!!.use {
            jacksonObjectMapper().readValue(it, ApplicationFormManifest::class.java)
        }
        val draft = NewApplicationPreparation(form.sourceCode, form.sourceProgramId, form.formVersionId, form.supportedServiceFields.first())
        val preparation = StoredApplicationPreparation(10, owner.id, 3, ApplicationProgressStage.PREPARING, 2, now, draft, now, now)
        val before = preparation.copy()
        val manifestBefore = jacksonObjectMapper().writeValueAsString(form)
        `when`(repository.findOwned(owner.id, 10)).thenReturn(preparation)
        `when`(forms.requireVersion(form.formVersionId)).thenReturn(form)
        val publicCandidates = listOf(
            "https://docs.google.com/forms/d/e/published-id/viewform?usp=sf_link",
            "https://docs.google.com/forms/u/0/d/form-id/viewform",
            "https://forms.gle/shortId",
        ).map { ApplicationOnlineFormSourceReference(it, "GOOGLE_FORMS") }
        val edit = ApplicationOnlineFormSourceReference("https://docs.google.com/forms/d/form-id/edit", "GOOGLE_FORMS")
        val unsupported = listOf(
            ApplicationOnlineFormSourceReference("https://example.com/form", "PUBLIC_HTML_FORM"),
            ApplicationOnlineFormSourceReference("https://docs.google.com/forms/d/id/edit", "UNKNOWN"),
        ) + listOf(
            "https://docs.google.com.evil.example/forms/d/id/edit",
            "https://evil.example/forms/d/id/edit",
            "https://docs.google.com/document/d/id/edit",
            "https://docs.google.com/forms/d/id/formResponse",
            "https://forms.gle/",
            "https://localhost/form", "https://127.0.0.1/form", "https://10.0.0.1/form",
            "https://172.16.0.1/form", "https://172.31.0.1/form", "https://192.168.0.1/form",
            "https://[::1]/form", "https://169.254.169.254/form",
        ).map { ApplicationOnlineFormSourceReference(it, "GOOGLE_FORMS") }
        publicCandidates.forEach { reference ->
            repeat(2) {
                assertEquals(ApplicationOnlineFormSourceCapabilityStatus.PUBLIC_READ_SUPPORTED,
                    service.checkOnlineFormSourceCapability(owner, 10, reference).status)
            }
        }
        assertEquals(ApplicationOnlineFormSourceCapabilityStatus.REQUIRES_AUTH,
            service.checkOnlineFormSourceCapability(owner, 10, edit).status)
        unsupported.forEach {
            assertEquals(ApplicationOnlineFormSourceCapabilityStatus.UNSUPPORTED_PROVIDER,
                service.checkOnlineFormSourceCapability(owner, 10, it).status)
        }
        assertEquals(before, preparation)
        assertEquals(manifestBefore, jacksonObjectMapper().writeValueAsString(form))
        verify(repository, times(publicCandidates.size * 2 + 1 + unsupported.size)).findOwned(owner.id, 10)
        verify(forms, times(publicCandidates.size * 2 + 1 + unsupported.size)).requireVersion(form.formVersionId)
        verifyNoMoreInteractions(repository, forms)
        verifyNoInteractions(inputs, ai, contents, saved, onlineMcp)
    }

    @Test
    fun capabilityChecksOwnershipBeforeManifestAndClassification() {
        val reference = ApplicationOnlineFormSourceReference("https://docs.google.com/forms/d/id/edit", "GOOGLE_FORMS")
        listOf(owner, owner.copy(id = 2, email = "other@example.com")).forEach {
            assertThrows(ApplicationPreparationNotFoundException::class.java) {
                service.checkOnlineFormSourceCapability(it, 10, reference)
            }
            verify(repository).findOwned(it.id, 10)
        }
        verifyNoMoreInteractions(repository)
        verifyNoInteractions(forms, inputs, ai, contents, saved)
    }

    @Test
    fun usesPinnedManifestAndReturnsCountsWithoutWritingOrCallingAi() {
        val form = javaClass.getResourceAsStream("/application-preparation/innovation-voucher-2026-v1.json")!!.use {
            jacksonObjectMapper().readValue(it, ApplicationFormManifest::class.java)
        }
        val draft = NewApplicationPreparation(form.sourceCode, form.sourceProgramId, form.formVersionId, form.supportedServiceFields.first())
        `when`(repository.findOwned(owner.id, 10)).thenReturn(StoredApplicationPreparation(10, owner.id, 3, ApplicationProgressStage.PREPARING, 2, now, draft, now, now))
        `when`(forms.requireVersion(form.formVersionId)).thenReturn(form)
        val result = service.reviewOnlineFormMapping(owner, 10, source)
        val count = form.sections.sumOf { it.fields.size }
        assertEquals(source.formId, result.formId)
        assertEquals(source.formTitle, result.formTitle)
        assertEquals(1, result.mappedCount)
        assertEquals(count - 1, result.unmappedCount)
        assertEquals(count - 1, result.requiredMissingCount)
        assertEquals(count, result.reviewRequiredCount)
        assertTrue(result.fieldMappings.first().mapped)
        assertFalse(result.fieldMappings.first().writable)
        assertFalse(result.fieldMappings.first().autoFillSupported)
        verify(repository).findOwned(owner.id, 10)
        verify(forms).requireVersion(form.formVersionId)
        verifyNoMoreInteractions(repository, forms)
        verifyNoInteractions(inputs, ai, contents, saved)
    }

    @Test
    fun absentOrOtherOwnersPreparationIsNotFoundBeforeManifestLookup() {
        listOf(owner, owner.copy(id = 2, email = "other@example.com")).forEach {
            assertThrows(ApplicationPreparationNotFoundException::class.java) { service.reviewOnlineFormMapping(it, 10, source) }
            verify(repository).findOwned(it.id, 10)
        }
        verifyNoMoreInteractions(repository)
        verifyNoInteractions(forms, inputs, ai, contents, saved)
    }
}
