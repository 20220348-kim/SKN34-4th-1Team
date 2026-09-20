package ai.govbiz.core.assistant.service

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.assistant.client.AiAssistantClient
import ai.govbiz.core.assistant.client.dto.AiAssistantAgentPayload
import ai.govbiz.core.assistant.client.dto.AiAssistantAgentRequest
import ai.govbiz.core.assistant.client.dto.AiAssistantAnswerPayload
import ai.govbiz.core.assistant.client.dto.AiAssistantAnswerRequest
import ai.govbiz.core.assistant.client.dto.AiAssistantCardPayload
import ai.govbiz.core.assistant.client.dto.AiAssistantContext
import ai.govbiz.core.assistant.client.dto.AiAssistantHelpAction
import ai.govbiz.core.assistant.client.dto.AiAssistantHelpEntry
import ai.govbiz.core.assistant.client.dto.AiAssistantHistoryMessage
import ai.govbiz.core.assistant.client.dto.AiAssistantNavigationPayload
import ai.govbiz.core.assistant.client.dto.AiAssistantPrincipal
import ai.govbiz.core.assistant.client.dto.AiAssistantSession
import ai.govbiz.core.assistant.config.AssistantAgentProperties
import ai.govbiz.core.assistant.domain.AssistantAccountTopic
import ai.govbiz.core.assistant.domain.AssistantAnswer
import ai.govbiz.core.assistant.domain.AssistantCard
import ai.govbiz.core.assistant.domain.AssistantCardKind
import ai.govbiz.core.assistant.domain.AssistantHelpEntry
import ai.govbiz.core.assistant.domain.AssistantIntent
import ai.govbiz.core.assistant.domain.AssistantNavigation
import ai.govbiz.core.assistant.domain.AssistantQuestion
import ai.govbiz.core.partner.domain.PartnerProposalBox
import ai.govbiz.core.partner.domain.PartnerProposalStatus
import ai.govbiz.core.partner.service.PartnerProposalService
import ai.govbiz.core.supportprogram.domain.SavedSupportProgram
import ai.govbiz.core.supportprogram.service.saved.SavedSupportProgramService
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Clock
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service

/**
 * 도우미 자유 질문 한 건을 처리합니다. 개인 정보를 가린 질문을 AI Service에 한 번 보내 의도를 받고,
 * 의도에 따라 Core가 회원 자료(관심 공고함·받은 제안함·기업)를 읽어 답을 만들거나 기존 화면으로 안내합니다.
 * `app.assistant.agent-enabled`가 켜지면 분류 대신 도구 에이전트를 부르고, 에이전트가 회원 자료를 읽어 만든
 * 답과 카드를 형식·경로 허용 목록으로 다시 검증해 씁니다. 대화 전문은 저장하지 않습니다.
 */
@Service
class AssistantMessageService(
    private val client: AiAssistantClient,
    private val savedSupportProgramService: SavedSupportProgramService,
    private val partnerProposalService: PartnerProposalService,
    @param:Qualifier("seoulClock") private val clock: Clock,
    private val properties: AssistantAgentProperties = AssistantAgentProperties(),
    private val tokenService: AssistantToolTokenService? = null,
    private val documentService: AssistantSavedProgramDocumentService? = null,
) {
    fun answer(account: Account?, question: AssistantQuestion): AssistantAnswer {
        val verified = if (properties.agentEnabled) askAgent(account, question) else askClassifier(account, question)
        return when (verified.intent) {
            AssistantIntent.PRODUCT_HELP -> productHelp(verified, question)
            AssistantIntent.ACCOUNT_STATE -> accountState(verified, account)
            AssistantIntent.SEARCH -> search(verified.searchQuery!!)
            AssistantIntent.PROGRAM_QUESTION -> programQuestion(question)
            AssistantIntent.OUT_OF_SCOPE -> AssistantAnswer(verified.intent, verified.answer, emptyList(), null, null, null, null)
            AssistantIntent.UNCLEAR -> AssistantAnswer(verified.intent, null, emptyList(), verified.clarificationQuestion, null, null, null)
            AssistantIntent.PARTNER_MATCH, AssistantIntent.SAVED_PROGRAMS_QUESTION -> toolAnswer(verified, account)
        }
    }

    private fun askClassifier(account: Account?, question: AssistantQuestion): VerifiedPayload =
        verify(client.answer(toRequest(account, question)).toRaw(), question, agent = false)

    /**
     * 로그인 회원이면 이 요청에만 쓰는 계정 묶음 토큰을 발급해 AI Service의 도구가 Core를 되부를 수 있게 합니다.
     * 관심 공고 묶음 질문은 첫 응답이 `needsDocuments`면 원문 청크 허용 목록을 준비해 같은 의도로 한 번 더 부르고,
     * 돌아온 인용은 준비한 청크 원문과 다시 대조합니다.
     */
    private fun askAgent(account: Account?, question: AssistantQuestion): VerifiedPayload {
        val tokens = tokenService ?: throw IllegalStateException("assistant agent requires the tool token service")
        val base = toRequest(account, question)
        val principal = account?.let { AiAssistantPrincipal(it.id, tokens.issue(it.id).value, it.company != null) }
        val request = AiAssistantAgentRequest(
            AGENT_SCHEMA_VERSION, base.message, base.history, base.session, base.context, base.helpEntries, principal,
        )
        val first = client.agent(request)
        val verified = verify(first.toRaw(), question, agent = true)
        if (first.needsDocuments != true || account == null || verified.intent != AssistantIntent.SAVED_PROGRAMS_QUESTION) return verified
        val documents = documentService ?: throw IllegalStateException("assistant agent requires the document service")
        val prepared = documents.prepare(account.id)
        if (prepared.documents.isEmpty()) return verified
        val second = client.agent(request.copy(
            principal = AiAssistantPrincipal(account.id, tokens.issue(account.id).value, account.company != null),
            savedProgramDocuments = prepared.documents, resumeIntent = AssistantIntent.SAVED_PROGRAMS_QUESTION.name,
        ))
        if (second.needsDocuments == true) invalidResponse()
        val resumed = verify(second.toRaw(), question, agent = true)
        if (resumed.intent != AssistantIntent.SAVED_PROGRAMS_QUESTION) invalidResponse()
        val allowed = prepared.documents.map { it.documentId }.toSet()
        // 카드는 준비한 관심 공고 안에서만, 인용은 그 공고의 청크 원문에 글자 그대로 있어야 남깁니다.
        val cards = resumed.cards.map { card ->
            if (card.kind != AssistantCardKind.PROGRAM || card.id !in allowed) invalidResponse()
            val quote = card.quote?.takeIf { text -> prepared.chunkTexts[card.id].orEmpty().any { it.contains(text) } }
            card.copy(quote = quote)
        }
        return resumed.copy(cards = cards)
    }

    private fun toRequest(account: Account?, question: AssistantQuestion): AiAssistantAnswerRequest =
        AiAssistantAnswerRequest(
            SCHEMA_VERSION,
            AssistantPiiMasker.mask(question.message).take(MESSAGE_MAX),
            question.history.map { AiAssistantHistoryMessage(it.role.name, AssistantPiiMasker.mask(it.content).take(HISTORY_MAX)) },
            AiAssistantSession(account != null, account?.company != null),
            AiAssistantContext(question.context.route, question.context.programSelected),
            question.helpEntries.map {
                AiAssistantHelpEntry(
                    it.id, it.title, it.question, it.summary, it.body, it.limitation, it.audience, it.status,
                    it.action?.let { action -> AiAssistantHelpAction(action.label, action.to) },
                )
            },
        )

    /**
     * AI Service와 같은 의도별 필드 규칙을 Core에서 다시 확인합니다. 어긋나면 답을 고치지 않고 502로 끝냅니다.
     * 에이전트 응답은 카드 id·경로 형식과 이동 경로 허용 목록까지 봅니다.
     */
    private fun verify(payload: RawPayload, question: AssistantQuestion, agent: Boolean): VerifiedPayload {
        if (payload.schemaVersion != (if (agent) AGENT_SCHEMA_VERSION else SCHEMA_VERSION)) invalidResponse()
        val intent = AssistantIntent.entries.firstOrNull { it.name == payload.intent } ?: invalidResponse()
        if (!agent && intent !in CLASSIFIER_INTENTS) invalidResponse()
        val citations = payload.citations ?: invalidResponse()
        if (citations.size > MAX_CITATIONS || citations.any { it == null } || citations.toSet().size != citations.size) invalidResponse()
        val helpIds = question.helpEntries.map { it.id }.toSet()
        val citedIds = citations.map { it!! }
        if (citedIds.any { it !in helpIds }) invalidResponse()
        val answer = payload.answer?.also { if (!validText(it, ANSWER_MAX, multiline = true)) invalidResponse() }
        val clarification = payload.clarificationQuestion?.also { if (!validText(it, SHORT_MAX)) invalidResponse() }
        val searchQuery = payload.searchQuery?.also { if (!validText(it, MESSAGE_MAX, multiline = true)) invalidResponse() }
        val accountTopic = payload.accountTopic?.let { name ->
            AssistantAccountTopic.entries.firstOrNull { it.name == name } ?: invalidResponse()
        }
        val present = buildSet {
            if (answer != null) add("answer")
            if (citedIds.isNotEmpty()) add("citations")
            if (clarification != null) add("clarificationQuestion")
            if (searchQuery != null) add("searchQuery")
            if (accountTopic != null) add("accountTopic")
        }
        val (required, optional) = when (intent) {
            AssistantIntent.PRODUCT_HELP -> setOf("answer", "citations") to emptySet()
            AssistantIntent.ACCOUNT_STATE -> setOf("accountTopic") to (if (agent) setOf("answer") else emptySet())
            AssistantIntent.SEARCH -> setOf("searchQuery") to emptySet()
            AssistantIntent.PROGRAM_QUESTION -> emptySet<String>() to emptySet()
            AssistantIntent.OUT_OF_SCOPE -> setOf("answer") to emptySet()
            AssistantIntent.UNCLEAR -> setOf("clarificationQuestion") to emptySet()
            AssistantIntent.PARTNER_MATCH, AssistantIntent.SAVED_PROGRAMS_QUESTION -> emptySet<String>() to setOf("answer")
        }
        if (!present.containsAll(required) || !(required + optional).containsAll(present)) invalidResponse()
        val cards = verifyCards(payload.cards)
        val navigation = payload.navigation?.let(::verifyNavigation)
        if ((cards.isNotEmpty() || navigation != null) && (!intent.usesTools || answer == null)) invalidResponse()
        return VerifiedPayload(intent, answer, citedIds, clarification, searchQuery, accountTopic, navigation, cards)
    }

    private fun verifyCards(cards: List<AiAssistantCardPayload?>?): List<AssistantCard> {
        if (cards == null) invalidResponse()
        if (cards.size > MAX_CARDS || cards.any { it == null }) invalidResponse()
        val verified = cards.map { card ->
            val kind = AssistantCardKind.entries.firstOrNull { it.name == card!!.kind } ?: invalidResponse()
            val id = card!!.id?.takeIf { CARD_ID.matches(it) } ?: invalidResponse()
            val title = card.title?.takeIf { validText(it, SHORT_MAX) } ?: invalidResponse()
            val subtitle = card.subtitle?.also { if (!validText(it, SHORT_MAX)) invalidResponse() }
            val reason = card.reason?.takeIf { validText(it, REASON_MAX) } ?: invalidResponse()
            val quote = card.quote?.also { if (kind != AssistantCardKind.PROGRAM || !validText(it, QUOTE_MAX, multiline = true)) invalidResponse() }
            val to = card.to ?: invalidResponse()
            if (to != expectedCardRoute(kind, id)) invalidResponse()
            AssistantCard(kind, id, title, subtitle, reason, to, quote)
        }
        if (verified.map { it.kind to it.id }.toSet().size != verified.size) invalidResponse()
        return verified
    }

    /** 카드 경로는 모델 문자열을 믿지 않고 종류·id에서 다시 만든 값과 같을 때만 통과합니다. */
    private fun expectedCardRoute(kind: AssistantCardKind, id: String): String = when (kind) {
        AssistantCardKind.RECRUITMENT -> {
            if (!RECRUITMENT_ID.matches(id)) invalidResponse()
            "${InternalRoutes.PARTNER_DETAIL}?recruitmentId=$id"
        }
        AssistantCardKind.PROGRAM -> {
            val separator = id.indexOf(':')
            if (separator <= 0 || separator == id.lastIndex) invalidResponse()
            val sourceCode = id.substring(0, separator)
            val sourceProgramId = id.substring(separator + 1)
            if (!SOURCE_CODE.matches(sourceCode)) invalidResponse()
            "${InternalRoutes.PROGRAM_DETAIL}?sourceCode=${encode(sourceCode)}&sourceProgramId=${encode(sourceProgramId)}"
        }
    }

    private fun verifyNavigation(navigation: AiAssistantNavigationPayload): AssistantNavigation {
        val label = navigation.label?.takeIf { validText(it, SHORT_MAX) } ?: invalidResponse()
        val to = navigation.to?.takeIf { it in InternalRoutes.NAVIGABLE } ?: invalidResponse()
        return AssistantNavigation(label, to)
    }

    /** 사용법 답입니다. 첫 인용 항목의 행동 버튼을 그대로 붙입니다. 경로는 프런트 도움말이 정한 값이라 요청에 실린 것만 씁니다. */
    private fun productHelp(payload: VerifiedPayload, question: AssistantQuestion): AssistantAnswer {
        val navigation = payload.citations.asSequence()
            .mapNotNull { id -> question.helpEntries.firstOrNull { it.id == id }?.action }
            .firstOrNull()
        return AssistantAnswer(AssistantIntent.PRODUCT_HELP, payload.answer, payload.citations, null, null, null, navigation)
    }

    private fun search(query: String): AssistantAnswer =
        AssistantAnswer(
            AssistantIntent.SEARCH,
            AssistantAnswerTexts.search(query),
            emptyList(), null, query, null,
            AssistantNavigation(AssistantAnswerTexts.OPEN_SEARCH_FOR_QUERY, InternalRoutes.CHAT),
        )

    /** 원문 질문은 공고 문서를 근거로 답하는 기존 화면이 맡습니다. 공고 상세에 있으면 프런트가 그 공고의 질문 화면 버튼을 붙입니다. */
    private fun programQuestion(question: AssistantQuestion): AssistantAnswer =
        if (question.context.programSelected) {
            AssistantAnswer(AssistantIntent.PROGRAM_QUESTION, AssistantAnswerTexts.PROGRAM_QUESTION_ON_DETAIL, emptyList(), null, null, null, null)
        } else {
            AssistantAnswer(
                AssistantIntent.PROGRAM_QUESTION, AssistantAnswerTexts.PROGRAM_QUESTION_NO_PROGRAM, emptyList(), null, null, null,
                AssistantNavigation(AssistantAnswerTexts.OPEN_SEARCH, InternalRoutes.CHAT),
            )
        }

    /** 에이전트가 회원 자료로 답을 만들었으면 그 답과 카드를 쓰고, 아니면 Core가 자료를 읽어 답합니다. */
    private fun accountState(payload: VerifiedPayload, account: Account?): AssistantAnswer {
        val topic = payload.accountTopic!!
        if (account != null && payload.answer != null) {
            return AssistantAnswer(AssistantIntent.ACCOUNT_STATE, payload.answer, emptyList(), null, null, topic, payload.navigation, payload.cards)
        }
        val (answer, navigation) = when {
            account == null -> AssistantAnswerTexts.loginRequired(topic) to null
            topic == AssistantAccountTopic.SAVED_PROGRAMS -> savedPrograms(account)
            topic == AssistantAccountTopic.RECEIVED_PROPOSALS -> receivedProposals(account)
            else -> companyProfile(account)
        }
        return AssistantAnswer(AssistantIntent.ACCOUNT_STATE, answer, emptyList(), null, null, topic, navigation)
    }

    /** 모집글 매칭·관심 공고 묶음 질문입니다. 비로그인은 로그인 안내, 답이 없으면 화면 안내로 끝냅니다. */
    private fun toolAnswer(payload: VerifiedPayload, account: Account?): AssistantAnswer = when {
        account == null -> AssistantAnswer(payload.intent, AssistantAnswerTexts.loginRequired(payload.intent), emptyList(), null, null, null, null)
        payload.answer == null -> AssistantAnswer(
            payload.intent, AssistantAnswerTexts.agentNoAnswer(payload.intent), emptyList(), null, null, null,
            if (payload.intent == AssistantIntent.PARTNER_MATCH) {
                AssistantNavigation(AssistantAnswerTexts.OPEN_PARTNERS, InternalRoutes.PARTNERS)
            } else {
                AssistantNavigation(AssistantAnswerTexts.OPEN_SAVED, InternalRoutes.SAVED_PROGRAMS)
            },
        )
        else -> AssistantAnswer(payload.intent, payload.answer, emptyList(), null, null, null, payload.navigation, payload.cards)
    }

    private fun savedPrograms(account: Account): Pair<String, AssistantNavigation?> {
        val saved = savedSupportProgramService.list(account.id)
        if (saved.isEmpty()) {
            return AssistantAnswerTexts.SAVED_NONE to AssistantNavigation(AssistantAnswerTexts.OPEN_SEARCH, InternalRoutes.CHAT)
        }
        val today = LocalDate.now(clock)
        val upcoming = saved.filter { it.endDate == null || !it.endDate!!.isBefore(today) }
        val nearest = upcoming.filter { it.endDate != null }.minByOrNull { it.endDate!! }
        val soon = upcoming.count { it.endDate != null && ChronoUnit.DAYS.between(today, it.endDate) <= SOON_DAYS }
        val answer = when {
            upcoming.isEmpty() -> AssistantAnswerTexts.savedAllClosed(saved.size)
            nearest == null -> AssistantAnswerTexts.savedSummary(saved.size, soon, null)
            else -> AssistantAnswerTexts.savedSummary(
                saved.size, soon,
                AssistantAnswerTexts.Deadline(nearest.program.title, nearest.endDate!!, ChronoUnit.DAYS.between(today, nearest.endDate).toInt()),
            )
        }
        return answer to AssistantNavigation(AssistantAnswerTexts.OPEN_SAVED, InternalRoutes.SAVED_PROGRAMS)
    }

    private fun receivedProposals(account: Account): Pair<String, AssistantNavigation?> {
        if (account.company == null) {
            return AssistantAnswerTexts.PROPOSALS_NEED_COMPANY to AssistantNavigation(AssistantAnswerTexts.OPEN_PROFILE, InternalRoutes.PROFILE)
        }
        val pending = partnerProposalService.findBox(account, PartnerProposalBox.RECEIVED)
            .filter { it.status == PartnerProposalStatus.PENDING }
        val earliest = pending.minOfOrNull { it.proposal.expiresAt }?.toLocalDate()
        val answer = if (pending.isEmpty()) AssistantAnswerTexts.PROPOSALS_NONE else AssistantAnswerTexts.proposalsSummary(pending.size, earliest)
        return answer to AssistantNavigation(AssistantAnswerTexts.OPEN_PROPOSALS, InternalRoutes.PROPOSALS)
    }

    private fun companyProfile(account: Account): Pair<String, AssistantNavigation?> {
        val company = account.company
        val answer = if (company == null) AssistantAnswerTexts.COMPANY_NONE else AssistantAnswerTexts.companyRegistered(company.companyName)
        return answer to AssistantNavigation(AssistantAnswerTexts.OPEN_PROFILE, InternalRoutes.PROFILE)
    }

    private val SavedSupportProgram.endDate: LocalDate?
        get() = program.applicationEndDate

    private fun validText(value: String, maximum: Int, multiline: Boolean = false): Boolean =
        value.isNotBlank() && value.length <= maximum && !(if (multiline) UNSUPPORTED_LAYOUT_TEXT else UNSUPPORTED_TEXT).containsMatchIn(value)

    private fun encode(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8)

    private fun invalidResponse(): Nothing =
        throw AiServiceCallException.invalidResponse("AI assistant response violated the internal contract", null)

    private fun AiAssistantAnswerPayload.toRaw() =
        RawPayload(schemaVersion, intent, answer, citations, clarificationQuestion, searchQuery, accountTopic, emptyList(), null)

    private fun AiAssistantAgentPayload.toRaw() =
        RawPayload(schemaVersion, intent, answer, citations, clarificationQuestion, searchQuery, accountTopic, cards, navigation)

    /** 두 AI 계약(분류·에이전트)의 공통 필드입니다. 분류 응답은 카드가 비고 이동 경로가 없습니다. */
    private data class RawPayload(
        val schemaVersion: String?,
        val intent: String?,
        val answer: String?,
        val citations: List<String?>?,
        val clarificationQuestion: String?,
        val searchQuery: String?,
        val accountTopic: String?,
        val cards: List<AiAssistantCardPayload?>?,
        val navigation: AiAssistantNavigationPayload?,
    )

    private data class VerifiedPayload(
        val intent: AssistantIntent,
        val answer: String?,
        val citations: List<String>,
        val clarificationQuestion: String?,
        val searchQuery: String?,
        val accountTopic: AssistantAccountTopic?,
        val navigation: AssistantNavigation? = null,
        val cards: List<AssistantCard> = emptyList(),
    )

    /** 답변 버튼·카드가 열 수 있는 내부 화면입니다. 프런트 `appPaths`의 값과 같아야 합니다. */
    object InternalRoutes {
        const val CHAT = "/app/chat"
        const val SAVED_PROGRAMS = "/app/saved-programs"
        const val PROPOSALS = "/app/proposals"
        const val PROFILE = "/app/profile"
        const val PARTNERS = "/app/partners"
        const val PARTNER_DETAIL = "/app/partners/detail"
        const val PROGRAM_DETAIL = "/app/support-programs/detail"

        /** 에이전트의 이동 버튼이 가리킬 수 있는 화면입니다. AI Service `NAVIGATIONS`와 같습니다. */
        val NAVIGABLE: Set<String> = setOf(CHAT, SAVED_PROGRAMS, PROPOSALS, PROFILE, PARTNERS)
    }

    companion object {
        const val SCHEMA_VERSION = "govbiz-assistant-v1"
        const val AGENT_SCHEMA_VERSION = "govbiz-assistant-agent-v1"
        const val MESSAGE_MAX = 500
        const val HISTORY_MAX = 1000
        const val ANSWER_MAX = 600
        const val SHORT_MAX = 160
        const val REASON_MAX = 200
        const val QUOTE_MAX = 300
        const val MAX_CITATIONS = 3
        const val MAX_CARDS = 5
        const val SOON_DAYS = 7L
        private val CLASSIFIER_INTENTS = setOf(
            AssistantIntent.PRODUCT_HELP, AssistantIntent.ACCOUNT_STATE, AssistantIntent.SEARCH,
            AssistantIntent.PROGRAM_QUESTION, AssistantIntent.OUT_OF_SCOPE, AssistantIntent.UNCLEAR,
        )
        private val UNSUPPORTED_TEXT = Regex("\\p{C}")
        private val UNSUPPORTED_LAYOUT_TEXT = Regex("[\\p{C}&&[^\\n\\r\\t]]")
        private val CARD_ID = Regex("[A-Za-z0-9_:.-]{1,80}")
        private val RECRUITMENT_ID = Regex("[1-9][0-9]{0,18}")
        private val SOURCE_CODE = Regex("[A-Z][A-Z0-9_]{0,39}")
    }
}
