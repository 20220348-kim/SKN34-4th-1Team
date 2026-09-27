from django.contrib.auth.views import LogoutView
from django.urls import path
from django.views.generic import RedirectView

from . import views

urlpatterns = [
    path("", RedirectView.as_view(pattern_name="evaluation-list", permanent=False)),
    path("ops/login", views.OperatorLoginView.as_view(), name="ops-login"),
    path("ops/logout", LogoutView.as_view(), name="ops-logout"),
    path("ops/evaluations", views.evaluation_list, name="evaluation-list"),
    path("ops/evaluations/<uuid:run_id>", views.evaluation_detail, name="evaluation-detail"),
    path("ops/evaluations/<uuid:run_id>/report", views.evaluation_report, name="evaluation-report"),
    path("api/v1/evaluations", views.api_runs, name="api-evaluations"),
    path("api/v1/evaluations/<uuid:run_id>", views.api_run_detail, name="api-evaluation-detail"),
]
