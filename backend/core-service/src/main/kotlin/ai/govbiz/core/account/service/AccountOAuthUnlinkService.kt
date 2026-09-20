package ai.govbiz.core.account.service

import ai.govbiz.core.account.client.oauth.KakaoOAuthClient
import ai.govbiz.core.account.client.oauth.exception.OAuthClientException
import ai.govbiz.core.account.repository.AccountOAuthUnlinkRepository
import org.springframework.stereotype.Service

/** DB 선점 → transaction 밖의 카카오 호출 → DB 결과 확정. 시도 후 불확실한 작업은 자동 재실행하지 않는다. */
@Service
class AccountOAuthUnlinkService(private val repository: AccountOAuthUnlinkRepository, private val client: KakaoOAuthClient) {
    fun execute(id: Long) {
        val job = repository.claim(id) ?: return
        val unlinked = try {
            client.unlink(job.subject)
        } catch (exception: Exception) {
            val code = (exception as? OAuthClientException)?.failure?.name ?: "UNEXPECTED_FAILURE"
            check(repository.markUnknown(id, code)) { "OAuth unlink result requires operator review" }
            return
        }
        // DB 저장 실패를 외부 호출 실패로 오인하거나 재호출하지 않는다. RUNNING은 만료 후 UNKNOWN으로 남는다.
        check(if (unlinked) repository.succeed(job) else repository.failUnconfigured(id)) {
            "OAuth unlink result requires operator review"
        }
    }
}
