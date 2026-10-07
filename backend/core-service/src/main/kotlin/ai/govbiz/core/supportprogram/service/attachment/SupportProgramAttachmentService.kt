package ai.govbiz.core.supportprogram.service.attachment

import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.cntradenotice.CnTradeNoticeAttachmentClient
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachmentLink
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.kstartup.KStartupAttachmentClient
import ai.govbiz.core.supportprogram.client.msit.MsitAttachmentClient
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.config.SupportProgramRequestAdmissionProperties
import ai.govbiz.core.supportprogram.service.attachment.exception.SupportProgramAttachmentException
import ai.govbiz.core.supportprogram.service.attachment.exception.SupportProgramAttachmentException.Reason
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import ai.govbiz.core.supportprogram.service.dto.SupportProgramAttachmentFileResult
import java.io.InputStream
import java.io.OutputStream
import java.time.Duration
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Service
import org.springframework.web.client.RestClientException
import tools.jackson.databind.ObjectMapper

/** 공고 상세의 공식 첨부 목록을 원문에서 읽어 잠시 보관하고, 고른 첨부를 원본에서 받아 그대로 내려 줍니다. */
@Service
class SupportProgramAttachmentService(
    private val details: SupportProgramDetailService,
    private val bizInfo: BizInfoAttachmentClient,
    private val kStartup: KStartupAttachmentClient,
    private val msit: MsitAttachmentClient,
    private val cnTrade: CnTradeNoticeAttachmentClient,
    private val redis: StringRedisTemplate,
    private val json: ObjectMapper,
) {
    // 공고 상세를 열 때마다 불리므로 검색·AI 요청 한도와 따로 세고, 원문 사이트에 가는 요청(보관 목록 없음·받기)만 셉니다.
    private val admission = SupportProgramRequestAdmissionService(
        SupportProgramRequestAdmissionProperties(perClientPerMinute = 30, globalPerMinute = 600, maxConcurrent = 8),
    )

    fun list(sourceCode: String, sourceProgramId: String, clientAddress: String): List<SupportProgramAttachmentFileResult> =
        links(sourceCode, sourceProgramId, clientAddress).mapIndexed { index, link ->
            SupportProgramAttachmentFileResult(index, link.fileName, link.extension)
        }

    /** [index] 첨부를 원본에서 받아 [output]이 연 출력으로 흘려보냅니다. [output]은 파일 이름과 길이(모르면 -1)를 받습니다. */
    fun download(
        sourceCode: String,
        sourceProgramId: String,
        index: Int,
        clientAddress: String,
        output: (fileName: String, contentLength: Long) -> OutputStream,
    ) {
        val link = links(sourceCode, sourceProgramId, clientAddress).getOrNull(index)
            ?: throw SupportProgramAttachmentException(Reason.NOT_FOUND)
        admission.execute(clientAddress) {
            fromSource {
                val receive = { length: Long, body: InputStream -> copy(link.fileName, length, body, output) }
                when (sourceCode) {
                    "BIZINFO" -> bizInfo.open(link, receive)
                    "KSTARTUP" -> kStartup.open(link, receive)
                    "MSIT" -> msit.open(link, receive)
                    "CNTRADE_NOTICE" -> cnTrade.open(link, receive)
                    else -> throw SupportProgramAttachmentException(Reason.NOT_FOUND)
                }
            }
        }
    }

    private fun links(sourceCode: String, sourceProgramId: String, clientAddress: String): List<SupportProgramAttachmentLink> {
        val program = details.get(sourceCode, sourceProgramId)
        val key = "$CACHE_PREFIX$sourceCode:$sourceProgramId"
        redis.opsForValue().get(key)?.let { return json.readValue(it, Array<SupportProgramAttachmentLink>::class.java).toList() }
        val links = admission.execute(clientAddress) {
            fromSource {
                when (sourceCode) {
                    "BIZINFO" -> bizInfo.links(sourceProgramId)
                    "KSTARTUP" -> kStartup.links(sourceProgramId, program.sourceUrl)
                    "MSIT" -> msit.links(sourceProgramId, program.sourceUrl)
                    "CNTRADE_NOTICE" -> cnTrade.links(sourceProgramId, program.title, program.targetDescription)
                    else -> emptyList()
                }
            }
        }
        // 첨부가 없다는 결과도 보관해 같은 공고를 다시 열 때 원문을 또 읽지 않습니다. 실패는 보관하지 않습니다.
        redis.opsForValue().set(key, json.writeValueAsString(links), CACHE_TTL)
        return links
    }

    private fun copy(fileName: String, contentLength: Long, body: InputStream, output: (String, Long) -> OutputStream) {
        if (contentLength > MAX_DOWNLOAD_BYTES) throw SupportProgramAttachmentException(Reason.TOO_LARGE)
        val target = output(fileName, contentLength)
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val read = body.read(buffer)
            if (read < 0) break
            total += read
            // 길이를 알리지 않은 원본이 상한을 넘으면 중간에 끊어 Core가 큰 파일을 끝없이 중계하지 않게 합니다.
            if (total > MAX_DOWNLOAD_BYTES) throw SupportProgramAttachmentException(Reason.TOO_LARGE)
            target.write(buffer, 0, read)
        }
        target.flush()
    }

    private fun <T> fromSource(block: () -> T): T = try {
        block()
    } catch (error: SupportProgramDocumentException) {
        throw SupportProgramAttachmentException(
            if (error.reason == SupportProgramDocumentException.Reason.TOO_LARGE) Reason.TOO_LARGE else Reason.UNAVAILABLE,
            error,
        )
    } catch (error: RestClientException) {
        throw SupportProgramAttachmentException(Reason.UNAVAILABLE, error)
    }

    private companion object {
        const val CACHE_PREFIX = "support-program-attachments:v1:"
        val CACHE_TTL: Duration = Duration.ofHours(6)
        const val MAX_DOWNLOAD_BYTES = 100L * 1024 * 1024
    }
}
