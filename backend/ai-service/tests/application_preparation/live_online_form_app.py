"""Minimal internal app used only by the explicit local online form smoke."""
from fastapi import FastAPI
from app.application_preparation.router import inspect_public_online_form

app = FastAPI()
app.add_api_route("/internal/v1/application-preparations/online-form/inspect", inspect_public_online_form, methods=["POST"])
