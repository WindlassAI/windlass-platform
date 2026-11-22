"""File bridge between an agent-owned worktree and a platform-owned Git directory.

This runs inside the session container with python3 -I. Git only opens the private
repository. All path components on the workspace side are opened relative to pinned
directory descriptors, without following links. Never hardlink a private object to
agent-writable storage, even temporarily.
"""
import contextlib
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys

DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
READ = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
operation, scratch, *args = sys.argv[1:]
private = Path(scratch)
repo = private / "repo"


def refuse(reason):
    print("wlp:unsafe", reason)
    sys.exit(3)


@contextlib.contextmanager
def directory(parent, path, create=False):
    fd = os.dup(parent)
    try:
        for part in path:
            if part in ("", ".", "..") or "/" in part:
                raise ValueError("invalid path component")
            if create:
                try:
                    os.mkdir(part, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def regular(parent, name):
    stream = os.fdopen(os.open(name, READ, dir_fd=parent), "rb")
    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
        stream.close()
        raise ValueError("expected a regular file")
    return stream


def copy_contents(source, target):
    # Prefer a copy-on-write snapshot where both directories share a filesystem.
    try:
        fcntl.ioctl(target, 0x40049409, source.fileno())  # Linux FICLONE
    except OSError as e:
        if e.errno not in (errno.ENOTTY, errno.EOPNOTSUPP, errno.EXDEV, errno.EINVAL, errno.EPERM):
            raise
        shutil.copyfileobj(source, target)


def copy_file(parent, name, dest):
    with regular(parent, name) as source:
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as target:
            copy_contents(source, target)
            if os.fstat(source.fileno()).st_mode & stat.S_IXUSR:
                os.fchmod(target.fileno(), 0o700)


def objects(fd):
    with directory(fd, ["objects"]) as root:
        for folder in os.listdir(root):
            packed = folder == "pack"
            if not packed and not re.fullmatch("[0-9a-f]{2}", folder):
                continue
            with directory(root, [folder]) as entries:
                # Readers may discover a pack as soon as its index is installed.
                names = os.listdir(entries)
                if packed:
                    names.sort(key=lambda name: name.endswith(".idx"))
                for name in names:
                    pattern = r"pack-[0-9a-f]{40}\.(pack|idx)" if packed else "[0-9a-f]{38}"
                    if re.fullmatch(pattern, name):
                        yield entries, folder, name


def import_repo(fd):
    # Keep the config solely as input to 'config --no-includes --file' in the guard.
    if "commondir" in os.listdir(fd):
        refuse(".git")
    copy_file(fd, "config", private / "guard-config")
    for name in os.listdir(fd):
        if name == "index" or re.fullmatch(r"sharedindex\.[0-9a-f]{40}", name):
            copy_file(fd, name, repo / name)
    try:
        with directory(fd, ["info"]) as info:
            copy_file(info, "exclude", repo / "info/exclude")
    except FileNotFoundError:
        pass
    state = os.fstat(fd)
    (private / "identity").write_text(f"{state.st_dev}:{state.st_ino}")
    if operation == "fetch":
        # The guard needs the index. Fetch needs only the old tracking ref values
        # for its eventual compare-and-swap; get all history from the remote.
        before = {name: fingerprint(fd, name) for name in ["packed-refs", *args]}
        (private / "before").write_text(json.dumps(before))
        return
    copy_file(fd, "HEAD", repo / "HEAD")
    for name in ("packed-refs", "MERGE_HEAD"):
        if name in os.listdir(fd):
            copy_file(fd, name, repo / name)
    with directory(fd, ["refs"]) as refs:
        for subtree in {"heads", "remotes", "tags"}.intersection(os.listdir(refs)):
            with directory(refs, [subtree]) as root:
                for path, _, files, parent in os.fwalk(".", dir_fd=root, follow_symlinks=False):
                    for name in files:
                        if not name.endswith(".lock"):
                            copy_file(parent, name, repo / "refs" / subtree / path / name)
    if "refs/wlp/review" in args:
        try:
            with directory(fd, ["refs", "wlp"]) as wlp:
                copy_file(wlp, "review", repo / "refs/wlp/review")
        except FileNotFoundError:
            pass  # The ref may be packed or absent.
    for parent, folder, name in objects(fd):
        copy_file(parent, name, repo / "objects" / folder / name)
    # Save initial values for compare-and-swap when publishing back to THIS repo.
    head = (repo / "HEAD").read_bytes().strip()
    names = ["HEAD", "index", "MERGE_HEAD", "packed-refs", *args]
    if head.startswith(b"ref: "):
        ref = os.fsdecode(head[5:])
        if not ref.startswith("refs/heads/") or any(p in ("", ".", "..") for p in ref.split("/")):
            refuse(".git")
        names.append(ref)
    imported = os.open(repo, DIRECTORY)
    (private / "before").write_text(json.dumps({name: fingerprint(imported, name) for name in names}))


def fingerprint(root, path):
    parts = path.split("/")
    try:
        with directory(root, parts[:-1]) as parent, regular(parent, parts[-1]) as source:
            return digest(source)
    except FileNotFoundError:
        return None


def digest(source):
    h = hashlib.sha256()
    for block in iter(lambda: source.read(131072), b""):
        h.update(block)
    return h.hexdigest()


def capture():
    # Git selected tracked and non-ignored paths. Reopen each without following
    # even an intermediate symlink. add/status/diff only consume this stable tree.
    names = (private / "paths").read_bytes().split(b"\0")
    tree = private / "tree"
    tree.mkdir()
    parents = {Path(".")}
    paths = set()
    for raw in filter(None, names):
        if raw.endswith(b"/"):
            refuse("nested")
        path = Path(os.fsdecode(raw))
        if path.is_absolute() or ".." in path.parts or ".git" in path.parts or not path.parts:
            refuse("unreadable")
        paths.add(path)
        parents.update(path.parents)
    for parent in parents:
        paths.update((parent / ".gitattributes", parent / ".gitignore"))
    root = os.open(".", DIRECTORY)
    links = {}
    for path in paths:
        try:
            with directory(root, path.parts[:-1]) as parent:
                mode = os.stat(path.name, dir_fd=parent, follow_symlinks=False).st_mode
                dest = tree / path
                if stat.S_ISLNK(mode):
                    links[dest] = os.readlink(path.name, dir_fd=parent)
                elif stat.S_ISREG(mode):
                    copy_file(parent, path.name, dest)
        except (NotADirectoryError, FileNotFoundError):
            # A tracked file or one of its ancestors was removed or changed type.
            continue
    # Install links last. Even concurrent file-to-directory replacements cannot
    # turn a private destination parent into a symlink while copying.
    for dest in links:
        dest.parent.mkdir(parents=True, exist_ok=True)
    for dest, target in links.items():
        dest.symlink_to(target)


def export_repo(fd):
    identity = os.fstat(fd)
    if (private / "identity").read_text() != f"{identity.st_dev}:{identity.st_ino}":
        raise ValueError("workspace repository was replaced")
    before = json.loads((private / "before").read_text())
    # Install independently copied objects before making any ref point to them.
    src = os.open(repo, DIRECTORY)
    for _, folder, name in objects(src):
        with directory(fd, ["objects", folder], create=True) as parent:
            try:
                entry = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISREG(entry.st_mode):
                    refuse(".git")
                continue
            except FileNotFoundError:
                pass
            temp = ".wlp-" + os.urandom(16).hex()
            try:
                with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444, dir_fd=parent), "wb") as out:
                    with (repo / "objects" / folder / name).open("rb") as source:
                        copy_contents(source, out)
                os.rename(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
            finally:
                unlink(parent, temp)
    # Cooperate with ordinary Git writers. Hold all relevant locks while checking
    # the input values and installing the new ref, HEAD and index by atomic rename.
    with contextlib.ExitStack() as stack:
        locks = {}
        for path in sorted(before):
            parts = path.split("/")
            parent = stack.enter_context(directory(fd, parts[:-1], create=True))
            name = parts[-1]
            lock = name + ".lock"
            out = stack.enter_context(os.fdopen(os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent), "wb"))
            cleanup = contextlib.ExitStack()
            cleanup.callback(unlink, parent, lock)
            stack.callback(cleanup.close)
            if fingerprint(parent, name) != before[path]:
                raise ValueError("workspace git state changed")
            if path in args:
                if (repo / path).exists():
                    with (repo / path).open("rb") as source:
                        copy_contents(source, out)
                    out.flush()
                locks[path] = (parent, name, lock, cleanup)
        for path, (parent, name, lock, cleanup) in locks.items():
            if (repo / path).exists():
                os.rename(lock, name, src_dir_fd=parent, dst_dir_fd=parent)
                cleanup.pop_all()
            else:
                unlink(parent, name)


def unlink(fd, name):
    try:
        os.unlink(name, dir_fd=fd)
    except FileNotFoundError:
        pass


try:
    for arg in args:
        if arg not in ("HEAD", "index", "MERGE_HEAD", "refs/wlp/review") and not arg.startswith(("refs/heads/", "refs/remotes/")):
            raise ValueError("invalid metadata path")
        if any(part in ("", ".", "..") for part in arg.split("/")):
            raise ValueError("invalid metadata path")
    if operation == "pack":
        # The workspace uid grants traversal and access to just this regular file.
        fd = os.open(private, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
        with regular(fd, "transfer.pack") as source:
            shutil.copyfileobj(source, sys.stdout.buffer)
    elif operation == "capture":
        capture()
    else:
        try:
            gitdir = os.open(".git", DIRECTORY)
        except FileNotFoundError:
            if operation in ("import", "fetch"):
                sys.exit(2)
            raise
        except NotADirectoryError:
            refuse(".git")
        if operation in ("import", "fetch"):
            import_repo(gitdir)
        elif operation == "export":
            export_repo(gitdir)
        else:
            raise ValueError("unknown git bridge operation")
except (OSError, ValueError) as error:
    print(f"Private git {operation} failed: {error}", file=sys.stderr)
    sys.exit(1)
