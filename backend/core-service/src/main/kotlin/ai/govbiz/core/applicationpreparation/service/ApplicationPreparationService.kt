package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.domain.NewApplicationPreparation
import ai.govbiz.core.applicationpreparation.domain.ApplicationProgressStage
import ai.govbiz.core.applicationpreparation.domain.ApplicationProgressUpdateResult
import ai.govbiz.core.applicationpreparation.domain.ApplicationInputReplaceResult
import ai.govbiz.core.applicationpreparation.domain.ApplicationInterpretationInputSnapshot
import ai.govbiz.core.applicationpreparation.domain.NewConfirmedApplicationFact
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRevisionConflictException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationSectionNotFoundException
import ai.govbiz.core.applicationpreparation.facade.AiApplicationPreparationFacade
import ai.govbiz.core.applicationpreparation.controller.exception.InvalidApplicationPreparationInputException
import ai.govbiz.core.applicationpreparation.repository.ApplicationPreparationInputRepository
import ai.govbiz.core.applicationpreparation.repository.ApplicationPreparationRepository
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationPreparationDetailResult
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationPreparationListItemResult
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationPreparationPageResult
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationInterpretationResult
import ai.govbiz.core.supportprogram.repository.SavedSupportProgramRepository
import org.springframework.stereotype.Service
import ai.govbiz.core.applicationpreparation.domain.ApplicationDraftInput
import ai.govbiz.core.applicationpreparation.domain.ApplicationContentVersion
import ai.govbiz.core.applicationpreparation.repository.ApplicationPreparationContentRepository

/** 세션 계정의 신청 준비와 문항별 질문·사용자 확인 입력 흐름을 담당합니다. */
@Service
class ApplicationPreparationService(
    private val repository: ApplicationPreparationRepository,
    private val forms: ApplicationFormService,
    private val inputs: ApplicationPreparationInputRepository,
    private val ai: AiApplicationPreparationFacade,
    private val contents: ApplicationPreparationContentRepository,
    private val savedSupportPrograms: SavedSupportProgramRepository,
) {
    fun supportedForms(account: Account) = forms.listSupported().also { require(account.id > 0) }

    @org.springframework.transaction.annotation.Transactional
    fun create(account: Account, draft: NewApplicationPreparation): ApplicationPreparationDetailResult {
        val form = forms.requireSupported(
            draft.sourceCode,
            draft.sourceProgramId,
            draft.formVersionId,
            draft.serviceField,
        )
        // 신청 준비를 시작한 공고는 관심 공고함에도 담아 둡니다. 진행 관리와 관심 공고함이 같은 목록을 보게 하는
        // 규칙이며, 이미 담겨 있거나 더 이상 노출되지 않는 공고면 아무것도 바꾸지 않습니다.
        savedSupportPrograms.saveIfPresent(account.id, draft.sourceCode, draft.sourceProgramId)
        return ApplicationPreparationDetailResult(repository.create(account.id, draft), form)
    }

    fun findOwned(account: Account, preparationId: Long): ApplicationPreparationDetailResult {
        val preparation = repository.findOwned(account.id, preparationId) ?: throw ApplicationPreparationNotFoundException()
        return ApplicationPreparationDetailResult(
            preparation,
            forms.requireVersion(preparation.draft.formVersionId),
            inputs.listOwnedFacts(account.id, preparationId),
            contents.listOwned(account.id, preparationId),
        )
    }

    fun listOwned(account: Account, beforeId: Long?, size: Int): ApplicationPreparationPageResult {
        require(size in 1..50 && (beforeId == null || beforeId > 0))
        val rows = repository.listOwned(account.id, beforeId, size + 1)
        val items = rows.take(size).map { summary ->
            ApplicationPreparationListItemResult(summary, forms.requireVersion(summary.formVersionId))
        }
        return ApplicationPreparationPageResult(items, items.lastOrNull()?.preparation?.id?.takeIf { rows.size > size })
    }

    fun deleteOwned(account: Account, preparationId: Long) {
        if (!repository.deleteOwned(account.id, preparationId)) throw ApplicationPreparationNotFoundException()
    }

    fun updateProgress(
        account: Account,
        preparationId: Long,
        expectedProgressRevision: Long,
        progressStage: ApplicationProgressStage,
    ): ApplicationPreparationDetailResult = when (
        val result = repository.updateProgressOwned(account.id, preparationId, expectedProgressRevision, progressStage)
    ) {
        ApplicationProgressUpdateResult.NotFound -> throw ApplicationPreparationNotFoundException()
        ApplicationProgressUpdateResult.RevisionConflict -> throw ApplicationPreparationRevisionConflictException()
        is ApplicationProgressUpdateResult.Updated -> ApplicationPreparationDetailResult(
            result.preparation,
            forms.requireVersion(result.preparation.draft.formVersionId),
            inputs.listOwnedFacts(account.id, preparationId),
            contents.listOwned(account.id, preparationId),
        )
    }

    fun interpret(
        account: Account,
        preparationId: Long,
        sectionKey: String,
        expectedRevision: Long,
        requestKey: String,
        userMessage: String,
    ): ApplicationInterpretationResult {
        if (expectedRevision <= 0 || !REQUEST_KEY.matches(requestKey) || userMessage.isBlank() ||
            userMessage != userMessage.trim() || userMessage.codePointCount(0, userMessage.length) > 4000) {
            throw InvalidApplicationPreparationInputException()
        }
        val preparation = repository.findOwned(account.id, preparationId) ?: throw ApplicationPreparationNotFoundException()
        val form = forms.requireVersion(preparation.draft.formVersionId)
        requireSection(form, sectionKey)
        val currentFacts = inputs.listOwnedFacts(account.id, preparationId).filter { it.sectionKey == sectionKey }
        val snapshot = ApplicationInterpretationInputSnapshot(
            inputRevision = expectedRevision,
            formVersionId = preparation.draft.formVersionId,
            sectionKey = sectionKey,
            serviceField = preparation.draft.serviceField,
            userMessage = userMessage,
            currentFacts = currentFacts,
        )
        val reservation = inputs.reserveInterpretation(account.id, preparationId, expectedRevision, requestKey, snapshot)
        reservation.run.output?.let { return ApplicationInterpretationResult(reservation.run.id, it) }
        return try {
            val output = ai.interpret(preparationId, form, snapshot)
            inputs.succeed(reservation.run.id, output)
            ApplicationInterpretationResult(reservation.run.id, output)
        } catch (error: RuntimeException) {
            inputs.fail(reservation.run.id, "AI_EXECUTION_FAILED")
            throw error
        }
    }

    fun replaceInputs(
        account: Account,
        preparationId: Long,
        sectionKey: String,
        expectedRevision: Long,
        facts: List<NewConfirmedApplicationFact>,
    ): ApplicationPreparationDetailResult {
        if (expectedRevision <= 0 || facts.size > 20 || facts.map { it.fieldKey }.distinct().size != facts.size) {
            throw InvalidApplicationPreparationInputException()
        }
        val preparation = repository.findOwned(account.id, preparationId) ?: throw ApplicationPreparationNotFoundException()
        val form = forms.requireVersion(preparation.draft.formVersionId)
        val section = requireSection(form, sectionKey)
        if (!facts.all { fact -> section.fields.any { it.key == fact.fieldKey } }) {
            throw InvalidApplicationPreparationInputException()
        }
        when (inputs.replaceOwned(account.id, preparationId, sectionKey, expectedRevision, facts)) {
            ApplicationInputReplaceResult.NotFound -> throw ApplicationPreparationNotFoundException()
            ApplicationInputReplaceResult.RevisionConflict -> throw ApplicationPreparationRevisionConflictException()
            is ApplicationInputReplaceResult.Updated -> Unit
        }
        return findOwned(account, preparationId)
    }

    private fun requireSection(form: ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest, sectionKey: String) =
        form.sections.find { it.key == sectionKey } ?: throw ApplicationPreparationSectionNotFoundException()

    fun generateDraft(account: Account, preparationId: Long, sectionKey: String, expectedRevision: Long, expectedVersionId: Long?, requestKey: String): ApplicationPreparationDetailResult {
        if (expectedRevision <= 0 || (expectedVersionId != null && expectedVersionId <= 0) || !REQUEST_KEY.matches(requestKey)) {
            throw InvalidApplicationPreparationInputException()
        }
        val detail = findOwned(account, preparationId)
        val section = requireSection(detail.form, sectionKey)
        val facts = ApplicationContentVersion.snapshot(detail.facts.filter { it.sectionKey == sectionKey })
        val input = ApplicationDraftInput(preparationId, expectedRevision, detail.form.formVersionId, detail.preparation.draft.serviceField.name, section, facts)
        // 완료 요청의 재시도는 입력이 바뀌었더라도 재실행하지 않는다. 새 요청의 누락 검증은 예약 전에 수행한다.
        if (detail.preparation.inputRevision == expectedRevision && section.fields.any { field -> field.required && facts.none { it.fieldKey == field.key } }) {
            throw InvalidApplicationPreparationInputException()
        }
        val reservation = contents.reserve(account.id, input, expectedVersionId, requestKey)
        if (reservation.completed) {
            if (!reservation.applied) throw ApplicationPreparationRevisionConflictException()
            return findOwned(account, preparationId)
        }
        val applied = try {
            contents.complete(account.id, reservation.id, input, expectedVersionId, ai.draft(input))
        } catch (error: RuntimeException) {
            contents.fail(reservation.id)
            throw error
        }
        if (!applied) throw ApplicationPreparationRevisionConflictException()
        return findOwned(account, preparationId)
    }

    fun saveContent(account: Account, preparationId: Long, sectionKey: String, expectedRevision: Long, expectedVersionId: Long, content: String): ApplicationPreparationDetailResult {
        if (expectedRevision <= 0 || expectedVersionId <= 0 || content.isBlank() || content.length > 15000 || content.any { Character.isISOControl(it) && it !in "\n\r\t" }) {
            throw InvalidApplicationPreparationInputException()
        }
        contents.save(account.id, preparationId, sectionKey, expectedRevision, expectedVersionId, content)
        return findOwned(account, preparationId)
    }

    fun confirmContent(account: Account, preparationId: Long, sectionKey: String, expectedRevision: Long, expectedVersionId: Long): ApplicationPreparationDetailResult {
        if (expectedRevision <= 0 || expectedVersionId <= 0) throw InvalidApplicationPreparationInputException()
        contents.confirm(account.id, preparationId, sectionKey, expectedRevision, expectedVersionId)
        return findOwned(account, preparationId)
    }

    private companion object {
        val REQUEST_KEY = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    }
}
