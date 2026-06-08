"""Apply a skill update: download the new ZIP, then take-latest / smart-merge /
keep-mine. Refreshes the pristine base and state.json afterward.

Usage (by the agent after a CHOICE_NEEDED, or internally for silent auto):
  python3 apply_update.py --skill-dir DIR --artifact-id ID --version V --mode MODE
  MODE = take-latest | smart-merge | keep-mine
"""

import json
import os
import shutil
import sys
import tempfile
import zipfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from common import get_token, get_gateway, devrev_post  # noqa: E402
from hashing import tree_hash  # noqa: E402
import merge as merge_mod  # noqa: E402


def _download_zip(artifact_id, token, gateway):
    resp = devrev_post("artifacts.locate", {"id": artifact_id}, token, gateway)
    url = resp.get("url")
    if not url:
        raise RuntimeError("no download URL for artifact")
    import urllib.request
    tmp = tempfile.mkdtemp()
    zpath = os.path.join(tmp, "skill.zip")
    with urllib.request.urlopen(url, timeout=30) as r, open(zpath, "wb") as f:
        f.write(r.read())
    return zpath


def _extract_new(zpath):
    """Extract the ZIP; return the path to the skill's root inside it."""
    tmp = tempfile.mkdtemp()
    with zipfile.ZipFile(zpath, "r") as zf:
        names = zf.namelist()
        zf.extractall(tmp)
    root_prefix = names[0].split("/")[0] if names else ""
    inner = os.path.join(tmp, root_prefix)
    return inner if os.path.isdir(inner) else tmp


def _copy_tree(src, dst, exclude=(".autoupdate",)):
    """Replace dst contents with src, preserving dst's excluded dirs."""
    preserved = {}
    for ex in exclude:
        p = os.path.join(dst, ex)
        if os.path.exists(p):
            tmp = tempfile.mkdtemp()
            shutil.move(p, os.path.join(tmp, ex))
            preserved[ex] = os.path.join(tmp, ex)
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    # drop any .autoupdate that came from the ZIP; restore the live one
    for ex in exclude:
        zipped = os.path.join(dst, ex)
        if os.path.exists(zipped):
            shutil.rmtree(zipped)
        if ex in preserved:
            shutil.move(preserved[ex], os.path.join(dst, ex))


def _refresh_base(skill_dir):
    """Snapshot the current tree (minus .autoupdate) as the new merge base."""
    autodir = os.path.join(skill_dir, ".autoupdate")
    base = os.path.join(autodir, "base")
    if os.path.exists(base):
        shutil.rmtree(base)
    os.makedirs(base, exist_ok=True)
    for rel, ab in _iter_skill_files(skill_dir):
        dest = os.path.join(base, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(ab, dest)
    return tree_hash(skill_dir)


def _iter_skill_files(root):
    from hashing import iter_files
    return iter_files(root)


def _update_state(skill_dir, version, preference=None):
    autodir = os.path.join(skill_dir, ".autoupdate")
    spath = os.path.join(autodir, "state.json")
    try:
        with open(spath, "r", encoding="utf-8") as f:
            state = json.load(f)
    except OSError:
        state = {}
    state["installedVersion"] = version
    state["baseHash"] = tree_hash(skill_dir)
    state["lastCheck"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if preference:
        state["preference"] = preference
    with open(spath, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def apply(skill_dir, artifact_id, version, mode="take-latest", token=None, gateway=None):
    """Apply an update. Returns True on success, False otherwise."""
    token = token or get_token()
    gateway = gateway or get_gateway()
    if mode == "keep-mine":
        # No file changes — the user stays on their copy. Leave preference as-is
        # ('modified'/'manual') so we keep asking on the next newer version.
        return False
    if not artifact_id or not token:
        return False

    try:
        zpath = _download_zip(artifact_id, token, gateway)
        new_dir = _extract_new(zpath)
    except Exception as e:
        print(f"[autoupdate] download/extract failed: {e}", file=sys.stderr)
        return False

    autodir = os.path.join(skill_dir, ".autoupdate")
    base_dir = os.path.join(autodir, "base")

    if mode == "smart-merge" and os.path.isdir(base_dir):
        out = tempfile.mkdtemp()
        report = merge_mod.merge_trees(base_dir, skill_dir, new_dir, out)
        _copy_tree(out, skill_dir)
        # After a merge, the user's tree == merged result; set that as new base
        # AND keep preference 'modified' (they still have a customized copy).
        _refresh_base(skill_dir)
        _update_state(skill_dir, version, preference="modified")
        print(f"[autoupdate] smart-merge: merged={len(report['merged'])} "
              f"took_new={len(report['took_new'])} kept={len(report['kept'])} "
              f"conflicts={len(report['conflicts'])}", file=sys.stderr)
        return True

    # take-latest (default + silent auto path)
    _copy_tree(new_dir, skill_dir)
    _refresh_base(skill_dir)
    # take-latest resets them to pristine published version → back to 'auto'.
    _update_state(skill_dir, version, preference="auto")
    return True


def main():
    args = sys.argv
    def opt(name, default=None):
        return args[args.index(name) + 1] if name in args else default
    skill_dir = opt("--skill-dir", os.path.dirname(HERE))
    artifact_id = opt("--artifact-id")
    version = opt("--version", "0.0.0")
    mode = opt("--mode", "take-latest")
    ok = apply(skill_dir, artifact_id, version, mode=mode)
    print(json.dumps({"ok": ok, "mode": mode, "version": version}))


if __name__ == "__main__":
    main()
