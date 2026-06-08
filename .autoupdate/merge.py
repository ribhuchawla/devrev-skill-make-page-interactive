"""File-level 3-way merge for skill updates.

Given base/ (pristine installed), mine/ (current local, may have edits), and new/
(freshly downloaded remote), produce a merged tree:

  - file changed in NEW only (mine == base)      -> take NEW
  - file changed in MINE only (new == base)       -> keep MINE
  - file changed in BOTH                          -> git merge-file (3-way)
  - file added in NEW                             -> add NEW
  - file added in MINE (not in new/base)          -> keep MINE
  - file deleted in NEW (in base, not new)        -> delete (unless mine changed it)

Returns a report dict: {merged:[...], kept:[...], took_new:[...], conflicts:[...]}.
git is used for the both-changed case; if git is unavailable, those files are
reported as conflicts (caller falls back to take-latest / keep-mine).
"""

import os
import shutil
import subprocess

from hashing import iter_files


def _read(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None


def _rel_set(root):
    return {rel for rel, _ in iter_files(root)}


def _git_available():
    try:
        subprocess.run(["git", "--version"], capture_output=True, check=True)
        return True
    except Exception:
        return False


def merge_trees(base_dir, mine_dir, new_dir, out_dir):
    """3-way merge mine+new over base into out_dir. Returns a report dict."""
    report = {"took_new": [], "kept": [], "merged": [], "conflicts": [], "deleted": []}
    have_git = _git_available()

    base_files = _rel_set(base_dir)
    mine_files = _rel_set(mine_dir)
    new_files = _rel_set(new_dir)
    all_files = base_files | mine_files | new_files

    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    def write_out(rel, data):
        dest = os.path.join(out_dir, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(data if data is not None else b"")

    for rel in sorted(all_files):
        b = _read(os.path.join(base_dir, rel)) if rel in base_files else None
        m = _read(os.path.join(mine_dir, rel)) if rel in mine_files else None
        n = _read(os.path.join(new_dir, rel)) if rel in new_files else None

        # Deletions in new
        if rel in base_files and rel not in new_files:
            if rel in mine_files and m != b:
                write_out(rel, m); report["kept"].append(rel)        # user kept/edited a file new deleted
            else:
                report["deleted"].append(rel)                          # honor deletion
            continue

        if m is None:                       # added in new only
            write_out(rel, n); report["took_new"].append(rel); continue
        if n is None:                       # added in mine only
            write_out(rel, m); report["kept"].append(rel); continue

        if m == n:
            write_out(rel, n); continue                               # identical, no report noise
        if b is not None and m == b:
            write_out(rel, n); report["took_new"].append(rel); continue   # only new changed
        if b is not None and n == b:
            write_out(rel, m); report["kept"].append(rel); continue       # only mine changed

        # changed in both -> 3-way merge
        if have_git and b is not None:
            merged, ok = _git_merge_file(m, b, n)
            write_out(rel, merged)
            (report["merged"] if ok else report["conflicts"]).append(rel)
        else:
            write_out(rel, m); report["conflicts"].append(rel)        # no base/git -> keep mine, flag

    return report


def _git_merge_file(mine, base, new):
    """Run `git merge-file -p` on three temp files. Returns (bytes, ok)."""
    import tempfile
    d = tempfile.mkdtemp()
    try:
        pm, pb, pn = (os.path.join(d, x) for x in ("mine", "base", "new"))
        for p, data in ((pm, mine), (pb, base), (pn, new)):
            with open(p, "wb") as f:
                f.write(data)
        # -p prints result to stdout; exit code 0 = clean, >0 = conflict count
        res = subprocess.run(["git", "merge-file", "-p", pm, pb, pn], capture_output=True)
        return res.stdout, res.returncode == 0
    finally:
        shutil.rmtree(d, ignore_errors=True)
