package ai.govbiz.core.admin.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.admin.domain.AdminAccessAction
import ai.govbiz.core.admin.domain.AdminAccessLog
import ai.govbiz.core.admin.domain.AdminAccessLogPage
import ai.govbiz.core.admin.domain.AdminAccessLogQuery
import ai.govbiz.core.admin.domain.AdminActor
import ai.govbiz.core.admin.service.AdminAccessLogService
import ai.govbiz.core.admin.service.exception.AdminAccessLogUnavailableException
import ai.govbiz.core.admin.web.AdminPrincipalArgumentResolver
import jakarta.servlet.http.Cookie
import java.time.LocalDate
import java.time.LocalDateTime
import org.hamcrest.Matchers.nullValue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

@ExtendWith(MockitoExtension::class)
class AdminAuditLogControllerTest {

    @Mock
    private lateinit var sessions: AccountSessionService

    @Mock
    private lateinit var service: AdminAccessLogService

    private lateinit var mvc: MockMvc

    private val admin = AccountTestHelper.account(id = 1, email = "admin@govbiz.local", role = AccountRole.ADMIN)

    private val actor = AdminActor(1, "198.51.100.7", "Mozilla/5.0 (Windows NT 10.0)")

    @BeforeEach
    fun setUp() {
        mvc = MockMvcBuilders.standaloneSetup(AdminAuditLogController(service))
            .setCustomArgumentResolvers(AdminPrincipalArgumentResolver { sessions })
            .setControllerAdvice(ApiExceptionHandler()).build()
    }

    @Test
    fun passesFiltersWithTheRequestOriginAndReturnsRecordsWithoutCaching() {
        doReturn(admin).`when`(sessions).requireAccount(ADMIN_SESSION)
        val query = AdminAccessLogQuery(
            actorAccountId = 1,
            targetAccountId = 11,
            action = AdminAccessAction.ACCOUNT_DETAIL,
            from = LocalDate.of(2026, 9, 1),
            to = LocalDate.of(2026, 9, 30),
            before = 500,
            limit = 20,
        )
        doReturn(AdminAccessLogPage(listOf(record()), nextCursor = 42)).`when`(service).findPage(actor, query)

        mvc.perform(
            asAdmin(get(PATH))
                .param("actorAccountId", "1")
                .param("targetAccountId", "11")
                .param("action", "ACCOUNT_DETAIL")
                .param("from", "2026-09-01")
                .param("to", "2026-09-30")
                .param("before", "500")
                .param("limit", "20"),
        )
            .andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.records[0].id").value(42))
            .andExpect(jsonPath("$.records[0].action").value("ACCOUNT_DETAIL"))
            .andExpect(jsonPath("$.records[0].actorAccountId").value(1))
            .andExpect(jsonPath("$.records[0].actorEmail").value("admin@govbiz.local"))
            .andExpect(jsonPath("$.records[0].targetAccountId").value(11))
            .andExpect(jsonPath("$.records[0].requestSummary").value(nullValue()))
            .andExpect(jsonPath("$.records[0].clientIp").value("198.51.100.7"))
            .andExpect(jsonPath("$.records[0].createdAt").value("2026-09-06T12:00:00.123456"))
            .andExpect(jsonPath("$.nextCursor").value(42))
    }

    @Test
    fun rejectsInvalidFiltersBeforeReadingAnything() {
        doReturn(admin).`when`(sessions).requireAccount(ADMIN_SESSION)
        val invalid = listOf(
            "limit" to "51",
            "limit" to "0",
            "action" to "BOGUS",
            "from" to "2026-13-01",
            "to" to "20260930",
            "actorAccountId" to "0",
            "targetAccountId" to "abc",
            "before" to "-1",
        )

        for ((name, value) in invalid) {
            mvc.perform(asAdmin(get(PATH)).param(name, value))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
        }
        verifyNoInteractions(service)
    }

    @Test
    fun anAccessRecordThatCannotBeWrittenIsA503WithoutRecords() {
        doReturn(admin).`when`(sessions).requireAccount(ADMIN_SESSION)
        doThrow(AdminAccessLogUnavailableException(IllegalStateException("database down")))
            .`when`(service).findPage(actor, AdminAccessLogQuery(null, null, null, null, null, null, AdminAccessLogQuery.MAX_LIMIT))

        mvc.perform(asAdmin(get(PATH)))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("ADMIN_ACCESS_LOG_UNAVAILABLE"))
            .andExpect(jsonPath("$.records").doesNotExist())
    }

    @Test
    fun membersAndAnonymousVisitorsCannotReadTheAuditLog() {
        doReturn(AccountTestHelper.account(id = 2, role = AccountRole.USER)).`when`(sessions).requireAccount("member-session")

        mvc.perform(get(PATH).cookie(Cookie(SessionCookieHelper.COOKIE_NAME, "member-session")))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("ADMIN_ACCESS_DENIED"))
        verifyNoInteractions(service)
    }

    private fun asAdmin(request: MockHttpServletRequestBuilder): MockHttpServletRequestBuilder =
        request.cookie(Cookie(SessionCookieHelper.COOKIE_NAME, ADMIN_SESSION))
            .header(HttpHeaders.USER_AGENT, requireNotNull(actor.userAgent))
            .with { it.remoteAddr = actor.clientIp; it }

    private fun record() =
        AdminAccessLog(
            id = 42,
            actorAccountId = 1,
            actorEmail = "admin@govbiz.local",
            action = AdminAccessAction.ACCOUNT_DETAIL,
            targetAccountId = 11,
            requestSummary = null,
            clientIp = "198.51.100.7",
            userAgent = "Mozilla/5.0 (Windows NT 10.0)",
            createdAt = LocalDateTime.of(2026, 9, 6, 12, 0, 0, 123_456_000),
        )

    private companion object {
        const val PATH = "/api/v1/admin/audit-logs"
        const val ADMIN_SESSION = "admin-session"
    }
}
