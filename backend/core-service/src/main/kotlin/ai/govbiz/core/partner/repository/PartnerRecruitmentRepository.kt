package ai.govbiz.core.partner.repository

import ai.govbiz.core.partner.domain.NewPartnerRecruitment
import ai.govbiz.core.partner.domain.PartnerRecruitment
import ai.govbiz.core.partner.domain.PartnerRecruitmentCompany
import ai.govbiz.core.partner.domain.PartnerRecruitmentInput
import ai.govbiz.core.partner.domain.PartnerRecruitmentSlice
import ai.govbiz.core.partner.domain.PartnerRecruitmentProgram
import ai.govbiz.core.partner.domain.PartnerRecruitmentQuery
import ai.govbiz.core.partner.domain.PartnerRecruitmentSort
import ai.govbiz.core.partner.domain.PartnerRole
import ai.govbiz.core.partner.repository.mapper.PartnerRecruitmentDbRow
import ai.govbiz.core.partner.repository.mapper.PartnerRecruitmentMapper
import ai.govbiz.core.partner.repository.mapper.PartnerProgramDbRow
import java.time.Clock
import java.time.LocalDate
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import tools.jackson.core.type.TypeReference
import tools.jackson.databind.ObjectMapper

/** 파트너 모집글을 MySQL에 저장하고, 기업·계정·공고를 조인해 읽습니다. 한 계정은 공고 하나에 모집글 하나입니다. */
@Repository
class PartnerRecruitmentRepository(
    private val recruitmentMapper: PartnerRecruitmentMapper,
    private val objectMapper: ObjectMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    /** 제공처에 현재 존재하는 공고만 모집글에 묶을 수 있습니다. */
    fun findPresentProgram(sourceCode: String, sourceProgramId: String): PartnerRecruitmentProgram? =
        recruitmentMapper.findPresentProgram(sourceCode, sourceProgramId)?.toProgram()

    /**
     * 모집글을 INSERT합니다. 같은 계정이 같은 공고에 두 번 쓰는 경우는 DB UNIQUE 제약이 막고,
     * 그때의 [org.springframework.dao.DuplicateKeyException]은 호출한 Service가 변환합니다.
     */
    @Transactional
    fun create(newRecruitment: NewPartnerRecruitment): PartnerRecruitment {
        val now = LocalDateTime.now(clock)
        val content = newRecruitment.content
        val row = PartnerRecruitmentDbRow(
            accountId = newRecruitment.accountId,
            companyId = newRecruitment.companyId,
            supportProgramId = newRecruitment.supportProgramId,
            title = content.title,
            body = content.body,
            ownRole = content.ownRole.name,
            seekingRole = content.seekingRole.name,
            seekingCount = content.seekingCount,
            region = content.region,
            minimumCompanyAgeYears = content.minimumCompanyAgeYears,
            capabilitiesJson = objectMapper.writeValueAsString(content.capabilities),
            recruitmentDeadline = content.recruitmentDeadline,
            closedAt = null,
            createdAt = now,
            updatedAt = now,
        )
        check(recruitmentMapper.insertRecruitment(row) == 1) { "partner_recruitment row was not created" }
        return requireNotNull(findById(row.id)) { "partner_recruitment row was not readable" }
    }

    fun findById(id: Long): PartnerRecruitment? =
        recruitmentMapper.findRecruitmentById(id)?.toRecruitment()

    /** 작성자의 수정입니다. 공고·기업·작성 시각은 그대로 두고 내용과 수정 시각만 바꿉니다. 이미 마감된 행은 바꾸지 않습니다. */
    @Transactional
    fun update(id: Long, content: PartnerRecruitmentInput, updatedAt: LocalDateTime): PartnerRecruitment {
        val row = PartnerRecruitmentDbRow(
            id = id,
            title = content.title,
            body = content.body,
            ownRole = content.ownRole.name,
            seekingRole = content.seekingRole.name,
            seekingCount = content.seekingCount,
            region = content.region,
            minimumCompanyAgeYears = content.minimumCompanyAgeYears,
            capabilitiesJson = objectMapper.writeValueAsString(content.capabilities),
            recruitmentDeadline = content.recruitmentDeadline,
            updatedAt = updatedAt,
        )
        check(recruitmentMapper.updateRecruitment(row) == 1) { "partner_recruitment row $id was not updated" }
        return requireNotNull(findById(id)) { "partner_recruitment row $id was not readable" }
    }

    /** 수동 마감입니다. 마감 시각을 적고 수정 시각도 같이 바꿉니다. */
    @Transactional
    fun close(id: Long, closedAt: LocalDateTime): PartnerRecruitment {
        check(recruitmentMapper.closeRecruitment(id, closedAt) == 1) { "partner_recruitment row $id was not closed" }
        return requireNotNull(findById(id)) { "partner_recruitment row $id was not readable" }
    }

    /** 같은 조건으로 한 페이지와 총 건수를 읽습니다. 모집 중 여부는 서울 기준 오늘 날짜로 SQL에서 거릅니다. */
    fun findSlice(query: PartnerRecruitmentQuery): PartnerRecruitmentSlice {
        val today = LocalDate.now(clock)
        val keywordPattern = query.keyword.ifEmpty { null }?.let { "%${escapeLikePattern(it)}%" }
        val seekingRoles = query.seekingRoles.map { it.name }.ifEmpty { null }
        // 지역을 고르면 전국 모집글도 함께 보여야 하므로 IN 목록에 전국을 더합니다. 전국만 골랐다면 전국만 남습니다.
        val regions = query.regions.ifEmpty { null }?.let { (it + PartnerRecruitmentQuery.NATIONWIDE_REGION).toList() }
        val rows = recruitmentMapper.findRecruitments(
            keywordPattern = keywordPattern,
            seekingRoles = seekingRoles,
            regions = regions,
            mineAccountId = query.mineAccountId,
            sourceCode = query.sourceCode,
            today = today,
            sortByRecent = query.sort == PartnerRecruitmentSort.RECENT,
            limit = query.pageSize,
            offset = query.offset,
        )
        val total = recruitmentMapper.countRecruitments(
            keywordPattern = keywordPattern,
            seekingRoles = seekingRoles,
            regions = regions,
            mineAccountId = query.mineAccountId,
            sourceCode = query.sourceCode,
            today = today,
        )
        return PartnerRecruitmentSlice(rows.map { it.toRecruitment() }, total)
    }

    /** 검색어의 LIKE 특수문자를 '!'로 이스케이프합니다. Mapper XML의 ESCAPE 문자와 같아야 합니다. */
    /** 아직 수동 마감하지 않은 이 계정의 모집글 수입니다. 계정 삭제 확인 화면이 씁니다. */
    fun countOpenByAccountId(accountId: Long): Int =
        recruitmentMapper.countOpenRecruitmentsByAccount(accountId)

    /** 계정 삭제 시 이 계정의 모집글을 모두 수동 마감합니다. 받은 제안은 만료로 계산됩니다. */
    @Transactional
    fun closeAllByAccountId(accountId: Long, closedAt: LocalDateTime): Int =
        recruitmentMapper.closeRecruitmentsByAccount(accountId, closedAt)

    private fun escapeLikePattern(keyword: String): String =
        keyword.replace("!", "!!").replace("%", "!%").replace("_", "!_")

    private fun PartnerProgramDbRow.toProgram(): PartnerRecruitmentProgram =
        PartnerRecruitmentProgram(
            id = id,
            sourceCode = sourceCode,
            sourceProgramId = sourceProgramId,
            title = title,
            organization = organization,
            summary = summary,
            targetDescription = targetDescription,
            applicationPeriod = applicationPeriodRaw,
            applicationStartDate = applicationStartDate,
            applicationEndDate = applicationEndDate,
            sourceUrl = sourceUrl,
        )

    private fun PartnerRecruitmentDbRow.toRecruitment(): PartnerRecruitment =
        PartnerRecruitment(
            id = id,
            accountId = accountId,
            company = PartnerRecruitmentCompany(
                companyName = companyName,
                region = companyRegion,
                industry = companyIndustry,
                foundedYear = companyFoundedYear,
                isEmailVerified = accountEmailVerifiedAt != null,
            ),
            program = PartnerRecruitmentProgram(
                id = supportProgramId,
                sourceCode = programSourceCode,
                sourceProgramId = programSourceProgramId,
                title = programTitle,
                organization = programOrganization,
                summary = programSummary,
                targetDescription = programTargetDescription,
                applicationPeriod = programApplicationPeriodRaw,
                applicationStartDate = programApplicationStartDate,
                applicationEndDate = programApplicationEndDate,
                sourceUrl = programSourceUrl,
            ),
            content = PartnerRecruitmentInput(
                title = title,
                body = body,
                ownRole = PartnerRole.valueOf(ownRole),
                seekingRole = PartnerRole.valueOf(seekingRole),
                seekingCount = seekingCount,
                region = region,
                minimumCompanyAgeYears = minimumCompanyAgeYears,
                capabilities = objectMapper.readValue(capabilitiesJson, STRING_LIST),
                recruitmentDeadline = requireNotNull(recruitmentDeadline) { "partner_recruitment recruitmentDeadline must not be null" },
            ),
            closedAt = closedAt,
            createdAt = requireNotNull(createdAt) { "partner_recruitment createdAt must not be null" },
            updatedAt = requireNotNull(updatedAt) { "partner_recruitment updatedAt must not be null" },
        )

    companion object {
        private val STRING_LIST = object : TypeReference<List<String>>() {}
    }
}
