from typing import Literal

from pydantic import BaseModel


class HealthResponse(BaseModel):
    """GET /internal/v1/health 응답 계약."""

    status: Literal["up"] = "up"
    service: Literal["govbiz-ai-service"] = "govbiz-ai-service"
