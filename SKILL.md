---
name: make-page-interactive
version: 1.1.2
description: >
  Convert a static HTML page into an interactive, editable + annotatable +
  VERSION-CONTROLLED page — appends a DevRev-branded Annotate/View bar,
  click-to-comment, double-click-to-edit-text-inline, an @-mention composer,
  pins, a comments panel, a "Send to Computer" flow, AND a built-in version
  picker (a "Versions" button in the toolbar listing every past version with
  title/time/author, plus restore + branch), all baked into one self-contained
  HTML file. Running the converter automatically seeds a per-page git/snapshot
  store and bakes the full history into the output — no extra step. Use when the
  user has an HTML artifact (or any static page) and wants to edit it,
  review/comment/mark it up, hand it to teammates to annotate, send page
  feedback to Computer, or keep a version history of the page across edits.
  Trigger phrases: "make this page interactive", "make this page editable",
  "let me edit this page", "make this HTML editable", "add an
  annotation/review layer to this HTML", "let me comment on this page", "turn
  this page into a Figma-style editable/commentable page", "make this page
  reviewable", "version control this page", "add version history to this page",
  "I want to leave notes on this page for Computer". When the user later asks to
  change a converted page, the agent edits the source, commits via the skill's
  version-store CLI, and regenerates so the picker stays current (see the
  "Version control" section). This is a stopgap until editing/annotation is
  built natively into Computer.
---

<!-- AUTOUPDATE_BLOCK_START (managed by skill-publisher — do not edit by hand) -->
## ⟳ Auto-update (run this first)

Before doing anything else with this skill, check for a newer published version:

```bash
python3 "<SKILL_DIR>/.autoupdate/check.py"
```

Act on its output:
- **`UP_TO_DATE`** → proceed with the skill normally.
- **`UPDATED <version>`** → the skill was just updated in place; **re-read this SKILL.md** (it may have changed), then proceed.
- **`CHOICE_NEEDED`** followed by a JSON block → present the listed `options` to the user (a short question), then run:
  ```bash
  python3 "<SKILL_DIR>/.autoupdate/apply_update.py" --skill-dir "<SKILL_DIR>" --artifact-id "<artifactId>" --version "<remoteVersion>" --mode "<chosen option id>"
  ```
  Use the `artifactId`/`remoteVersion` from the JSON and the option `id` the user picked (`take-latest`, `smart-merge`, or `keep-mine`). After applying, re-read this SKILL.md.

This check is throttled (~once every 6h) and fails open — if it can't reach DevRev it just prints `UP_TO_DATE` and never blocks the skill. Auto-update preference is stored in `<SKILL_DIR>/.autoupdate/state.json`; the user can ask to switch between automatic and manual updates at any time (edit `preference` to `auto` or `manual`).
<!-- AUTOUPDATE_BLOCK_END -->

# Make page interactive

Wraps an existing static HTML page in the DevRev annotation runtime, producing a
**single self-contained `.html`** that turns the page editable and commentable.
On top of the original page it adds:

- a slim **Annotate ⇄ View** bar (DevRev brand: pill buttons, Chip mono labels, yellow primary);
- **hover-to-comment, double-click-to-edit** gestures on the page's own elements;
- click-located **pins** (Figma-style, multiple per element), audience-distinct (Computer vs people);
- an **@-mention composer** (`@Computer` routes to the agent, `@person` to people) with live mention highlighting;
- a **comments panel** grouped For Computer / For people, with hover-sync and click-to-scroll;
- a **Send to Computer** popup: a copy-paste prompt + an `annotations.json` to **download or drag straight into the Computer chat**.

The page's original `window.DevRevHost` bridge (if any) is **preserved** — when the
annotated page is opened inside Computer, a Send button still talks to the chat
directly; the popup is the offline/standalone fallback.

## Path Resolution

`SKILL_DIR` is the directory containing this `SKILL.md`. The inliner and its
prebuilt assets are addressed relative to it:

- `<SKILL_DIR>/make-interactive.mjs` — the converter (Node, no dependencies).
- `<SKILL_DIR>/runtime/index.html`, `runtime/a.js`, `runtime/a.css` — the prebuilt annotation runtime that gets inlined into every output.

## Description

This skill is a converter: given the path to a static HTML page, it emits one
self-contained HTML file that renders the original page inside a sandboxed
frame with the DevRev annotation layer overlaid on top. The output has no
external dependencies (JS, CSS, and the Chip brand fonts are all inlined) so it
opens in Computer or any browser and works offline.

It does **not** restyle the user's page and it is **not** the Submit-button
wire-up skill (that is `devrev-page-bridge`); the two compose — a converted page
keeps any existing `window.DevRevHost` bridge.

## When to Use

- **Use** when the input is an HTML file (or any static page) the user wants to edit, review, comment on, mark up, or collect feedback on, or hand to teammates to annotate.
- **Use** on triggers like "make this page interactive" / "make this page editable".
- **Don't use** to wire a Submit button back to chat — that's `devrev-page-bridge`.
- **Don't use** as a styling skill — it overlays annotation chrome, it doesn't redesign the page.

## Run Instructions

The skill ships a self-contained Node inliner and prebuilt runtime assets. No
build step, no dependencies.

```
node "<SKILL_DIR>/make-interactive.mjs" <input.html> [output.html]
```

- `<input.html>` — path to the page to convert (required).
- `[output.html]` — optional; defaults to `<input-name>.interactive.html` beside the input.

Then open the output in Computer (render it as an HTML artifact) or in any
browser. The original page renders inside, with the annotation bar on top.

## Version control (history + picker)

Every converted page is backed by a per-page version store in a hidden sibling
dir `.<page>.versions/` (real git when available, else a built-in snapshot
store — auto-detected, no setup). `make-interactive.mjs` seeds the store on
first run and bakes the full history into the output as a `v{n} ▾` picker
(browse, restore, branch). The picker is offline and self-contained.

### ALWAYS commit with a descriptive title before rebuilding

The title and its change bullets are the only human-readable record of what each
version was, so **they matter.** After every edit, commit with:

- a short, specific **title** summarising the round as comma-separated changes;
- one **`--bullet`** per distinct change, each a 3–6 word phrase (shown in the
  picker's hover card).

Good vs bad:

- ✅ title `"Remove decimals, recolour metric, add bullets"`
  with `--bullet "Removed % decimals" --bullet "Recoloured chat-ceiling card" --bullet "Bulletized the meta line"`
- ❌ `"Update"`, `"Changes"`, `"Dev0 Deflection"` — vague/derived titles are useless.

```
node "<SKILL_DIR>/version-store/cli.mjs" commit <source.html> \
  "Remove decimals, recolour metric, add bullets" \
  --bullet "Removed % decimals" \
  --bullet "Recoloured chat-ceiling card" \
  --bullet "Bulletized the meta line"
```

Derive the title and bullets from **what you actually changed** this round
(e.g. the user's annotations/feedback you applied) — not from the page's name
or heading.

**Safety net (don't rely on it):** if you edit the source and rebuild WITHOUT
committing, `make-interactive.mjs` auto-commits so no change is ever lost, with
a plain `"Edited (no description)"` title and no bullets. That's a fallback for
mistakes, not the normal path. Always prefer an explicit, descriptive commit
with bullets.

### The per-round lifecycle the agent follows

1. Edit the raw **source** HTML in response to the user's request.
2. **Commit with a descriptive title** (see above). Split a round into multiple
   commits when it spans distinct changes (see below):
   ```
   node "<SKILL_DIR>/version-store/cli.mjs" commit <source.html> "Tighten hero spacing"
   ```
3. Regenerate the interactive page (re-bakes history; auto-saves only if you
   skipped step 2):
   ```
   node "<SKILL_DIR>/make-interactive.mjs" <source.html>
   ```

### Commit-splitting judgment

- Small or cohesive changes in one request → **one commit**.
- A request spanning distinct, unrelated major changes → **separate commits**
  (e.g. "rewrite the hero" + "add a pricing section" = two commits), each with
  its own title. Multiple commits in one round is expected and fine.

### Author labels

The seed commit is authored **"Computer"**; later versions use the user's
identity (auto-configured locally from the session if git has no name set). In
a shared repo, real git author names flow through.

### Acting on picker buttons (prompts returned from the page)

The picker's buttons produce copy-paste prompts. When the user pastes one back,
recognize the **intent** (not an exact string) and run the matching command,
then regenerate:

| Pasted prompt intent | Command |
|---|---|
| "Restore version N (…) of PAGE as the latest version." | `node "<SKILL_DIR>/version-store/cli.mjs" restore <source.html> N` |
| "Create a new branch \"NAME\" from version N of PAGE." | `node "<SKILL_DIR>/version-store/cli.mjs" branch <source.html> NAME N` |
| "Switch PAGE to branch \"NAME\" and regenerate." | `node "<SKILL_DIR>/version-store/cli.mjs" switch <source.html> NAME` |

Restore is a **forward** operation: it writes the old version's exact content as
a new latest version — nothing is lost. If `N` is out of range or a branch name
collides, ask rather than guessing. Always regenerate the page after a mutation.

## Publishing a version

The picker's **Publish** button (on every version) lets the user share that
version. It opens an audience menu and produces a **short intent prompt** — the
page can't call the API itself, so Computer runs the **bundled**
`ui-publisher-public` skill at `make-page-interactive/publish/ui-publisher-public/`.

The pasted prompt is intentionally terse, e.g. *"Publish v2 of report.html for
anyone in the org."* or *"Publish v3 of report.html as a public 7-day link."* or
*"Publish v2 of report.html shared with a@x.com and groups Design."* **You own the
mechanics:** recognise the intent, map it to the `publisher.py` flags below, run
it from the bundled path, then **record the result and regenerate** (steps below).
Don't ask the user for the location or the flags — they're all here.

Audience → `publisher.py` flags:

| Choice | Flags |
|---|---|
| Everyone in the org | `--access internal` |
| Just me | `--access personal` |
| Specific people | `--access personal --share-with-emails "a@x.com,b@x.com"` |
| Specific groups | `--access personal --share-with-groups "Design,Engineering"` (exact names) |
| Public link (7 days) | `--access public` → returns a presigned S3 URL + `expires_at`; ignores share-with. By default ALSO run `--access internal` so org access survives expiry. |

**Token:** the publisher reads `DEVREV_TOKEN`/`DEVREV_PAT`. Inside Computer the
injected `DEVREV_API_KEY` works — export it first if needed:
`export DEVREV_TOKEN="$DEVREV_API_KEY"`.

**After publishing, record it** so the picker shows it on the next rebuild
(the publisher prints `viewer_url`, and for public also `public_url`/`expires_at`):
```
node "<SKILL_DIR>/version-store/cli.mjs" record-publish <source.html> <n> \
  --access <a> [--emails "..."] [--groups "..."] \
  [--viewer-url <viewer_url>] [--public-url <public_url>] [--expires-at <iso>] --at <now-iso>
```
Then regenerate: `node "<SKILL_DIR>/make-interactive.mjs" <source.html>`. The
picker then shows a "🔗 Published · Org/Private/Public" chip linking to the URL
(public shows the presigned link + expiry).

## Examples

**Example 1 — convert a page (default output path):**

```
node "<SKILL_DIR>/make-interactive.mjs" ./sla-reply.html
# → ./sla-reply.interactive.html  (one self-contained file, ~2.5 MB)
```

**Example 2 — explicit output path:**

```
node "<SKILL_DIR>/make-interactive.mjs" ./report.html ./report.review.html
# → ./report.review.html
```

## What the inliner does

1. Reads the prebuilt runtime (`runtime/index.html` + `runtime/a.js` + `runtime/a.css`) shipped with the skill.
2. Inlines the JS module and CSS into the runtime HTML, escaping any `</script>` / `</style>` / `<!--` in the asset bytes so they can't terminate the inline tag early. Replacements use functions, so `$` sequences in the minified bundle are never treated as patterns.
3. Injects the user's page as **base64** into `window.__DEVREV_PAGE_HTML__` (plus the file name), which is decoded at runtime and rendered in the sandboxed inner iframe. Base64 makes arbitrary markup — embedded scripts, quotes, `</script>`, `</body>` — injection-safe.
4. Writes one self-contained `.html`.

## Gestures (what the user gets)

- **Click** any element → comment composer at the click point.
- **Double-click** text → edit it inline (no LLM). Esc cancels; ⌘-Enter commits.
- **Hold ⌘ / Ctrl** → the page goes live (use its tabs/buttons/links); release → back to annotating. The corner **Annotate ⇄ View** switch is the discoverable equivalent.
- **@Computer …** → a change request or question for the agent. **@name …** → a comment for people. Bare text defaults to Computer.
- **Send to Computer** (composer + panel) → opens the popup: copy the prompt, and download or drag the `annotations.json` into the Computer chat.

## Known limitations (stopgap honesty)

- **Single-player only.** Comments/annotations persist to the browser's local IndexedDB (`devrev-page-annotations`, keyed by chat+artifact) — device-local, never synced. They survive reloads on your machine but are invisible to teammates and to you on another device. There is intentionally no shared backend; multiplayer comment sync belongs to the native Computer feature (timeline-backed), not to a portable HTML file. (Note: the *page content* still refreshes if its file changes on disk — that's the in-app renderer's job, not this self-contained output.)
- **Inline-edit can't write the source file** when the page is opened inside Computer's sandboxed iframe (`window.DevRevNative` is unavailable there). Edits update the in-memory page; committing offers the edited HTML as a download. Real file-write is the job of the native Computer feature this skill stands in for.
- **Drag-to-chat** uses the Chromium `DownloadURL` DataTransfer mechanism. It lands in Chromium/Electron drop zones (Computer) but isn't guaranteed in every browser; **download is the reliable path**, drag is the bonus.
- Output is ~2.5 MB (the annotation app + arcade CSS + embedded Chip fonts are inlined for full portability and offline use).

## Security notes

- The output is **not** a code-injection vector for the host: the user's page is decoded from base64 and rendered in a **sandboxed iframe** (`allow-scripts allow-forms`, opaque origin, no `allow-same-origin`), the same isolation Computer uses for any HTML artifact.
- The skill-evaluator's static scan flags 3 "unsafe innerHTML" findings in `runtime/a.js`. These are **vendor false positives** — matches inside minified React's internal error-stack code (`displayName`, `<anonymous>`, `.stack`), not skill-authored DOM writes. The skill's own code (`make-interactive.mjs`, the React components) uses no raw `innerHTML` on untrusted input.

## Updating the runtime

The `runtime/` assets are built from `apps/search/annotation-standalone` in the
`devrev-web` repo:

```
npx vite build --config apps/search/annotation-standalone/vite.config.mts
# then copy dist/apps/annotation-standalone/{index.html,a.js,a.css} into this skill's runtime/
```
