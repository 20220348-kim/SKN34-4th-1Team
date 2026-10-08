"""Owned-container binding and real Node probe logic with an offline HTTP transport."""

import base64
import copy
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

import evaluation_langfuse as auth
import yaml

CREDENTIALS = {
    "LANGFUSE_PUBLIC_KEY": "pk-lf-" + "a" * 32,
    "LANGFUSE_SECRET_KEY": "sk-lf-" + "b" * 32,
}

# Execute the production JS unchanged with Node 24. Only HTTP and stdin are
# replaced; assertions exercise parsing, redirect/error rejection and headers.
NODE_HTTP = r"""
const fs = require('node:fs'), vm = require('node:vm');
const {EventEmitter} = require('node:events');
const fixture = JSON.parse(fs.readFileSync(0, 'utf8'));
const calls = [], output = [];
const child = {stdout: {write: text => output.push(text)}, exitCode: 0};
const http = {request(options, callback) {
  calls.push(options);
  const row = fixture.responses[calls.length - 1];
  const request = new EventEmitter();
  request.destroy = error => {request.emit('error', error); request.emit('close');};
  request.end = () => queueMicrotask(() => {
    if (!row || row.error) return request.destroy(new Error('private transport text'));
    if (row.stall) return;
    const response = new EventEmitter();
    response.statusCode = row.status;
    callback(response);
    if (row.aborted) response.emit('aborted');
    else {response.emit('data', Buffer.from(row.body || '')); response.emit('end');}
    request.emit('close');
  });
  return request;
}};
vm.runInNewContext(fixture.program, {
  require: name => name === 'node:http' ? http : name === 'node:os' ? {
    networkInterfaces: () => ({eth0: [{family: 'IPv4', address: '172.20.0.2', internal: false}]}),
  } : {
    readFileSync: () => JSON.stringify(fixture.input),
  },
  Buffer, setTimeout: (callback, milliseconds) => {
    if (milliseconds !== 5000) throw new Error('missing total deadline');
    return setTimeout(callback, fixture.deadline ? 0 : milliseconds);
  }, clearTimeout, process: child,
});
process.once('beforeExit', () => {
  process.stdout.write(JSON.stringify({calls, output, exitCode: child.exitCode}));
});
"""


class LangfuseProbeTests(unittest.TestCase):
    def execute(self, responses, *, address="172.20.0.2", deadline=False):
        result = subprocess.run(
            ["node", "-e", NODE_HTTP],
            input=json.dumps(
                {
                    "program": auth.AUTH_PROBE,
                    "responses": responses,
                    "deadline": deadline,
                    "input": {
                        "publicKey": CREDENTIALS["LANGFUSE_PUBLIC_KEY"],
                        "secretKey": CREDENTIALS["LANGFUSE_SECRET_KEY"],
                        "projectId": "fixture",
                        "address": address,
                    },
                }
            ),
            text=True,
            capture_output=True,
            check=True,
            timeout=10,
        )
        return json.loads(result.stdout)

    def test_only_own_container_address_is_contacted_and_total_deadline_is_required(self):
        result = self.execute([], address="172.20.0.99")
        self.assertEqual(result["exitCode"], 1)
        self.assertEqual(result["calls"], [])
        result = self.execute([{"stall": True}], deadline=True)
        self.assertEqual(result["exitCode"], 1)
        self.assertEqual(result["output"], ['{"status":"BLOCKED"}'])
        self.assertEqual(len(result["calls"]), 1)

    def test_infra_ci_installs_the_repository_node_runtime_for_offline_probe_tests(self):
        root = Path(__file__).resolve().parents[3]
        workflow = yaml.safe_load(
            (root / ".github/workflows/infra-ci.yml").read_text(encoding="utf-8")
        )
        setup = next(
            s
            for s in workflow["jobs"]["kubernetes-manifests"]["steps"]
            if s.get("uses", "").startswith("pnpm/setup@")
        )
        self.assertEqual(setup["with"]["runtime"], "node@24")
        self.assertIs(setup["with"]["install"], False)

    def test_own_address_get_requires_anonymous_rejection_and_exact_project(self):
        for anonymous in (401, 403):
            with self.subTest(anonymous=anonymous):
                result = self.execute(
                    [
                        {"status": anonymous},
                        {"status": 200, "body": '{"data":[{"id":"fixture"}]}'},
                    ]
                )
                self.assertEqual(result["exitCode"], 0)
                self.assertEqual(
                    json.loads(result["output"][0]),
                    {
                        "status": "VERIFIED",
                        "anonymousRejected": True,
                        "projectMatched": True,
                    },
                )
                self.assertEqual(len(result["calls"]), 2)
                for call in result["calls"]:
                    self.assertEqual(
                        {k: v for k, v in call.items() if k != "headers"},
                        {
                            "hostname": "172.20.0.2",
                            "port": 3000,
                            "path": "/api/public/projects",
                            "method": "GET",
                        },
                    )
                self.assertEqual(result["calls"][0]["headers"], {})
                encoded = base64.b64encode(":".join(CREDENTIALS.values()).encode()).decode()
                self.assertEqual(
                    result["calls"][1]["headers"], {"Authorization": "Basic " + encoded}
                )

    def test_anonymous_success_or_redirect_never_sends_credentials(self):
        for status in (200, 301, 302, 307, 308, 500):
            with self.subTest(status=status):
                result = self.execute([{"status": status}])
                self.assertEqual(result["exitCode"], 1)
                self.assertEqual(len(result["calls"]), 1)
                self.assertEqual(result["calls"][0]["headers"], {})
                self.assertEqual(result["output"], ['{"status":"BLOCKED"}'])

    def test_authentication_redirect_bad_json_wrong_project_and_large_response_fail(self):
        for response in (
            {"status": 401},
            {"status": 403},
            {"status": 302},
            {"status": 500},
            {"status": 200, "body": "private invalid json"},
            {"status": 200, "body": "null"},
            {"status": 200, "body": '{"data":[]}'},
            {"status": 200, "body": '{"data":[{"id":"foreign"}]}'},
            {"status": 200, "body": '{"data":[{"id":"fixture"},{"id":"foreign"}]}'},
            {"status": 200, "body": "x" * 16385},
            {"error": True},
            {"status": 200, "aborted": True},
        ):
            with self.subTest(status=response.get("status"), keys=list(response)):
                result = self.execute([{"status": 401}, response])
                self.assertEqual(result["exitCode"], 1)
                self.assertEqual(result["output"], ['{"status":"BLOCKED"}'])
                self.assertEqual(len(result["calls"]), 2)


class LangfuseOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.item = {
            "Id": "c" * 64,
            "Image": "sha256:" + "d" * 64,
            "RestartCount": 0,
            "State": {"Running": True, "StartedAt": "initial"},
            "NetworkSettings": {
                "Networks": {
                    "fixture_default": {
                        "IPAddress": "172.20.0.2",
                        "NetworkID": "e" * 64,
                    }
                }
            },
            "Config": {
                "Env": ["LANGFUSE_INIT_PROJECT_ID=fixture"],
                "Labels": {
                    "com.docker.compose.project": "fixture",
                    "com.docker.compose.service": "langfuse-web",
                },
            },
        }
        self.reply = {"status": "VERIFIED", "anonymousRejected": True, "projectMatched": True}
        self.calls = []
        self.after_exec = None
        self.enterContext(
            patch.object(
                auth.snapshot.storage, "inspect", side_effect=lambda _: copy.deepcopy(self.item)
            )
        )
        self.enterContext(patch.object(auth.snapshot.storage, "run", side_effect=self.run_command))

    def run_command(self, args, *, data=None, timeout=180):
        self.calls.append((args, data, timeout))
        if args[1] == "ps":
            return (self.item["Id"] + "\n").encode()
        self.assertEqual(args[:4], ["docker", "exec", "-i", self.item["Id"]])
        if self.after_exec:
            self.after_exec()
        return json.dumps(self.reply).encode()

    def test_credentials_use_stdin_only_and_report_does_not_certify_kubernetes_route(self):
        result = auth.verify("fixture", CREDENTIALS)
        self.assertEqual(result["status"], "VERIFIED")
        self.assertFalse(result["kubernetesRouteVerified"])
        self.assertEqual(result["modelApiCalls"], 0)
        command, payload, timeout = next(c for c in self.calls if c[0][1] == "exec")
        self.assertEqual(json.loads(payload)["secretKey"], CREDENTIALS["LANGFUSE_SECRET_KEY"])
        self.assertEqual(command[-3:-1], ["node", "-e"])
        self.assertEqual(timeout, 15)
        for value in CREDENTIALS.values():
            self.assertNotIn(value, json.dumps(command) + json.dumps(result))

    def test_wrong_container_or_missing_source_project_blocks_before_exec(self):
        original = copy.deepcopy(self.item)
        for defect in (
            "project",
            "service",
            "oneoff",
            "stopped",
            "paused",
            "project_id",
            "duplicate",
        ):
            self.item = copy.deepcopy(original)
            self.calls.clear()
            if defect in ("project", "service", "oneoff"):
                self.item["Config"]["Labels"]["com.docker.compose." + defect] = "foreign"
            elif defect == "stopped":
                self.item["State"]["Running"] = False
            elif defect == "paused":
                self.item["State"]["Paused"] = True
            elif defect == "project_id":
                self.item["Config"]["Env"] = []
            else:
                self.item["Config"]["Env"] *= 2
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                auth.verify("fixture", CREDENTIALS)
            self.assertFalse(any(c[0][1] == "exec" for c in self.calls))

    def test_restart_or_changed_project_during_request_cannot_pass(self):
        for key in ("StartedAt", "Running"):
            self.item["State"] = {"Running": True, "StartedAt": "initial"}
            self.after_exec = lambda key=key: self.item["State"].update({key: "changed"})
            with self.subTest(key=key), self.assertRaises(ValueError):
                auth.verify("fixture", CREDENTIALS)

    def test_unexpected_reply_or_header_injection_cannot_pass(self):
        for reply in ({"status": "BLOCKED"}, {**self.reply, "private": "text"}):
            self.reply = reply
            with self.subTest(reply=reply), self.assertRaises(ValueError):
                auth.verify("fixture", CREDENTIALS)
        self.calls.clear()
        for value in ("", "x" * 5000, "pk-lf-" + "x" * 20 + ":", "x" * 20 + "\r\n"):
            with self.subTest(length=len(value)), self.assertRaises(ValueError):
                auth.verify("fixture", {**CREDENTIALS, "LANGFUSE_PUBLIC_KEY": value})
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
