# syntax=docker/dockerfile:1
FROM python:3.13-slim-bookworm AS builder

COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /bin/uv
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential default-libmysqlclient-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

FROM python:3.13-slim-bookworm AS runtime

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libmariadb3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 govbiz \
    && useradd --uid 10001 --gid govbiz --no-create-home --shell /usr/sbin/nologin govbiz
COPY --from=builder /app/.venv /app/.venv
COPY --chown=govbiz:govbiz manage.py ./
COPY --chown=govbiz:govbiz config ./config
COPY --chown=govbiz:govbiz apps ./apps
USER 10001:10001
EXPOSE 8000
# 개발 Compose만 runserver로 재정의합니다. DB migration은 별도 배포 작업입니다.
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "2", "--timeout", "30", "--graceful-timeout", "25", "--worker-tmp-dir", "/tmp", "--access-logfile", "-", "--error-logfile", "-"]
