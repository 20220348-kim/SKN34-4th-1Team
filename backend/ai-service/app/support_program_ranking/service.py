import asyncio
from collections import OrderedDict
from dataclasses import dataclass
from hashlib import sha256
import logging
from math import isfinite
from time import monotonic

from pydantic import ValidationError

from app.support_program_ranking.errors import AgentExecutionError, AgentFailureCode

from .agent import SupportProgramRecommendationAgent
from .models import (
    ScoredSupportProgram,
    SupportProgramRankingRequest,
    SupportProgramRankingResponse,
    SupportProgramEligibility,
)


# 사용자가 요청한 지원을 원문이 일부라도 직접 제공해야 추천한다.
MIN_SEMANTIC_RELEVANCE_SCORE = 20
logger = logging.getLogger(__name__)


@dataclass
class _PendingRanking:
    """동일 입력의 평가 작업과 아직 결과를 기다리는 호출 수를 보관한다."""

    task: asyncio.Task[SupportProgramRankingResponse]
    waiters: int = 0


class SupportProgramRankingService:
    """본문 자격 근거를 검증하고 명백한 부적합을 제외해 검색 관련도순으로 반환한다."""

    def __init__(
        self,
        agent: SupportProgramRecommendationAgent,
        *,
        cache_max_entries: int = 128,
        cache_ttl_seconds: float = 300.0,
    ) -> None:
        if cache_max_entries < 1 or cache_ttl_seconds <= 0 or not isfinite(cache_ttl_seconds):
            raise ValueError("Ranking cache capacity and TTL must be positive and finite")
        # Agent의 모델·프롬프트 정책은 인스턴스 생애 동안 고정되며 캐시를 다른 인스턴스와 공유하지 않는다.
        self._agent = agent
        self._cache_max_entries = cache_max_entries
        self._cache_ttl_seconds = cache_ttl_seconds
        self._cache: OrderedDict[str, tuple[float, SupportProgramRankingResponse]] = OrderedDict()
        self._pending: dict[str, _PendingRanking] = {}

    async def rank(
        self,
        request: SupportProgramRankingRequest,
    ) -> SupportProgramRankingResponse:
        started_at = monotonic()
        # frozen 모델 안의 list까지 복사해 키 생성 이후 호출자가 입력을 바꿔도 평가 입력과 키가 일치한다.
        request = request.model_copy(deep=True)
        key = sha256(request.model_dump_json(by_alias=True).encode("utf-8")).hexdigest()
        now = monotonic()
        for expired_key, (expires_at, _) in list(self._cache.items()):
            if expires_at <= now:
                del self._cache[expired_key]

        cache_state = "miss"
        try:
            cached = self._cache.get(key)
            if cached is not None:
                cache_state = "hit"
                self._cache.move_to_end(key)
                return cached[1].model_copy(deep=True)

            pending = self._pending.get(key)
            if pending is None:
                pending = _PendingRanking(asyncio.create_task(self._rank_and_cache(key, request)))
                self._pending[key] = pending
            else:
                cache_state = "shared"
            pending.waiters += 1
            try:
                # 한 HTTP 호출의 취소가 다른 호출이 기다리는 OpenAI 작업까지 취소하지 않게 한다.
                response = await asyncio.shield(pending.task)
                return response.model_copy(deep=True)
            finally:
                pending.waiters -= 1
                if pending.waiters == 0:
                    if self._pending.get(key) is pending:
                        del self._pending[key]
                    if not pending.task.done():
                        pending.task.cancel()
                        await asyncio.gather(pending.task, return_exceptions=True)
        finally:
            logger.info(
                "support_program_ranking cache_state=%s elapsed_ms=%.1f candidate_count=%d",
                cache_state,
                (monotonic() - started_at) * 1_000,
                len(request.candidates),
            )

    async def _rank_and_cache(
        self,
        key: str,
        request: SupportProgramRankingRequest,
    ) -> SupportProgramRankingResponse:
        response = await self._rank_uncached(request)
        # 모든 후보·인용·점수의 기존 검증을 통과한 정상 응답만 저장한다. 실패는 그대로 전파한다.
        self._cache[key] = (monotonic() + self._cache_ttl_seconds, response.model_copy(deep=True))
        self._cache.move_to_end(key)
        while len(self._cache) > self._cache_max_entries:
            self._cache.popitem(last=False)
        return response

    async def _rank_uncached(
        self,
        request: SupportProgramRankingRequest,
    ) -> SupportProgramRankingResponse:
        output = await self._agent.rank(request)
        candidate_order = {
            candidate.id: index for index, candidate in enumerate(request.candidates)
        }
        expected_ids = set(candidate_order)
        actual_ids = {ranking.program_id for ranking in output.rankings}
        if actual_ids != expected_ids or len(output.rankings) != len(request.candidates):
            raise AgentExecutionError(
                "Support program recommendation agent changed the candidate id set",
                reason_code=AgentFailureCode.CANDIDATE_SET_MISMATCH,
            )

        candidates_by_id = {candidate.id: candidate for candidate in request.candidates}
        # 제외되거나 점수 미달인 후보까지 모두 검증한다. 잘못된 인용을 정상 응답으로 숨기지 않는다.
        for assessment in output.rankings:
            candidate = candidates_by_id[assessment.program_id]
            source_fields = {"SUMMARY": candidate.summary, "TARGET_DESCRIPTION": candidate.target_description}
            for eligibility in (assessment.target_assessment, assessment.region_assessment):
                if candidate.source_text_truncated and eligibility.eligibility is not SupportProgramEligibility.UNKNOWN:
                    raise AgentExecutionError(
                        "Truncated source text requires UNKNOWN eligibility",
                        reason_code=AgentFailureCode.TRUNCATED_SOURCE_KNOWN_ELIGIBILITY,
                    )
                if eligibility.eligibility is not SupportProgramEligibility.UNKNOWN and not eligibility.evidence:
                    raise AgentExecutionError(
                        "Known eligibility requires source evidence",
                        reason_code=AgentFailureCode.MISSING_KNOWN_EVIDENCE,
                    )
                for evidence in eligibility.evidence:
                    if evidence.quote not in source_fields[evidence.field]:
                        raise AgentExecutionError(
                            "Eligibility evidence is not an exact quote of the candidate source",
                            reason_code=AgentFailureCode.EXACT_QUOTE_MISMATCH,
                        )

        try:
            scored_rankings = [
                ScoredSupportProgram(
                    program_id=assessment.program_id,
                    semantic_relevance=assessment.semantic_relevance,
                    target_eligibility=assessment.target_assessment.eligibility,
                    target_evidence=assessment.target_assessment.evidence,
                    target_explanation=assessment.target_assessment.explanation,
                    region_eligibility=assessment.region_assessment.eligibility,
                    region_evidence=assessment.region_assessment.evidence,
                    region_explanation=assessment.region_assessment.explanation,
                    support_type_fit=assessment.support_type_fit,
                    total_score=2 * (assessment.semantic_relevance + assessment.support_type_fit),
                    recommendation_reasons=assessment.recommendation_reasons,
                )
                for assessment in output.rankings
            ]
        except ValidationError as error:
            raise AgentExecutionError(
                "Support program recommendation agent produced invalid score dimensions"
            ) from error

        sorted_rankings = sorted(
            scored_rankings,
            key=lambda ranking: (
                -ranking.total_score,
                candidate_order[ranking.program_id],
            ),
        )
        eligible_rankings = []
        excluded_low_relevance = excluded_target = excluded_region = 0
        for ranking in sorted_rankings:
            # 선행 제외 사유에 한 번만 집계한다. UNKNOWN은 기존처럼 결과에 남긴다.
            if ranking.semantic_relevance < MIN_SEMANTIC_RELEVANCE_SCORE:
                excluded_low_relevance += 1
            elif ranking.target_eligibility is SupportProgramEligibility.INCOMPATIBLE:
                excluded_target += 1
            elif ranking.region_eligibility is SupportProgramEligibility.INCOMPATIBLE:
                excluded_region += 1
            else:
                eligible_rankings.append(ranking)
        selected_rankings = eligible_rankings[: request.result_limit]
        logger.info(
            "support_program_ranking_selection candidate_count=%d eligible_count=%d selected_count=%d "
            "excluded_low_relevance=%d excluded_target=%d excluded_region=%d "
            "selected_target_unknown=%d selected_region_unknown=%d",
            len(sorted_rankings), len(eligible_rankings), len(selected_rankings),
            excluded_low_relevance, excluded_target, excluded_region,
            sum(item.target_eligibility is SupportProgramEligibility.UNKNOWN for item in selected_rankings),
            sum(item.region_eligibility is SupportProgramEligibility.UNKNOWN for item in selected_rankings),
        )
        return SupportProgramRankingResponse(
            original_query=request.original_query,
            scoring_version=request.scoring_version,
            rankings=selected_rankings,
        )
