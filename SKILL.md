---
name: make-page-interactive
version: 1.0.0
description: >
  Convert a static HTML page into an interactive, editable + annotatable page —
  appends a DevRev-branded Annotate/View bar, click-to-comment,
  double-click-to-edit-text-inline, an @-mention composer, pins, a comments
  panel, and a "Send to Computer" flow, all baked into one self-contained HTML
  file. Use when the user has an HTML artifact (or any static page) and wants to
  edit it, review/comment/mark it up, hand it to teammates to annotate, or send
  page feedback to Computer. Trigger phrases: "make this page interactive",
  "make this page editable", "let me edit this page", "make this HTML editable",
  "add an annotation/review layer to this HTML", "let me comment on this page",
  "turn this page into a Figma-style editable/commentable page", "make this page
  reviewable", "I want to leave notes on this page for Computer". This is a
  stopgap until editing/annotation is built natively into Computer.
---

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
