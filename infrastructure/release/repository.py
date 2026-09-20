"""Account-independent, validated GitHub identity shared by CI and local tools.

CI identity comes from GitHub's own context, never a release receipt or PR input.
Local identity comes from origin; upstream is not a publication destination.
"""

from dataclasses import dataclass
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

SERVICES = ("core-service", "catalog-service", "ai-service", "ops-service")
EDUCATION_OWNER = "sknetworks-family-aicamp"


def validate_branch(branch):
    if (not isinstance(branch, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}", branch)
            or branch in {"HEAD", "@"} or ".." in branch or "//" in branch
            or any(part.startswith(".") or part.endswith((".", ".lock"))
                   for part in branch.split("/")) or branch.endswith("/")):
        raise ValueError("Use a valid branch name, not a SHA, refspec or option")
    return branch


@dataclass(frozen=True)
class Fork:
    repository: str
    branch: str = "main"

    def __post_init__(self):
        if (not isinstance(self.repository, str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}",
                                    self.repository)
                or self.repository.split("/")[1].endswith(".git")):
            raise ValueError("Repository must be a GitHub owner/name without credentials")
        validate_branch(self.branch)

    @property
    def owner(self):
        return self.repository.split("/")[0]

    @property
    def name(self):
        return self.repository.split("/")[1]

    @property
    def url(self):
        return "https://github.com/" + self.repository + ".git"

    @property
    def source_url(self):
        return "https://github.com/" + self.repository

    def image(self, service):
        if service not in SERVICES:
            raise ValueError("Unknown GovBiz service")
        return "ghcr.io/" + self.repository.lower() + "-" + service

    def require_personal_publish(self):
        # The education organization explicitly does not provide GHCR here.
        # Enabling a repository variable must not bypass that restriction.
        if self.owner.lower() == EDUCATION_OWNER:
            raise ValueError("Image publication is disabled for the education organization; use your own fork")
        return self


def repository_from_url(value):
    if not isinstance(value, str) or any(c.isspace() for c in value):
        raise ValueError("Origin must be a credential-free GitHub HTTPS or SSH URL")
    if value.startswith("git@github.com:"):
        name = value[len("git@github.com:"):]
    else:
        parsed = urlsplit(value)
        https = parsed.scheme == "https" and parsed.netloc == "github.com"
        ssh = parsed.scheme == "ssh" and parsed.netloc in {"git@github.com", "git@github.com:22"}
        if not (https or ssh) or parsed.query or parsed.fragment:
            raise ValueError("Origin must be a credential-free github.com HTTPS or git SSH URL")
        name = parsed.path.removeprefix("/")
    name = name.removesuffix("/").removesuffix(".git")
    return Fork(name).repository


def from_origin(root, branch=None):
    root = Path(root).resolve()
    remote = subprocess.check_output(["git", "-C", str(root), "remote", "get-url", "origin"],
                                     text=True, timeout=15).strip()
    repository = repository_from_url(remote)
    if branch is None:
        result = subprocess.run(["git", "-C", str(root), "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
                                text=True, capture_output=True, timeout=15)
        if result.returncode not in (0, 1):
            raise ValueError("Cannot determine origin's default branch; specify --branch")
        branch = result.stdout.strip().removeprefix("refs/remotes/origin/") if result.returncode == 0 else "main"
    return Fork(repository, branch)


def from_ci(environ=None):
    environ = os.environ if environ is None else environ
    repository = environ.get("GITHUB_REPOSITORY")
    if not repository:
        raise ValueError("GitHub's trusted GITHUB_REPOSITORY context is required")
    if environ.get("GITHUB_SERVER_URL", "https://github.com") != "https://github.com":
        raise ValueError("Only GitHub.com and ghcr.io are supported")
    return Fork(repository, environ.get("GOVBIZ_RELEASE_BRANCH", "main"))
