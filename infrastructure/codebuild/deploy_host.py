#!/usr/bin/env python3
"""SSM document payload: image-only deployment on the existing private EC2 host.

No source checkout, Compose replacement, database/volume deletion, or secret output.
Database migrations are forward-only; restoring images is NOT a database rollback.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile

ROOT = Path('/opt/govbiz')
ENV_FILE = ROOT / '.env.production'
COMPOSE_FILE = ROOT / 'infrastructure/compose.prod.yaml'
KEYS = {'core-service': 'CORE_API_IMAGE', 'ai-service': 'AI_SERVICE_IMAGE'}
PRESERVED = ('nginx', 'elasticsearch', 'qdrant', 'redis', 'rabbitmq')
IMAGE = re.compile(r'([0-9]{12}\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com)/govbiz/(core-service|ai-service)@sha256:[0-9a-f]{64}')


def invoke(args, *, environment=None, input=None):
    result = subprocess.run(args, env=environment, input=input, capture_output=True, text=True)
    if result.returncode:
        # Compose errors may contain interpolated credentials. Keep raw stderr on neither log.
        raise RuntimeError('Command failed: ' + args[0] + '; raw output suppressed')
    return result.stdout


def image_values(text):
    values = {}
    for service, key in KEYS.items():
        matches = re.findall(r'^' + key + r'=(.*)$', text, re.MULTILINE)
        if len(matches) != 1:
            raise ValueError('Expected exactly one ' + key + ' assignment')
        value = matches[0].strip()
        if value[:1] in {'"', "'"} and value[-1:] == value[:1]:
            value = value[1:-1]
        match = IMAGE.fullmatch(value)
        if not match or match[3] != service:
            raise ValueError('Existing image must be an own-ECR digest for ' + service)
        values[service] = value
    return values


def replace_images(original, images):
    previous = image_values(original)
    registry = IMAGE.fullmatch(previous['core-service'])[1]
    if IMAGE.fullmatch(previous['ai-service'])[1] != registry:
        raise ValueError('Existing images use different registries')
    result = original
    for service, key in KEYS.items():
        match = IMAGE.fullmatch(images[service])
        if not match or match[1] != registry or match[3] != service:
            raise ValueError('New image does not match the existing ECR repository')
        result = re.sub(r'^' + key + r'=.*$', lambda _: key + '=' + images[service], result, flags=re.MULTILINE)
    return result


def atomic_write(path, data, original_stat=None):
    fd, name = tempfile.mkstemp(prefix='.govbiz-deploy-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), 0o600)
            if original_stat is not None:
                os.fchown(handle.fileno(), original_stat.st_uid, original_stat.st_gid)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def compose(*args, environment=None):
    return invoke(['docker', 'compose', '--project-name', 'govbiz-prod', '--env-file', str(ENV_FILE),
                   '--file', str(COMPOSE_FILE), *args], environment=environment)


def container_id(service):
    result = compose('ps', '--all', '--quiet', service).strip().splitlines()
    if len(result) != 1:
        raise RuntimeError('Expected one existing production container: ' + service)
    return result[0]


def health():
    for service in (*KEYS, *PRESERVED):
        state = json.loads(invoke(['docker', 'inspect', '--format', '{{json .State}}', container_id(service)]))
        if not state.get('Running') or (service != 'qdrant' and state.get('Health', {}).get('Status') != 'healthy'):
            raise RuntimeError('Production service is not healthy: ' + service)
    body = invoke(['docker', 'exec', container_id('core-service'), 'curl', '--fail', '--silent',
                   '--max-time', '10', 'http://127.0.0.1:8080/api/v1/health/ai-service'])
    if json.loads(body).get('status') != 'up':
        raise RuntimeError('Core-to-AI health check did not report up')


def restore_or_start():
    # Never restart stateful dependencies or run `down`. AI must be ready before Core.
    for service in ('ai-service', 'core-service'):
        compose('up', '--detach', '--no-deps', '--no-build', '--pull', 'never', '--wait',
                '--wait-timeout', '300', service)
    nginx = container_id('nginx')
    invoke(['docker', 'exec', nginx, 'nginx', '-t'])
    invoke(['docker', 'exec', nginx, 'nginx', '-s', 'reload'])
    health()


def apply_release(original, candidate, file_stat, receipt):
    atomic_write(receipt / 'environment.before', original, file_stat)
    atomic_write(ENV_FILE, candidate, file_stat)
    try:
        restore_or_start()
    except Exception:
        atomic_write(ENV_FILE, original, file_stat)
        try:
            restore_or_start()
        except Exception:
            atomic_write(receipt / 'result', b'FAILED_IMAGE_RESTORE_FAILED_DATABASE_NOT_ROLLED_BACK\n')
            raise RuntimeError('Deployment and previous-image recovery failed; operator action required') from None
        atomic_write(receipt / 'result', b'FAILED_PREVIOUS_IMAGES_RESTORED_DATABASE_NOT_ROLLED_BACK\n')
        raise RuntimeError('Deployment failed; previous images restored, database NOT rolled back') from None
    atomic_write(receipt / 'result', b'SUCCESS\n')


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run through the approved root SSM document')
    mode = os.environ.get('SSM_Mode', '')
    if mode not in {'check', 'deploy'}:
        raise ValueError('SSM ENV_VAR interpolation is required')
    with open('/var/lock/govbiz-backend-deploy.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        file_stat = ENV_FILE.lstat()
        if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_mode & 0o077:
            raise ValueError('Production env must be a regular mode-600 file')
        original = ENV_FILE.read_bytes()
        previous = image_values(original.decode())
        # No environment values are printed. Preserve the host's SMTP settings and fixed IP patch.
        config = json.loads(compose('config', '--format', 'json'))
        services = config['services']
        if set(services) != set(KEYS) | set(PRESERVED):
            raise ValueError('Unexpected production Compose services')
        if services['core-service']['networks']['proxy'].get('ipv4_address') != '172.30.254.3':
            raise ValueError('Existing Core proxy IP must be 172.30.254.3; do not replace host Compose')
        for service, image in previous.items():
            live = invoke(['docker', 'inspect', '--format', '{{.Config.Image}}', container_id(service)]).strip()
            if services[service]['image'] != image or live != image:
                raise ValueError('Runtime/image configuration drift: ' + service)
        health()
        if mode == 'check':
            print('GOVBIZ_BACKEND_PREFLIGHT_OK', flush=True)
            return
        sha = os.environ.get('SSM_Commit', '')
        if not re.fullmatch('[0-9a-f]{40}', sha):
            raise ValueError('Expected a full Git commit')
        images = {'core-service': os.environ.get('SSM_CoreImage', ''), 'ai-service': os.environ.get('SSM_AiImage', '')}
        candidate = replace_images(original.decode(), images).encode()
        if shutil.disk_usage('/var/lib/docker').free < 4 * 1024 ** 3:
            raise RuntimeError('Less than 4 GiB Docker disk headroom; nothing changed')
        preserved_ids = {service: container_id(service) for service in PRESERVED}
        registry, region, _ = IMAGE.fullmatch(images['core-service']).groups()
        # Isolate ECR credentials from the host's persistent Docker configuration.
        with tempfile.TemporaryDirectory(prefix='govbiz-ecr-') as auth_dir:
            environment = dict(os.environ, DOCKER_CONFIG=auth_dir)
            password = invoke(['aws', 'ecr', 'get-login-password', '--region', region])
            invoke(['docker', 'login', '--username', 'AWS', '--password-stdin', registry],
                   input=password, environment=environment)
            for image in images.values():
                invoke(['docker', 'pull', image], environment=environment)
                details = json.loads(invoke(['docker', 'image', 'inspect', image]))[0]
                if details['Architecture'] != 'amd64' or details['Os'] != 'linux' or (
                    details['Config'].get('Labels') or {}).get('org.opencontainers.image.revision') != sha:
                    raise ValueError('New image platform or commit label mismatch')
        releases = ROOT / 'deployments'
        releases.mkdir(mode=0o700, exist_ok=True)
        if releases.is_symlink() or releases.stat().st_uid != 0 or releases.stat().st_mode & 0o077:
            raise ValueError('Deployment receipts directory must be root-owned mode 700')
        receipt = Path(tempfile.mkdtemp(prefix=sha + '-', dir=releases))
        apply_release(original, candidate, file_stat, receipt)
        if any(container_id(service) != identifier for service, identifier in preserved_ids.items()):
            atomic_write(receipt / 'result', b'FAILED_PRESERVED_CONTAINER_CHANGED\n')
            raise RuntimeError('A preserved container changed unexpectedly; inspect production')
        print('GOVBIZ_BACKEND_DEPLOY_OK ' + sha, flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Validation messages are constant; do not serialize subprocess commands, env or tracebacks.
        reason = str(error) if type(error) in {RuntimeError, ValueError} else type(error).__name__
        print('GOVBIZ_BACKEND_DEPLOY_FAILED ' + reason, flush=True)
        raise SystemExit(1)
