package ai.govbiz.core.assistant.service

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.domain.CompanySummary
import ai.govbiz.core.assistant.client.AiAssistantClient
import ai.govbiz.core.assistant.client.dto.AiAssistantAgentPayload
import ai.govbiz.core.assistant.client.dto.AiAssistantAgentRequest
import ai.govbiz.core.assistant.client.dto.AiAssistantChunkRef
import ai.govbiz.core.assistant.client.dto.AiAssistantSavedProgramDocument
import ai.govbiz.core.assistant.client.dto.AiAssistantCardPayload
import ai.govbiz.core.assistant.client.dto.AiAssistantContext
import ai.govbiz.core.assistant.client.dto.AiAssistantNavigationPayload
import ai.govbiz.core.assistant.client.dto.AiAssistantSession
import ai.govbiz.core.assistant.client.dto.AiAssistantToolCallPayload
import ai.govbiz.core.assistant.config.AssistantAgentProperties
import ai.govbiz.core.assistant.domain.AssistantAccountTopic
import ai.govbiz.core.assistant.domain.AssistantCard
import ai.govbiz.core.assistant.domain.AssistantCardKind
import ai.govbiz.core.assistant.domain.AssistantHelpEntry
import ai.govbiz.core.assistant.domain.AssistantIntent
import ai.govbiz.core.assistant.domain.AssistantNavigation
import ai.govbiz.core.assistant.domain.AssistantQuestion
import ai.govbiz.core.assistant.domain.AssistantScreenContext
import ai.govbiz.core.partner.service.PartnerProposalService
import ai.govbiz.core.supportprogram.service.saved.SavedSupportProgramService
import java.time.Clock
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito
import org.mockito.Mockito.`when`

/** 에이전트 경로(`app.assistant.agent-enabled=true`)입니다. 분류 경로의 규칙은 [AssistantMessageServiceTest]가 봅니다. */
class AssistantMessageAgentServiceTest {
    private val client = Mockito.mock(AiAssistantClient::class.java)
    private val savedPrograms = Mockito.mock(SavedSupportProgramService::class.java)
    private val proposals = Mockito.mock(PartnerProposalService::class.java)
    private val clock = Clock.fixed(Instant.parse("2026-09-13T03:00:00Z"), ZoneId.of("Asia/Seoul"))
    private val properties = AssistantAgentProperties(agentEnabled = true, toolsSecret = "assistant-tools-secret-for-tests-0123456789")
    private val tokens = AssistantToolTokenService(properties, clock)
    private val documents = Mockito.mock(AssistantSavedProgramDocumentService::class.java)
    private val service = AssistantMessageService(client, savedPrograms, proposals, clock, properties, tokens, documents)

    private val scoreEntry = AssistantHelpEntry(
        "search-score-meaning", "점수는 무엇을 뜻하나요", "점수는 무슨 뜻인가요?",
        "점수는 검색어와 공고의 관련도입니다.", listOf("점수는 순서를 정하는 값입니다."), "선정 가능성은 제공하지 않습니다.",
        "public", "available", AssistantNavigation("검색 화면 열기", "/app/chat"),
    )
    private val member = Account(7L, "member@example.com", AccountRole.USER, LocalDateTime.of(2026, 9, 1, 9, 0), null, LocalDateTime.of(2026, 9, 1, 9, 0))
    private val companyMember = member.copy(company = CompanySummary(3L, "데이터브릿지 주식회사", "1248100998"))
    private val sentRequests = mutableListOf<AiAssistantAgentRequest>()

    private fun question(message: String = "나한테 맞는 파트너 모집글 있어?") =
        AssistantQuestion(message, emptyList(), AssistantScreenContext("/app/chat", false), listOf(scoreEntry))

    private fun recruitmentCard(id: String = "21", to: String = "/app/partners/detail?recruitmentId=$id", kind: String = "RECRUITMENT", quote: String? = null) =
        AiAssistantCardPayload(kind, id, "AI 실증 참여기관 구합니다", "서울AI 주식회사 · 서울", "지역과 역할이 맞습니다.", quote, to)

    private fun programCard(sourceCode: String = "BIZINFO", programId: String = "PBLN_000000000000001", quote: String? = null) = AiAssistantCardPayload(
        "PROGRAM", "$sourceCode:$programId", "서울 AI 실증 지원사업", "서울경제진흥원 · 2026-09-30", "가장 빨리 마감됩니다.", quote,
        "/app/support-programs/detail?sourceCode=$sourceCode&sourceProgramId=$programId",
    )

    private fun payload(
        intent: String, answer: String? = null, cards: List<AiAssistantCardPayload?>? = emptyList(),
        navigation: AiAssistantNavigationPayload? = null, accountTopic: String? = null, citations: List<String?>? = emptyList(),
        schemaVersion: String? = "govbiz-assistant-agent-v1", clarification: String? = null, searchQuery: String? = null,
        needsDocuments: Boolean? = false,
    ) = AiAssistantAgentPayload(
        schemaVersion, intent, answer, citations, clarification, searchQuery, accountTopic, cards, navigation,
        listOf(AiAssistantToolCallPayload("get_my_company_profile", 12, true)), needsDocuments,
    )

    /** 여러 개를 주면 호출 순서대로 돌려주고 마지막 것을 반복합니다. */
    private fun respondWith(vararg payloads: AiAssistantAgentPayload) {
        val queue = ArrayDeque(payloads.toList())
        `when`(client.agent(any(AiAssistantAgentRequest::class.java) ?: EMPTY_REQUEST)).thenAnswer {
            sentRequests += it.getArgument<AiAssistantAgentRequest>(0)
            if (queue.size > 1) queue.removeFirst() else queue.first()
        }
    }

    private val seoulDocument = AiAssistantSavedProgramDocument(
        "BIZINFO", "PBLN_000000000000001", "서울 AI 실증 지원사업", "2026-09-30", "BIZINFO:PBLN_000000000000001",
        listOf(AiAssistantChunkRef("c".repeat(64), "h".repeat(64))),
    )
    private val preparedDocuments = AssistantSavedProgramDocumentService.PreparedDocuments(
        listOf(seoulDocument), mapOf("BIZINFO:PBLN_000000000000001" to listOf("신청방법: 기업마당 온라인 신청 후 사업계획서를 제출합니다.")),
    )

    @Test
    fun savedProgramsQuestionPreparesDocumentsAndCallsTheAgentAgainWithResumeIntent() {
        `when`(documents.prepare(7L)).thenReturn(preparedDocuments)
        respondWith(
            payload("SAVED_PROGRAMS_QUESTION", needsDocuments = true),
            payload(
                "SAVED_PROGRAMS_QUESTION", answer = "관심 공고 한 건이 온라인으로 접수해요.",
                cards = listOf(programCard(quote = "기업마당 온라인 신청")), navigation = AiAssistantNavigationPayload("관심 공고함 열기", "/app/saved-programs"),
            ),
        )
        val answer = service.answer(member, question("담아둔 공고 중 온라인 접수 되는 거 있어?"))

        assertEquals(2, sentRequests.size)
        assertNull(sentRequests[0].savedProgramDocuments)
        assertNull(sentRequests[0].resumeIntent)
        val second = sentRequests[1]
        assertEquals("SAVED_PROGRAMS_QUESTION", second.resumeIntent)
        assertEquals(listOf(seoulDocument), second.savedProgramDocuments)
        assertTrue(tokens.verify(second.principal!!.toolToken, 7L))
        assertEquals(AssistantIntent.SAVED_PROGRAMS_QUESTION, answer.intent)
        assertEquals("관심 공고 한 건이 온라인으로 접수해요.", answer.answer)
        assertEquals("기업마당 온라인 신청", answer.cards.single().quote)
        assertEquals("/app/saved-programs", answer.navigation!!.to)
    }

    @Test
    fun quotesOutsideThePreparedChunksAreDroppedAndCardsOutsideTheDocumentsAreRejected() {
        `when`(documents.prepare(7L)).thenReturn(preparedDocuments)
        respondWith(
            payload("SAVED_PROGRAMS_QUESTION", needsDocuments = true),
            payload("SAVED_PROGRAMS_QUESTION", answer = "답", cards = listOf(programCard(quote = "원문에 없는 문장"))),
        )
        assertNull(service.answer(member, question()).cards.single().quote)

        respondWith(
            payload("SAVED_PROGRAMS_QUESTION", needsDocuments = true),
            payload("SAVED_PROGRAMS_QUESTION", answer = "답", cards = listOf(programCard(programId = "PBLN_000000000000009"))),
        )
        assertEquals(AiServiceFailure.INVALID_RESPONSE, assertThrows(AiServiceCallException::class.java) { service.answer(member, question()) }.failure)

        respondWith(payload("SAVED_PROGRAMS_QUESTION", needsDocuments = true), payload("SAVED_PROGRAMS_QUESTION", needsDocuments = true))
        assertEquals(AiServiceFailure.INVALID_RESPONSE, assertThrows(AiServiceCallException::class.java) { service.answer(member, question()) }.failure)

        respondWith(payload("SAVED_PROGRAMS_QUESTION", needsDocuments = true), payload("PARTNER_MATCH", answer = "다른 의도"))
        assertEquals(AiServiceFailure.INVALID_RESPONSE, assertThrows(AiServiceCallException::class.java) { service.answer(member, question()) }.failure)
    }

    @Test
    fun emptySavedBoxSkipsTheSecondCallAndGuestsNeverPrepareDocuments() {
        `when`(documents.prepare(7L)).thenReturn(AssistantSavedProgramDocumentService.PreparedDocuments(emptyList(), emptyMap()))
        respondWith(payload("SAVED_PROGRAMS_QUESTION", needsDocuments = true))
        val answer = service.answer(member, question())
        assertEquals(1, sentRequests.size)
        assertEquals(AssistantAnswerTexts.agentNoAnswer(AssistantIntent.SAVED_PROGRAMS_QUESTION), answer.answer)

        respondWith(payload("SAVED_PROGRAMS_QUESTION", needsDocuments = true))
        service.answer(null, question())
        Mockito.verify(documents, Mockito.times(1)).prepare(7L)
    }

    @Test
    fun quotesOnRecruitmentCardsAreRejected() {
        respondWith(payload("PARTNER_MATCH", answer = "답", cards = listOf(recruitmentCard(quote = "인용"))))
        assertEquals(AiServiceFailure.INVALID_RESPONSE, assertThrows(AiServiceCallException::class.java) { service.answer(companyMember, question()) }.failure)
    }

    @Test
    fun sendsAnAccountBoundTokenForMembersAndNoPrincipalForGuests() {
        respondWith(payload("PARTNER_MATCH", answer = "맞는 모집글이 있습니다.", navigation = AiAssistantNavigationPayload("파트너 모집 열기", "/app/partners")))
        service.answer(companyMember, question())
        val sent = sentRequests.last()
        assertEquals("govbiz-assistant-agent-v1", sent.schemaVersion)
        val principal = sent.principal!!
        assertEquals(7L, principal.accountId)
        assertTrue(principal.hasCompany)
        assertTrue(tokens.verify(principal.toolToken, 7L), "발급한 토큰은 같은 계정으로만 통과합니다")
        assertFalse(tokens.verify(principal.toolToken, 8L))
        assertTrue(sent.session.authenticated && sent.session.hasCompany)

        service.answer(null, question())
        assertNull(sentRequests.last().principal)
        assertFalse(sentRequests.last().session.authenticated)
        Mockito.verify(client, Mockito.never()).answer(any() ?: EMPTY_ANSWER_REQUEST)
    }

    @Test
    fun partnerMatchKeepsVerifiedCardsAndNavigation() {
        respondWith(payload(
            "PARTNER_MATCH", answer = "지역과 역할이 맞는 모집글 두 건이에요.", cards = listOf(recruitmentCard("21"), recruitmentCard("22")),
            navigation = AiAssistantNavigationPayload("파트너 모집 열기", "/app/partners"),
        ))
        val answer = service.answer(companyMember, question())
        assertEquals(AssistantIntent.PARTNER_MATCH, answer.intent)
        assertEquals("지역과 역할이 맞는 모집글 두 건이에요.", answer.answer)
        assertEquals(
            listOf(
                AssistantCard(AssistantCardKind.RECRUITMENT, "21", "AI 실증 참여기관 구합니다", "서울AI 주식회사 · 서울", "지역과 역할이 맞습니다.", "/app/partners/detail?recruitmentId=21"),
                AssistantCard(AssistantCardKind.RECRUITMENT, "22", "AI 실증 참여기관 구합니다", "서울AI 주식회사 · 서울", "지역과 역할이 맞습니다.", "/app/partners/detail?recruitmentId=22"),
            ),
            answer.cards,
        )
        assertEquals(AssistantNavigation("파트너 모집 열기", "/app/partners"), answer.navigation)
        assertTrue(answer.citations.isEmpty())
    }

    @Test
    fun programCardsRebuildTheDetailRouteFromTheIdentity() {
        respondWith(payload("SAVED_PROGRAMS_QUESTION", answer = "담아 둔 공고 중 하나가 곧 마감돼요.", cards = listOf(programCard())))
        val answer = service.answer(member, question("담아둔 공고 중 이번 달 마감 뭐야?"))
        assertEquals(AssistantIntent.SAVED_PROGRAMS_QUESTION, answer.intent)
        assertEquals("/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN_000000000000001", answer.cards.single().to)
        assertEquals(AssistantCardKind.PROGRAM, answer.cards.single().kind)
        assertNull(answer.navigation)
    }

    @Test
    fun programCardsPreserveCanonicalUnicodeAndLongIdentities() {
        val encodedIds = listOf(
            "PBLN:100" to "PBLN%3A100",
            "공고-01" to "%EA%B3%B5%EA%B3%A0-01",
            "P".repeat(255) to "P".repeat(255),
            "한".repeat(255) to "%ED%95%9C".repeat(255),
            "😀".repeat(255) to "%F0%9F%98%80".repeat(255),
            "PBLN~*+& one" to "PBLN~%2A%2B%26+one",
        )
        for ((programId, encodedId) in encodedIds) {
            val route = "/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=$encodedId"
            val card = programCard(programId = programId).copy(to = route)
            respondWith(payload("SAVED_PROGRAMS_QUESTION", answer = "공고 안내", cards = listOf(card)))
            val verified = service.answer(member, question()).cards.single()
            assertEquals("BIZINFO:$programId", verified.id)
            assertEquals(route, verified.to)
        }
        val sourceCode = "A".repeat(64)
        respondWith(payload("SAVED_PROGRAMS_QUESTION", answer = "공고 안내", cards = listOf(programCard(sourceCode))))
        assertEquals("$sourceCode:PBLN_000000000000001", service.answer(member, question()).cards.single().id)
    }

    @Test
    fun programCardsStillRejectInvalidCanonicalIdentitiesAndMismatchedRoutes() {
        for (card in listOf(
            programCard(programId = "P".repeat(256)),
            programCard(programId = "한".repeat(256)),
            programCard(programId = " leading"),
            programCard(programId = "trailing "),
            programCard(programId = "P\u200B1"),
            programCard(programId = "P\u00001"),
            programCard(sourceCode = "A".repeat(65)),
            programCard(programId = "PBLN:100").copy(to = "/app/support-programs/detail?sourceCode=BIZINFO&sourceProgramId=PBLN%3A101"),
        )) {
            respondWith(payload("SAVED_PROGRAMS_QUESTION", answer = "공고 안내", cards = listOf(card)))
            assertEquals(AiServiceFailure.INVALID_RESPONSE,
                assertThrows(AiServiceCallException::class.java) { service.answer(member, question()) }.failure)
        }
    }

    @Test
    fun rejectsCardsAndNavigationOutsideTheContract() {
        val partners = AiAssistantNavigationPayload("파트너 모집 열기", "/app/partners")
        listOf(
            payload("PARTNER_MATCH", answer = "답", cards = listOf(recruitmentCard(to = "/app/partners/detail?recruitmentId=99"))),
            payload("PARTNER_MATCH", answer = "답", cards = listOf(recruitmentCard(to = "https://evil.example/x"))),
            payload("PARTNER_MATCH", answer = "답", cards = listOf(recruitmentCard(id = "21a", to = "/app/partners/detail?recruitmentId=21a"))),
            payload("PARTNER_MATCH", answer = "답", cards = listOf(recruitmentCard(kind = "COMPANY"))),
            payload("PARTNER_MATCH", answer = "답", cards = listOf(programCard("bizinfo"))),
            payload("PARTNER_MATCH", answer = "답", cards = listOf(recruitmentCard("21"), recruitmentCard("21"))),
            payload("PARTNER_MATCH", answer = "답", cards = (1..6).map { recruitmentCard("$it") }),
            payload("PARTNER_MATCH", answer = "답", cards = listOf(null)),
            payload("PARTNER_MATCH", answer = "답", cards = null),
            payload("PARTNER_MATCH", answer = "답", navigation = AiAssistantNavigationPayload("관리자", "/app/admin")),
            payload("PARTNER_MATCH", answer = "답", navigation = AiAssistantNavigationPayload("", "/app/partners")),
            payload("PARTNER_MATCH", cards = listOf(recruitmentCard())),
            payload("PARTNER_MATCH", navigation = partners),
            payload("OUT_OF_SCOPE", answer = "답", cards = listOf(recruitmentCard())),
            payload("PRODUCT_HELP", answer = "답", citations = listOf("search-score-meaning"), navigation = partners),
            payload("PARTNER_MATCH", answer = "답", searchQuery = "검색어까지"),
            payload("ACCOUNT_STATE", answer = "답"),
            payload("PARTNER_MATCH", answer = "답", schemaVersion = "govbiz-assistant-v1"),
            payload("ELIGIBILITY", answer = "없는 의도"),
        ).forEach { bad ->
            respondWith(bad)
            val error = assertThrows(AiServiceCallException::class.java, { service.answer(companyMember, question()) }, bad.toString())
            assertEquals(AiServiceFailure.INVALID_RESPONSE, error.failure, bad.toString())
        }
    }

    @Test
    fun guestsGetLoginGuidanceForToolIntentsEvenIfAnAnswerCameBack() {
        respondWith(payload("PARTNER_MATCH"))
        val guest = service.answer(null, question())
        assertEquals(AssistantAnswerTexts.loginRequired(AssistantIntent.PARTNER_MATCH), guest.answer)
        assertNull(guest.navigation)
        assertTrue(guest.cards.isEmpty())

        respondWith(payload("SAVED_PROGRAMS_QUESTION"))
        assertEquals(AssistantAnswerTexts.loginRequired(AssistantIntent.SAVED_PROGRAMS_QUESTION), service.answer(null, question()).answer)
    }

    @Test
    fun membersWithoutAnAgentAnswerAreSentToTheScreen() {
        respondWith(payload("PARTNER_MATCH"))
        val answer = service.answer(member, question())
        assertEquals(AssistantAnswerTexts.agentNoAnswer(AssistantIntent.PARTNER_MATCH), answer.answer)
        assertEquals(AssistantNavigation(AssistantAnswerTexts.OPEN_PARTNERS, "/app/partners"), answer.navigation)

        respondWith(payload("SAVED_PROGRAMS_QUESTION"))
        assertEquals("/app/saved-programs", service.answer(member, question()).navigation!!.to)
    }

    @Test
    fun accountStateUsesTheAgentAnswerWhenPresentAndCoreDataOtherwise() {
        respondWith(payload(
            "ACCOUNT_STATE", accountTopic = "SAVED_PROGRAMS", answer = "관심 공고 두 건 중 하나가 9월 30일에 마감돼요.",
            cards = listOf(programCard()), navigation = AiAssistantNavigationPayload("관심 공고함 열기", "/app/saved-programs"),
        ))
        val fromAgent = service.answer(member, question("관심 공고 마감 언제야?"))
        assertEquals("관심 공고 두 건 중 하나가 9월 30일에 마감돼요.", fromAgent.answer)
        assertEquals(AssistantAccountTopic.SAVED_PROGRAMS, fromAgent.accountTopic)
        assertEquals(1, fromAgent.cards.size)
        Mockito.verifyNoInteractions(savedPrograms)

        respondWith(payload("ACCOUNT_STATE", accountTopic = "SAVED_PROGRAMS"))
        `when`(savedPrograms.list(7L)).thenReturn(emptyList())
        val fromCore = service.answer(member, question("관심 공고 마감 언제야?"))
        assertEquals(AssistantAnswerTexts.SAVED_NONE, fromCore.answer)

        val guest = service.answer(null, question("관심 공고 마감 언제야?"))
        assertEquals(AssistantAnswerTexts.loginRequired(AssistantAccountTopic.SAVED_PROGRAMS), guest.answer)
    }

    @Test
    fun classificationIntentsStillFollowTheClassicRules() {
        respondWith(payload("PRODUCT_HELP", answer = "점수는 관련도입니다.", citations = listOf("search-score-meaning")))
        val help = service.answer(null, question("점수가 뭐야?"))
        assertEquals(listOf("search-score-meaning"), help.citations)
        assertEquals(AssistantNavigation("검색 화면 열기", "/app/chat"), help.navigation)

        respondWith(payload("SEARCH", searchQuery = "부산 수출 지원"))
        assertEquals("부산 수출 지원", service.answer(null, question("부산 수출 지원 찾아줘")).searchQuery)
    }

    @Test
    fun classifierPathRejectsAgentOnlyIntents() {
        val classic = AssistantMessageService(client, savedPrograms, proposals, clock)
        `when`(client.answer(any() ?: EMPTY_ANSWER_REQUEST)).thenReturn(
            ai.govbiz.core.assistant.client.dto.AiAssistantAnswerPayload("govbiz-assistant-v1", "PARTNER_MATCH", null, emptyList(), null, null, null),
        )
        val error = assertThrows(AiServiceCallException::class.java) { classic.answer(companyMember, question()) }
        assertEquals(AiServiceFailure.INVALID_RESPONSE, error.failure)
        Mockito.verify(client, Mockito.never()).agent(any() ?: EMPTY_REQUEST)
    }

    private companion object {
        val EMPTY_REQUEST = AiAssistantAgentRequest("", "", emptyList(), AiAssistantSession(false, false), AiAssistantContext("/", false), emptyList(), null)
        val EMPTY_ANSWER_REQUEST = ai.govbiz.core.assistant.client.dto.AiAssistantAnswerRequest(
            "", "", emptyList(), AiAssistantSession(false, false), AiAssistantContext("/", false), emptyList(),
        )
    }
}
