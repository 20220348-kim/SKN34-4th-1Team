package ai.govbiz.core.admin.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.admin.domain.AdminAccountActivity
import ai.govbiz.core.admin.domain.AdminAccountDetail
import ai.govbiz.core.admin.domain.AdminAccountQuery
import ai.govbiz.core.admin.domain.AdminAccountSort
import ai.govbiz.core.admin.domain.AdminAccountSummary
import ai.govbiz.core.admin.domain.AdminActor
import ai.govbiz.core.admin.service.AdminAccountService
import ai.govbiz.core.admin.service.exception.AdminAccessLogUnavailableException
import ai.govbiz.core.admin.service.exception.AdminLastActiveAdminException
import ai.govbiz.core.admin.web.AdminPrincipalArgumentResolver
import jakarta.servlet.http.Cookie
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

/** 관리자 계정 Controller가 요청의 접속지를 처리자와 함께 넘기고, 권한 변경 본문과 거절·기록 실패를 어떻게 응답하는지 봅니다. */
@ExtendWith(MockitoExtension::class)
class AdminAccountControllerTest {

    @Mock
    private lateinit var sessions: AccountSessionService

    @Mock
    private lateinit var service: AdminAccountService

    private lateinit var mvc: MockMvc

    private val admin = AccountTestHelper.account(id = 1, email = "admin@govbiz.local", role = AccountRole.ADMIN)

    private val actor = AdminActor(1, "198.51.100.7", "Mozilla/5.0")

    @BeforeEach
    fun setUp() {
        mvc = MockMvcBuilders.standaloneSetup(AdminAccountController(service))
            .setCustomArgumentResolvers(AdminPrincipalArgumentResolver { sessions })
            .setControllerAdvice(ApiExceptionHandler()).build()
        doReturn(admin).`when`(sessions).requireAccount(ADMIN_SESSION)
    }

    @Test
    fun roleChangePassesTheActorWithItsOriginAndReturnsTheUpdatedDetail() {
        doReturn(detail(11, AccountRole.ADMIN)).`when`(service).changeRole(actor, 11, AccountRole.ADMIN, " 운영 담당 추가 ")

        mvc.perform(asAdmin(post("$ACCOUNTS/11/role")).json("""{"role":"ADMIN","reason":" 운영 담당 추가 "}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.id").value(11))
            .andExpect(jsonPath("$.account.role").value("ADMIN"))
            .andExpect(jsonPath("$.account.tier").value("ADMIN"))
            .andExpect(jsonPath("$.isSelf").value(false))
    }

    @Test
    fun roleChangeNeedsAKnownRoleAndAReason() {
        val invalidBodies = listOf(
            """{"reason":"사유"}""",
            """{"role":"ROOT","reason":"사유"}""",
            """{"role":"ADMIN","reason":"   "}""",
            """{"role":"ADMIN"}""",
            """{"role":"ADMIN","reason":"${"가".repeat(AdminAccountService.MAX_REASON_LENGTH + 1)}"}""",
        )

        for (body in invalidBodies) {
            mvc.perform(asAdmin(post("$ACCOUNTS/11/role")).json(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
        }
        verifyNoInteractions(service)
    }

    @Test
    fun theLastActiveAdminRefusalHasItsOwnCode() {
        doThrow(AdminLastActiveAdminException()).`when`(service).changeRole(actor, 2, AccountRole.USER, "퇴사")

        mvc.perform(asAdmin(post("$ACCOUNTS/2/role")).json("""{"role":"USER","reason":"퇴사"}"""))
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("ADMIN_LAST_ACTIVE_ADMIN"))
    }

    @Test
    fun personalDataIsNotReturnedWhenItsAccessCannotBeRecorded() {
        val query = AdminAccountQuery("", null, null, null, AdminAccountSort.RECENT, 1, 20)
        doThrow(AdminAccessLogUnavailableException(IllegalStateException("database down"))).`when`(service).findPage(actor, query)
        doThrow(AdminAccessLogUnavailableException(IllegalStateException("database down"))).`when`(service).detail(actor, 11)

        mvc.perform(asAdmin(get(ACCOUNTS)))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("ADMIN_ACCESS_LOG_UNAVAILABLE"))
            .andExpect(jsonPath("$.accounts").doesNotExist())
        mvc.perform(asAdmin(get("$ACCOUNTS/11")))
            .andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.account").doesNotExist())
    }

    private fun asAdmin(request: MockHttpServletRequestBuilder): MockHttpServletRequestBuilder =
        request.cookie(Cookie(SessionCookieHelper.COOKIE_NAME, ADMIN_SESSION))
            .header(HttpHeaders.USER_AGENT, requireNotNull(actor.userAgent))
            .with { it.remoteAddr = actor.clientIp; it }

    private fun MockHttpServletRequestBuilder.json(body: String) = contentType(MediaType.APPLICATION_JSON).content(body)

    private fun detail(id: Long, role: AccountRole) =
        AdminAccountDetail(
            account = AdminAccountSummary(
                id = id,
                email = "member@company.co.kr",
                role = role,
                emailVerified = true,
                hasPassword = true,
                oauthProviders = emptySet(),
                companyName = null,
                businessNumber = null,
                suspendedAt = null,
                createdAt = NOW,
                lastLoginAt = null,
            ),
            company = null,
            activity = AdminAccountActivity(0, 0, 0, 1),
            actions = emptyList(),
        )

    private companion object {
        const val ACCOUNTS = "/api/v1/admin/accounts"
        const val ADMIN_SESSION = "admin-session"
    }
}
