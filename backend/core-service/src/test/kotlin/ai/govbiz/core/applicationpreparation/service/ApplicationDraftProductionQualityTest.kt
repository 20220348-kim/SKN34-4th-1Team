package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.applicationpreparation.client.ai.ApplicationOnlineFormMcpClient
import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRevisionConflictException
import ai.govbiz.core.applicationpreparation.facade.AiApplicationPreparationFacade
import ai.govbiz.core.applicationpreparation.repository.*
import ai.govbiz.core.planusage.PlanUsageTestHelper
import ai.govbiz.core.supportprogram.client.ops.ProductionQualityClient
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualityContextRequest
import ai.govbiz.core.supportprogram.repository.SavedSupportProgramRepository
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import tools.jackson.module.kotlin.jacksonObjectMapper

class ApplicationDraftProductionQualityTest {
    private val repository = mock(ApplicationPreparationRepository::class.java)
    private val forms = mock(ApplicationFormService::class.java)
    private val inputs = mock(ApplicationPreparationInputRepository::class.java)
    private val ai = mock(AiApplicationPreparationFacade::class.java)
    private val contents = mock(ApplicationPreparationContentRepository::class.java)
    private val quality = mock(ProductionQualityClient::class.java)
    private val service = ApplicationPreparationService(repository, forms, inputs, ai, contents,
        mock(SavedSupportProgramRepository::class.java), mock(ApplicationOnlineFormMcpClient::class.java),
        mock(SupportProgramRepository::class.java), PlanUsageTestHelper.allowAll(), PlanUsageTestHelper.noTransactions(), quality)
    private val now = LocalDateTime.of(2026, 10, 15, 12, 0)
    private val account = Account(1, "private@example.test", AccountRole.USER, null, null, now)
    private val manifest = javaClass.getResourceAsStream("/application-preparation/innovation-voucher-2026-v1.json")!!.use {
        jacksonObjectMapper().readValue(it, ApplicationFormManifest::class.java)
    }
    private val requestKey = "00000000-0000-4000-8000-000000000001"
    private val output = ApplicationDraftOutput("확인된 목표에 맞춰 자동화 설비를 개선한다.", "test-model", "test-prompt", emptyList())

    private fun prepare(sectionKey: String = "voucher-plan", completed: Boolean = false, applied: Boolean = true): ApplicationDraftInput {
        val draft = NewApplicationPreparation(manifest.sourceCode, manifest.sourceProgramId, manifest.formVersionId,
            manifest.supportedServiceFields.first())
        `when`(repository.findOwned(account.id, 10)).thenReturn(StoredApplicationPreparation(10, account.id, 1,
            ApplicationProgressStage.PREPARING, 1, now, draft, now, now))
        `when`(forms.requireVersion(manifest.formVersionId)).thenReturn(manifest)
        val section = manifest.sections.first { it.key == sectionKey }
        val facts = section.fields.mapIndexed { index, field ->
            ConfirmedApplicationFact(index + 1L, sectionKey, field.key, ApplicationFactStatus.PROVIDED,
                "확인된 ${field.label}", "not-collected-original-source", 1, now)
        }
        `when`(inputs.listOwnedFacts(account.id, 10)).thenReturn(facts)
        `when`(contents.listOwned(account.id, 10)).thenReturn(emptyList())
        val input = ApplicationDraftInput(10, 1, manifest.formVersionId, draft.serviceField.name, section,
            ApplicationContentVersion.snapshot(facts))
        `when`(contents.reserve(account.id, input, null, requestKey)).thenReturn(ApplicationDraftReservation(20, completed, applied))
        `when`(ai.draft(input)).thenReturn(output)
        `when`(contents.complete(account.id, 20, input, null, output)).thenReturn(applied)
        return input
    }

    @Test
    fun samplesActualDraftOnlyAfterSuccessfulSaveWithAllowlistedInputs() {
        val input = prepare()
        service.generateDraft(account, 10, input.section.key, 1, null, requestKey)
        val invocation = mockingDetails(quality).invocations.single { it.method.name == "recordOperation" }
        assertEquals("application-document-generation", invocation.getArgument<String>(0))
        assertTrue(invocation.getArgument<String>(1).contains(input.section.title))
        val contexts = invocation.getArgument<List<ProductionQualityContextRequest>>(2)
        assertEquals(input.section.fields.map { it.key }, contexts.map { it.id })
        assertTrue(contexts.all { it.text.contains("사용자가 확인한 값:") })
        val material = contexts.joinToString() + invocation.getArgument<String>(3)
        assertFalse(material.contains(account.email))
        assertFalse(material.contains("not-collected-original-source"))
        assertFalse(material.contains(manifest.sourceUrl))
        assertTrue(invocation.getArgument<String>(3).contains(output.content))
        assertEquals("${manifest.sourceCode}:${manifest.sourceProgramId}", invocation.getArgument<String>(6))
        assertTrue(mockingDetails(contents).invocations.first { it.method.name == "complete" }.sequenceNumber < invocation.sequenceNumber)
    }

    @Test
    fun reusingCompletedRequestDoesNotCallModelOrSampleAgain() {
        val input = prepare(completed = true)
        repeat(2) { service.generateDraft(account, 10, input.section.key, 1, null, requestKey) }
        verifyNoInteractions(ai, quality)
    }

    @Test
    fun revisionConflictDoesNotCollectUnappliedDraft() {
        val input = prepare(applied = false)
        assertThrows(ApplicationPreparationRevisionConflictException::class.java) {
            service.generateDraft(account, 10, input.section.key, 1, null, requestKey)
        }
        verifyNoInteractions(quality)
    }

    @Test
    fun skipsWholeDraftForIdentityOrContactFields() {
        val input = prepare(sectionKey = "company-overview")
        service.generateDraft(account, 10, input.section.key, 1, null, requestKey)
        verify(contents).complete(account.id, 20, input, null, output)
        verifyNoInteractions(quality)
    }

    @Test
    fun sampleFailureDoesNotFailSavedDraft() {
        val input = prepare()
        doThrow(IllegalStateException("collector unavailable")).`when`(quality).recordOperation(
            anyString(), anyString(), anyList(), anyString(), anyString(), isNull(), anyString())
        assertDoesNotThrow { service.generateDraft(account, 10, input.section.key, 1, null, requestKey) }
        verify(contents, never()).fail(20)
    }

    @Test
    fun modelFailureAndReadOnlyReloadDoNotCreateSamples() {
        val input = prepare()
        `when`(ai.draft(input)).thenThrow(IllegalStateException("model failed"))
        assertThrows(IllegalStateException::class.java) {
            service.generateDraft(account, 10, input.section.key, 1, null, requestKey)
        }
        service.findOwned(account, 10)
        verify(contents).fail(20)
        verifyNoInteractions(quality)
    }
}
