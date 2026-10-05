package ai.govbiz.core.admin.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.helper.SignupTestHelper
import jakarta.servlet.http.Cookie
import java.util.concurrent.atomic.AtomicInteger
import org.hamcrest.Matchers.containsInAnyOrder
import org.hamcrest.Matchers.hasSize
import org.hamcrest.Matchers.nullValue
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * 관리자 계정 관리 API를 실제 MySQL 8.4에서 확인합니다. 관리자는 가입한 계정의 역할을 SQL로 올려 만들고,
 * 정지·강제 로그아웃·권한 변경이 세션과 로그인에 바로 반영되는지와 조치 기록·접속기록(감사 기록)이 남는지를 봅니다.
 */
@SpringBootTest(
    properties = [
        "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
        "app.ai-service.base-url=http://127.0.0.1:1",
        "app.ai-service.connect-timeout=10ms",
        "app.ai-service.read-timeout=10ms",
        "app.bizinfo.sync.enabled=false",
        "app.support-program-index.enabled=false",
        "app.account.cookie-secure=false",
    ],
)
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class)
class AdminAccountFlowIntegrationTest {

    @Autowired
    private lateinit var mockMvc: MockMvc

    @Autowired
    private lateinit var jdbcTemplate: JdbcTemplate

    @BeforeEach
    fun resetAccounts() {
        // 애플리케이션은 접속기록을 지우지 않지만, 격리된 테스트 DB에서는 테스트끼리 섞이지 않도록 비웁니다.
        jdbcTemplate.update("DELETE FROM admin_access_log")
        jdbcTemplate.update("DELETE FROM account_admin_action")
        jdbcTemplate.update("DELETE FROM partner_proposal")
        jdbcTemplate.update("DELETE FROM partner_recruitment")
        jdbcTemplate.update("DELETE FROM company")
        jdbcTemplate.update("DELETE FROM account_oauth_identity")
        jdbcTemplate.update("DELETE FROM account_session")
        jdbcTemplate.update("DELETE FROM account")
    }

    @Test
    fun onlyAdminsOpenTheApiAndADemotedAdminIsBlockedOnTheNextRequest() {
        mockMvc.perform(get(ACCOUNTS)).andExpect(status().isUnauthorized())
        mockMvc.perform(get("/api/v1/admin/session")).andExpect(status().isUnauthorized())
        val member = signUp("member@company.co.kr")
        mockMvc.perform(get(ACCOUNTS).cookie(member))
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("ADMIN_ACCESS_DENIED"))
        mockMvc.perform(get("$ACCOUNTS/summary").cookie(member)).andExpect(status().isForbidden())
        mockMvc.perform(get("/api/v1/admin/session").cookie(member)).andExpect(status().isForbidden())

        val admin = signUpAdmin("admin@govbiz.local")
        mockMvc.perform(get(ACCOUNTS).cookie(admin)).andExpect(status().isOk())
        mockMvc.perform(get("/api/v1/admin/session").cookie(admin)).andExpect(status().isOk())
            .andExpect(jsonPath("$.email").value("admin@govbiz.local"))
        // 역할은 요청마다 DB에서 다시 읽으므로 권한을 내리면 같은 세션으로도 막힙니다.
        jdbcTemplate.update("UPDATE account SET role = 'USER' WHERE email = 'admin@govbiz.local'")
        mockMvc.perform(get(ACCOUNTS).cookie(admin)).andExpect(status().isForbidden())
        mockMvc.perform(get("/api/v1/admin/session").cookie(admin)).andExpect(status().isForbidden())
    }

    @Test
    fun listsSearchesAndFiltersAccountsWithoutDeletedOnes() {
        val admin = signUpAdmin("admin@govbiz.local")
        signUp("alpha@company.co.kr")
        signUp("beta@company.co.kr")
        insertCompany("beta@company.co.kr", "1248100998", "테스트기업 주식회사")
        insertKakaoAccount("kakao@kakao.com")
        val gone = signUp("gone@company.co.kr")
        mockMvc.perform(delete("/api/v1/me").cookie(gone).origin().json("""{"password":"password1"}"""))
            .andExpect(status().isNoContent())

        mockMvc.perform(get(ACCOUNTS).cookie(admin))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.total").value(4))
            .andExpect(jsonPath("$.totalPages").value(1))
            .andExpect(
                jsonPath(
                    "$.accounts[*].email",
                    containsInAnyOrder("admin@govbiz.local", "alpha@company.co.kr", "beta@company.co.kr", "kakao@kakao.com"),
                ),
            )
        mockMvc.perform(get(ACCOUNTS).cookie(admin).param("keyword", "beta"))
            .andExpect(jsonPath("$.total").value(1))
            .andExpect(jsonPath("$.accounts[0].tier").value("COMPANY"))
            .andExpect(jsonPath("$.accounts[0].company.companyName").value("테스트기업 주식회사"))
            .andExpect(jsonPath("$.accounts[0].loginMethods", containsInAnyOrder("EMAIL")))
            .andExpect(jsonPath("$.accounts[0].lastLoginAt").isNotEmpty())
        // 기업명과 사업자등록번호 일부(하이픈 포함)로도 찾고, LIKE 특수문자는 글자 그대로 찾습니다.
        mockMvc.perform(get(ACCOUNTS).cookie(admin).param("keyword", "테스트기업"))
            .andExpect(jsonPath("$.total").value(1))
        mockMvc.perform(get(ACCOUNTS).cookie(admin).param("keyword", "124-81"))
            .andExpect(jsonPath("$.total").value(1))
        mockMvc.perform(get(ACCOUNTS).cookie(admin).param("keyword", "100%"))
            .andExpect(jsonPath("$.total").value(0))
        mockMvc.perform(get(ACCOUNTS).cookie(admin).param("role", "ADMIN"))
            .andExpect(jsonPath("$.total").value(1))
            .andExpect(jsonPath("$.accounts[0].email").value("admin@govbiz.local"))
        mockMvc.perform(get(ACCOUNTS).cookie(admin).param("loginMethod", "KAKAO"))
            .andExpect(jsonPath("$.total").value(1))
            .andExpect(jsonPath("$.accounts[0].hasPassword").value(false))
            .andExpect(jsonPath("$.accounts[0].loginMethods", containsInAnyOrder("KAKAO")))
        mockMvc.perform(get(ACCOUNTS).cookie(admin).param("loginMethod", "EMAIL"))
            .andExpect(jsonPath("$.total").value(3))
        mockMvc.perform(get(ACCOUNTS).cookie(admin).param("status", "SUSPENDED"))
            .andExpect(jsonPath("$.total").value(0))
        // 로그인한 적 없는 계정은 최근 로그인순의 맨 뒤에 둡니다.
        mockMvc.perform(get(ACCOUNTS).cookie(admin).param("sort", "LAST_LOGIN"))
            .andExpect(jsonPath("$.accounts[3].email").value("kakao@kakao.com"))
        mockMvc.perform(get(ACCOUNTS).cookie(admin).param("page", "2").param("pageSize", "3"))
            .andExpect(jsonPath("$.totalPages").value(2))
            .andExpect(jsonPath("$.accounts", hasSize<Any>(1)))
        mockMvc.perform(get(ACCOUNTS).cookie(admin).param("status", "BOGUS"))
            .andExpect(status().isBadRequest())

        mockMvc.perform(get("$ACCOUNTS/summary").cookie(admin))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.total").value(4))
            .andExpect(jsonPath("$.companyRegistered").value(1))
            .andExpect(jsonPath("$.socialLinked").value(1))
            .andExpect(jsonPath("$.suspended").value(0))
            .andExpect(jsonPath("$.admins").value(1))
            .andExpect(jsonPath("$.joinedRecently").value(4))
            .andExpect(jsonPath("$.recentJoinDays").value(7))
    }

    @Test
    fun suspendingSignsTheMemberOutAndKeepsTheReasonUntilTheSuspensionIsLifted() {
        val admin = signUpAdmin("admin@govbiz.local")
        val member = signUp("member@company.co.kr")
        val path = "$ACCOUNTS/${idOf("member@company.co.kr")}"

        mockMvc.perform(get(path).cookie(admin))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.status").value("ACTIVE"))
            .andExpect(jsonPath("$.activity.activeSessionCount").value(1))
            .andExpect(jsonPath("$.isSelf").value(false))
            .andExpect(jsonPath("$.actions", hasSize<Any>(0)))
        // 사유가 없으면 조치하지 않습니다.
        mockMvc.perform(post("$path/suspend").cookie(admin).origin().json("""{"reason":"   "}"""))
            .andExpect(status().isBadRequest())

        mockMvc.perform(post("$path/suspend").cookie(admin).origin().json("""{"reason":"  스팸 제안 반복 "}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.status").value("SUSPENDED"))
            .andExpect(jsonPath("$.account.suspendedAt").isNotEmpty())
            .andExpect(jsonPath("$.activity.activeSessionCount").value(0))
            .andExpect(jsonPath("$.actions[0].action").value("SUSPEND"))
            .andExpect(jsonPath("$.actions[0].reason").value("스팸 제안 반복"))
            .andExpect(jsonPath("$.actions[0].adminEmail").value("admin@govbiz.local"))
        // 쓰던 세션은 끝났고, 다시 로그인해도 정지로 막힙니다.
        mockMvc.perform(get("/api/v1/auth/me").cookie(member)).andExpect(status().isUnauthorized())
        logIn("member@company.co.kr")
            .andExpect(status().isForbidden())
            .andExpect(jsonPath("$.code").value("ACCOUNT_SUSPENDED"))
        mockMvc.perform(post("$path/suspend").cookie(admin).origin().json("""{"reason":"다시"}"""))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("ADMIN_ACCOUNT_STATE_CONFLICT"))
        mockMvc.perform(get(ACCOUNTS).cookie(admin).param("status", "SUSPENDED"))
            .andExpect(jsonPath("$.total").value(1))

        mockMvc.perform(post("$path/unsuspend").cookie(admin).origin().json("""{"reason":"소명 확인"}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.status").value("ACTIVE"))
            .andExpect(jsonPath("$.actions", hasSize<Any>(2)))
            .andExpect(jsonPath("$.actions[0].action").value("UNSUSPEND"))
        logIn("member@company.co.kr").andExpect(status().isOk())
        mockMvc.perform(post("$path/unsuspend").cookie(admin).origin().json("""{"reason":"다시"}"""))
            .andExpect(status().isConflict())
    }

    @Test
    fun revokingSessionsSignsEveryDeviceOutButKeepsTheAccountUsable() {
        val admin = signUpAdmin("admin@govbiz.local")
        val firstDevice = signUp("member@company.co.kr")
        val secondDevice = requireNotNull(logIn("member@company.co.kr").andReturn().response.getCookie(SessionCookieHelper.COOKIE_NAME))
        val path = "$ACCOUNTS/${idOf("member@company.co.kr")}"

        mockMvc.perform(post("$path/sessions/revoke").cookie(admin).origin().json("""{"reason":"기기 분실 신고"}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.status").value("ACTIVE"))
            .andExpect(jsonPath("$.activity.activeSessionCount").value(0))
            .andExpect(jsonPath("$.actions[0].action").value("SESSIONS_REVOKE"))

        mockMvc.perform(get("/api/v1/auth/me").cookie(firstDevice)).andExpect(status().isUnauthorized())
        mockMvc.perform(get("/api/v1/auth/me").cookie(secondDevice)).andExpect(status().isUnauthorized())
        logIn("member@company.co.kr").andExpect(status().isOk())
    }

    @Test
    fun adminsCannotActOnThemselvesOrOtherAdminsAndMissingAccountsAreNotFound() {
        val admin = signUpAdmin("admin@govbiz.local")
        signUpAdmin("second@govbiz.local")
        val selfPath = "$ACCOUNTS/${idOf("admin@govbiz.local")}"
        val otherPath = "$ACCOUNTS/${idOf("second@govbiz.local")}"

        mockMvc.perform(post("$selfPath/suspend").cookie(admin).origin().json("""{"reason":"테스트"}"""))
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("ADMIN_SELF_ACTION"))
        mockMvc.perform(post("$otherPath/suspend").cookie(admin).origin().json("""{"reason":"테스트"}"""))
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("ADMIN_TARGET_PROTECTED"))
        mockMvc.perform(post("$otherPath/sessions/revoke").cookie(admin).origin().json("""{"reason":"테스트"}"""))
            .andExpect(jsonPath("$.code").value("ADMIN_TARGET_PROTECTED"))
        mockMvc.perform(get(selfPath).cookie(admin))
            .andExpect(jsonPath("$.isSelf").value(true))
            .andExpect(jsonPath("$.account.tier").value("ADMIN"))
        mockMvc.perform(get("$ACCOUNTS/999999").cookie(admin))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("ADMIN_ACCOUNT_NOT_FOUND"))
        mockMvc.perform(post("$ACCOUNTS/999999/suspend").cookie(admin).origin().json("""{"reason":"테스트"}"""))
            .andExpect(status().isNotFound())

        val gone = signUp("gone@company.co.kr")
        val gonePath = "$ACCOUNTS/${idOf("gone@company.co.kr")}"
        mockMvc.perform(delete("/api/v1/me").cookie(gone).origin().json("""{"password":"password1"}"""))
            .andExpect(status().isNoContent())
        mockMvc.perform(get(gonePath).cookie(admin)).andExpect(status().isNotFound())
        assertEquals(0, count("SELECT COUNT(*) FROM account_admin_action"))
    }

    @Test
    fun roleChangesApplyOnTheNextRequestAndEveryPersonalDataAccessIsRecordedWithItsOrigin() {
        val admin = signUpAdmin("admin@govbiz.local")
        val member = signUp("member@company.co.kr")
        val adminId = idOf("admin@govbiz.local")
        val memberId = idOf("member@company.co.kr")
        val memberPath = "$ACCOUNTS/$memberId"

        mockMvc.perform(get(ACCOUNTS).cookie(admin).param("keyword", "member@company").fromAdminDesk())
            .andExpect(status().isOk())
        mockMvc.perform(get(memberPath).cookie(admin).fromAdminDesk()).andExpect(status().isOk())
        // 요약 수치와 없는 계정은 개인정보를 돌려주지 않으므로 남기지 않습니다.
        mockMvc.perform(get("$ACCOUNTS/summary").cookie(admin).fromAdminDesk()).andExpect(status().isOk())
        mockMvc.perform(get("$ACCOUNTS/999999").cookie(admin).fromAdminDesk()).andExpect(status().isNotFound())

        mockMvc.perform(post("$ACCOUNTS/$adminId/role").cookie(admin).origin().fromAdminDesk().json("""{"role":"USER","reason":"테스트"}"""))
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("ADMIN_SELF_ACTION"))
        mockMvc.perform(post("$memberPath/role").cookie(admin).origin().fromAdminDesk().json("""{"role":"ROOT","reason":"테스트"}"""))
            .andExpect(status().isBadRequest())
        mockMvc.perform(post("$memberPath/role").cookie(admin).origin().fromAdminDesk().json("""{"role":"ADMIN","reason":" 운영 담당 추가 "}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.role").value("ADMIN"))
            .andExpect(jsonPath("$.actions[0].action").value("ADMIN_GRANT"))
            .andExpect(jsonPath("$.actions[0].reason").value("운영 담당 추가"))
            .andExpect(jsonPath("$.actions[0].adminEmail").value("admin@govbiz.local"))
        mockMvc.perform(post("$memberPath/role").cookie(admin).origin().fromAdminDesk().json("""{"role":"ADMIN","reason":"다시"}"""))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("ADMIN_ACCOUNT_STATE_CONFLICT"))
        // 역할은 요청마다 다시 읽으므로 새 관리자는 쓰던 세션으로 바로 관리자 API를 열고, 첫 관리자의 권한을 내릴 수 있습니다.
        mockMvc.perform(get("/api/v1/admin/session").cookie(member)).andExpect(status().isOk())
        mockMvc.perform(post("$ACCOUNTS/$adminId/role").cookie(member).origin().json("""{"role":"USER","reason":"권한 이관"}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.account.role").value("USER"))
            .andExpect(jsonPath("$.actions[0].action").value("ADMIN_REVOKE"))
        mockMvc.perform(post("$memberPath/role").cookie(admin).origin().json("""{"role":"USER","reason":"되돌리기"}"""))
            .andExpect(status().isForbidden())
        // 이제 유일한 활성 관리자는 자기 권한을 내릴 수 없어 관리자가 사라지지 않습니다.
        mockMvc.perform(post("$memberPath/role").cookie(member).origin().json("""{"role":"USER","reason":"테스트"}"""))
            .andExpect(jsonPath("$.code").value("ADMIN_SELF_ACTION"))
        assertEquals(1, count("SELECT COUNT(*) FROM account WHERE role = 'ADMIN' AND deleted_at IS NULL"))

        assertEquals(
            listOf(
                "ACCOUNT_LIST|null|keywordLength=14, sort=RECENT, page=1, pageSize=20, returned=1",
                "ACCOUNT_DETAIL|$memberId|null",
                "ACCOUNT_ADMIN_GRANT|$memberId|role=USER->ADMIN, adminActionId=${actionIdOf(memberId, "ADMIN_GRANT")}",
                "ACCOUNT_ADMIN_REVOKE|$adminId|role=ADMIN->USER, adminActionId=${actionIdOf(adminId, "ADMIN_REVOKE")}",
            ),
            jdbcTemplate.queryForList(
                "SELECT CONCAT(action, '|', IFNULL(target_account_id, 'null'), '|', IFNULL(request_summary, 'null')) FROM admin_access_log ORDER BY id",
                String::class.java,
            ),
        )
        assertEquals(
            listOf("$adminId|$DESK_ADDRESS|$DESK_AGENT", "$adminId|$DESK_ADDRESS|$DESK_AGENT", "$adminId|$DESK_ADDRESS|$DESK_AGENT"),
            jdbcTemplate.queryForList(
                "SELECT CONCAT(actor_account_id, '|', client_ip, '|', user_agent) FROM admin_access_log WHERE actor_account_id = ? ORDER BY id",
                String::class.java,
                adminId,
            ),
        )

        // 감사 기록은 최신순 커서로 읽고, 이 조회도 남습니다.
        val firstPage = mockMvc.perform(get(AUDIT_LOGS).cookie(member).param("targetAccountId", "$memberId").param("limit", "1"))
            .andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.records[0].action").value("ACCOUNT_ADMIN_GRANT"))
            .andExpect(jsonPath("$.records[0].actorAccountId").value(adminId))
            .andExpect(jsonPath("$.records[0].actorEmail").value("admin@govbiz.local"))
            .andExpect(jsonPath("$.records[0].clientIp").value(DESK_ADDRESS))
            .andExpect(jsonPath("$.records[0].userAgent").value(DESK_AGENT))
            .andExpect(jsonPath("$.nextCursor").isNumber())
            .andReturn().response.contentAsString
        val cursor = Regex("\"nextCursor\":(\\d+)").find(firstPage)!!.groupValues[1]
        mockMvc.perform(get(AUDIT_LOGS).cookie(member).param("targetAccountId", "$memberId").param("limit", "1").param("before", cursor))
            .andExpect(jsonPath("$.records[0].action").value("ACCOUNT_DETAIL"))
            .andExpect(jsonPath("$.nextCursor").value(nullValue()))
        mockMvc.perform(get(AUDIT_LOGS).cookie(member).param("action", "AUDIT_LOG_LIST"))
            .andExpect(jsonPath("$.records", hasSize<Any>(2)))
            .andExpect(jsonPath("$.records[1].requestSummary").value("targetAccountId=$memberId, limit=1, returned=1"))
        mockMvc.perform(get(AUDIT_LOGS).cookie(admin)).andExpect(status().isForbidden())
    }

    @Test
    fun anUnwritableAccessLogFailsTheRequestAndRollsTheActionBack() {
        val admin = signUpAdmin("admin@govbiz.local")
        signUp("member@company.co.kr")
        val memberPath = "$ACCOUNTS/${idOf("member@company.co.kr")}"

        // 격리된 테스트 DB에서만 기록 테이블 이름을 잠시 바꿔 쓰기 실패를 만듭니다.
        jdbcTemplate.execute("RENAME TABLE admin_access_log TO admin_access_log_unavailable")
        try {
            mockMvc.perform(get(ACCOUNTS).cookie(admin))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("ADMIN_ACCESS_LOG_UNAVAILABLE"))
                .andExpect(jsonPath("$.accounts").doesNotExist())
            mockMvc.perform(get(memberPath).cookie(admin))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.account").doesNotExist())
            mockMvc.perform(post("$memberPath/suspend").cookie(admin).origin().json("""{"reason":"스팸 제안 반복"}"""))
                .andExpect(status().isServiceUnavailable())
            mockMvc.perform(post("$memberPath/role").cookie(admin).origin().json("""{"role":"ADMIN","reason":"운영 담당 추가"}"""))
                .andExpect(status().isServiceUnavailable())
        } finally {
            jdbcTemplate.execute("RENAME TABLE admin_access_log_unavailable TO admin_access_log")
        }

        // 조치와 사유 기록은 접속기록과 같은 transaction이라 함께 되돌려졌습니다.
        assertEquals(0, count("SELECT COUNT(*) FROM account WHERE email = 'member@company.co.kr' AND (suspended_at IS NOT NULL OR role = 'ADMIN')"))
        assertEquals(0, count("SELECT COUNT(*) FROM account_admin_action"))
        assertEquals(1, count("SELECT COUNT(*) FROM account_session WHERE account_id = ${idOf("member@company.co.kr")}"))
    }

    @Test
    fun theOnlyActiveAdminCannotDeleteTheirOwnAccount() {
        val admin = signUpAdmin("admin@govbiz.local")
        mockMvc.perform(delete("/api/v1/me").cookie(admin).origin().json("""{"password":"password1"}"""))
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("LAST_ADMIN_DELETION"))

        signUpAdmin("second@govbiz.local")
        mockMvc.perform(delete("/api/v1/me").cookie(admin).origin().json("""{"password":"password1"}"""))
            .andExpect(status().isNoContent())
    }

    private fun signUp(email: String): Cookie {
        val response = mockMvc.perform(
            post("/api/v1/auth/signup").fromNextAddress().json(SignupTestHelper.signupJson(jdbcTemplate, email, "password1")),
        )
            .andExpect(status().isCreated())
            .andReturn().response
        return requireNotNull(response.getCookie(SessionCookieHelper.COOKIE_NAME))
    }

    /** 관리자는 가입 화면으로 만들 수 없으므로 가입한 계정의 역할을 SQL로 올립니다. 쓰던 세션은 다음 요청부터 관리자로 읽힙니다. */
    private fun signUpAdmin(email: String): Cookie {
        val session = signUp(email)
        jdbcTemplate.update("UPDATE account SET role = 'ADMIN' WHERE email = ?", email)
        return session
    }

    private fun logIn(email: String) =
        mockMvc.perform(post("/api/v1/auth/login").fromNextAddress().json("""{"email":"$email","password":"password1"}"""))

    /**
     * 가입·로그인 시도 제한은 주소별로 세고 캐시된 Spring 컨텍스트 안에 남습니다. 전체 테스트에서는 앞선 클래스들의 시도가
     * 127.0.0.1에 쌓이므로, 요청마다 문서용 주소(198.51.100.0/24)를 하나씩 바꿔 이 테스트가 제한에 걸리지 않게 합니다.
     */
    private fun MockHttpServletRequestBuilder.fromNextAddress() =
        with { request -> request.remoteAddr = "198.51.100.${nextAddress.getAndIncrement() % 254 + 1}"; request }

    private fun insertCompany(email: String, businessNumber: String, companyName: String) {
        jdbcTemplate.update(
            """
            INSERT INTO company (
                account_id, business_number, company_name, business_status, business_status_code, region, industry,
                founded_year, business_verified_at, created_at, updated_at
            )
            SELECT id, ?, ?, '계속사업자', '01', '서울특별시', '정보통신업', 2021, NOW(6), NOW(6), NOW(6)
            FROM account WHERE email = ?
            """.trimIndent(),
            businessNumber,
            companyName,
            email,
        )
    }

    /** 카카오로만 가입해 비밀번호가 없고 로그인 기록도 없는 계정입니다. */
    private fun insertKakaoAccount(email: String) {
        jdbcTemplate.update(
            "INSERT INTO account (email, password_hash, role, email_verified_at, terms_agreed_at, created_at) VALUES (?, NULL, 'USER', NOW(6), NOW(6), NOW(6))",
            email,
        )
        jdbcTemplate.update(
            "INSERT INTO account_oauth_identity (account_id, provider, subject, linked_at) SELECT id, 'KAKAO', '4012345678', NOW(6) FROM account WHERE email = ?",
            email,
        )
    }

    private fun idOf(email: String): Long =
        requireNotNull(jdbcTemplate.queryForObject("SELECT id FROM account WHERE email = ?", Long::class.java, email))

    private fun actionIdOf(targetAccountId: Long, action: String): Long =
        requireNotNull(
            jdbcTemplate.queryForObject(
                "SELECT id FROM account_admin_action WHERE target_account_id = ? AND action = ?",
                Long::class.java,
                targetAccountId,
                action,
            ),
        )

    /** 관리자 PC 한 대에서 보낸 요청처럼 접속 주소와 User-Agent를 정합니다. 접속기록에 그대로 남는지 봅니다. */
    private fun MockHttpServletRequestBuilder.fromAdminDesk() =
        header(HttpHeaders.USER_AGENT, DESK_AGENT).with { request -> request.remoteAddr = DESK_ADDRESS; request }

    private fun count(sql: String): Int =
        requireNotNull(jdbcTemplate.queryForObject(sql, Int::class.java))

    private fun MockHttpServletRequestBuilder.origin() = header(HttpHeaders.ORIGIN, "http://localhost:5173")

    private fun MockHttpServletRequestBuilder.json(body: String) = contentType(MediaType.APPLICATION_JSON).content(body)

    private companion object {
        const val ACCOUNTS = "/api/v1/admin/accounts"
        const val AUDIT_LOGS = "/api/v1/admin/audit-logs"
        const val DESK_ADDRESS = "203.0.113.9"
        const val DESK_AGENT = "GovBiz-Admin-Test/1.0"
        val nextAddress = AtomicInteger(0)
    }
}
