package ai.govbiz.core.applicationpreparation.repository.mapper

import org.apache.ibatis.annotations.Mapper
import java.time.LocalDateTime

@Mapper
interface ApplicationFormAvailabilityMapper {
    fun listAvailable(): List<ApplicationFormAvailabilityDbRow>
    fun find(sourceCode: String, sourceProgramId: String): ApplicationFormAvailabilityDbRow?
    fun lock(sourceCode: String, sourceProgramId: String): ApplicationFormAvailabilityDbRow?
    fun insert(row: ApplicationFormAvailabilityDbRow): Int
    fun update(row: ApplicationFormAvailabilityDbRow): Int
    fun nextDue(now: LocalDateTime): ApplicationFormAvailabilityDbRow?
}
