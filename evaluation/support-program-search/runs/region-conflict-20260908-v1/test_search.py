import importlib.util
import json
from pathlib import Path

import httpx2
import pytest


@pytest.fixture
def probe(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("region_search_probe", Path(__file__).with_name("run-search.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    return module


def test_default_plan_makes_no_request_or_reservation(probe, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("unexpected network")
    monkeypatch.setattr(httpx2, "Client", forbidden)
    assert probe.run() == 0
    assert list(probe.ROOT.iterdir()) == []


@pytest.mark.parametrize("kind", ["success", "ansan", "missing-national", "missing-personal", "http-error", "invalid-score", "non-json"])
def test_one_attempt_preserves_region_check_and_never_retries(probe, monkeypatch, capsys, kind):
    calls = []
    real_client = httpx2.Client
    def handler(request):
        calls.append(request)
        assert (probe.ROOT / "search/capture.json").exists()
        assert request.method == "POST"
        assert str(request.url) == "http://127.0.0.1:8080/api/v1/support-programs/search"
        assert json.loads(request.content) == probe.BODY
        if kind == "http-error":
            return httpx2.Response(503, text="private error")
        if kind == "non-json":
            return httpx2.Response(200, text="private response")
        programs = [
            {"sourceCode": "BIZINFO", "id": "PBLN_000000000125611", "recommendationScore": 90},
            {"sourceCode": "BIZINFO", "id": "PBLN_000000000125748", "recommendationScore": 80},
        ]
        if kind == "ansan":
            programs.append({"sourceCode": "BIZINFO", "id": "PBLN_000000000125900", "recommendationScore": 80})
        if kind == "missing-national":
            programs = programs[1:]
        if kind == "missing-personal":
            programs = programs[:1]
        if kind == "invalid-score":
            programs[0]["recommendationScore"] = True
        return httpx2.Response(200, json={"programs": programs})
    def create_client(**kwargs):
        assert kwargs == {"trust_env": False, "follow_redirects": False, "timeout": 90}
        return real_client(transport=httpx2.MockTransport(handler), **kwargs)
    monkeypatch.setattr(httpx2, "Client", create_client)
    assert probe.run(True) == (0 if kind == "success" else 2)
    assert len(calls) == 1
    saved = (probe.ROOT / "search/capture.json").read_text()
    assert "private" not in saved + capsys.readouterr().out
    with pytest.raises(FileExistsError):
        probe.run(True)
    assert len(calls) == 1
