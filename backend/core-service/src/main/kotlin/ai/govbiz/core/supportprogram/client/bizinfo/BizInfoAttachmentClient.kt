package ai.govbiz.core.supportprogram.client.bizinfo

import ai.govbiz.core._common.helper.AttachmentCopyHelper
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES
import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENTS_TOTAL_BYTES
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachment
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachmentLink
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachments
import ai.govbiz.core.supportprogram.client.document.helper.SupportProgramAttachmentLinkHelper
import java.io.InputStream
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

/** 기업마당 공고 ID로 공식 페이지를 찾고 그 페이지가 직접 연결한 PDF/HWP/HWPX/DOCX/XLSX 첨부만 수집합니다. */
@Component
class BizInfoAttachmentClient(
    private val htmlClient: BizInfoSourceDocumentClient,
    @param:Qualifier("bizInfoSourceDocumentRestClient") private val restClient: RestClient,
) {
    fun collect(sourceCode: String, sourceProgramId: String): SupportProgramAttachments {
        if (sourceCode != "BIZINFO" || !Regex("PBLN_[0-9]{1,32}").matches(sourceProgramId)) fail(Reason.UNSUPPORTED)
        try {
            val url = "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=$sourceProgramId"
            val page = Jsoup.parse(htmlClient.fetchHtml(url, sourceProgramId), url)
            val detail = page.selectFirst(".support_project_detail") ?: fail(Reason.NOT_FOUND)
            val title = detail.selectFirst(".title_area .title")?.text()?.trim().orEmpty()
            if (title.isBlank()) fail(Reason.NOT_FOUND)
            val links = linkedMapOf<String, Pair<String, String>>()
            val bodyExports = mutableSetOf<String>()
            val warnings = mutableListOf("공식 페이지가 직접 연결한 PDF/HWP/HWPX/DOCX/XLSX만 수집했습니다. 추출 문항은 사용자가 원문과 대조해야 합니다.")
            detail.select(".file_name").forEach { name ->
                val anchor = name.parent()?.selectFirst("a[href*='/cmm/fms/fileDown.do']")
                if (anchor != null) {
                    addLink(links, warnings, anchor.absUrl("href"), name.text())
                    if (sectionOf(name) == BODY_EXPORT_SECTION) bodyExports.add(URI(anchor.absUrl("href")).toString())
                }
            }
            val mssPages = detail.select("a[href]").mapNotNull { anchor ->
                runCatching { URI(anchor.absUrl("href")) }.getOrNull()?.takeIf(::isMssPage)
            }.distinct()
            if (mssPages.size > 1) fail(Reason.INVALID)
            mssPages.singleOrNull()?.let { mss ->
                val linked = Jsoup.parse(String(download(mss, 500_000), StandardCharsets.UTF_8), mss.toString())
                val board = linked.selectFirst(".board_view") ?: fail(Reason.INVALID)
                board.select("a[href*='/common/board/Download.do']").forEach { anchor ->
                    val label = anchor.parent()?.selectFirst(".name")?.text()
                        ?: anchor.parent()?.parent()?.selectFirst(".name")?.text().orEmpty()
                    addLink(links, warnings, anchor.absUrl("href"), label)
                }
            }
            // 받을 수 있는 첨부가 없어도(ZIP만 있는 공고 등) 어떤 첨부를 왜 받지 못했는지는 안내로 남깁니다.
            if (links.isEmpty()) throw SupportProgramDocumentException(Reason.UNSUPPORTED, warnings = warnings.distinct())
            if (warnings.distinct().size > 12) throw SupportProgramDocumentException(Reason.TOO_LARGE, warnings = warnings.distinct())
            // 같은 표제를 형식만 바꿔 함께 올린 사본은 한 문서로 묶어 개수 상한에 한 번만 셉니다. 같은 형식이면 발행기관(중기부)
            // 게시판 파일을 앞에 둡니다. 분석은 묶음에서 읽히는 첫 사본을 쓰므로, 우선 사본을 받거나 읽지 못해도 다른 사본으로 이어갑니다.
            val order = links.keys.withIndex().associate { it.value to it.index }
            val candidates = links.entries.sortedBy { if (isMss(URI(it.key))) 0 else 1 }
            val groups = AttachmentCopyHelper.copyGroups(candidates) { it.value.first }.sortedBy { order.getValue(it.first().key) }
                .map { group ->
                    // 기업마당 사본은 발행기관(중기부) HWPX를 변환한 같은 문서라 받지 않습니다.
                    val publisher = group.first()
                    if (!isMss(URI(publisher.key)) || publisher.value.second != "HWPX" || group.all { isMss(URI(it.key)) }) group
                    else group.filter { isMss(URI(it.key)) }.also {
                        warnings.add("동일 표제의 기업마당 변환본 대신 발행기관 중기부 HWPX를 사용했습니다: ${publisher.value.first.take(200)}")
                    }
                }
            // 본문출력파일은 공고 본문에 넣은 파일이라 개수 상한에 넣지 않습니다. 첨부가 상한을 넘으면 앞의 것만 받고 나머지는 알립니다.
            val attachments = groups.filter { group -> group.none { it.key in bodyExports } }
            val selected = attachments.take(MAX_ATTACHMENTS) + groups.filter { group -> group.any { it.key in bodyExports } }
            attachments.drop(MAX_ATTACHMENTS).forEach { group ->
                warnings.add("첨부가 ${MAX_ATTACHMENTS}개를 넘어 받지 않은 첨부: ${group.first().value.first.take(200)}")
            }
            val files = mutableListOf<SupportProgramAttachment>()
            var totalBytes = 0
            val sizeFailures = mutableMapOf<List<Map.Entry<String, Pair<String, String>>>, String>()
            fun receive(group: List<Map.Entry<String, Pair<String, String>>>, entry: Map.Entry<String, Pair<String, String>>): Boolean {
                val (link, descriptor) = entry.key to entry.value
                var mimeType: String? = null
                val bytes = try {
                    download(URI(link), MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES) { mimeType = it }
                } catch (error: SupportProgramDocumentException) {
                    if (error.reason != Reason.TOO_LARGE) throw error
                    sizeFailures.putIfAbsent(group, "파일 크기 제한 초과")
                    return false
                }
                if (totalBytes + bytes.size > MAX_SUPPORT_PROGRAM_ATTACHMENTS_TOTAL_BYTES) {
                    sizeFailures.putIfAbsent(group, "공고별 전체 크기 제한 초과")
                    return false
                }
                if (files.any { it.bytes.contentEquals(bytes) }) {
                    // 첨부파일과 본문출력파일 구역에 같은 파일이 함께 걸린 경우입니다.
                    if (group.size == 1) warnings.add("같은 파일이 두 번 연결되어 한 번만 받았습니다: ${descriptor.first.take(200)}")
                    return true
                }
                files.add(SupportProgramAttachment(link, descriptor.first.take(300), descriptor.second, bytes, mimeType))
                totalBytes += bytes.size
                return true
            }
            // 각 문서의 우선 사본을 먼저 받아, 다른 형식 사본이 전체 크기 한도를 먼저 차지하지 않게 합니다.
            val received = selected.filter { group -> receive(group, group.first()) }.toMutableSet()
            selected.forEach { group ->
                group.drop(1).forEach { entry -> if (receive(group, entry)) received += group }
            }
            selected.filter { it !in received }.forEach { group ->
                warnings.add("미수집 첨부(${sizeFailures[group] ?: "파일 크기 제한 초과"}): ${group.first().value.first.take(250)}")
            }
            if (files.isEmpty()) {
                throw SupportProgramDocumentException(if (sizeFailures.isNotEmpty()) Reason.TOO_LARGE else Reason.UNSUPPORTED, warnings = warnings.distinct())
            }
            return SupportProgramAttachments(title, files, warnings.distinct(), url)
        } catch (error: SupportProgramDocumentException) {
            throw error
        } catch (error: Exception) {
            throw SupportProgramDocumentException(Reason.UNAVAILABLE, cause = error)
        }
    }

    /** 공고 상세에 보여 줄 첨부 목록입니다. 분석용 [collect]와 달리 형식·개수를 거르지 않고 이미지만 빼며 파일은 받지 않습니다. */
    fun links(sourceProgramId: String): List<SupportProgramAttachmentLink> {
        if (!Regex("PBLN_[0-9]{1,32}").matches(sourceProgramId)) fail(Reason.UNSUPPORTED)
        try {
            val url = "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=$sourceProgramId"
            val detail = Jsoup.parse(htmlClient.fetchHtml(url, sourceProgramId), url).selectFirst(".support_project_detail")
                ?: fail(Reason.NOT_FOUND)
            val links = detail.select(".file_name").mapNotNull { name ->
                val href = name.parent()?.selectFirst("a[href*='/cmm/fms/fileDown.do']")?.absUrl("href") ?: return@mapNotNull null
                listable(href)?.let { SupportProgramAttachmentLinkHelper.link(name.text(), it) }
            }
            if (links.isNotEmpty()) return SupportProgramAttachmentLinkHelper.visible(links)
            // 기업마당에 파일 없이 발행기관(중기부) 게시판만 연결한 공고는 그 게시판의 파일을 보여 줍니다.
            val mss = detail.select("a[href]").mapNotNull { anchor ->
                runCatching { URI(anchor.absUrl("href")) }.getOrNull()?.takeIf(::isMssPage)
            }.distinct().singleOrNull() ?: return emptyList()
            val board = Jsoup.parse(String(download(mss, 500_000), StandardCharsets.UTF_8), mss.toString()).selectFirst(".board_view")
                ?: fail(Reason.INVALID)
            return SupportProgramAttachmentLinkHelper.visible(board.select("a[href*='/common/board/Download.do']").mapNotNull { anchor ->
                val label = anchor.parent()?.selectFirst(".name")?.text()
                    ?: anchor.parent()?.parent()?.selectFirst(".name")?.text().orEmpty()
                listable(anchor.absUrl("href"))?.let { SupportProgramAttachmentLinkHelper.link(label, it) }
            })
        } catch (error: SupportProgramDocumentException) {
            throw error
        } catch (error: Exception) {
            throw SupportProgramDocumentException(Reason.UNAVAILABLE, cause = error)
        }
    }

    /** [links]가 돌려준 첨부 하나를 원본에서 받아 길이(모르면 -1)와 본문을 [receive]로 넘깁니다. */
    fun open(link: SupportProgramAttachmentLink, receive: (Long, InputStream) -> Unit) {
        val uri = URI(link.url)
        requireTrustedUri(uri, documentsOnly = false)
        restClient.get().uri(uri).accept(MediaType.ALL).exchange { _, response ->
            SupportProgramAttachmentLinkHelper.receive(response, receive)
        }
    }

    private fun listable(url: String): String? =
        runCatching { URI(url).also { requireTrustedUri(it, documentsOnly = false) }.toString() }.getOrNull()

    private fun addLink(links: MutableMap<String, Pair<String, String>>, warnings: MutableList<String>, url: String, name: String) {
        val format = when {
            Regex("(?i)\\.docx(?:\\s|$)").containsMatchIn(name) -> "DOCX"
            Regex("(?i)\\.xlsx(?:\\s|$)").containsMatchIn(name) -> "XLSX"
            Regex("(?i)\\.hwpx(?:\\s|$)").containsMatchIn(name) -> "HWPX"
            Regex("(?i)\\.hwp(?:\\s|$)").containsMatchIn(name) -> "HWP"
            Regex("(?i)\\.pdf(?:\\s|$)").containsMatchIn(name) -> "PDF"
            else -> null
        }
        if (format == null) {
            warnings.add("미수집 첨부(지원 형식 PDF/HWP/HWPX/DOCX/XLSX 이외): ${name.take(250)}")
            return
        }
        val uri = URI(url)
        requireTrustedUri(uri)
        links[uri.toString()] = AttachmentCopyHelper.withoutSizeSuffix(name) to format
    }

    /** 상세 페이지의 첨부 목록은 같은 목록 안의 h3(첨부파일·본문출력파일)로 구역을 나눕니다. */
    private fun sectionOf(name: Element): String? =
        generateSequence((name.closest("li") ?: name.parent())?.previousElementSibling()) { it.previousElementSibling() }
            .firstOrNull { it.tagName() == "h3" }?.text()?.trim()

    private fun isMss(uri: URI): Boolean = uri.host in setOf("mss.go.kr", "www.mss.go.kr")

    private fun download(uri: URI, limit: Int, observeMimeType: (String?) -> Unit = {}): ByteArray {
        requireTrustedUri(uri)
        return restClient.get().uri(uri).accept(MediaType.ALL).exchange { _, response ->
            observeMimeType(response.headers.contentType?.toString())
            if (response.statusCode.value() == 404) fail(Reason.NOT_FOUND)
            if (response.statusCode.value() != 200) fail(Reason.UNAVAILABLE)
            if (response.headers.contentLength > limit) fail(Reason.TOO_LARGE)
            val bytes = response.body.readNBytes(limit + 1)
            if (bytes.isEmpty()) fail(Reason.INVALID)
            if (bytes.size > limit) fail(Reason.TOO_LARGE)
            bytes
        }
    }

    /** 분석 수집은 [documentsOnly]로 중기부 게시판 파일을 문서 형식으로 제한하고, 상세 첨부 목록은 형식을 묻지 않습니다. */
    internal fun requireTrustedUri(uri: URI, documentsOnly: Boolean = true) {
        if (uri.scheme != "https" || uri.userInfo != null || uri.fragment != null || uri.port !in listOf(-1, 443)) fail(Reason.INVALID)
        val storedName = if (documentsOnly) Regex("[A-Za-z0-9-]+\\.(hwpx|hwp|pdf|docx|xlsx)", RegexOption.IGNORE_CASE)
        else Regex("[A-Za-z0-9-]+\\.[A-Za-z0-9]{1,10}")
        val query = uri.rawQuery.orEmpty().split('&').map { it.substringBefore('=') }
        if (query.size != query.distinct().size) fail(Reason.INVALID)
        val valid = when (uri.host) {
            "www.bizinfo.go.kr", "bizinfo.go.kr" -> uri.path == "/cmm/fms/fileDown.do" && query.toSet() == setOf("atchFileId", "fileSn") &&
                Regex("FILE_[0-9]+").matches(parameter(uri, "atchFileId")) && Regex("[0-9]+").matches(parameter(uri, "fileSn"))
            "www.mss.go.kr", "mss.go.kr" -> isMssPage(uri) || (uri.path == "/common/board/Download.do" &&
                query.toSet() == setOf("bcIdx", "cbIdx", "streFileNm") && parameter(uri, "cbIdx") == "310" &&
                Regex("[0-9]+").matches(parameter(uri, "bcIdx")) &&
                storedName.matches(parameter(uri, "streFileNm")))
            else -> false
        }
        if (!valid) fail(Reason.INVALID)
    }

    private fun isMssPage(uri: URI): Boolean = uri.scheme == "https" && uri.host in setOf("mss.go.kr", "www.mss.go.kr") &&
        uri.userInfo == null && uri.port in listOf(-1, 443) && uri.path == "/site/smba/ex/bbs/View.do" &&
        parameter(uri, "cbIdx") == "310" && Regex("[0-9]+").matches(parameter(uri, "bcIdx"))

    private fun parameter(uri: URI, name: String): String = uri.rawQuery.orEmpty().split('&')
        .singleOrNull { it.substringBefore('=') == name }?.substringAfter('=', "")
        ?.let { URLDecoder.decode(it, StandardCharsets.UTF_8) }.orEmpty()

    private fun fail(reason: Reason): Nothing = throw SupportProgramDocumentException(reason)

    private companion object {
        /** 다른 제공처와 같은 공고당 첨부 상한입니다. 본문출력파일은 세지 않습니다. */
        const val MAX_ATTACHMENTS = 8
        const val BODY_EXPORT_SECTION = "본문출력파일"
    }
}
