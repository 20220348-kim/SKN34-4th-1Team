# syntax=docker/dockerfile:1

FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN groupadd --system govbiz && \
    useradd --system \
        --gid govbiz \
        --home-dir /nonexistent \
        --shell /usr/sbin/nologin \
        govbiz

COPY --chown=govbiz:govbiz server.py ./

USER govbiz:govbiz

EXPOSE 8004

CMD ["python", "server.py"]
