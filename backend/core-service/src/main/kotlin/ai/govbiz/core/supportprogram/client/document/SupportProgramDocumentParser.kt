package ai.govbiz.core.supportprogram.client.document

import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.ZipInputStream
import java.util.zip.Inflater
import java.util.zip.InflaterInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.apache.poi.poifs.filesystem.POIFSFileSystem
import org.apache.poi.poifs.filesystem.DirectoryNode
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory
import org.apache.pdfbox.Loader
import org.apache.pdfbox.pdmodel.encryption.InvalidPasswordException
import org.apache.pdfbox.text.PDFTextStripper
import org.apache.tika.exception.EncryptedDocumentException
import org.apache.tika.exception.TikaMemoryLimitException
import org.apache.tika.exception.UnsupportedFormatException
import org.apache.tika.io.TikaInputStream
import org.apache.tika.metadata.Metadata
import org.apache.tika.parser.ParseContext
import org.apache.tika.parser.hwp.HwpV5Parser
import org.springframework.stereotype.Component
import org.w3c.dom.Element
import org.xml.sax.Attributes
import org.xml.sax.SAXException
import org.xml.sax.helpers.DefaultHandler

data class SupportProgramDocumentBlock(val locator: String, val text: String)

/** 공식 PDF/HWP/HWPX 원문의 순서와 위치를 보존하며 안전 한도 안에서 텍스트 블록으로 변환합니다. */
@Component
class SupportProgramDocumentParser {
    fun parse(bytes: ByteArray, format: String): List<SupportProgramDocumentBlock> = try {
        if (bytes.size > MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES) fail(Reason.TOO_LARGE)
        val blocks = when (format) {
            "PDF" -> pdf(bytes)
            "HWP" -> hwp(bytes)
            "HWPX" -> hwpx(bytes)
            else -> fail(Reason.UNSUPPORTED)
        }
        if (blocks.sumOf { it.text.length } < 50) fail(Reason.UNSUPPORTED)
        if (blocks.sumOf { it.text.length } > MAX_DOCUMENT_CHARACTERS || blocks.size > 256) fail(Reason.TOO_LARGE)
        blocks
    } catch (error: SupportProgramDocumentException) {
        throw error
    } catch (error: InvalidPasswordException) {
        throw SupportProgramDocumentException(Reason.UNSUPPORTED, cause = error)
    } catch (error: EncryptedDocumentException) {
        throw SupportProgramDocumentException(Reason.UNSUPPORTED, cause = error)
    } catch (error: UnsupportedFormatException) {
        throw SupportProgramDocumentException(Reason.UNSUPPORTED, cause = error)
    } catch (error: TikaMemoryLimitException) {
        throw SupportProgramDocumentException(Reason.TOO_LARGE, cause = error)
    } catch (error: HwpTextLimitException) {
        throw SupportProgramDocumentException(Reason.TOO_LARGE, cause = error)
    } catch (error: Exception) {
        throw SupportProgramDocumentException(Reason.INVALID, cause = error)
    }

    private fun pdf(bytes: ByteArray): List<SupportProgramDocumentBlock> = Loader.loadPDF(bytes).use { document ->
        if (document.isEncrypted || !document.currentAccessPermission.canExtractContent()) fail(Reason.UNSUPPORTED)
        if (document.numberOfPages !in 1..80) fail(Reason.TOO_LARGE)
        buildList {
            for (page in 1..document.numberOfPages) {
                val text = PDFTextStripper().apply { startPage = page; endPage = page; sortByPosition = true }.getText(document).trim()
                if (text.length < 10) fail(Reason.UNSUPPORTED)
                splitText(text).forEachIndexed { part, value ->
                    add(SupportProgramDocumentBlock("PDF page $page part ${part + 1}", value))
                }
            }
        }
    }

    private fun hwp(bytes: ByteArray): List<SupportProgramDocumentBlock> {
        val handler = HwpParagraphHandler()
        TikaInputStream.get(bytes).use { input ->
            HwpV5Parser().parse(input, handler, Metadata(), ParseContext())
        }
        return buildList {
            var buffer = StringBuilder()
            var firstParagraph = 1
            fun flush(lastParagraph: Int) {
                if (buffer.isNotEmpty()) {
                    add(SupportProgramDocumentBlock("HWP paragraphs $firstParagraph-$lastParagraph", buffer.toString()))
                }
                buffer = StringBuilder()
            }
            handler.paragraphs.forEachIndexed { index, paragraph ->
                if (paragraph.length > 3000) {
                    flush(index)
                    splitText(paragraph).forEachIndexed { part, value ->
                        add(SupportProgramDocumentBlock("HWP paragraph ${index + 1} part ${part + 1}", value))
                    }
                    return@forEachIndexed
                }
                if (buffer.length + paragraph.length + 1 > 3000) flush(index)
                if (buffer.isEmpty()) firstParagraph = index + 1 else buffer.append('\n')
                buffer.append(paragraph)
            }
            flush(handler.paragraphs.size)
            addAll(hwpFormControls(bytes))
        }
    }

    /** Tika omits HWP FORM_OBJECT captions. Keep their nearby text as source context. */
    private fun hwpFormControls(bytes: ByteArray): List<SupportProgramDocumentBlock> = buildList {
        POIFSFileSystem(ByteArrayInputStream(bytes)).use { file ->
            val header = file.createDocumentInputStream("FileHeader").use { it.readNBytes(40) }
            if (header.size < 40) fail(Reason.INVALID)
            val compressed = header[36].toInt() and 1 != 0
            val body = file.root.getEntry("BodyText") as DirectoryNode
            var expanded = 0
            body.entries.asSequence().filter { it.name.matches(Regex("Section[0-9]+")) }.sortedBy { it.name.removePrefix("Section").toInt() }.forEach { entry ->
                val raw = body.createDocumentInputStream(entry.name).use { it.readNBytes(MAX_DOCUMENT_CHARACTERS * 4 + 1) }
                val inflater = Inflater(true)
                val data = try {
                    if (compressed) InflaterInputStream(ByteArrayInputStream(raw), inflater).use { it.readNBytes(MAX_DOCUMENT_CHARACTERS * 4 + 1) } else raw
                } finally { inflater.end() }
                expanded += data.size
                if (expanded > MAX_DOCUMENT_CHARACTERS * 4) fail(Reason.TOO_LARGE)
                val records = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
                var context = ""
                var captions = mutableListOf<String>()
                var record = 0
                fun flush() {
                    if (captions.isNotEmpty()) add(SupportProgramDocumentBlock("HWP ${entry.name} form controls near record $record", (context + "\n" + captions.joinToString("\n")).trim()))
                    captions = mutableListOf()
                }
                while (records.remaining() >= 4) {
                    record++
                    val recordHeader = records.int
                    val tag = recordHeader and 1023
                    var size = recordHeader ushr 20
                    if (size == 4095) {
                        if (records.remaining() < 4) fail(Reason.INVALID)
                        size = records.int
                    }
                    if (size < 0 || size > records.remaining()) fail(Reason.INVALID)
                    val payload = ByteArray(size).also { records.get(it) }
                    if (tag == 67) {
                        val text = payload.toString(Charsets.UTF_16LE)
                            .replace(Regex("[\u0001-\u0009\u000b\u000c\u000e-\u0017].{6}[\u0001-\u0017]"), "")
                            .replace(Regex("[\\p{C}]"), " ").trim()
                        if (text.isNotEmpty()) {
                            flush()
                            context = (context + " " + text).takeLast(700)
                        }
                    } else if (tag == 91) {
                        val text = payload.toString(Charsets.UTF_16LE)
                        val match = Regex("Caption:wstring:([0-9]+):").find(text)
                        if (match != null) {
                            val length = match.groupValues[1].toIntOrNull() ?: fail(Reason.INVALID)
                            val start = match.range.last + 1
                            if (length > 100 || start + length > text.length) fail(Reason.INVALID)
                            val caption = text.substring(start, start + length).trim()
                            if (caption.isNotEmpty()) captions.add(caption)
                            if (captions.size > 30) fail(Reason.TOO_LARGE)
                        }
                    }
                }
                if (records.hasRemaining()) fail(Reason.INVALID)
                flush()
            }
        }
    }

    private fun hwpx(bytes: ByteArray): List<SupportProgramDocumentBlock> {
        val sections = sortedMapOf<Int, ByteArray>()
        var expanded = 0
        var entries = 0
        ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                if (++entries > 256 || entry.name.contains("..") || entry.name.startsWith("/")) fail(Reason.INVALID)
                val section = Regex("Contents/section(\\d+)\\.xml").matchEntire(entry.name)
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = zip.read(buffer)
                    if (count < 0) break
                    expanded += count
                    if (expanded > 24 * 1024 * 1024) fail(Reason.TOO_LARGE)
                    if (section != null) output.write(buffer, 0, count)
                }
                if (section != null && sections.put(section.groupValues[1].toInt(), output.toByteArray()) != null) fail(Reason.INVALID)
            }
        }
        if (sections.isEmpty()) fail(Reason.INVALID)
        val factory = DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = true
            setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
            setFeature("http://xml.org/sax/features/external-general-entities", false)
            setFeature("http://xml.org/sax/features/external-parameter-entities", false)
            setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "")
            setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "")
            isXIncludeAware = false
            isExpandEntityReferences = false
        }
        return buildList {
            sections.forEach { (section, xml) ->
                val nodes = factory.newDocumentBuilder().parse(ByteArrayInputStream(xml)).getElementsByTagNameNS(HP, "p")
                var buffer = StringBuilder()
                var start = 1
                fun flush(end: Int) {
                    if (buffer.isNotEmpty()) add(SupportProgramDocumentBlock("HWPX section$section paragraphs $start-$end", buffer.toString()))
                    buffer = StringBuilder()
                }
                for (index in 0 until nodes.length) {
                    val paragraph = nodes.item(index) as Element
                    val text = buildString {
                        for (i in 0 until paragraph.childNodes.length) {
                            val run = paragraph.childNodes.item(i)
                            if (run.namespaceURI != HP || run.localName != "run") continue
                            for (j in 0 until run.childNodes.length) {
                                val child = run.childNodes.item(j)
                                if (child.namespaceURI == HP && child.localName == "t") append(child.textContent)
                            }
                        }
                    }.trim()
                    if (text.isBlank()) continue
                    if (text.length > 3000) {
                        flush(index)
                        splitText(text).forEachIndexed { part, value ->
                            add(SupportProgramDocumentBlock("HWPX section$section paragraph ${index + 1} part ${part + 1}", value))
                        }
                        continue
                    }
                    if (buffer.length + text.length + 1 > 3000) flush(index)
                    if (buffer.isEmpty()) start = index + 1 else buffer.append('\n')
                    buffer.append(text)
                }
                flush(nodes.length)
            }
        }
    }

    private fun splitText(text: String): List<String> = buildList {
        var start = 0
        while (start < text.length) {
            var end = minOf(start + 3000, text.length)
            if (end < text.length && Character.isHighSurrogate(text[end - 1]) && Character.isLowSurrogate(text[end])) end--
            add(text.substring(start, end))
            start = end
        }
    }

    private fun fail(reason: Reason): Nothing = throw SupportProgramDocumentException(reason)

    private class HwpParagraphHandler : DefaultHandler() {
        val paragraphs = mutableListOf<String>()
        private var paragraph: StringBuilder? = null
        private var totalCharacters = 0

        override fun startElement(uri: String?, localName: String?, qName: String?, attributes: Attributes?) {
            if ((localName ?: qName) == "p") paragraph = StringBuilder()
        }

        override fun characters(characters: CharArray, start: Int, length: Int) {
            val target = paragraph ?: return
            totalCharacters += length
            if (totalCharacters > MAX_DOCUMENT_CHARACTERS) throw HwpTextLimitException()
            target.append(characters, start, length)
        }

        override fun endElement(uri: String?, localName: String?, qName: String?) {
            if ((localName ?: qName) != "p") return
            paragraph?.toString()?.trim()?.takeIf(String::isNotBlank)?.let(paragraphs::add)
            paragraph = null
        }
    }

    private class HwpTextLimitException : SAXException()

    companion object {
        const val VERSION = "pdfbox-3.0.8-tika-4.0.0-hwp-form-controls-v2-hwpx-direct-paragraph-v1"
        const val MAX_DOCUMENT_CHARACTERS = 120_000
        private const val HP = "http://www.hancom.co.kr/hwpml/2011/paragraph"
    }
}
