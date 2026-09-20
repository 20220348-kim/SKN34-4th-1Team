package ai.govbiz.core.combinationreview.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.combinationreview.domain.CombinationReviewDraft
import ai.govbiz.core.combinationreview.domain.CombinationReviewInput
import ai.govbiz.core.combinationreview.domain.ParticipationAnswer
import ai.govbiz.core.combinationreview.domain.ProgramExecutionStatus
import ai.govbiz.core.combinationreview.domain.ProgramParticipation
import ai.govbiz.core.combinationreview.domain.ReviewProgramIdentity
import ai.govbiz.core.combinationreview.domain.SelectedReviewProgram
import ai.govbiz.core.combinationreview.domain.StoredCombinationReview
import java.time.LocalDateTime
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.dao.DataAccessException
import org.springframework.dao.DuplicateKeyException
import org.springframework.jdbc.core.JdbcTemplate

@SpringBootTest(
    properties = [
        "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
        "app.ai-service.base-url=http://127.0.0.1:1",
        "app.ai-service.connect-timeout=10ms",
        "app.ai-service.read-timeout=10ms",
        "app.bizinfo.sync.enabled=false",
        "app.support-program-index.enabled=false",
    ],
)
@Import(MySqlTestContainerConfig::class)
class CombinationReviewRepositoryIntegrationTest {
    @Autowired private lateinit var repository: CombinationReviewRepository
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    private var ownerId: Long = 0
    private var otherId: Long = 0

    @BeforeEach
    fun prepareOwners() {
        jdbc.update("DELETE FROM combination_review")
        ownerId = createAccount()
        otherId = createAccount()
    }

    @Test
    fun roundTripsKoreanSpecialCharactersNullSubProgramsAndIndependentFacts() {
        val facts = ProgramParticipation(
            applicationSubmitted = ParticipationAnswer.YES,
            selected = ParticipationAnswer.YES,
            commitmentSubmitted = ParticipationAnswer.NO,
            executionStatus = ProgramExecutionStatus.NOT_STARTED,
            fundingReceived = ParticipationAnswer.UNKNOWN,
        )
        val draft = CombinationReviewDraft(
            "창업 \"일반형\" & 딥테크 🚀 검토",
            CombinationReviewInput(
                listOf(
                    SelectedReviewProgram(ReviewProgramIdentity("BIZINFO", "공고 A:/?&=1"), facts),
                    SelectedReviewProgram(ReviewProgramIdentity("KSTARTUP", "공고 A:/?&=1", "유형:가/나")),
                ),
            ),
        )
        val created = repository.create(ownerId, draft)
        assertTrue(created.id > 0)
        assertEquals(1L, created.inputRevision)
        assertSameSnapshot(created, requireNotNull(repository.findOwned(ownerId, created.id)))
        assertNull(repository.findOwned(ownerId, Long.MAX_VALUE))
    }

    @Test
    fun keepsDifferentSubProgramsAndProvidersUnderTheSameOriginalId() {
        val subPrograms = CombinationReviewInput(
            listOf(
                SelectedReviewProgram(ReviewProgramIdentity("BIZINFO", "same-id", "general")),
                SelectedReviewProgram(ReviewProgramIdentity("BIZINFO", "same-id", "deep-tech")),
            ),
        )
        val providers = CombinationReviewInput(
            listOf(
                SelectedReviewProgram(ReviewProgramIdentity("BIZINFO", "same-id")),
                SelectedReviewProgram(ReviewProgramIdentity("KSTARTUP", "same-id")),
            ),
        )
        val subProgramReview = repository.create(ownerId, CombinationReviewDraft("세부사업 비교", subPrograms))
        val providerReview = repository.create(ownerId, CombinationReviewDraft("제공처 비교", providers))
        assertEquals(subPrograms.programs, requireNotNull(repository.findOwned(ownerId, subProgramReview.id)).draft.input.programs)
        assertEquals(providers.programs, requireNotNull(repository.findOwned(ownerId, providerReview.id)).draft.input.programs)
        assertEquals(1, subPrograms.programPairs().size)
        assertEquals(1, providers.programPairs().size)
    }

    @Test
    fun doesNotCollapseCaseOrAccentDifferencesInSourceIds() {
        val caseReview = repository.create(ownerId, draft("대소문자 구분", "Case", "case"))
        val accentReview = repository.create(ownerId, draft("악센트 구분", "case", "cáse"))
        assertEquals(listOf("Case", "case"), requireNotNull(repository.findOwned(ownerId, caseReview.id)).draft.input.programs.map { it.identity.sourceProgramId })
        assertEquals(listOf("case", "cáse"), requireNotNull(repository.findOwned(ownerId, accentReview.id)).draft.input.programs.map { it.identity.sourceProgramId })
    }

    @Test
    fun acceptsTheUnicodeLengthBoundaryInMysql() {
        val longId = "가".repeat(254) + "🚀"
        val longTitle = "나".repeat(199) + "🚀"
        val created = repository.create(ownerId, draft(longTitle, longId, "other"))
        assertSameSnapshot(created, requireNotNull(repository.findOwned(ownerId, created.id)))
    }

    @Test
    fun replacesAllProgramsAndIncrementsRevisionWithoutChangingOwnershipOrCreationTime() {
        val created = repository.create(ownerId, draft("이전", "a", "b"))
        val replacement = draft("변경", "second", "first")
        assertTrue(repository.replaceOwned(ownerId, created.id, 1, replacement))
        val updated = requireNotNull(repository.findOwned(ownerId, created.id))
        assertEquals(created.id, updated.id)
        assertEquals(ownerId, updated.ownerAccountId)
        assertEquals(created.createdAt, updated.createdAt)
        assertEquals(2L, updated.inputRevision)
        assertEquals(replacement.title, updated.draft.title)
        assertEquals(replacement.input.programs, updated.draft.input.programs)
        assertEquals(2, programCount(created.id))
    }

    @Test
    fun hidesAndDoesNotModifyAnotherOwnersReview() {
        val created = repository.create(ownerId, draft())
        assertNull(repository.findOwned(otherId, created.id))
        assertFalse(repository.replaceOwned(otherId, created.id, 1, draft("다른 사용자", "x", "y")))
        assertSameSnapshot(created, requireNotNull(repository.findOwned(ownerId, created.id)))
    }

    @Test
    fun deletesOnlyTheOwnedReviewAndCascadesItsPrograms() {
        val created = repository.create(ownerId, draft())
        assertFalse(repository.deleteOwned(otherId, created.id))
        assertEquals(2, programCount(created.id))
        assertTrue(repository.deleteOwned(ownerId, created.id))
        assertNull(repository.findOwned(ownerId, created.id))
        assertEquals(0, programCount(created.id))
        assertFalse(repository.deleteOwned(ownerId, created.id))
    }

    @Test
    fun staleOrMissingReviewUpdatesLeaveTheCurrentSnapshotUntouched() {
        val created = repository.create(ownerId, draft())
        assertTrue(repository.replaceOwned(ownerId, created.id, 1, draft("최신", "x", "y")))
        val latest = requireNotNull(repository.findOwned(ownerId, created.id))
        assertFalse(repository.replaceOwned(ownerId, created.id, 1, draft("오래된 입력", "c", "d")))
        assertFalse(repository.replaceOwned(ownerId, Long.MAX_VALUE, 1, draft()))
        assertSameSnapshot(latest, requireNotNull(repository.findOwned(ownerId, created.id)))
    }

    @Test
    fun rejectsDuplicateIdentityEvenWhenSubProgramIsNullAtTheDatabase() {
        val created = repository.create(ownerId, draft())
        assertThrows(DuplicateKeyException::class.java) {
            jdbc.update(
                """INSERT INTO combination_review_program
                    (review_id, position, source_code, source_program_id, sub_program_id,
                     application_submitted, selected, commitment_submitted, agreement_signed, execution_status, funding_received)
                    SELECT review_id, 2, source_code, source_program_id, sub_program_id,
                           application_submitted, selected, commitment_submitted, agreement_signed, execution_status, funding_received
                    FROM combination_review_program WHERE review_id = ? AND position = 0""",
                created.id,
            )
        }
        assertEquals(2, programCount(created.id))
    }

    @Test
    fun enforcesForeignKeysForOwnersAndPrograms() {
        assertThrows(DataAccessException::class.java) { repository.create(Long.MAX_VALUE, draft()) }
        val created = repository.create(ownerId, draft())
        assertThrows(DataAccessException::class.java) {
            jdbc.update("UPDATE combination_review_program SET review_id = ? WHERE review_id = ?", Long.MAX_VALUE, created.id)
        }
        assertSameSnapshot(created, requireNotNull(repository.findOwned(ownerId, created.id)))
    }

    @Test
    fun enforcesStatusPositionAndRevisionConstraintsAtTheDatabase() {
        val created = repository.create(ownerId, draft())
        assertThrows(DataAccessException::class.java) {
            jdbc.update("UPDATE combination_review_program SET selected = 'yes' WHERE review_id = ?", created.id)
        }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("UPDATE combination_review_program SET execution_status = 'INVALID' WHERE review_id = ?", created.id)
        }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("UPDATE combination_review_program SET position = 3 WHERE review_id = ? AND position = 1", created.id)
        }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("UPDATE combination_review SET input_revision = 0 WHERE id = ?", created.id)
        }
        assertSameSnapshot(created, requireNotNull(repository.findOwned(ownerId, created.id)))
    }

    @Test
    fun rollsBackTheParentAndFirstProgramWhenTheSecondInsertFails() {
        withRejectedProgram {
            assertThrows(DataAccessException::class.java) { repository.create(ownerId, draft("실패", "inserted-first", "reject-write")) }
        }
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM combination_review WHERE owner_account_id = ?", Int::class.java, ownerId))
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM combination_review_program", Int::class.java))
    }

    @Test
    fun rollsBackTitleRevisionDeletionAndInsertionsWhenReplacementFails() {
        val before = repository.create(ownerId, draft("원래 입력", "a", "b"))
        withRejectedProgram {
            assertThrows(DataAccessException::class.java) {
                repository.replaceOwned(ownerId, before.id, 1, draft("실패할 변경", "inserted-first", "reject-write"))
            }
        }
        assertSameSnapshot(before, requireNotNull(repository.findOwned(ownerId, before.id)))
        assertEquals(2, programCount(before.id))
    }

    @Test
    fun concurrentUpdatesOfTheSameRevisionHaveExactlyOneWinner() {
        val created = repository.create(ownerId, draft())
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val requests = listOf("left", "right").map { label ->
                pool.submit<Pair<String, Boolean>> {
                    check(start.await(30, TimeUnit.SECONDS))
                    label to repository.replaceOwned(ownerId, created.id, 1, draft(label, "$label-a", "$label-b"))
                }
            }
            start.countDown()
            val results = requests.map { it.get(30, TimeUnit.SECONDS) }
            assertEquals(1, results.count { it.second })
            val winner = results.single { it.second }.first
            val stored = requireNotNull(repository.findOwned(ownerId, created.id))
            assertEquals(2L, stored.inputRevision)
            assertEquals(winner, stored.draft.title)
            assertEquals(listOf("$winner-a", "$winner-b"), stored.draft.input.programs.map { it.identity.sourceProgramId })
        } finally {
            pool.shutdownNow()
        }
    }

    @Test
    fun readsConsistentParentAndProgramSnapshotsWhileAnotherTransactionUpdates() {
        val created = repository.create(ownerId, draft("v1", "v1-a", "v1-b"))
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val writer = pool.submit {
                check(start.await(30, TimeUnit.SECONDS))
                for (revision in 1L..12L) {
                    val next = "v${revision + 1}"
                    assertTrue(repository.replaceOwned(ownerId, created.id, revision, draft(next, "$next-a", "$next-b")))
                }
            }
            val reader = pool.submit {
                check(start.await(30, TimeUnit.SECONDS))
                repeat(30) {
                    val snapshot = requireNotNull(repository.findOwned(ownerId, created.id))
                    assertEquals("v${snapshot.inputRevision}", snapshot.draft.title)
                    assertEquals(
                        listOf("${snapshot.draft.title}-a", "${snapshot.draft.title}-b"),
                        snapshot.draft.input.programs.map { it.identity.sourceProgramId },
                    )
                }
            }
            start.countDown()
            writer.get(60, TimeUnit.SECONDS)
            reader.get(60, TimeUnit.SECONDS)
        } finally {
            pool.shutdownNow()
        }
    }

    /** 테스트 DB에만 실패 조건을 추가해 실제 두 번째 SQL 실패와 Repository transaction rollback을 확인한다. */
    private fun withRejectedProgram(action: () -> Unit) {
        jdbc.execute("ALTER TABLE combination_review_program ADD CONSTRAINT test_reject_program CHECK (source_program_id <> 'reject-write')")
        try {
            action()
        } finally {
            jdbc.execute("ALTER TABLE combination_review_program DROP CHECK test_reject_program")
        }
    }

    private fun createAccount(): Long = accounts.createAccount(
        NewAccount("review-${UUID.randomUUID()}@example.test", "test-only-password-hash", LocalDateTime.of(2026, 9, 9, 9, 0)),
    ).id

    private fun programCount(id: Long): Int =
        requireNotNull(jdbc.queryForObject("SELECT COUNT(*) FROM combination_review_program WHERE review_id = ?", Int::class.java, id))

    private fun draft(title: String = "중복 지원 검토", vararg ids: String = arrayOf("a", "b")): CombinationReviewDraft =
        CombinationReviewDraft(title, CombinationReviewInput(ids.map { SelectedReviewProgram(ReviewProgramIdentity("BIZINFO", it)) }))

    private fun assertSameSnapshot(expected: StoredCombinationReview, actual: StoredCombinationReview) {
        assertEquals(expected.id, actual.id)
        assertEquals(expected.ownerAccountId, actual.ownerAccountId)
        assertEquals(expected.inputRevision, actual.inputRevision)
        assertEquals(expected.createdAt, actual.createdAt)
        assertEquals(expected.updatedAt, actual.updatedAt)
        assertEquals(expected.draft.title, actual.draft.title)
        assertEquals(expected.draft.input.programs, actual.draft.input.programs)
    }
}
