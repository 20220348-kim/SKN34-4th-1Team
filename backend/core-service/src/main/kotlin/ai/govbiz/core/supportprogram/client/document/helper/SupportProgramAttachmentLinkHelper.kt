package ai.govbiz.core.supportprogram.client.document.helper

import ai.govbiz.core._common.helper.AttachmentCopyHelper
import ai.govbiz.core.supportprogram.client.document.MAX_SUPPORT_PROGRAM_ATTACHMENT_LINKS
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachmentLink
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import java.io.InputStream
import org.springframework.http.MediaType
import org.springframework.http.client.ClientHttpResponse

/** 제공처별 첨부 수집기가 공고 상세 첨부 목록과 원본 받기에 함께 쓰는 규칙입니다. */
object SupportProgramAttachmentLinkHelper {
    private val imageExtensions = setOf("jpg", "jpeg", "png", "gif", "bmp", "webp", "tif", "tiff", "svg", "heic")
    private val extension = Regex("\\.([A-Za-z0-9]{1,10})$")

    /** 게시판이 붙인 크기 표기를 뗀 이름과 그 확장자(소문자, 없으면 빈 값)로 첨부 한 건을 만듭니다. */
    fun link(fileName: String, url: String, referer: String? = null): SupportProgramAttachmentLink {
        val name = AttachmentCopyHelper.withoutSizeSuffix(fileName.trim()).take(300)
        return SupportProgramAttachmentLink(name, extension.find(name)?.groupValues?.get(1)?.lowercase().orEmpty(), url, referer)
    }

    /** 이름 없는 첨부와 이미지는 빼고, 같은 주소는 한 번만 남겨 앞에서부터 상한까지 둡니다. */
    fun visible(links: List<SupportProgramAttachmentLink>): List<SupportProgramAttachmentLink> =
        links.filter { it.fileName.isNotBlank() && it.extension !in imageExtensions }
            .distinctBy { it.url }
            .take(MAX_SUPPORT_PROGRAM_ATTACHMENT_LINKS)

    /** 원본 응답이 파일일 때만 길이(모르면 -1)와 본문을 넘깁니다. 오류 안내 HTML을 파일로 내려 주지 않습니다. */
    fun receive(response: ClientHttpResponse, receive: (Long, InputStream) -> Unit) {
        if (response.statusCode.value() == 404) throw SupportProgramDocumentException(Reason.NOT_FOUND)
        if (response.statusCode.value() != 200 || response.headers.contentType?.isCompatibleWith(MediaType.TEXT_HTML) == true) {
            throw SupportProgramDocumentException(Reason.UNAVAILABLE)
        }
        receive(response.headers.contentLength, response.body)
    }
}
