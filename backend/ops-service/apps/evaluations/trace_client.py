"""프로젝트 API 키로 Langfuse의 읽기 전용 실행 단계만 조회한다."""

import base64
import json
import logging
import math
import re
import time
from decimal import Decimal
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from django.conf import settings
from django.utils.dateparse import parse_datetime
from django.utils.timezone import is_aware

PAGE_SIZE = 50
CALL_PAGE_SIZE = 1000
MAX_CALL_PAGES = 3
CALL_READ_SECONDS = 8
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
ID_PATTERN = r"[A-Za-z0-9_-]{1,128}"
CURSOR_PATTERN = r"[A-Za-z0-9+/=_-]{1,2048}"
# 화면의 업무 이름과 Langfuse observation 이름은 서로 다른 계약이다.
# Core 전체 흐름과 AI 서비스의 별도 시작 단계를 같은 업무로 조회한다.
EXECUTION_PREFIXES = {
    "support-program-search": "search.",
    "assistant-agent": "assistant.",
    "support-program-evidence": "evidence.",
}
logger = logging.getLogger(__name__)


class LangfuseUnavailable(Exception):
    pass


class NoTraceRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # 다른 호스트로 프로젝트 키를 전달하거나 로그인 HTML을 결과로 읽지 않는다.
        return None


def read_page(params, *, timeout=5):
    base = settings.LANGFUSE_BASE_URL
    public, secret = settings.LANGFUSE_PUBLIC_KEY, settings.LANGFUSE_SECRET_KEY
    category = "configuration"
    http_status = None
    try:
        parsed = urlsplit(base)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or any(char.isspace() for char in base)
            or any(
                not value
                or len(value) > 4096
                or any(char.isspace() or ord(char) < 32 or char == ":" for char in value)
                for value in (public, secret)
            )
        ):
            raise ValueError("Invalid trace configuration")
        _ = parsed.port  # 잘못된 포트도 요청 전에 거절한다.
        authorization = base64.b64encode(f"{public}:{secret}".encode()).decode()
        request = Request(
            base.rstrip("/") + "/api/public/v2/observations?" + urlencode(params),
            headers={"Authorization": "Basic " + authorization, "Accept": "application/json"},
            method="GET",
        )
        category = "transport"
        with build_opener(ProxyHandler({}), NoTraceRedirect()).open(
            request, timeout=timeout
        ) as response:
            http_status = response.status
            if response.status != 200:
                category = "upstream_http"
                raise ValueError("Unexpected trace response")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        category = "response_validation"
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("Trace response too large")
        category = "response_parse"
        data = json.loads(raw)
        category = "response_validation"
        if not isinstance(data, dict) or not isinstance(data.get("meta"), dict):
            raise ValueError("Invalid trace response")
        rows, cursor = data.get("data"), data["meta"].get("cursor")
        if (
            not isinstance(rows, list)
            or len(rows) > min(params.get("limit", PAGE_SIZE), CALL_PAGE_SIZE)
            or (cursor is not None and not valid_id(cursor, CURSOR_PATTERN))
        ):
            raise ValueError("Invalid trace page")
        return rows, cursor
    except (URLError, OSError, HTTPException, ValueError, TypeError, RecursionError) as error:
        if isinstance(error, HTTPError):
            category, http_status = "upstream_http", error.code
        elif isinstance(error, TimeoutError) or (
            isinstance(error, URLError) and isinstance(error.reason, TimeoutError)
        ):
            category = "timeout"
        # 고정 분류와 숫자 상태만 기록한다. 예외 본문·주소·키·조회 조건은 남기지 않는다.
        logger.warning(
            "langfuse_trace_read_failed category=%s http_status=%s",
            category,
            http_status if type(http_status) is int and 100 <= http_status <= 599 else "none",
        )
        raise LangfuseUnavailable from None


def valid_id(value, pattern=ID_PATTERN):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def timestamp(value, *, optional=False):
    if value is None and optional:
        return None
    parsed = parse_datetime(value) if isinstance(value, str) else None
    if parsed is None or not is_aware(parsed):
        raise ValueError("Invalid trace timestamp")
    return parsed.isoformat()


def text(value, *, optional=False, limit=1024):
    if value is None and optional:
        return None
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("Invalid trace text")
    return value


def number(value):
    if value is None:
        return None
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ValueError("Invalid trace metric")
    return value


def observation(row, *, detail=False):
    if not isinstance(row, dict) or not valid_id(row.get("id")) or not valid_id(row.get("traceId")):
        raise ValueError("Invalid trace identity")
    result = {
        "id": row["id"],
        "trace_id": row["traceId"],
        "name": text(row.get("name") or ""),
        "type": text(row["type"], limit=64),
        "started_at": timestamp(row.get("startTime")),
        "ended_at": timestamp(row.get("endTime"), optional=True),
        "level": text(row.get("level") or "DEFAULT", limit=64),
        "status_message": text(row.get("statusMessage"), optional=True, limit=16384),
        "model": text(row.get("model"), optional=True),
        "latency_seconds": number(row.get("latency")),
        "total_cost": number(row.get("totalCost")),
        "environment": text(row.get("environment"), optional=True),
    }
    if detail:
        parent = row.get("parentObservationId")
        usage = row.get("usageDetails")
        if parent is not None and not valid_id(parent):
            raise ValueError("Invalid parent observation")
        if usage is not None and (
            not isinstance(usage, dict)
            or len(usage) > 100
            or any(
                not isinstance(key, str) or len(key) > 128 or type(value) is not int or value < 0
                for key, value in usage.items()
            )
        ):
            raise ValueError("Invalid trace usage")
        metadata = row.get("metadata")
        # 메타데이터의 NaN/Infinity를 공개 JSON의 정상 값으로 내보내지 않는다.
        json.dumps(metadata, allow_nan=False)
        result.update(
            parent_observation_id=parent,
            input=text(row.get("input"), optional=True, limit=MAX_RESPONSE_BYTES),
            output=text(row.get("output"), optional=True, limit=MAX_RESPONSE_BYTES),
            metadata=metadata,
            usage_details=usage,
        )
    return result


def call_node(row):
    """요약에는 입출력 없이 호출 정보와 부모 관계만 사용한다."""
    item = observation(row)
    parent = row.get("parentObservationId")
    if (parent is not None and not valid_id(parent)) or type(
        row.get("isRootObservation")
    ) is not bool:
        raise ValueError("Invalid observation relationship")
    return {
        key: item[key] for key in ("id", "trace_id", "type", "model", "total_cost", "ended_at")
    } | {"parent": parent, "root": row["isRootObservation"]}


def read_call_summaries(roots):
    """한 페이지의 trace들을 묶어 읽고 각 호출을 가장 가까운 시작 단계에 귀속한다."""
    if not roots:
        return {}
    try:
        nodes = {row["id"]: call_node(row) for row in roots}
        root_ids = set(nodes)
        trace_ids = sorted({row["trace_id"] for row in nodes.values()})
        calls = {root_id: [] for root_id in root_ids}
        pending_roots = set()
        partial_traces = set()
        seen = set()
        cursors = set()
        params = {
            # 기간/루트 필터를 이어 쓰지 않는다. 기간 끝에 시작한 요청의 하위 호출도 읽는다.
            "filter": json.dumps(
                [
                    {
                        "type": "stringOptions",
                        "column": "traceId",
                        "operator": "any of",
                        "value": trace_ids,
                    }
                ],
                separators=(",", ":"),
            ),
            "fields": "basic,model,usage",
            "limit": CALL_PAGE_SIZE,
        }
        deadline = time.monotonic() + CALL_READ_SECONDS
        complete = False
        for _ in range(MAX_CALL_PAGES):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            rows, cursor = read_page(params, timeout=min(5, remaining))
            for row in rows:
                node = call_node(row)
                node_id = node["id"]
                if node["trace_id"] not in trace_ids:
                    raise ValueError("Unexpected trace in call summary")
                if node_id in seen and nodes[node_id] != node:
                    raise ValueError("Conflicting observation")
                if node_id in root_ids and (
                    node["trace_id"] != nodes[node_id]["trace_id"] or not node["root"]
                ):
                    raise ValueError("Unexpected root in call summary")
                nodes[node_id] = node
                seen.add(node_id)
            if not cursor:
                complete = True
                break
            if cursor in cursors:
                raise ValueError("Repeated observation cursor")
            cursors.add(cursor)
            params = {**params, "cursor": cursor}
        # 루트 목록과 하위 조회 사이의 반영 지연도 완전한 0건으로 표현하지 않는다.
        partial_traces.update(nodes[key]["trace_id"] for key in root_ids - seen)
        for node in nodes.values():
            current = node
            visited = set()
            while not current["root"]:
                parent = current["parent"]
                if current["id"] in visited or parent not in nodes:
                    partial_traces.add(node["trace_id"])
                    current = None
                    break
                visited.add(current["id"])
                current = nodes[parent]
                if current["trace_id"] != node["trace_id"]:
                    raise ValueError("Cross-trace parent")
            if current is not None and current["id"] in calls:
                # 다른 logical root를 지나 상위 카드까지 중복 합산하지 않는다.
                if node["ended_at"] is None:
                    pending_roots.add(current["id"])
                if node["type"].upper() in {"GENERATION", "EMBEDDING"}:
                    calls[current["id"]].append(node)
        summaries = {}
        for root_id, items in calls.items():
            models = sorted(
                {item["model"].strip() for item in items if item["model"] and item["model"].strip()}
            )
            costs = [
                Decimal(str(item["total_cost"])) for item in items if item["total_cost"] is not None
            ]
            cost = number(float(sum(costs))) if costs else None
            root = nodes[root_id]
            partial = not complete or root["trace_id"] in partial_traces or root_id in pending_roots
            summaries[root_id] = {
                "models": models,
                "call_count": len(items),
                "missing_model_count": sum(not (item["model"] or "").strip() for item in items),
                "recorded_cost": cost,
                "missing_cost_count": len(items) - len(costs),
                "status": "partial" if partial else "complete",
            }
        return summaries
    except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
        logger.warning("langfuse_trace_read_failed category=response_validation operation=summary")
        raise LangfuseUnavailable from None


def read_roots(*, from_time, to_time, name="", cursor=""):
    params = {
        "isRootObservation": "true",
        "fromStartTime": from_time.isoformat(),
        "toStartTime": to_time.isoformat(),
        "fields": "basic,model,usage,metrics",
        "limit": PAGE_SIZE,
    }
    prefix = EXECUTION_PREFIXES.get(name)
    if prefix:
        # v2의 filter는 단순 query 조건보다 우선하므로 기간과 루트 조건도 포함한다.
        params["filter"] = json.dumps(
            [
                {"type": "boolean", "column": "isRootObservation", "operator": "=", "value": True},
                {
                    "type": "datetime",
                    "column": "startTime",
                    "operator": ">=",
                    "value": from_time.isoformat(),
                },
                {
                    "type": "datetime",
                    "column": "startTime",
                    "operator": "<",
                    "value": to_time.isoformat(),
                },
                {"type": "string", "column": "name", "operator": "starts with", "value": prefix},
            ],
            separators=(",", ":"),
        )
    elif name:
        params["name"] = name
    if cursor:
        params["cursor"] = cursor
    rows, next_cursor = read_page(params)
    try:
        if any(row.get("isRootObservation") is not True for row in rows):
            raise ValueError("Unexpected non-root observation")
        results = [observation(row) for row in rows]
        if prefix and any(not row["name"].startswith(prefix) for row in results):
            raise ValueError("Unexpected execution category")
        if len({row["id"] for row in results}) != len(results):
            raise ValueError("Duplicate observation")
    except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
        logger.warning("langfuse_trace_read_failed category=response_validation operation=list")
        raise LangfuseUnavailable from None
    summaries = read_call_summaries(rows)
    for item in results:
        item["call_summary"] = summaries[item["id"]]
    return {"results": results, "next_cursor": next_cursor}


def read_trace(trace_id, *, cursor=""):
    if not valid_id(trace_id):
        raise ValueError("Invalid trace ID")
    params = {
        "traceId": trace_id,
        "fields": "basic,model,usage,metrics,io,metadata",
        "limit": PAGE_SIZE,
    }
    if cursor:
        params["cursor"] = cursor
    rows, next_cursor = read_page(params)
    try:
        results = [observation(row, detail=True) for row in rows]
        if any(row["trace_id"] != trace_id for row in results) or len(
            {row["id"] for row in results}
        ) != len(results):
            raise ValueError("Unexpected trace observation")
    except (KeyError, TypeError, ValueError, OverflowError, RecursionError):
        logger.warning("langfuse_trace_read_failed category=response_validation operation=detail")
        raise LangfuseUnavailable from None
    return {"trace_id": trace_id, "observations": results, "next_cursor": next_cursor}
