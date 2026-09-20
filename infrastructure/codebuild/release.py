#!/usr/bin/env python3
"""Publish two immutable images and invoke only the configured GovBiz SSM document."""
import json
import os
import re
import subprocess
import time

BUILD_CONTEXTS = {
    'core-service': 'backend/core-service',
    'ai-service': 'backend/ai-service',
}


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def aws(*args):
    return json.loads(run('aws', *args, '--region', os.environ['AWS_REGION'],
                          '--output', 'json', '--no-cli-pager', capture_output=True).stdout)


def commit_id():
    sha = os.environ.get('CODEBUILD_RESOLVED_SOURCE_VERSION', '')
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('Expected a resolved Git commit, not a branch or PR identifier')
    if run('git', 'rev-parse', 'HEAD', capture_output=True).stdout.strip() != sha:
        raise ValueError('Source checkout does not match CodeBuild revision')
    return sha


def is_current_main(sha):
    # A failed fetch is an error, not permission to deploy an old build.
    tip = run('git', 'ls-remote', '--exit-code',
              'https://github.com/ilil1/SKN34-3rd-1Team.git', 'refs/heads/main',
              capture_output=True).stdout.split()[0]
    return tip == sha


def image_digest(repository, tag):
    # An immutable tag may already exist after a retry; never overwrite it.
    response = aws('ecr', 'batch-get-image', '--repository-name', repository,
                   '--image-ids', 'imageTag=' + tag)
    images = response.get('images', [])
    if images:
        return images[0]['imageId']['imageDigest']
    failures = response.get('failures', [])
    if len(failures) != 1 or failures[0].get('failureCode') != 'ImageNotFound':
        raise RuntimeError('ECR image lookup failed')
    return None


def publish(registry, service, sha):
    context = BUILD_CONTEXTS[service]
    repository, tag = 'govbiz/' + service, 'git-' + sha
    digest = image_digest(repository, tag)
    if digest is None:
        ref = registry + '/' + repository + ':' + tag
        run('docker', 'build', '--platform', 'linux/amd64', '--label',
            'org.opencontainers.image.revision=' + sha, '--tag', ref, context)
        run('docker', 'push', ref)
        digest = image_digest(repository, tag)
    if not digest or not re.fullmatch('sha256:[0-9a-f]{64}', digest):
        raise RuntimeError('ECR did not return a valid immutable image digest')
    return registry + '/' + repository + '@' + digest


def wait_command(command_id, instance):
    print('SSM_COMMAND_ID=' + command_id, flush=True)
    deadline = time.monotonic() + 1860
    while time.monotonic() < deadline:
        try:
            result = aws('ssm', 'get-command-invocation', '--command-id', command_id,
                         '--instance-id', instance)
        except subprocess.CalledProcessError as error:
            if 'InvocationDoesNotExist' not in (error.stderr or ''):
                raise RuntimeError('Cannot read SSM status; inspect the printed command ID') from None
            time.sleep(10)
            continue
        status = result['Status']
        if status == 'Success':
            if 'GOVBIZ_BACKEND_DEPLOY_OK' not in result.get('StandardOutputContent', ''):
                raise RuntimeError('SSM success marker missing')
            print('GOVBIZ_BACKEND_DEPLOY_OK', flush=True)
            return
        if status not in {'Pending', 'InProgress', 'Delayed'}:
            # Do not copy arbitrary server output or app logs into CodeBuild/GitHub.
            raise RuntimeError('Deployment failed: ' + status + '; inspect SSM command ' + command_id)
        time.sleep(10)
    raise RuntimeError('SSM result timed out; remote deployment may still be running. Do not resend blindly.')


def main():
    sha = commit_id()
    if os.environ.get('GOVBIZ_DEPLOY_ENABLED') != 'true':
        print('GOVBIZ_BACKEND_VERIFIED_DEPLOY_DISABLED')
        return
    if not is_current_main(sha):
        print('GOVBIZ_SUPERSEDED_BUILD_NOT_DEPLOYED')
        return
    account = aws('sts', 'get-caller-identity')['Account']
    registry = account + '.dkr.ecr.' + os.environ['AWS_REGION'] + '.amazonaws.com'
    # Password only crosses stdin. Never print or place it in command arguments.
    password = run('aws', 'ecr', 'get-login-password', '--region', os.environ['AWS_REGION'],
                   capture_output=True).stdout
    try:
        run('docker', 'login', '--username', 'AWS', '--password-stdin', registry,
            input=password, capture_output=True)
        images = {service: publish(registry, service, sha) for service in ('core-service', 'ai-service')}
    finally:
        subprocess.run(['docker', 'logout', registry], capture_output=True)
    if not is_current_main(sha):
        print('GOVBIZ_SUPERSEDED_BUILD_NOT_DEPLOYED')
        return
    instance = os.environ['GOVBIZ_INSTANCE_ID']
    response = aws('ssm', 'send-command', '--document-name', os.environ['GOVBIZ_DEPLOY_DOCUMENT'],
                   '--document-version', os.environ['GOVBIZ_DEPLOY_DOCUMENT_VERSION'], '--instance-ids', instance,
                   '--parameters', json.dumps({'Mode': ['deploy'], 'Commit': [sha],
                       'CoreImage': [images['core-service']], 'AiImage': [images['ai-service']]}),
                   '--comment', 'GovBiz main ' + sha)
    wait_command(response['Command']['CommandId'], instance)


if __name__ == '__main__':
    main()
