"""로컬 볼륨 없이 실제 실행기 증거를 내부 HTTP로 읽는 계약. DB·모델 호출 없음."""

import io
import json
from hashlib import sha256
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

from django.conf import settings
from django.test import override_settings

from . import artifact_store
from . import test_usage_correction as receipts
from .artifact_files import MAX_RECEIPT_BYTES
from .artifact_server import application
from .test_artifact_store import TOKEN, ArtifactServerMixin
from .usage_correction import CorrectionUnavailable, read_receipt


class RemoteUsageReceiptTests(ArtifactServerMixin, receipts.UsageReceiptTests):
    # Repeat the producer/signature/invalid-file cases against the real HTTP boundary.
    def setUp(self):
        super().setUp()
        self.url = self.serve(application(self.root, self.root / "no-evidence", TOKEN))
        override = override_settings(
            LLMOPS_ARTIFACT_URL=self.url,
            LLMOPS_ARTIFACT_TOKEN=TOKEN,
            LLMOPS_RESULTS_DIR=self.root / "not-mounted-results",
        )
        override.enable()
        self.addCleanup(override.disable)

    def request(self, suffix, *, token=TOKEN, method="GET"):
        request = Request(
            self.url + suffix, headers={"Authorization": f"Bearer {token}"}, method=method
        )
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, response.read(), response.headers
        except HTTPError as error:
            with error:
                return error.code, error.read(), error.headers

    def test_answer_and_embedding_bytes_are_identical_without_a_local_mount(self):
        self.assertFalse(settings.LLMOPS_RESULTS_DIR.exists())
        self.assertEqual(read_receipt(self.run_id, 0)[0].encode(), self.raw)
        for sequence, kind in ((1, "document_embedding"), (511, "query_embedding")):
            operation = {
                "id": f"{kind}:sample",
                "kind": kind,
                "model": "text-embedding-3-small",
                "dimensions": 1536,
                "input_sha256": "c" * 64,
                "max_input_tokens": 500,
                "max_output_tokens": 0,
            }
            self.runner.record_embedding_usage_receipt(
                self.folder,
                sequence,
                operation,
                f"req_embedding_{sequence}",
                {"input_tokens": 100, "output_tokens": 0, "total_tokens": 100},
            )
            raw = (self.folder / f"usage-{sequence}.json").read_bytes()
            text, digest, payload, _ = read_receipt(self.run_id, sequence)
            self.assertEqual(text.encode(), raw)
            self.assertEqual(digest, sha256(raw).hexdigest())
            self.assertEqual(payload["operation_kind"], kind)
            self.assertNotIn("response_id", payload)
        # A valid receipt at the wrong location must fail its signed run/sequence contract.
        (self.folder / "usage-2.json").write_bytes(self.raw)
        with self.assertRaises(CorrectionUnavailable):
            read_receipt(self.run_id, 2)
        other = uuid4()
        directory = self.root / str(other) / "capture"
        directory.mkdir(parents=True)
        (directory / "usage-0.json").write_bytes(self.raw)
        with self.assertRaises(CorrectionUnavailable):
            read_receipt(other, 0)

    def test_receipt_endpoint_requires_authentication_get_and_exact_selection(self):
        endpoint = f"/v1/usage-receipts/{self.run_id}/0"
        code, raw, headers = self.request(endpoint)
        self.assertEqual((code, raw), (200, self.raw))
        self.assertEqual(headers["Cache-Control"], "no-store")
        for token in ("", "invalid", "b" * 64):
            self.assertEqual(self.request(endpoint, token=token)[0], 401)
        for method in ("POST", "PUT", "PATCH", "DELETE", "HEAD"):
            self.assertEqual(self.request(endpoint, method=method)[0], 405)
        for path in (
            "/v1/usage-receipts/",
            "/v1/usage-receipts/not-a-uuid/0",
            f"/v1/usage-receipts/{str(self.run_id).upper()}/0",
            endpoint + "?sequence=1",
            f"/v1/results/{self.run_id}/capture/usage-0.json",
            *(
                f"/v1/usage-receipts/{self.run_id}/{value}"
                for value in ("-1", "512", "00", "+0", "0.0", "true", "0/", "../0", "usage-0.json")
            ),
        ):
            with self.subTest(path=path):
                code, raw, _ = self.request(path)
                self.assertEqual(code, 404)
                self.assertNotIn(self.raw, raw)
                self.assertNotIn(str(self.root).encode(), raw)

    def test_invalid_local_selection_never_sends_http(self):
        for run, sequence in (
            (self.run_id, True),
            (self.run_id, -1),
            (self.run_id, 512),
            (self.run_id, "0"),
            (self.run_id, 0.0),
            ("../private", 0),
        ):
            with patch.object(artifact_store, "build_opener") as build:
                with self.assertRaises(CorrectionUnavailable):
                    read_receipt(run, sequence)
                build.assert_not_called()

    def test_exact_size_boundary_and_oversize_rejected_by_both_transports(self):
        bounded = self.raw + b" " * (MAX_RECEIPT_BYTES - len(self.raw))
        self.path.write_bytes(bounded)
        for url in (self.url, ""):
            with override_settings(LLMOPS_ARTIFACT_URL=url, LLMOPS_RESULTS_DIR=self.root):
                self.assertEqual(read_receipt(self.run_id, 0)[0].encode(), bounded)
                self.path.write_bytes(bounded + b" ")
                with self.assertRaises(CorrectionUnavailable):
                    read_receipt(self.run_id, 0)
                self.path.write_bytes(bounded)

    def test_remote_failure_never_reads_a_valid_local_receipt(self):
        with override_settings(LLMOPS_RESULTS_DIR=self.root, LLMOPS_ARTIFACT_TOKEN="b" * 64):
            with patch.object(artifact_store, "read_file") as local_read:
                with self.assertRaises(CorrectionUnavailable):
                    read_receipt(self.run_id, 0)
                local_read.assert_not_called()
        with patch.object(artifact_store, "build_opener", side_effect=TimeoutError):
            with self.assertRaises(CorrectionUnavailable):
                read_receipt(self.run_id, 0)

    def test_redirect_and_untrusted_http_body_fail_before_receipt_validation(self):
        calls = []

        def redirect(environ, respond):
            calls.append(environ["PATH_INFO"])
            respond("302 Found", [("Location", self.url + "/v1/status"), ("Content-Length", "0")])
            return [b""]

        with override_settings(LLMOPS_ARTIFACT_URL=self.serve(redirect)):
            with self.assertRaises(CorrectionUnavailable):
                read_receipt(self.run_id, 0)
        self.assertEqual(calls, [f"/v1/usage-receipts/{self.run_id}/0"])
        for status, length, encoding, raw in (
            (200, "8193", None, b"x" * 8193),
            (200, "9000", None, self.raw),
            (200, None, None, self.raw),
            (200, str(len(self.raw)), "gzip", self.raw),
            (206, str(len(self.raw)), None, self.raw),
        ):
            body = io.BytesIO(raw)
            response = Mock(wraps=body)
            response.status = status
            response.headers = {"Content-Length": length, "Content-Encoding": encoding}
            context = Mock()
            context.__enter__ = Mock(return_value=response)
            context.__exit__ = Mock(return_value=False)
            opener = Mock()
            opener.open.return_value = context
            with patch.object(artifact_store, "build_opener", return_value=opener):
                with self.assertRaises(CorrectionUnavailable):
                    read_receipt(self.run_id, 0)
            if status == 200 and not encoding:
                response.read.assert_called_once_with(MAX_RECEIPT_BYTES + 1)

    def test_symlinked_capture_or_run_directory_is_not_served(self):
        alias = uuid4()
        (self.root / str(alias)).symlink_to(self.root / str(self.run_id), target_is_directory=True)
        self.assertEqual(self.request(f"/v1/usage-receipts/{alias}/0")[0], 404)
        self.folder.rename(self.root / "original-capture")
        self.folder.symlink_to(self.root / "original-capture", target_is_directory=True)
        self.assertEqual(self.request(f"/v1/usage-receipts/{self.run_id}/0")[0], 404)

    def test_wrong_embedding_signature_domain_is_rejected(self):
        # The v1 inherited case also checks modified JSON and duplicate signature keys.
        payload = json.loads(self.raw)["payload"]
        payload["version"] = 2
        self.path.write_bytes(receipts.signed(payload))
        with self.assertRaises(CorrectionUnavailable):
            read_receipt(self.run_id, 0)
