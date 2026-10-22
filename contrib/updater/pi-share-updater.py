#!/usr/bin/env python3
"""pi-share updater: installs a newer pi-share release when the admin asks for one.

Runs as root on the host, started by pi-share-updater.path when the admin leaves a request (and once at boot, to
undo an update a power cut interrupted). The admin only ever writes a wish; everything here is decided again:

- from the request only a version number is read (no symlinks, no special files, a few bytes at most);
- the version must be newer than the running one and a published, non-prerelease release of the configured repo;
- the downloaded image must say it was built from that repository for that version, and its build provenance is
  verified against the exact digest that will run when the GitHub CLI and a token are available (always, with
  VERIFY_PROVENANCE=required);
- the database is copied before the switch, and if the new version does not become healthy, or the run is
  stopped half-way, the previous image and database come back.

The admin reads progress from a status file in a directory it cannot write to. Messages are fixed strings: nothing
the admin wrote is ever echoed back.
"""

import fcntl
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

VERSION = re.compile(r"[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}", re.ASCII)
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", re.ASCII)
DIGEST = re.compile(r"sha256:[0-9a-f]{64}", re.ASCII)
IMAGE_LINE = re.compile(
    r"PI_SHARE_IMAGE=(?P<reference>(?P<image>[^\s:@]+(?::[0-9]+)?(?:/[^\s:@]+)*)"
    r":(?P<tag>[0-9]{1,4}\.[0-9]{1,4}(?:\.[0-9]{1,4})?)(?:@sha256:[0-9a-f]{64})?)",
    re.ASCII,
)
MAX_REQUEST_BYTES = 1024
KEEP_BACKUPS = 3
SPARE_BYTES = 256 * 1024 * 1024
STOP_TIMEOUT = 120
UP_TIMEOUT = 300
DATABASE_FILES = ("share.db", "share.db-wal", "share.db-shm")
DEFAULTS = {
    "REPO": "ontech7/pi-share",
    "IMAGE": "ghcr.io/ontech7/pi-share",
    "SIGNER_WORKFLOW": ".github/workflows/release.yml",
    "COMPOSE_FILE": "/etc/pi-share/compose.yaml",
    "ENV_FILE": "/etc/pi-share/.env",
    "DATA_DIR": "/var/lib/pi-share",
    "REQUEST_DIR": "/var/lib/pi-share-update/request",
    "STATUS_DIR": "/var/lib/pi-share-update/status",
    "BACKUP_DIR": "/var/lib/pi-share-update/backup",
    "HEALTH_TIMEOUT": "120",
    "COOLDOWN": "15",
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
    if not REPO.fullmatch(config["REPO"]) or config["VERIFY_PROVENANCE"] not in ("auto", "required", "off"):
        sys.exit("REPO or VERIFY_PROVENANCE is not valid")
    return config


class Status:
    def __init__(self, directory):
        self.directory = directory
        self.version = "0.0.0"

    def write(self, state, message=None):
        record = {"state": state, "version": self.version, "message": message, "at": int(time.time() * 1000)}
        write_file(os.path.join(self.directory, "status.json"), json.dumps(record))


class Switch:
    """What to undo while pi-share is stopped or on a new image, so a run stopped half-way is undone by the next."""

    def __init__(self, config):
        self.path = os.path.join(config["BACKUP_DIR"], ".switching")

    def save(self, record):
        write_file(self.path, json.dumps(record))

    def load(self):
        try:
            with open(self.path, encoding="utf-8") as file:
                record = json.load(file)
        except FileNotFoundError:
            return None
        except ValueError:
            record = None
        if not isinstance(record, dict) or not {"version", "current", "env", "folder"} <= record.keys():
            self.clear()
            return None
        return record

    def clear(self):
        remove(self.path)


def take_request(directory):
    """The requested version, or None when there is no request. The request is always removed."""
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
    except (ValueError, AttributeError, RecursionError):
        raise Refused("the request was not valid")
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise Refused("the request did not name a version")
    return version


def remove(path):
    """Removes whatever is at path without following symlinks. Never raises: a leftover is retried next run."""
    try:
        if stat.S_ISDIR(os.lstat(path).st_mode):
            shutil.rmtree(path)
        else:
            os.unlink(path)
    except OSError:
        pass


def as_tuple(version):
    return tuple(int(part) for part in version.split("."))


def read_env(path):
    with open(path, encoding="utf-8") as file:
        return file.read()


def running_version(config, env_text):
    for line in env_text.splitlines():
        match = IMAGE_LINE.fullmatch(line.strip())
        if not match or match["image"] != config["IMAGE"]:
            continue
        if VERSION.fullmatch(match["tag"]):
            return match["tag"]
        # A moving x.y tag: the version is the one the image itself carries.
        version = image_labels(config, match["reference"]).get("org.opencontainers.image.version")
        if isinstance(version, str) and VERSION.fullmatch(version) and version.startswith(match["tag"] + "."):
            return version
        break
    raise Refused("the running version could not be read from the env file")


def with_image(env_text, reference):
    lines = [line for line in env_text.splitlines() if not line.strip().startswith("PI_SHARE_IMAGE=")]
    return "\n".join([*lines, f"PI_SHARE_IMAGE={reference}"]) + "\n"


def write_file(path, text):
    """Replaces a file atomically, keeping its mode and owner."""
    try:
        info = os.stat(path)
        mode, owner = stat.S_IMODE(info.st_mode), (info.st_uid, info.st_gid)
    except FileNotFoundError:
        mode, owner = 0o644, None
    handle, temporary = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".pi-share-")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            file.write(text)
        os.chmod(temporary, mode)
        if owner:
            os.chown(temporary, *owner)
        os.replace(temporary, path)
    except BaseException:
        remove(temporary)
        raise


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
    except (urllib.error.URLError, TimeoutError, ValueError, RecursionError):
        raise Refused("GitHub could not be reached")


def run(config, *args, check=True, timeout=600):
    result = subprocess.run(
        [config["DOCKER"], *args], capture_output=True, text=True, timeout=timeout, check=False
    )
    if check and result.returncode != 0:
        raise Refused(f"docker {args[0]} failed")
    return result


def compose(config, *args, check=True, timeout=600):
    files = [arg for path in config["COMPOSE_FILE"].split(":") if path for arg in ("-f", path)]
    return run(config, "compose", *files, "--env-file", config["ENV_FILE"], *args, check=check, timeout=timeout)


def inspect(config, reference, field, empty):
    result = run(config, "image", "inspect", "--format", f"{{{{json .{field}}}}}", reference, timeout=60)
    try:
        value = json.loads(result.stdout or "null")
    except ValueError:
        value = None
    return value if isinstance(value, type(empty)) else empty


def image_labels(config, reference):
    return inspect(config, reference, "Config.Labels", {})


def verify_image(config, version):
    reference = f"{config['IMAGE']}:{version}"
    run(config, "pull", "--quiet", reference)
    labels = image_labels(config, reference)
    if labels.get("org.opencontainers.image.source") != f"https://github.com/{config['REPO']}":
        raise Refused("the image does not come from the expected repository")
    if labels.get("org.opencontainers.image.version") != version:
        raise Refused("the image does not carry the expected version")

    digests = inspect(config, reference, "RepoDigests", [])
    prefix = config["IMAGE"] + "@"
    digest = next(
        (d[len(prefix):] for d in digests if isinstance(d, str) and d.startswith(prefix) and DIGEST.fullmatch(d[len(prefix):])),
        None,
    )
    if not digest:
        raise Refused("the image digest could not be read")
    verify_provenance(config, version, f"{config['IMAGE']}@{digest}")
    return f"{reference}@{digest}"


def verify_provenance(config, version, pinned):
    """Checks the image that will run was built by the release workflow, from the tag of that version."""
    mode = config["VERIFY_PROVENANCE"]
    gh = shutil.which("gh")
    ready = gh is not None and bool(os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"))
    if mode == "off" or (mode == "auto" and not ready):
        return
    if gh is None or not ready:
        raise Refused("build provenance is required but the GitHub CLI or its token is missing")
    repo = config["REPO"]
    result = subprocess.run(
        [
            gh, "attestation", "verify", f"oci://{pinned}",
            "--repo", repo,
            "--signer-workflow", f"{repo}/{config['SIGNER_WORKFLOW']}",
            "--source-ref", f"refs/tags/v{version}",
            "--deny-self-hosted-runners",
        ],
        capture_output=True, text=True, timeout=120, check=False,
    )
    if result.returncode != 0:
        raise Refused("the build provenance of the image could not be verified")


def healthy(config):
    deadline = time.monotonic() + int(config["HEALTH_TIMEOUT"])
    while time.monotonic() < deadline:
        try:
            output = compose(config, "ps", "--all", "--format", "json", check=False, timeout=60).stdout.strip()
            containers = json.loads(output) if output.startswith("[") else [
                json.loads(line) for line in output.splitlines() if line.strip()
            ]
        except (subprocess.SubprocessError, OSError, ValueError):
            containers = []
        if containers and all(
            isinstance(c, dict) and c.get("State") == "running" and c.get("Health", "") in ("healthy", "")
            for c in containers
        ):
            return True
        time.sleep(3)
    return False


def copy_plain(source, target):
    """Copies a regular file without following symlinks at either end."""
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as reader:
        info = os.fstat(reader.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise OSError(f"{source} is not a regular file")
        out = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(out, "wb") as writer:
            shutil.copyfileobj(reader, writer, 1024 * 1024)
            os.fchmod(writer.fileno(), stat.S_IMODE(info.st_mode))


def database_files(config):
    found = {}
    for name in DATABASE_FILES:
        try:
            info = os.lstat(os.path.join(config["DATA_DIR"], name))
        except FileNotFoundError:
            continue
        if stat.S_ISREG(info.st_mode):
            found[name] = info.st_size
    if "share.db" not in found:
        raise Refused("the database was not found, nothing was changed")
    return found


def back_up(config, current):
    files = database_files(config)
    if shutil.disk_usage(config["BACKUP_DIR"]).free < sum(files.values()) + SPARE_BYTES:
        raise Refused("there is not enough free space to back up the database, nothing was changed")
    folder = os.path.join(config["BACKUP_DIR"], f"{time.strftime('%Y%m%d-%H%M%S')}-{current}")
    os.makedirs(folder, mode=0o700)
    try:
        for name in files:
            copy_plain(os.path.join(config["DATA_DIR"], name), os.path.join(folder, name))
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    backups = sorted(d for d in os.listdir(config["BACKUP_DIR"]) if not d.startswith("."))
    for old in backups[:-KEEP_BACKUPS]:
        shutil.rmtree(os.path.join(config["BACKUP_DIR"], old), ignore_errors=True)
    return folder


def restore(config, folder):
    """Puts the backed-up database back, owned like the data folder, whatever is in its place now."""
    owner = os.stat(config["DATA_DIR"])
    for name in DATABASE_FILES:
        target = os.path.join(config["DATA_DIR"], name)
        saved = os.path.join(folder, name)
        try:
            if stat.S_ISDIR(os.lstat(target).st_mode):
                shutil.rmtree(target)
            elif not os.path.exists(saved):
                os.unlink(target)
        except FileNotFoundError:
            pass
        if not os.path.exists(saved):
            continue
        handle, temporary = tempfile.mkstemp(dir=config["DATA_DIR"], prefix=".restore-")
        try:
            with os.fdopen(handle, "wb") as writer, open(saved, "rb") as reader:
                shutil.copyfileobj(reader, writer, 1024 * 1024)
            os.chmod(temporary, stat.S_IMODE(os.stat(saved).st_mode))
            os.chown(temporary, owner.st_uid, owner.st_gid)
            os.replace(temporary, target)
        except BaseException:
            remove(temporary)
            raise


def roll_back(config, status, record, message):
    """Brings back the previous image and its database. Every step is tried even when an earlier one failed."""
    current = record["current"]
    database_back = env_back = True
    try:
        compose(config, "stop", check=False, timeout=STOP_TIMEOUT)
    except Exception:
        pass
    if record["folder"]:
        try:
            restore(config, record["folder"])
        except Exception:
            database_back = False
    try:
        write_file(config["ENV_FILE"], record["env"])
    except Exception:
        env_back = False
    try:
        compose(config, "up", "-d", "--remove-orphans", check=False, timeout=UP_TIMEOUT)
    except Exception:
        pass
    if not env_back or not healthy(config):
        status.write("rolled_back", f"{message} and {current} is not healthy either: check the containers")
    elif not database_back:
        status.write("rolled_back", f"{message}; {current} is running again, but its database backup could not be put back")
    else:
        status.write("rolled_back", f"{message}; {current} is running again")


def update(config, status, switch):
    version = take_request(config["REQUEST_DIR"])
    if version is None:
        return
    status.version = version
    env_text = read_env(config["ENV_FILE"])
    current = running_version(config, env_text)
    if as_tuple(version) <= as_tuple(current):
        raise Refused(f"{version} is not newer than the running {current}")

    status.write("checking")
    release = github(config, f"/repos/{config['REPO']}/releases/tags/v{version}")
    if not isinstance(release, dict) or release.get("draft") or release.get("prerelease") or release.get("tag_name") != f"v{version}":
        raise Refused("this version is not a published release")

    status.write("downloading")
    reference = verify_image(config, version)

    status.write("backing_up")
    record = {"version": version, "current": current, "env": env_text, "folder": None}
    switch.save(record)
    try:
        compose(config, "stop", timeout=STOP_TIMEOUT)
        record["folder"] = back_up(config, current)
    except BaseException as error:
        # Nothing changed yet: the running version just starts again.
        try:
            compose(config, "up", "-d", check=False, timeout=UP_TIMEOUT)
        finally:
            switch.clear()
        if isinstance(error, OSError):
            raise Refused("the database could not be backed up, nothing was changed") from error
        raise
    switch.save(record)

    try:
        status.write("restarting")
        write_file(config["ENV_FILE"], with_image(env_text, reference))
        compose(config, "up", "-d", "--remove-orphans", check=False, timeout=UP_TIMEOUT)
        if healthy(config):
            status.write("done")
            switch.clear()
            return
        message = f"{version} did not start correctly"
    except BaseException:
        # Including the SystemExit a stop signal raises: the previous version comes back before leaving.
        message = f"the switch to {version} was interrupted"
    roll_back(config, status, record, message)
    switch.clear()


def recover(config, status, switch):
    record = switch.load()
    if record is None:
        return
    status.version = record["version"]
    roll_back(config, status, record, f"the update to {record['version']} was interrupted")
    switch.clear()


def cool_down(config):
    """Spaces runs out, so a flood of requests cannot keep Docker and GitHub busy."""
    mark = os.path.join(config["BACKUP_DIR"], ".last-run")
    try:
        wait = int(config["COOLDOWN"]) - (time.time() - os.stat(mark).st_mtime)
    except FileNotFoundError:
        wait = 0
    if wait > 0:
        time.sleep(min(wait, int(config["COOLDOWN"])))
    with open(mark, "w"):
        pass


def stop_on_signal(signum, _):
    # Once is enough: a second signal must not cut the rollback short.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise SystemExit(f"stopped by signal {signum}")


def main():
    config = load_config(os.environ.get("PI_SHARE_UPDATER_CONFIG", "/etc/pi-share/updater.env"))
    signal.signal(signal.SIGTERM, stop_on_signal)
    status = Status(config["STATUS_DIR"])
    switch = Switch(config)
    os.makedirs(config["BACKUP_DIR"], mode=0o700, exist_ok=True)
    with open(os.path.join(config["BACKUP_DIR"], ".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        recover(config, status, switch)
        if not os.path.lexists(os.path.join(config["REQUEST_DIR"], "request.json")):
            return
        cool_down(config)
        try:
            update(config, status, switch)
        except Refused as refusal:
            status.write("failed", str(refusal))
        except BaseException:
            status.write("failed", "the update stopped unexpectedly: check the updater's log")
            raise


if __name__ == "__main__":
    main()
