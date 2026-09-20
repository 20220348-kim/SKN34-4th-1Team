package ai.govbiz.core.applicationpreparation.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.applicationpreparation.domain.ApplicationServiceField
import ai.govbiz.core.applicationpreparation.domain.ApplicationProgressStage
import ai.govbiz.core.applicationpreparation.domain.ApplicationProgressUpdateResult
import ai.govbiz.core.applicationpreparation.domain.NewApplicationPreparation
import ai.govbiz.core.applicationpreparation.domain.ApplicationFactStatus
import ai.govbiz.core.applicationpreparation.domain.ApplicationInputReplaceResult
import ai.govbiz.core.applicationpreparation.domain.NewConfirmedApplicationFact
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentUnfilledAnswer
import java.time.LocalDateTime
import java.util.UUID
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate
import ai.govbiz.core.applicationpreparation.domain.ApplicationContentVersion
import ai.govbiz.core.applicationpreparation.domain.ApplicationDraftInput
import ai.govbiz.core.applicationpreparation.domain.ApplicationDraftOutput
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormSectionDefinition
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormFieldDefinition
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRevisionConflictException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRunConflictException

@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.ai-service.base-url=http://127.0.0.1:1",
    "app.bizinfo.sync.enabled=false",
    "app.support-program-index.enabled=false",
])
@Import(MySqlTestContainerConfig::class)
class ApplicationPreparationRepositoryIntegrationTest {
    @Autowired private lateinit var repository: ApplicationPreparationRepository
    @Autowired private lateinit var inputs: ApplicationPreparationInputRepository
    @Autowired private lateinit var contents: ApplicationPreparationContentRepository
    @Autowired private lateinit var documents: ApplicationDocumentRepository
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    private var ownerId = 0L
    private var otherId = 0L

    @BeforeEach
    fun prepare() {
        jdbc.update("DELETE FROM application_preparation")
        ownerId = createAccount()
        otherId = createAccount()
    }

    @Test
    fun roundTripsEveryServiceFieldAndKeepsOwnerIsolation() {
        val created = ApplicationServiceField.entries.map { field -> repository.create(ownerId, draft(field)) }
        assertTrue(created.all {
            it.inputRevision == 1L && it.ownerAccountId == ownerId &&
                it.progressStage == ApplicationProgressStage.PREPARING && it.progressRevision == 1L
        })
        assertEquals(ApplicationServiceField.entries, repository.listOwned(ownerId, null, 51).reversed().map { it.serviceField })
        assertNull(repository.findOwned(otherId, created.first().id))
        assertEquals(created.first(), repository.findOwned(ownerId, created.first().id))
    }

    @Test
    fun updatesProgressWithOwnerAndIndependentRevisionProtection() {
        val created = repository.create(ownerId, draft())
        val updated = repository.updateProgressOwned(
            ownerId,
            created.id,
            created.progressRevision,
            ApplicationProgressStage.DOCUMENT_REVIEW,
        ) as ApplicationProgressUpdateResult.Updated

        assertEquals(ApplicationProgressStage.DOCUMENT_REVIEW, updated.preparation.progressStage)
        assertEquals(2L, updated.preparation.progressRevision)
        assertEquals(1L, updated.preparation.inputRevision)
        assertEquals(
            ApplicationProgressUpdateResult.RevisionConflict,
            repository.updateProgressOwned(ownerId, created.id, 1, ApplicationProgressStage.SELECTED),
        )
        assertEquals(
            ApplicationProgressUpdateResult.NotFound,
            repository.updateProgressOwned(otherId, created.id, 2, ApplicationProgressStage.SELECTED),
        )
    }

    @Test
    fun paginatesOnlyTheOwnerByStableDescendingId() {
        val oldest = repository.create(ownerId, draft()).id
        repository.create(otherId, draft())
        val middle = repository.create(ownerId, draft()).id
        val newest = repository.create(ownerId, draft()).id
        val first = repository.listOwned(ownerId, null, 2)
        val second = repository.listOwned(ownerId, middle, 2)
        assertEquals(listOf(newest, middle), first.map { it.id })
        assertEquals(listOf(oldest), second.map { it.id })
    }

    @Test
    fun enforcesOwnerFieldFormAndRevisionConstraintsInMysql() {
        assertThrows(DataAccessException::class.java) { repository.create(Long.MAX_VALUE, draft()) }
        val created = repository.create(ownerId, draft())
        assertThrows(DataAccessException::class.java) {
            jdbc.update("UPDATE application_preparation SET service_field = 'INVALID' WHERE id = ?", created.id)
        }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("UPDATE application_preparation SET input_revision = 0 WHERE id = ?", created.id)
        }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("UPDATE application_preparation SET progress_stage = 'INVALID' WHERE id = ?", created.id)
        }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("UPDATE application_preparation SET progress_revision = 0 WHERE id = ?", created.id)
        }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("UPDATE application_preparation SET form_version_id = '잘못된-버전' WHERE id = ?", created.id)
        }
        assertEquals(created, repository.findOwned(ownerId, created.id))
    }

    @Test
    fun replacesKoreanSpecialCharacterAndUnknownFactsInOneRevision() {
        val created = repository.create(ownerId, draft())
        val result = inputs.replaceOwned(ownerId, created.id, "company-overview", 1, listOf(
            NewConfirmedApplicationFact("company-name", ApplicationFactStatus.PROVIDED, "새봄테크 & 연구소", "업체명은 ‘새봄테크 & 연구소’입니다."),
            NewConfirmedApplicationFact("contact-person", ApplicationFactStatus.UNKNOWN, null, "담당자는 아직 미정입니다."),
        ))
        assertEquals(ApplicationInputReplaceResult.Updated(2), result)
        val facts = inputs.listOwnedFacts(ownerId, created.id)
        assertEquals(listOf("새봄테크 & 연구소", null), facts.map { it.value })
        assertEquals(listOf(ApplicationFactStatus.PROVIDED, ApplicationFactStatus.UNKNOWN), facts.map { it.status })
        assertEquals(2L, repository.findOwned(ownerId, created.id)!!.inputRevision)
        assertTrue(inputs.listOwnedFacts(otherId, created.id).isEmpty())
    }

    @Test
    fun duplicateSnapshotRollsBackDeletedFactsAndRevision() {
        val created = repository.create(ownerId, draft())
        val original = NewConfirmedApplicationFact("company-name", ApplicationFactStatus.PROVIDED, "기존 업체", "기존 답변")
        inputs.replaceOwned(ownerId, created.id, "company-overview", 1, listOf(original))
        assertThrows(DataAccessException::class.java) {
            inputs.replaceOwned(ownerId, created.id, "company-overview", 2, listOf(original, original))
        }
        assertEquals("기존 업체", inputs.listOwnedFacts(ownerId, created.id).single().value)
        assertEquals(2L, repository.findOwned(ownerId, created.id)!!.inputRevision)
    }

    @Test
    fun deletesOnlyTheOwnedPreparationAndCascadesItsConfirmedFacts() {
        val created = repository.create(ownerId, draft())
        inputs.replaceOwned(ownerId, created.id, "company-overview", 1, listOf(
            NewConfirmedApplicationFact("company-name", ApplicationFactStatus.PROVIDED, "삭제할 업체", "삭제할 답변"),
        ))

        assertTrue(!repository.deleteOwned(otherId, created.id))
        assertTrue(repository.deleteOwned(ownerId, created.id))
        assertNull(repository.findOwned(ownerId, created.id))
        assertEquals(0, jdbc.queryForObject(
            "SELECT COUNT(*) FROM application_preparation_fact WHERE preparation_id = ?",
            Int::class.java,
            created.id,
        ))
    }

    private fun createAccount(): Long = accounts.createAccount(
        NewAccount("application-${UUID.randomUUID()}@example.test", "test-password-hash", LocalDateTime.of(2026, 9, 11, 0, 0)),
    ).id

    private fun draftInput(): ApplicationDraftInput {
        val created = repository.create(ownerId, draft())
        inputs.replaceOwned(ownerId, created.id, "company-overview", 1, listOf(
            NewConfirmedApplicationFact("company-name", ApplicationFactStatus.PROVIDED, "새봄 & 연구소 😀", "회사명"),
            NewConfirmedApplicationFact("contact-person", ApplicationFactStatus.UNKNOWN, null, "미정"),
        ))
        return ApplicationDraftInput(created.id, 2, created.draft.formVersionId, "TECHNICAL_SUPPORT",
            ApplicationFormSectionDefinition("company-overview", "기업 개요", "문단 1", "기업 정보", listOf(
                ApplicationFormFieldDefinition("company-name", "기업명", "공식 명칭", true),
                ApplicationFormFieldDefinition("contact-person", "담당자", "이름", true),
            )), ApplicationContentVersion.snapshot(inputs.listOwnedFacts(ownerId, created.id)))
    }

    @Test
    fun storesNativeFilesByRevisionWithOwnerIsolationConflictRollbackAndCascadeDeletion() {
        val preparation = repository.create(ownerId, draft())
        val file = documents.save(ownerId, preparation.id, 1, "신청서 & 초안.hwpx", "application/hwp+zip", byteArrayOf(80, 75, 3, 4), "a".repeat(64), emptyList())
        assertEquals(file.id, documents.save(ownerId, preparation.id, 1, "중복.hwpx", "application/hwp+zip", byteArrayOf(1), "a".repeat(64), emptyList()).id)
        assertNull(documents.findOwned(otherId, preparation.id, file.id))
        assertEquals("신청서 & 초안.hwpx", documents.findRevision(ownerId, preparation.id, 1)!!.fileName)
        org.junit.jupiter.api.Assertions.assertArrayEquals(file.bytes, documents.findOwned(ownerId, preparation.id, file.id)!!.bytes)
        assertThrows(ApplicationPreparationRevisionConflictException::class.java) {
            documents.save(ownerId, preparation.id, 2, "실패.hwpx", "application/hwp+zip", byteArrayOf(1), "a".repeat(64), emptyList())
        }
        assertNull(documents.findRevision(ownerId, preparation.id, 2))
        repository.deleteOwned(ownerId, preparation.id)
        assertNull(documents.findOwned(ownerId, preparation.id, file.id))
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM application_document_file WHERE preparation_id = ?", Int::class.java, preparation.id))
    }

    private fun draftOutput(content: String = "새봄 & 연구소 😀\n담당자: 미정") =
        ApplicationDraftOutput(content, "test-model", "sha256:" + "a".repeat(64), listOf("company-name"))

    @Test
    fun fingerprintsPreserveHistoryDeduplicateAndRecheckOwnershipAndRevision() {
        val preparation = repository.create(ownerId, draft())
        val first = documents.save(ownerId, preparation.id, 1, "가상기업.pdf", "application/pdf", byteArrayOf(1), "a".repeat(64), emptyList(), fingerprint = "1".repeat(64), evidence = mapOf("planHash" to "b".repeat(64), "targets" to listOf("회사 & 연구소")))
        val repeated = documents.save(ownerId, preparation.id, 1, "중복.pdf", "application/pdf", byteArrayOf(2), "a".repeat(64), emptyList(), fingerprint = "1".repeat(64))
        assertEquals(first.id, repeated.id)
        val updatedEngine = documents.save(ownerId, preparation.id, 1, "새엔진.pdf", "application/pdf", byteArrayOf(3), "a".repeat(64), emptyList(), fingerprint = "2".repeat(64))
        assertTrue(first.id != updatedEngine.id)
        assertEquals(first.id, documents.findOwned(ownerId, preparation.id, first.id)!!.id)
        assertNull(documents.findFingerprint(otherId, preparation.id, 1, "1".repeat(64)))
        assertThrows(ApplicationPreparationRevisionConflictException::class.java) {
            documents.save(ownerId, preparation.id, 2, "이전.pdf", "application/pdf", byteArrayOf(4), "a".repeat(64), emptyList(), fingerprint = "3".repeat(64))
        }
        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM application_document_file WHERE preparation_id = ?", Int::class.java, preparation.id))
        assertEquals("회사 & 연구소", jdbc.queryForObject("SELECT JSON_UNQUOTE(JSON_EXTRACT(placements_json, '$.mcp.targets[0]')) FROM application_document_file WHERE id = ?", String::class.java, first.id))
    }

    @Test
    fun preservesTheGeneratedRevisionUnfilledAnswerSnapshotAndDoesNotInferLegacyMetadata() {
        val preparation = repository.create(ownerId, draft())
        val omitted = ApplicationDocumentUnfilledAnswer("company:consent", "기업 개요 / 개인정보 동의", "동의함", "INPUT_LOCATION_NOT_FOUND")
        val file = documents.save(ownerId, preparation.id, 1, "부분초안.pdf", "application/pdf", byteArrayOf(1), "a".repeat(64), emptyList(),
            fingerprint = "4".repeat(64), filledAnswerCount = 1, unfilledAnswers = listOf(omitted))
        val restored = documents.findOwned(ownerId, preparation.id, file.id)!!
        assertEquals(1, restored.filledAnswerCount)
        assertEquals(listOf(omitted), restored.unfilledAnswers)
        assertEquals(listOf(file.id), documents.listOwned(ownerId, preparation.id).map { it.id })
        assertEquals(emptyList<Long>(), documents.listOwned(otherId, preparation.id).map { it.id })

        val legacy = documents.save(ownerId, preparation.id, 1, "이전.pdf", "application/pdf", byteArrayOf(2), "a".repeat(64), emptyList())
        assertNull(documents.findOwned(ownerId, preparation.id, legacy.id)!!.filledAnswerCount)
        assertEquals(emptyList<ApplicationDocumentUnfilledAnswer>(), documents.findOwned(ownerId, preparation.id, legacy.id)!!.unfilledAnswers)
    }

    @Test
    fun regeneratesLegacyFilesWithoutLosingTheirOwnedDownloads() {
        val preparation = repository.create(ownerId, draft())
        val legacy = documents.save(ownerId, preparation.id, 1, "이전.hwp", "application/x-hwp", byteArrayOf(1), "a".repeat(64), emptyList())
        jdbc.update("UPDATE application_document_file SET generator_version = 4 WHERE id = ?", legacy.id)
        assertNull(documents.findRevision(ownerId, preparation.id, 1))
        val current = documents.save(ownerId, preparation.id, 1, "수정.hwp", "application/x-hwp", byteArrayOf(2), "a".repeat(64), emptyList(), listOf("s0-p1"))
        assertTrue(current.id != legacy.id)
        assertEquals(current.id, documents.findRevision(ownerId, preparation.id, 1)!!.id)
        assertEquals(5, jdbc.queryForObject("SELECT generator_version FROM application_document_file WHERE id = ?", Int::class.java, current.id))
        assertEquals(legacy.id, documents.findOwned(ownerId, preparation.id, legacy.id)!!.id)
        assertEquals("s0-p1", jdbc.queryForObject("SELECT JSON_UNQUOTE(JSON_EXTRACT(placements_json, '$.clearExampleTargetIds[0]')) FROM application_document_file WHERE id = ?", String::class.java, current.id))
    }

    @Test
    fun preservesVersionsConfirmationAndSectionSpecificInputFreshness() {
        val input = draftInput()
        val key = UUID.randomUUID().toString()
        val run = contents.reserve(ownerId, input, null, key)
        assertThrows(ApplicationPreparationRunConflictException::class.java) { contents.reserve(ownerId, input, null, key) }
        assertTrue(contents.complete(ownerId, run.id, input, null, draftOutput()))
        val first = contents.listOwned(ownerId, input.preparationId).single()
        assertNull(first.confirmedAt)
        assertEquals(input.facts, first.facts)
        assertTrue(contents.reserve(ownerId, input, null, key).completed)
        contents.save(ownerId, input.preparationId, input.section.key, 2, first.id, "사용자가 고친 문안 😀")
        val second = contents.listOwned(ownerId, input.preparationId).first()
        assertEquals("USER_EDIT", second.kind)
        assertThrows(ApplicationPreparationRevisionConflictException::class.java) {
            contents.save(ownerId, input.preparationId, input.section.key, 2, first.id, "덮어쓰기")
        }
        contents.confirm(ownerId, input.preparationId, input.section.key, 2, second.id)
        val confirmed = contents.listOwned(ownerId, input.preparationId).first()
        assertTrue(confirmed.confirmedAt != null)
        inputs.replaceOwned(ownerId, input.preparationId, "voucher-plan", 2, emptyList())
        assertTrue(!confirmed.isStale(inputs.listOwnedFacts(ownerId, input.preparationId)))
        inputs.replaceOwned(ownerId, input.preparationId, input.section.key, 3, emptyList())
        assertTrue(confirmed.isStale(inputs.listOwnedFacts(ownerId, input.preparationId)))
        assertThrows(ApplicationPreparationRevisionConflictException::class.java) {
            contents.confirm(ownerId, input.preparationId, input.section.key, 4, second.id)
        }
        assertEquals(first, contents.listOwned(ownerId, input.preparationId).last())
        assertTrue(contents.listOwned(otherId, input.preparationId).isEmpty())
        assertThrows(ApplicationPreparationNotFoundException::class.java) { contents.save(otherId, input.preparationId, input.section.key, 4, second.id, "다른 계정") }
        assertThrows(ApplicationPreparationNotFoundException::class.java) { contents.confirm(otherId, input.preparationId, input.section.key, 4, second.id) }
        assertThrows(ApplicationPreparationNotFoundException::class.java) { contents.reserve(otherId, input, null, UUID.randomUUID().toString()) }
        repository.deleteOwned(ownerId, input.preparationId)
        assertTrue(contents.listOwned(ownerId, input.preparationId).isEmpty())
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM application_preparation_draft_run WHERE preparation_id = ?", Int::class.java, input.preparationId))
    }

    @Test
    fun lateDraftCannotOverwriteChangedInputsOrUserContentAndCompletionRollsBackAtomically() {
        val input = draftInput()
        val run = contents.reserve(ownerId, input, null, UUID.randomUUID().toString())
        assertThrows(DataAccessException::class.java) { contents.complete(ownerId, run.id, input, null, draftOutput("가".repeat(15001))) }
        assertEquals("RUNNING", jdbc.queryForObject("SELECT run_status FROM application_preparation_draft_run WHERE id = ?", String::class.java, run.id))
        assertTrue(contents.listOwned(ownerId, input.preparationId).isEmpty())
        assertTrue(contents.complete(ownerId, run.id, input, null, draftOutput()))
        val first = contents.listOwned(ownerId, input.preparationId).first()
        val concurrent = contents.reserve(ownerId, input, first.id, UUID.randomUUID().toString())
        contents.save(ownerId, input.preparationId, input.section.key, 2, first.id, "생성 중 사용자 수정")
        assertTrue(!contents.complete(ownerId, concurrent.id, input, first.id, draftOutput()))
        val latest = contents.listOwned(ownerId, input.preparationId).first()
        assertEquals("생성 중 사용자 수정", latest.content)
        val changed = contents.reserve(ownerId, input, latest.id, UUID.randomUUID().toString())
        inputs.replaceOwned(ownerId, input.preparationId, input.section.key, 2, emptyList())
        assertTrue(!contents.complete(ownerId, changed.id, input, latest.id, draftOutput()))
        assertEquals(2, contents.listOwned(ownerId, input.preparationId).size)
    }

    @Test
    fun failedDraftKeepsCurrentContentAndRequiresANewRequestKey() {
        val input = draftInput()
        val key = UUID.randomUUID().toString()
        val run = contents.reserve(ownerId, input, null, key)
        contents.fail(run.id)
        assertThrows(ApplicationPreparationRunConflictException::class.java) { contents.reserve(ownerId, input, null, key) }
        assertTrue(contents.listOwned(ownerId, input.preparationId).isEmpty())
        assertTrue(!contents.reserve(ownerId, input, null, UUID.randomUUID().toString()).completed)
    }

    private fun draft(field: ApplicationServiceField = ApplicationServiceField.TECHNICAL_SUPPORT) = NewApplicationPreparation(
        "BIZINFO",
        "PBLN_000000000118979",
        "bizinfo-pbln-000000000118979-innovation-voucher-2026-v1",
        field,
    )
}
