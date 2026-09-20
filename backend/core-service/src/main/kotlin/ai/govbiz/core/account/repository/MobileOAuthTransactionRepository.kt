package ai.govbiz.core.account.repository

import ai.govbiz.core.account.domain.MobileOAuthTransaction
import ai.govbiz.core.account.domain.OAuthProvider
import ai.govbiz.core.account.repository.mapper.MobileOAuthTransactionDbRow
import ai.govbiz.core.account.repository.mapper.MobileOAuthTransactionMapper
import java.time.LocalDateTime
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

@Repository
class MobileOAuthTransactionRepository(private val mapper: MobileOAuthTransactionMapper) {
    fun create(transaction: MobileOAuthTransaction) {
        mapper.deleteExpired(transaction.expiresAt.minusDays(1))
        mapper.insert(MobileOAuthTransactionDbRow(transaction.stateHash, transaction.provider.name,
            transaction.redirectUri, transaction.appState, transaction.codeChallenge,
            transaction.rememberMe, transaction.expiresAt))
    }

    /** UPDATE의 조건과 행 잠금으로 다중 서버에서도 콜백 하나만 공급자 코드를 교환합니다. */
    @Transactional
    fun claimCallback(stateHash: String, provider: OAuthProvider, now: LocalDateTime): MobileOAuthTransaction? {
        if (mapper.claimCallback(stateHash, provider.name, now) != 1) return null
        return mapper.findByStateHash(stateHash)?.toDomain()
    }

    fun issueCode(stateHash: String, codeHash: String, accountId: Long, expiresAt: LocalDateTime) {
        check(mapper.issueCode(stateHash, codeHash, accountId, expiresAt) == 1) { "Mobile OAuth callback was not claimed" }
    }

    /** Service의 세션 생성 transaction에 참여하므로 세션 저장 실패 시 코드 소비도 rollback됩니다. */
    @Transactional
    fun consumeCode(codeHash: String, redirectUri: String, challenge: String, now: LocalDateTime): MobileOAuthTransaction? {
        if (mapper.consumeCode(codeHash, redirectUri, challenge, now) != 1) return null
        return mapper.findByCodeHash(codeHash)?.toDomain()
    }

    private fun MobileOAuthTransactionDbRow.toDomain() = MobileOAuthTransaction(
        stateHash, OAuthProvider.valueOf(provider), redirectUri, appState, codeChallenge, rememberMe, expiresAt, accountId,
    )
}
