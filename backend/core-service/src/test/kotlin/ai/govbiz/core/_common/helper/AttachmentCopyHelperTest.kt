package ai.govbiz.core._common.helper

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class AttachmentCopyHelperTest {
    @Test fun keepsOneFormatPerTitlePreferringHangulSourcesAndOriginalOrder() {
        val names = listOf("붙임1. 신청서.pdf", "공고문.hwp", "붙임1. 신청서.hwpx [141.87 KB]", "공고문.pdf", "붙임2_계획서.docx")
        assertEquals(listOf("공고문.hwp", "붙임1. 신청서.hwpx [141.87 KB]", "붙임2_계획서.docx"),
            AttachmentCopyHelper.withoutFormatCopies(names) { it })
    }

    @Test fun sameFormatCopiesKeepTheFirstAndUnknownNamesStaySeparate() {
        val items = listOf("a" to "신청서.hwp", "b" to "신청서.hwp", "c" to ".pdf", "d" to "!!.pdf")
        assertEquals(listOf("a", "c", "d"), AttachmentCopyHelper.withoutFormatCopies(items) { it.second }.map { it.first })
    }

    @Test fun copyGroupsKeepEveryCopyPreferredFormatFirst() {
        val names = listOf("붙임1. 신청서.pdf", "공고문.hwp", "붙임1. 신청서.hwpx [141.87 KB]", "붙임1. 신청서.hwp")
        assertEquals(listOf(listOf("공고문.hwp"), listOf("붙임1. 신청서.hwpx [141.87 KB]", "붙임1. 신청서.hwp", "붙임1. 신청서.pdf")),
            AttachmentCopyHelper.copyGroups(names) { it })
    }

    @Test fun titleKeyDropsSizeSuffixExtensionAndSymbols() {
        assertEquals("붙임1신청서", AttachmentCopyHelper.titleKey("붙임1. 신청서.HWPX [12 KB]"))
        assertEquals("공고문.hwpx", AttachmentCopyHelper.withoutSizeSuffix("공고문.hwpx [1,024.5 kb]"))
        assertNull(AttachmentCopyHelper.titleKey(" .pdf"))
    }
}
