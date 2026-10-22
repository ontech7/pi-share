#!/usr/bin/env python3
"""pi-share updater: installs a newer pi-share release when the admin asks for one.

Runs as root on the host, started by pi-share-updater.path when the admin leaves a request. The admin only ever
writes a wish; everything here is decided again from scratch:

- from the request only a version number is read (no symlinks, no special files, a few bytes at most);
- the version must be newer than the running one and a published, non-prerelease release of the configured repo;
- the downloaded image must say it was built from that repository for that version, and its build provenance is
  verified when the GitHub CLI is available (or always, with VERIFY_PROVENANCE=required);
- the database is copied before the switch, and if the new version does not become healthy the previous image
  and database come back.

The admin reads progress from a status file in a directory it cannot write to. Messages are fixed strings: nothing
the admin wrote is ever echoed back.
"""

import fcntl
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

VERSION = re.compile(r"^\d{1,4}\.\d{1,4}\.\d{1,4}$")
REPO = re.compile(r"^[\w.-]+/[\w.-]+$")
IMAGE_LINE = re.compile(r"^PI_SHARE_IMAGE=(?P<image>[^\s:@]+(?::\d+)?(?:/[^\s:@]+)*):(?P<version>\d{1,4}\.\d{1,4}\.\d{1,4})(?:@sha256:[0-9a-f]{64})?$")
MAX_REQUEST_BYTES = 1024
KEEP_BACKUPS = 3
DATABASE_FILES = ("share.db", "share.db-wal", "share.db-shm")
DEFAULTS = {
    "REPO": "ontech7/pi-share",
    "IMAGE": "ghcr.io/ontech7/pi-share",
    "COMPOSE_FILE": "/etc/pi-share/compose.yaml",
    "ENV_FILE": "/etc/pi-share/.env",
    "DATA_DIR": "/var/lib/pi-share",
    "REQUEST_DIR": "/var/lib/pi-share-update/request",
    "STATUS_DIR": "/var/lib/pi-share-update/status",
    "BACKUP_DIR": "/var/lib/pi-share-update/backup",
    "HEALTH_TIMEOUT": "120",
    "VERIFY_PROVENANCE": "auto",
    "DOCKER": "docker",
    "GITHUB_API": "https://api.github.com",
}


class Refused(Exception):
    """A request that is not acted upon, with a message safe to show in the admin."""


def load_config(path):
    info = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        sys.exit(f"{path} must be a regular file owned by this user and not writable by group or others")
    config = dict(DEFAULTS)
    with open(path, encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                config[key.strip()] = value.strip().strip("'\"")
    if not REPO.match(config["REPO"]) or config["VERIFY_PROVENANCE"] not in ("auto", "required", "off"):
        sys.exit("REPO or VERIFY_PROVENANCE is not valid")
    return config


class Status:
    def __init__(self, directory):
        self.directory = directory
        self.version = "0.0.0"

    def write(self, state, message=None):
        record = {"state": state, "version": self.version, "message": message, "at": int(time.time() * 1000)}
        handle, temporary = tempfile.mkstemp(dir=self.directory, prefix=".status-")
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            json.dump(record, file)
        os.chmod(temporary, 0o644)
        os.replace(temporary, os.path.join(self.directory, "status.json"))


def take_request(directory):
    """The requested version, or None when there is no request. The request file is always removed."""
    path = os.path.join(directory, "request.json")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        remove(path)
        raise Refused("the request was not a plain file")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_REQUEST_BYTES:
            raise Refused("the request was not a small plain file")
        raw = os.read(fd, MAX_REQUEST_BYTES + 1)
    finally:
        os.close(fd)
        remove(path)
    try:
        version = json.loads(raw.decode("utf-8")).get("version")
    except (ValueError, AttributeError):
        raise Refused("the request was not valid")
    if not isinstance(version, str) or not VERSION.match(version):
        raise Refused("the request did not name a version")
    return version


def remove(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def as_tuple(version):
    return tuple(int(part) for part in version.split("."))


def read_env(path):
    with open(path, encoding="utf-8") as file:
        return file.read()


def running_image(env_text, image):
    for line in env_text.splitlines():
        match = IMAGE_LINE.match(line.strip())
        if match and match["image"] == image:
            return match["version"]
    raise Refused("the running version could not be read from the env file")


def with_image(env_text, reference):
    lines = [line for line in env_text.splitlines() if not line.strip().startswith("PI_SHARE_IMAGE=")]
    return "\n".join([*lines, f"PI_SHARE_IMAGE={reference}"]) + "\n"


def write_file(path, text):
    directory = os.path.dirname(path) or "."
    handle, temporary = tempfile.mkstemp(dir=directory, prefix=".pi-share-")
    with os.fdopen(handle, "w", encoding="utf-8") as file:
        file.write(text)
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)


def github(config, path):
    request = urllib.request.Request(
        config["GITHUB_API"] + path,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "pi-share-updater"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise Refused("this version is not a published release")
        raise Refused("GitHub could not be reached")
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise Refused("GitHub could not be reached")


def run(config, *args, check=True, timeout=600):
    result = subprocess.run(
        [config["DOCKER"], *args], capture_output=True, text=True, timeout=timeout, check=False
    )
    if check and result.returncode != 0:
        raise Refused(f"docker {args[0]} failed")
    return result


def compose(config, *args, check=True):
    files = [arg for path in config["COMPOSE_FILE"].split(":") if path for arg in ("-f", path)]
    return run(config, "compose", *files, "--env-file", config["ENV_FILE"], *args, check=check)


def verify_image(config, version):
    reference = f"{config['IMAGE']}:{version}"
    run(config, "pull", "--quiet", reference)
    labels = json.loads(run(config, "image", "inspect", "--format", "{{json .Config.Labels}}", reference).stdout or "{}")
    if (labels or {}).get("org.opencontainers.image.source") != f"https://github.com/{config['REPO']}":
        raise Refused("the image does not come from the expected repository")
    if labels.get("org.opencontainers.image.version") != version:
        raise Refused("the image does not carry the expected version")

    mode = config["VERIFY_PROVENANCE"]
    gh = shutil.which("gh")
    if mode == "required" and not gh:
        raise Refused("build provenance is required but the GitHub CLI is not installed")
    if mode != "off" and gh:
        result = subprocess.run(
            [gh, "attestation", "verify", f"oci://{reference}", "--repo", config["REPO"]],
            capture_output=True, text=True, timeout=120, check=False,
        )
        if result.returncode != 0:
            raise Refused("the build provenance of the image could not be verified")

    digests = json.loads(run(config, "image", "inspect", "--format", "{{json .RepoDigests}}", reference).stdout or "[]")
    pinned = next((d for d in digests or [] if d.startswith(config["IMAGE"] + "@sha256:")), None)
    if not pinned:
        raise Refused("the image digest could not be read")
    return f"{reference}@{pinned.split('@', 1)[1]}"


def healthy(config):
    deadline = time.monotonic() + int(config["HEALTH_TIMEOUT"])
    while time.monotonic() < deadline:
        output = compose(config, "ps", "--all", "--format", "json", check=False).stdout.strip()
        containers = []
        if output.startswith("["):
            containers = json.loads(output)
        elif output:
            containers = [json.loads(line) for line in output.splitlines() if line.strip()]
        if containers and all(
            c.get("State") == "running" and c.get("Health", "") in ("healthy", "") for c in containers
        ):
            return True
        time.sleep(3)
    return False


def back_up(config, current):
    folder = os.path.join(config["BACKUP_DIR"], f"{time.strftime('%Y%m%d-%H%M%S')}-{current}")
    os.makedirs(folder, mode=0o700)
    for name in DATABASE_FILES:
        source = os.path.join(config["DATA_DIR"], name)
        if os.path.isfile(source) and not os.path.islink(source):
            shutil.copy2(source, folder)
    backups = sorted(d for d in os.listdir(config["BACKUP_DIR"]) if not d.startswith("."))
    for old in backups[:-KEEP_BACKUPS]:
        shutil.rmtree(os.path.join(config["BACKUP_DIR"], old), ignore_errors=True)
    return folder


def restore(config, folder):
    for name in DATABASE_FILES:
        target = os.path.join(config["DATA_DIR"], name)
        saved = os.path.join(folder, name)
        if os.path.exists(saved):
            shutil.copy2(saved, target)
        else:
            remove(target)


def update(config, status):
    version = take_request(config["REQUEST_DIR"])
    if version is None:
        return
    status.version = version
    env_text = read_env(config["ENV_FILE"])
    current = running_image(env_text, config["IMAGE"])
    if as_tuple(version) <= as_tuple(current):
        raise Refused(f"{version} is not newer than the running {current}")

    status.write("checking")
    release = github(config, f"/repos/{config['REPO']}/releases/tags/v{version}")
    if release.get("draft") or release.get("prerelease") or release.get("tag_name") != f"v{version}":
        raise Refused("this version is not a published release")

    status.write("downloading")
    reference = verify_image(config, version)

    status.write("backing_up")
    compose(config, "stop")
    try:
        folder = back_up(config, current)
    except OSError:
        compose(config, "up", "-d", check=False)
        raise Refused("the database could not be backed up, nothing was changed")

    try:
        status.write("restarting")
        write_file(config["ENV_FILE"], with_image(env_text, reference))
        compose(config, "up", "-d", "--remove-orphans", check=False)
        if healthy(config):
            status.write("done")
            return
        message = f"{version} did not start correctly"
    except Exception:
        message = f"the switch to {version} stopped unexpectedly"

    # Whatever went wrong after the containers stopped, the previous version and its database come back.
    compose(config, "stop", check=False)
    restore(config, folder)
    write_file(config["ENV_FILE"], env_text)
    compose(config, "up", "-d", "--remove-orphans", check=False)
    if healthy(config):
        status.write("rolled_back", f"{message}; {current} is running again")
    else:
        status.write("rolled_back", f"{message} and {current} is not healthy either: check the containers")


def main():
    config = load_config(os.environ.get("PI_SHARE_UPDATER_CONFIG", "/etc/pi-share/updater.env"))
    status = Status(config["STATUS_DIR"])
    os.makedirs(config["BACKUP_DIR"], mode=0o700, exist_ok=True)
    with open(os.path.join(config["BACKUP_DIR"], ".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            update(config, status)
        except Refused as refusal:
            status.write("failed", str(refusal))
        except Exception:
            status.write("failed", "the update stopped unexpectedly: check the updater's log")
            raise


if __name__ == "__main__":
    main()
