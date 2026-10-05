package ai.govbiz.core.admin.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** 관리자 접속기록 SQL을 실행하는 MyBatis Mapper입니다. 기록은 추가와 조회만 하며 고치거나 지우는 SQL은 두지 않습니다. */
@Mapper
interface AdminAccessLogMapper {

    fun insertLog(row: AdminAccessLogDbRow): Int

    /** 최신 기록부터 읽습니다. 다음 쪽이 있는지 알 수 있도록 호출한 쪽이 한 건 더 요청합니다. */
    fun findLogs(
        @Param("actorAccountId") actorAccountId: Long?,
        @Param("targetAccountId") targetAccountId: Long?,
        @Param("action") action: String?,
        @Param("createdFrom") createdFrom: LocalDateTime?,
        @Param("createdBefore") createdBefore: LocalDateTime?,
        @Param("beforeId") beforeId: Long?,
        @Param("limit") limit: Int,
    ): List<AdminAccessLogDbRow>
}
