#!/usr/bin/env python3
"""
UI Publisher (public) — uploads HTML files to DevRev with composable access control.

USAGE MODES
-----------
  Publish a new page:
    publisher.py --file <path> --name <title> --access {personal|internal|public}
                 [--author <name>]
                 [--share-with-emails alice@x.com,bob@x.com]
                 [--share-with-groups "Devrev Design,Engineering"]
                 [--share-with-group-urls https://app.devrev.ai/.../group/123,...]

  Update sharing on an existing page (does NOT re-upload content):
    publisher.py --update-access <article-id>
                 [--access {personal|internal}]
                 [--add-emails ...] [--add-groups ...] [--add-group-urls ...]
                 [--remove-emails ...] [--remove-groups ...]

  List recent publishes (for "what did I share recently?"):
    publisher.py --list-recent [N]   # default N=20

ACCESS MODES
------------
  personal  — owner-only article. shared_with=[]. Combinable with --share-with-*.
  internal  — adds the org-wide "All Users" group. Combinable with --share-with-*.
  public    — no article; returns a 7-day pre-signed S3 URL (no DevRev auth).
              Ignores --share-with-* (S3 URL is the only knob here).

The viewer (devrev-artifact-viewer.vercel.app) fetches the article via
articles.get and reads the embedded original_url. So whoever can read the
article can read the page; whoever can't gets 403.

A persistent cache at ~/.config/devrev-ui-publisher/recently_shared_with.json
remembers recent publishes and resolved targets, powering reverse-lookup queries
and "share like last time" workflows.

Reads DEVREV_TOKEN (or DEVREV_PAT as fallback) from environment.
Use DEVREV_GATEWAY_URL to override the API base for non-prod orgs.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

try:
    import mimetypes
except ImportError:
    mimetypes = None

if sys.version_info < (3, 8):
    print(json.dumps({"error": True, "message": "Python 3.8+ required"}))
    sys.exit(1)

VIEWER_BASE = "https://devrev-artifact-viewer.vercel.app"
SCOPE_INTERNAL = 1
ALL_USERS_NAME_ALLOWLIST = ("All Users", "Everyone", "All Members", "Default")
ALL_USERS_FALLBACK_SUFFIX = "group/default9"

# Persistent cache lives outside the skill folder so it survives reinstalls.
CACHE_DIR = os.path.expanduser("~/.config/devrev-ui-publisher")
CACHE_FILE = os.path.join(CACHE_DIR, "recently_shared_with.json")
CACHE_RESOLUTION_LIMIT = 100   # most recent + most frequent
CACHE_PUBLISH_LIMIT = 50        # most recent publishes


# ─────────────────────────────────────────────────────────────────────────────
# Environment / HTTP plumbing
# ─────────────────────────────────────────────────────────────────────────────

def get_gateway():
    """Return the DevRev gateway base URL from env or the production default."""
    return os.environ.get(
        "DEVREV_GATEWAY_URL",
        "https://app.devrev.ai/api/gateway/internal",
    )


def get_pat():
    """Read DevRev token from env. Primary: DEVREV_TOKEN. Fallback: DEVREV_PAT."""
    pat = os.environ.get("DEVREV_TOKEN", "").strip() or os.environ.get("DEVREV_PAT", "").strip()
    if not pat:
        print(json.dumps({"error": True, "message": "DEVREV_TOKEN environment variable is not set (DEVREV_PAT also accepted as fallback)"}))
        sys.exit(1)
    return pat


def devrev_post(endpoint, body, pat, gateway):
    """POST a JSON body to a DevRev gateway endpoint. Exits 1 on any failure."""
    url = f"{gateway}/{endpoint}"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"Authorization": pat, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8")
        print(json.dumps({"error": True, "message": f"HTTP {e.code} from {endpoint}: {body_text}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": True, "message": f"Request failed: {str(e)}"}))
        sys.exit(1)


def devrev_post_nofail(endpoint, body, pat, gateway):
    """Like devrev_post but returns None on any failure instead of exiting."""
    url = f"{gateway}/{endpoint}"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"Authorization": pat, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Identity / org / role helpers
# ─────────────────────────────────────────────────────────────────────────────

def get_current_user(pat, gateway):
    """Return (id, full_name) of the calling user."""
    resp = devrev_post_nofail("dev-users.self", {}, pat, gateway)
    if resp and "dev_user" in resp:
        u = resp["dev_user"]
        return u.get("id"), u.get("full_name") or u.get("display_name")
    return None, None


def get_org_slug(pat, gateway):
    """Return the calling org's dev_slug (e.g. 'devrev'), or None on failure.

    Used to embed an org-aware help link in the viewer URL so the recipient's
    'how do I get a PAT?' link points at THEIR org's settings page.
    """
    resp = devrev_post_nofail("dev-orgs.self", {}, pat, gateway)
    if resp and "dev_org" in resp:
        return resp["dev_org"].get("dev_slug")
    return None


def get_default_part(pat, gateway):
    """Return any part ID — articles.create requires applies_to_parts non-empty."""
    resp = devrev_post_nofail("parts.list", {"limit": 1}, pat, gateway)
    if resp and resp.get("parts"):
        return resp["parts"][0]["id"]
    return None


def get_viewer_role(pat, gateway):
    """Resolve the article-target 'Viewer' role ID (read-only)."""
    resp = devrev_post_nofail("roles.list", {"target": "article"}, pat, gateway)
    if resp:
        for role in resp.get("roles", []):
            if role.get("name") == "Viewer":
                return role["id"]
    return None


def org_prefix_from_user_id(user_id):
    """Extract the 'don:identity:<region>:devo/<org>' prefix from a dev_user DON."""
    if not user_id or ":devu/" not in user_id:
        return None
    return user_id.split(":devu/", 1)[0]


# ─────────────────────────────────────────────────────────────────────────────
# Group resolution (layered: name allowlist → dynamic_group_info → fallback DON)
# ─────────────────────────────────────────────────────────────────────────────

def is_dynamic_all_devu_group(group_record):
    """True if the group's dynamic membership rule is 'every dev_user in the org'."""
    dgi = group_record.get("dynamic_group_info") or {}
    expr = dgi.get("membership_expression") or {}
    if expr.get("operator") != "eq":
        return False
    if (expr.get("key") or {}).get("attribute") != "object_type":
        return False
    if (expr.get("value") or {}).get("string") != "devu":
        return False
    return True


def list_all_groups(pat, gateway, max_pages=20):
    """Walk groups.list and return every group record (full pagination)."""
    out = []
    cursor = None
    for _ in range(max_pages):
        body = {"limit": 100}
        if cursor:
            body["cursor"] = cursor
        resp = devrev_post_nofail("groups.list", body, pat, gateway)
        if not resp:
            break
        out.extend(resp.get("groups", []))
        cursor = resp.get("next_cursor")
        if not cursor:
            break
    return out


def resolve_all_users_group(pat, gateway, org_prefix):
    """Find the org-wide 'every dev_user' group. Returns (group_id, signal).

    Signal is one of: name_allowlist, dynamic_group_info, fallback_don, none.
    """
    groups = list_all_groups(pat, gateway)

    # Strategy 1: exact name match against allowlist
    by_name = {g.get("name"): g for g in groups if g.get("name")}
    for name in ALL_USERS_NAME_ALLOWLIST:
        if name in by_name:
            return by_name[name]["id"], "name_allowlist"

    # Strategy 2: per-group dynamic_group_info verification (narrowed by name regex)
    candidate_re = re.compile(r"\b(all|everyone|default|members?)\b", re.I)
    candidates = [g for g in groups if g.get("name") and candidate_re.search(g["name"])]
    for g in candidates:
        full = devrev_post_nofail("groups.get", {"id": g["id"]}, pat, gateway)
        if full and is_dynamic_all_devu_group(full.get("group", {})):
            return g["id"], "dynamic_group_info"

    # Strategy 3: constructed fallback DON from caller's own org
    if org_prefix:
        return f"{org_prefix}:{ALL_USERS_FALLBACK_SUFFIX}", "fallback_don"

    return None, "none"


def resolve_groups_by_name(names, pat, gateway):
    """Resolve a list of group names (exact match) to (resolved, unresolved)."""
    resolved, unresolved = [], []
    cleaned = [n.strip() for n in names if n and n.strip()]
    if not cleaned:
        return resolved, unresolved
    all_groups = list_all_groups(pat, gateway)
    by_name = {g.get("name"): g for g in all_groups if g.get("name")}
    for name in cleaned:
        g = by_name.get(name)
        if g:
            resolved.append({"name": name, "id": g["id"]})
        else:
            unresolved.append(name)
    return resolved, unresolved


GROUP_URL_RE = re.compile(r"group/([A-Za-z0-9_\-]+)")


def parse_group_urls(urls, org_prefix):
    """Parse DevRev UI group URLs into DON IDs. Returns (resolved, unresolved).

    Accepts forms like:
      https://app.devrev.ai/<slug>/groups/group/123
      .../group/default9
    Anything matching `group/<id>` is extracted; the DON is reconstructed using
    the caller's own org prefix (so we never leak a different org's DON).
    """
    resolved, unresolved = [], []
    cleaned = [u.strip() for u in urls if u and u.strip()]
    for url in cleaned:
        m = GROUP_URL_RE.search(url)
        if m and org_prefix:
            resolved.append({"url": url, "id": f"{org_prefix}:group/{m.group(1)}"})
        else:
            unresolved.append(url)
    return resolved, unresolved


# ─────────────────────────────────────────────────────────────────────────────
# User (email) resolution
# ─────────────────────────────────────────────────────────────────────────────

def resolve_emails_to_user_ids(emails, pat, gateway):
    """Resolve emails to dev_user DON IDs via dev-users.list filter."""
    resolved, unresolved = [], []
    cleaned = [e.strip() for e in emails if e and e.strip()]
    for email in cleaned:
        resp = devrev_post_nofail("dev-users.list", {"email": [email], "limit": 1}, pat, gateway)
        users = (resp or {}).get("dev_users", [])
        if users:
            u = users[0]
            resolved.append({
                "email": email,
                "id": u.get("id"),
                "name": u.get("full_name") or u.get("display_name") or email,
            })
        else:
            unresolved.append(email)
    return resolved, unresolved


# ─────────────────────────────────────────────────────────────────────────────
# Persistent cache (resolutions + recent publishes)
# ─────────────────────────────────────────────────────────────────────────────

def _load_cache():
    """Load cache from disk. Returns dict with 'resolutions' and 'publishes' keys."""
    if not os.path.isfile(CACHE_FILE):
        return {"resolutions": {}, "publishes": []}
    try:
        with open(CACHE_FILE, "r") as f:
            data = json.load(f)
        data.setdefault("resolutions", {})
        data.setdefault("publishes", [])
        data.setdefault("org_slug", None)
        return data
    except Exception:
        return {"resolutions": {}, "publishes": [], "org_slug": None}


def _save_cache(data):
    """Write cache to disk, ensuring directory exists."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = CACHE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, CACHE_FILE)


def remember_resolutions(items):
    """Record resolutions of {label, id, kind} so they can be suggested later.

    label: human handle (email, group name)
    id: DON ID
    kind: 'email' | 'group_name' | 'group_url'
    """
    if not items:
        return
    data = _load_cache()
    res = data["resolutions"]
    now = int(time.time())
    for it in items:
        key = f"{it['kind']}::{it['label']}"
        prev = res.get(key, {})
        res[key] = {
            "label": it["label"],
            "id": it["id"],
            "kind": it["kind"],
            "name": it.get("name") or it["label"],
            "last_used": now,
            "count": prev.get("count", 0) + 1,
        }
    # LRU prune
    if len(res) > CACHE_RESOLUTION_LIMIT:
        sorted_items = sorted(res.items(), key=lambda kv: kv[1]["last_used"], reverse=True)
        data["resolutions"] = dict(sorted_items[:CACHE_RESOLUTION_LIMIT])
    _save_cache(data)


def forget_resolutions(ids):
    """Remove cache entries by DON ID. Called when a target turns out to be stale."""
    if not ids:
        return
    data = _load_cache()
    data["resolutions"] = {k: v for k, v in data["resolutions"].items() if v.get("id") not in ids}
    _save_cache(data)


def record_publish(article_id, page_name, access, viewer_url, share_targets):
    """Append a publish event. share_targets: list of {kind, label, id} dicts."""
    data = _load_cache()
    entry = {
        "article_id": article_id,
        "page_name": page_name,
        "access": access,
        "viewer_url": viewer_url,
        "share_targets": share_targets,
        "ts": int(time.time()),
    }
    data["publishes"].insert(0, entry)
    if len(data["publishes"]) > CACHE_PUBLISH_LIMIT:
        data["publishes"] = data["publishes"][:CACHE_PUBLISH_LIMIT]
    _save_cache(data)


def list_recent_publishes(limit):
    """Return up to `limit` most recent publishes from cache."""
    data = _load_cache()
    return data["publishes"][:limit]


def update_publish_share_targets(article_id, share_targets, viewer_url=None):
    """Replace share_targets for a recorded publish (after --update-access).

    If viewer_url is provided (e.g. when we have a fresh slug-aware URL), it
    overwrites the stored URL too — useful for backfilling pre-org-slug entries.
    """
    data = _load_cache()
    for entry in data["publishes"]:
        if entry["article_id"] == article_id:
            entry["share_targets"] = share_targets
            if viewer_url is not None:
                entry["viewer_url"] = viewer_url
            entry["ts"] = int(time.time())
            break
    _save_cache(data)


def remember_org_slug(slug):
    """Persist the calling org's dev_slug at the top of the cache.

    Stored once per org (this skill is single-org per install). Used by
    --list-recent to backfill missing &org= on URLs minted before the slug
    plumbing was added.
    """
    if not slug:
        return
    data = _load_cache()
    if data.get("org_slug") != slug:
        data["org_slug"] = slug
        _save_cache(data)


def backfill_org_slug_in_url(url, slug):
    """If the URL is a viewer URL that lacks &org=, append it. Otherwise return as-is.

    Public-mode URLs (raw S3) and URLs that already have &org= are untouched.
    """
    if not url or not slug:
        return url
    # Raw S3 URLs aren't viewer URLs — skip.
    if not url.startswith(VIEWER_BASE):
        return url
    if "org=" in url:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}org={urllib.parse.quote(slug, safe='')}"


# ─────────────────────────────────────────────────────────────────────────────
# Artifact upload (two-step: prepare → S3 multipart POST)
# ─────────────────────────────────────────────────────────────────────────────

def upload_file(file_path, pat, gateway):
    """Upload a file to DevRev artifacts. Returns the artifact DON ID."""
    file_name = os.path.basename(file_path)
    mime_type = (mimetypes.guess_type(file_path)[0] if mimetypes else None) or "text/html"

    prepare_resp = devrev_post(
        "artifacts.prepare",
        {"file_name": file_name, "file_type": mime_type},
        pat, gateway,
    )
    artifact_id = prepare_resp.get("id")
    upload_url = prepare_resp.get("url")
    form_data = prepare_resp.get("form_data", [])
    if not artifact_id or not upload_url:
        print(json.dumps({"error": True, "message": "Prepare response missing artifact ID or upload URL"}))
        sys.exit(1)

    boundary = f"----WebKitFormBoundary{uuid.uuid4().hex[:16]}"
    with open(file_path, "rb") as f:
        file_data = f.read()

    parts = []
    for field in form_data:
        parts.append(f'--{boundary}\r\n'.encode())
        parts.append(f'Content-Disposition: form-data; name="{field["key"]}"\r\n\r\n'.encode())
        parts.append(f'{field["value"]}\r\n'.encode())
    parts.append(f'--{boundary}\r\n'.encode())
    parts.append(f'Content-Disposition: form-data; name="file"; filename="{file_name}"\r\n'.encode())
    parts.append(f'Content-Type: {mime_type}\r\n\r\n'.encode())
    parts.append(file_data)
    parts.append(f'\r\n--{boundary}--\r\n'.encode())
    body = b''.join(parts)

    req = urllib.request.Request(
        upload_url, data=body, method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            if resp.status not in (200, 201, 204):
                print(json.dumps({"error": True, "message": f"S3 upload returned status {resp.status}"}))
                sys.exit(1)
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8") if e.fp else ""
        print(json.dumps({"error": True, "message": f"S3 upload failed: HTTP {e.code} - {body_text}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": True, "message": f"Upload failed: {str(e)}"}))
        sys.exit(1)

    return artifact_id


# ─────────────────────────────────────────────────────────────────────────────
# Article create / update / locate
# ─────────────────────────────────────────────────────────────────────────────

def create_article(title, owner_id, part_id, artifact_id, shared_with_entries, pat, gateway):
    """Create a new article wrapping a single artifact. Returns the article DON ID."""
    body = {
        "title": title,
        "status": "published",
        "scope": SCOPE_INTERNAL,
        "owned_by": [owner_id],
        "applies_to_parts": [part_id],
        "shared_with": shared_with_entries,
        "resource": {"artifacts": [artifact_id]},
    }
    resp = devrev_post("articles.create", body, pat, gateway)
    article = resp.get("article")
    if not article or "id" not in article:
        print(json.dumps({"error": True, "message": f"articles.create returned unexpected shape: {resp}"}))
        sys.exit(1)
    return article["id"]


def get_article(article_id, pat, gateway):
    """Fetch an article record. Returns the inner article dict, or None."""
    resp = devrev_post_nofail("articles.get", {"id": article_id}, pat, gateway)
    return (resp or {}).get("article")


def update_article_shared_with(article_id, shared_with_entries, pat, gateway):
    """Replace the shared_with list on an existing article. Returns the updated article."""
    body = {
        "id": article_id,
        "shared_with": {"set": [
            {"member": e["member"], "role": e["role"]} for e in shared_with_entries
        ]},
    }
    resp = devrev_post("articles.update", body, pat, gateway)
    return resp.get("article")


def locate_artifact(artifact_id, pat, gateway):
    """Mint a 7-day pre-signed S3 URL via artifacts.locate.

    Returns (signed_url, expires_at_iso). The URL is publicly accessible.
    """
    resp = devrev_post("artifacts.locate", {"id": artifact_id}, pat, gateway)
    return resp.get("url"), resp.get("expires_at")


def build_viewer_url(article_id, title, author, org_slug=None):
    """Build the viewer URL with ?page=<id>&title=...&author=...&org=<slug>.

    The optional `org` param lets the viewer build an org-aware 'get a PAT'
    help link. If omitted, the viewer hides that link instead of showing a
    broken default.
    """
    encoded_id = urllib.parse.quote(article_id, safe="")
    encoded_title = urllib.parse.quote(title, safe="")
    encoded_author = urllib.parse.quote(author, safe="")
    url = (
        f"{VIEWER_BASE}/?page={encoded_id}"
        f"&title={encoded_title}"
        f"&author={encoded_author}"
    )
    if org_slug:
        url += f"&org={urllib.parse.quote(org_slug, safe='')}"
    return url


# ─────────────────────────────────────────────────────────────────────────────
# Sharing target composition
# ─────────────────────────────────────────────────────────────────────────────

def compose_shared_with(emails, group_names, group_urls, include_all_users,
                         viewer_role, pat, gateway, org_prefix, owner_id):
    """Resolve all share inputs, dedupe, and return (entries, summary).

    entries: list of {member, role} dicts ready for articles.create / update.
    summary: dict with keys:
      - all_users_group: {id, signal} or None
      - emails:    {resolved: [...], unresolved: [...]}
      - groups:    {resolved: [...], unresolved: [...]}
      - group_urls:{resolved: [...], unresolved: [...]}
    """
    entries = []
    seen = set()
    summary = {
        "all_users_group": None,
        "emails": {"resolved": [], "unresolved": []},
        "groups": {"resolved": [], "unresolved": []},
        "group_urls": {"resolved": [], "unresolved": []},
    }

    def add(member_id):
        if member_id and member_id != owner_id and member_id not in seen:
            entries.append({"member": member_id, "role": viewer_role})
            seen.add(member_id)

    if include_all_users:
        gid, signal = resolve_all_users_group(pat, gateway, org_prefix)
        if not gid:
            return None, summary  # caller surfaces error
        summary["all_users_group"] = {"id": gid, "signal": signal}
        add(gid)

    if emails:
        resolved, unresolved = resolve_emails_to_user_ids(emails, pat, gateway)
        summary["emails"] = {"resolved": resolved, "unresolved": unresolved}
        for u in resolved:
            add(u["id"])

    if group_names:
        resolved, unresolved = resolve_groups_by_name(group_names, pat, gateway)
        summary["groups"] = {"resolved": resolved, "unresolved": unresolved}
        for g in resolved:
            add(g["id"])

    if group_urls:
        resolved, unresolved = parse_group_urls(group_urls, org_prefix)
        summary["group_urls"] = {"resolved": resolved, "unresolved": unresolved}
        for g in resolved:
            add(g["id"])

    return entries, summary


def share_summary_to_targets(summary, access):
    """Convert the resolution summary into the cache-friendly share_targets list."""
    targets = []
    if summary.get("all_users_group"):
        targets.append({
            "kind": "all_users_group",
            "label": "All Users (org)",
            "id": summary["all_users_group"]["id"],
        })
    for u in summary["emails"]["resolved"]:
        targets.append({"kind": "email", "label": u["email"], "id": u["id"], "name": u.get("name")})
    for g in summary["groups"]["resolved"]:
        targets.append({"kind": "group_name", "label": g["name"], "id": g["id"]})
    for g in summary["group_urls"]["resolved"]:
        targets.append({"kind": "group_url", "label": g["url"], "id": g["id"]})
    return targets


def resolutions_for_cache(summary):
    """Pick out the entries to remember in the resolutions cache."""
    items = []
    for u in summary["emails"]["resolved"]:
        items.append({"kind": "email", "label": u["email"], "id": u["id"], "name": u.get("name")})
    for g in summary["groups"]["resolved"]:
        items.append({"kind": "group_name", "label": g["name"], "id": g["id"], "name": g["name"]})
    return items


# ─────────────────────────────────────────────────────────────────────────────
# Mode handlers
# ─────────────────────────────────────────────────────────────────────────────

def parse_csv_arg(s):
    """Split a comma-separated CLI arg. Returns [] for empty/None input."""
    if not s:
        return []
    return [x.strip() for x in s.split(",") if x.strip()]


def cmd_list_recent(args):
    """--list-recent: emit the cache's recent publishes.

    Backfills &org= on entries minted before slug plumbing existed, using the
    cached org_slug. The cache itself is NOT mutated — backfill is read-only
    so old entries can be re-shared cleanly without an extra publish.
    """
    limit = args.list_recent if isinstance(args.list_recent, int) and args.list_recent > 0 else 20
    publishes = list_recent_publishes(limit)
    cache = _load_cache()
    cached_slug = cache.get("org_slug")
    if cached_slug:
        for p in publishes:
            if p.get("viewer_url"):
                p["viewer_url"] = backfill_org_slug_in_url(p["viewer_url"], cached_slug)
    print(json.dumps({
        "recent_publishes": publishes,
        "count": len(publishes),
        "org_slug": cached_slug,
    }, indent=2))


def cmd_publish(args, pat, gateway):
    """Default action: upload + create article (or get S3 URL for public)."""
    if not os.path.isfile(args.file):
        print(json.dumps({"error": True, "message": f"File not found: {args.file}"}))
        sys.exit(1)

    user_id, user_name = get_current_user(pat, gateway)
    if not user_id:
        print(json.dumps({"error": True, "message": "Could not resolve calling user via dev-users.self"}))
        sys.exit(1)

    author = args.author or user_name or "Unknown"
    org_prefix = org_prefix_from_user_id(user_id)
    org_slug = get_org_slug(pat, gateway)  # may be None — non-fatal
    remember_org_slug(org_slug)             # persist for offline list-recent backfill

    print(f"Uploading {args.file} ...", file=sys.stderr)
    artifact_id = upload_file(args.file, pat, gateway)

    result = {
        "artifact_id": artifact_id,
        "page_name": args.name,
        "author": author,
        "access": args.access,
    }

    if args.access == "public":
        if any([args.share_with_emails, args.share_with_groups, args.share_with_group_urls]):
            print("Note: --share-with-* flags are ignored for --access public.", file=sys.stderr)
        signed_url, expires_at = locate_artifact(artifact_id, pat, gateway)
        if not signed_url:
            print(json.dumps({"error": True, "message": "artifacts.locate did not return a URL"}))
            sys.exit(1)
        result["public_url"] = signed_url
        result["expires_at"] = expires_at
        result["markdown_link"] = f"[{args.name}]({signed_url})"
        result["note"] = (
            "Public mode: this URL works without DevRev auth until expires_at "
            "(7 days, server-controlled). After expiry, re-run the publisher to mint a new URL."
        )
        # Public publishes are also recorded in cache (no article ID).
        record_publish(
            article_id=None, page_name=args.name, access="public",
            viewer_url=signed_url, share_targets=[],
        )
        print(json.dumps(result, indent=2))
        return

    # Personal / internal both wrap the artifact in an article
    part_id = get_default_part(pat, gateway)
    if not part_id:
        print(json.dumps({"error": True, "message": "Could not resolve a default part for applies_to_parts"}))
        sys.exit(1)

    viewer_role = get_viewer_role(pat, gateway)
    if not viewer_role:
        print(json.dumps({"error": True, "message": "Could not resolve the article 'Viewer' role"}))
        sys.exit(1)

    emails = parse_csv_arg(args.share_with_emails)
    group_names = parse_csv_arg(args.share_with_groups)
    group_urls = parse_csv_arg(args.share_with_group_urls)
    include_all_users = (args.access == "internal")

    entries, summary = compose_shared_with(
        emails, group_names, group_urls, include_all_users,
        viewer_role, pat, gateway, org_prefix, user_id,
    )

    if entries is None:
        # Internal mode requested but All Users couldn't be resolved.
        print(json.dumps({
            "error": True,
            "message": (
                "Internal mode requires an org-wide 'All Users' group. None could be found in your DevRev org. "
                f"Tried name allowlist {list(ALL_USERS_NAME_ALLOWLIST)}, dynamic_group_info verification, "
                "and the system-default DON suffix. Either ask your DevRev admin to create an org-wide group, "
                "or use --access personal with --share-with-emails / --share-with-groups / --share-with-group-urls."
            ),
        }))
        sys.exit(1)

    article_id = create_article(args.name, user_id, part_id, artifact_id, entries, pat, gateway)
    result["article_id"] = article_id
    viewer = build_viewer_url(article_id, args.name, author, org_slug=org_slug)
    result["viewer_url"] = viewer
    result["markdown_link"] = f"[{args.name}]({viewer})"
    result["share_summary"] = summary

    # Surface unresolved inputs as a warning (non-fatal).
    unresolved_total = (
        summary["emails"]["unresolved"]
        + summary["groups"]["unresolved"]
        + summary["group_urls"]["unresolved"]
    )
    if unresolved_total:
        result["unresolved"] = {
            "emails": summary["emails"]["unresolved"],
            "groups": summary["groups"]["unresolved"],
            "group_urls": summary["group_urls"]["unresolved"],
        }
        result["unresolved_warning"] = (
            "Some share targets could not be resolved and were skipped. "
            "The article was created with the resolvable targets only."
        )

    # Build human-readable note
    target_count = len(entries) - (1 if summary.get("all_users_group") else 0)
    if args.access == "internal":
        result["note"] = (
            "Internal mode: shared with the org-wide 'All Users' group "
            f"(resolved via {summary['all_users_group']['signal']})"
            + (f" plus {target_count} additional target(s)" if target_count else "")
            + ". Any of those identities can open the page with their DevRev PAT."
        )
    else:  # personal
        if target_count:
            result["note"] = f"Personal mode + shared with {target_count} additional target(s)."
        else:
            result["note"] = "Personal mode: only your DevRev PAT can read the page."

    # Persist to cache
    targets_for_cache = share_summary_to_targets(summary, args.access)
    record_publish(article_id, args.name, args.access, viewer, targets_for_cache)
    remember_resolutions(resolutions_for_cache(summary))

    print(json.dumps(result, indent=2))


def cmd_update_access(args, pat, gateway):
    """--update-access <article_id>: change ACL on existing article."""
    article_id = args.update_access
    user_id, _ = get_current_user(pat, gateway)
    if not user_id:
        print(json.dumps({"error": True, "message": "Could not resolve calling user via dev-users.self"}))
        sys.exit(1)
    org_prefix = org_prefix_from_user_id(user_id)

    article = get_article(article_id, pat, gateway)
    if not article:
        print(json.dumps({"error": True, "message": f"Could not fetch article {article_id} (not found or not authorized)"}))
        sys.exit(1)

    viewer_role = get_viewer_role(pat, gateway)
    if not viewer_role:
        print(json.dumps({"error": True, "message": "Could not resolve the article 'Viewer' role"}))
        sys.exit(1)

    # Resolve org slug for the viewer URL we'll return
    org_slug = get_org_slug(pat, gateway)
    remember_org_slug(org_slug)

    # Build base set from current shared_with on the article
    current = []
    seen_ids = set()
    for entry in article.get("shared_with", []):
        member = entry.get("member") or {}
        role = entry.get("role") or {}
        mid = member.get("id") if isinstance(member, dict) else member
        rid = role.get("id") if isinstance(role, dict) else role
        if mid and rid and mid not in seen_ids:
            current.append({"member": mid, "role": rid})
            seen_ids.add(mid)

    # Optional --access flip: add/remove the All Users group
    new_set = list(current)
    new_seen = set(seen_ids)

    def remove_member(mid):
        nonlocal new_set, new_seen
        new_set = [e for e in new_set if e["member"] != mid]
        new_seen.discard(mid)

    def add_member(mid):
        nonlocal new_set, new_seen
        if mid and mid != user_id and mid not in new_seen:
            new_set.append({"member": mid, "role": viewer_role})
            new_seen.add(mid)

    flip_summary = {"all_users_group": None}
    if args.access == "internal":
        gid, signal = resolve_all_users_group(pat, gateway, org_prefix)
        if not gid:
            print(json.dumps({"error": True, "message": "Could not resolve 'All Users' group for internal flip"}))
            sys.exit(1)
        add_member(gid)
        flip_summary["all_users_group"] = {"id": gid, "signal": signal, "action": "added"}
    elif args.access == "personal":
        # Strip any all-users-shaped group entry. Conservative: drop anything
        # ending in :group/<id> whose name resolves to one of the allowlist.
        # Cheaper heuristic: drop the constructed default9 DON, plus any group
        # in the current list whose name matches the allowlist via groups.list.
        group_ids_in_current = [e["member"] for e in current if ":group/" in e["member"]]
        if group_ids_in_current:
            # Look up names
            for gid in group_ids_in_current:
                full = devrev_post_nofail("groups.get", {"id": gid}, pat, gateway)
                gname = (full or {}).get("group", {}).get("name")
                if gname in ALL_USERS_NAME_ALLOWLIST:
                    remove_member(gid)
                    flip_summary["all_users_group"] = {"id": gid, "name": gname, "action": "removed"}

    # Add new targets
    add_emails = parse_csv_arg(args.add_emails)
    add_groups = parse_csv_arg(args.add_groups)
    add_group_urls = parse_csv_arg(args.add_group_urls)

    add_summary = {
        "emails": {"resolved": [], "unresolved": []},
        "groups": {"resolved": [], "unresolved": []},
        "group_urls": {"resolved": [], "unresolved": []},
    }
    if add_emails:
        r, u = resolve_emails_to_user_ids(add_emails, pat, gateway)
        add_summary["emails"] = {"resolved": r, "unresolved": u}
        for x in r: add_member(x["id"])
    if add_groups:
        r, u = resolve_groups_by_name(add_groups, pat, gateway)
        add_summary["groups"] = {"resolved": r, "unresolved": u}
        for x in r: add_member(x["id"])
    if add_group_urls:
        r, u = parse_group_urls(add_group_urls, org_prefix)
        add_summary["group_urls"] = {"resolved": r, "unresolved": u}
        for x in r: add_member(x["id"])

    # Remove targets
    remove_emails = parse_csv_arg(args.remove_emails)
    remove_groups = parse_csv_arg(args.remove_groups)

    removed_summary = {"emails": [], "groups": [], "not_found": []}
    if remove_emails:
        r, u = resolve_emails_to_user_ids(remove_emails, pat, gateway)
        for x in r:
            if x["id"] in new_seen:
                remove_member(x["id"])
                removed_summary["emails"].append(x)
            else:
                removed_summary["not_found"].append(x["email"])
        # Unresolved emails: clean from cache (per your guidance: stale → remove from suggestions)
        if u:
            removed_summary["not_found"].extend(u)
    if remove_groups:
        r, u = resolve_groups_by_name(remove_groups, pat, gateway)
        for x in r:
            if x["id"] in new_seen:
                remove_member(x["id"])
                removed_summary["groups"].append(x)
            else:
                removed_summary["not_found"].append(x["name"])
        if u:
            removed_summary["not_found"].extend(u)

    # Apply
    update_article_shared_with(article_id, new_set, pat, gateway)

    # Cache: remember new resolutions, refresh publish entry's targets
    items_to_remember = []
    for x in add_summary["emails"]["resolved"]:
        items_to_remember.append({"kind": "email", "label": x["email"], "id": x["id"], "name": x.get("name")})
    for x in add_summary["groups"]["resolved"]:
        items_to_remember.append({"kind": "group_name", "label": x["name"], "id": x["id"], "name": x["name"]})
    if items_to_remember:
        remember_resolutions(items_to_remember)

    # Build new share_targets snapshot from final new_set
    final_targets = []
    for entry in new_set:
        mid = entry["member"]
        if ":group/" in mid:
            full = devrev_post_nofail("groups.get", {"id": mid}, pat, gateway)
            gname = (full or {}).get("group", {}).get("name", "?")
            kind = "all_users_group" if gname in ALL_USERS_NAME_ALLOWLIST else "group_name"
            final_targets.append({"kind": kind, "label": gname if kind == "group_name" else "All Users (org)", "id": mid})
        elif ":devu/" in mid:
            # Reverse-lookup name from cache where possible
            data = _load_cache()
            label = mid
            name = None
            for v in data["resolutions"].values():
                if v.get("id") == mid:
                    label = v["label"]
                    name = v.get("name")
                    break
            final_targets.append({"kind": "email", "label": label, "id": mid, "name": name})
        else:
            final_targets.append({"kind": "unknown", "label": mid, "id": mid})
    # Build a fresh viewer URL — useful for re-sharing with newly added users.
    page_name = article.get("title") or "Untitled"
    _, user_name = get_current_user(pat, gateway)
    author = user_name or "Unknown"
    viewer = build_viewer_url(article_id, page_name, author, org_slug=org_slug)

    update_publish_share_targets(article_id, final_targets, viewer_url=viewer)

    result = {
        "article_id": article_id,
        "updated_access": args.access,
        "flip": flip_summary,
        "added": add_summary,
        "removed": removed_summary,
        "final_share_targets": final_targets,
        "viewer_url": viewer,
        "markdown_link": f"[{page_name}]({viewer})",
    }
    print(json.dumps(result, indent=2))


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def build_parser():
    p = argparse.ArgumentParser(description="Publish an HTML file to DevRev with composable access control.")
    # Publish-mode args (default)
    p.add_argument("--file", help="Path to the HTML file to upload (publish mode)")
    p.add_argument("--name", help="Human-readable title for the page (publish mode)")
    p.add_argument("--author", default="", help="Author name for the URL. Defaults to caller's full name.")
    p.add_argument("--access", choices=["personal", "internal", "public"],
                   help="Access mode (publish or update-access)")
    p.add_argument("--share-with-emails", default="",
                   help="Comma-separated DevRev emails (publish mode)")
    p.add_argument("--share-with-groups", default="",
                   help="Comma-separated DevRev group names (exact match, publish mode)")
    p.add_argument("--share-with-group-urls", default="",
                   help="Comma-separated DevRev group UI URLs (publish mode)")

    # Update-access mode
    p.add_argument("--update-access", metavar="ARTICLE_ID",
                   help="Update sharing on an existing article (no upload)")
    p.add_argument("--add-emails", default="", help="Emails to ADD (update-access mode)")
    p.add_argument("--add-groups", default="", help="Group names to ADD (update-access mode)")
    p.add_argument("--add-group-urls", default="", help="Group URLs to ADD (update-access mode)")
    p.add_argument("--remove-emails", default="", help="Emails to REMOVE (update-access mode)")
    p.add_argument("--remove-groups", default="", help="Group names to REMOVE (update-access mode)")

    # List-recent mode
    p.add_argument("--list-recent", nargs="?", type=int, const=20, default=None, metavar="N",
                   help="List N most recent publishes from local cache (default 20)")
    return p


def main():
    args = build_parser().parse_args()

    # --list-recent: cache-only, no PAT needed
    if args.list_recent is not None:
        cmd_list_recent(args)
        return

    pat = get_pat()
    gateway = get_gateway()

    # --update-access: re-share existing article
    if args.update_access:
        cmd_update_access(args, pat, gateway)
        return

    # Default: publish a new file. Both --file and --name and --access are required here.
    missing = []
    if not args.file: missing.append("--file")
    if not args.name: missing.append("--name")
    if not args.access: missing.append("--access")
    if missing:
        print(json.dumps({"error": True, "message": f"Missing required args for publish: {missing}"}))
        sys.exit(1)
    cmd_publish(args, pat, gateway)


if __name__ == "__main__":
    main()
