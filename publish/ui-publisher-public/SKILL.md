---
name: ui-publisher-public
version: 5.1.0
description: >
  Uploads HTML files to DevRev with composable access control. Three access
  modes (personal / internal / public) compose with optional sharing flags
  (--share-with-emails, --share-with-groups, --share-with-group-urls). Supports
  ACL changes on existing articles (--update-access) and reverse-lookup of
  recent publishes (--list-recent). Public, self-contained variant of the
  internal ui-publisher with no pat-manager dependency and no pin-to-nav.
---

# UI Publisher (Public)

## Path Resolution
`SKILL_DIR` = the **absolute path of the directory containing this SKILL.md file**.
Substitute the actual path in all commands below before running them.

---

## Description

UI Publisher (Public) lets agents upload HTML files to DevRev and share them
with composable access control. The publisher creates a per-publish DevRev
article wrapping the artifact; the article's `shared_with` field is the access
control pivot. Whoever can read the article can read the page; whoever can't
gets 403.

The recipient opens the page via the **artifact viewer**
(`https://devrev-artifact-viewer.vercel.app`), which fetches the article via
`articles.get` and renders the embedded `original_url`. So sharing is purely a
DevRev ACL question — the viewer carries no auth state of its own beyond the
recipient's PAT.

This is the **public** variant. Compared to the internal `ui-publisher`:
- **No required pat-manager dependency** — script reads `DEVREV_TOKEN` from env
  (with `DEVREV_PAT` accepted as a fallback). The `pat-manager` skill is
  supported as an **optional fallback** when available.
- **No pin-to-nav** — this skill only publishes; it does not modify the user's
  DevRev left sidebar.

---

## When to Use

- **Publish a new page** — user says "publish this", "share this dashboard",
  "get me a link to this".
- **Change sharing on a previously published page** — user says "share that
  page with X too", "make this page org-wide", "remove Y from the page".
- **Reverse lookup** — user asks "what did I publish recently?", "what links
  did I share with the team last week?". The script reads from a local cache.

---

## Access Modes (composable)

```
--access personal | internal | public      # required for publish
[--share-with-emails alice@x.com,bob@x.com]
[--share-with-groups "Devrev Design,Engineering"]
[--share-with-group-urls https://app.devrev.ai/.../group/123,...]
```

| Mode | Behavior | Compose with --share-with-*? |
|---|---|---|
| `personal` | Article shared with no one (owner-only). | ✅ Adds those targets to a still-restricted article. |
| `internal` | Article shared with the org-wide "All Users" group. | ✅ Adds those targets on top of org-wide read. |
| `public` | No article. Returns a 7-day pre-signed S3 URL. | ❌ Ignored (with stderr note). |

### What "share with" actually accepts

| Flag | Format | Resolution |
|---|---|---|
| `--share-with-emails` | Comma-separated DevRev emails | Exact match via `dev-users.list` |
| `--share-with-groups` | Comma-separated group names | Exact match via `groups.list` |
| `--share-with-group-urls` | Comma-separated DevRev UI group URLs | Extracts `group/<id>` segment |

**The agent does the human-friendly resolution.** When the user says "share
with Aravinda", the agent should look up that name (e.g. via
`dev-users.list?term=Aravinda`), confirm with the user if multiple matches,
then pass the resolved email to `--share-with-emails`. The script itself does
**strict** resolution only — typos fail closed (`unresolved_emails`) rather
than silently sharing with the wrong person.

### "All Users" group resolution (internal mode)

The script tries three strategies in order:
1. **Name allowlist**: `["All Users", "Everyone", "All Members", "Default"]`
   — fast, works in 99% of orgs.
2. **Dynamic membership rule** verification — looks for a group whose
   `dynamic_group_info.membership_expression` matches "every dev_user". This
   is the platform's canonical signal for an org-wide group.
3. **Constructed fallback DON** — `<caller's-org-prefix>:group/default9`
   (DevRev's system-default org-wide group). The org prefix is parsed from
   the caller's own user DON, so this never leaks a different org's group ID.

If all three fail, the script errors out with a clear message and tells the
user to either ask their admin to create an org-wide group, or fall back to
explicit `--share-with-emails`.

---

## Run Instructions

### Prerequisites
- Python 3.8+ (no external deps — all stdlib)
- `DEVREV_TOKEN` exported in env (see "Acquiring DEVREV_TOKEN")

### Publish a new page
```bash
python3 "${SKILL_DIR}/scripts/publisher.py" \
  --file /path/to/page.html \
  --name "My Page" \
  --access internal \
  --share-with-emails alice@example.com,bob@example.com
```

### Update sharing on an existing page
```bash
python3 "${SKILL_DIR}/scripts/publisher.py" \
  --update-access "don:core:dvrv-us-1:devo/0:article/63288" \
  --access internal \
  --add-emails carol@example.com \
  --remove-emails bob@example.com
```

### List recent publishes (no PAT needed; reads local cache)
```bash
python3 "${SKILL_DIR}/scripts/publisher.py" --list-recent 10
```

---

## Examples

### Example 1: Personal page (only me)
```bash
python3 "${SKILL_DIR}/scripts/publisher.py" \
  --file ~/dashboard.html \
  --name "My Private Dashboard" \
  --access personal
# Returns:
# {
#   "artifact_id": "...",
#   "article_id": "don:core:dvrv-us-1:devo/0:article/...",
#   "page_name": "My Private Dashboard",
#   "author": "Team Member",
#   "access": "personal",
#   "viewer_url": "https://devrev-artifact-viewer.vercel.app/?page=...&title=...&author=...&org=<slug>",
#   "markdown_link": "[My Private Dashboard](https://...)",
#   "share_summary": { "all_users_group": null, "emails": {...}, "groups": {...}, "group_urls": {...} },
#   "note": "Personal mode: only your DevRev PAT can read the page."
# }
```

### Example 2: Personal + share with two named users
```bash
python3 "${SKILL_DIR}/scripts/publisher.py" \
  --file ./brief.html \
  --name "Q3 Brief" \
  --access personal \
  --share-with-emails alice@example.com,bob@example.com
```

### Example 3: Internal + a few extra people
```bash
python3 "${SKILL_DIR}/scripts/publisher.py" \
  --file ./report.html \
  --name "All-hands report" \
  --access internal \
  --share-with-emails external-contractor@example.com
```

### Example 4: Group URL fallback
When name match doesn't work for a group:
```bash
python3 "${SKILL_DIR}/scripts/publisher.py" \
  --file ./team-doc.html \
  --name "Team-only doc" \
  --access personal \
  --share-with-group-urls "https://app.devrev.ai/devrev/groups/group/498"
```

### Example 5: Public 7-day shareable link
```bash
python3 "${SKILL_DIR}/scripts/publisher.py" \
  --file ./customer-demo.html \
  --name "Customer Demo" \
  --access public
# Returns public_url + expires_at (~7 days, server-controlled).
```

### Example 6: Flip a personal page to internal later
```bash
python3 "${SKILL_DIR}/scripts/publisher.py" \
  --update-access "don:core:dvrv-us-1:devo/0:article/63288" \
  --access internal
```

### Example 7: Add and remove people on an existing article
```bash
python3 "${SKILL_DIR}/scripts/publisher.py" \
  --update-access "don:core:dvrv-us-1:devo/0:article/63288" \
  --add-emails carol@example.com,dave@example.com \
  --remove-emails bob@example.com
```

### Example 8: List the user's recent publishes
```bash
python3 "${SKILL_DIR}/scripts/publisher.py" --list-recent 10
# Returns:
# {
#   "recent_publishes": [
#     {
#       "article_id": "...",
#       "page_name": "Q3 Brief",
#       "access": "personal",
#       "viewer_url": "https://devrev-artifact-viewer.vercel.app/?page=...&org=devrev",
#       "share_targets": [{"kind":"email","label":"alice@...","id":"...","name":"Alice"}],
#       "ts": 1716500000
#     },
#     ...
#   ],
#   "count": 10,
#   "org_slug": "devrev"
# }
```

---

## Acquiring DEVREV_TOKEN

The script reads the DevRev token from the `DEVREV_TOKEN` environment variable
(with `DEVREV_PAT` accepted as a backwards-compatibility fallback). The agent
must make sure that variable is set **before** invoking `publisher.py`.

### Acquisition order (try each in turn)

**1. Already exported in the user's shell (primary path).**
If `$DEVREV_TOKEN` is already set when the script runs, it just works.

**2. `pat-manager` skill — optional fallback when the user hasn't exported one.**
If the [`pat-manager`](https://github.com/ribhuchawla/devrev-skill-pat-manager)
skill is installed alongside this one, the agent may use it to fetch a stored
token:
```bash
VAULT_ENTRY=$(python3 "${SKILL_DIR}/../pat-manager/scripts/pat_manager.py" get "<org-slug>" 2>/dev/null)
if [ $? -eq 0 ]; then
  export DEVREV_TOKEN=$(echo "$VAULT_ENTRY" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
  export DEVREV_GATEWAY_URL=$(echo "$VAULT_ENTRY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('gateway_url','https://app.devrev.ai/api/gateway/internal'))")
fi
```

**3. Local file (last-resort fallback).**
If neither of the above works, ask the user for the **path to a local file**
that contains the token — never the token value itself.

### Anti-patterns — DO NOT
- ❌ **Never** ask the user to paste the token into chat.
- ❌ **Never** echo, log, or print the token value in your replies.
- ❌ **Never** write the token into a file you create on the user's machine.

---

## Step-by-step flow for the agent

### Publishing a new page
1. **Acquire `DEVREV_TOKEN`** (see above). Never solicit in chat.
2. **Confirm the page name and access mode.** "How should I share this?
   personal (only you), internal (org-wide), or public (7-day signed URL)?"
3. **Resolve any sharing intent the user expressed.** If they said "share
   with Aravinda" or "share with the design team":
   - For people → look them up via `dev-users.list` (or `hybrid_search` on
     dev_users), present matches if more than one, get user confirmation,
     then pass the resolved email to `--share-with-emails`.
   - For groups → similarly via `groups.list`. Pass the exact group name to
     `--share-with-groups`.
   - The script does NOT do fuzzy matching — pass strict identifiers only.
4. **Run the publisher** with `--file --name --access` plus any
   `--share-with-*` flags.
5. **Return the `markdown_link` field as a hyperlink.** Never paste the raw
   `viewer_url` or `public_url`. For public mode, also tell the user
   `expires_at`.

### Reverse-lookup ("what did I publish recently?")
1. Run `python3 publisher.py --list-recent <N>` (no PAT needed — local cache).
2. Show the user the list with page name, access, share targets, and
   article_id (since they might want to re-share).
3. If the user picks one to modify, use `--update-access` (next flow).

### Changing access on an existing page
1. Get the `article_id` (from `--list-recent` output, or directly from user).
2. Resolve any add/remove targets the same way as in publish flow.
3. Run with `--update-access <article-id>` plus any combination of:
   - `--access personal|internal` (flip the All Users group on/off)
   - `--add-emails ...`, `--add-groups ...`, `--add-group-urls ...`
   - `--remove-emails ...`, `--remove-groups ...`
4. Return the updated `final_share_targets` to the user.

---

## Persistent cache: recently_shared_with.json

Location: `~/.config/devrev-ui-publisher/recently_shared_with.json`

Survives skill reinstalls. Three top-level fields:

```json
{
  "org_slug": "devrev",
  "resolutions": {
    "email::alice@example.com": {
      "label": "alice@example.com",
      "id": "don:identity:...:devu/12",
      "kind": "email",
      "name": "Alice Engineer",
      "last_used": 1716500000,
      "count": 3
    },
    "group_name::Devrev Design": { ... }
  },
  "publishes": [
    {
      "article_id": "don:core:...:article/63288",
      "page_name": "Q3 Brief",
      "access": "personal",
      "viewer_url": "https://devrev-artifact-viewer.vercel.app/?page=...&org=devrev",
      "share_targets": [
        {"kind":"email","label":"alice@x.com","id":"...","name":"Alice"},
        {"kind":"group_name","label":"Devrev Design","id":"..."}
      ],
      "ts": 1716500000
    }
  ]
}
```

- **`org_slug`** — calling org's `dev_slug` (resolved once via `dev-orgs.self`,
  persisted on every authed mode). Used by `--list-recent` to backfill `&org=`
  on URLs that pre-date the slug plumbing.

- **`resolutions`** is an LRU-100 cache of label→DON resolutions. Powers
  proactive "share with the people you usually share with" suggestions.
- **`publishes`** is the most recent 50 publish events, newest first. Powers
  the `--list-recent` reverse-lookup.

**No prevalidation.** Stale entries (e.g. user left org, group renamed) are
removed only when they fail a future operation. This avoids extra API calls
on every cache read.

The agent can read this file directly to answer questions like:
- "Who do I usually share with?" → top resolutions by `count`
- "What did I share last week?" → filter `publishes` by `ts`
- "Did I share that report with the design team?" → search `publishes` by
  `page_name` and inspect `share_targets`

---

## Re-publishing (updates)

Re-running the publisher on the same file creates a **new article** with a new
ID and URL — old links continue to work. For ACL changes on the *existing*
page (no re-upload), use `--update-access`.

For public-mode link refresh (after the 7-day expiry), re-run the publisher;
each call mints a fresh 7-day URL.

---

## Parameters

### Publish mode (default)

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--file` | Yes | Absolute path to the HTML file to upload |
| `--name` | Yes | Human-readable page title — embedded in the URL |
| `--access` | Yes | `personal`, `internal`, or `public` |
| `--author` | No | Author name; defaults to caller's `dev-users.self.full_name` |
| `--share-with-emails` | No | Comma-separated DevRev emails (publish + ignored if public) |
| `--share-with-groups` | No | Comma-separated DevRev group names (exact) |
| `--share-with-group-urls` | No | Comma-separated DevRev UI group URLs |

### Update-access mode

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--update-access` | Yes | The article ID (DON) to modify |
| `--access` | No | Set to `personal` or `internal` to flip the All Users group on/off |
| `--add-emails` | No | Comma-separated emails to ADD |
| `--add-groups` | No | Comma-separated group names to ADD |
| `--add-group-urls` | No | Comma-separated group UI URLs to ADD |
| `--remove-emails` | No | Comma-separated emails to REMOVE |
| `--remove-groups` | No | Comma-separated group names to REMOVE |

### List-recent mode
| Parameter | Required | Description |
|-----------|----------|-------------|
| `--list-recent [N]` | Yes | Print the N most recent cached publishes (default 20) |

### Environment variables
- `DEVREV_TOKEN` — DevRev personal access token (required for publish/update; not needed for list-recent)
- `DEVREV_PAT` — fallback name; either works
- `DEVREV_GATEWAY_URL` — override gateway URL (optional)

---

## Error Handling

The script outputs errors as JSON: `{"error": true, "message": "..."}` on
stdout, and exits with code 1.

| Error Message | Cause | Fix |
|---|---|---|
| `Python 3.8+ required` | Old Python | Upgrade to ≥ 3.8 |
| `DEVREV_TOKEN environment variable is not set ...` | No token in env | Follow the acquisition order above |
| `HTTP 401 from <endpoint>` | PAT expired or invalid | Refresh PAT |
| `HTTP 403 from <endpoint>` | PAT lacks required permission | Generate a PAT with full permissions |
| `Could not resolve calling user via dev-users.self` | PAT works but identity not returned | Check PAT scope |
| `File not found` | Wrong path to `--file` | Use an absolute path |
| `Internal mode requires an org-wide 'All Users' group ...` | No matching group in this org | Use `--access personal` with explicit `--share-with-*`, or have admin create one |
| `Could not fetch article <id>` (update-access mode) | Article doesn't exist or caller can't read it | Confirm article ID; user must have read on the article |
| `Request failed: <details>` | Network error / timeout | Retry; `<details>` indicates the underlying cause |

`unresolved` is **not** a fatal error. The publish succeeds with the
resolvable targets only; unresolved entries are surfaced as a warning in the
JSON result.

---

## API Endpoints Used

| Endpoint | Mode | Purpose |
|---|---|---|
| `artifacts.prepare` | publish | Initiate upload, get pre-signed S3 POST URL |
| Pre-signed S3 POST | publish | Upload raw file content (multipart/form-data) |
| `dev-users.self` | publish, update | Resolve calling user (for owner + author + org prefix) |
| `dev-orgs.self` | publish, update | Resolve `dev_slug` for org-aware help link in viewer URL |
| `parts.list` | publish | Resolve any part for `applies_to_parts` |
| `roles.list` | publish, update | Resolve the article-target Viewer role |
| `groups.list` | internal mode + group-name share | List groups for resolution |
| `groups.get` | internal mode (rare) | Verify dynamic_group_info as canonical signal |
| `dev-users.list` | email-share | Resolve email → user DON |
| `articles.create` | publish (personal/internal) | Create per-publish article wrapping the artifact |
| `articles.update` | update-access | Replace shared_with on existing article |
| `articles.get` | update-access | Read current shared_with before modifying |
| `artifacts.locate` | public | Mint a 7-day pre-signed S3 URL for anonymous access |

---

## Verified two-user behavior

These access semantics were tested with two real DevRev PATs (publisher and a
peer in the same org):

| Mode + share targets | Owner | Peer (Aravinda) |
|---|---|---|
| `personal` (no extra share) | ✅ 200 | ❌ 403 |
| `personal --share-with-emails <peer>` | ✅ 200 | ✅ 200 |
| `internal` (All Users group) | ✅ 200 | ✅ 200 |
| `update-access` flip personal → internal | ✅ 200 | ✅ 200 (after flip) |
| `public` (raw S3 URL, no auth) | ✅ 200 | ✅ 200 (no auth) |

---

## Version History

### v5.1.0 (2026-05-27)
- **New:** every viewer URL now includes `&org=<dev_slug>` so the viewer's gate
  screen can render an org-aware "Generate a token" help link. Without this,
  the link is hidden (better than a broken default).
- **New:** `--update-access` now returns `viewer_url` and `markdown_link` so
  the user can re-share immediately after an ACL change without looking it up.
- **New:** `--list-recent` backfills `&org=` on cached entries that pre-date
  the slug propagation, using the cached `org_slug`. Read-only — doesn't
  mutate the stored cache.
- **New cache field:** top-level `org_slug` persists per-install for offline
  list-recent backfill. Set whenever an authed mode (publish/update-access)
  resolves it via `dev-orgs.self`.

### v5.0.0 (2026-05-26)
- **New:** unified sharing surface — `--share-with-emails`, `--share-with-groups`,
  `--share-with-group-urls`. All three compose with `--access {personal|internal}`.
- **New:** `--update-access <article_id>` — change ACL on an existing article
  without re-uploading content. Supports `--add-*` and `--remove-*` flags plus
  optional `--access` flip to add/remove the All Users group.
- **New:** persistent cache at `~/.config/devrev-ui-publisher/recently_shared_with.json`
  — stores resolutions and publish history. Survives skill reinstalls.
- **New:** `--list-recent [N]` mode — reverse-lookup of recent publishes.
- **New:** layered All Users group resolver (name allowlist → dynamic_group_info
  verification → org-aware fallback DON). Replaces the v4 hardcoded DEV-0 ID.
- **Verified end-to-end** with two PATs across all flows including ACL flips.

### v4.0.0 (2026-05-26)
- Per-publish article wrapping every personal/internal upload (was: shared "Computer Published Pages" article).
- Viewer URL changed to `?page=<article-id>` (was `?artifact=<id>`); legacy `?artifact=` still supported.
- Article's `shared_with` is now the access-control pivot (was: implicit assumption that scope:1 meant org-wide).

### v3.x
- `?artifact=`-based viewer URL pattern, `scope: 1` shared article hack — superseded by v4 article-per-publish design.

### v2.0.0 (2026-05-26)
- Forked from internal `ui-publisher` v1.0.2 as a public, self-contained variant.
- Removed Pin-to-Nav functionality; pat-manager moved from required to optional.
