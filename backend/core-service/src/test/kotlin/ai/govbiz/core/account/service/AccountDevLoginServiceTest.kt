package ai.govbiz.core.account.service

import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper.NOW
import ai.govbiz.core.account.helper.SessionTokenHelper
import ai.govbiz.core.account.repository.AccountRepository
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.mockito.Mock
import org.mockito.Mockito.doAnswer
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.eq
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.junit.jupiter.MockitoExtension
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder

@ExtendWith(MockitoExtension::class)
class AccountDevLoginServiceTest {

    @Mock
    private lateinit var repository: AccountRepository

    private val passwordEncoder = BCryptPasswordEncoder(4)

    private lateinit var service: AccountDevLoginService

    @BeforeEach
    fun setUp() {
        service = AccountDevLoginService(
            repository,
            AccountSessionService(repository, AccountTestHelper.sessionProperties(), AccountTestHelper.FIXED_CLOCK),
            passwordEncoder,
            AccountTestHelper.devLoginProperties(
                email = " Admin@GovBiz.local ",
                password = "govbiz-admin1",
                memberEmail = "Member@GovBiz.local",
            ),
            AccountTestHelper.FIXED_CLOCK,
        )
    }

    @Test
    fun createsTheVerifiedAdminAccountWithTheConfiguredPasswordWhenItDoesNotExist() {
        val admin = AccountTestHelper.account(id = 9L, email = "admin@govbiz.local", role = AccountRole.ADMIN, emailVerifiedAt = NOW)
        var created: NewAccount? = null
        doAnswer { invocation ->
            created = invocation.getArgument(0)
            admin
        }.`when`(repository).createAccount(AccountTestHelper.anyValue())

        val result = service.logInAs(AccountRole.ADMIN)

        val newAccount = requireNotNull(created)
        assertEquals("admin@govbiz.local", newAccount.email)
        assertEquals(AccountRole.ADMIN, newAccount.role)
        assertEquals(NOW, newAccount.emailVerifiedAt)
        assertTrue(passwordEncoder.matches("govbiz-admin1", newAccount.passwordHash))
        assertEquals(admin, result.account)
        assertTrue(result.rememberMe)
        verify(repository).createSession(eq(9L), AccountTestHelper.anyValue())
        assertEquals(9L, requireNotNull(SessionTokenHelper.verify(result.sessionToken, AccountTestHelper.JWT_SECRET, AccountTestHelper.FIXED_CLOCK.instant())).accountId)
    }

    @Test
    fun createsAPlainMemberSeedAccountForTheUserRole() {
        val member = AccountTestHelper.account(id = 4L, email = "member@govbiz.local", emailVerifiedAt = NOW)
        var created: NewAccount? = null
        doAnswer { invocation ->
            created = invocation.getArgument(0)
            member
        }.`when`(repository).createAccount(AccountTestHelper.anyValue())

        val result = service.logInAs(AccountRole.USER)

        val newAccount = requireNotNull(created)
        assertEquals("member@govbiz.local", newAccount.email)
        assertEquals(AccountRole.USER, newAccount.role)
        assertEquals(member, result.account)
        verify(repository).createSession(eq(4L), AccountTestHelper.anyValue())
    }

    @Test
    fun reusesTheExistingAccountWithoutCreatingAnotherOne() {
        val admin = AccountTestHelper.account(id = 3L, email = "admin@govbiz.local", role = AccountRole.ADMIN)
        doReturn(admin).`when`(repository).findByEmail("admin@govbiz.local")

        val result = service.logInAs(AccountRole.ADMIN)

        assertEquals(admin, result.account)
        verify(repository, never()).createAccount(AccountTestHelper.anyValue())
        verify(repository).createSession(eq(3L), AccountTestHelper.anyValue())
    }
}
