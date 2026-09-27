from django.urls import include, path

urlpatterns = [
    path("api/v1/", include("apps.health.urls")),
    path("", include("apps.evaluations.urls")),
]
