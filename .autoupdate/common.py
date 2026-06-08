"""Shared helpers for the skill auto-updater: token/gateway, API calls, semver,
SKILL.md version parsing, and the article install-block parser.
"""

import json
import os
import re
import sys
import urllib.request
import urllib.error

DEFAULT_GATEWAY = "https://app.devrev.ai/api/gateway/internal"


def get_token():
    """Token Computer injects (DEVREV_API_KEY) or pat-manager's DEVREV_PAT/TOKEN."""
    return (os.environ.get("DEVREV_API_KEY")
            or os.environ.get("DEVREV_TOKEN")
            or os.environ.get("DEVREV_PAT"))


def get_gateway():
    return os.environ.get("DEVREV_GATEWAY_URL", DEFAULT_GATEWAY)


def devrev_post(endpoint, body, token, gateway):
    """POST to a gateway endpoint. Returns parsed JSON or raises."""
    url = f"{gateway.rstrip('/')}/{endpoint}"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Authorization", token)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_semver(v):
    """'1.2.3' -> (1,2,3). Missing/garbage -> (0,0,0). Tolerates a leading 'v'."""
    if not v:
        return (0, 0, 0)
    s = str(v).strip().lstrip("vV")
    parts = re.split(r"[.\-+]", s)
    out = []
    for p in parts[:3]:
        try:
            out.append(int(p))
        except ValueError:
            out.append(0)
    while len(out) < 3:
        out.append(0)
    return tuple(out[:3])


def is_newer(remote, local):
    """True iff remote semver is strictly greater than local."""
    return parse_semver(remote) > parse_semver(local)


def read_skill_version(skill_dir):
    """Read `version:` from SKILL.md frontmatter. '0.0.0' if absent."""
    path = os.path.join(skill_dir, "SKILL.md")
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return "0.0.0"
    m = re.search(r"^version:\s*([^\s]+)\s*$", text, re.MULTILINE)
    return m.group(1).strip() if m else "0.0.0"


def parse_install_block(article_body):
    """Extract SKILL_VERSION / SKILL_NAME / ARTIFACT_ID from an article body."""
    out = {}
    for key in ("SKILL_VERSION", "SKILL_NAME", "ARTIFACT_ID"):
        m = re.search(r"^%s:\s*(.+)$" % key, article_body or "", re.MULTILINE)
        if m:
            out[key] = m.group(1).strip()
    return out


def find_article(skill_name, token, gateway, article_id=None):
    """Return (article_id, body) for a skill's [Skill Store] article, or (None, None)."""
    if article_id:
        try:
            resp = devrev_post("articles.get", {"id": article_id}, token, gateway)
            art = resp.get("article") or {}
            body = _article_body_text(art)
            if body:
                return article_id, body
        except Exception:
            pass  # fall through to search
    title = f"[Skill Store] {skill_name}"
    try:
        resp = devrev_post("articles.list", {"filter": {"title": [title]}, "limit": 5}, token, gateway)
    except Exception:
        return None, None
    arts = resp.get("articles", [])
    if not arts:
        return None, None
    art = arts[0]
    return art.get("id"), _article_body_text(art)


def _article_body_text(art):
    """Articles store body in different shapes; pull the markdown text out."""
    if not art:
        return None
    for key in ("body", "text", "description"):
        v = art.get(key)
        if isinstance(v, str) and v:
            return v
    # some shapes nest under 'body' as an object
    b = art.get("body")
    if isinstance(b, dict):
        return b.get("text") or b.get("markdown")
    return None
