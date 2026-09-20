import contextlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import deploy_host as host
import release
import ssm_document

REGISTRY = '123456789012.dkr.ecr.ap-southeast-2.amazonaws.com'
SHA = 'a' * 40


def images(digit):
    return {service: REGISTRY + '/govbiz/' + service + '@sha256:' + digit * 64 for service in host.KEYS}


def env_text(digit):
    refs = images(digit)
    return '# keep this comment\nCORE_API_IMAGE=' + refs['core-service'] + '\nAI_SERVICE_IMAGE=' + refs['ai-service'] + '\nSMTP_PASSWORD=not-a-real-secret\nBIZINFO_SYNC_ENABLED=false\n'


class HostDeploymentTest(unittest.TestCase):
    def test_changes_only_two_image_assignments(self):
        original = env_text('1')
        self.assertEqual(env_text('2'), host.replace_images(original, images('2')))

    def test_quoted_existing_images_are_supported(self):
        original = env_text('1').replace('CORE_API_IMAGE=', 'CORE_API_IMAGE="').replace('\nAI_SERVICE_IMAGE=', '"\nAI_SERVICE_IMAGE=')
        self.assertEqual(env_text('2'), host.replace_images(original, images('2')))

    def test_rejects_duplicate_or_missing_assignments(self):
        for text in ('SMTP_PASSWORD=secret\n', env_text('1') + 'CORE_API_IMAGE=x\n'):
            with self.assertRaises(ValueError):
                host.replace_images(text, images('2'))

    def test_rejects_foreign_repository_mutable_tag_and_injection(self):
        for value in (images('2')['core-service'].replace('123456789012', '999999999999'),
                      images('2')['core-service'].replace('/core-service@', '/core-api@'),
                      images('2')['ai-service'], REGISTRY + '/govbiz/core-service:latest',
                      images('2')['core-service'] + '\nACCOUNT_DEV_LOGIN_ENABLED=true'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                host.replace_images(env_text('1'), dict(images('2'), **{'core-service': value}))

    def test_existing_registry_must_match(self):
        original = env_text('1').replace('AI_SERVICE_IMAGE=123456789012', 'AI_SERVICE_IMAGE=999999999999')
        with self.assertRaises(ValueError):
            host.replace_images(original, images('2'))

    def test_atomic_write_is_private(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'env'
            host.atomic_write(path, b'not-a-secret')
            self.assertEqual(0o600, path.stat().st_mode & 0o777)
            self.assertEqual(b'not-a-secret', path.read_bytes())
            self.assertEqual([path], list(Path(folder).iterdir()))

    def apply_scenario(self, effects):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        root = Path(folder.name)
        target = root / 'env'
        target.write_bytes(env_text('1').encode())
        original_stat = target.stat()
        with patch.object(host, 'ENV_FILE', target), patch.object(host, 'restore_or_start', side_effect=effects) as start:
            if effects and isinstance(effects[0], Exception):
                with self.assertRaises(RuntimeError):
                    host.apply_release(env_text('1').encode(), env_text('2').encode(), original_stat, root)
            else:
                host.apply_release(env_text('1').encode(), env_text('2').encode(), original_stat, root)
        return target.read_bytes(), (root / 'result').read_bytes(), (root / 'environment.before').read_bytes(), start.call_count

    def test_success_keeps_backup_and_new_image_env(self):
        actual, receipt, backup, calls = self.apply_scenario([None])
        self.assertEqual(env_text('2').encode(), actual)
        self.assertEqual(env_text('1').encode(), backup)
        self.assertEqual(b'SUCCESS\n', receipt)
        self.assertEqual(1, calls)

    def test_failure_restores_previous_env_and_reports_not_database_rollback(self):
        actual, receipt, _, calls = self.apply_scenario([RuntimeError('unhealthy'), None])
        self.assertEqual(env_text('1').encode(), actual)
        self.assertIn(b'DATABASE_NOT_ROLLED_BACK', receipt)
        self.assertEqual(2, calls)

    def test_failed_recovery_does_not_claim_success(self):
        actual, receipt, _, calls = self.apply_scenario([RuntimeError('unhealthy'), RuntimeError('old unhealthy')])
        self.assertEqual(env_text('1').encode(), actual)
        self.assertIn(b'RESTORE_FAILED', receipt)
        self.assertEqual(2, calls)

    def test_only_application_services_are_recreated_without_dependencies(self):
        with patch.object(host, 'compose') as compose, patch.object(host, 'invoke'), \
                patch.object(host, 'container_id', return_value='nginx-id'), patch.object(host, 'health'):
            host.restore_or_start()
        self.assertEqual(['ai-service', 'core-service'], [call.args[-1] for call in compose.call_args_list])
        for call in compose.call_args_list:
            self.assertIn('--no-deps', call.args)
            self.assertIn('--wait', call.args)
            self.assertNotIn('down', call.args)

    def test_subprocess_stderr_is_not_exposed(self):
        result = subprocess.CompletedProcess([], 1, stdout='', stderr='secret-password')
        with patch.object(host.subprocess, 'run', return_value=result), self.assertRaises(RuntimeError) as caught:
            host.invoke(['docker', 'compose', 'config'])
        self.assertNotIn('secret-password', str(caught.exception))


class CodeBuildReleaseTest(unittest.TestCase):
    def test_disabled_mode_does_not_access_aws_or_deploy(self):
        with patch.object(release, 'commit_id', return_value=SHA), patch.dict(os.environ, GOVBIZ_DEPLOY_ENABLED='false'), \
                patch.object(release, 'aws') as aws, contextlib.redirect_stdout(io.StringIO()):
            release.main()
        aws.assert_not_called()

    def test_old_queued_build_does_not_publish_or_deploy(self):
        with patch.object(release, 'commit_id', return_value=SHA), patch.dict(os.environ, GOVBIZ_DEPLOY_ENABLED='true'), \
                patch.object(release, 'is_current_main', return_value=False), patch.object(release, 'aws') as aws, \
                contextlib.redirect_stdout(io.StringIO()):
            release.main()
        aws.assert_not_called()

    def test_rechecks_main_after_publishing(self):
        with patch.object(release, 'commit_id', return_value=SHA), patch.dict(os.environ, GOVBIZ_DEPLOY_ENABLED='true', AWS_REGION='ap-southeast-2'), \
                patch.object(release, 'is_current_main', side_effect=[True, False]), \
                patch.object(release, 'aws', return_value={'Account': '123456789012'}) as aws, \
                patch.object(release, 'run', return_value=subprocess.CompletedProcess([], 0, stdout='token')), \
                patch.object(release.subprocess, 'run'), patch.object(release, 'publish'), contextlib.redirect_stdout(io.StringIO()):
            release.main()
        self.assertEqual([('sts', 'get-caller-identity')], [call.args for call in aws.call_args_list])

    def test_image_lookup_failure_is_not_treated_as_missing(self):
        with patch.object(release, 'aws', return_value={'failures': [{'failureCode': 'AccessDenied'}]}):
            with self.assertRaises(RuntimeError):
                release.image_digest('govbiz/core-service', 'git-' + SHA)

    def test_missing_image_is_buildable(self):
        with patch.object(release, 'aws', return_value={'failures': [{'failureCode': 'ImageNotFound'}]}):
            self.assertIsNone(release.image_digest('govbiz/core-service', 'git-' + SHA))

    def test_publish_uses_current_source_folders_and_service_ecr_names(self):
        root = Path(__file__).resolve().parents[2]
        for service, context in [('core-service', 'backend/core-service'), ('ai-service', 'backend/ai-service')]:
            with self.subTest(service=service):
                digest = 'sha256:' + '1' * 64
                ref = REGISTRY + '/govbiz/' + service + ':git-' + SHA
                self.assertTrue((root / context / 'Dockerfile').is_file())
                with patch.object(release, 'image_digest', side_effect=[None, digest]) as lookup, \
                        patch.object(release, 'run') as run:
                    actual = release.publish(REGISTRY, service, SHA)
                self.assertEqual(REGISTRY + '/govbiz/' + service + '@' + digest, actual)
                self.assertEqual([
                    ('docker', 'build', '--platform', 'linux/amd64', '--label',
                     'org.opencontainers.image.revision=' + SHA, '--tag', ref, context),
                    ('docker', 'push', ref),
                ], [call.args for call in run.call_args_list])
                self.assertEqual([('govbiz/' + service, 'git-' + SHA)] * 2,
                                 [call.args for call in lookup.call_args_list])

    def test_existing_immutable_image_is_reused_without_build_or_push(self):
        digest = 'sha256:' + '2' * 64
        with patch.object(release, 'image_digest', return_value=digest), patch.object(release, 'run') as run:
            actual = release.publish(REGISTRY, 'core-service', SHA)
        self.assertEqual(REGISTRY + '/govbiz/core-service@' + digest, actual)
        run.assert_not_called()

    def test_failed_ssm_is_not_reported_successfully(self):
        with patch.object(release, 'aws', return_value={'Status': 'Failed', 'StandardOutputContent': 'secret'}), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError) as caught:
            release.wait_command('command-id', 'instance-id')
        self.assertNotIn('secret', str(caught.exception))

    def test_ssm_success_requires_deployment_marker(self):
        with patch.object(release, 'aws', return_value={'Status': 'Success', 'StandardOutputContent': 'nothing'}), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
            release.wait_command('command-id', 'instance-id')


class DocumentTest(unittest.TestCase):
    def test_parameters_use_environment_interpolation_and_deny_injection(self):
        doc = ssm_document.document()
        for parameter in doc['parameters'].values():
            self.assertEqual('ENV_VAR', parameter['interpolationType'])
        self.assertEqual('check', doc['parameters']['Mode']['default'])
        for key, service in [('CoreImage', 'core-service'), ('AiImage', 'ai-service')]:
            pattern = doc['parameters'][key]['allowedPattern']
            self.assertIsNotNone(re.fullmatch(pattern, images('2')[service]))
            self.assertIsNone(re.fullmatch(pattern, images('2')[service] + ';id'))
        self.assertLess(len(json.dumps(doc)), 64 * 1024)

    def test_script_is_reviewed_content_not_raw_parameter_substitution(self):
        command = ssm_document.document()['mainSteps'][0]['inputs']['runCommand'][0]
        self.assertIn(Path(host.__file__).read_text(), command)
        self.assertNotIn('{{', command.replace('{{json .State}}', '').replace('{{.Config.Image}}', ''))

    def test_tests_precede_release_in_fail_fast_build_phase(self):
        spec = Path(__file__).with_name('backend.yml').read_text()
        self.assertIn('on-failure: ABORT', spec)
        self.assertLess(spec.index('verify-backend.sh'), spec.index('release.py'))
        self.assertNotIn('post_build:', spec)


if __name__ == '__main__':
    unittest.main()
