package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFile
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.repository.ApplicationDocumentRepository
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationDocumentDownloadLinkResult
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentDownloadLinkException
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Clock
import java.time.Duration
import java.time.OffsetDateTime
import java.util.Base64
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Service
import tools.jackson.databind.ObjectMapper

/** 브라우저에 로그인 세션을 전달하지 않고 선택한 파일만 짧게 내려받도록 허용한다. */
@Service
class ApplicationDocumentDownloadLinkService(
    private val files: ApplicationDocumentRepository,
    private val accounts: AccountRepository,
    private val redis: StringRedisTemplate,
    private val json: ObjectMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    private val random = SecureRandom()
    private val ttl = Duration.ofMinutes(2)

    fun create(account: Account, preparationId: Long, fileId: Long): ApplicationDocumentDownloadLinkResult {
        files.findOwned(account.id, preparationId, fileId) ?: throw ApplicationPreparationNotFoundException()
        val ticket = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also(random::nextBytes))
        val expiresAt = clock.instant().plus(ttl)
        val grant = DownloadGrant(account.id, preparationId, fileId, expiresAt.toEpochMilli())
        redis.opsForValue().set(key(ticket), json.writeValueAsString(grant), ttl)
        return ApplicationDocumentDownloadLinkResult(preparationId, fileId, ticket, OffsetDateTime.ofInstant(expiresAt, clock.zone))
    }

    fun download(preparationId: Long, fileId: Long, ticket: String): ApplicationDocumentFile {
        if (!Regex("[A-Za-z0-9_-]{43}").matches(ticket)) throw ApplicationDocumentDownloadLinkException()
        val serialized = redis.opsForValue().get(key(ticket)) ?: throw ApplicationDocumentDownloadLinkException()
        val grant = json.readValue(serialized, DownloadGrant::class.java)
        if (grant.preparationId != preparationId || grant.fileId != fileId || clock.millis() >= grant.expiresAtEpochMilli)
            throw ApplicationDocumentDownloadLinkException()
        val account = accounts.findById(grant.ownerId)
        if (account == null || account.isSuspended) throw ApplicationDocumentDownloadLinkException()
        // HEAD·브라우저 재시도를 허용한다. 만료 전에도 삭제·소유권을 매번 다시 확인한다.
        return files.findOwned(grant.ownerId, preparationId, fileId) ?: throw ApplicationDocumentDownloadLinkException()
    }

    private fun key(ticket: String): String {
        val hash = MessageDigest.getInstance("SHA-256").digest(ticket.toByteArray(Charsets.US_ASCII))
        return "application-document-download:${java.util.HexFormat.of().formatHex(hash)}"
    }

    private data class DownloadGrant(val ownerId: Long, val preparationId: Long, val fileId: Long, val expiresAtEpochMilli: Long)
}
