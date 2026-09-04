import errno
import json
import os
import secrets
import stat
import sys


def fail(message):
    raise RuntimeError(message)


def read_header():
    raw = sys.stdin.buffer.readline(16 * 1024)
    if not raw.endswith(b"\n"):
        fail("Invalid Windows image-output helper request")
    try:
        request = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("Invalid Windows image-output helper request")
    if not isinstance(request, dict):
        fail("Invalid Windows image-output helper request")
    return request


def read_exact(length):
    chunks = []
    remaining = length
    while remaining:
        chunk = sys.stdin.buffer.read(min(remaining, 1024 * 1024))
        if not chunk:
            fail("Windows image output was cancelled")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def validated_segments(request):
    segments = request.get("segments")
    if not isinstance(segments, list) or not segments:
        fail("Invalid Windows image-output path")
    for segment in segments:
        if (
            not isinstance(segment, str)
            or not segment
            or segment in (".", "..")
            or "/" in segment
            or "\\" in segment
        ):
            fail("Invalid Windows image-output path")
    return segments


def open_approved_parent(root, segments):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        expected_root = os.path.realpath(root)
        root_fd = os.open(root, flags)
    except OSError:
        fail("Could not open the approved image-output root")
    opened_fds = [root_fd]
    opened_root = os.path.realpath(f"/proc/self/fd/{root_fd}")
    if opened_root != expected_root:
        fail("Output parent directory escaped the approved path while it was being opened")

    current_fd = root_fd
    try:
        for segment in segments[:-1]:
            try:
                current_fd = os.open(segment, flags, dir_fd=current_fd)
            except FileNotFoundError:
                fail("Output parent directory must already exist")
            except OSError as error:
                if error.errno in (errno.ELOOP, errno.ENOTDIR):
                    fail("Output parent directory escaped the approved path while it was being opened")
                raise
            opened_fds.append(current_fd)
        return opened_fds, current_fd, segments[-1]
    except Exception:
        for descriptor in reversed(opened_fds):
            os.close(descriptor)
        raise


def target_state(parent_fd, target_name, requested_path, overwrite):
    try:
        existing = os.stat(target_name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if stat.S_ISLNK(existing.st_mode):
        fail(f"Refusing to replace symbolic link: {requested_path}")
    if not overwrite:
        fail(f"Output already exists; set overwrite=true to replace it: {requested_path}")
    if not stat.S_ISREG(existing.st_mode):
        fail(f"Output path is not a regular file: {requested_path}")


def validate(request):
    segments = validated_segments(request)
    root = request.get("root")
    requested_path = request.get("requestedPath")
    overwrite = request.get("overwrite")
    if not isinstance(root, str) or not isinstance(requested_path, str) or not isinstance(overwrite, bool):
        fail("Invalid Windows image-output helper request")
    descriptors, parent_fd, target_name = open_approved_parent(root, segments)
    try:
        target_state(parent_fd, target_name, requested_path, overwrite)
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def save(request):
    segments = validated_segments(request)
    root = request.get("root")
    requested_path = request.get("requestedPath")
    overwrite = request.get("overwrite")
    byte_length = request.get("byteLength")
    if (
        not isinstance(root, str)
        or not isinstance(requested_path, str)
        or not isinstance(overwrite, bool)
        or not isinstance(byte_length, int)
        or byte_length < 0
        or byte_length > 40 * 1024 * 1024
    ):
        fail("Invalid Windows image-output helper request")

    image = read_exact(byte_length)
    descriptors, parent_fd, target_name = open_approved_parent(root, segments)
    temporary_name = f".{target_name}.pi-image-{secrets.token_hex(16)}.tmp"
    temporary_created = False
    try:
        target_state(parent_fd, target_name, requested_path, overwrite)
        temporary_fd = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=parent_fd,
        )
        temporary_created = True
        try:
            view = memoryview(image)
            while view:
                written = os.write(temporary_fd, view)
                if written <= 0:
                    fail("Could not write generated image")
                view = view[written:]
            os.fsync(temporary_fd)
        finally:
            os.close(temporary_fd)

        print("READY", flush=True)
        if sys.stdin.buffer.readline(32) != b"COMMIT\n":
            fail("Windows image output was cancelled")

        if overwrite:
            os.replace(temporary_name, target_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        else:
            try:
                os.link(
                    temporary_name,
                    target_name,
                    src_dir_fd=parent_fd,
                    dst_dir_fd=parent_fd,
                    follow_symlinks=False,
                )
            except FileExistsError:
                fail(f"Output already exists; set overwrite=true to replace it: {requested_path}")
            os.unlink(temporary_name, dir_fd=parent_fd)
        temporary_created = False
        try:
            os.fsync(parent_fd)
        except OSError as error:
            if error.errno not in (errno.EINVAL, errno.ENOTSUP):
                raise
    finally:
        if temporary_created:
            try:
                os.unlink(temporary_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def main():
    request = read_header()
    action = request.get("action")
    if action == "validate":
        validate(request)
    elif action == "save":
        save(request)
    else:
        fail("Invalid Windows image-output helper request")
    print("OK", flush=True)


try:
    main()
except Exception as error:
    message = str(error).replace("\r", " ").replace("\n", " ")[:2000]
    print(f"ERROR\t{message}", flush=True)
    sys.exit(1)
