package ai.govbiz.core.planusage.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.planusage.PlanUsageTestHelper
import ai.govbiz.core.planusage.domain.AccountPlan
import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.domain.PlanSource
import ai.govbiz.core.planusage.domain.PlanTrial
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.domain.PlanUsageJob
import ai.govbiz.core.planusage.domain.PlanUsagePeriod
import ai.govbiz.core.planusage.domain.PlanUsageWindow
import ai.govbiz.core.planusage.repository.GuestPlanUsageRepository
import ai.govbiz.core.planusage.repository.PlanUsageRepository
import ai.govbiz.core.planusage.service.exception.PlanQuotaExceededException
import ai.govbiz.core.planusage.service.exception.PlanTrialException
import java.time.Clock
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.mockito.Mockito

class PlanUsageServiceTest {
    private val seoul = ZoneId.of("Asia/Seoul")
    // 서울 2026-10-08 21:00 — 하루 한도는 3시간 뒤, 월 한도는 11월 1일에 다시 채워집니다.
    private val clock = Clock.fixed(Instant.parse("2026-10-08T12:00:00Z"), seoul)
    private val repository = Mockito.mock(PlanUsageRepository::class.java)
    private val guests = Mockito.mock(GuestPlanUsageRepository::class.java)
    private val accounts = Mockito.mock(AccountRepository::class.java)
    private val service = PlanUsageService(repository, guests, clock, PlanUsageTestHelper.noTransactions(), accounts, "")
    private val member = Account(7, "member@example.test", AccountRole.USER, null, null, LocalDateTime.of(2026, 9, 1, 9, 0))
    private val verified = member.copy(emailVerifiedAt = LocalDateTime.of(2026, 9, 1, 9, 0))
    private val today = PlanUsageWindow.current(PlanUsagePeriod.DAY, ZonedDateTime.now(clock))
    private val thisMonth = PlanUsageWindow.current(PlanUsagePeriod.MONTH, ZonedDateTime.now(clock))

    @Test
    fun keepsTheUseWhenTheActionSucceedsAndGivesItBackWhenItFails() {
        Mockito.doReturn(AccountPlan.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(true).`when`(repository).reserve(7, PlanUsageFeature.AI_SEARCH, "2026-10-08", 10)

        assertEquals("ranked", service.consume(member, "192.0.2.1", PlanUsageFeature.AI_SEARCH) { "ranked" })
        Mockito.verify(repository, Mockito.never()).release(7, PlanUsageFeature.AI_SEARCH, "2026-10-08")

        val failure = IllegalStateException("model timeout")
        assertEquals(failure, assertThrows(IllegalStateException::class.java) {
            service.consume(member, "192.0.2.1", PlanUsageFeature.AI_SEARCH) { throw failure }
        })
        Mockito.verify(repository).release(7, PlanUsageFeature.AI_SEARCH, "2026-10-08")
    }

    @Test
    fun rejectsAtTheDailyLimitWithTheResetTimeAndNeverRunsTheAction() {
        Mockito.doReturn(AccountPlan.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(false).`when`(repository).reserve(7, PlanUsageFeature.EVIDENCE_QUESTION, "2026-10-08", 10)
        var called = false

        val error = assertThrows(PlanQuotaExceededException::class.java) {
            service.consume(member, "192.0.2.1", PlanUsageFeature.EVIDENCE_QUESTION) { called = true }
        }

        assertFalse(called)
        assertEquals(PlanUsageFeature.EVIDENCE_QUESTION, error.feature)
        assertEquals(PlanCode.FREE, error.plan)
        assertEquals(10, error.limit)
        assertEquals(10, error.used)
        assertEquals(ZonedDateTime.of(2026, 10, 9, 0, 0, 0, 0, seoul), error.resetsAt)
        assertEquals(3 * 60 * 60L, error.retryAfterSeconds)
    }

    @Test
    fun guestsOnlyGetTheAiSearchTrialPerAddress() {
        Mockito.doReturn(false).`when`(guests).reserve("192.0.2.9", today, 2)

        val error = assertThrows(PlanQuotaExceededException::class.java) {
            service.consume(null, "192.0.2.9", PlanUsageFeature.AI_SEARCH) { "never" }
        }
        assertNull(error.plan)
        assertEquals(2, error.limit)
        // 원문 질문 같은 다른 AI 기능은 컨트롤러가 로그인부터 요구하므로 여기 오면 잘못 연결된 것입니다.
        assertThrows(IllegalArgumentException::class.java) {
            service.consume(null, "192.0.2.9", PlanUsageFeature.EVIDENCE_QUESTION) { "never" }
        }
        Mockito.verifyNoInteractions(repository)
    }

    @Test
    fun aPassCountsEachRequestAgainstItsThirtyDayPeriodAndEndsWhenThePassEnds() {
        // 10월 1일 15:30에 시작한 플러스 30일 이용권은 10월 31일 15:30까지 한 이용 기간입니다.
        val starts = ZonedDateTime.of(2026, 10, 1, 15, 30, 0, 0, seoul)
        Mockito.doReturn(AccountPlan(PlanCode.PLUS, starts, starts.plusDays(30))).`when`(repository).findPlan(7)
        Mockito.doReturn(true).`when`(repository).reserve(7, PlanUsageFeature.AI_SEARCH, "P20261001T153000", 500)

        assertEquals("ranked", service.consume(member, "192.0.2.1", PlanUsageFeature.AI_SEARCH) { "ranked" })

        Mockito.doReturn(false).`when`(repository).reserve(7, PlanUsageFeature.EVIDENCE_QUESTION, "P20261001T153000", 500)
        val error = assertThrows(PlanQuotaExceededException::class.java) {
            service.consume(member, "192.0.2.1", PlanUsageFeature.EVIDENCE_QUESTION) { "never" }
        }
        assertEquals(PlanUsagePeriod.PLAN, error.period)
        assertEquals(PlanCode.PLUS, error.plan)
        assertEquals(500, error.limit)
        assertEquals(ZonedDateTime.of(2026, 10, 31, 15, 30, 0, 0, seoul), error.resetsAt)
    }

    @Test
    fun localDevelopmentAccountsAreCountedButNeverBlocked() {
        // 로컬 데모 시드 계정만 개발용 무제한으로 지정합니다. 대소문자와 앞뒤 공백은 가리지 않습니다.
        val dev = PlanUsageService(repository, guests, clock, PlanUsageTestHelper.noTransactions(), accounts, " Member@Example.test , other@example.test")
        Mockito.doReturn(AccountPlan.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(member).`when`(accounts).findById(7)
        Mockito.doReturn(false).`when`(repository).reserve(7, PlanUsageFeature.AI_SEARCH, "2026-10-08", null)

        // 하루 10회를 넘겼어도 막지 않고, 사용량은 그대로 셉니다.
        assertEquals("ranked", dev.consume(member, "192.0.2.1", PlanUsageFeature.AI_SEARCH) { "ranked" })
        Mockito.verify(repository).reserve(7, PlanUsageFeature.AI_SEARCH, "2026-10-08", null)
        // 작업으로 세는 기능도 한도를 확인하지 않습니다.
        dev.requireMonthlyCapacity(7, PlanUsageJob.ReviewRun(31))
        Mockito.verify(repository, Mockito.never()).findCounts(Mockito.anyLong(), Mockito.anyList())
        assertEquals(listOf(null, null, null, null), dev.usage(member, "192.0.2.1").items.map { it.limit })

        // 지정하지 않은 계정과 지정이 없는 운영 설정은 계정을 읽지 않고 한도를 적용합니다.
        Mockito.doReturn(true).`when`(repository).reserve(7, PlanUsageFeature.EVIDENCE_QUESTION, "2026-10-08", 10)
        assertEquals("answered", service.consume(member, "192.0.2.1", PlanUsageFeature.EVIDENCE_QUESTION) { "answered" })
        Mockito.verify(accounts, Mockito.times(3)).findById(7)
    }

    @Test
    fun anEndedPassFallsBackToTheFreeDailyLimit() {
        // 오늘 정오에 끝난 이용권이라 저녁 9시에는 무료 하루 한도로 셉니다.
        val starts = ZonedDateTime.of(2026, 9, 8, 12, 0, 0, 0, seoul)
        Mockito.doReturn(AccountPlan(PlanCode.PLUS, starts, starts.plusDays(30))).`when`(repository).findPlan(7)
        Mockito.doReturn(true).`when`(repository).reserve(7, PlanUsageFeature.AI_SEARCH, "2026-10-08", 10)

        assertEquals("ranked", service.consume(member, "192.0.2.1", PlanUsageFeature.AI_SEARCH) { "ranked" })
        Mockito.verify(repository).reserve(7, PlanUsageFeature.AI_SEARCH, "2026-10-08", 10)
    }

    @Test
    fun monthlyCapacityBlocksOnlyANewItemThatGoesOverTheLimit() {
        Mockito.doReturn(AccountPlan.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(mapOf((PlanUsageFeature.COMBINATION_REVIEW to "2026-10") to 1))
            .`when`(repository).findCounts(7, listOf("2026-10"))
        val run = PlanUsageJob.ReviewRun(31)
        Mockito.doReturn(2).`when`(repository).countJobs(7, PlanUsageFeature.COMBINATION_REVIEW, thisMonth, run, null)
        Mockito.doReturn(3).`when`(repository).countJobs(7, PlanUsageFeature.COMBINATION_REVIEW, thisMonth, null, null)

        // 지운 검토의 1회 + 진행·완료 2회에 새 실행을 더하면 4회로 FREE 3회를 넘습니다.
        val error = assertThrows(PlanQuotaExceededException::class.java) { service.requireMonthlyCapacity(7, run) }
        assertEquals(3, error.limit)
        assertEquals(3, error.used)
        assertEquals(ZonedDateTime.of(2026, 11, 1, 0, 0, 0, 0, seoul), error.resetsAt)
    }

    @Test
    fun repeatingTheSameProgramDoesNotUseAnotherDraft() {
        Mockito.doReturn(AccountPlan.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(emptyMap<Pair<PlanUsageFeature, String>, Int>()).`when`(repository).findCounts(7, listOf("2026-10"))
        val generation = PlanUsageJob.DocumentGeneration(12)
        Mockito.doReturn(3).`when`(repository).countJobs(7, PlanUsageFeature.APPLICATION_DRAFT, thisMonth, generation, null)
        Mockito.doReturn(3).`when`(repository).countJobs(7, PlanUsageFeature.APPLICATION_DRAFT, thisMonth, null, null)

        // 이미 센 공고를 다시 만들면 한도에 다다랐어도 막지 않습니다.
        service.requireMonthlyCapacity(7, generation)
    }

    @Test
    fun aProgramWithoutAJobIsRecordedBeforeTheActionAndRemovedWhenTheActionFails() {
        Mockito.doReturn(AccountPlan.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(emptyMap<Pair<PlanUsageFeature, String>, Int>()).`when`(repository).findCounts(7, listOf("2026-10"))
        val program = PlanUsageJob.DraftProgram("BIZINFO", "PBLN_NEW")
        Mockito.doReturn(1).`when`(repository).countJobs(7, PlanUsageFeature.APPLICATION_DRAFT, thisMonth, null, null)
        Mockito.doReturn(2).`when`(repository).countJobs(7, PlanUsageFeature.APPLICATION_DRAFT, thisMonth, null, program)
        Mockito.doReturn(41L).`when`(repository).addDraftProgram(7, "BIZINFO", "PBLN_NEW")

        assertEquals("analyzed", service.consumeDraftProgram(7, "BIZINFO", "PBLN_NEW") { "analyzed" })
        // 계정 행을 잠근 뒤 공고를 기록하고, 성공하면 기록을 그대로 둡니다.
        val order = Mockito.inOrder(repository)
        order.verify(repository).lockAccount(7)
        order.verify(repository).addDraftProgram(7, "BIZINFO", "PBLN_NEW")
        Mockito.verify(repository, Mockito.never()).removeDraftProgram(41)

        val failure = IllegalStateException("model timeout")
        assertEquals(failure, assertThrows(IllegalStateException::class.java) {
            service.consumeDraftProgram(7, "BIZINFO", "PBLN_NEW") { throw failure }
        })
        Mockito.verify(repository).removeDraftProgram(41)
    }

    @Test
    fun aNewProgramOverTheMonthlyLimitIsRejectedBeforeTheActionRuns() {
        Mockito.doReturn(AccountPlan.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(emptyMap<Pair<PlanUsageFeature, String>, Int>()).`when`(repository).findCounts(7, listOf("2026-10"))
        val program = PlanUsageJob.DraftProgram("BIZINFO", "PBLN_NEW")
        Mockito.doReturn(3).`when`(repository).countJobs(7, PlanUsageFeature.APPLICATION_DRAFT, thisMonth, null, null)
        Mockito.doReturn(4).`when`(repository).countJobs(7, PlanUsageFeature.APPLICATION_DRAFT, thisMonth, null, program)
        var called = false

        val error = assertThrows(PlanQuotaExceededException::class.java) {
            service.consumeDraftProgram(7, "BIZINFO", "PBLN_NEW") { called = true }
        }
        assertFalse(called)
        assertEquals(3, error.used)
        Mockito.verify(repository, Mockito.never()).addDraftProgram(Mockito.anyLong(), Mockito.anyString(), Mockito.anyString())
    }

    @Test
    fun aProgramAlreadyCountedThisMonthIsNeitherBlockedNorRecordedAgain() {
        Mockito.doReturn(AccountPlan.FREE).`when`(repository).findPlan(7)
        val program = PlanUsageJob.DraftProgram("BIZINFO", "PBLN_DISCOVERED")
        Mockito.doReturn(3).`when`(repository).countJobs(7, PlanUsageFeature.APPLICATION_DRAFT, thisMonth, null, null)
        Mockito.doReturn(3).`when`(repository).countJobs(7, PlanUsageFeature.APPLICATION_DRAFT, thisMonth, null, program)

        // 한도에 다다랐어도 이번 달에 이미 센 공고는 다시 분석·생성할 수 있고, 실패해도 지울 기록이 없습니다.
        assertThrows(IllegalStateException::class.java) {
            service.consumeDraftProgram(7, "BIZINFO", "PBLN_DISCOVERED") { throw IllegalStateException("retry failed") }
        }
        Mockito.verify(repository, Mockito.never()).addDraftProgram(Mockito.anyLong(), Mockito.anyString(), Mockito.anyString())
        Mockito.verify(repository, Mockito.never()).removeDraftProgram(Mockito.anyLong())
    }

    @Test
    fun anOpenEndedPaidPlanCountsDraftsInTheCurrentThirtyDayPeriod() {
        // 끝나는 때가 없는 프리미엄 배정은 9월 1일 9시부터 30일마다 새 기간입니다. 지금은 10월 1일 9시에 시작한 두 번째 기간입니다.
        val starts = ZonedDateTime.of(2026, 9, 1, 9, 0, 0, 0, seoul)
        Mockito.doReturn(AccountPlan(PlanCode.PREMIUM, starts)).`when`(repository).findPlan(7)
        val period = PlanUsageWindow.plan(starts, null, ZonedDateTime.now(clock))
        assertEquals("P20261001T090000", period.key)
        val program = PlanUsageJob.DraftProgram("BIZINFO", "PBLN_NEW")
        Mockito.doReturn(19).`when`(repository).countJobs(7, PlanUsageFeature.APPLICATION_DRAFT, period, null, null)
        Mockito.doReturn(20).`when`(repository).countJobs(7, PlanUsageFeature.APPLICATION_DRAFT, period, null, program)

        assertEquals("drafted", service.consumeDraftProgram(7, "BIZINFO", "PBLN_NEW") { "drafted" })
        Mockito.verify(repository).addDraftProgram(7, "BIZINFO", "PBLN_NEW")

        // 이번 기간 20건을 넘는 새 공고는 AI 전에 막고, 다음 기간이 시작하는 10월 31일 9시를 알려 줍니다.
        val another = PlanUsageJob.DraftProgram("BIZINFO", "PBLN_ANOTHER")
        Mockito.doReturn(20).`when`(repository).countJobs(7, PlanUsageFeature.APPLICATION_DRAFT, period, null, null)
        Mockito.doReturn(21).`when`(repository).countJobs(7, PlanUsageFeature.APPLICATION_DRAFT, period, null, another)
        val error = assertThrows(PlanQuotaExceededException::class.java) {
            service.consumeDraftProgram(7, "BIZINFO", "PBLN_ANOTHER") { "never" }
        }
        assertEquals(PlanUsagePeriod.PLAN, error.period)
        assertEquals(ZonedDateTime.of(2026, 10, 31, 9, 0, 0, 0, seoul), error.resetsAt)
    }

    @Test
    fun aDraftProgramIsNeverCheckedAsAJob() {
        assertThrows(IllegalArgumentException::class.java) {
            service.requireMonthlyCapacity(7, PlanUsageJob.DraftProgram("BIZINFO", "PBLN_NEW"))
        }
    }

    @Test
    fun deletingKeepsTheUsageThatTheDeletedWorkAlreadySpentThisMonth() {
        Mockito.doReturn(AccountPlan.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(3, 1).`when`(repository).countJobs(7, PlanUsageFeature.COMBINATION_REVIEW, thisMonth, null, null)

        assertEquals(true, service.keepMonthlyUsage(7, PlanUsageFeature.COMBINATION_REVIEW) { true })

        Mockito.verify(repository).addCount(7, PlanUsageFeature.COMBINATION_REVIEW, "2026-10", 2)
    }

    @Test
    fun reportsTheGuestTrialFreeUsageAndAPassWithItsPeriodAndEnd() {
        Mockito.doReturn(2).`when`(guests).used("192.0.2.9", today)
        val guest = service.usage(null, "192.0.2.9")
        assertNull(guest.plan)
        assertEquals(listOf(PlanUsageFeature.AI_SEARCH to 2), guest.items.map { it.feature to it.used })
        assertEquals(2, guest.items.single().limit)

        Mockito.doReturn(AccountPlan.FREE).`when`(repository).findPlan(7)
        Mockito.doReturn(
            mapOf((PlanUsageFeature.AI_SEARCH to "2026-10-08") to 4, (PlanUsageFeature.COMBINATION_REVIEW to "2026-10") to 1),
        ).`when`(repository).findCounts(7, listOf("2026-10-08", "2026-10-08", "2026-10", "2026-10"))
        Mockito.doReturn(1).`when`(repository).countJobs(7, PlanUsageFeature.APPLICATION_DRAFT, thisMonth, null, null)
        Mockito.doReturn(1).`when`(repository).countJobs(7, PlanUsageFeature.COMBINATION_REVIEW, thisMonth, null, null)

        val usage = service.usage(member, "192.0.2.1")

        assertEquals(PlanCode.FREE, usage.plan)
        assertNull(usage.planEndsAt)
        assertEquals(
            listOf(
                Triple(PlanUsageFeature.AI_SEARCH, 10, 4),
                Triple(PlanUsageFeature.EVIDENCE_QUESTION, 10, 0),
                Triple(PlanUsageFeature.APPLICATION_DRAFT, 3, 1),
                Triple(PlanUsageFeature.COMBINATION_REVIEW, 3, 2),
            ),
            usage.items.map { Triple(it.feature, it.limit, it.used) },
        )

        // 플러스 이용권은 네 기능 모두 이용 기간 총량으로 세고, 이용권이 끝나는 때를 함께 돌려줍니다.
        val starts = ZonedDateTime.of(2026, 10, 1, 15, 30, 0, 0, seoul)
        Mockito.doReturn(AccountPlan(PlanCode.PLUS, starts, starts.plusDays(30))).`when`(repository).findPlan(7)
        val pass = service.usage(member, "192.0.2.1")
        assertEquals(PlanCode.PLUS, pass.plan)
        assertEquals(starts.plusDays(30), pass.planEndsAt)
        assertEquals(listOf(500, 500, 5, 10), pass.items.map { it.limit })
        assertEquals(setOf(PlanUsagePeriod.PLAN), pass.items.map { it.period }.toSet())
        assertEquals(setOf(starts.plusDays(30)), pass.items.map { it.resetsAt }.toSet())
    }

    @Test
    fun aTrialStartsNowForFourteenDaysAndReportsWhatIsLeftToTry() {
        val now = ZonedDateTime.now(clock)
        val trial = AccountPlan(PlanCode.PLUS, now, now.plusDays(PlanTrial.DAYS), source = PlanSource.TRIAL)
        Mockito.doReturn(AccountPlan.FREE, trial).`when`(repository).findPlan(7)
        Mockito.doReturn(emptySet<PlanCode>(), setOf(PlanCode.PLUS)).`when`(repository).findTrialPlans(7)

        val usage = service.startTrial(verified, PlanCode.PLUS)

        val order = Mockito.inOrder(repository)
        order.verify(repository).lockAccount(7)
        order.verify(repository).startTrial(7, PlanCode.PLUS, now, now.plusDays(14))
        assertEquals(PlanCode.PLUS, usage.plan)
        assertEquals(PlanSource.TRIAL, usage.planSource)
        assertEquals(now.plusDays(14), usage.planEndsAt)
        assertEquals(listOf(PlanCode.PREMIUM), usage.trialsAvailable)
        assertEquals(listOf(500, 500, 5, 10), usage.items.map { it.limit })
    }

    @Test
    fun aTrialIsRefusedOnceUsedWhenNotAnUpgradeAndBeforeTheEmailIsVerified() {
        val now = ZonedDateTime.now(clock)
        Mockito.doReturn(setOf(PlanCode.PLUS)).`when`(repository).findTrialPlans(7)
        Mockito.doReturn(AccountPlan.FREE).`when`(repository).findPlan(7)
        assertEquals(PlanTrialException.Reason.USED, assertThrows(PlanTrialException::class.java) {
            service.startTrial(verified, PlanCode.PLUS)
        }.reason)

        // 운영자가 배정한 플러스를 쓰는 동안에는 프리미엄 체험도 시작하지 않습니다.
        Mockito.doReturn(emptySet<PlanCode>()).`when`(repository).findTrialPlans(7)
        Mockito.doReturn(AccountPlan(PlanCode.PLUS, now.minusDays(3), source = PlanSource.OPERATOR)).`when`(repository).findPlan(7)
        assertEquals(PlanTrialException.Reason.UNAVAILABLE, assertThrows(PlanTrialException::class.java) {
            service.startTrial(verified, PlanCode.PREMIUM)
        }.reason)
        // 프리미엄 체험 중에는 플러스 체험으로 내려가지 않습니다.
        Mockito.doReturn(setOf(PlanCode.PREMIUM)).`when`(repository).findTrialPlans(7)
        Mockito.doReturn(AccountPlan(PlanCode.PREMIUM, now.minusDays(3), now.plusDays(11), source = PlanSource.TRIAL)).`when`(repository).findPlan(7)
        assertEquals(PlanTrialException.Reason.UNAVAILABLE, assertThrows(PlanTrialException::class.java) {
            service.startTrial(verified, PlanCode.PLUS)
        }.reason)

        assertEquals(PlanTrialException.Reason.EMAIL_UNVERIFIED, assertThrows(PlanTrialException::class.java) {
            service.startTrial(member, PlanCode.PLUS)
        }.reason)
        assertFalse(Mockito.mockingDetails(repository).invocations.any { it.method.name == "startTrial" })
    }

    @Test
    fun aPlusTrialMovesUpToAPremiumTrialRightAway() {
        val now = ZonedDateTime.now(clock)
        Mockito.doReturn(setOf(PlanCode.PLUS)).`when`(repository).findTrialPlans(7)
        Mockito.doReturn(AccountPlan(PlanCode.PLUS, now.minusDays(5), now.plusDays(9), source = PlanSource.TRIAL)).`when`(repository).findPlan(7)

        service.startTrial(verified, PlanCode.PREMIUM)

        Mockito.verify(repository).startTrial(7, PlanCode.PREMIUM, now, now.plusDays(14))
    }
}
