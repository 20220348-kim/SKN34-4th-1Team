package ai.govbiz.core.supportprogram.controller

import ai.govbiz.core.supportprogram.controller.dto.SupportProgramCatalogResponse
import ai.govbiz.core.supportprogram.domain.SupportProgramCatalogSort
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.service.catalog.SupportProgramCatalogService
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1/support-programs/catalog")
class SupportProgramCatalogController(
    private val service: SupportProgramCatalogService,
) {
    @GetMapping
    fun browse(
        @RequestParam(defaultValue = "") @Size(max = 100) @Pattern(regexp = "[^\\p{C}]*") keyword: String,
        @RequestParam(defaultValue = "") @Size(max = 50) @Pattern(regexp = "[^\\p{C}]*") region: String,
        @RequestParam(defaultValue = "") @Size(max = 100) @Pattern(regexp = "[^\\p{C}]*") category: String,
        @RequestParam(defaultValue = "OPEN") @Pattern(regexp = "ALL|OPEN|UPCOMING|CLOSED|UNKNOWN") status: String,
        @RequestParam(defaultValue = "RECENT") @Pattern(regexp = "RECENT|DEADLINE") sort: String,
        @RequestParam(defaultValue = "1") @Min(1) @Max(1_000_000) page: Int,
        @RequestParam(defaultValue = "12") @Min(1) @Max(50) pageSize: Int,
        @RequestParam(defaultValue = "") @Pattern(regexp = "|BIZINFO|KSTARTUP|MSIT|CNTRADE_NOTICE") sourceCode: String,
        @RequestParam(defaultValue = "") @Size(max = 100) @Pattern(regexp = "[^\\p{C}]*") startupStage: String,
        @RequestParam(defaultValue = "") @Size(max = 100) @Pattern(regexp = "[^\\p{C}]*") applicantType: String,
        @RequestParam(defaultValue = "") @Size(max = 100) @Pattern(regexp = "[^\\p{C}]*") founderAge: String,
    ): SupportProgramCatalogResponse = SupportProgramCatalogResponse.from(
        service.browse(
            rawKeyword = keyword,
            rawRegion = region,
            rawCategory = category,
            status = status.takeUnless { it == "ALL" }?.let(SupportProgramStatus::valueOf),
            sort = SupportProgramCatalogSort.valueOf(sort),
            page = page,
            pageSize = pageSize,
            sourceCode = sourceCode,
            rawStartupStage = startupStage,
            rawApplicantType = applicantType,
            rawFounderAge = founderAge,
        ),
    )
}
