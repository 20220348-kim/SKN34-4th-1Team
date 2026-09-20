package ai.govbiz.core.supportprogram.service.conversation

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramConversationClient
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationCompanyConditionsRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationContextRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationUpdatePayload
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationContext
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationField
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationLastSearch
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramPendingClarification
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.mockito.Mockito

class SupportProgramConversationServiceTest {
    private val client = Mockito.mock(AiSupportProgramConversationClient::class.java)
    private val clock = Clock.fixed(Instant.parse("2026-09-06T15:00:00Z"), ZoneId.of("Asia/Seoul"))
    private val service = SupportProgramConversationService(client, clock)
    private val context = SupportProgramConversationContext(
        "사업화 지원", false, SupportProgramCompanyConditions("서울", "SW", LocalDate.parse("2024-02-29"), "사업화"),
    )
    private var sent: AiSupportProgramConversationRequest? = null
    private val matcherFallback = AiSupportProgramConversationRequest(
        SupportProgramConversationService.SCHEMA_VERSION, "2026-09-07", "부산",
        AiSupportProgramConversationContextRequest(null, true, AiSupportProgramConversationCompanyConditionsRequest(null, null, null, null)), null,
    )

    // Java Mockito matchers return null; supply a value only for Kotlin's non-null argument check.
    private fun anyRequest() = Mockito.any(AiSupportProgramConversationRequest::class.java) ?: matcherFallback

    private fun response(
        updates: List<AiSupportProgramConversationUpdatePayload?>? = emptyList(),
        status: String? = "READY",
        question: String? = null,
        version: String? = SupportProgramConversationService.SCHEMA_VERSION,
        answer: String? = null,
    ) = AiSupportProgramConversationPayload(version, status, updates, question, answer)

    private fun update(field: String = "REGION", value: String? = "부산", evidence: String? = "부산", operation: String? = "SET") =
        AiSupportProgramConversationUpdatePayload(field, operation, value, evidence)

    private fun stub(payload: AiSupportProgramConversationPayload) {
        Mockito.doAnswer { sent = it.getArgument(0); payload }.`when`(client).interpret(anyRequest())
    }

    private fun rejects(payload: AiSupportProgramConversationPayload, message: String = "부산으로 변경", initial: SupportProgramConversationContext = context) {
        stub(payload)
        val error = assertThrows(AiServiceCallException::class.java) { service.interpret(message, initial, null) }
        assertEquals(AiServiceFailure.INVALID_RESPONSE, error.failure)
    }

    @Test
    fun preservesRegisteredYearAcrossRegionChangeAndAllowsExplicitYearOrDateReplacement() {
        val initial = context.copy(companyConditions = context.companyConditions.copy(establishedOn = null, foundedYear = 2021))
        stub(response(listOf(update())))
        val retained = service.interpret("부산으로 변경", initial, null)
        assertEquals(2021, retained.proposedContext.companyConditions.foundedYear)
        assertEquals(2021, sent!!.context.companyConditions.foundedYear)
        assertNull(retained.proposedContext.companyConditions.establishedOn)

        stub(response(listOf(update(field = "FOUNDED_YEAR", value = "2022", evidence = "2022년"))))
        val changed = service.interpret("2022년 설립", initial, null)
        assertEquals(2022, changed.proposedContext.companyConditions.foundedYear)
        assertNull(changed.proposedContext.companyConditions.establishedOn)

        stub(response(listOf(update(field = "ESTABLISHED_ON", value = "2021-06-01", evidence = "2021-06-01"))))
        val precise = service.interpret("설립일은 2021-06-01", initial, null)
        assertNull(precise.proposedContext.companyConditions.foundedYear)
        assertEquals(LocalDate.parse("2021-06-01"), precise.proposedContext.companyConditions.establishedOn)

        stub(response(listOf(update(field = "FOUNDED_YEAR", value = null, evidence = "설립 조건 해제", operation = "CLEAR"))))
        val cleared = service.interpret("설립 조건 해제", initial, null)
        assertNull(cleared.proposedContext.companyConditions.foundedYear)
        assertNull(cleared.proposedContext.companyConditions.establishedOn)
    }

    @Test
    fun rejectsFutureAndFabricatedFoundationYears() {
        rejects(response(listOf(update(field = "FOUNDED_YEAR", value = "2027", evidence = "2027년"))), "2027년 설립")
        rejects(response(listOf(update(field = "FOUNDED_YEAR", value = "2021", evidence = "설립 5년"))), "설립 5년")
    }

    @Test
    fun updatesPendingProposalWithoutRevertingItsTradeIntentOrApplyingLastSearchConditions() {
        val proposal = context.copy(query = "무역 지원", companyConditions = context.companyConditions.copy(supportPurpose = "수출"))
        val lastSearch = SupportProgramConversationLastSearch(context, 0)
        stub(response(listOf(update(value = "대구", evidence = "대구"))))
        val result = service.interpret("대구로 찾아봐", context, null, proposal, lastSearch)
        assertEquals(proposal.copy(companyConditions = proposal.companyConditions.copy(region = "대구")), result.proposedContext)
        assertEquals(listOf(SupportProgramConversationField.QUERY, SupportProgramConversationField.REGION, SupportProgramConversationField.SUPPORT_PURPOSE), result.changedFields)
        assertEquals("무역 지원", sent!!.pendingProposal!!.query)
        assertEquals("사업화 지원", sent!!.lastSearch!!.context.query)
        assertEquals(0, sent!!.lastSearch!!.resultCount)
        assertNull(sent!!.pendingClarification)
    }

    @Test
    fun answersUsingLastSearchSummaryWithoutChangingConfirmedConditionsOrRequiringAQuery() {
        val initial = context.copy(query = null)
        val lastSearch = SupportProgramConversationLastSearch(context, 0)
        val answer = "직전 검색 결과는 0건입니다.\n지역 조건을 바꾸어 볼 수 있습니다."
        stub(response(status = "ANSWERED", answer = answer))
        val result = service.interpret("왜 못찾아?", initial, null, lastSearch = lastSearch)
        assertEquals(SupportProgramConversationStatus.ANSWERED, result.status)
        assertEquals(initial, result.proposedContext)
        assertEquals(emptyList<SupportProgramConversationField>(), result.changedFields)
        assertEquals(answer, result.answer)
        assertNull(result.clarificationQuestion)
        assertEquals(context.query, sent!!.lastSearch!!.context.query)
        assertEquals(0, sent!!.lastSearch!!.resultCount)
        assertNull(sent!!.pendingProposal)
    }

    @Test
    fun answeredKeepsThePendingDraftAndComparesItAgainstConfirmedConditions() {
        val draft = context.copy(query = "무역 지원", companyConditions = context.companyConditions.copy(region = "대구"))
        for (clarifying in listOf(true, false)) {
            stub(response(status = "ANSWERED", answer = "현재 검토 중인 검색 의도는 무역 지원이고 지역은 대구입니다."))
            val result = service.interpret(
                "어떤 조건이야?", context,
                if (clarifying) SupportProgramPendingClarification("설립일을 알려 주세요.", draft) else null,
                if (clarifying) null else draft,
            )
            assertEquals(draft, result.proposedContext)
            assertEquals(listOf(SupportProgramConversationField.QUERY, SupportProgramConversationField.REGION), result.changedFields)
        }
    }

    @Test
    fun shortConfirmationMaySetTheQuestionRegionWithEvidenceFromTheCurrentMessage() {
        val pending = SupportProgramPendingClarification("대구를 현재 소재지로 설정할까요?", context)
        stub(response(listOf(update(value = "대구", evidence = "설정해"))))
        val result = service.interpret("설정해", context, pending)
        assertEquals("대구", result.proposedContext.companyConditions.region)
        assertEquals(context.query, result.proposedContext.query)
        assertEquals(listOf(SupportProgramConversationField.REGION), result.changedFields)
    }

    @Test
    fun rejectsTwoPendingStatesBeforeCallingTheAi() {
        assertThrows(IllegalArgumentException::class.java) {
            service.interpret("대구", context, SupportProgramPendingClarification("어느 지역인가요?", context), context)
        }
        Mockito.verifyNoInteractions(client)
    }

    @Test
    fun rejectsAnswerTextOutsideAnsweredStatusAndAnsweredConditionUpdatesOrQuestions() {
        rejects(response(answer = "설명"))
        rejects(response(status = "CLARIFICATION_REQUIRED", question = "어느 지역인가요?", answer = "설명"))
        rejects(response(listOf(update()), status = "ANSWERED", answer = "설명"))
        rejects(response(status = "ANSWERED", question = "어느 지역인가요?", answer = "설명"))
    }

    @Test
    fun validatesAnsweredTextInUtf16WhilePreservingAllowedLayout() {
        for (answer in listOf(null, "", " ", "\u00a0", "가".repeat(1001), "😀".repeat(501), "답\u0000", "답\u200b")) {
            rejects(response(status = "ANSWERED", answer = answer))
        }
        for (answer in listOf("가".repeat(1000), "😀".repeat(500), "첫 줄\n다음 줄\r\t설명")) {
            stub(response(status = "ANSWERED", answer = answer))
            assertEquals(answer, service.interpret("왜 못찾아?", context, null).answer)
        }
    }

    @Test
    fun changesOnlyTheMentionedRegionAndSendsOnlySmallCurrentStateWithSeoulReferenceDate() {
        stub(response(listOf(update())))
        val result = service.interpret("부산으로 변경", context, null)
        assertEquals(context.copy(companyConditions = context.companyConditions.copy(region = "부산")), result.proposedContext)
        assertEquals(listOf(SupportProgramConversationField.REGION), result.changedFields)
        assertEquals(SupportProgramConversationStatus.READY, result.status)
        assertNull(result.clarificationQuestion)
        assertEquals("서울", context.companyConditions.region)
        assertEquals("2026-09-07", sent!!.referenceDate)
        assertEquals("부산으로 변경", sent!!.message)
        assertEquals("2024-02-29", sent!!.context.companyConditions.establishedOn)
        assertEquals(false, sent!!.context.acceptingOnly)
        assertNull(sent!!.pendingClarification)
        Mockito.verify(client, Mockito.times(1)).interpret(sent!!)
    }

    @Test
    fun supportPurposeAndQueryChangesKeepAllOtherCompanyFields() {
        stub(response(listOf(update("SUPPORT_PURPOSE", "지원금", "지원금"), update("QUERY", "지원금 지원", "지원금"))))
        val result = service.interpret("지원금 위주", context, null)
        assertEquals(context.copy(query = "지원금 지원", companyConditions = context.companyConditions.copy(supportPurpose = "지원금")), result.proposedContext)
        assertEquals(listOf(SupportProgramConversationField.QUERY, SupportProgramConversationField.SUPPORT_PURPOSE), result.changedFields)
    }

    @Test
    fun mergesIntoPendingDraftButComputesChangesAgainstConfirmedContext() {
        val draft = context.copy(query = "시제품 지원", companyConditions = context.companyConditions.copy(region = "부산", establishedOn = null))
        val pending = SupportProgramPendingClarification("정확한 설립일은?", draft)
        stub(response(listOf(update("ESTABLISHED_ON", "2024-01-01", "2024년 1월 1일"))))
        val result = service.interpret("2024년 1월 1일입니다", context, pending)
        assertEquals(draft.copy(companyConditions = draft.companyConditions.copy(establishedOn = LocalDate.parse("2024-01-01"))), result.proposedContext)
        assertEquals(listOf(SupportProgramConversationField.QUERY, SupportProgramConversationField.REGION, SupportProgramConversationField.ESTABLISHED_ON), result.changedFields)
        assertEquals("정확한 설립일은?", sent!!.pendingClarification!!.question)
        assertEquals("부산", sent!!.pendingClarification!!.draftContext.companyConditions.region)
        assertEquals("서울", sent!!.context.companyConditions.region)
    }

    @Test
    fun clarificationReturnsAnUnconfirmedPartialDraftWithoutInventingRelativeEstablishmentDate() {
        stub(response(listOf(update()), "CLARIFICATION_REQUIRED", "정확한 설립일은?"))
        val initial = context.copy(query = null, companyConditions = context.companyConditions.copy(establishedOn = null))
        val result = service.interpret("부산이고 설립 2년", initial, null)
        assertEquals(SupportProgramConversationStatus.CLARIFICATION_REQUIRED, result.status)
        assertNull(result.proposedContext.query)
        assertNull(result.proposedContext.companyConditions.establishedOn)
        assertEquals(listOf(SupportProgramConversationField.REGION), result.changedFields)
        assertEquals("서울", initial.companyConditions.region)
    }

    @Test
    fun clearResetsCompanyConditionsAndAcceptingOnlyInCanonicalChangedFieldOrder() {
        stub(response(SupportProgramConversationField.entries.reversed().map { update(it.name, null, "초기화", "CLEAR") }, "CLARIFICATION_REQUIRED", "어떤 지원을 원하시나요?"))
        val result = service.interpret("초기화", context, null)
        assertEquals(SupportProgramConversationContext(null, true, SupportProgramCompanyConditions()), result.proposedContext)
        assertEquals(listOf(
            SupportProgramConversationField.QUERY, SupportProgramConversationField.REGION,
            SupportProgramConversationField.INDUSTRY, SupportProgramConversationField.ESTABLISHED_ON,
            SupportProgramConversationField.SUPPORT_PURPOSE, SupportProgramConversationField.ACCEPTING_ONLY,
        ), result.changedFields)

        val yearContext = context.copy(companyConditions = context.companyConditions.copy(establishedOn = null, foundedYear = 2021))
        val yearResult = service.interpret("초기화", yearContext, null)
        assertEquals(SupportProgramConversationContext(null, true, SupportProgramCompanyConditions()), yearResult.proposedContext)
        assertEquals(listOf(
            SupportProgramConversationField.QUERY, SupportProgramConversationField.REGION,
            SupportProgramConversationField.INDUSTRY, SupportProgramConversationField.FOUNDED_YEAR,
            SupportProgramConversationField.SUPPORT_PURPOSE, SupportProgramConversationField.ACCEPTING_ONLY,
        ), yearResult.changedFields)
    }

    @Test
    fun noOpChangesDoNotAppearAndRawTextIsNotTrimmed() {
        stub(response(listOf(update(value = "서울", evidence = "서울"))))
        assertEquals(emptyList<SupportProgramConversationField>(), service.interpret("서울 유지", context, null).changedFields)
        stub(response(listOf(update(value = " 부산 ", evidence = "부산"))))
        assertEquals(" 부산 ", service.interpret("부산", context, null).proposedContext.companyConditions.region)
    }

    @Test
    fun acceptingOnlyAcceptsOnlyExactBooleanStringsAndClearResetsTrue() {
        for ((value, expected) in listOf("true" to true, "false" to false, null to true)) {
            stub(response(listOf(update("ACCEPTING_ONLY", value, "접수", if (value == null) "CLEAR" else "SET"))))
            assertEquals(expected, service.interpret("접수", context, null).proposedContext.acceptingOnly)
        }
        for (value in listOf("TRUE", "False", "1", " false ")) rejects(response(listOf(update("ACCEPTING_ONLY", value))))
    }

    @Test
    fun rejectsUnsupportedDuplicateMissingOrOversizedPatchListsAndWrongOperations() {
        for (updates in listOf(null, listOf(null), List(7) { update() }, listOf(update(), update()), listOf(update("UNKNOWN")), listOf(update(operation = "KEEP")), listOf(update(operation = null)), listOf(update(value = null)), listOf(update(value = " ")), listOf(update(operation = "CLEAR")))) {
            rejects(response(updates))
        }
    }

    @Test
    fun rejectsEvidenceNotExactlyQuotedFromTheCurrentMessageIncludingOldContextOrQuestion() {
        for (evidence in listOf(null, "", " ", "서울", "부 산", "정확한 설립일은?")) rejects(response(listOf(update(evidence = evidence))))
        for (evidence in listOf("가".repeat(161), "😀".repeat(81), "부산\n", "부산\r", "부산\t", "부산\u0000", "부산\u200b")) {
            rejects(response(listOf(update(evidence = evidence))), evidence)
        }
    }

    @Test
    fun appliesUtf16BoundariesAndAllowsMultilineOnlyForQuery() {
        for ((field, limit) in listOf("QUERY" to 500, "REGION" to 50, "INDUSTRY" to 100, "SUPPORT_PURPOSE" to 100)) {
            stub(response(listOf(update(field, "😀".repeat(limit / 2)))))
            assertNotNull(service.interpret("부산", context, null))
            rejects(response(listOf(update(field, "가".repeat(limit + 1)))))
            rejects(response(listOf(update(field, "😀".repeat(limit / 2 + 1)))))
            rejects(response(listOf(update(field, "가\u200b"))))
            if (field != "QUERY") rejects(response(listOf(update(field, "가\n"))))
        }
        stub(response(listOf(update("QUERY", "AI\n지원\t사업\r"))))
        assertEquals("AI\n지원\t사업\r", service.interpret("부산", context, null).proposedContext.query)
        val evidence = "😀".repeat(80)
        stub(response(listOf(update(evidence = evidence))))
        assertNotNull(service.interpret(evidence, context, null))
    }

    @ParameterizedTest
    @ValueSource(strings = ["1900-01-01", "2024-02-29", "2026-09-07"])
    fun acceptsExactRealIsoDatesThroughSeoulToday(value: String) {
        stub(response(listOf(update("ESTABLISHED_ON", value, value))))
        assertEquals(LocalDate.parse(value), service.interpret("설립일 $value", context, null).proposedContext.companyConditions.establishedOn)
    }

    @ParameterizedTest
    @ValueSource(strings = ["2024년1월1일", "2024년 01월 01일", "2024년\u00a01월\u00a01일"])
    fun acceptsCompleteKoreanDatesWithOptionalUnicodeSpacing(evidence: String) {
        stub(response(listOf(update("ESTABLISHED_ON", "2024-01-01", evidence))))
        assertEquals(LocalDate.parse("2024-01-01"), service.interpret(evidence, context, null).proposedContext.companyConditions.establishedOn)
    }

    @ParameterizedTest
    @ValueSource(strings = ["1899-12-31", "2026-09-08", "2025-02-29", "2026-02-30", "2026-9-07", " 2024-01-01", "2024-01-01 ", "2024-01-01T00:00:00"])
    fun rejectsInventedOutOfRangeAndNonIsoDates(value: String) {
        rejects(response(listOf(update("ESTABLISHED_ON", value, value))), value)
    }

    @ParameterizedTest
    @ValueSource(strings = ["설립 2년", "2023-01-01", "2024년 2월 30일", "2024년 01월 01일 설립", " 2024-01-01", "2024-01-01 "])
    fun rejectsRelativeMismatchedOrNonDateEvidence(evidence: String) {
        rejects(response(listOf(update("ESTABLISHED_ON", "2024-01-01", evidence))), evidence)
    }

    @Test
    fun rejectsWrongSchemaStatusAndInvalidReadyOrClarificationStates() {
        for (payload in listOf(response(version = null), response(version = "v2"), response(status = null), response(status = "SEARCH"), response(question = "질문"), response(status = "CLARIFICATION_REQUIRED"), response(listOf(update("QUERY", null, "부산", "CLEAR"))))) rejects(payload)
        rejects(response(), initial = context.copy(query = null))
        for (question in listOf("", " ", "가".repeat(161), "😀".repeat(81), "질문\n", "질문\u200b")) rejects(response(status = "CLARIFICATION_REQUIRED", question = question))
        stub(response(status = "CLARIFICATION_REQUIRED", question = "😀".repeat(80)))
        assertNotNull(service.interpret("부산", context, null))
    }

    @Test
    fun propagatesAnUpstreamFailureWithoutSearchingOrReturningAClarificationFallback() {
        val failure = AiServiceCallException.timeout(null)
        Mockito.doThrow(failure).`when`(client).interpret(anyRequest())
        assertSame(failure, assertThrows(AiServiceCallException::class.java) { service.interpret("부산", context, null) })
    }
}
