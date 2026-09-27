package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.facade.AiApplicationPreparationFacade
import ai.govbiz.core.applicationpreparation.repository.*
import ai.govbiz.core.supportprogram.repository.SavedSupportProgramRepository
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationOnlineFormSourceCapabilityStatus
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import tools.jackson.module.kotlin.jacksonObjectMapper

class ApplicationPreparationServiceOnlineFormTest {
    private val repository = mock(ApplicationPreparationRepository::class.java)
    private val forms = mock(ApplicationFormService::class.java)
    private val inputs = mock(ApplicationPreparationInputRepository::class.java)
    private val ai = mock(AiApplicationPreparationFacade::class.java)
    private val contents = mock(ApplicationPreparationContentRepository::class.java)
    private val saved = mock(SavedSupportProgramRepository::class.java)
    private val service = ApplicationPreparationService(repository, forms, inputs, ai, contents, saved)
    private val now = LocalDateTime.of(2026, 9, 27, 12, 0)
    private val owner = Account(1, "owner@example.com", AccountRole.USER, null, null, now)
    private val source = ApplicationOnlineFormSource(1, "review-form", "검토 신청서", listOf(
        ApplicationOnlineFormSourceControl("name", "업체명", true),
        ApplicationOnlineFormSourceControl("consent", "개인정보 수집 동의", true),
    ))

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
        val google = listOf(
            "https://docs.google.com/forms/d/form-id/edit",
            "https://docs.google.com/forms/d/e/published-id/viewform?usp=sf_link",
            "https://docs.google.com/forms/u/0/d/form-id/viewform",
            "https://forms.gle/shortId",
        ).map { ApplicationOnlineFormSourceReference(it, "GOOGLE_FORMS") }
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
        google.forEach { reference ->
            repeat(2) {
                assertEquals(ApplicationOnlineFormSourceCapabilityStatus.REQUIRES_AUTH,
                    service.checkOnlineFormSourceCapability(owner, 10, reference).status)
            }
        }
        unsupported.forEach {
            assertEquals(ApplicationOnlineFormSourceCapabilityStatus.UNSUPPORTED_PROVIDER,
                service.checkOnlineFormSourceCapability(owner, 10, it).status)
        }
        assertEquals(before, preparation)
        assertEquals(manifestBefore, jacksonObjectMapper().writeValueAsString(form))
        verify(repository, times(google.size * 2 + unsupported.size)).findOwned(owner.id, 10)
        verify(forms, times(google.size * 2 + unsupported.size)).requireVersion(form.formVersionId)
        verifyNoMoreInteractions(repository, forms)
        verifyNoInteractions(inputs, ai, contents, saved)
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
