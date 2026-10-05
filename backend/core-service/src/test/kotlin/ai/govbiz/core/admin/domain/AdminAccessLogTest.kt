package ai.govbiz.core.admin.domain

import ai.govbiz.core.account.domain.AccountRole
import java.time.LocalDate
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class AdminAccessLogTest {

    @Test
    fun actorKeepsTheRequestAddressAndFitsLongValuesIntoTheColumns() {
        val actor = AdminActor.of(1, " 198.51.100.7 ", " Mozilla/5.0 ${"a".repeat(300)}")

        assertEquals("198.51.100.7", actor.clientIp)
        assertEquals(AdminActor.MAX_USER_AGENT_LENGTH, actor.userAgent?.length)
        assertEquals(AdminActor.UNKNOWN_CLIENT_IP, AdminActor.of(1, null, null).clientIp)
        assertEquals(AdminActor.UNKNOWN_CLIENT_IP, AdminActor.of(1, "  ", null).clientIp)
        assertNull(AdminActor.of(1, "::1", "   ").userAgent)
        assertEquals(AdminActor.MAX_CLIENT_IP_LENGTH, AdminActor.of(1, "f".repeat(80), null).clientIp.length)
        // 이모지처럼 두 칸을 쓰는 문자가 경계에 걸리면 반으로 나누지 않고 뺍니다.
        val emojiAgent = "a".repeat(AdminActor.MAX_USER_AGENT_LENGTH - 1) + "😀"
        assertEquals("a".repeat(AdminActor.MAX_USER_AGENT_LENGTH - 1), AdminActor.of(1, "::1", emojiAgent).userAgent)
        assertThrows(IllegalArgumentException::class.java) { AdminActor(0, "::1", null) }
    }

    @Test
    fun accountListSummaryKeepsConditionNamesAndCountsButNotTheKeywordText() {
        val query = AdminAccountQuery(
            keyword = "kim@company.co.kr",
            status = AdminAccountStatus.SUSPENDED,
            role = AccountRole.ADMIN,
            loginMethod = null,
            sort = AdminAccountSort.LAST_LOGIN,
            page = 2,
            pageSize = 20,
        )

        val summary = query.accessSummary(returned = 3)

        assertEquals("keywordLength=17, status=SUSPENDED, role=ADMIN, sort=LAST_LOGIN, page=2, pageSize=20, returned=3", summary)
        assertFalse(summary.contains("kim"))
        assertEquals(
            "sort=RECENT, page=1, pageSize=20, returned=0",
            query.copy(keyword = "", status = null, role = null, sort = AdminAccountSort.RECENT, page = 1).accessSummary(0),
        )
    }

    @Test
    fun auditQuerySummaryListsOnlyChosenConditionsAndRejectsInvalidPaging() {
        val query = AdminAccessLogQuery(
            actorAccountId = null,
            targetAccountId = 11,
            action = AdminAccessAction.ACCOUNT_DETAIL,
            from = LocalDate.of(2026, 9, 1),
            to = LocalDate.of(2026, 9, 6),
            before = 120,
            limit = 50,
        )

        assertEquals(
            "targetAccountId=11, action=ACCOUNT_DETAIL, from=2026-09-01, to=2026-09-06, before=120, limit=50, returned=2",
            query.accessSummary(returned = 2),
        )
        assertThrows(IllegalArgumentException::class.java) { query.copy(limit = 51) }
        assertThrows(IllegalArgumentException::class.java) { query.copy(actorAccountId = 0) }
        assertThrows(IllegalArgumentException::class.java) { query.copy(before = -1) }
    }

    @Test
    fun newRecordRejectsEmptyOrOversizedSummaries() {
        val actor = AdminActor(1, "198.51.100.7", null)
        val at = LocalDateTime.of(2026, 9, 6, 12, 0)

        assertThrows(IllegalArgumentException::class.java) {
            NewAdminAccessLog(actor, AdminAccessAction.ACCOUNT_LIST, null, "", at)
        }
        assertThrows(IllegalArgumentException::class.java) {
            NewAdminAccessLog(actor, AdminAccessAction.ACCOUNT_LIST, null, "x".repeat(NewAdminAccessLog.MAX_REQUEST_SUMMARY_LENGTH + 1), at)
        }
        assertThrows(IllegalArgumentException::class.java) {
            NewAdminAccessLog(actor, AdminAccessAction.ACCOUNT_DETAIL, 0, null, at)
        }
    }
}
