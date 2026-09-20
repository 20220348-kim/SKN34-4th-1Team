from django.urls import path

from apps.health.views import health, readiness

app_name = "health"

urlpatterns = [
    path("health", health, name="health"),
    path("health/ready", readiness, name="readiness"),
]
