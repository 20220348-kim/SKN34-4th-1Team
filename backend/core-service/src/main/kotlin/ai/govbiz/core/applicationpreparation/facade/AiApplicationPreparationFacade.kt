package ai.govbiz.core.applicationpreparation.facade

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.applicationpreparation.client.ai.AiApplicationPreparationClient
import ai.govbiz.core.applicationpreparation.client.ai.dto.AI_APPLICATION_PREPARATION_CONTRACT_VERSION
import ai.govbiz.core.applicationpreparation.client.ai.dto.AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationFormDiscoveryBlockRequest
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationFormDiscoveryDocumentRequest
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationFormDiscoveryRequest
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationPreparationFactRequest
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationPreparationFieldRequest
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationPreparationInterpretRequest
import ai.govbiz.core.applicationpreparation.domain.ApplicationFactStatus
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import ai.govbiz.core.applicationpreparation.domain.ApplicationFactSuggestion
import ai.govbiz.core.applicationpreparation.domain.ApplicationInterpretation
import ai.govbiz.core.applicationpreparation.domain.ApplicationInterpretationConfiguration
import ai.govbiz.core.applicationpreparation.domain.ApplicationInterpretationInputSnapshot
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryConfiguration
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryInput
import ai.govbiz.core.applicationpreparation.domain.ExtractedApplicationForm
import ai.govbiz.core.applicationpreparation.domain.ExtractedApplicationFormField
import ai.govbiz.core.applicationpreparation.domain.ExtractedApplicationFormSection
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import ai.govbiz.core.applicationpreparation.domain.ApplicationDraftInput
import ai.govbiz.core.applicationpreparation.domain.ApplicationDraftOutput
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationDraftRequest
import ai.govbiz.core.applicationpreparation.client.ai.dto.AI_APPLICATION_DRAFT_CONTRACT_VERSION

/** AI 계약 생성·응답 검증·내부 모델 변환을 담당하며 DB나 상위 Service를 호출하지 않습니다. */
@Component
class AiApplicationPreparationFacade(private val client: AiApplicationPreparationClient) {
    fun draft(input: ApplicationDraftInput): ApplicationDraftOutput = try {
        val configuration = client.draftConfiguration()
        require(configuration.contractVersion == AI_APPLICATION_DRAFT_CONTRACT_VERSION)
        require(configuration.model.isNotBlank() && configuration.model.length <= 200)
        require(Regex("sha256:[0-9a-f]{64}").matches(configuration.promptVersion))
        val output = client.draft(AiApplicationDraftRequest(
            preparationId = input.preparationId, inputRevision = input.inputRevision, formVersionId = input.formVersionId,
            sectionKey = input.section.key, serviceField = input.serviceField,
            sectionTitle = input.section.title, sectionDescription = input.section.description,
            currentFacts = input.facts.map { AiApplicationPreparationFactRequest(it.fieldKey, it.status, it.value) },
            fieldOptions = input.section.fields.map { AiApplicationPreparationFieldRequest(it.key, it.label, it.guidance, it.required) },
        ))
        require(output.contractVersion == configuration.contractVersion && output.model == configuration.model && output.promptVersion == configuration.promptVersion)
        require(output.preparationId == input.preparationId && output.inputRevision == input.inputRevision && output.formVersionId == input.formVersionId && output.sectionKey == input.section.key)
        require(output.content.isNotBlank() && output.content.length <= 15000)
        require(output.content.none { Character.isISOControl(it) && it !in "\n\r\t" })
        val provided = input.facts.filter { it.status == "PROVIDED" }.map { it.fieldKey }.toSet()
        require(output.usedFieldKeys.toSet() == provided && output.usedFieldKeys.size == provided.size)
        require(input.facts.filter { it.status == "UNKNOWN" }.all { fact ->
            output.content.contains("${input.section.fields.first { it.key == fact.fieldKey }.label}: 미정")
        })
        ApplicationDraftOutput(output.content, output.model, output.promptVersion, output.usedFieldKeys)
    } catch (error: IllegalArgumentException) {
        throw AiServiceCallException.invalidResponse("Application draft response violated its contract", error)
    }

    fun discoveryConfiguration(): ApplicationFormDiscoveryConfiguration = try {
        val payload = client.discoveryConfiguration()
        ApplicationFormDiscoveryConfiguration(payload.contractVersion, payload.model, payload.promptVersion).also {
            require(it.contractVersion == AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION)
            require(it.model.isNotBlank() && it.model.length <= 200)
            require(Regex("sha256:[0-9a-f]{64}").matches(it.promptVersion))
        }
    } catch (error: AiServiceCallException) {
        throw error
    } catch (error: IllegalArgumentException) {
        throw AiServiceCallException.invalidResponse("Application form discovery configuration violated its contract", error)
    }

    fun discover(input: ApplicationFormDiscoveryInput, configuration: ApplicationFormDiscoveryConfiguration): List<ExtractedApplicationForm> {
        val request = AiApplicationFormDiscoveryRequest(
            AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION,
            input.sourceCode,
            input.sourceProgramId,
            input.programTitle,
            input.documents.map { document ->
                AiApplicationFormDiscoveryDocumentRequest(
                    document.documentIndex,
                    document.fileName,
                    document.format,
                    document.blocks.map { block -> AiApplicationFormDiscoveryBlockRequest(block.blockId, block.locator, block.text) },
                    document.sourceBytes?.let { java.util.Base64.getEncoder().encodeToString(it) },
                    document.sha256.takeIf { document.sourceBytes != null },
                )
            },
        )
        return validateDiscoveryPayload(input, configuration, client.discover(request))
    }

    /** 일회성 백필도 원문 block과 동일한 AI 계약 검증을 통과해야 한다. 외부 호출 없음. */
    fun validateDiscoveryPayload(input: ApplicationFormDiscoveryInput, configuration: ApplicationFormDiscoveryConfiguration,
        payload: ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationFormDiscoveryPayload): List<ExtractedApplicationForm> = try {
        validateDiscovery(
            payload.contractVersion == configuration.contractVersion && payload.model == configuration.model &&
                payload.promptVersion == configuration.promptVersion && payload.forms.size <= input.documents.size,
            "response",
            "METADATA_OR_FORM_COUNT_MISMATCH",
            "contractVersionMatch=${payload.contractVersion == configuration.contractVersion} " +
                "modelMatch=${payload.model == configuration.model} promptVersionMatch=${payload.promptVersion == configuration.promptVersion} " +
                "formCount=${payload.forms.size} documentCount=${input.documents.size}",
        )
        val documents = input.documents.associateBy { it.documentIndex }
        validateDiscovery(
            payload.forms.map { it.documentIndex }.distinct().size == payload.forms.size,
            "forms",
            "DUPLICATE_DOCUMENT_INDEX",
            "formCount=${payload.forms.size} distinctDocumentCount=${payload.forms.map { it.documentIndex }.distinct().size}",
        )
        payload.forms.mapIndexed { formIndex, form ->
            val document = documents[form.documentIndex] ?: discoveryViolation(
                "forms[$formIndex].documentIndex",
                "UNKNOWN_DOCUMENT_INDEX",
                "documentCount=${documents.size}",
            )
            val blocks = document.blocks.associateBy { it.blockId }
            validateDiscovery(
                form.sections.isNotEmpty() && form.sections.size <= 12 &&
                    form.sections.map { it.sectionKey }.distinct().size == form.sections.size,
                "forms[$formIndex].sections",
                "INVALID_SECTION_COUNT_OR_DUPLICATE_KEY",
                "sectionCount=${form.sections.size} distinctKeyCount=${form.sections.map { it.sectionKey }.distinct().size} limit=12",
            )
            ExtractedApplicationForm(form.documentIndex, form.sections.mapIndexed { sectionIndex, section ->
                val sectionPath = "forms[$formIndex].sections[$sectionIndex]"
                validateDiscovery(
                    Regex("[a-z][a-z0-9-]{0,63}").matches(section.sectionKey),
                    "$sectionPath.sectionKey",
                    "INVALID_KEY",
                    "utf16Length=${section.sectionKey.length} codePoints=${section.sectionKey.codePointCount(0, section.sectionKey.length)}",
                )
                val sectionTitle = validatedAiText(section.title, 100, "$sectionPath.title")
                val sectionDescription = validatedAiText(section.description, 1000, "$sectionPath.description")
                validateDiscovery(
                    section.fields.isNotEmpty() && section.fields.size <= 20 &&
                        section.fields.map { it.fieldKey }.distinct().size == section.fields.size,
                    "$sectionPath.fields",
                    "INVALID_FIELD_COUNT_OR_DUPLICATE_KEY",
                    "fieldCount=${section.fields.size} distinctKeyCount=${section.fields.map { it.fieldKey }.distinct().size} limit=20",
                )
                ExtractedApplicationFormSection(
                    section.sectionKey,
                    sectionTitle,
                    sectionDescription,
                    section.fields.mapIndexed { fieldIndex, field ->
                        val fieldPath = "$sectionPath.fields[$fieldIndex]"
                        val block = blocks[field.evidenceBlockId] ?: discoveryViolation(
                            "$fieldPath.evidenceBlockId",
                            "UNKNOWN_EVIDENCE_BLOCK",
                            "blockCount=${blocks.size}",
                        )
                        validateDiscovery(
                            Regex("[a-z][a-z0-9-]{0,63}").matches(field.fieldKey),
                            "$fieldPath.fieldKey",
                            "INVALID_KEY",
                            "utf16Length=${field.fieldKey.length} codePoints=${field.fieldKey.codePointCount(0, field.fieldKey.length)}",
                        )
                        val label = validatedAiText(field.label, 100, "$fieldPath.label")
                        val guidance = validatedAiText(field.guidance, 500, "$fieldPath.guidance")
                        val quoteCodePoints = field.evidenceQuote.codePointCount(0, field.evidenceQuote.length)
                        validateDiscovery(
                            field.evidenceQuote.isNotBlank() && quoteCodePoints <= 300 && block.text.contains(field.evidenceQuote),
                            "$fieldPath.evidenceQuote",
                            "INVALID_EVIDENCE_QUOTE",
                            "blank=${field.evidenceQuote.isBlank()} utf16Length=${field.evidenceQuote.length} codePoints=$quoteCodePoints " +
                                "limit=300 sourceUtf16Length=${block.text.length} exactSourceSubstring=${block.text.contains(field.evidenceQuote)}",
                        )
                        validateDiscovery(
                            field.options.size != 1 && field.options.size <= 30 && field.options.distinct().size == field.options.size &&
                                field.options.all { it.isNotBlank() && it == it.trim() && it.codePointCount(0, it.length) <= 100 && field.evidenceQuote.contains(it) },
                            "$fieldPath.options", "INVALID_CHOICE_OPTIONS", "count=${field.options.size}",
                        )
                        ExtractedApplicationFormField(
                            field.fieldKey, label, guidance, field.required,
                            field.evidenceBlockId, field.evidenceQuote, field.options,
                        )
                    },
                )
            })
        }
    } catch (error: AiServiceCallException) {
        throw error
    } catch (error: DiscoveryContractViolation) {
        logger.warn(
            "application_form_discovery_response_invalid stage=validation path={} reason={} {}",
            error.path,
            error.reason,
            error.safeDetails,
        )
        throw AiServiceCallException.invalidResponse("Application form discovery response violated its contract", error)
    } catch (error: IllegalArgumentException) {
        logger.warn("application_form_discovery_response_invalid stage=validation path=unknown reason=ILLEGAL_ARGUMENT")
        throw AiServiceCallException.invalidResponse("Application form discovery response violated its contract", error)
    }

    fun interpret(preparationId: Long, form: ApplicationFormManifest, snapshot: ApplicationInterpretationInputSnapshot): ApplicationInterpretation =
        try {
            interpretValidated(preparationId, form, snapshot)
        } catch (error: AiServiceCallException) {
            throw error
        } catch (error: IllegalArgumentException) {
            throw AiServiceCallException.invalidResponse("Application preparation response violated its contract", error)
        }

    private fun interpretValidated(preparationId: Long, form: ApplicationFormManifest, snapshot: ApplicationInterpretationInputSnapshot): ApplicationInterpretation {
        val section = requireNotNull(form.sections.find { it.key == snapshot.sectionKey })
        val configurationPayload = client.configuration()
        val configuration = ApplicationInterpretationConfiguration(
            configurationPayload.contractVersion,
            configurationPayload.model,
            configurationPayload.promptVersion,
        ).also(::validateConfiguration)
        val request = AiApplicationPreparationInterpretRequest(
            contractVersion = AI_APPLICATION_PREPARATION_CONTRACT_VERSION,
            preparationId = preparationId,
            inputRevision = snapshot.inputRevision,
            formVersionId = snapshot.formVersionId,
            sectionKey = snapshot.sectionKey,
            serviceField = snapshot.serviceField.name,
            userMessage = snapshot.userMessage,
            currentFacts = snapshot.currentFacts.map { AiApplicationPreparationFactRequest(it.fieldKey, it.status.name, it.value) },
            fieldOptions = section.fields.map { AiApplicationPreparationFieldRequest(it.key, it.label, it.guidance, it.required) },
        )
        val payload = client.interpret(request)
        require(
            payload.contractVersion == configuration.contractVersion && payload.model == configuration.model &&
                payload.promptVersion == configuration.promptVersion && payload.preparationId == preparationId &&
                payload.inputRevision == snapshot.inputRevision && payload.formVersionId == snapshot.formVersionId &&
                payload.sectionKey == snapshot.sectionKey,
        )
        val allowed = section.fields.map { it.key }.toSet()
        require(payload.suggestions.size <= allowed.size && payload.suggestions.map { it.fieldKey }.distinct().size == payload.suggestions.size)
        val suggestions = payload.suggestions.map { suggestion ->
            require(suggestion.fieldKey in allowed && suggestion.evidenceQuote.isNotBlank() && suggestion.evidenceQuote.length <= 1000)
            require(snapshot.userMessage.contains(suggestion.evidenceQuote))
            val status = ApplicationFactStatus.valueOf(suggestion.status)
            require((status == ApplicationFactStatus.PROVIDED && !suggestion.value.isNullOrBlank() && suggestion.value.length <= 2000) ||
                (status == ApplicationFactStatus.UNKNOWN && suggestion.value == null))
            ApplicationFactSuggestion(suggestion.fieldKey, status, suggestion.value?.trim(), suggestion.evidenceQuote)
        }
        require(payload.missingFields.distinct().size == payload.missingFields.size && payload.missingFields.all { it in allowed })
        val answered = snapshot.currentFacts.map { it.fieldKey }.toSet() + suggestions.map { it.fieldKey }
        val expectedMissing = section.fields.filter { it.required && it.key !in answered }.map { it.key }
        require(payload.missingFields == expectedMissing)
        require(
            if (expectedMissing.isEmpty()) payload.nextQuestion == null
            else payload.nextQuestion != null && payload.nextQuestion.isNotBlank() && payload.nextQuestion.length <= 300,
        )
        return ApplicationInterpretation(
            preparationId,
            snapshot.inputRevision,
            snapshot.formVersionId,
            snapshot.sectionKey,
            suggestions,
            payload.missingFields,
            payload.nextQuestion,
            configuration,
        )
    }

    private fun validateConfiguration(configuration: ApplicationInterpretationConfiguration) {
        require(configuration.contractVersion == AI_APPLICATION_PREPARATION_CONTRACT_VERSION)
        require(configuration.model.isNotBlank() && configuration.model.length <= 200)
        require(Regex("sha256:[0-9a-f]{64}").matches(configuration.promptVersion))
    }

    private fun validatedAiText(value: String, maxCodePoints: Int, path: String): String =
        value.replace(Regex("[ \\t\\r\\n]+"), " ").trim(' ').also { normalized ->
            val codePoints = normalized.codePointCount(0, normalized.length)
            val forbiddenCount = normalized.codePoints().filter { Character.getType(it) in FORBIDDEN_CHARACTER_TYPES }.count()
            validateDiscovery(
                normalized.isNotEmpty() && codePoints <= maxCodePoints && forbiddenCount == 0L,
                path,
                when {
                    normalized.isEmpty() -> "EMPTY_DISPLAY_TEXT"
                    codePoints > maxCodePoints -> "DISPLAY_TEXT_TOO_LONG"
                    else -> "FORBIDDEN_DISPLAY_CHARACTER"
                },
                "utf16Length=${normalized.length} codePoints=$codePoints limit=$maxCodePoints forbiddenCharacterCount=$forbiddenCount",
            )
        }

    private fun validateDiscovery(condition: Boolean, path: String, reason: String, safeDetails: String) {
        if (!condition) discoveryViolation(path, reason, safeDetails)
    }

    private fun discoveryViolation(path: String, reason: String, safeDetails: String): Nothing =
        throw DiscoveryContractViolation(path, reason, safeDetails)

    private class DiscoveryContractViolation(
        val path: String,
        val reason: String,
        val safeDetails: String,
    ) : IllegalArgumentException(reason)

    private companion object {
        val logger = LoggerFactory.getLogger(AiApplicationPreparationFacade::class.java)
        val FORBIDDEN_CHARACTER_TYPES = setOf(
            Character.CONTROL.toInt(),
            Character.FORMAT.toInt(),
            Character.SURROGATE.toInt(),
            Character.PRIVATE_USE.toInt(),
            Character.UNASSIGNED.toInt(),
        )
    }
}
