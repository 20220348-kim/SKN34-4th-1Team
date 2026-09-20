package ai.govbiz.core.supportprogram.service.conversation

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramConversationClient
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationCompanyConditionsRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationContextRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationLastSearchRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramConversationRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramPendingClarificationRequest
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationContext
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationField
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationLastSearch
import ai.govbiz.core.supportprogram.domain.SupportProgramConversationStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramPendingClarification
import ai.govbiz.core.supportprogram.service.dto.SupportProgramConversationResult
import java.time.Clock
import java.time.LocalDate
import java.time.format.DateTimeParseException
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service

/** 검증된 변경만 초안에 병합하거나 맥락 설명을 반환하며 적용·검색·저장은 하지 않습니다. */
@Service
class SupportProgramConversationService(
    private val client: AiSupportProgramConversationClient,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    fun interpret(
        message: String,
        context: SupportProgramConversationContext,
        pendingClarification: SupportProgramPendingClarification?,
        pendingProposal: SupportProgramConversationContext? = null,
        lastSearch: SupportProgramConversationLastSearch? = null,
    ): SupportProgramConversationResult {
        require(pendingClarification == null || pendingProposal == null) { "only one pending conversation state is allowed" }
        val referenceDate = LocalDate.now(clock)
        val payload = client.interpret(
            AiSupportProgramConversationRequest(
                SCHEMA_VERSION,
                referenceDate.toString(),
                message,
                context.toRequest(),
                pendingClarification?.let { AiSupportProgramPendingClarificationRequest(it.question, it.draftContext.toRequest()) },
                pendingProposal?.toRequest(),
                lastSearch?.let { AiSupportProgramConversationLastSearchRequest(it.context.toRequest(), it.resultCount) },
            ),
        )
        if (payload.schemaVersion != SCHEMA_VERSION) invalidResponse()
        val status = SupportProgramConversationStatus.entries.firstOrNull { it.name == payload.status } ?: invalidResponse()
        val updates = payload.updates?.takeIf { it.size <= 7 } ?: invalidResponse()
        val fields = HashSet<SupportProgramConversationField>()
        var proposed = pendingClarification?.draftContext ?: pendingProposal ?: context
        for (update in updates) {
            if (update == null) invalidResponse()
            val field = SupportProgramConversationField.entries.firstOrNull { it.name == update.field } ?: invalidResponse()
            if (!fields.add(field)) invalidResponse()
            val evidence = update.evidence?.takeIf { validText(it, 160) && message.contains(it) } ?: invalidResponse()
            val value = when (update.operation) {
                "CLEAR" -> {
                    if (update.value != null) invalidResponse()
                    null
                }
                "SET" -> update.value?.takeIf { it.isNotBlank() } ?: invalidResponse()
                else -> invalidResponse()
            }
            if (field == SupportProgramConversationField.ESTABLISHED_ON && value != null) {
                val establishedOn = parseIsoDate(value) ?: invalidResponse()
                if (establishedOn < EARLIEST_DATE || establishedOn > referenceDate || parseEvidenceDate(evidence) != establishedOn) invalidResponse()
            }
            if (field == SupportProgramConversationField.FOUNDED_YEAR && value != null) {
                val year = value.takeIf { it.matches(Regex("[0-9]{4}")) }?.toIntOrNull() ?: invalidResponse()
                if (year !in 1900..referenceDate.year || evidence.removeSuffix("년") != value) invalidResponse()
            }
            proposed = applyUpdate(proposed, field, value)
        }
        if (!validContext(proposed, referenceDate)) invalidResponse()
        when (status) {
            SupportProgramConversationStatus.READY ->
                if (proposed.query == null || payload.clarificationQuestion != null || payload.answer != null) invalidResponse()
            SupportProgramConversationStatus.CLARIFICATION_REQUIRED ->
                if (payload.clarificationQuestion == null || !validText(payload.clarificationQuestion, 160) || payload.answer != null) invalidResponse()
            SupportProgramConversationStatus.ANSWERED ->
                if (updates.isNotEmpty() || payload.clarificationQuestion != null || payload.answer == null ||
                    !validText(payload.answer, 1000, multiline = true)
                ) invalidResponse()
        }
        val changedFields = SupportProgramConversationField.entries.filter { valueOf(context, it) != valueOf(proposed, it) }
        return SupportProgramConversationResult(status, proposed, payload.clarificationQuestion, java.util.List.copyOf(changedFields), payload.answer)
    }

    private fun applyUpdate(
        context: SupportProgramConversationContext,
        field: SupportProgramConversationField,
        value: String?,
    ): SupportProgramConversationContext = when (field) {
        SupportProgramConversationField.QUERY -> context.copy(query = value)
        SupportProgramConversationField.REGION -> context.copy(companyConditions = context.companyConditions.copy(region = value))
        SupportProgramConversationField.INDUSTRY -> context.copy(companyConditions = context.companyConditions.copy(industry = value))
        SupportProgramConversationField.ESTABLISHED_ON -> context.copy(companyConditions = context.companyConditions.copy(establishedOn = value?.let { parseIsoDate(it) ?: invalidResponse() }, foundedYear = null))
        SupportProgramConversationField.FOUNDED_YEAR -> context.copy(companyConditions = context.companyConditions.copy(foundedYear = value?.toIntOrNull(), establishedOn = null))
        SupportProgramConversationField.SUPPORT_PURPOSE -> context.copy(companyConditions = context.companyConditions.copy(supportPurpose = value))
        SupportProgramConversationField.ACCEPTING_ONLY -> context.copy(acceptingOnly = when (value) {
            null, "true" -> true
            "false" -> false
            else -> invalidResponse()
        })
    }

    private fun validContext(context: SupportProgramConversationContext, referenceDate: LocalDate): Boolean =
        (context.query == null || validText(context.query, 500, multiline = true)) &&
            context.companyConditions.let {
                (it.region == null || validText(it.region, 50)) &&
                    (it.industry == null || validText(it.industry, 100)) &&
                    (it.supportPurpose == null || validText(it.supportPurpose, 100)) &&
                    (it.establishedOn == null || it.establishedOn in EARLIEST_DATE..referenceDate) &&
                    (it.foundedYear == null || it.foundedYear in 1900..referenceDate.year) &&
                    (it.establishedOn == null || it.foundedYear == null)
            }

    private fun valueOf(context: SupportProgramConversationContext, field: SupportProgramConversationField): Any? = when (field) {
        SupportProgramConversationField.QUERY -> context.query
        SupportProgramConversationField.REGION -> context.companyConditions.region
        SupportProgramConversationField.INDUSTRY -> context.companyConditions.industry
        SupportProgramConversationField.ESTABLISHED_ON -> context.companyConditions.establishedOn
        SupportProgramConversationField.FOUNDED_YEAR -> context.companyConditions.foundedYear
        SupportProgramConversationField.SUPPORT_PURPOSE -> context.companyConditions.supportPurpose
        SupportProgramConversationField.ACCEPTING_ONLY -> context.acceptingOnly
    }

    private fun SupportProgramConversationContext.toRequest() = AiSupportProgramConversationContextRequest(
        query,
        acceptingOnly,
        companyConditions.let { AiSupportProgramConversationCompanyConditionsRequest(it.region, it.industry, it.establishedOn?.toString(), it.supportPurpose, it.foundedYear) },
    )

    private fun validText(value: String, maximum: Int, multiline: Boolean = false): Boolean =
        value.isNotBlank() && value.length <= maximum && !(if (multiline) UNSUPPORTED_QUERY_TEXT else UNSUPPORTED_TEXT).containsMatchIn(value)

    private fun parseIsoDate(value: String): LocalDate? {
        if (!ISO_DATE.matches(value)) return null
        return try { LocalDate.parse(value) } catch (_: DateTimeParseException) { null }
    }

    private fun parseEvidenceDate(evidence: String): LocalDate? {
        parseIsoDate(evidence)?.let { return it }
        val match = KOREAN_DATE.matchEntire(evidence) ?: return null
        return try {
            LocalDate.of(match.groupValues[1].toInt(), match.groupValues[2].toInt(), match.groupValues[3].toInt())
        } catch (_: java.time.DateTimeException) { null }
    }

    private fun invalidResponse(): Nothing =
        throw AiServiceCallException.invalidResponse("AI conversation response violated the internal contract", null)

    companion object {
        const val SCHEMA_VERSION = "govbiz-support-program-conversation-v1"
        private val EARLIEST_DATE = LocalDate.of(1900, 1, 1)
        private val ISO_DATE = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")
        private val KOREAN_DATE = Regex("([0-9]{4})년(?U)\\s*([0-9]{1,2})월\\s*([0-9]{1,2})일")
        private val UNSUPPORTED_TEXT = Regex("\\p{C}")
        private val UNSUPPORTED_QUERY_TEXT = Regex("[\\p{C}&&[^\\n\\r\\t]]")
    }
}
