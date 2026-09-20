import asyncio
import json
import logging
from copy import deepcopy
from functools import lru_cache
from time import perf_counter
from typing import Annotated, Literal
from unicodedata import category

from agents import (
    Agent,
    MaxTurnsExceeded,
    Model,
    ModelBehaviorError,
    ModelRefusalError,
    ModelSettings,
    ModelTimeoutError,
    RunConfig,
    Runner,
)
from openai import APITimeoutError, OpenAIError
from openai.types.shared import Reasoning
from pydantic import ConfigDict, Field, ValidationError, create_model

from app.support_program_ranking.errors import AgentExecutionError, AgentFailureCode, AgentTimeoutError

from .models import (
    AssessedSupportProgram,
    IncompatibleEligibilityAssessment,
    RegionEligibilityAssessment,
    SupportProgramAssessment,
    SupportProgramCandidate,
    SupportProgramEligibility,
    SupportProgramEligibilityEvidence,
    SupportProgramRankingOutput,
    SupportProgramRankingRequest,
    TargetEligibilityAssessment,
)
from .prompt import SUPPORT_PROGRAM_COMPANY_CONDITIONS_INSTRUCTIONS, SUPPORT_PROGRAM_RANKING_INSTRUCTIONS


logger = logging.getLogger(__name__)


def _short_field(model: type, name: str, alias: str) -> tuple:
    field = deepcopy(model.model_fields[name])
    field.alias = field.validation_alias = field.serialization_alias = alias
    return field.annotation, field


def build_evidence_options(candidate: SupportProgramCandidate) -> list[SupportProgramEligibilityEvidence]:
    """두 원문 필드의 제어문자 없는 연속 구간을 겹치는 정확한 인용으로 나눈다."""
    options: list[SupportProgramEligibilityEvidence] = []
    for field, source in (("SUMMARY", candidate.summary), ("TARGET_DESCRIPTION", candidate.target_description)):
        run_start = 0
        for boundary in range(len(source) + 1):
            if boundary < len(source) and not category(source[boundary]).startswith("C"):
                continue
            start = run_start
            while start < boundary:
                end = min(start + 240, boundary)
                if end < boundary:
                    # Prefer a late sentence/word boundary without changing any source character.
                    sentence_ends = [index + 1 for index in range(start + 120, end)
                                     if source[index] in ".!?。！？"]
                    word_ends = [index + 1 for index in range(start + 120, end)
                                 if source[index].isspace()]
                    if sentence_ends or word_ends:
                        end = (sentence_ends or word_ends)[-1]
                quote = source[start:end]
                if quote.strip():
                    options.append(SupportProgramEligibilityEvidence(field=field, quote=quote))
                if end == boundary:
                    break
                next_start = end - 60
                word_starts = [index + 1 for index in range(max(start + 1, next_start - 30), next_start)
                               if source[index].isspace()]
                start = word_starts[-1] if word_starts else next_start
            run_start = boundary + 1
    return options


@lru_cache(maxsize=128)
def _assessment_selection_type(option_count: int, compact: bool = False) -> type[SupportProgramAssessment]:
    """기존 점수·자격 검증을 유지하고 LLM 내부 evidence만 후보별 번호로 제한한다."""
    indexes = list[Annotated[int, Field(strict=True, ge=0, le=max(0, option_count - 1))]]
    evidence = (indexes, Field(max_length=1 if option_count else 0, alias="e" if compact else None))
    fields = {"evidence": evidence}
    if compact:
        fields.update(eligibility=_short_field(TargetEligibilityAssessment, "eligibility", "v"),
                      explanation=_short_field(TargetEligibilityAssessment, "explanation", "x"))
    if not option_count:
        fields["eligibility"] = (Literal[SupportProgramEligibility.UNKNOWN], Field(alias="v" if compact else None))
    target = create_model(f"TargetSelectionFor{option_count}Options", __base__=TargetEligibilityAssessment, **fields)
    region = create_model(f"RegionSelectionFor{option_count}Options", __base__=RegionEligibilityAssessment, **fields)
    if option_count:
        incompatible = create_model(
            f"IncompatibleSelectionFor{option_count}Options", __base__=IncompatibleEligibilityAssessment,
            **({"eligibility": _short_field(IncompatibleEligibilityAssessment, "eligibility", "v"),
                "explanation": _short_field(IncompatibleEligibilityAssessment, "explanation", "x")} if compact else {}),
            evidence=(indexes, Field(min_length=1, max_length=1, alias="e" if compact else None)),
        )
        target = target | incompatible
        region = region | incompatible
    return create_model(
        f"SupportProgramSelectionFor{option_count}Options", __base__=SupportProgramAssessment,
        **({"semantic_relevance": _short_field(SupportProgramAssessment, "semantic_relevance", "s"),
            "support_type_fit": _short_field(SupportProgramAssessment, "support_type_fit", "f"),
            "recommendation_reasons": _short_field(SupportProgramAssessment, "recommendation_reasons", "why")} if compact else {}),
        target_assessment=(target, Field(alias="t" if compact else "targetAssessment")),
        region_assessment=(region, Field(
            alias="r" if compact else "regionAssessment",
            description=(
                "확인된 회사 소재지와 본문 신청 허용 지역의 포함 관계를 판정한다. "
                "상위 지역만 알고 공고가 하위 지역으로 제한되면 UNKNOWN이며, "
                "충돌하지 않는다는 이유로 MATCH하지 않는다. MATCH/INCOMPATIBLE의 인용 번호는 "
                "실제 소재지 허용·제한 문구를 가리켜야 하며 태그·제목·일반 지원 내용은 지역 근거가 아니다."
                " '또는'의 허용 경로 중 하나를 이미 충족하면 MATCH이며 다른 경로의 이전 의사는 불필요하다. "
                "현재 소재지 경로 불충족과 이전 경로 미확인의 조합은 UNKNOWN이지 INCOMPATIBLE이 아니다."
            ),
        )),
    )


class SupportProgramRecommendationAgent:
    """한 번의 structured LLM 호출로 모든 공고 후보를 점수화한다."""

    def __init__(
        self,
        *,
        model: Model,
        model_timeout_seconds: float,
        run_timeout_seconds: float,
        reasoning_effort: Literal["none", "low"] = "none",
        compact_output: bool = False,
        service_tier: Literal["default", "priority"] | None = None,
    ) -> None:
        if reasoning_effort not in ("none", "low"):
            raise ValueError("ranking reasoning effort must be none or low")
        if service_tier not in (None, "default", "priority"):
            raise ValueError("ranking service tier must be default or priority")
        if type(compact_output) is not bool:
            raise ValueError("ranking compact output must be boolean")
        self._run_timeout_seconds = run_timeout_seconds
        self._compact_output = compact_output
        self._agent: Agent[None] = Agent(
            name="GovBiz Support Program Recommendation Scorer",
            instructions=SUPPORT_PROGRAM_RANKING_INSTRUCTIONS,
            model=model,
            model_settings=ModelSettings(
                max_tokens=10_000,
                reasoning=Reasoning(effort=reasoning_effort),
                store=False,
                timeout=model_timeout_seconds,
                # The SDK model deadline and the OpenAI HTTP timeout are separate.
                # Override only this request; the shared client keeps its 25s default.
                extra_args={"timeout": model_timeout_seconds,
                            **({"service_tier": service_tier} if service_tier is not None else {})},
            ),
        )
        self._run_config = RunConfig(
            workflow_name="GovBiz support program recommendation ranking",
            tracing_disabled=True,
            trace_include_sensitive_data=False,
        )

    async def rank(
        self,
        request: SupportProgramRankingRequest,
    ) -> SupportProgramRankingOutput:
        candidate_count = len(request.candidates)
        started = perf_counter()
        evidence_options = {candidate.id: build_evidence_options(candidate) for candidate in request.candidates}
        selection_types = {count: _assessment_selection_type(count, self._compact_output) for count in
                           {len(options) for options in evidence_options.values()}}
        # 짧은 요청별 ID는 원문·제공처 식별자를 대체 저장하지 않고 LLM 왕복에서만 사용합니다.
        output_ids = {candidate.id: f"p{index}" if self._compact_output else candidate.id
                      for index, candidate in enumerate(request.candidates)}
        rankings_type = create_model(
            f"SupportProgramAssessmentsFor{candidate_count}Candidates",
            __config__=ConfigDict(extra="forbid", frozen=True),
            **{
                output_ids[candidate.id]: (selection_types[len(evidence_options[candidate.id])], ...)
                for candidate in request.candidates
            },
        )
        output_type = create_model(
            f"SupportProgramRankingOutputFor{candidate_count}Candidates",
            __config__=ConfigDict(extra="forbid", frozen=True),
            rankings=(rankings_type, ...),
        )
        # 모든 후보 ID를 필수 속성 키로 고정해 배열의 ID 누락·중복·추가 생성을 막는다.
        instructions = self._agent.instructions
        if request.company_conditions is not None:
            instructions = f"{instructions}\n\n{SUPPORT_PROGRAM_COMPANY_CONDITIONS_INSTRUCTIONS}"
        if self._compact_output:
            instructions = instructions.replace(
                "입력 candidates[].id의 제공처 포함 식별자(sourceCode:sourceProgramId)",
                "입력 candidates[].id의 요청별 식별자(p0, p1 등)",
            )
            instructions += (
                "\n\n출력 표기만 간결하게 합니다. 위의 모든 평가 기준·설명·근거는 그대로 유지합니다. "
                "각 후보의 출력 키는 semanticRelevance=s, supportTypeFit=f, targetAssessment=t, "
                "regionAssessment=r, recommendationReasons=why입니다. "
                "t와 r 안의 키는 eligibility=v, evidence=e, explanation=x입니다. "
                "입력의 p0·p1 등은 점수나 순위가 아닌 식별자이며 모든 후보를 빠짐없이 평가합니다."
            )
        agent = self._agent.clone(output_type=output_type, instructions=instructions)
        payload = request.model_dump(mode="json", by_alias=True)
        for candidate in payload["candidates"]:
            candidate["evidenceOptions"] = [
                {"index": index, **option.model_dump()}
                for index, option in enumerate(evidence_options[candidate["id"]])
            ]
            candidate["id"] = output_ids[candidate["id"]]
        prepared = perf_counter()
        try:
            async with asyncio.timeout(self._run_timeout_seconds):
                result = await Runner.run(
                    agent,
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":") if self._compact_output else None),
                    max_turns=1,
                    run_config=self._run_config,
                )
        except (ModelTimeoutError, APITimeoutError, TimeoutError) as error:
            raise AgentTimeoutError("Support program recommendation agent timed out") from error
        except (
            MaxTurnsExceeded,
            ModelBehaviorError,
            ModelRefusalError,
            OpenAIError,
            ValidationError,
        ) as error:
            raise AgentExecutionError(
                "Support program recommendation agent did not produce a usable result"
            ) from error

        model_finished = perf_counter()
        output = result.final_output
        if not isinstance(output, output_type):
            raise AgentExecutionError(
                "Support program recommendation agent returned an unexpected output type",
                reason_code=AgentFailureCode.UNEXPECTED_OUTPUT_TYPE,
            )
        assessments: list[AssessedSupportProgram] = []
        for candidate in request.candidates:
            selection = getattr(output.rankings, output_ids[candidate.id]).model_dump()
            options = evidence_options[candidate.id]
            for dimension in ("target_assessment", "region_assessment"):
                indexes = selection[dimension]["evidence"]
                if any(type(index) is not int or not 0 <= index < len(options) for index in indexes):
                    raise AgentExecutionError(
                        "Support program recommendation agent selected an invalid evidence index",
                        reason_code=AgentFailureCode.INVALID_EVIDENCE_SELECTION,
                    )
                selection[dimension]["evidence"] = [options[index].model_dump() for index in indexes]
            try:
                assessments.append(AssessedSupportProgram(program_id=candidate.id, **selection))
            except ValidationError as error:
                raise AgentExecutionError(
                    "Support program recommendation agent produced invalid evidence selections",
                    reason_code=AgentFailureCode.INVALID_EVIDENCE_SELECTION,
                ) from error
        logger.info(
            "support_program_ranking_completed candidate_count=%d preparation_ms=%d model_ms=%d validation_ms=%d elapsed_ms=%d output_format=%s",
            candidate_count, round((prepared - started) * 1000),
            round((model_finished - prepared) * 1000), round((perf_counter() - model_finished) * 1000),
            round((perf_counter() - started) * 1000),
            "compact" if self._compact_output else "full",
        )
        return SupportProgramRankingOutput(rankings=assessments)
