package ai.govbiz.core.dailyreport.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.account.service.exception.CompanyNotRegisteredException
import ai.govbiz.core.dailyreport.client.DailyReportMailClient
import ai.govbiz.core.dailyreport.config.DailyReportProperties
import ai.govbiz.core.dailyreport.repository.DailyReportRepository
import ai.govbiz.core.dailyreport.service.dto.DailyReportSettingsResult
import ai.govbiz.core.dailyreport.domain.exception.DailyReportErrorCode
import ai.govbiz.core.dailyreport.domain.exception.DailyReportException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import org.springframework.stereotype.Service

@Service
class DailyReportSubscriptionService(
    private val repository: DailyReportRepository, private val companies: CompanyRepository,
    private val mail: DailyReportMailClient, private val properties: DailyReportProperties,
) {
    fun settings(account: Account): DailyReportSettingsResult {
        val stored = repository.subscription(account.id)
        val confirmed = stored?.confirmedAt != null && stored.confirmedEmail == account.email
        return DailyReportSettingsResult(stored?.supportPurpose.orEmpty(), stored?.enabled == true && confirmed,
            confirmed, mail.isAvailable(), properties.sendHour, properties.enabled)
    }

    fun update(account: Account, supportPurpose: String, enabled: Boolean, consent: Boolean): DailyReportSettingsResult {
        require(supportPurpose.length <= 100)
        if (enabled) {
            companies.findByAccountId(account.id) ?: throw CompanyNotRegisteredException()
            if (!mail.isAvailable()) throw DailyReportException(DailyReportErrorCode.EMAIL_DELIVERY_UNAVAILABLE)
        }
        repository.saveSettings(account.id, account.email, supportPurpose.trim(), enabled, consent)
        return settings(account)
    }

    fun requestVerification(account: Account) {
        if (!mail.isAvailable()) throw DailyReportException(DailyReportErrorCode.EMAIL_DELIVERY_UNAVAILABLE)
        val token = newToken()
        // SMTP 실패 시에도 요청 이력은 남겨 메일 폭주를 방지한다. 외부 호출은 저장 transaction 밖이다.
        repository.reserveVerification(account.id, account.email, hashToken(token))
        mail.sendVerification(account.email, token)
    }

    fun confirm(token: String) {
        if (!TOKEN_PATTERN.matches(token) || !repository.confirmEmail(hashToken(token))) {
            throw DailyReportException(DailyReportErrorCode.INVALID_EMAIL_TOKEN)
        }
    }

    fun unsubscribe(token: String) {
        if (!TOKEN_PATTERN.matches(token) || !repository.unsubscribe(hashToken(token))) {
            throw DailyReportException(DailyReportErrorCode.INVALID_EMAIL_TOKEN)
        }
    }

    companion object {
        private val RANDOM = SecureRandom()
        private val TOKEN_PATTERN = Regex("[A-Za-z0-9_-]{43}")
        internal fun newToken(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also(RANDOM::nextBytes))
        internal fun hashToken(token: String): String = MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}
