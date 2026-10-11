"""Exercise build gates, retired rollout rejection and workflow/IAM wiring offline."""

import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import yaml

ROOT = Path(__file__).resolve().parents[3]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "infrastructure/eks" / filename
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load("eks_release", "release.py")
deploy = load("eks_deploy", "deploy.py")
SHA = "a" * 40
ENV = {
    "GITHUB_REPOSITORY": release.SOURCE,
    "GOVBIZ_RELEASE_BRANCH": "main",
    "EKS_RELEASE_ENABLED": "true",
    "AWS_ACCOUNT_ID": "123456789012",
    "AWS_REGION": "ap-southeast-2",
    "EKS_CLUSTER_NAME": "govbiz-eks",
    "KUBECONFIG": "/tmp/test-kube",
}


def receipt():
    return {
        "schema": 1,
        "repository": release.SOURCE,
        "sourceSha": SHA,
        "account": ENV["AWS_ACCOUNT_ID"],
        "region": ENV["AWS_REGION"],
        "cluster": ENV["EKS_CLUSTER_NAME"],
        "images": {
            name: f"123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/govbiz-demo/{name}@sha256:"
            + "b" * 64
            for name in release.COMPONENTS
        },
    }


class EksReleaseTests(unittest.TestCase):
    def test_only_explicitly_enabled_selected_main_can_release(self):
        self.assertEqual(release.SOURCE, "ilil1/SKN34-4th-1Team")
        self.assertEqual(deploy.SOURCE, release.SOURCE)
        with patch.dict(os.environ, ENV):
            self.assertEqual(release.authority().repository, release.SOURCE)
        for change in (
            {"GITHUB_REPOSITORY": "SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team"},
            {"GITHUB_REPOSITORY": "someone/SKN34-4th-1Team"},
            {"GOVBIZ_RELEASE_BRANCH": "skn-451"},
            {"EKS_RELEASE_ENABLED": "false"},
        ):
            with (
                patch.dict(os.environ, {**ENV, **change}),
                self.assertRaises(ValueError),
            ):
                release.authority()

    def test_required_ci_gate_and_current_head_are_both_checked(self):
        get = Mock(return_value={"object": {"sha": SHA}})
        with (
            patch.dict(os.environ, ENV),
            patch.object(release.gate, "ci_blocked_reason", return_value=None) as ci,
        ):
            release.check(SHA, get)
            self.assertEqual(ci.call_args.args[0], SHA)
            self.assertEqual(get.call_count, 2)
        with (
            patch.dict(os.environ, ENV),
            patch.object(
                release.gate,
                "ci_blocked_reason",
                return_value="ci_jobs_not_successful_or_incomplete:ci.yml",
            ),
            self.assertRaisesRegex(ValueError, "Required CI"),
        ):
            release.check(SHA, get)

    def test_head_change_during_ci_blocks_release(self):
        get = Mock(
            side_effect=[{"object": {"sha": SHA}}, {"object": {"sha": "d" * 40}}]
        )
        with (
            patch.dict(os.environ, ENV),
            patch.object(release.gate, "ci_blocked_reason", return_value=None),
            self.assertRaisesRegex(ValueError, "changed during"),
        ):
            release.check(SHA, get)

    def test_unready_ci_never_authenticates_or_builds(self):
        with (
            patch.object(release, "check", side_effect=ValueError("CI pending")),
            patch.object(release, "settings") as settings,
        ):
            with self.assertRaisesRegex(ValueError, "CI pending"):
                release.publish(SHA, Path("never-created"))
            settings.assert_not_called()

    def test_ecr_lookup_distinguishes_missing_image_from_lookup_failure(self):
        for response, expected in (
            (
                {"images": [{"imageId": {"imageDigest": "sha256:" + "b" * 64}}]},
                "sha256:" + "b" * 64,
            ),
            ({"failures": [{"failureCode": "ImageNotFound"}]}, None),
        ):
            with patch.object(release, "aws", return_value=response):
                self.assertEqual(
                    release.digest("govbiz-demo/core-service", "git-" + SHA), expected
                )
        for response in (
            {},
            {"failures": [{"failureCode": "AccessDenied"}]},
            {"images": [{"imageId": {"imageDigest": "latest"}}]},
        ):
            with (
                patch.object(release, "aws", return_value=response),
                self.assertRaises(ValueError),
            ):
                release.digest("govbiz-demo/core-service", "git-" + SHA)

    def test_legacy_rollout_is_disabled_before_any_cluster_or_ci_access(self):
        with patch.object(release, "check") as check, patch.object(release, "run") as run:
            with self.assertRaisesRegex(ValueError, "Direct rollout is disabled"):
                release.rollout(SHA, Path("unused"))
            with self.assertRaisesRegex(ValueError, "Direct EKS deployment is disabled"):
                deploy.deploy(receipt())
            check.assert_not_called()
            run.assert_not_called()

    def test_receipt_rejects_other_account_registry_tag_and_missing_runner(self):
        deploy.validate(receipt(), ENV)
        for mutate in (
            lambda r: r.update(account="999999999999"),
            lambda r: r.update(repository="someone/else"),
            lambda r: r.update(repository="SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team"),
            lambda r: r["images"].update({"core-service": "docker.io/app:latest"}),
            lambda r: r["images"].pop("evaluation-runner"),
            lambda r: r.update(sourceSha="main"),
        ):
            record = receipt()
            mutate(record)
            with self.assertRaises(ValueError):
                deploy.validate(record, ENV)

    def test_archive_uses_only_tracked_selected_inputs(self):
        with tempfile.TemporaryDirectory() as temp:
            root, output = Path(temp) / "repo", Path(temp) / "archive"
            root.mkdir()
            output.mkdir()
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / "web").mkdir()
            (root / "web/index.txt").write_text("tracked")
            (root / "private.txt").write_text("not selected")
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(root),
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.com",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-qm",
                    "fixture",
                ],
                check=True,
            )
            sha = subprocess.check_output(
                ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
            ).strip()
            (root / "web/.env").write_text("UNTRACKED_SECRET")
            with patch.object(release, "ROOT", root):
                release.archive(sha, ("web",), output)
            self.assertEqual((output / "web/index.txt").read_text(), "tracked")
            self.assertFalse((output / "web/.env").exists())
            self.assertFalse((output / "private.txt").exists())

    def test_workflow_requires_all_ci_serializes_and_waits_before_web_promotion(self):
        w = yaml.load(
            (ROOT / ".github/workflows/eks-release.yml").read_text(),
            Loader=yaml.BaseLoader,
        )
        self.assertEqual(set(w["on"]), {"workflow_run", "workflow_dispatch"})
        self.assertEqual(len(w["on"]["workflow_run"]["workflows"]), 5)
        self.assertEqual(w["concurrency"]["cancel-in-progress"], "false")
        self.assertIn(
            "github.repository == 'ilil1/SKN34-4th-1Team'", w["jobs"]["gate"]["if"]
        )
        self.assertNotIn("id-token", w["permissions"])
        backend = w["jobs"]["backend"]
        self.assertNotIn("id-token", backend["permissions"])
        self.assertEqual(backend["environment"], "eks-production")
        self.assertEqual(backend["needs"], "gate")
        self.assertEqual(backend["if"], "needs.gate.outputs.ready == 'true'")
        self.assertEqual(
            backend["runs-on"],
            "codebuild-${{ vars.EKS_DEPLOY_PROJECT }}-${{ github.run_id }}-${{ github.run_attempt }}",
        )
        commands = "\n".join(step.get("run", "") for step in backend["steps"])
        self.assertNotIn("release.py rollout", commands)
        self.assertIn("gitops.py publish", commands)
        self.assertIn("gitops.py wait", commands)
        self.assertLess(commands.index("gitops.py preflight"), commands.index("release.py publish"))
        self.assertLess(commands.index("gitops.py publish"), commands.index("gitops.py wait"))
        self.assertEqual(backend["permissions"]["contents"], "write")
        self.assertNotIn("release.py dispatch", commands)
        self.assertFalse(
            any(
                "configure-aws-credentials" in step.get("uses", "")
                for step in backend["steps"]
            )
        )
        web = w["jobs"]["web"]
        self.assertIn("backend", web["needs"])
        steps = "\n".join(s.get("run", "") for s in web["steps"])
        self.assertIn("--prod --skip-domain", steps)
        self.assertNotIn("vercel promote", steps)
        self.assertLess(
            steps.index("vercel deploy"), steps.index("release.py web-promote")
        )
        self.assertIn('--deployment-url-file "$RUNNER_TEMP/vercel-url.txt"', steps)
        self.assertTrue(
            any(
                step.get("with", {}).get("name") == "vercel-release"
                for step in web["steps"]
            )
        )
        for job in w["jobs"].values():
            self.assertNotIn("continue-on-error", job)
            for step in job["steps"]:
                self.assertNotIn("continue-on-error", step)
                if "uses" in step:
                    self.assertRegex(step["uses"], r"@[a-f0-9]{40}$")
        config = json.loads((ROOT / "frontend/web/vercel.json").read_text())
        self.assertIs(config["git"]["deploymentEnabled"]["main"], False)

    def test_stack_uses_connection_runner_and_scoped_service_role_without_oidc(self):
        stack = yaml.load(
            (ROOT / "infrastructure/eks/release-stack.yaml").read_text(),
            Loader=yaml.BaseLoader,
        )
        resources = stack["Resources"]
        self.assertNotIn("GitHubReleaseRole", resources)
        self.assertNotIn("ReleaseBucket", resources)
        self.assertNotIn("GitHubOidcProviderArn", stack["Parameters"])
        self.assertEqual(stack["Parameters"]["EnableWebhook"]["Default"], "false")
        project = resources["DeployProject"]["Properties"]
        self.assertEqual(project["ConcurrentBuildLimit"], "1")
        self.assertEqual(project["Environment"]["PrivilegedMode"], "true")
        self.assertIn("VpcConfig", project)
        self.assertEqual(project["Source"]["Type"], "GITHUB")
        self.assertEqual(
            project["Source"]["Location"], f"https://github.com/{release.SOURCE}.git"
        )
        self.assertEqual(project["Source"]["Auth"]["Type"], "CODECONNECTIONS")
        self.assertEqual(project["SourceVersion"], "refs/heads/main")
        self.assertIn("exit 1", project["Source"]["BuildSpec"])
        conditional = project["Triggers"]["FilterGroups"]
        self.assertEqual(conditional[0], "WebhookEnabled")
        self.assertEqual(conditional[2], "AWS::NoValue")
        filters = conditional[1]
        self.assertEqual(
            len(filters), 1
        )  # Conditions are ANDed, never separate OR groups.
        self.assertEqual(
            {f["Type"]: f["Pattern"] for f in filters[0]},
            {
                "EVENT": "WORKFLOW_JOB_QUEUED",
                "WORKFLOW_NAME": "^EKS and Vercel release$",
                "ACTOR_ACCOUNT_ID": "^${GitHubActorId}$",
            },
        )
        role = resources["DeployRole"]["Properties"]
        trust = role["AssumeRolePolicyDocument"]["Statement"][0]
        self.assertEqual(trust["Principal"], {"Service": "codebuild.amazonaws.com"})
        self.assertIn("aws:SourceArn", trust["Condition"]["ArnEquals"])
        statements = role["Policies"][0]["PolicyDocument"]["Statement"]
        publish = next(r for r in statements if "ecr:PutImage" in r["Action"])
        self.assertEqual(len(publish["Resource"]), 5)
        connection = next(
            r for r in statements if "codeconnections:GetConnectionToken" in r["Action"]
        )
        self.assertEqual(connection["Resource"], "GitHubConnectionArn")
        self.assertFalse(
            any(
                "iam:*" in r["Action"] or "sts:AssumeRoleWithWebIdentity" in r["Action"]
                for r in statements
            )
        )
        self.assertEqual(
            resources["DeployAccess"]["Properties"]["KubernetesGroups"],
            ["govbiz-eks-release"],
        )
        for r in yaml.safe_load_all(
            (ROOT / "infrastructure/eks/release-rbac.yaml").read_text()
        ):
            self.assertNotIn(r["kind"], {"ClusterRole", "ClusterRoleBinding"})
            for rule in r.get("rules", []):
                self.assertFalse(
                    {"secrets", "persistentvolumeclaims", "statefulsets"}
                    & set(rule["resources"])
                )
                self.assertEqual(rule["verbs"], ["get"])


class VercelPromotionTests(unittest.TestCase):
    url = "https://govbiz-test-team.vercel.app"

    def setUp(self):
        self.project = {"id": "prj_Test", "accountId": "team_Test"}
        self.deployment = {
            "id": "dpl_Test",
            "projectId": "prj_Test",
            "url": "govbiz-test-team.vercel.app",
            "meta": {"githubCommitSha": SHA},
            "readyState": "READY",
            "target": "production",
        }
        for patcher in (
            patch.dict(
                os.environ,
                {
                    "VERCEL_ORG_ID": "team_Test",
                    "VERCEL_PROJECT_ID": "prj_Test",
                    "VERCEL_TOKEN": "test-token",
                },
            ),
            patch.object(release.time, "sleep"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        checker = patch.object(release, "check")
        self.check = checker.start()
        self.addCleanup(checker.stop)

    def promoted(self, status="succeeded"):
        return {
            **self.project,
            "lastAliasRequest": {"toDeploymentId": "dpl_Test", "jobStatus": status},
            "targets": {"production": {"id": "dpl_Test"}},
        }

    def test_team_scoped_api_and_actual_domain_completion_without_user_lookup(self):
        responses = [
            self.deployment,
            self.project,
            {},
            self.promoted("pending"),
            self.promoted(),
        ]
        with patch.object(release, "vercel_api", side_effect=responses) as api:
            record = release.promote_web(SHA, self.url)
        self.assertEqual(record["sourceSha"], SHA)
        self.assertEqual(record["deploymentId"], "dpl_Test")
        self.assertEqual(self.check.call_count, 3)
        self.assertEqual(
            api.call_args_list[2].args,
            (
                "/v10/projects/prj_Test/promote/dpl_Test",
                "team_Test",
                "test-token",
                "POST",
            ),
        )
        self.assertTrue(all("user" not in call.args[0] for call in api.call_args_list))
        self.assertTrue(all(call.args[1] == "team_Test" for call in api.call_args_list))

    def test_project_status_requires_rollback_info_query_at_http_boundary(self):
        requested = False

        def respond(request, **kwargs):
            nonlocal requested
            url = urlsplit(request.full_url)
            query = parse_qs(url.query)
            self.assertEqual(query.get("teamId"), ["team_Test"])
            if url.path == "/v13/deployments/govbiz-test-team.vercel.app":
                payload = self.deployment
            elif url.path == "/v10/projects/prj_Test/promote/dpl_Test":
                self.assertEqual(request.get_method(), "POST")
                requested = True
                payload = {}
            elif url.path == "/v9/projects/prj_Test":
                # The real project API hides alias job details by default.
                payload = (
                    self.promoted()
                    if requested and query.get("rollbackInfo") == ["true"]
                    else self.project
                )
            else:
                self.fail("Unexpected Vercel endpoint: " + url.path)
            return io.BytesIO(json.dumps(payload).encode())

        with (
            patch.object(release, "urlopen", side_effect=respond),
            patch.object(release.time, "monotonic", side_effect=[0, 0, 181]),
        ):
            record = release.promote_web(SHA, self.url)
        self.assertTrue(requested)
        self.assertEqual(record["deploymentId"], "dpl_Test")
        self.assertEqual(self.check.call_count, 3)

    def test_unready_preview_wrong_project_sha_and_url_never_promote(self):
        for change in (
            {"readyState": "BUILDING"},
            {"target": "preview"},
            {"projectId": "prj_Other"},
            {"meta": {"githubCommitSha": "b" * 40}},
            {"url": "other.vercel.app"},
            {"id": "bad/id"},
        ):
            with (
                self.subTest(change=change),
                patch.object(
                    release,
                    "vercel_api",
                    side_effect=[{**self.deployment, **change}, self.project],
                ) as api,
            ):
                with self.assertRaises(ValueError):
                    release.promote_web(SHA, self.url)
                self.assertFalse(
                    any(len(call.args) == 4 for call in api.call_args_list)
                )

    def test_wrong_team_and_changed_main_reject_before_post(self):
        with patch.object(
            release,
            "vercel_api",
            side_effect=[self.deployment, {**self.project, "accountId": "team_Other"}],
        ) as api:
            with self.assertRaisesRegex(ValueError, "configured team"):
                release.promote_web(SHA, self.url)
            self.assertEqual(api.call_count, 2)
        self.check.side_effect = [None, ValueError("Source superseded")]
        with patch.object(
            release, "vercel_api", side_effect=[self.deployment, self.project]
        ) as api:
            with self.assertRaisesRegex(ValueError, "superseded"):
                release.promote_web(SHA, self.url)
            self.assertEqual(api.call_count, 2)

    def test_failed_or_skipped_alias_job_is_not_success(self):
        for status in ("failed", "skipped"):
            with (
                self.subTest(status=status),
                patch.object(
                    release,
                    "vercel_api",
                    side_effect=[
                        self.deployment,
                        self.project,
                        {},
                        self.promoted(status),
                    ],
                ),
                self.assertRaisesRegex(ValueError, "promotion failed"),
            ):
                release.promote_web(SHA, self.url)

    def test_accepted_request_and_different_production_id_are_not_completion(self):
        incomplete = self.promoted()
        incomplete["targets"]["production"]["id"] = "dpl_Other"
        for last in (self.project, incomplete):
            with (
                self.subTest(last=last),
                patch.object(
                    release,
                    "vercel_api",
                    side_effect=[self.deployment, self.project, {}, last],
                ),
                patch.object(release.time, "monotonic", side_effect=[0, 0, 181]),
                self.assertRaisesRegex(ValueError, "did not complete"),
            ):
                release.promote_web(SHA, self.url)

    def test_invalid_output_or_missing_credentials_never_call_external_api(self):
        with patch.object(release, "vercel_api") as api:
            for url in (
                "http://govbiz-test.vercel.app",
                "https://evil.example",
                self.url + "?token=x",
                self.url + "\n" + self.url,
            ):
                with self.subTest(url=url), self.assertRaises(ValueError):
                    release.promote_web(SHA, url)
            with (
                patch.dict(os.environ, {"VERCEL_TOKEN": ""}),
                self.assertRaises(ValueError),
            ):
                release.promote_web(SHA, self.url)
            api.assert_not_called()
            self.check.assert_not_called()

    def test_http_client_scopes_every_request_and_keeps_token_out_of_error(self):
        with patch.object(
            release, "urlopen", return_value=io.BytesIO(b"{}")
        ) as open_url:
            release.vercel_api("/v9/projects/prj_Test", "team_Test", "secret")
        request = open_url.call_args.args[0]
        self.assertEqual(
            request.full_url,
            "https://api.vercel.com/v9/projects/prj_Test?teamId=team_Test",
        )
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")
        error = HTTPError(
            "https://api.vercel.com", 403, "secret", {}, io.BytesIO(b"secret")
        )
        with (
            patch.object(release, "urlopen", side_effect=error),
            self.assertRaises(ValueError) as raised,
        ):
            release.vercel_api(
                "/v10/projects/prj_Test/promote/dpl_Test", "team_Test", "secret", "POST"
            )
        self.assertEqual(str(raised.exception), "Vercel POST request failed (HTTP 403)")


if __name__ == "__main__":
    unittest.main()
