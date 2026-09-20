package ai.govbiz.core.supportprogram.service.evaluation.helper

import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING

/** 평가 산출 파일을 모두 준비한 뒤 한 번에 교체합니다. */
object SupportProgramSearchEvaluationFileHelper {

    fun writeAtomically(configuredPath: Path, content: ByteArray) {
        val outputPath = configuredPath.toAbsolutePath().normalize()
        val parent = outputPath.parent ?: invalid("evaluation output path must have a parent directory")
        Files.createDirectories(parent)
        val temporaryPath = Files.createTempFile(parent, ".${outputPath.fileName}.", ".tmp")
        try {
            Files.write(temporaryPath, content)
            try {
                Files.move(temporaryPath, outputPath, ATOMIC_MOVE, REPLACE_EXISTING)
            } catch (exception: AtomicMoveNotSupportedException) {
                throw IllegalStateException("evaluation output filesystem does not support atomic moves", exception)
            }
        } finally {
            Files.deleteIfExists(temporaryPath)
        }
    }

    private fun invalid(message: String): Nothing = throw IllegalArgumentException(message)
}
