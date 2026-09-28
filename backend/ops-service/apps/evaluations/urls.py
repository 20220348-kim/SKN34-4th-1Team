from django.urls import path

from . import views

urlpatterns = [
    path("api/v1/ops/evaluations/<uuid:run_id>/fixture-review", views.api_fixture_review),
    path("api/v1/ops/evaluations/<uuid:run_id>/quality", views.api_quality),
    path("", views.web_redirect),
    path("ops/login", views.web_redirect),
    path("ops/evaluations", views.web_redirect),
    path("ops/evaluations/<uuid:run_id>", views.web_redirect),
    path("api/v1/ops/session", views.api_session),
    path("api/v1/ops/evaluations", views.api_runs, name="api-evaluations"),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>", views.api_run_detail, name="api-evaluation-detail"
    ),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>/recover",
        views.api_recover,
        name="evaluation-recover",
    ),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>/review",
        views.api_review,
        name="evaluation-review",
    ),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>/case-review",
        views.api_case_review,
        name="evaluation-case-review",
    ),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>/baseline",
        views.api_baseline,
        name="evaluation-baseline",
    ),
    path(
        "api/v1/ops/evaluations/<uuid:run_id>/report",
        views.evaluation_report,
        name="evaluation-report",
    ),
]
