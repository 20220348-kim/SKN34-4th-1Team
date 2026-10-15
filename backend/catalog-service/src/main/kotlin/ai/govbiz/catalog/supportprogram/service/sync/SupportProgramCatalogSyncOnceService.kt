package ai.govbiz.catalog.supportprogram.service.sync

import ai.govbiz.catalog.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.catalog.supportprogram.facade.SupportProgramCatalogFacade
import ai.govbiz.catalog.supportprogram.helper.SupportProgramIndexTextHelper
import ai.govbiz.catalog.supportprogram.repository.SupportProgramRepository
import ai.govbiz.catalog.supportprogram.service.sync.config.SupportProgramCatalogSyncOnceProperties
import java.math.BigDecimal
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardOpenOption.CREATE_NEW
import java.nio.file.StandardOpenOption.READ
import java.nio.file.StandardOpenOption.WRITE
import java.nio.file.attribute.PosixFilePermissions
import org.slf4j.LoggerFactory

/** 전체 수집과 비용 사전 검사를 마친 동일 스냅샷만 한 번 색인하고 제공처별로 공개합니다. */
class SupportProgramCatalogSyncOnceService(
    private val bizInfo: SupportProgramCatalogFacade,
    private val kStartup: SupportProgramCatalogFacade,
    private val msit: SupportProgramCatalogFacade,
    private val cnTrade: SupportProgramCatalogFacade,
    private val repository: SupportProgramRepository,
    private val indexService: SupportProgramIndexSyncService,
) {
    fun run(properties: SupportProgramCatalogSyncOnceProperties) {
        // 실패/중단한 작업도 다시 청구할 수 있으므로 기존 기록을 삭제하거나 재사용하지 않습니다.
        check(!Files.exists(properties.receiptPath, NOFOLLOW_LINKS)) { "receipt already exists; automatic retry is forbidden" }
        val snapshots = properties.sources.associateWith { source ->
            val programs = when (source) {
                "BIZINFO" -> bizInfo.load()
                "KSTARTUP" -> kStartup.load()
                "MSIT" -> msit.load()
                "CNTRADE_NOTICE" -> cnTrade.load()
                else -> error("unsupported source")
            }
            check(programs.all { it.program.sourceCode == source }) { "snapshot contains another source" }
            check(programs.map { it.program.id }.distinct().size == programs.size) { "duplicate source identities" }
            logger.info("CATALOG_SYNC_ONCE_COLLECTED source={} count={}", source, programs.size)
            programs
        }
        val programs = snapshots.values.flatten()
        check(programs.size <= SupportProgramIndexTextHelper.MAX_DOCUMENTS) { "catalog exceeds supported document limit" }
        // cl100k_base의 byte-level BPE 토큰 수는 UTF-8 바이트 수 이하이며 AI의 8191 토큰 상한도 적용합니다.
        // 동일 스냅샷의 모든 문서를 신규 임베딩한다고 가정합니다. 기존 벡터 재사용에 따른 절약은 빼지 않습니다.
        val tokenUpperBound = programs.sumOf {
            minOf(SupportProgramIndexTextHelper.buildText(it).toByteArray(UTF_8).size, 8191).toLong()
        }
        val costUpperBound = BigDecimal.valueOf(tokenUpperBound).multiply(USD_PER_TOKEN)
        logger.info("CATALOG_SYNC_ONCE_PREFLIGHT count={} tokenUpperBound={} costUpperBoundUsd={} budgetUsd={} apply={}",
            programs.size, tokenUpperBound, costUpperBound.toPlainString(), properties.maxUsd.toPlainString(), properties.apply)
        check(costUpperBound <= properties.maxUsd) { "embedding cost upper bound exceeds approved budget; nothing indexed or published" }
        if (!properties.apply) return

        FileChannel.open(properties.receiptPath, setOf(CREATE_NEW, WRITE), PosixFilePermissions.asFileAttribute(
            PosixFilePermissions.fromString("rw-------"),
        )).use { receipt ->
            append(receipt, "RESERVED model=text-embedding-3-small maxUsd=${properties.maxUsd} upperBoundUsd=$costUpperBound sources=${properties.sources.joinToString(",")}\n")
            // 디렉터리 항목도 영속화한 뒤 유료 API 호출과 DB 변경을 시작합니다.
            FileChannel.open(properties.receiptPath.parent, READ).use { it.force(true) }
            for ((source, snapshot) in snapshots) {
                val generation = repository.startSyncGeneration(source)
                try {
                    check(indexService.indexSnapshot(snapshot) == snapshot.size) { "index count mismatch" }
                    check(repository.publishSnapshotIfCurrent(source, snapshot, generation)) { "a newer sync superseded this run" }
                    append(receipt, "PUBLISHED source=$source count=${snapshot.size} generation=$generation\n")
                    logger.info("CATALOG_SYNC_ONCE_PUBLISHED source={} count={}", source, snapshot.size)
                } catch (exception: RuntimeException) {
                    try {
                        repository.recordSyncFailureIfCurrent(source, generation)
                    } catch (recordingException: RuntimeException) {
                        exception.addSuppressed(recordingException)
                    }
                    throw exception
                }
            }
            append(receipt, "COMPLETED\n")
        }
        logger.info("CATALOG_SYNC_ONCE_OK count={}", programs.size)
    }

    private fun append(channel: FileChannel, value: String) {
        val buffer = ByteBuffer.wrap(value.toByteArray(UTF_8))
        while (buffer.hasRemaining()) channel.write(buffer)
        channel.force(true)
    }

    private companion object {
        // text-embedding-3-small 표준 입력 단가 $0.02 / 1M tokens (2026-09-15). 실행 전 AI 모델과 retry=0을 확인합니다.
        val USD_PER_TOKEN = BigDecimal("0.00000002")
        val logger = LoggerFactory.getLogger(SupportProgramCatalogSyncOnceService::class.java)
    }
}
