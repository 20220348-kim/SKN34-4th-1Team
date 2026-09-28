package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.applicationpreparation.client.ai.ApplicationOnlineFormMcpClient
import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.facade.AiApplicationPreparationFacade
import ai.govbiz.core.applicationpreparation.repository.*
import ai.govbiz.core.applicationpreparation.service.dto.*
import ai.govbiz.core.supportprogram.repository.SavedSupportProgramRepository
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramApplicationRoute
import ai.govbiz.core.supportprogram.domain.SupportProgramApplicationRouteType
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import tools.jackson.module.kotlin.jacksonObjectMapper

class ApplicationOnlineInputGuideTest {
    private val now = LocalDateTime.of(2026, 9, 28, 10, 0)
    private val original = javaClass.getResourceAsStream("/application-preparation/innovation-voucher-2026-v1.json")!!.use {
        jacksonObjectMapper().readValue(it, ApplicationFormManifest::class.java)
    }
    private val manifest = original.copy(sections = listOf(ApplicationFormSectionDefinition("company", "기업", "공식 위치", "설명", listOf(
        ApplicationFormFieldDefinition("name", "기업명", "확정값", true),
        ApplicationFormFieldDefinition("industry", "업종", "공식 선택지", true, listOf("정보통신업", "제조업")),
        ApplicationFormFieldDefinition("plan", "사업계획", "입력", true),
    ))))
    private fun fact(key: String, value: String?, status: ApplicationFactStatus = ApplicationFactStatus.PROVIDED) =
        ConfirmedApplicationFact(1, "company", key, status, value, "synthetic user input", 1, now)

    @Test fun providedTextAndValidChoiceAreReadyWithoutExternalMapping() {
        val result = ApplicationOnlineInputGuideResult.from(10, 3, manifest, listOf(
            fact("name", "합성테크"), fact("industry", "정보통신업"), fact("plan", null, ApplicationFactStatus.UNKNOWN),
            fact("not-in-manifest", "제외"),
        ))
        assertEquals(3, result.totalCount)
        assertEquals(2, result.readyCount)
        assertEquals(0, result.needsReviewCount)
        assertEquals(1, result.missingCount)
        assertEquals(0, result.directInputCount)
        assertEquals(listOf("합성테크", "정보통신업"), result.savedAnswers.map { it.answer })
        assertTrue(result.items.all { it.inputMode == "UNKNOWN" })
        assertFalse(result.externalMappingVerified)
        assertTrue(result.items.take(2).all { it.status == ApplicationOnlineInputGuideStatus.READY && it.copyable })
        assertFalse(result.items.last().copyable)
        assertEquals(result.savedAnswers.map { it.fieldId }, result.items.filter { it.status == ApplicationOnlineInputGuideStatus.READY }.map { it.fieldId })
        assertNull(result.items.last().answer)
    }

    @Test fun invalidChoiceIsReviewRequiredAndExcludedFromExport() {
        val result = ApplicationOnlineInputGuideResult.from(10, 3, manifest, listOf(fact("industry", "AI\nSaaS")))
        assertEquals(ApplicationOnlineInputGuideStatus.NEEDS_REVIEW, result.items[1].status)
        assertFalse(result.items[1].copyable)
        assertEquals(1, result.needsReviewCount)
        assertEquals(2, result.missingCount)
        assertTrue(result.savedAnswers.isEmpty())
    }

    @Test fun googleQuestionsKeepSourceOrderAndSafeAnswerStatuses() {
        val source = ApplicationOnlineFormSource(1, "form", "신청서", listOf(
            ApplicationOnlineFormSourceControl("choice", "업종", true, ApplicationOnlineFormSourceKind.SINGLE_CHOICE, listOf("제조업", "정보통신업")),
            ApplicationOnlineFormSourceControl("name", "기업명", true),
            ApplicationOnlineFormSourceControl("other", "외부 추가 질문", true),
            ApplicationOnlineFormSourceControl("multi", "사업계획", true, ApplicationOnlineFormSourceKind.MULTI_CHOICE, listOf("A", "B")),
        ))
        val url = "https://docs.google.com/forms/d/e/public-id/viewform"
        val result = ApplicationOnlineInputGuideResult.fromSource(10, 3, manifest,
            listOf(fact("industry", "정보통신업"), fact("name", "합성테크"), fact("plan", "A")), source, url)
        assertEquals(listOf("choice", "name", "other", "multi"), result.items.map { it.sourceControlId })
        assertEquals(listOf(ApplicationOnlineInputGuideStatus.READY, ApplicationOnlineInputGuideStatus.READY,
            ApplicationOnlineInputGuideStatus.DIRECT_INPUT, ApplicationOnlineInputGuideStatus.DIRECT_INPUT),
            result.items.map { it.status })
        assertEquals(listOf("업종", "기업명"), result.savedAnswers.map { it.label })
        assertNull(result.items[2].fieldId)
        assertEquals(url, result.officialApplicationUrl)
        assertFalse(result.externalMappingVerified)
        assertEquals(4, result.totalCount)
        assertEquals(2, result.readyCount)
    }

    @Test fun choiceOutsideOptionsRequiresReviewAndMissingFactStaysMissing() {
        val source = ApplicationOnlineFormSource(1, "form", "신청서", listOf(
            ApplicationOnlineFormSourceControl("choice", "업종", true, ApplicationOnlineFormSourceKind.DROPDOWN, listOf("제조업")),
            ApplicationOnlineFormSourceControl("name", "기업명", true),
        ))
        val result = ApplicationOnlineInputGuideResult.fromSource(10, 3, manifest,
            listOf(fact("industry", "정보통신업")), source, "https://docs.google.com/forms/d/e/id/viewform")
        assertEquals(listOf(ApplicationOnlineInputGuideStatus.NEEDS_REVIEW, ApplicationOnlineInputGuideStatus.MISSING),
            result.items.map { it.status })
        assertTrue(result.savedAnswers.isEmpty())
    }

    @Test fun completeExactReviewIsVerifiedButRequiredMismatchNeedsReview() {
        val controls = listOf(
            ApplicationOnlineFormSourceControl("name", "기업명", true),
            ApplicationOnlineFormSourceControl("industry", "업종", true, ApplicationOnlineFormSourceKind.SINGLE_CHOICE, listOf("제조업")),
            ApplicationOnlineFormSourceControl("plan", "사업계획", true),
        )
        val url = "https://docs.google.com/forms/d/e/id/viewform"
        val exact = ApplicationOnlineInputGuideResult.fromSource(10, 3, manifest, emptyList(),
            ApplicationOnlineFormSource(1, "form", "신청서", controls), url)
        assertTrue(exact.externalMappingVerified)
        assertEquals(3, exact.missingCount)
        val mismatch = ApplicationOnlineInputGuideResult.fromSource(10, 3, manifest, emptyList(),
            ApplicationOnlineFormSource(1, "form", "신청서",
                controls.map { if (it.controlId == "name") it.copy(required = false) else it }), url)
        assertFalse(mismatch.externalMappingVerified)
        assertEquals(ApplicationOnlineInputGuideStatus.NEEDS_REVIEW, mismatch.items.first().status)
    }

    @Test fun syntheticFixtureCountsAndControllerContractMatchReadyAnswers() {
        val json = jacksonObjectMapper()
        val fixture = json.readTree(java.io.File("../../evaluation/application-map/fixtures/synthetic-online-input-guide-v1.json"))
        val fields = fixture.path("items").toList().map { item ->
            ApplicationFormFieldDefinition(item.path("fieldId").asText().substringAfter(":"), item.path("label").asText(), "합성 입력", item.path("required").asBoolean(), item.path("options").toList().map { it.asText() })
        }
        val synthetic = original.copy(sections = listOf(ApplicationFormSectionDefinition("synthetic", "합성", "공식 위치", "설명", fields)))
        val facts = fixture.path("items").toList().filter { !it.path("answer").isNull }.map { item ->
            fact(item.path("fieldId").asText().substringAfter(":"), item.path("answer").asText()).copy(sectionKey = "synthetic")
        }
        val result = ApplicationOnlineInputGuideResult.from(30, 1, synthetic, facts)
        assertEquals(listOf(8, 5, 1, 2, 0), listOf(result.totalCount, result.readyCount, result.needsReviewCount, result.missingCount, result.directInputCount))
        assertEquals(result.items.filter { it.copyable }.map { it.fieldId }, result.savedAnswers.map { it.fieldId })
        val response = ai.govbiz.core.applicationpreparation.controller.dto.ApplicationOnlineInputGuideResponse.from(result)
        val body = json.readTree(json.writeValueAsString(response))
        assertEquals(5, body.path("readyCount").asInt())
        assertFalse(body.path("externalMappingVerified").asBoolean())
        assertTrue(body.path("officialApplicationUrl").isNull)
        assertEquals("READY", body.path("items")[0].path("status").asText())
        assertTrue(body.path("items")[0].path("copyable").asBoolean())
        assertEquals("UNKNOWN", body.path("items")[0].path("inputMode").asText())
    }

    @Test fun ownershipIsCheckedBeforeReadingFactsAndGuideHasNoWriteOrAiCalls() {
        val repository = mock(ApplicationPreparationRepository::class.java)
        val forms = mock(ApplicationFormService::class.java)
        val inputs = mock(ApplicationPreparationInputRepository::class.java)
        val ai = mock(AiApplicationPreparationFacade::class.java)
        val contents = mock(ApplicationPreparationContentRepository::class.java)
        val saved = mock(SavedSupportProgramRepository::class.java)
        val supportPrograms = mock(SupportProgramRepository::class.java)
        val service = ApplicationPreparationService(repository, forms, inputs, ai, contents, saved, mock(ApplicationOnlineFormMcpClient::class.java), supportPrograms)
        val owner = Account(1, "synthetic@example.test", AccountRole.USER, null, null, now)
        val preparation = StoredApplicationPreparation(10, 1, 3, ApplicationProgressStage.PREPARING, 1, now,
            NewApplicationPreparation(manifest.sourceCode, manifest.sourceProgramId, manifest.formVersionId, manifest.supportedServiceFields.first()), now, now)
        `when`(repository.findOwned(1, 10)).thenReturn(preparation)
        `when`(forms.requireVersion(manifest.formVersionId)).thenReturn(manifest)
        `when`(inputs.listOwnedFacts(1, 10)).thenReturn(listOf(fact("name", "합성테크")))
        assertEquals("합성테크", service.onlineInputGuide(owner, 10).savedAnswers.single().answer)
        assertThrows(ApplicationPreparationNotFoundException::class.java) { service.onlineInputGuide(owner.copy(id = 2), 10) }
        assertThrows(ApplicationPreparationNotFoundException::class.java) { service.onlineInputGuide(owner, 999) }
        verify(repository).findOwned(1, 10)
        verify(repository).findOwned(2, 10)
        verify(repository).findOwned(1, 999)
        verify(forms).requireVersion(manifest.formVersionId)
        verify(inputs).listOwnedFacts(1, 10)
        verify(supportPrograms).findPresentBySourceAndProgramId(manifest.sourceCode, manifest.sourceProgramId)
        verifyNoMoreInteractions(repository, forms, inputs, supportPrograms)
        verifyNoInteractions(ai, contents, saved)
        assertEquals(3, preparation.inputRevision)
    }

    @Test fun officialGoogleRouteRunsMcpAndBuildsGuideFromActualQuestions() {
        val repository = mock(ApplicationPreparationRepository::class.java)
        val forms = mock(ApplicationFormService::class.java)
        val inputs = mock(ApplicationPreparationInputRepository::class.java)
        val ai = mock(AiApplicationPreparationFacade::class.java)
        val contents = mock(ApplicationPreparationContentRepository::class.java)
        val saved = mock(SavedSupportProgramRepository::class.java)
        val supportPrograms = mock(SupportProgramRepository::class.java)
        val mcp = mock(ApplicationOnlineFormMcpClient::class.java)
        val service = ApplicationPreparationService(repository, forms, inputs, ai, contents, saved, mcp, supportPrograms)
        val owner = Account(1, "synthetic@example.test", AccountRole.USER, null, null, now)
        val preparation = StoredApplicationPreparation(10, 1, 3, ApplicationProgressStage.PREPARING, 1, now,
            NewApplicationPreparation(manifest.sourceCode, manifest.sourceProgramId, manifest.formVersionId, manifest.supportedServiceFields.first()), now, now)
        val url = "https://docs.google.com/forms/d/e/public-id/viewform"
        val program = SupportProgram(manifest.sourceProgramId, manifest.sourceCode, "공고", "기관", "요약",
            emptyList(), emptyList(), "대상", "기간", null, null, SupportProgramStatus.UNKNOWN,
            "기업마당", "https://www.bizinfo.go.kr/notice", emptyList(),
            applicationRoute = SupportProgramApplicationRoute("온라인", url, SupportProgramApplicationRouteType.GOOGLE_FORMS))
        `when`(repository.findOwned(1, 10)).thenReturn(preparation)
        `when`(forms.requireVersion(manifest.formVersionId)).thenReturn(manifest)
        `when`(supportPrograms.findPresentBySourceAndProgramId(manifest.sourceCode, manifest.sourceProgramId))
            .thenReturn(CatalogSupportProgram(program, ""))
        `when`(inputs.listOwnedFacts(1, 10)).thenReturn(listOf(fact("name", "합성테크")))
        `when`(mcp.inspect(url)).thenReturn(ApplicationOnlineFormSource(1, "form", "신청서",
            listOf(ApplicationOnlineFormSourceControl("name", "기업명", true))))
        val guide = service.onlineInputGuide(owner, 10)
        assertEquals(url, guide.officialApplicationUrl)
        assertEquals(1, guide.totalCount)
        assertEquals("합성테크", guide.savedAnswers.single().answer)
        assertFalse(guide.externalMappingVerified) // 나머지 필수 Manifest 문항은 발견되지 않음
        verify(mcp).inspect(url)
    }
}
