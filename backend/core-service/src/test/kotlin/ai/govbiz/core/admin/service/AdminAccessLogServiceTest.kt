package ai.govbiz.core.admin.service

import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.admin.domain.AdminAccessAction
import ai.govbiz.core.admin.domain.AdminAccessLog
import ai.govbiz.core.admin.domain.AdminAccessLogPage
import ai.govbiz.core.admin.domain.AdminAccessLogQuery
import ai.govbiz.core.admin.domain.AdminActor
import ai.govbiz.core.admin.domain.NewAdminAccessLog
import ai.govbiz.core.admin.repository.AdminAccessLogRepository
import ai.govbiz.core.admin.service.exception.AdminAccessLogUnavailableException
import java.time.LocalDate
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.inOrder
import org.mockito.Mockito.verify
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.jdbc.CannotGetJdbcConnectionException

@ExtendWith(MockitoExtension::class)
class AdminAccessLogServiceTest {

    @Mock
    private lateinit var repository: AdminAccessLogRepository

    private lateinit var service: AdminAccessLogService

    private val actor = AdminActor(1, "198.51.100.7", "Mozilla/5.0")

    @BeforeEach
    fun setUp() {
        service = AdminAccessLogService(repository, AccountTestHelper.FIXED_CLOCK)
    }

    @Test
    fun recordsWithTheSeoulClock() {
        service.record(actor, AdminAccessAction.ACCOUNT_DETAIL, targetAccountId = 11)

        verify(repository).insert(NewAdminAccessLog(actor, AdminAccessAction.ACCOUNT_DETAIL, 11, null, NOW))
    }

    @Test
    fun databaseFailuresBecomeAnExplicitUnavailableError() {
        for (failure in listOf(CannotGetJdbcConnectionException("down"), DataIntegrityViolationException("check failed"))) {
            doThrow(failure).`when`(repository).insert(AccountTestHelper.anyValue())

            val error = assertThrows(AdminAccessLogUnavailableException::class.java) {
                service.record(actor, AdminAccessAction.ACCOUNT_LIST, requestSummary = "returned=0")
            }
            assertEquals(failure, error.cause)
        }
    }

    @Test
    fun viewingTheAuditLogIsRecordedAfterReadingAndBeforeReturning() {
        val query = AdminAccessLogQuery(null, 11, null, LocalDate.of(2026, 9, 1), LocalDate.of(2026, 9, 6), null, 50)
        val page = AdminAccessLogPage(listOf(record(id = 7)), nextCursor = null)
        doReturn(page).`when`(repository).findPage(query)

        assertEquals(page, service.findPage(actor, query))

        val order = inOrder(repository)
        order.verify(repository).findPage(query)
        order.verify(repository).insert(
            NewAdminAccessLog(
                actor,
                AdminAccessAction.AUDIT_LOG_LIST,
                null,
                "targetAccountId=11, from=2026-09-01, to=2026-09-06, limit=50, returned=1",
                NOW,
            ),
        )
    }

    @Test
    fun anUnwrittenAuditViewHidesTheRecords() {
        val query = AdminAccessLogQuery(null, null, null, null, null, null, 50)
        doReturn(AdminAccessLogPage(listOf(record(id = 7)), null)).`when`(repository).findPage(query)
        doThrow(CannotGetJdbcConnectionException("down")).`when`(repository).insert(AccountTestHelper.anyValue())

        val error = assertThrows(AdminAccessLogUnavailableException::class.java) { service.findPage(actor, query) }
        assertInstanceOf(CannotGetJdbcConnectionException::class.java, error.cause)
    }

    private fun record(id: Long) =
        AdminAccessLog(
            id = id,
            actorAccountId = 1,
            actorEmail = "admin@govbiz.local",
            action = AdminAccessAction.ACCOUNT_DETAIL,
            targetAccountId = 11,
            requestSummary = null,
            clientIp = "198.51.100.7",
            userAgent = null,
            createdAt = NOW,
        )
}
