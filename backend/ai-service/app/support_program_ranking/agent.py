import asyncio
import logging
from functools import lru_cache
from time import perf_counter
from typing import Annotated, Literal
from unicodedata import category

from langchain_openai import ChatOpenAI
from openai import APITimeoutError, OpenAIError
from pydantic import ConfigDict, Field, ValidationError, create_model

from app.support_program_llm import (
    get_support_program_usage_details,
    invoke_support_program_model,
    validate_support_program_output,
)

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
def _assessment_selection_type(option_count: int) -> type[SupportProgramAssessment]:
    """기존 점수·자격 검증을 유지하고 LLM 내부 evidence만 후보별 번호로 제한한다."""
    indexes = list[Annotated[int, Field(strict=True, ge=0, le=max(0, option_count - 1))]]
    evidence = (indexes, Field(max_length=1 if option_count else 0))
    fields = {"evidence": evidence, "eligibility": (Literal[SupportProgramEligibility.UNKNOWN], ...)}
    target = create_model(f"TargetSelectionFor{option_count}Options", __base__=TargetEligibilityAssessment, **fields)
    region = create_model(f"RegionSelectionFor{option_count}Options", __base__=RegionEligibilityAssessment, **fields)
    if option_count:
        # 서버 validator에서만 거절하던 MATCH의 빈 근거를 모델 출력 스키마에서도 막는다.
        match_fields = {
            "eligibility": (Literal[SupportProgramEligibility.MATCH], ...),
            "evidence": (indexes, Field(min_length=1, max_length=1)),
        }
        matched_target = create_model(
            f"MatchedTargetSelectionFor{option_count}Options", __base__=TargetEligibilityAssessment, **match_fields,
        )
        matched_region = create_model(
            f"MatchedRegionSelectionFor{option_count}Options", __base__=RegionEligibilityAssessment, **match_fields,
        )
        incompatible = create_model(
            f"IncompatibleSelectionFor{option_count}Options", __base__=IncompatibleEligibilityAssessment,
            evidence=(indexes, Field(min_length=1, max_length=1)),
        )
        target = target | matched_target | incompatible
        region = region | matched_region | incompatible
    return create_model(
        f"SupportProgramSelectionFor{option_count}Options", __base__=SupportProgramAssessment,
        semantic_relevance=(int, Field(
            alias="semanticRelevance", ge=0, le=40,
            description=(
                "검색이 요구한 지원 활동과 본문이 실제 제공하는 지원의 관련성만 0~40으로 평가한다. "
                "'AI 창업지원'처럼 지원 형태를 한정하지 않은 요청에는 AI 기업에도 적용 가능한 일반 창업보육·사업화·"
                "창업 교육·입주 공간·지식재산 활용 지원도 직접 관련 있는 일부 지원(20~29)이다. "
                "본문에 AI 단어가 없거나 설립연도·직원 수·인증 자격이 미확인이라는 이유로 20 미만으로 낮추지 않는다. "
                "설립연도나 자격 충족 여부는 대상·지역 판정에서 처리한다. "
                "특정 비용·서비스를 요구하면 그것을 실제 제공해야 하며, 다른 산업 전용 활동이나 키워드만 일치하면 20 미만이다. "
                "30~40은 핵심 요청을 직접 충족하며, 결과 수를 채우려고 점수를 올리지 않는다."
            ),
        )),
        recommendation_reasons=(
            list[Annotated[str, Field(min_length=1, max_length=120)]],
            Field(alias="recommendationReasons", min_length=1, max_length=3),
        ),
        target_assessment=(target, Field(
            alias="targetAssessment",
            description=(
                "본문에 명시된 업종·업력·기업 유형의 필수 요건만 확인한다. 소재지는 regionAssessment에서 별도로 판단한다. "
                "'20인 이상 기업 우선 지원'은 우대이지 필수 직원 수가 아니므로 직원 수 미확인만으로 UNKNOWN 또는 INCOMPATIBLE로 만들지 않는다. "
                "대안 중 한 신청 경로의 필수 요건을 충족하면 MATCH이며 다른 경로의 요건을 추가로 요구하지 않는다. "
                "충족 경로 없이 미확인 경로가 남으면 UNKNOWN, 모든 허용 경로가 명백히 불충족일 때만 INCOMPATIBLE이다. "
                "기본 7년 이내 요건을 충족하면 신산업 10년 연장 예외는 확인할 필요가 없다. "
                "확인된 공고 기준일에서 foundedYear의 연도 범위 전체가 업력 요건 안이면 정확한 월·일을 추가로 요구하지 않는다. "
                "기준일 자체가 불명확하면 기준일 미확인을 설명하고 정확한 설립일만 요구하지 않는다. "
                "'정보통신업' 같은 대분류만으로 AI 세부 업종의 충족·불충족을 단정하지 않는다. "
                "UNKNOWN의 explanation에는 남은 필수 요건을 적고 확인된 업종·설립연도와 우대 항목을 미입력 요건으로 쓰지 않는다."
            ),
        )),
        region_assessment=(region, Field(
            alias="regionAssessment",
            description=(
                "먼저 지역 제한 주체를 회사·특정 사업장·개인으로 구분한다. 회사 region을 개인 거주지나 본점·공장의 확인된 주소로 대입하지 않는다. "
                "해당 주체의 주소 미확인은 UNKNOWN이다. 예: 서울 회사/대구지역 여성은 개인 지역 미확인이므로 UNKNOWN이다. "
                "확인된 회사 소재지와 본문 신청 허용 지역의 포함 관계를 판정한다. "
                "공고 제한 지역이 확인된 회사 지역 내부의 하위 지역일 때만 하위 주소 미확인을 UNKNOWN으로 둔다. "
                "별도 허용 경로 없이 회사 지역 밖으로 명백히 제한하면 INCOMPATIBLE이며 주소 상세도 차이로 UNKNOWN 처리하지 않는다. "
                "예: 서울/서울 서초는 UNKNOWN, 서울/경기 안산은 INCOMPATIBLE. "
                "원문에 없는 추가 사업장·지점·이전 경로를 가정하지 않는다. 개인 거주지와 회사 소재지는 별개다. "
                "충돌하지 않는다는 이유로 MATCH하지 않는다. MATCH/INCOMPATIBLE의 인용 번호는 "
                "실제 소재지 허용·제한 문구를 가리켜야 하며 태그·제목·일반 지원 내용은 지역 근거가 아니다."
                " '또는'·'중 하나'·'하나 이상'의 허용 경로 중 하나를 이미 충족하면 MATCH이며 다른 경로의 이전 의사는 불필요하다. "
                "모든 허용 경로의 불충족이 확인되어야 INCOMPATIBLE이다. "
                "이미 충족한 허용 경로가 없고 본문이 실제 허용한 이전·별도 사업장 경로가 미확인이면 UNKNOWN이지 INCOMPATIBLE이 아니다. "
                "예: 안산 회사에 서울 본점·지점·공장 중 하나를 허용한 공고는 서울 지점·공장 유무 미확인이므로 UNKNOWN이다. "
                "확인된 회사 소재지 하나만으로 다른 사업장의 부재를 증명하지 않는다. "
                "사업장 종류가 확인되지 않은 회사 지역을 본점·공장 각각의 주소로 일반화하지 않는다."
            ),
        )),
    )


def _output_failure_code(error: ValidationError) -> AgentFailureCode:
    """검증 메시지·공고 ID·원문을 기록하지 않고 고정 진단 코드만 반환한다."""
    errors = error.errors(include_input=False, include_context=False, include_url=False)
    allowed_types = {
        "json_invalid", "missing", "extra_forbidden", "literal_error", "int_type",
        "greater_than_equal", "less_than_equal", "too_short", "too_long",
        "string_too_short", "string_too_long", "string_type", "list_type",
        "dict_type", "model_type", "value_error",
    }
    allowed_fields = {
        "rankings", "semanticRelevance", "targetAssessment", "regionAssessment",
        "eligibility", "evidence", "explanation", "supportTypeFit", "recommendationReasons",
    }
    types = {item["type"] if item["type"] in allowed_types else "other" for item in errors}
    fields = {part for item in errors for part in item["loc"]
              if isinstance(part, str) and part in allowed_fields}
    failure_code = (
        AgentFailureCode.MODEL_OUTPUT_INVALID_JSON if "json_invalid" in types
        else AgentFailureCode.MODEL_OUTPUT_SCHEMA_MISMATCH
    )
    logger.warning(
        "support_program_ranking_output_invalid reason_code=%s validation_types=%s validation_fields=%s",
        failure_code.value, ",".join(sorted(types)), ",".join(sorted(fields)) or "none",
    )
    return failure_code


class SupportProgramRecommendationAgent:
    """한 번의 structured LLM 호출로 모든 공고 후보를 점수화한다."""

    def __init__(
        self,
        *,
        model: ChatOpenAI,
        model_timeout_seconds: float,
        run_timeout_seconds: float,
        reasoning_effort: Literal["none", "low"] = "none",
        service_tier: Literal["default", "priority"] | None = None,
    ) -> None:
        if reasoning_effort not in ("none", "low"):
            raise ValueError("ranking reasoning effort must be none or low")
        if service_tier not in (None, "default", "priority"):
            raise ValueError("ranking service tier must be default or priority")
        self._instructions = SUPPORT_PROGRAM_RANKING_INSTRUCTIONS
        self._run_timeout_seconds = run_timeout_seconds
        self._model_timeout_seconds = model_timeout_seconds
        self._model = model.bind(
            max_tokens=10_000, store=False,
            reasoning={"effort": reasoning_effort},
            timeout=model_timeout_seconds,
            **({"service_tier": service_tier} if service_tier is not None else {}),
        )

    async def rank(
        self,
        request: SupportProgramRankingRequest,
    ) -> SupportProgramRankingOutput:
        candidate_count = len(request.candidates)
        started = perf_counter()
        evidence_options = {candidate.id: build_evidence_options(candidate) for candidate in request.candidates}
        selection_types = {count: _assessment_selection_type(count) for count in
                           {len(options) for options in evidence_options.values()}}
        rankings_type = create_model(
            f"SupportProgramAssessmentsFor{candidate_count}Candidates",
            __config__=ConfigDict(extra="forbid", frozen=True),
            **{
                candidate.id: (selection_types[len(evidence_options[candidate.id])], ...)
                for candidate in request.candidates
            },
        )
        output_type = create_model(
            f"SupportProgramRankingOutputFor{candidate_count}Candidates",
            __config__=ConfigDict(extra="forbid", frozen=True),
            rankings=(rankings_type, ...),
        )
        # 모든 후보 ID를 필수 속성 키로 고정해 배열의 ID 누락·중복·추가 생성을 막는다.
        instructions = self._instructions
        if request.company_conditions is not None:
            instructions = f"{instructions}\n\n{SUPPORT_PROGRAM_COMPANY_CONDITIONS_INSTRUCTIONS}"
        payload = request.model_dump(mode="json", by_alias=True)
        for candidate in payload["candidates"]:
            candidate["evidenceOptions"] = [
                {"index": index, **option.model_dump()}
                for index, option in enumerate(evidence_options[candidate["id"]])
            ]
        prepared = perf_counter()
        try:
            async with asyncio.timeout(self._run_timeout_seconds):
                result = await invoke_support_program_model(
                    self._model, instructions=instructions, payload=payload,
                    output_type=output_type, timeout_seconds=self._model_timeout_seconds,
                )
                output = validate_support_program_output(result, output_type)
        except (APITimeoutError, TimeoutError) as error:
            logger.info(
                "support_program_ranking_model_failed outcome=timeout candidate_count=%d model_ms=%d",
                candidate_count, round((perf_counter() - prepared) * 1000),
            )
            raise AgentTimeoutError("Support program recommendation agent timed out") from error
        except (OpenAIError, ValueError) as error:
            logger.info(
                "support_program_ranking_model_failed outcome=failed candidate_count=%d model_ms=%d",
                candidate_count, round((perf_counter() - prepared) * 1000),
            )
            raise AgentExecutionError(
                "Support program recommendation agent did not produce a usable result",
                reason_code=_output_failure_code(error) if isinstance(error, ValidationError) else AgentFailureCode.EXECUTION_FAILED,
            ) from error
        except asyncio.CancelledError:
            logger.info(
                "support_program_ranking_model_failed outcome=cancelled candidate_count=%d model_ms=%d",
                candidate_count, round((perf_counter() - prepared) * 1000),
            )
            raise

        model_finished = perf_counter()
        # LangChain 응답에 포함된 실제 사용량만 기록한다. 사용량 없는 응답은 0 토큰으로 오인하지 않는다.
        usage = result.usage_metadata
        usage_reported = usage is not None
        cached_input_tokens, reasoning_tokens = get_support_program_usage_details(usage)
        logger.info(
            "support_program_ranking_model_completed candidate_count=%d model_ms=%d usage_reported=%s "
            "input_tokens=%s output_tokens=%s cached_input_tokens=%s reasoning_tokens=%s",
            candidate_count, round((model_finished - prepared) * 1000), usage_reported,
            usage.get("input_tokens") if usage_reported else None,
            usage.get("output_tokens") if usage_reported else None,
            cached_input_tokens,
            reasoning_tokens,
        )
        assessments: list[AssessedSupportProgram] = []
        for candidate in request.candidates:
            selection = getattr(output.rankings, candidate.id).model_dump()
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
            "support_program_ranking_completed candidate_count=%d preparation_ms=%d model_ms=%d validation_ms=%d elapsed_ms=%d",
            candidate_count, round((prepared - started) * 1000),
            round((model_finished - prepared) * 1000), round((perf_counter() - model_finished) * 1000),
            round((perf_counter() - started) * 1000),
        )
        return SupportProgramRankingOutput(rankings=assessments)
