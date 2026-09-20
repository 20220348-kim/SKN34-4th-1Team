import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("seed_application_forms", Path(__file__).with_name("seed-application-forms.py"))
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)


class ApplicationFormSeedTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = Path(self.temp.name) / "deployment.env"
        env.write_text("", encoding="utf-8")
        self.args = argparse.Namespace(env_file=env, compose_file=env, apply=False,
                                       backup_confirmed=False, expected_jdbc_url=None)
        self.calls = []
        self.jdbc = "jdbc:mysql://example:3306/govbiz?sslMode=VERIFY_IDENTITY"

    def invoke(self, command, **kwargs):
        self.calls.append(command)
        output = ""
        if "config" in command:
            output = json.dumps({"services": {"core-service": {"environment": {"SPRING_DATASOURCE_URL": self.jdbc}}}})
        return subprocess.CompletedProcess(command, 0, output, "")

    def apply_args(self):
        self.args.apply = self.args.backup_confirmed = True
        self.args.expected_jdbc_url = self.jdbc

    def test_default_runs_real_validator_only(self):
        with patch.object(seed.subprocess, "run", side_effect=self.invoke):
            self.assertEqual(seed.run(self.args), 0)
        self.assertEqual(len(self.calls), 1)
        self.assertIn("org.springframework.boot.loader.launch.PropertiesLauncher", self.calls[0])
        self.assertIn("--no-deps", self.calls[0])
        self.assertTrue(any(arg.endswith(":ro") for arg in self.calls[0]))
        self.assertNotIn("-jar", self.calls[0])

    def test_apply_disables_background_work_and_exits(self):
        self.apply_args()
        with patch.object(seed.subprocess, "run", side_effect=self.invoke):
            self.assertEqual(seed.run(self.args), 0)
        self.assertEqual(len(self.calls), 4)
        command = self.calls[-1]
        for key in seed.DISABLED_PROPERTIES:
            self.assertIn(f"--{key}=false", command)
        self.assertIn("--app.application-form-backfill.exit-after-run=true", command)
        self.assertIn("--spring.flyway.enabled=false", command)
        self.assertIn(f"--app.application-form-backfill.expected-jdbc-url={self.jdbc}", command)

    def test_mismatched_database_never_applies(self):
        self.apply_args()
        self.args.expected_jdbc_url += "-wrong"
        with patch.object(seed.subprocess, "run", side_effect=self.invoke), self.assertRaises(ValueError):
            seed.run(self.args)
        self.assertEqual(len(self.calls), 2)

    def test_backup_confirmation_required(self):
        self.args.apply = True
        with patch.object(seed.subprocess, "run", side_effect=self.invoke), self.assertRaises(ValueError):
            seed.run(self.args)
        self.assertEqual(len(self.calls), 1)

    def test_running_core_prevents_apply(self):
        self.apply_args()
        def invoke(command, **kwargs):
            result = self.invoke(command, **kwargs)
            if "ps" in command:
                result.stdout = "core-service\n"
            return result
        with patch.object(seed.subprocess, "run", side_effect=invoke), self.assertRaises(ValueError):
            seed.run(self.args)
        self.assertEqual(len(self.calls), 3)

    def test_validator_failure_prevents_apply(self):
        self.apply_args()
        with patch.object(seed.subprocess, "run", return_value=subprocess.CompletedProcess([], 7)) as run:
            self.assertEqual(seed.run(self.args), 7)
            self.assertEqual(run.call_count, 1)

    def test_apply_failure_is_returned(self):
        self.apply_args()
        def invoke(command, **kwargs):
            result = self.invoke(command, **kwargs)
            if "-jar" in command:
                result.returncode = 9
            return result
        with patch.object(seed.subprocess, "run", side_effect=invoke):
            self.assertEqual(seed.run(self.args), 9)

    def test_modified_seed_never_calls_docker(self):
        file = Path(self.temp.name) / "changed.json"
        file.write_text("{}", encoding="utf-8")
        with patch.object(seed, "SEED", file), patch.object(seed.subprocess, "run") as run, self.assertRaises(ValueError):
            seed.run(self.args)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
