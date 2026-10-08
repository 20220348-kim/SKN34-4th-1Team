package ai.govbiz.core.supportprogram.service.saved

import ai.govbiz.core.supportprogram.client.SavedSupportProgramPrefetchQueueClient
import ai.govbiz.core.supportprogram.domain.SavedSupportProgramPrefetchStatus
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.facade.AiSupportProgramEvidenceFacade
import ai.govbiz.core.supportprogram.facade.SupportProgramSourceDocumentFacade
import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import ai.govbiz.core.supportprogram.repository.SavedSupportProgramRepository
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceChunk
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceChunker
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import ai.govbiz.core.supportprogram.service.evidence.exception.SupportProgramEvidenceNotSupportedException
import ai.govbiz.core.supportprogram.service.evidence.exception.SupportProgramEvidenceUnavailableException
import com.rabbitmq.client.Channel
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.anyList
import org.mockito.Mockito
import org.mockito.Mockito.`when`
import org.springframework.amqp.core.MessageBuilder

class SavedSupportProgramPrefetchTest {
    private val repository = Mockito.mock(SavedSupportProgramRepository::class.java)
    private val evidence = Mockito.mock(SupportProgramEvidenceService::class.java)
    private val facade = Mockito.mock(AiSupportProgramEvidenceFacade::class.java)
    private val service = SavedSupportProgramPrefetchService(repository, evidence, facade)
    private val program = SupportProgram(
        "PBLN_000000000000001", "BIZINFO", "공고", "기관", "요약", emptyList(), emptyList(), "대상", "기간", null, LocalDate.of(2026, 9, 30),
        SupportProgramStatus.OPEN, "기업마당", "https://www.bizinfo.go.kr/1", emptyList(),
    )
    private val chunk = SupportProgramEvidenceChunk("c".repeat(64), "h".repeat(64), program.sourceQualifiedId, 0, "본문")

    @Test
    fun prefetchIndexesTheCurrentSourceAndMarksDone() {
        `when`(repository.findPublishedProgram(5L)).thenReturn(program)
        `when`(evidence.prepareChunks(program)).thenReturn(listOf(chunk))
        service.prefetch(5L)
        Mockito.verify(facade).index(listOf(chunk))
        Mockito.verify(repository).finishPrefetch(5L, SavedSupportProgramPrefetchStatus.DONE)
    }

    @Test
    fun unsupportedProgramsAreClosedAsFailedWithoutIndexing() {
        `when`(repository.findPublishedProgram(5L)).thenReturn(program)
        `when`(evidence.prepareChunks(program)).thenThrow(SupportProgramEvidenceNotSupportedException())
        service.prefetch(5L)
        Mockito.verify(facade, Mockito.never()).index(anyList())
        Mockito.verify(repository).finishPrefetch(5L, SavedSupportProgramPrefetchStatus.FAILED)
    }

    @Test
    fun kStartupProgramsArePreparedLikeBizInfoWhileMsitProgramsAreClosedAsFailed() {
        val sourceDocuments = Mockito.mock(SupportProgramSourceDocumentFacade::class.java)
        val programs = Mockito.mock(SupportProgramRepository::class.java)
        val realEvidence = SupportProgramEvidenceService(
            Mockito.mock(SupportProgramDetailService::class.java), programs, sourceDocuments, facade,
            Clock.fixed(Instant.parse("2026-09-05T03:00:00Z"), ZoneId.of("Asia/Seoul")),
        )
        val prefetch = SavedSupportProgramPrefetchService(repository, realEvidence, facade)
        val kStartup = program.copy(id = "178927", sourceCode = "KSTARTUP", sourceName = "K-Startup",
            sourceUrl = "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=178927")
        val msit = program.copy(id = "3186573", sourceCode = "MSIT", sourceName = "과학기술정보통신부",
            sourceUrl = "https://www.msit.go.kr/bbs/view.do?nttSeqNo=3186573")
        val content = "공고명: 178927 공고\n공식 원문: ${kStartup.sourceUrl}\n\n제출서류: 참가신청서 1부"
        val document = SupportProgramSourceDocument("KSTARTUP", "178927", kStartup.sourceUrl, content,
            SupportProgramContentHashHelper.sha256(content), LocalDateTime.of(2026, 9, 5, 12, 0))
        `when`(repository.findPublishedProgram(7L)).thenReturn(kStartup)
        `when`(repository.findPublishedProgram(8L)).thenReturn(msit)
        `when`(sourceDocuments.load(kStartup)).thenReturn(document)

        prefetch.prefetch(7L)
        prefetch.prefetch(8L)

        Mockito.verify(programs).upsertSourceDocument(document)
        Mockito.verify(facade).index(SupportProgramEvidenceChunker.chunk(document))
        Mockito.verify(repository).finishPrefetch(7L, SavedSupportProgramPrefetchStatus.DONE)
        Mockito.verify(repository).finishPrefetch(8L, SavedSupportProgramPrefetchStatus.FAILED)
        Mockito.verify(sourceDocuments, Mockito.never()).load(msit)
    }

    @Test
    fun transientFailuresPropagateSoTheMessageIsRetriedAndMissingRowsAreIgnored() {
        `when`(repository.findPublishedProgram(5L)).thenReturn(program)
        `when`(evidence.prepareChunks(program)).thenThrow(SupportProgramEvidenceUnavailableException(IllegalStateException("bizinfo down")))
        assertThrows(SupportProgramEvidenceUnavailableException::class.java) { service.prefetch(5L) }
        Mockito.verify(repository, Mockito.never()).finishPrefetch(Mockito.eq(5L), Mockito.any() ?: SavedSupportProgramPrefetchStatus.DONE)

        `when`(repository.findPublishedProgram(6L)).thenReturn(null)
        service.prefetch(6L)
        Mockito.verify(evidence, Mockito.times(1)).prepareChunks(program)
    }

    @Test
    fun schedulerPublishesReservedRowsAndStopsAtTheFirstUnconfirmedPublication() {
        val client = Mockito.mock(SavedSupportProgramPrefetchQueueClient::class.java)
        `when`(repository.publishablePrefetch()).thenReturn(listOf(1L, 2L, 3L, 4L))
        `when`(repository.reservePrefetchPublication(1L)).thenReturn(true)
        `when`(repository.reservePrefetchPublication(2L)).thenReturn(false)
        `when`(repository.reservePrefetchPublication(3L)).thenReturn(true)
        `when`(repository.reservePrefetchPublication(4L)).thenReturn(true)
        Mockito.doThrow(IllegalStateException("broker")).`when`(client).publish(3L)

        SavedSupportProgramPrefetchOutboxScheduler(repository, client).publishPending()

        Mockito.verify(repository).expireStalePrefetch()
        Mockito.verify(client).publish(1L)
        Mockito.verify(repository).markPrefetchPublished(1L)
        Mockito.verify(client, Mockito.never()).publish(2L)
        Mockito.verify(client, Mockito.never()).publish(4L)
        Mockito.verify(repository, Mockito.never()).markPrefetchPublished(3L)
    }

    @Test
    fun consumerAcksRecordedOutcomesAndRejectsMalformedOrUnconfirmedOnes() {
        val prefetch = Mockito.mock(SavedSupportProgramPrefetchService::class.java)
        val channel = Mockito.mock(Channel::class.java)
        val consumer = SavedSupportProgramPrefetchConsumer(prefetch)

        consumer.receive(MessageBuilder.withBody("v1:5".toByteArray()).build().also { it.messageProperties.deliveryTag = 11L }, channel)
        Mockito.verify(prefetch).prefetch(5L)
        Mockito.verify(channel).basicAck(11L, false)

        consumer.receive(MessageBuilder.withBody("v1:abc".toByteArray()).build().also { it.messageProperties.deliveryTag = 12L }, channel)
        Mockito.verify(channel).basicReject(12L, false)

        Mockito.doThrow(IllegalStateException("unconfirmed")).`when`(prefetch).prefetch(6L)
        consumer.receive(MessageBuilder.withBody("v1:6".toByteArray()).build().also { it.messageProperties.deliveryTag = 13L }, channel)
        Mockito.verify(channel).basicReject(13L, false)
    }
}
