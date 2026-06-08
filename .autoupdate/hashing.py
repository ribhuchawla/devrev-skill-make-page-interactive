"""Stable content hash of a skill tree, for local-edit detection + merge base.

Hashes file paths + contents (sorted, deterministic), EXCLUDING the .autoupdate/
control directory itself (so the updater's own state never counts as a user edit).
"""

import hashlib
import os

EXCLUDE_DIRS = {".autoupdate", ".git", "__pycache__", "node_modules", ".pytest_cache"}


def iter_files(root):
    """Yield (relpath, abspath) for every file under root, excluding control dirs."""
    root = os.path.abspath(root)
    for dirpath, dirnames, filenames in os.walk(root):
        # prune excluded dirs in-place so os.walk doesn't descend into them
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for name in filenames:
            if name == ".DS_Store":
                continue
            abspath = os.path.join(dirpath, name)
            relpath = os.path.relpath(abspath, root)
            yield relpath.replace(os.sep, "/"), abspath


def tree_hash(root):
    """Deterministic sha256 over the skill tree (paths + contents), sorted."""
    h = hashlib.sha256()
    for relpath, abspath in sorted(iter_files(root), key=lambda x: x[0]):
        h.update(relpath.encode("utf-8"))
        h.update(b"\0")
        try:
            with open(abspath, "rb") as f:
                h.update(f.read())
        except OSError:
            h.update(b"<unreadable>")
        h.update(b"\0")
    return h.hexdigest()
