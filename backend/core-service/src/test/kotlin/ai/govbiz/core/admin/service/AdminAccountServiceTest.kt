package ai.govbiz.core.admin.service

import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.admin.domain.AdminAccessAction
import ai.govbiz.core.admin.domain.AdminAccountActionType
import ai.govbiz.core.admin.domain.AdminAccountActivity
import ai.govbiz.core.admin.domain.AdminAccountPage
import ai.govbiz.core.admin.domain.AdminAccountQuery
import ai.govbiz.core.admin.domain.AdminAccountSort
import ai.govbiz.core.admin.domain.AdminAccountStatus
import ai.govbiz.core.admin.domain.AdminAccountSummary
import ai.govbiz.core.admin.domain.AdminAccountTarget
import ai.govbiz.core.admin.domain.AdminActor
import ai.govbiz.core.admin.repository.AdminAccountRepository
import ai.govbiz.core.admin.service.exception.AdminAccessDeniedException
import ai.govbiz.core.admin.service.exception.AdminAccessLogUnavailableException
import ai.govbiz.core.admin.service.exception.AdminAccountNotFoundException
import ai.govbiz.core.admin.service.exception.AdminAccountStateConflictException
import ai.govbiz.core.admin.service.exception.AdminLastActiveAdminException
import ai.govbiz.core.admin.service.exception.AdminSelfActionException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.anyLong
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.inOrder
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.junit.jupiter.MockitoExtension

@ExtendWith(MockitoExtension::class)
class AdminAccountServiceTest {

    @Mock
    private lateinit var repository: AdminAccountRepository

    @Mock
    private lateinit var accountRepository: AccountRepository

    @Mock
    private lateinit var accessLog: AdminAccessLogService

    private lateinit var service: AdminAccountService

    private val actor = AdminActor(ADMIN_ID, "198.51.100.7", "Mozilla/5.0")

    @BeforeEach
    fun setUp() {
        service = AdminAccountService(repository, accountRepository, accessLog, AccountTestHelper.FIXED_CLOCK)
    }

    @Test
    fun listRecordsConditionsAndCountWithoutTheKeywordText() {
        val query = AdminAccountQuery("kim@company.co.kr", AdminAccountStatus.SUSPENDED, null, null, AdminAccountSort.RECENT, 2, 20)
        doReturn(AdminAccountPage(listOf(summary(MEMBER_ID)), 21, 2, 20)).`when`(repository).findPage(query)

        assertEquals(21, service.findPage(actor, query).total)

        verify(accessLog).record(
            actor,
            AdminAccessAction.ACCOUNT_LIST,
            null,
            "keywordLength=17, status=SUSPENDED, sort=RECENT, page=2, pageSize=20, returned=1",
        )
    }

    @Test
    fun detailIsRecordedOnlyWhenAnAccountIsReturned() {
        doReturn(null).`when`(repository).findSummary(MISSING_ID)
        assertThrows(AdminAccountNotFoundException::class.java) { service.detail(actor, MISSING_ID) }
        verifyNoInteractions(accessLog)

        stubDetail(MEMBER_ID)
        assertEquals(MEMBER_ID, service.detail(actor, MEMBER_ID).account.id)
        verify(accessLog).record(actor, AdminAccessAction.ACCOUNT_DETAIL, MEMBER_ID, null)
    }

    @Test
    fun anUnwrittenAccessLogKeepsTheDetailFromBeingReturned() {
        stubDetail(MEMBER_ID)
        doThrow(AdminAccessLogUnavailableException(IllegalStateException("database down")))
            .`when`(accessLog).record(actor, AdminAccessAction.ACCOUNT_DETAIL, MEMBER_ID, null)

        assertThrows(AdminAccessLogUnavailableException::class.java) { service.detail(actor, MEMBER_ID) }
    }

    @Test
    fun suspendingRecordsTheReasonAndPointsTheAccessLogAtThatRecord() {
        doReturn(AdminAccountTarget(MEMBER_ID, AccountRole.USER, null)).`when`(repository).lockTarget(MEMBER_ID)
        doReturn(31L).`when`(repository).recordAction(MEMBER_ID, ADMIN_ID, AdminAccountActionType.SUSPEND, "스팸 제안 반복", NOW)
        stubDetail(MEMBER_ID)

        service.suspend(actor, MEMBER_ID, "  스팸 제안 반복 ")

        val order = inOrder(repository, accountRepository, accessLog)
        order.verify(repository).updateSuspendedAt(MEMBER_ID, NOW)
        order.verify(accountRepository).deleteAllSessionsByAccountId(MEMBER_ID)
        order.verify(repository).recordAction(MEMBER_ID, ADMIN_ID, AdminAccountActionType.SUSPEND, "스팸 제안 반복", NOW)
        order.verify(accessLog).record(actor, AdminAccessAction.ACCOUNT_SUSPEND, MEMBER_ID, "adminActionId=31")
    }

    @Test
    fun grantingAdminLocksBothAccountsInIdOrderAndRecordsTheRoleChange() {
        // 처리자 ID(5)가 대상 ID(3)보다 커도 작은 ID부터 잠가, 서로를 바꾸는 두 요청이 교착하지 않습니다.
        val laterAdmin = AdminActor(5, "198.51.100.7", null)
        doReturn(AdminAccountTarget(3, AccountRole.USER, null)).`when`(repository).lockTarget(3)
        doReturn(AdminAccountTarget(5, AccountRole.ADMIN, null)).`when`(repository).lockTarget(5)
        doReturn(41L).`when`(repository).recordAction(3, 5, AdminAccountActionType.ADMIN_GRANT, "운영 담당 추가", NOW)
        stubDetail(3)

        service.changeRole(laterAdmin, 3, AccountRole.ADMIN, " 운영 담당 추가 ")

        val order = inOrder(repository, accessLog)
        order.verify(repository).lockTarget(3)
        order.verify(repository).lockTarget(5)
        order.verify(repository).updateRole(3, AccountRole.ADMIN)
        order.verify(repository).recordAction(3, 5, AdminAccountActionType.ADMIN_GRANT, "운영 담당 추가", NOW)
        order.verify(accessLog).record(laterAdmin, AdminAccessAction.ACCOUNT_ADMIN_GRANT, 3L, "role=USER->ADMIN, adminActionId=41")
        // 권한을 주는 일은 활성 관리자 수를 줄이지 않으므로 세지 않습니다.
        verifyNoInteractions(accountRepository)
    }

    @Test
    fun revokingAdminKeepsAnotherActiveAdminAndRecordsTheRoleChange() {
        doReturn(AdminAccountTarget(ADMIN_ID, AccountRole.ADMIN, null)).`when`(repository).lockTarget(ADMIN_ID)
        doReturn(AdminAccountTarget(OTHER_ADMIN_ID, AccountRole.ADMIN, null)).`when`(repository).lockTarget(OTHER_ADMIN_ID)
        doReturn(2).`when`(accountRepository).countActiveAdmins()
        doReturn(42L).`when`(repository).recordAction(OTHER_ADMIN_ID, ADMIN_ID, AdminAccountActionType.ADMIN_REVOKE, "퇴사", NOW)
        stubDetail(OTHER_ADMIN_ID)

        service.changeRole(actor, OTHER_ADMIN_ID, AccountRole.USER, "퇴사")

        verify(repository).updateRole(OTHER_ADMIN_ID, AccountRole.USER)
        verify(accessLog).record(actor, AdminAccessAction.ACCOUNT_ADMIN_REVOKE, OTHER_ADMIN_ID, "role=ADMIN->USER, adminActionId=42")
    }

    @Test
    fun refusesToChangeYourOwnRoleBeforeLockingAnything() {
        assertThrows(AdminSelfActionException::class.java) { service.changeRole(actor, ADMIN_ID, AccountRole.USER, "사유") }
        verifyNoInteractions(repository, accessLog)
    }

    @Test
    fun anAdminWhoLostTheRoleMeanwhileCannotChangeOtherRoles() {
        // 다른 관리자가 먼저 이 관리자의 권한을 내렸다면 잠근 뒤 다시 읽은 역할로 막습니다.
        doReturn(AdminAccountTarget(ADMIN_ID, AccountRole.USER, null)).`when`(repository).lockTarget(ADMIN_ID)
        doReturn(AdminAccountTarget(OTHER_ADMIN_ID, AccountRole.ADMIN, null)).`when`(repository).lockTarget(OTHER_ADMIN_ID)

        assertThrows(AdminAccessDeniedException::class.java) { service.changeRole(actor, OTHER_ADMIN_ID, AccountRole.USER, "사유") }
        verify(repository, never()).updateRole(anyLong(), AccountTestHelper.anyValue())
        verifyNoInteractions(accessLog)
    }

    @Test
    fun refusesMissingTargetsSameRolesAndPromotingSuspendedAccounts() {
        doReturn(AdminAccountTarget(ADMIN_ID, AccountRole.ADMIN, null)).`when`(repository).lockTarget(ADMIN_ID)
        doReturn(null).`when`(repository).lockTarget(MISSING_ID)
        assertThrows(AdminAccountNotFoundException::class.java) { service.changeRole(actor, MISSING_ID, AccountRole.ADMIN, "사유") }

        doReturn(AdminAccountTarget(MEMBER_ID, AccountRole.USER, null)).`when`(repository).lockTarget(MEMBER_ID)
        assertThrows(AdminAccountStateConflictException::class.java) { service.changeRole(actor, MEMBER_ID, AccountRole.USER, "사유") }

        doReturn(AdminAccountTarget(MEMBER_ID, AccountRole.USER, NOW)).`when`(repository).lockTarget(MEMBER_ID)
        assertThrows(AdminAccountStateConflictException::class.java) { service.changeRole(actor, MEMBER_ID, AccountRole.ADMIN, "사유") }

        verify(repository, never()).updateRole(anyLong(), AccountTestHelper.anyValue())
        verifyNoInteractions(accessLog)
    }

    @Test
    fun refusesToDemoteTheLastActiveAdmin() {
        doReturn(AdminAccountTarget(ADMIN_ID, AccountRole.ADMIN, null)).`when`(repository).lockTarget(ADMIN_ID)
        doReturn(AdminAccountTarget(OTHER_ADMIN_ID, AccountRole.ADMIN, null)).`when`(repository).lockTarget(OTHER_ADMIN_ID)
        doReturn(1).`when`(accountRepository).countActiveAdmins()

        assertThrows(AdminLastActiveAdminException::class.java) { service.changeRole(actor, OTHER_ADMIN_ID, AccountRole.USER, "사유") }
        verify(repository, never()).updateRole(anyLong(), AccountTestHelper.anyValue())
        verifyNoInteractions(accessLog)
    }

    @Test
    fun demotingASuspendedAdminDoesNotNeedAnotherActiveAdminCount() {
        doReturn(AdminAccountTarget(ADMIN_ID, AccountRole.ADMIN, null)).`when`(repository).lockTarget(ADMIN_ID)
        doReturn(AdminAccountTarget(OTHER_ADMIN_ID, AccountRole.ADMIN, NOW)).`when`(repository).lockTarget(OTHER_ADMIN_ID)
        doReturn(43L).`when`(repository).recordAction(OTHER_ADMIN_ID, ADMIN_ID, AdminAccountActionType.ADMIN_REVOKE, "정리", NOW)
        stubDetail(OTHER_ADMIN_ID)

        service.changeRole(actor, OTHER_ADMIN_ID, AccountRole.USER, "정리")

        verify(repository).updateRole(OTHER_ADMIN_ID, AccountRole.USER)
        verifyNoInteractions(accountRepository)
    }

    private fun stubDetail(accountId: Long) {
        doReturn(summary(accountId)).`when`(repository).findSummary(accountId)
        doReturn(null).`when`(repository).findCompany(accountId)
        doReturn(AdminAccountActivity(0, 0, 0, 0)).`when`(repository).findActivity(accountId, NOW.toLocalDate(), NOW)
        doReturn(emptyList<Any>()).`when`(repository).findActions(accountId, AdminAccountService.ACTION_HISTORY_LIMIT)
    }

    private fun summary(accountId: Long): AdminAccountSummary =
        AdminAccountSummary(
            id = accountId,
            email = "account$accountId@company.co.kr",
            role = AccountRole.USER,
            emailVerified = true,
            hasPassword = true,
            oauthProviders = emptySet(),
            companyName = null,
            businessNumber = null,
            suspendedAt = null,
            createdAt = NOW,
            lastLoginAt = null,
        )

    private companion object {
        const val ADMIN_ID = 1L
        const val OTHER_ADMIN_ID = 2L
        const val MEMBER_ID = 11L
        const val MISSING_ID = 99L
    }
}
