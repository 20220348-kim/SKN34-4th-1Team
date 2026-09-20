package ai.govbiz.core.account.repository

import ai.govbiz.core.account.domain.CompanyPartnerProfile
import ai.govbiz.core.account.domain.CompanyPartnerProfileInput
import ai.govbiz.core.account.repository.mapper.CompanyPartnerProfileDbRow
import ai.govbiz.core.account.repository.mapper.CompanyPartnerProfileMapper
import ai.govbiz.core.partner.domain.PartnerRole
import java.time.Clock
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper

/** 협업·파트너 설정을 MySQL에 저장하고 읽습니다. 배열 컬럼은 모집글의 역량과 같이 JSON 문자열로 다룹니다. */
@Repository
class CompanyPartnerProfileRepository(
    private val mapper: CompanyPartnerProfileMapper,
    private val objectMapper: ObjectMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    /** 저장한 적이 없으면 비어 있는 설정입니다. 화면은 이 경우 기본값 폼을 보여 줍니다. */
    fun findByCompanyId(companyId: Long): CompanyPartnerProfile =
        mapper.findByCompanyId(companyId)?.toProfile() ?: CompanyPartnerProfile.empty(companyId)

    /** 기업당 한 행을 만들거나 덮어씁니다. */
    @Transactional
    fun save(companyId: Long, input: CompanyPartnerProfileInput): CompanyPartnerProfile {
        val now = LocalDateTime.now(clock)
        val row = CompanyPartnerProfileDbRow(
            companyId = companyId,
            rolesJson = objectMapper.writeValueAsString(input.roles.map(PartnerRole::name)),
            interestAreasJson = objectMapper.writeValueAsString(input.interestAreas),
            introduction = input.introduction,
            capabilitiesJson = objectMapper.writeValueAsString(input.capabilities),
            createdAt = now,
            updatedAt = now,
        )
        check(mapper.upsert(row) >= 1) { "company partner profile row was not saved" }
        return requireNotNull(mapper.findByCompanyId(companyId)) { "company partner profile row was not readable" }.toProfile()
    }

    private fun CompanyPartnerProfileDbRow.toProfile(): CompanyPartnerProfile =
        CompanyPartnerProfile(
            companyId = companyId,
            input = CompanyPartnerProfileInput(
                roles = objectMapper.readValue(rolesJson, STRING_LIST).map(PartnerRole::valueOf),
                interestAreas = objectMapper.readValue(interestAreasJson, STRING_LIST),
                introduction = introduction,
                capabilities = objectMapper.readValue(capabilitiesJson, STRING_LIST),
            ),
            updatedAt = requireNotNull(updatedAt) { "company partner profile updatedAt must not be null" },
        )

    private companion object {
        val STRING_LIST = object : tools.jackson.core.type.TypeReference<List<String>>() {}
    }
}
