package ai.govbiz.core.planusage.service.exception

/** 출시 전 무료 체험을 시작할 수 없습니다. [reason]으로 이미 체험했는지, 지금 요금제로는 체험할 수 없는지 가립니다. */
class PlanTrialException(val reason: Reason) : RuntimeException("The plan trial cannot start: $reason") {
    enum class Reason {
        /** 이 요금제는 이미 체험했습니다. */
        USED,

        /** 운영자가 배정한 유료 요금제를 쓰고 있거나, 지금 요금제보다 높지 않은 요금제입니다. */
        UNAVAILABLE,

        /** 이메일 인증을 마치지 않았습니다. */
        EMAIL_UNVERIFIED,
    }
}
