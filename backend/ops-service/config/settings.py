"""Ops 전용 계정과 평가 실행 이력을 관리하는 Django 설정."""

import re
from pathlib import Path

import environ
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent
env = environ.Env()
environ.Env.read_env(BASE_DIR / ".env", overwrite=False)

SECRET_KEY = env("DJANGO_SECRET_KEY")
DEBUG = env.bool("DJANGO_DEBUG", default=False)
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["localhost", "127.0.0.1"])

INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "rest_framework",
    "apps.health.apps.HealthConfig",
    "apps.evaluations",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
            ],
        },
    },
]
OPS_WEB_URL = env("OPS_WEB_URL", default="http://localhost:5173").rstrip("/")
CORE_API_URL = env("CORE_API_URL", default="http://127.0.0.1:8080").rstrip("/")
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"auth_console": {"class": "logging.StreamHandler"}},
    "loggers": {
        "apps.evaluations.authentication": {
            "handlers": ["auth_console"],
            "level": "INFO",
            "propagate": False,
        },
    },
}
# 리소스가 제한된 로컬 환경에서만 늘릴 수 있는 Core 인증 연결·읽기 제한시간이다.
try:
    CORE_AUTH_TIMEOUT_SECONDS = env.int("CORE_AUTH_TIMEOUT_SECONDS", default=3)
except (TypeError, ValueError) as error:
    raise ImproperlyConfigured("CORE_AUTH_TIMEOUT_SECONDS must be an integer in 1..10") from error
if not 1 <= CORE_AUTH_TIMEOUT_SECONDS <= 10:
    raise ImproperlyConfigured("CORE_AUTH_TIMEOUT_SECONDS must be an integer in 1..10")
# 로컬 복제본은 원본 core:<id> 검토자와 새 Core의 같은 숫자 ID를 구별한다.
# 생성 후 변경하지 않는다. 원본 환경은 빈 값으로 기존 계정 연결을 유지한다.
CORE_ACCOUNT_NAMESPACE = env("CORE_ACCOUNT_NAMESPACE", default="")
if CORE_ACCOUNT_NAMESPACE and not re.fullmatch(r"[a-f0-9]{32}", CORE_ACCOUNT_NAMESPACE):
    raise ImproperlyConfigured("CORE_ACCOUNT_NAMESPACE must be empty or 32 lowercase hex digits")
# 같은 origin 프록시가 Host를 보존하면 추가 설정 없이 Origin을 검증한다.
CSRF_TRUSTED_ORIGINS = env.list("DJANGO_CSRF_TRUSTED_ORIGINS", default=[])
SESSION_COOKIE_NAME = "govbiz_ops_session"
CSRF_COOKIE_NAME = "govbiz_ops_csrf"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SECURE = env.bool("DJANGO_COOKIE_SECURE", default=not DEBUG)
CSRF_COOKIE_SECURE = SESSION_COOKIE_SECURE
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

PREFECT_API_URL = env("PREFECT_API_URL", default="http://127.0.0.1:14200/api").rstrip("/")
PREFECT_UI_URL = env("PREFECT_UI_URL", default="http://localhost:14200").rstrip("/")
PREFECT_DEPLOYMENT_NAME = "govbiz-ops-evidence-evaluation/saved-capture"
# Empty URL explicitly selects filesystem storage. HTTP failure never falls back.
LLMOPS_ARTIFACT_URL = env("LLMOPS_ARTIFACT_URL", default="").rstrip("/")
LLMOPS_ARTIFACT_TOKEN = env("LLMOPS_ARTIFACT_TOKEN", default="")
LLMOPS_BUDGET_TOKEN = env("LLMOPS_BUDGET_TOKEN", default="")
LLMOPS_LIVE_ENABLED = env.bool("LLMOPS_LIVE_ENABLED", default=False)
LLMOPS_LOCAL_SEED_ENABLED = env.bool("LLMOPS_LOCAL_SEED_ENABLED", default=False)
LLMOPS_RAG_LIVE_ENABLED = env.bool("LLMOPS_RAG_LIVE_ENABLED", default=False)
LLMOPS_SCHEDULES_ENABLED = env.bool("LLMOPS_SCHEDULES_ENABLED", default=False)
# 운영 본문 표본은 별도 동의한 배포에서만 수집한다. 평가 실행기 토큰과 분리한다.
LLMOPS_PRODUCTION_SAMPLES_ENABLED = env.bool("LLMOPS_PRODUCTION_SAMPLES_ENABLED", default=False)
LLMOPS_PRODUCTION_SAMPLE_TOKEN = env("LLMOPS_PRODUCTION_SAMPLE_TOKEN", default="")
LLMOPS_PRODUCTION_SAMPLE_DAILY_LIMIT = env.int("LLMOPS_PRODUCTION_SAMPLE_DAILY_LIMIT", default=100)
LLMOPS_PRODUCTION_SAMPLE_RETENTION_DAYS = env.int(
    "LLMOPS_PRODUCTION_SAMPLE_RETENTION_DAYS", default=14
)
if not 1 <= LLMOPS_PRODUCTION_SAMPLE_DAILY_LIMIT <= 10000:
    raise ImproperlyConfigured("LLMOPS_PRODUCTION_SAMPLE_DAILY_LIMIT must be 1..10000")
if not 1 <= LLMOPS_PRODUCTION_SAMPLE_RETENTION_DAYS <= 30:
    raise ImproperlyConfigured("LLMOPS_PRODUCTION_SAMPLE_RETENTION_DAYS must be 1..30")
if LLMOPS_PRODUCTION_SAMPLES_ENABLED and len(LLMOPS_PRODUCTION_SAMPLE_TOKEN) < 32:
    raise ImproperlyConfigured("Production sample collection requires a dedicated token")
LLMOPS_RESULTS_DIR = Path(
    env("LLMOPS_RESULTS_DIR", default=str(BASE_DIR.parent.parent / "work/llmops-ops"))
).resolve()
LLMOPS_EVIDENCE_DIR = Path(
    env(
        "LLMOPS_EVIDENCE_DIR",
        default=str(BASE_DIR.parent.parent / "evaluation/support-program-evidence"),
    )
).resolve()
LANGFUSE_PROJECT_URL = env(
    "LANGFUSE_PROJECT_URL",
    default="http://localhost:13000/project/govbiz-evidence-development",
).rstrip("/")
# 브라우저에 전달하지 않는 프로젝트 API 연결. 누락 시 실행 추적 조회만 503으로 거절한다.
LANGFUSE_BASE_URL = env("LANGFUSE_BASE_URL", default="").rstrip("/")
LANGFUSE_PUBLIC_KEY = env("LANGFUSE_PUBLIC_KEY", default="")
LANGFUSE_SECRET_KEY = env("LANGFUSE_SECRET_KEY", default="")

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.mysql",
        "NAME": env("DB_NAME", default="govbiz4"),
        "USER": env("DB_USER", default="govbiz4"),
        "PASSWORD": env("DB_PASSWORD"),
        "HOST": env("DB_HOST", default="127.0.0.1"),
        "PORT": env.int("DB_PORT", default=3308),
        "CONN_MAX_AGE": 0,
        "OPTIONS": {
            "charset": "utf8mb4",
            "connect_timeout": 5,
            "init_command": "SET sql_mode='STRICT_TRANS_TABLES'",
        },
        "TEST": {
            "CHARSET": "utf8mb4",
            "COLLATION": "utf8mb4_0900_ai_ci",
        },
    }
}

LANGUAGE_CODE = "ko-kr"
TIME_ZONE = "Asia/Seoul"
USE_I18N = True
USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

REST_FRAMEWORK = {
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "DEFAULT_AUTHENTICATION_CLASSES": ["apps.evaluations.authentication.CoreSessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
}
