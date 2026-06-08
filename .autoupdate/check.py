"""On-invocation auto-update check. Run by the SKILL.md auto-update block.

Prints exactly one of:
  UP_TO_DATE                  - nothing to do (also on any error/offline: never block the skill)
  UPDATED <version>           - silently updated in place (preference=auto); re-read SKILL.md
  CHOICE_NEEDED\n<json>       - the agent must present options to the user (manual/modified)

The <json> for CHOICE_NEEDED:
  { "skill","localVersion","remoteVersion","preference",
    "options":[{"id","label","desc"}...], "articleId" }

Usage:
  python3 check.py [--skill-dir DIR] [--force]   (DIR defaults to this script's parent)
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from common import (get_token, get_gateway, find_article, parse_install_block,  # noqa: E402
                    read_skill_version, is_newer)
from hashing import tree_hash  # noqa: E402

THROTTLE_SECONDS = 6 * 3600  # at most one live check per 6h unless --force


def skill_dir_from_args():
    if "--skill-dir" in sys.argv:
        return sys.argv[sys.argv.index("--skill-dir") + 1]
    return os.path.dirname(HERE)  # .autoupdate/ lives inside the skill


def load_state(autodir):
    try:
        with open(os.path.join(autodir, "state.json"), "r", encoding="utf-8") as f:
            return json.load(f)
    except OSError:
        return {}


def save_state(autodir, state):
    with open(os.path.join(autodir, "state.json"), "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    force = "--force" in sys.argv
    skill_dir = skill_dir_from_args()
    autodir = os.path.join(skill_dir, ".autoupdate")
    state = load_state(autodir)
    skill_name = state.get("skillName") or os.path.basename(skill_dir.rstrip("/"))

    # Throttle: skip a live check if we looked recently (keeps API cost ~0).
    if not force and state.get("lastCheck"):
        try:
            last = datetime.strptime(state["lastCheck"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            if (datetime.now(timezone.utc) - last).total_seconds() < THROTTLE_SECONDS:
                print("UP_TO_DATE")
                return
        except Exception:
            pass

    token = get_token()
    if not token:
        print("UP_TO_DATE")  # offline/no auth: never block the skill
        return
    gateway = get_gateway()

    article_id, body = find_article(skill_name, token, gateway, state.get("articleId"))
    # record the check time regardless (so we don't hammer the API)
    state["lastCheck"] = now_iso()
    if article_id:
        state["articleId"] = article_id
    save_state(autodir, state)

    if not body:
        print("UP_TO_DATE")
        return

    info = parse_install_block(body)
    remote_version = info.get("SKILL_VERSION")
    local_version = read_skill_version(skill_dir)
    if not remote_version or not is_newer(remote_version, local_version):
        print("UP_TO_DATE")
        return

    # Local-edit detection: if the tree changed since install, protect the user's
    # edits by switching to 'modified' before deciding what to do.
    pref = state.get("preference", "auto")
    base_hash = state.get("baseHash")
    if base_hash and pref == "auto":
        if tree_hash(skill_dir) != base_hash:
            pref = "modified"
            state["preference"] = "modified"
            save_state(autodir, state)

    artifact_id = info.get("ARTIFACT_ID")

    if pref == "auto":
        # Silent update.
        from apply_update import apply
        ok = apply(skill_dir, artifact_id, remote_version, mode="take-latest",
                   token=token, gateway=gateway)
        print(("UPDATED " + remote_version) if ok else "UP_TO_DATE")
        return

    # manual or modified -> the agent must ask the user.
    if pref == "modified":
        options = [
            {"id": "smart-merge", "label": "Smart merge",
             "desc": "Keep your local changes AND bring in the new version's improvements."},
            {"id": "take-latest", "label": "Use latest",
             "desc": "Replace with the new published version (discards your local edits)."},
            {"id": "keep-mine", "label": "Keep mine",
             "desc": "Stay on your edited copy; don't update."},
        ]
    else:  # manual
        options = [
            {"id": "take-latest", "label": "Update now",
             "desc": "Install the new published version."},
            {"id": "keep-mine", "label": "Not now", "desc": "Skip this update."},
        ]

    print("CHOICE_NEEDED")
    print(json.dumps({
        "skill": skill_name,
        "localVersion": local_version,
        "remoteVersion": remote_version,
        "preference": pref,
        "articleId": article_id,
        "artifactId": artifact_id,
        "options": options,
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never let an update check break the skill it guards.
        print("UP_TO_DATE")
